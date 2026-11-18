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
/// The model of a transcription language: small.en for English (`"en"`),
/// the multilingual small model, held to the language, for every other.
pub fn language_model(language: &str) -> &'static SpeechModel {
    match language {
        "en" => &SMALL_EN,
        _ => &SMALL,
    }
}
/// The models the language chosen in Settings needs, in download order:
/// both small models for Auto (`None`), the English one first, because any
/// take can turn out to be in either; else the chosen language's model.
pub fn needed_models(chosen: Option<&str>) -> Vec<&'static SpeechModel> {
    match chosen {
        None => vec![&SMALL_EN, &SMALL],
        Some(language) => vec![language_model(language)],
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
/// The final models of one take, chosen once when it starts, so every
/// stretch of the take in one language comes from the same model whatever
/// finishes downloading meanwhile.
pub struct TakeModels {
    english: ModelChoice,
    other: ModelChoice,
}
impl TakeModels {
    pub fn now() -> Self {
        Self {
            english: final_model("en"),
            // Any other code: they all use the multilingual model.
            other: final_model("de"),
        }
    }
    pub fn of(&self, language: &str) -> &ModelChoice {
        if language_model(language).name == SMALL_EN.name {
            &self.english
        } else {
            &self.other
        }
    }
}
/// The model for live words while recording, and for detecting a take's
/// language: base, which is multilingual and quicker per update.
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

/// The background download of the models the chosen language needs.
#[derive(Clone, Debug, Default)]
struct Fetch {
    /// The model being or last downloaded, by name.
    model: &'static str,
    received: u64,
    running: bool,
    /// Set when the chosen language changed during a download and no longer
    /// needs its model: the running download stops and the loop moves on to
    /// what the new choice needs.
    cancel: bool,
    error: Option<String>,
}
fn fetch_state() -> &'static Mutex<Fetch> {
    static STATE: OnceLock<Mutex<Fetch>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn locked(state: &Mutex<Fetch>) -> std::sync::MutexGuard<'_, Fetch> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}
/// The language chosen in Settings; `None` is Auto.
fn chosen_language() -> Option<&'static str> {
    settings::chosen_language(&settings::load(&data_root()))
}
fn needs(wanted: &[&SpeechModel], name: &str) -> bool {
    wanted.iter().any(|model| model.name == name)
}
fn models_dir() -> PathBuf {
    data_root().join("models")
}
/// Downloads a model into a models folder, reporting the bytes received to a
/// progress callback that returns false to stop it.
type Downloader<'a> = &'a dyn Fn(&SpeechModel, &Path, &dyn Fn(u64) -> bool) -> Result<(), String>;
/// Takes the fetch for this caller, or returns false when one is running. A
/// running fetch whose model none of `wanted` is, is told to move on.
fn claim(state: &Mutex<Fetch>, wanted: &[&SpeechModel]) -> bool {
    let mut fetch = locked(state);
    if fetch.running {
        // Choosing a language that needs the model being fetched takes back
        // an earlier stop.
        fetch.cancel = !needs(wanted, fetch.model);
        return false;
    }
    *fetch = Fetch {
        model: wanted.first().map_or("", |model| model.name),
        running: true,
        ..Default::default()
    };
    true
}
/// Tells a running download of a model none of `wanted` is, which are all
/// installed, to stop.
fn stop_other(state: &Mutex<Fetch>, wanted: &[&SpeechModel]) {
    let mut fetch = locked(state);
    if fetch.running {
        fetch.cancel = !needs(wanted, fetch.model);
    }
}
/// Downloads every model the chosen language needs, in order, until all are
/// installed, asking `chosen` again after each download, so a language
/// chosen meanwhile gets its models too. Stops at the first failure of a
/// model still needed, and releases the fetch.
fn fetch_loop(
    models: &Path,
    chosen: &dyn Fn() -> Option<&'static str>,
    download: Downloader<'_>,
    state: &Mutex<Fetch>,
) -> Result<(), String> {
    let missing = || {
        needed_models(chosen())
            .into_iter()
            .find(|model| !model.installed_in(models))
    };
    loop {
        let Some(model) = missing() else {
            // Released under the lock that a refused claim takes, after
            // asking once more: a language chosen meanwhile is fetched too.
            let mut fetch = locked(state);
            if missing().is_none() {
                fetch.running = false;
                return Ok(());
            }
            continue;
        };
        {
            let mut fetch = locked(state);
            fetch.model = model.name;
            fetch.received = 0;
            fetch.cancel = false;
            fetch.error = None;
        }
        let stopped = std::cell::Cell::new(false);
        let outcome = download(model, models, &|received| {
            let mut fetch = locked(state);
            fetch.received = received;
            stopped.set(fetch.cancel);
            !fetch.cancel
        });
        if let Err(error) = outcome {
            let mut fetch = locked(state);
            // A download stopped for another language is no failure, even
            // when that language is taken back before this point.
            if !stopped.get() && needs(&needed_models(chosen()), model.name) {
                fetch.error = Some(error.clone());
                fetch.running = false;
                return Err(error);
            }
        }
    }
}
/// The model's download, with failures said plainly.
fn download_model(
    model: &SpeechModel,
    models: &Path,
    progress: &dyn Fn(u64) -> bool,
) -> Result<(), String> {
    fs::create_dir_all(models).map_err(|e| e.to_string())?;
    download_checked(
        &model.url(),
        &model.path_in(models),
        model.size,
        model.sha256,
        progress,
    )
    .map_err(|error| {
        eprintln!("The {} model's download failed: {error}", model.name);
        plain_download_error(&error)
    })
}
fn plain_download_error(error: &str) -> String {
    if error.contains("SHA-256") {
        "The downloaded file was damaged, so it was removed.".into()
    } else if error.contains("error sending request") {
        "Hugging Face could not be reached.".into()
    } else if error.starts_with("Download failed") || error.starts_with("The download stopped") {
        "The download was cut off.".into()
    } else {
        format!("The model could not be saved: {error}")
    }
}
/// The size of `model`'s partial download when another process is writing it:
/// it changed within the last 30 s.
fn growing_partial(model: &Path) -> Option<u64> {
    let partial = model.with_extension("download").metadata().ok()?;
    let age = partial.modified().ok()?.elapsed().unwrap_or_default();
    (age < Duration::from_secs(30)).then_some(partial.len())
}
/// Removes partial downloads that a closed app left behind.
fn sweep_partial(models: &Path) {
    for entry in fs::read_dir(models).into_iter().flatten().flatten() {
        if entry
            .path()
            .extension()
            .is_some_and(|ext| ext == "download")
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}
/// Downloads every model the chosen language needs that is not installed,
/// blocking, with the progress in [`setup_status`]. Used by
/// `cue setup --install`.
pub fn fetch_language_models() -> Result<(), String> {
    if std::env::var_os("CUEREVIEW_MODEL").is_some() {
        return Ok(());
    }
    let models = models_dir();
    if !claim(fetch_state(), &needed_models(chosen_language())) {
        return Err("The language models are already being downloaded.".into());
    }
    sweep_partial(&models);
    fetch_loop(&models, &chosen_language, &download_model, fetch_state())
}
/// Starts downloading the models the chosen language needs on their own
/// thread, unless they are installed. A download already running moves on to
/// them. Refused until Install transcription has put base and the speech
/// tools in place.
pub fn start_language_models_download() -> Result<(), String> {
    if std::env::var_os("CUEREVIEW_MODEL").is_some() {
        return Ok(());
    }
    if !speech_model_ready() {
        return Err(
            "Install transcription first, then the language models download by themselves.".into(),
        );
    }
    let models = models_dir();
    let wanted = needed_models(chosen_language());
    if wanted.iter().all(|model| model.installed_in(&models)) {
        stop_other(fetch_state(), &wanted);
        return Ok(());
    }
    if !claim(fetch_state(), &wanted) {
        return Ok(());
    }
    sweep_partial(&models);
    std::thread::spawn(move || {
        let _ = fetch_loop(&models, &chosen_language, &download_model, fetch_state());
    });
    Ok(())
}
/// The models the chosen language needs and their download, in download
/// order, for Settings and `cue setup`. Empty when `CUEREVIEW_MODEL`
/// replaces them.
pub fn language_models_status() -> Vec<LanguageModel> {
    if std::env::var_os("CUEREVIEW_MODEL").is_some() {
        return Vec::new();
    }
    let fetch = locked(fetch_state()).clone();
    statuses_of(&models_dir(), chosen_language(), &fetch)
}
fn statuses_of(models: &Path, chosen: Option<&str>, fetch: &Fetch) -> Vec<LanguageModel> {
    needed_models(chosen)
        .into_iter()
        .map(|model| status_of(models, model, fetch))
        .collect()
}
fn status_of(models: &Path, model: &SpeechModel, fetch: &Fetch) -> LanguageModel {
    let ours = fetch.model == model.name;
    let (state, received, error) = if model.installed_in(models) {
        ("ready", model.size, None)
    } else if fetch.running {
        // A download of another model moves on to this one next.
        ("downloading", if ours { fetch.received } else { 0 }, None)
    } else if let Some(received) = growing_partial(&model.path_in(models)) {
        // The app downloads it while `cue setup` asks.
        ("downloading", received, None)
    } else if ours && fetch.error.is_some() {
        ("failed", 0, fetch.error.clone())
    } else {
        ("missing", 0, None)
    };
    LanguageModel {
        model: model.name.into(),
        state: state.into(),
        received_bytes: received,
        total_bytes: model.size,
        error,
    }
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
        language_models: language_models_status(),
    }
}
fn download(url: &str, target: &Path, expected: Option<&str>) -> Result<(), String> {
    download_to(url, target, None, expected, &|_| true)
}
/// Downloads a model of known size and SHA-256, reporting the bytes received.
fn download_checked(
    url: &str,
    target: &Path,
    size: u64,
    sha256: &str,
    progress: &dyn Fn(u64) -> bool,
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
    progress: &dyn Fn(u64) -> bool,
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
            if !progress(received) {
                return Err("The download was stopped.".into());
            }
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
        download_checked(&BASE.url(), &model_path(), BASE.size, BASE.sha256, &|_| {
            true
        })?;
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
    fn english_uses_small_en_and_every_other_language_the_multilingual_model() {
        let dir = models(&[&BASE, &SMALL_EN, &SMALL]);
        assert_eq!(choose_model(dir.path(), "en"), &SMALL_EN);
        // Each model aligns with its own preset.
        assert_eq!((SMALL_EN.dtw, SMALL.dtw), ("small.en", "small"));
        // Every other language of the speech model, German included.
        for (code, _) in settings::LANGUAGES {
            let expected = if code == "en" { &SMALL_EN } else { &SMALL };
            assert_eq!(language_model(code), expected, "{code}");
            assert_eq!(choose_model(dir.path(), code), expected, "{code}");
        }
        // What a choice in Settings needs: its own model, both for Auto.
        assert_eq!(needed_models(Some("en")), [&SMALL_EN]);
        assert_eq!(needed_models(Some("de")), [&SMALL]);
        assert_eq!(needed_models(Some("ja")), [&SMALL]);
        assert_eq!(needed_models(None), [&SMALL_EN, &SMALL]);
        // One model is enough for the takes in its language.
        let english_only = models(&[&BASE, &SMALL_EN]);
        assert_eq!(choose_model(english_only.path(), "en"), &SMALL_EN);
        assert_eq!(choose_model(english_only.path(), "de"), &BASE);
    }

    #[test]
    fn a_missing_language_model_falls_back_to_base() {
        let dir = models(&[&BASE]);
        assert_eq!(choose_model(dir.path(), "en"), &BASE);
        assert_eq!(choose_model(dir.path(), "de"), &BASE);
        assert_eq!(choose_model(dir.path(), "fr"), &BASE);
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
        let error = download_checked(&serve_once(b"wrong bytes"), &target, 11, &good, &|_| true)
            .unwrap_err();
        assert!(error.contains("SHA-256"), "{error}");
        let error =
            download_checked(&serve_once(b"model"), &target, 11, &good, &|_| true).unwrap_err();
        assert!(error.contains("stopped after 5 of 11 bytes"), "{error}");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        let received = std::sync::atomic::AtomicU64::new(0);
        download_checked(&serve_once(b"model bytes"), &target, 11, &good, &|n| {
            received.store(n, std::sync::atomic::Ordering::Relaxed);
            true
        })
        .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"model bytes");
        assert_eq!(received.into_inner(), 11);
    }

    /// A downloader that installs each model it is asked for, after calling
    /// `during` once, and records the order.
    fn installs<'a>(
        order: &'a std::cell::RefCell<Vec<&'static str>>,
        during: &'a dyn Fn(&'static str),
    ) -> impl Fn(&SpeechModel, &Path, &dyn Fn(u64) -> bool) -> Result<(), String> + 'a {
        move |model, models, progress| {
            order.borrow_mut().push(model.name);
            during(model.name);
            if !progress(1000) {
                return Err("The download was stopped.".into());
            }
            fs::File::create(model.path_in(models))
                .unwrap()
                .set_len(model.size)
                .unwrap();
            Ok(())
        }
    }

    /// The state of each model `chosen` needs, in order.
    fn states(models: &Path, chosen: Option<&str>, fetch: &Fetch) -> Vec<(String, String)> {
        statuses_of(models, chosen, fetch)
            .into_iter()
            .map(|status| (status.model, status.state))
            .collect()
    }
    fn pairs(states: &[(&str, &str)]) -> Vec<(String, String)> {
        states
            .iter()
            .map(|&(model, state)| (model.to_owned(), state.to_owned()))
            .collect()
    }

    #[test]
    fn a_language_chosen_during_a_download_gets_its_model() {
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let language = std::cell::Cell::new(Some("en"));
        let order = std::cell::RefCell::new(Vec::new());
        // German is chosen while small.en downloads: the start is refused but
        // tells the running download to move on.
        let during = |name: &'static str| {
            if name == "small.en" {
                language.set(Some("de"));
                assert!(!claim(&state, &needed_models(Some("de"))));
                let status = status_of(dir.path(), &SMALL, &locked(&state));
                assert_eq!(status.state, "downloading");
            }
        };
        assert!(claim(&state, &needed_models(Some("en"))));
        let chosen = || language.get();
        fetch_loop(dir.path(), &chosen, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small.en", "small"]);
        assert!(SMALL.installed_in(dir.path()));
        assert!(
            !SMALL_EN.installed_in(dir.path()),
            "the stopped download is not kept"
        );
        let fetch = locked(&state).clone();
        assert!(!fetch.running);
        assert_eq!(status_of(dir.path(), &SMALL, &fetch).state, "ready");
        assert_eq!(status_of(dir.path(), &SMALL_EN, &fetch).state, "missing");
    }

    #[test]
    fn auto_fetches_both_small_models_english_first() {
        // An installation with only base, and no language ever chosen.
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let order = std::cell::RefCell::new(Vec::new());
        assert_eq!(
            states(dir.path(), None, &locked(&state)),
            pairs(&[("small.en", "missing"), ("small", "missing")])
        );
        // While the English model downloads, the other one waits its turn.
        let during = |name: &'static str| {
            let fetch = locked(&state).clone();
            let waiting = if name == "small.en" {
                [("small.en", "downloading"), ("small", "downloading")]
            } else {
                [("small.en", "ready"), ("small", "downloading")]
            };
            assert_eq!(states(dir.path(), None, &fetch), pairs(&waiting));
        };
        assert!(claim(&state, &needed_models(None)));
        fetch_loop(dir.path(), &|| None, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small.en", "small"]);
        let fetch = locked(&state).clone();
        assert!(!fetch.running);
        assert_eq!(
            states(dir.path(), None, &fetch),
            pairs(&[("small.en", "ready"), ("small", "ready")])
        );

        // An installation that already has small.en fetches only the other.
        let upgraded = models(&[&BASE, &SMALL_EN]);
        let state = Mutex::new(Fetch::default());
        let order = std::cell::RefCell::new(Vec::new());
        assert!(claim(&state, &needed_models(None)));
        fetch_loop(
            upgraded.path(),
            &|| None,
            &installs(&order, &|_| ()),
            &state,
        )
        .unwrap();
        assert_eq!(*order.borrow(), ["small"]);

        // A fixed language fetches its own model only.
        for (language, model) in [("en", "small.en"), ("de", "small"), ("fr", "small")] {
            let dir = models(&[&BASE]);
            let state = Mutex::new(Fetch::default());
            let order = std::cell::RefCell::new(Vec::new());
            assert!(claim(&state, &needed_models(Some(language))));
            let chosen = || Some(language);
            fetch_loop(dir.path(), &chosen, &installs(&order, &|_| ()), &state).unwrap();
            assert_eq!(*order.borrow(), [model], "{language}");
        }
    }

    #[test]
    fn a_changed_choice_stops_only_a_download_nothing_needs() {
        // Auto downloads small.en; choosing English keeps it and drops small.
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let language = std::cell::Cell::new(None);
        let order = std::cell::RefCell::new(Vec::new());
        let during = |name: &'static str| {
            if name == "small.en" {
                language.set(Some("en"));
                assert!(!claim(&state, &needed_models(Some("en"))));
                assert!(!locked(&state).cancel, "English still needs small.en");
            }
        };
        assert!(claim(&state, &needed_models(None)));
        let chosen = || language.get();
        fetch_loop(dir.path(), &chosen, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small.en"]);
        assert!(!SMALL.installed_in(dir.path()));

        // Auto downloads small.en; choosing German stops it for small.
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let language = std::cell::Cell::new(None);
        let order = std::cell::RefCell::new(Vec::new());
        let during = |name: &'static str| {
            if name == "small.en" {
                language.set(Some("de"));
                assert!(!claim(&state, &needed_models(Some("de"))));
                assert!(locked(&state).cancel, "German has no use for small.en");
            }
        };
        assert!(claim(&state, &needed_models(None)));
        let chosen = || language.get();
        fetch_loop(dir.path(), &chosen, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small.en", "small"]);
        assert!(SMALL.installed_in(dir.path()) && !SMALL_EN.installed_in(dir.path()));
        assert!(locked(&state).error.is_none());

        // German downloads small; going back to Auto keeps it and adds small.en.
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let language = std::cell::Cell::new(Some("de"));
        let order = std::cell::RefCell::new(Vec::new());
        let during = |name: &'static str| {
            if name == "small" && language.get().is_some() {
                language.set(None);
                assert!(!claim(&state, &needed_models(None)));
                assert!(!locked(&state).cancel, "Auto needs small too");
            }
        };
        assert!(claim(&state, &needed_models(Some("de"))));
        let chosen = || language.get();
        fetch_loop(dir.path(), &chosen, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small", "small.en"]);
    }

    #[test]
    fn choosing_the_fetched_language_again_keeps_its_download() {
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let order = std::cell::RefCell::new(Vec::new());
        // English, German, English again, all within one read of small.en.
        let during = |name: &'static str| {
            if name == "small.en" && order.borrow().len() == 1 {
                assert!(!claim(&state, &[&SMALL]));
                assert!(!claim(&state, &[&SMALL_EN]));
            }
        };
        assert!(claim(&state, &[&SMALL_EN]));
        let english = || Some("en");
        fetch_loop(dir.path(), &english, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small.en"]);
        assert!(SMALL_EN.installed_in(dir.path()));
        assert!(locked(&state).error.is_none());
    }

    #[test]
    fn a_stop_taken_back_is_no_failure() {
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let calls = std::cell::Cell::new(0);
        // German is chosen, the download of small.en stops at its next chunk,
        // and English is chosen again before the stop is looked at.
        let download = |model: &SpeechModel, models: &Path, progress: &dyn Fn(u64) -> bool| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                assert!(!claim(&state, &[&SMALL]));
                assert!(!progress(1000), "the stop reaches the download");
                assert!(!claim(&state, &[&SMALL_EN]));
                return Err("The download was stopped.".into());
            }
            fs::File::create(model.path_in(models))
                .unwrap()
                .set_len(model.size)
                .unwrap();
            Ok(())
        };
        assert!(claim(&state, &[&SMALL_EN]));
        fetch_loop(dir.path(), &|| Some("en"), &download, &state).unwrap();
        assert_eq!(calls.get(), 2, "small.en is fetched again");
        assert!(locked(&state).error.is_none());
        assert!(SMALL_EN.installed_in(dir.path()));
    }

    #[test]
    fn choosing_an_installed_language_stops_the_other_download() {
        let state = Mutex::new(Fetch::default());
        assert!(claim(&state, &[&SMALL]));
        stop_other(&state, &[&SMALL_EN]);
        assert!(locked(&state).cancel, "the German download stops");
        stop_other(&state, &[&SMALL]);
        assert!(!locked(&state).cancel, "German again keeps it");
        stop_other(&state, &[&SMALL_EN]);
        stop_other(&state, &[&SMALL_EN, &SMALL]);
        assert!(!locked(&state).cancel, "Auto keeps it too");
        locked(&state).running = false;
        stop_other(&state, &[&SMALL_EN]);
        assert!(!locked(&state).cancel, "nothing runs, nothing to stop");
    }

    #[test]
    fn a_download_another_process_writes_reads_as_downloading() {
        let dir = models(&[&BASE]);
        let idle = Fetch::default();
        let partial = dir.path().join("ggml-small.download");
        fs::write(&partial, b"part").unwrap();
        let status = status_of(dir.path(), &SMALL, &idle);
        assert_eq!(
            (status.state.as_str(), status.received_bytes),
            ("downloading", 4)
        );
        // A partial file nobody has written to for a while is left over, not a download.
        let old = std::time::SystemTime::now() - Duration::from_secs(120);
        fs::File::options()
            .write(true)
            .open(&partial)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(status_of(dir.path(), &SMALL, &idle).state, "missing");
    }

    #[test]
    fn the_download_state_follows_the_fetch() {
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        assert_eq!(
            status_of(dir.path(), &SMALL_EN, &locked(&state)).state,
            "missing"
        );
        assert!(claim(&state, &[&SMALL_EN]));
        assert!(!claim(&state, &[&SMALL_EN]), "one download at a time");
        locked(&state).received = 5;
        let downloading = status_of(dir.path(), &SMALL_EN, &locked(&state));
        assert_eq!(
            (downloading.state.as_str(), downloading.received_bytes),
            ("downloading", 5)
        );
        let fail = |_: &SpeechModel, _: &Path, _: &dyn Fn(u64) -> bool| -> Result<(), String> {
            Err("The download was cut off.".into())
        };
        let english = || Some("en");
        let error = fetch_loop(dir.path(), &english, &fail, &state).unwrap_err();
        assert_eq!(error, "The download was cut off.");
        let failed = status_of(dir.path(), &SMALL_EN, &locked(&state));
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.error.as_deref(), Some("The download was cut off."));
        assert_eq!(
            status_of(dir.path(), &SMALL, &locked(&state)).state,
            "missing",
            "another model's failure is not this one's"
        );
        // Under Auto the list says which of the two failed.
        assert_eq!(
            states(dir.path(), None, &locked(&state)),
            pairs(&[("small.en", "failed"), ("small", "missing")])
        );
        // Try again claims it anew.
        assert!(claim(&state, &[&SMALL_EN]));
        let order = std::cell::RefCell::new(Vec::new());
        fetch_loop(dir.path(), &english, &installs(&order, &|_| ()), &state).unwrap();
        let ready = status_of(dir.path(), &SMALL_EN, &locked(&state));
        assert_eq!(
            (ready.state.as_str(), ready.received_bytes),
            ("ready", SMALL_EN.size)
        );
    }

    #[test]
    fn download_failures_are_said_plainly_and_partial_files_swept() {
        assert_eq!(
            plain_download_error("Downloaded file failed its SHA-256 integrity check."),
            "The downloaded file was damaged, so it was removed."
        );
        assert_eq!(
            plain_download_error("Download failed: error sending request for url (https://x)"),
            "Hugging Face could not be reached."
        );
        assert_eq!(
            plain_download_error("The download stopped after 5 of 11 bytes."),
            "The download was cut off."
        );
        let dir = models(&[&BASE]);
        fs::write(dir.path().join("ggml-small.en.download"), b"part").unwrap();
        sweep_partial(dir.path());
        assert!(!dir.path().join("ggml-small.en.download").exists());
        assert!(BASE.installed_in(dir.path()));
    }

    #[test]
    fn the_plain_build_runs_where_the_vector_build_cannot() {
        let (_dir, plain) = runtime(true);
        assert_eq!(vector_build(&plain, false), plain);
        let (_dir, plain) = runtime(false);
        assert_eq!(vector_build(&plain, true), plain);
    }
}
