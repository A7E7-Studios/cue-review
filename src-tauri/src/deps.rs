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
    time::Duration,
};

pub fn tool(name: &str) -> Result<PathBuf, String> {
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
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join(&exe);
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
    let mut cmd = Command::new(tool(name)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    Ok(cmd)
}
pub fn model_path() -> PathBuf {
    std::env::var_os("CUEREVIEW_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root().join("models").join("ggml-base.bin"))
}
fn whisper_works() -> bool {
    command("whisper-cli")
        .and_then(|mut c| c.arg("-h").output().map_err(|e| e.to_string()))
        .is_ok_and(|out| out.status.success())
}
pub fn setup_status() -> SetupStatus {
    let whisper_ok = whisper_works();
    let dependencies: Vec<_> = ["ffmpeg", "ffprobe", "whisper-cli", "adb", "scrcpy"]
        .iter()
        .map(|name| {
            let path = tool(name).ok();
            Dependency {
                name: name.to_string(),
                available: path.is_some() && (*name != "whisper-cli" || whisper_ok),
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
    let model_ready = model_ready();
    let mut issues = vec![];
    for d in &dependencies {
        if !d.available && !matches!(d.name.as_str(), "adb" | "scrcpy") {
            issues.push(format!("{} is missing", d.name));
        }
    }
    if tool("whisper-cli").is_ok() && !whisper_ok {
        issues.push(
            "The speech runtime cannot start. Reinstall it to repair missing runtime files.".into(),
        );
    }
    if !model_ready {
        issues.push("Local speech model is missing (about 148 MB).".into());
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
    if !whisper_works() {
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
        let mut zip = zip::ZipArchive::new(fs::File::open(&archive).map_err(|e| e.to_string())?)
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
                let mut out = fs::File::create(staging.join(name)).map_err(|e| e.to_string())?;
                std::io::copy(&mut file, &mut out).map_err(|e| e.to_string())?;
            }
        }
        let mut check = Command::new(staging.join("whisper-cli.exe"));
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
                "Speech runtime verification failed; existing installation was preserved.".into(),
            );
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
    if !model_ready() {
        if std::env::var_os("CUEREVIEW_MODEL").is_some() {
            return Err("The custom CUEREVIEW_MODEL file is missing or invalid. Correct that path or unset it to install the standard model.".into());
        }
        download("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin",&model_path(),Some("60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"))?;
    }
    Ok(setup_status())
}
fn model_ready() -> bool {
    model_path().metadata().is_ok_and(|m| {
        if std::env::var_os("CUEREVIEW_MODEL").is_some() {
            m.len() > 1_000_000
        } else {
            m.len() == 147_951_465
        }
    })
}
