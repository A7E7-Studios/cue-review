use crate::{
    models::{Dependency, LanguageModel, SetupStatus},
    settings,
    store::data_root,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
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
/// A Whisper model the app installs: its file in `<root>/models`, its exact
/// size and SHA-256, and its alignment heads preset.
#[derive(Debug, PartialEq, Eq)]
pub struct SpeechModel {
    pub name: &'static str,
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    pub dtw: &'static str,
}
/// Every model comes from this revision of ggerganov/whisper.cpp on Hugging Face.
const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
pub const BASE: SpeechModel = SpeechModel {
    name: "base",
    file: "ggml-base.bin",
    size: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    dtw: "base",
};
pub const SMALL_EN: SpeechModel = SpeechModel {
    name: "small.en",
    file: "ggml-small.en.bin",
    size: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    dtw: "small.en",
};
pub const SMALL: SpeechModel = SpeechModel {
    name: "small",
    file: "ggml-small.bin",
    size: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    dtw: "small",
};
impl SpeechModel {
    fn url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL_REVISION}/{}",
            self.file
        )
    }
    fn path_in(&self, models: &Path) -> PathBuf {
        models.join(self.file)
    }
    fn installed_in(&self, models: &Path) -> bool {
        self.path_in(models)
            .metadata()
            .is_ok_and(|m| m.len() == self.size)
    }
}
/// The model of a transcription language (`"en"` or `"de"`): small.en for
/// English, the multilingual small model for German.
pub fn language_model(language: &str) -> &'static SpeechModel {
    match language {
        "de" => &SMALL,
        _ => &SMALL_EN,
    }
}
/// The model file a transcription runs, and its alignment preset (`None`
/// for a custom model without `CUEREVIEW_DTW_MODEL`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelChoice {
    pub path: PathBuf,
    pub dtw: Option<String>,
}
/// The model for a final transcription in `language`: its own model once
/// installed, else base. `CUEREVIEW_MODEL` replaces both.
pub fn final_model(language: &str) -> ModelChoice {
    custom_model().unwrap_or_else(|| {
        let models = data_root().join("models");
        let model = choose_model(&models, language);
        ModelChoice {
            path: model.path_in(&models),
            dtw: Some(model.dtw.into()),
        }
    })
}
/// The model for live words while recording: base, which is quicker per update.
pub fn live_model() -> ModelChoice {
    custom_model().unwrap_or_else(|| ModelChoice {
        path: model_path(),
        dtw: Some(BASE.dtw.into()),
    })
}
fn custom_model() -> Option<ModelChoice> {
    std::env::var_os("CUEREVIEW_MODEL").map(|path| ModelChoice {
        path: PathBuf::from(path),
        dtw: std::env::var("CUEREVIEW_DTW_MODEL").ok(),
    })
}
fn choose_model(models: &Path, language: &str) -> &'static SpeechModel {
    let model = language_model(language);
    if model.installed_in(models) {
        model
    } else {
        &BASE
    }
}

