use crate::{
    models::{Dependency, SetupStatus},
    store::data_root,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::Duration,
};
static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
pub fn set_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}

/// The executable `name` runs from. A whisper.cpp runtime folder may hold a
/// second build for AVX2, FMA, F16C and BMI2 in its `avx2` subfolder, about
/// eight times faster; it runs on processors that support all four.
pub fn tool(name: &str) -> Result<PathBuf, String> {
    let path = locate(name)?;
    Ok(if name.starts_with("whisper-") {
        vector_build(&path, processor_has_vector())
    } else {
        path
    })
}
/// `binary`'s build in the `avx2` folder beside it, when `supported` and it exists.
fn vector_build(binary: &Path, supported: bool) -> PathBuf {
    let fast = binary
        .parent()
        .zip(binary.file_name())
        .map(|(dir, name)| dir.join("avx2").join(name));
    match fast {
        Some(fast) if supported && fast.is_file() => fast,
        _ => binary.to_owned(),
    }
}
fn processor_has_vector() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c")
            && std::arch::is_x86_feature_detected!("bmi2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}
/// Where `name` is installed, before choosing a processor-specific build.
pub(crate) fn locate(name: &str) -> Result<PathBuf, String> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let pinned = data_root().join("tools/whisper-b5454").join(&exe);
    if pinned.is_file() {
        return Ok(pinned);
    }
    let local = data_root().join("tools").join(&exe);
    if local.is_file() {
        return Ok(local);
    }
    for dir in RESOURCE_DIR.get().cloned().into_iter().chain(
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_owned)),
    ) {
        let bundled = dir.join("tools/whisper-b5454").join(&exe);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join(&exe);
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(not(windows))]
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        let path = Path::new(dir).join(&exe);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(format!(
        "{name} is not installed. Install it or place {exe} in {}.",
        data_root().join("tools").display()
    ))
}
pub fn command(name: &str) -> Result<Command, String> {
    let cmd = Command::new(tool(name)?);
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(0x08000000);
        cmd
    };
    Ok(cmd)
}
pub fn model_path() -> PathBuf {
    std::env::var_os("CUEREVIEW_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root().join("models").join("ggml-base.bin"))
}
const VAD_MODEL_SHA256: &str = "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";
pub fn vad_model_path() -> PathBuf {
    std::env::var_os("CUEREVIEW_VAD_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root().join("models/ggml-silero-v6.2.0.bin"))
}
fn runtime_works(name: &str) -> bool {
    command(name)
        .and_then(|mut c| c.arg("-h").output().map_err(|e| e.to_string()))
        .is_ok_and(|out| out.status.success())
}
pub fn setup_status() -> SetupStatus {
    let whisper_ok = runtime_works("whisper-cli");
    let vad_ok = runtime_works("whisper-vad-speech-segments");
    let dependencies: Vec<_> = [
        "ffmpeg",
        "ffprobe",
        "whisper-cli",
        "whisper-vad-speech-segments",
        "adb",
        "scrcpy",
    ]
    .iter()
    .map(|name| {
        let path = tool(name).ok();
        Dependency {
            name: name.to_string(),
            available: path.is_some()
                && (*name != "whisper-cli" || whisper_ok)
                && (*name != "whisper-vad-speech-segments" || vad_ok),
            path: path.map(|p| p.to_string_lossy().into()),
            detail: Some(
                if matches!(*name, "adb" | "scrcpy") {
                    "Required for Android and Quest USB capture"
                } else {
                    "Required for recording or local transcription"
                }
                .into(),
            ),
        }
    })
    .collect();
    let speech_ready = speech_model_ready();
    let vad_ready = vad_model_ready();
    let model_ready = speech_ready && vad_ready;
    let mut issues = vec![];
    for d in &dependencies {
        if !d.available && !matches!(d.name.as_str(), "adb" | "scrcpy") {
            issues.push(format!("{} is missing", d.name));
        }
    }
    if (tool("whisper-cli").is_ok() && !whisper_ok)
        || (tool("whisper-vad-speech-segments").is_ok() && !vad_ok)
    {
        issues.push(
            "The speech runtime cannot start. Reinstall it to repair missing runtime files.".into(),
        );
    }
    if !speech_ready {
        issues.push("Local speech model is missing (about 148 MB).".into());
    }
    if !vad_ready {
        issues.push("Local speech detection model is missing or invalid (about 885 KB).".into());
    }
    SetupStatus {
        ready: issues.is_empty(),
        issues,
        dependencies,
        model_ready,
        model_path: model_ready.then(|| model_path().to_string_lossy().into()),
    }
}
fn download(url: &str, target: &Path, expected: Option<&str>) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .user_agent("CueReview/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download failed: {e}"))?;
    let temp = target.with_extension("download");
    let mut out = fs::File::create(&temp).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = response.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    out.sync_all().map_err(|e| e.to_string())?;
    drop(out);
    if let Some(expected) = expected {
        if format!("{:x}", hash.finalize()) != expected {
            let _ = fs::remove_file(&temp);
            return Err("Downloaded file failed its SHA-256 integrity check.".into());
        }
    }
    fs::rename(&temp, target).map_err(|e| e.to_string())
}
pub fn install_transcription() -> Result<SetupStatus, String> {
    let root = data_root();
    fs::create_dir_all(root.join("tools")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("models")).map_err(|e| e.to_string())?;
    if !runtime_works("whisper-cli") || !runtime_works("whisper-vad-speech-segments") {
        #[cfg(not(windows))]
        return Err("The bundled speech runtime is unavailable. Reinstall CueReview for your architecture, or install whisper.cpp with both whisper-cli and whisper-vad-speech-segments on PATH.".into());
        #[cfg(windows)]
        {
            let archive = root.join("tools/whisper.zip");
            download(
            "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip",
            &archive,
            Some("6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb"),
        )?;
            let staging = root
                .join("tools")
                .join(format!("whisper-install-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&staging).map_err(|e| e.to_string())?;
            let mut zip =
                zip::ZipArchive::new(fs::File::open(&archive).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            for i in 0..zip.len() {
                let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
                if file.is_dir() {
                    continue;
                }
                let enclosed = file.enclosed_name().ok_or("Unsafe archive entry")?;
                let name = enclosed.file_name().ok_or("Invalid archive entry")?;
                if matches!(
                    enclosed.extension().and_then(|x| x.to_str()),
                    Some("exe" | "dll" | "txt")
                ) {
                    let mut out =
                        fs::File::create(staging.join(name)).map_err(|e| e.to_string())?;
                    std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
                }
            }
            for name in ["whisper-cli.exe", "whisper-vad-speech-segments.exe"] {
                let mut check = Command::new(staging.join(name));
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    check.creation_flags(0x08000000);
                }
                if !check
                    .arg("-h")
                    .output()
                    .map_err(|e| format!("Speech runtime failed to start: {e}"))?
                    .status
                    .success()
                {
                    return Err(
                        "Speech runtime verification failed; existing installation was preserved."
                            .into(),
                    );
                }
            }
            let destination = root.join("tools/whisper-b5454");
            if destination.exists() {
                fs::rename(
                    &destination,
                    root.join("tools")
                        .join(format!("whisper-backup-{}", uuid::Uuid::new_v4())),
                )
                .map_err(|e| e.to_string())?;
            }
            fs::rename(staging, destination).map_err(|e| e.to_string())?;
            drop(zip);
            let _ = fs::remove_file(archive);
        }
    }
    if !speech_model_ready() {
        if std::env::var_os("CUEREVIEW_MODEL").is_some() {
            return Err("The custom CUEREVIEW_MODEL file is missing or invalid. Correct that path or unset it to install the standard model.".into());
        }
        download("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",&model_path(),Some("60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"))?;
    }
    if !vad_model_ready() {
        if std::env::var_os("CUEREVIEW_VAD_MODEL").is_some() {
            return Err("The custom CUEREVIEW_VAD_MODEL file is missing or invalid. Correct that path or unset it to install the standard detection model.".into());
        }
        download("https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin", &vad_model_path(), Some(VAD_MODEL_SHA256))?;
    }
    Ok(setup_status())
}
fn speech_model_ready() -> bool {
    model_path().metadata().is_ok_and(|m| {
        if std::env::var_os("CUEREVIEW_MODEL").is_some() {
            m.len() > 1_000_000
        } else {
            m.len() == 147_951_465
        }
    })
}
fn vad_model_ready() -> bool {
    let path = vad_model_path();
    if std::env::var_os("CUEREVIEW_VAD_MODEL").is_some() {
        return path.metadata().is_ok_and(|m| m.len() > 100_000);
    }
    fs::read(path).is_ok_and(|bytes| format!("{:x}", Sha256::digest(bytes)) == VAD_MODEL_SHA256)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(with_vector: bool) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("whisper-cli.exe");
        fs::write(&plain, b"plain").unwrap();
        if with_vector {
            fs::create_dir(dir.path().join("avx2")).unwrap();
            fs::write(dir.path().join("avx2/whisper-cli.exe"), b"avx2").unwrap();
        }
        (dir, plain)
    }

    #[test]
    fn the_vector_build_runs_where_the_processor_supports_it() {
        let (dir, plain) = runtime(true);
        assert_eq!(
            vector_build(&plain, true),
            dir.path().join("avx2/whisper-cli.exe")
        );
    }

    #[test]
    fn the_plain_build_runs_where_the_vector_build_cannot() {
        let (_dir, plain) = runtime(true);
        assert_eq!(vector_build(&plain, false), plain);
        let (_dir, plain) = runtime(false);
        assert_eq!(vector_build(&plain, true), plain);
    }
}