/// The background download of the chosen language's model.
#[derive(Clone, Debug, Default)]
struct Fetch {
    model: &'static str,
    received: u64,
    running: bool,
    error: Option<String>,
}
fn fetch_state() -> &'static Mutex<Fetch> {
    static STATE: OnceLock<Mutex<Fetch>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn chosen_language() -> &'static str {
    settings::language(&settings::load(&data_root()))
}
/// Downloads the chosen language's model unless it is installed, blocking,
/// with its progress in [`setup_status`]. Used by `cue setup --install`.
pub fn fetch_language_model() -> Result<(), String> {
    let model = language_model(chosen_language());
    let models = data_root().join("models");
    if std::env::var_os("CUEREVIEW_MODEL").is_some() || model.installed_in(&models) {
        return Ok(());
    }
    {
        let mut state = fetch_state().lock().unwrap_or_else(|e| e.into_inner());
        if state.running {
            return Err("The language model is already being downloaded.".into());
        }
        *state = Fetch {
            model: model.name,
            running: true,
            ..Default::default()
        };
    }
    fs::create_dir_all(&models).map_err(|e| e.to_string())?;
    let result = download_checked(
        &model.url(),
        &model.path_in(&models),
        model.size,
        model.sha256,
        &|received| {
            fetch_state()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .received = received
        },
    );
    let mut state = fetch_state().lock().unwrap_or_else(|e| e.into_inner());
    state.running = false;
    state.error = result.as_ref().err().cloned();
    result
}
/// Starts [`fetch_language_model`] on its own thread, when transcription is
/// set up (base installed) and the chosen language's model is not.
pub fn start_language_model_download() {
    if speech_model_ready() {
        std::thread::spawn(|| {
            let _ = fetch_language_model();
        });
    }
}
fn language_model_status() -> Option<LanguageModel> {
    if std::env::var_os("CUEREVIEW_MODEL").is_some() {
        return None;
    }
    let language = chosen_language();
    let model = language_model(language);
    let models = data_root().join("models");
    let fetch = fetch_state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let ours = fetch.model == model.name;
    let (state, received, error) = if model.installed_in(&models) {
        ("ready", model.size, None)
    } else if ours && fetch.running {
        ("downloading", fetch.received, None)
    } else if ours && fetch.error.is_some() {
        ("failed", 0, fetch.error)
    } else {
        ("missing", 0, None)
    };
    Some(LanguageModel {
        language: language.into(),
        model: model.name.into(),
        state: state.into(),
        received_bytes: received,
        total_bytes: model.size,
        error,
    })
}
pub fn model_path() -> PathBuf {
    std::env::var_os("CUEREVIEW_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root().join("models").join(BASE.file))
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
        language_model: language_model_status(),
    }
}
fn download(url: &str, target: &Path, expected: Option<&str>) -> Result<(), String> {
    download_to(url, target, None, expected, &|_| ())
}
/// Downloads a model of known size and SHA-256, reporting the bytes received.
fn download_checked(
    url: &str,
    target: &Path,
    size: u64,
    sha256: &str,
    progress: &dyn Fn(u64),
) -> Result<(), String> {
    download_to(url, target, Some(size), Some(sha256), progress)
}
/// Streams `url` into `<target>.download` and renames it to `target` only when
/// the size and SHA-256 match; any failure removes the partial file.
fn download_to(
    url: &str,
    target: &Path,
    size: Option<u64>,
    sha256: Option<&str>,
    progress: &dyn Fn(u64),
) -> Result<(), String> {
    let temp = target.with_extension("download");
    let result = (|| {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .user_agent("CueReview/0.2")
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Download failed: {e}"))?;
        let mut out = fs::File::create(&temp).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buf = [0u8; 65536];
        let mut received = 0u64;
        loop {
            let n = response
                .read(&mut buf)
                .map_err(|e| format!("Download failed: {e}"))?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            received += n as u64;
            progress(received);
        }
        out.sync_all().map_err(|e| e.to_string())?;
        drop(out);
        if size.is_some_and(|size| size != received) {
            return Err(format!(
                "The download stopped after {received} of {} bytes.",
                size.unwrap_or_default()
            ));
        }
        if sha256.is_some_and(|expected| format!("{:x}", hash.finalize()) != expected) {
            return Err("Downloaded file failed its SHA-256 integrity check.".into());
        }
        fs::rename(&temp, target).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
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
        download_checked(&BASE.url(), &model_path(), BASE.size, BASE.sha256, &|_| ())?;
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
            m.len() == BASE.size
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

    /// A models folder holding files of exactly these models' sizes (sparse).
    fn models(installed: &[&SpeechModel]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for model in installed {
            fs::File::create(model.path_in(dir.path()))
                .unwrap()
                .set_len(model.size)
                .unwrap();
        }
        dir
    }

    #[test]
    fn english_uses_small_en_by_default() {
        let dir = models(&[&BASE, &SMALL_EN]);
        let language = settings::language(&Default::default());
        assert_eq!(choose_model(dir.path(), language), &SMALL_EN);
        assert_eq!(SMALL_EN.dtw, "small.en");
    }

    #[test]
    fn german_uses_the_multilingual_small_model() {
        let dir = models(&[&BASE, &SMALL_EN, &SMALL]);
        assert_eq!(choose_model(dir.path(), "de"), &SMALL);
        assert_eq!(SMALL.dtw, "small");
    }

    #[test]
    fn a_missing_language_model_falls_back_to_base() {
        let dir = models(&[&BASE]);
        assert_eq!(choose_model(dir.path(), "en"), &BASE);
        assert_eq!(choose_model(dir.path(), "de"), &BASE);
        // A file of the wrong size, such as one cut off, is not installed.
        fs::File::create(SMALL_EN.path_in(dir.path()))
            .unwrap()
            .set_len(SMALL_EN.size - 1)
            .unwrap();
        assert_eq!(choose_model(dir.path(), "en"), &BASE);
    }

    /// Serves `body` once over HTTP on a local port and returns its URL.
    fn serve_once(body: &'static [u8]) -> String {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/model.bin", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        });
        url
    }

    #[test]
    fn a_damaged_model_download_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("ggml-small.en.bin");
        let good = format!("{:x}", Sha256::digest(b"model bytes"));
        let error =
            download_checked(&serve_once(b"wrong bytes"), &target, 11, &good, &|_| ()).unwrap_err();
        assert!(error.contains("SHA-256"), "{error}");
        let error =
            download_checked(&serve_once(b"model"), &target, 11, &good, &|_| ()).unwrap_err();
        assert!(error.contains("stopped after 5 of 11 bytes"), "{error}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        let received = std::sync::atomic::AtomicU64::new(0);
        download_checked(&serve_once(b"model bytes"), &target, 11, &good, &|n| {
            received.store(n, std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"model bytes");
        assert_eq!(received.into_inner(), 11);
    }

    #[test]
    fn the_plain_build_runs_where_the_vector_build_cannot() {
        let (_dir, plain) = runtime(true);
        assert_eq!(vector_build(&plain, false), plain);
        let (_dir, plain) = runtime(false);
        assert_eq!(vector_build(&plain, true), plain);
    }
}
