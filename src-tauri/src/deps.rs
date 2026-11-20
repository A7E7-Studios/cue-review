use crate::{
    models::{
        Dependency, DeviceKind, DeviceState, LanguageModel, SetupStatus, SpeechCard, SpeechDevice,
    },
    settings,
    store::{data_root, read_json, write_json},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
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
    Ok(windowless(Command::new(tool(name)?)))
}
/// `cmd`, opening no console window on Windows.
fn windowless(cmd: Command) -> Command {
    #[cfg(windows)]
    let cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = cmd;
        cmd.creation_flags(0x08000000);
        cmd
    };
    cmd
}
/// The Vulkan build of `whisper-cli`, which runs on a graphics card: in the
/// `vulkan` subfolder of the runtime folder, on Windows only. `None` where
/// it is missing, and the processor builds transcribe as ever.
pub fn card_build() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    card_build_beside(&locate("whisper-cli").ok()?)
}
/// The Vulkan build beside the processor build `binary`, when it is there.
fn card_build_beside(binary: &Path) -> Option<PathBuf> {
    let vulkan = binary.parent()?.join("vulkan").join(binary.file_name()?);
    vulkan.is_file().then_some(vulkan)
}
/// A command running the Vulkan build of `whisper-cli`.
pub fn card_command() -> Result<Command, String> {
    let build =
        card_build().ok_or("The graphics card build of the speech runtime is not installed.")?;
    Ok(windowless(Command::new(build)))
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
/// The larger model, offered on a fast graphics card and run only there.
pub const LARGE: SpeechModel = SpeechModel {
    name: "large-v3-turbo",
    file: "ggml-large-v3-turbo.bin",
    size: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    dtw: "large.v3.turbo",
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
/// Every model the choices in Settings need, in download order: the small
/// models of the language ([`needed_models`]), which transcribe on the
/// processor and until the larger one is there, then the larger model when
/// Large is chosen.
pub fn wanted_models(chosen: Option<&str>, large: bool) -> Vec<&'static SpeechModel> {
    let mut wanted = needed_models(chosen);
    if large {
        wanted.push(&LARGE);
    }
    wanted
}
/// The same models as Settings and `cue setup` list them: the larger model
/// first.
fn listed_models(chosen: Option<&str>, large: bool) -> Vec<&'static SpeechModel> {
    let mut listed = wanted_models(chosen, large);
    listed.rotate_right(usize::from(large));
    listed
}
/// The model file a transcription runs, and its alignment preset (`None`
/// for a custom model without `CUEREVIEW_DTW_MODEL`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelChoice {
    pub path: PathBuf,
    pub dtw: Option<String>,
}
/// The small model for a final transcription in `language`: its own model
/// once installed, else base. `CUEREVIEW_MODEL` replaces both. It is what
/// the processor transcribes with.
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
fn large_model() -> ModelChoice {
    ModelChoice {
        path: LARGE.path_in(&models_dir()),
        dtw: Some(LARGE.dtw.into()),
    }
}
/// How one final transcription runs: on the graphics card `card` of the
/// Vulkan build, or on the processor build with `None`, with `model`; and
/// `small`, the small model of its language, which does it again on the
/// processor when the card fails.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalRun {
    pub card: Option<u32>,
    pub model: ModelChoice,
    pub small: ModelChoice,
}
impl FinalRun {
    /// On the processor build with `small`.
    pub fn processor(small: ModelChoice) -> Self {
        Self {
            card: None,
            model: small.clone(),
            small,
        }
    }
    /// On `card` when there is one, with `large` when it is given, else
    /// `small`; on the processor with `small` otherwise. The larger model
    /// never runs on the processor.
    pub(crate) fn on(card: Option<u32>, large: Option<ModelChoice>, small: ModelChoice) -> Self {
        match card {
            Some(_) => Self {
                card,
                model: large.unwrap_or_else(|| small.clone()),
                small,
            },
            None => Self::processor(small),
        }
    }
}
/// How a final transcription in `language` runs now ([`Facts::card`],
/// [`Facts::large`]): Stop's pass, Retry, `cue transcribe` and the refining
/// pass.
pub fn final_run(language: &str) -> FinalRun {
    let facts = Facts::now();
    let large = (facts.large() && custom_model().is_none()).then(large_model);
    FinalRun::on(facts.card(), large, final_model(language))
}
/// The final models of one take, chosen once when it starts, so every
/// stretch of the take in one language comes from the same model whatever
/// finishes downloading meanwhile.
pub struct TakeModels {
    english: ModelChoice,
    other: ModelChoice,
    /// The larger model, when it may transcribe the take on the card.
    large: Option<ModelChoice>,
}
impl TakeModels {
    pub fn now() -> Self {
        let large = Facts::now().large_fits() && custom_model().is_none();
        Self {
            english: final_model("en"),
            // Any other code: they all use the multilingual model.
            other: final_model("de"),
            large: large.then(large_model),
        }
    }
    /// The small model of `language`.
    pub fn of(&self, language: &str) -> &ModelChoice {
        if language_model(language).name == SMALL_EN.name {
            &self.english
        } else {
            &self.other
        }
    }
    /// How a stretch in `language` runs: on the card in use now, which the
    /// switch or a failure can stop during the take, with the take's larger
    /// model when it has one; else with the small model on the processor.
    pub fn run_of(&self, language: &str) -> FinalRun {
        self.run_on(Facts::now().card(), language)
    }
    /// [`TakeModels::run_of`] on `card`, or on the processor with `None`.
    fn run_on(&self, card: Option<u32>, language: &str) -> FinalRun {
        FinalRun::on(card, self.large.clone(), self.of(language).clone())
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
/// The models the choices saved in Settings need, in download order.
fn wanted_now() -> Vec<&'static SpeechModel> {
    let settings = settings::load(&data_root());
    wanted_models(
        settings::chosen_language(&settings),
        settings::large_chosen(&settings),
    )
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
/// Downloads every model the choices need, in order, until all are
/// installed, asking `wanted` for them again after each download, so a
/// language or model chosen meanwhile gets its models too. Stops at the
/// first failure of a model still needed, and releases the fetch.
fn fetch_loop(
    models: &Path,
    wanted: &dyn Fn() -> Vec<&'static SpeechModel>,
    download: Downloader<'_>,
    state: &Mutex<Fetch>,
) -> Result<(), String> {
    let missing = || {
        wanted()
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
            if !stopped.get() && needs(&wanted(), model.name) {
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
/// Downloads every model the choices in Settings need that is not
/// installed, blocking, with the progress in [`setup_status`]: the chosen
/// language's, and the larger model when Large is chosen. Used by
/// `cue setup --install`.
pub fn fetch_language_models() -> Result<(), String> {
    if std::env::var_os("CUEREVIEW_MODEL").is_some() {
        return Ok(());
    }
    let models = models_dir();
    if !claim(fetch_state(), &wanted_now()) {
        return Err("The language models are already being downloaded.".into());
    }
    sweep_partial(&models);
    fetch_loop(&models, &wanted_now, &download_model, fetch_state())
}
/// Starts downloading the models the choices in Settings need on their own
/// thread, unless they are installed. A download already running moves on to
/// them. Refused until Install transcription has put base and the speech
/// tools in place. Once they are installed the app's measurement worker is
/// woken, which times the larger model on the card after its download.
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
    let wanted = wanted_now();
    if wanted.iter().all(|model| model.installed_in(&models)) {
        stop_other(fetch_state(), &wanted);
        return Ok(());
    }
    if !claim(fetch_state(), &wanted) {
        return Ok(());
    }
    sweep_partial(&models);
    std::thread::spawn(move || {
        if fetch_loop(&models, &wanted_now, &download_model, fetch_state()).is_ok() {
            wake_measuring();
        }
    });
    Ok(())
}
/// The models the choices in Settings need and their download, for
/// Settings and `cue setup`: the larger model first when Large is chosen,
/// then the small models in download order. Empty when `CUEREVIEW_MODEL`
/// replaces them.
pub fn language_models_status() -> Vec<LanguageModel> {
    if std::env::var_os("CUEREVIEW_MODEL").is_some() {
        return Vec::new();
    }
    let fetch = locked(fetch_state()).clone();
    let settings = settings::load(&data_root());
    let listed = listed_models(
        settings::chosen_language(&settings),
        settings::large_chosen(&settings),
    );
    statuses_of(&models_dir(), &listed, &fetch)
}
fn statuses_of(models: &Path, listed: &[&SpeechModel], fetch: &Fetch) -> Vec<LanguageModel> {
    listed
        .iter()
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
        speech_device: speech_device_status(),
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

// The graphics card. The Vulkan build names the cards it can use in every
// run's log; a run that cannot use the card it was given falls back to the
// processor inside the same process and still exits with 0, so only its log
// tells where it ran.

/// A graphics card the Vulkan build lists: its number for `-dev` and its
/// name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Card {
    pub index: u32,
    pub name: String,
}
/// The cards a Vulkan run's log lists, in its order, from lines like
/// `ggml_vulkan: 0 = NVIDIA GeForce RTX 5090 (NVIDIA) | uma: 0 | ...`: the
/// name is what comes before the first ` | ` without its last bracketed
/// group, the driver's, so `AMD Radeon(TM) Graphics` keeps its `(TM)`.
/// Empty for the processor build's log, which has no such lines.
pub(crate) fn listed_cards(log: &str) -> Vec<Card> {
    let mut cards: Vec<Card> = Vec::new();
    for line in log.lines() {
        let Some((index, rest)) = line
            .trim()
            .strip_prefix("ggml_vulkan: ")
            .and_then(|rest| rest.split_once(" = "))
        else {
            continue;
        };
        let Ok(index) = index.parse() else {
            continue;
        };
        let described = rest.split(" | ").next().unwrap_or_default().trim();
        let name = match described.rfind(" (") {
            Some(at) if described.ends_with(')') => &described[..at],
            _ => described,
        };
        if !name.is_empty() && cards.iter().all(|card| card.index != index) {
            cards.push(Card {
                index,
                name: name.trim().into(),
            });
        }
    }
    cards
}
/// The card a run's log shows in use: `N` for
/// `whisper_backend_init_gpu: using VulkanN backend`. `None` when the run
/// was on the processor: `no GPU found`, or the processor build's log.
pub(crate) fn card_in_use(log: &str) -> Option<u32> {
    const MARK: &str = "whisper_backend_init_gpu: using Vulkan";
    let rest = &log[log.find(MARK)? + MARK.len()..];
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if !rest[digits..].starts_with(" backend") {
        return None;
    }
    rest[..digits].parse().ok()
}

/// The last measurement of the devices, saved as
/// `<data root>/speech-device.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    /// The computer it was made on: when that changes, the devices are
    /// measured again.
    pub computer: Computer,
    /// What was transcribed: [`SAMPLE`]. A measurement made on another
    /// sample, or saved before this field, is made again.
    #[serde(default)]
    pub sample: String,
    /// The model the sample was transcribed with: `small`, else `small.en`,
    /// else `base` ([`sample_model`]).
    pub model: String,
    /// The processor build's counted time for the sample, in ms.
    pub processor_ms: u64,
    /// The time the processor's counted run spent transcribing, without
    /// loading the model ([`Run::transcribing_ms`]), in ms: what the larger
    /// model's time is judged against. A measurement saved without it is
    /// made again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processor_transcribing_ms: Option<u64>,
    /// Each card the Vulkan build listed, with its counted time.
    pub cards: Vec<CardTime>,
    /// The card that transcribes: the fastest one, when it beat the
    /// processor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chosen: Option<u32>,
    /// A run on the chosen card failed or turned out to use the processor:
    /// the processor transcribes until the devices are measured again.
    #[serde(default, skip_serializing_if = "is_false")]
    pub stopped: bool,
    /// The larger model's time for the sample on the chosen card, once it
    /// was timed after its download.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large: Option<LargeTime>,
}
fn is_false(value: &bool) -> bool {
    !*value
}
/// One card of a measurement: its number for `-dev`, its name, and its
/// counted time in ms, `None` when its runs failed or used the processor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardTime {
    pub index: u32,
    pub name: String,
    pub ms: Option<u64>,
}
/// The larger model's run of the sample on the chosen card.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LargeTime {
    /// It spent this many ms transcribing, without loading the model
    /// ([`Run::transcribing_ms`]).
    Ms(u64),
    /// It failed, or the log shows the processor.
    Failed,
}
/// What decides whether the devices are measured again: the app's version,
/// the speech runtime's builds, and the display adapters with their driver
/// versions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Computer {
    pub app: String,
    /// Each build of `whisper-cli` that is timed: its folder and file name,
    /// size and write time ([`build_key`]).
    pub runtime: Vec<String>,
    pub adapters: Vec<Adapter>,
}
/// A display adapter, from the registry's display class: `DriverDesc` and
/// `DriverVersion`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub name: String,
    pub driver: String,
}
impl Measured {
    fn chosen_card(&self) -> Option<&CardTime> {
        let chosen = self.chosen?;
        self.cards.iter().find(|card| card.index == chosen)
    }
    /// Whether the larger model is offered: the chosen card ran the sample
    /// with a small model in two thirds of the processor's time or less
    /// ([`offers_large`]). A measurement made with base judges nothing.
    fn large_offered(&self) -> bool {
        small_sized(&self.model)
            && self
                .chosen_card()
                .and_then(|card| card.ms)
                .is_some_and(|ms| offers_large(self.processor_ms, ms))
    }
    /// The larger model's time spent transcribing on the card and the
    /// processor's with the small model, once both are known.
    fn transcribing_times(&self) -> Option<(u64, u64)> {
        match self.large? {
            LargeTime::Ms(large) => Some((large, self.processor_transcribing_ms?)),
            LargeTime::Failed => None,
        }
    }
    /// Whether the larger model, timed on the card, spent longer
    /// transcribing than the processor with the small model, or failed there.
    fn large_slow(&self) -> bool {
        self.large == Some(LargeTime::Failed)
            || self
                .transcribing_times()
                .is_some_and(|(large, processor)| large > processor)
    }
    /// Whether the larger model may run on the card: offered, and timed
    /// there transcribing no slower than the processor with the small model.
    fn large_fits(&self) -> bool {
        self.large_offered()
            && self
                .transcribing_times()
                .is_some_and(|(large, processor)| large <= processor)
    }
}
/// A card that runs the sample in two thirds of the processor's time or less
/// runs the larger model no slower than the processor runs the small one:
/// on the RTX 5090 the large model took 1.5 times the small one's time.
fn offers_large(processor_ms: u64, card_ms: u64) -> bool {
    card_ms * 3 <= processor_ms * 2
}
/// Whether the devices are to be measured: nothing was saved, or it was
/// saved on another computer than `now`, or on another sample than
/// [`SAMPLE`], or without the processor's transcribing time, which the
/// larger model is judged against, or with base while `model`, the
/// one the sample is timed with now ([`sample_model`]), is a small model: a
/// measurement made before the small models were there is made again with
/// one. Small and small.en are the same size, so one measured with either
/// is not made again when the other arrives.
fn needs_measuring(saved: Option<&Measured>, now: &Computer, model: Option<&SpeechModel>) -> bool {
    saved.is_none_or(|saved| {
        saved.computer != *now
            || saved.sample != SAMPLE
            || saved.processor_transcribing_ms.is_none()
            || (!small_sized(&saved.model) && model.is_some_and(|model| small_sized(model.name)))
    })
}
/// Whether a model is one of the two small ones, which share a size and
/// time the same: the multilingual small model or small.en.
fn small_sized(name: &str) -> bool {
    name == SMALL.name || name == SMALL_EN.name
}
/// Whether the larger model waits to be timed on the chosen card: it is
/// installed and offered, and the card has not stopped.
fn large_due(measured: &Measured, installed: bool) -> bool {
    installed && measured.large.is_none() && !measured.stopped && measured.large_offered()
}

/// Where one run of the sample goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum On {
    Processor,
    Card(u32),
}
/// One timed run of the sample.
#[derive(Clone, Debug, Default)]
pub(crate) struct Run {
    /// It exited with success.
    pub ok: bool,
    /// From its start to its exit.
    pub ms: u64,
    /// What it wrote to stderr.
    pub log: String,
}
impl Run {
    /// The time it spent transcribing, without loading the model, in ms:
    /// its log's [`transcribing_ms`], else its whole time.
    pub fn transcribing_ms(&self) -> u64 {
        transcribing_ms(&self.log).unwrap_or(self.ms)
    }
}
/// The time a run spent transcribing, from the timings `whisper-cli` logs
/// at its end: `total time`, from the start of loading the model to the end
/// of the run, less `load time`, in whole ms. Loading the 1.6 GB larger
/// model takes most of a run of the sample. `None` when the log lacks
/// either line.
pub(crate) fn transcribing_ms(log: &str) -> Option<u64> {
    let timing = |name: &str| {
        log.lines().rev().find_map(|line| {
            let value = line
                .trim()
                .strip_prefix("whisper_print_timings:")?
                .trim_start()
                .strip_prefix(name)?
                .trim_start()
                .strip_prefix('=')?
                .trim()
                .strip_suffix("ms")?
                .trim()
                .parse::<f64>()
                .ok()?;
            (value.is_finite() && value >= 0.0).then_some(value)
        })
    };
    let (load, total) = (timing("load time")?, timing("total time")?);
    Some((total - load).max(0.0).round() as u64)
}
/// A measurement stopped before its end, because a recording started.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Cut;
/// Runs the sample once on a device with a model; two runs can go at once.
type Sampler<'a> = &'a (dyn Fn(On, &'static SpeechModel) -> Result<Run, Cut> + Sync);

/// A device's counted time from its two runs: the second one's, when both
/// ended well and, on a card, each log shows that card in use. The first
/// carries a card's one-time warm-up.
fn counted(runs: [&Run; 2], card: Option<u32>) -> Option<u64> {
    let fine = |run: &&Run| run.ok && card.is_none_or(|card| card_in_use(&run.log) == Some(card));
    runs.iter().all(fine).then_some(runs[1].ms)
}
/// The card that transcribes: the fastest measured one, when it beat the
/// processor. A tie goes to the processor.
fn fastest(processor_ms: u64, cards: &[CardTime]) -> Option<u32> {
    cards
        .iter()
        .filter_map(|card| Some((card.ms?, card.index)))
        .filter(|&(ms, _)| ms < processor_ms)
        .min()
        .map(|(_, index)| index)
}
/// Times the sample with `model`, twice each, on the processor build and on
/// every card the Vulkan build lists, which the first run on card 0 shows,
/// and chooses the fastest. `None` when the processor's runs failed.
fn measure_with(
    computer: Computer,
    model: &'static SpeechModel,
    sample: Sampler<'_>,
) -> Result<Option<Measured>, Cut> {
    let processor = [sample(On::Processor, model)?, sample(On::Processor, model)?];
    let Some(processor_ms) = counted([&processor[0], &processor[1]], None) else {
        return Ok(None);
    };
    let mut first = Some(sample(On::Card(0), model)?);
    let listed = first
        .as_ref()
        .map_or_else(Vec::new, |run| listed_cards(&run.log));
    let mut cards = Vec::new();
    for card in listed {
        let one = match first.take().filter(|_| card.index == 0) {
            Some(run) => run,
            None => sample(On::Card(card.index), model)?,
        };
        let two = sample(On::Card(card.index), model)?;
        cards.push(CardTime {
            ms: counted([&one, &two], Some(card.index)),
            index: card.index,
            name: card.name,
        });
    }
    Ok(Some(Measured {
        computer,
        sample: SAMPLE.into(),
        model: model.name.into(),
        processor_ms,
        processor_transcribing_ms: Some(processor[1].transcribing_ms()),
        chosen: fastest(processor_ms, &cards),
        cards,
        stopped: false,
        large: None,
    }))
}
/// Times the larger model on `card`, once after its download: twice, the
/// second run counted as in the measurement, then twice at the same time, as
/// the two tracks of a take run ([`large_time`]).
fn time_large(card: u32, sample: Sampler<'_>) -> Result<LargeTime, Cut> {
    let first = sample(On::Card(card), &LARGE)?;
    let second = sample(On::Card(card), &LARGE)?;
    if counted([&first, &second], Some(card)).is_none() {
        return Ok(LargeTime::Failed);
    }
    let (one, other) = std::thread::scope(|scope| {
        let other = scope.spawn(|| sample(On::Card(card), &LARGE));
        let one = sample(On::Card(card), &LARGE);
        let other = other
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
        (one, other)
    });
    let (one, other) = (one?, other?);
    let time = large_time([&first, &second], [&one, &other], card);
    eprintln!(
        "large-v3-turbo on card {card}: {} ms, {} ms of it transcribing, two at once {} and {} ms: {time:?}",
        second.ms,
        second.transcribing_ms(),
        one.ms,
        other.ms
    );
    Ok(time)
}
/// The larger model's time on `card`: what the second of its two runs one
/// after the other (`timed`) spent transcribing, when both ended well on the
/// card, and so did both of the two it ran at the same time (`together`).
/// Otherwise it failed: a card with too little memory for two would fail
/// every take with two tracks. The card itself goes on with the small models.
fn large_time(timed: [&Run; 2], together: [&Run; 2], card: u32) -> LargeTime {
    match (counted(timed, Some(card)), counted(together, Some(card))) {
        (Some(_), Some(_)) => LargeTime::Ms(timed[1].transcribing_ms()),
        _ => LargeTime::Failed,
    }
}
/// Measures the devices into `root`'s saved measurement when they are due
/// (`asked`, or [`needs_measuring`]), then times the larger model when it
/// waits for that ([`large_due`]).
fn measure_into(
    root: &Path,
    computer: Computer,
    asked: bool,
    models: &Path,
    sample: Sampler<'_>,
) -> Result<(), Cut> {
    let mut saved = load_measured(root);
    let model = sample_model(models);
    if asked || needs_measuring(saved.as_ref(), &computer, model) {
        let Some(model) = model else {
            return Ok(());
        };
        saved = measure_with(computer, model, sample)?;
        if let Some(measured) = &saved {
            save_measured(root, measured);
        }
    }
    let large = LARGE.installed_in(models);
    if let Some(measured) = saved.as_mut().filter(|saved| large_due(saved, large)) {
        if let Some(card) = measured.chosen {
            measured.large = Some(time_large(card, sample)?);
            save_measured(root, measured);
        }
    }
    Ok(())
}

/// What decides where a final transcription runs and with which model.
#[derive(Clone, Debug, Default)]
pub(crate) struct Facts {
    /// The Vulkan build is installed.
    pub card_build: bool,
    /// The saved measurement.
    pub saved: Option<Measured>,
    /// It was made on this computer as it is now.
    pub current: bool,
    /// A measurement is queued or runs.
    pub measuring: bool,
    /// The switch "Use the graphics card" is on.
    pub switch_on: bool,
    pub large_chosen: bool,
    pub large_installed: bool,
}
impl Facts {
    fn now() -> Self {
        let root = data_root();
        let settings = settings::load(&root);
        let card_build = card_build().is_some();
        let saved = if card_build {
            load_measured(&root)
        } else {
            None
        };
        Self {
            card_build,
            current: saved
                .as_ref()
                .is_some_and(|saved| saved.computer == this_computer()),
            saved,
            measuring: locked_measuring(measuring_state()).running,
            switch_on: settings::graphics_card_on(&settings),
            large_chosen: settings::large_chosen(&settings),
            large_installed: LARGE.installed_in(&models_dir()),
        }
    }
    /// The card a final transcription runs on: the one the measurement of
    /// this computer chose, when the Vulkan build is there, the switch is on,
    /// no measurement runs and the card has not stopped. `None` is the
    /// processor build.
    pub fn card(&self) -> Option<u32> {
        if !self.card_build || !self.switch_on || self.measuring || !self.current {
            return None;
        }
        let saved = self.saved.as_ref()?;
        saved.chosen.filter(|_| !saved.stopped)
    }
    /// Whether the larger model may transcribe on the card: chosen,
    /// installed, offered by the measurement and timed on the card no slower
    /// than the processor with the small model.
    pub fn large_fits(&self) -> bool {
        self.large_chosen
            && self.large_installed
            && self.current
            && self.saved.as_ref().is_some_and(Measured::large_fits)
    }
    /// Whether the larger model transcribes a final run now: it fits and
    /// the run is on the card. It never runs on the processor.
    pub fn large(&self) -> bool {
        self.card().is_some() && self.large_fits()
    }
    /// Where transcription runs, for Settings and `cue setup`. The card and
    /// the larger model's offer come from a measurement of this computer as
    /// it is, or while measuring from the last one; a saved measurement of
    /// the computer as it was reports none.
    pub fn device(&self) -> SpeechDevice {
        let card = self.card();
        let measured = self
            .saved
            .as_ref()
            .filter(|_| self.card_build && (self.current || self.measuring));
        let chosen = measured.and_then(Measured::chosen_card);
        SpeechDevice {
            state: if self.measuring {
                DeviceState::Measuring
            } else {
                DeviceState::Ready
            },
            kind: if card.is_some() {
                DeviceKind::GraphicsCard
            } else {
                DeviceKind::Processor
            },
            name: card.and(chosen).map(|chosen| chosen.name.clone()),
            card: chosen.map(|chosen| SpeechCard {
                name: chosen.name.clone(),
                stopped: measured.is_some_and(|measured| measured.stopped),
            }),
            large_offered: measured.is_some_and(Measured::large_offered),
            large_slow: self.large_installed && measured.is_some_and(Measured::large_slow),
            large_in_use: self.large(),
            measurable: self.card_build,
        }
    }
}
/// Where transcription runs now, for Settings and `cue setup`, from the
/// saved measurement. It never measures.
pub fn speech_device_status() -> SpeechDevice {
    Facts::now().device()
}

fn device_file(root: &Path) -> PathBuf {
    root.join("speech-device.json")
}
/// Serializes the writes of the saved measurement.
fn device_file_lock() -> std::sync::MutexGuard<'static, ()> {
    static WRITING: Mutex<()> = Mutex::new(());
    WRITING.lock().unwrap_or_else(|e| e.into_inner())
}
pub(crate) fn load_measured(root: &Path) -> Option<Measured> {
    let file = device_file(root);
    file.is_file().then(|| read_json(&file).ok()).flatten()
}
fn save_measured(root: &Path, measured: &Measured) {
    let _writing = device_file_lock();
    if let Err(error) = write_json(&device_file(root), measured) {
        eprintln!("The measurement of the devices was not saved: {error}");
    }
}
/// Marks the chosen card of the saved measurement as stopped, because a run
/// on it failed or turned out to use the processor: the processor
/// transcribes until the devices are measured again.
pub fn stop_card(why: &str) {
    stop_card_in(&data_root(), why);
}
pub(crate) fn stop_card_in(root: &Path, why: &str) {
    let _writing = device_file_lock();
    let Some(mut measured) = load_measured(root) else {
        return;
    };
    if measured.chosen.is_some() && !measured.stopped {
        eprintln!("The graphics card stopped transcribing: {why}");
        measured.stopped = true;
        if let Err(error) = write_json(&device_file(root), &measured) {
            eprintln!("The stopped graphics card was not saved: {error}");
        }
    }
}

/// The measurement in the background.
#[derive(Default)]
pub(crate) struct Measuring {
    /// One is queued or runs.
    running: bool,
    /// Stops the one that runs.
    cancel: Option<Arc<AtomicBool>>,
    /// The person asked for one that has not run to its end yet.
    asked: bool,
}
fn measuring_state() -> &'static Mutex<Measuring> {
    static STATE: OnceLock<Mutex<Measuring>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn locked_measuring(state: &Mutex<Measuring>) -> std::sync::MutexGuard<'_, Measuring> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}
/// Takes the measurement for a worker and returns its stop flag, when one is
/// to run: the person asked for one now (`asked`) or before it could run to
/// its end, or `due` says so. `None` while one is queued or runs, or when
/// none is to run.
pub(crate) fn claim_measuring_in(
    state: &Mutex<Measuring>,
    asked: bool,
    due: impl FnOnce() -> bool,
) -> Option<Arc<AtomicBool>> {
    let mut measuring = locked_measuring(state);
    if measuring.running {
        return None;
    }
    measuring.asked |= asked;
    if !measuring.asked && !due() {
        return None;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    measuring.running = true;
    measuring.cancel = Some(cancel.clone());
    Some(cancel)
}
/// Releases the measurement. One that ran to its `finished` end settles a
/// request; one cut short runs again at the next idle moment, when it is
/// still due or was asked for.
pub(crate) fn finish_measuring_in(state: &Mutex<Measuring>, finished: bool) {
    let mut measuring = locked_measuring(state);
    measuring.running = false;
    measuring.cancel = None;
    if finished {
        measuring.asked = false;
    }
}
/// Stops the measurement that is queued or runs.
pub(crate) fn cancel_measuring_in(state: &Mutex<Measuring>) {
    if let Some(cancel) = &locked_measuring(state).cancel {
        cancel.store(true, Ordering::Release);
    }
}
/// Takes the measurement for the app's worker ([`claim_measuring_in`]): due
/// when the Vulkan build, the sample and a model to time it with are there,
/// and the saved measurement is missing, from another computer, made on
/// another sample, or made with base where a small model is now installed
/// ([`needs_measuring`]), or the larger model waits to be timed.
pub fn claim_measuring(asked: bool) -> Option<Arc<AtomicBool>> {
    if card_build().is_none() || sample_file().is_none() {
        return None;
    }
    let models = models_dir();
    sample_model(&models)?;
    claim_measuring_in(measuring_state(), asked, || {
        let saved = load_measured(&data_root());
        needs_measuring(saved.as_ref(), &this_computer(), sample_model(&models))
            || saved.is_some_and(|saved| large_due(&saved, LARGE.installed_in(&models)))
    })
}
/// Measures the devices for the worker that claimed it, under the app's
/// inference lock, and releases the measurement. `cancel` cuts it short.
pub fn measure_devices(cancel: &AtomicBool) {
    let asked = locked_measuring(measuring_state()).asked;
    let finished = match sample_file() {
        Some(jfk) => {
            // One scratch file in the data root, as the runtime folder may be
            // read-only: each measurement writes it anew, so one cut short by
            // a quit or a crash leaves no more than this file behind.
            let sample = data_root().join(SAMPLE_FILE);
            let finished = match twice(&jfk, &sample) {
                Ok(()) => {
                    let models = models_dir();
                    let threads = crate::transcribe::whole_take_threads();
                    let sampler = |on: On, model: &'static SpeechModel| {
                        let Ok(command) = sample_command(
                            on,
                            &model.path_in(&models),
                            model.dtw,
                            &sample,
                            threads,
                        ) else {
                            return Ok(Run::default());
                        };
                        run_sample(command, cancel, SAMPLE_TIMEOUT)
                    };
                    measure_into(&data_root(), this_computer(), asked, &models, &sampler).is_ok()
                }
                Err(error) => {
                    eprintln!("The devices were not measured: {error}");
                    true
                }
            };
            let _ = fs::remove_file(&sample);
            finished
        }
        None => true,
    };
    finish_measuring_in(measuring_state(), finished);
}
/// Releases a claimed measurement that did not start, because a recording
/// runs: it runs at the next idle moment.
pub fn give_up_measuring() {
    finish_measuring_in(measuring_state(), false);
}
/// Stops a measurement that is queued or runs, because a recording starts or
/// a transcription wants the inference lock: it runs again at the next idle
/// moment.
pub fn cancel_measuring() {
    cancel_measuring_in(measuring_state());
}
/// What starts a measurement in the background: the app's, which holds its
/// inference lock around [`measure_devices`]. The CLI never measures.
static WORKER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
pub fn set_measuring_worker(start: impl Fn() + Send + Sync + 'static) {
    let _ = WORKER.set(Box::new(start));
}
/// Starts the app's worker, which measures when that is due.
fn wake_measuring() {
    if let Some(start) = WORKER.get() {
        start();
    }
}

/// What every run of a measurement transcribes: whisper.cpp's `jfk.wav`
/// played twice back to back, 22 s, as long as a stretch. Loading the model
/// still takes much of a whole run, most of one with the larger model, which
/// is judged by its time spent transcribing ([`Run::transcribing_ms`]).
pub(crate) const SAMPLE: &str = "jfk.wav twice";
/// The doubled sample a measurement writes and removes, in the data root.
const SAMPLE_FILE: &str = "speech-sample.wav";
/// whisper.cpp's own sample, 11 s of speech, in the runtime folder.
fn sample_file() -> Option<PathBuf> {
    let sample = locate("whisper-cli").ok()?.parent()?.join("jfk.wav");
    sample.is_file().then_some(sample)
}
/// The model the sample is timed with: the multilingual small model, else
/// small.en, which a computer held to English has instead and which times
/// the same (the sample is English), else base.
fn sample_model(models: &Path) -> Option<&'static SpeechModel> {
    [&SMALL, &SMALL_EN, &BASE]
        .into_iter()
        .find(|model| model.installed_in(models))
}
/// Writes [`SAMPLE`]: `jfk`'s speech twice back to back into `target`. Its
/// header must say 16 kHz mono 16-bit PCM, what the speech runtime takes;
/// anything else is refused and nothing is measured.
fn twice(jfk: &Path, target: &Path) -> Result<(), String> {
    let mut reader = hound::WavReader::open(jfk).map_err(|e| format!("{}: {e}", jfk.display()))?;
    let spec = reader.spec();
    if (
        spec.channels,
        spec.sample_rate,
        spec.bits_per_sample,
        spec.sample_format,
    ) != (1, 16_000, 16, hound::SampleFormat::Int)
    {
        return Err(format!(
            "{} is not 16 kHz mono 16-bit PCM: {spec:?}",
            jfk.display()
        ));
    }
    let samples = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut writer = hound::WavWriter::create(target, spec).map_err(|e| e.to_string())?;
    for &sample in samples.iter().chain(&samples) {
        writer.write_sample(sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}
/// How long one run of the sample may take; a run still going then counts as
/// failed. Generous: the plain build on a slow processor takes many times
/// the sample's 22 s.
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(180);
/// The command of one run of the sample.
fn sample_command(
    on: On,
    model: &Path,
    dtw: &str,
    sample: &Path,
    threads: usize,
) -> Result<Command, String> {
    let mut command = match on {
        On::Processor => command("whisper-cli")?,
        On::Card(_) => card_command()?,
    };
    sample_options(&mut command, on, model, dtw, sample, threads);
    Ok(command)
}
/// The options of one run of the sample: those of a final transcription,
/// held to English, without a vocabulary and without output files; on the
/// processor build `-ng` and the threads of a whole-take pass, on the Vulkan
/// build `-dev <card>` and four threads, as a run on the card has.
fn sample_options(
    command: &mut Command,
    on: On,
    model: &Path,
    dtw: &str,
    sample: &Path,
    threads: usize,
) {
    command.arg("-m").arg(model).arg("-f").arg(sample);
    command.args(["-dtw", dtw, "-nfa", "-l", "en"]);
    match on {
        On::Processor => command.args(["-ng".to_owned(), "-t".into(), threads.to_string()]),
        On::Card(card) => command.args([
            "-dev".to_owned(),
            card.to_string(),
            "-t".into(),
            settings::CARD_THREADS.to_string(),
        ]),
    };
    command.args(["-mc", "0", "-nf", "-nth", "0.3"]);
}
/// Runs `command`, timing it from its start to its exit and keeping its
/// stderr. A run still going after `timeout` is killed and fails; one that
/// cannot start fails. `cancel` kills it and cuts the measurement short.
fn run_sample(mut command: Command, cancel: &AtomicBool, timeout: Duration) -> Result<Run, Cut> {
    if cancel.load(Ordering::Acquire) {
        return Err(Cut);
    }
    let started = Instant::now();
    let mut child = match command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Ok(Run {
                log: error.to_string(),
                ..Default::default()
            })
        }
    };
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut log = Vec::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.read_to_end(&mut log);
        }
        String::from_utf8_lossy(&log).into_owned()
    });
    let status = loop {
        if cancel.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err(Cut);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let ms = started.elapsed().as_millis() as u64;
    Ok(Run {
        ok: status.is_some_and(|status| status.success()),
        ms,
        log: reader.join().unwrap_or_default(),
    })
}

/// This computer as a measurement sees it.
fn this_computer() -> Computer {
    Computer {
        app: env!("CARGO_PKG_VERSION").into(),
        runtime: [tool("whisper-cli").ok(), card_build()]
            .into_iter()
            .flatten()
            .map(|build| build_key(&build))
            .collect(),
        adapters: display_adapters(),
    }
}
/// What names a build of `whisper-cli` in a measurement: its folder and
/// file name, its size and the time it was written, in seconds. Not its full
/// path: the app finds the bundled runtime through its resource folder,
/// which Windows gives it as a verbatim path (`\\?\C:\…`), and `cue` beside
/// its own executable (`C:\…`), and both are to agree on the same file.
fn build_key(path: &Path) -> String {
    let meta = path.metadata().ok();
    let size = meta.as_ref().map_or(0, |meta| meta.len());
    let at = meta
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_secs());
    build_key_of(path, size, at)
}
fn build_key_of(path: &Path, size: u64, at: u64) -> String {
    let name = |name: Option<&std::ffi::OsStr>| {
        name.map_or_else(String::new, |name| name.to_string_lossy().to_lowercase())
    };
    let folder = name(path.parent().and_then(Path::file_name));
    format!("{folder}/{} {size} {at}", name(path.file_name()))
}
/// The display adapters and their driver versions, from the registry's
/// display class (`HKLM\SYSTEM\CurrentControlSet\Control\Class\
/// {4d36e968-e325-11ce-bfc1-08002be10318}\00NN`, `DriverDesc` and
/// `DriverVersion`), in the order of their keys.
#[cfg(windows)]
fn display_adapters() -> Vec<Adapter> {
    use std::ffi::c_void;
    type Hkey = *mut c_void;
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
    const KEY_READ: u32 = 0x0002_0019;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    const ERROR_NO_MORE_ITEMS: i32 = 259;
    const CLASS: &str =
        r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: Hkey,
            sub_key: *const u16,
            options: u32,
            desired: u32,
            result: *mut Hkey,
        ) -> i32;
        fn RegEnumKeyExW(
            key: Hkey,
            index: u32,
            name: *mut u16,
            name_len: *mut u32,
            reserved: *mut u32,
            class: *mut u16,
            class_len: *mut u32,
            written: *mut u64,
        ) -> i32;
        fn RegGetValueW(
            key: Hkey,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            data_len: *mut u32,
        ) -> i32;
        fn RegCloseKey(key: Hkey) -> i32;
    }
    use std::ptr::null_mut as null;
    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let mut class: Hkey = null();
    // SAFETY: a valid predefined key, a NUL-terminated name and an out
    // pointer to a local.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE as Hkey,
            wide(CLASS).as_ptr(),
            0,
            KEY_READ,
            &mut class,
        )
    };
    if opened != 0 {
        return Vec::new();
    }
    let mut keys = Vec::new();
    for index in 0..1000 {
        let mut name = [0u16; 256];
        let mut length = name.len() as u32;
        // SAFETY: `class` is open; `name` holds `length` characters.
        let status = unsafe {
            RegEnumKeyExW(
                class,
                index,
                name.as_mut_ptr(),
                &mut length,
                null(),
                null(),
                null(),
                null(),
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        let key = String::from_utf16_lossy(&name[..(length as usize).min(name.len())]);
        if status == 0 && key.len() == 4 && key.bytes().all(|b| b.is_ascii_digit()) {
            keys.push(key);
        }
    }
    keys.sort();
    let value = |key: &str, value: &str| -> Option<String> {
        let mut data = [0u16; 1024];
        let mut bytes = (data.len() * 2) as u32;
        // SAFETY: `class` is open, the names are NUL-terminated and `data`
        // holds `bytes` bytes.
        let status = unsafe {
            RegGetValueW(
                class,
                wide(key).as_ptr(),
                wide(value).as_ptr(),
                RRF_RT_REG_SZ,
                null(),
                data.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        let read = &data[..(bytes as usize / 2).min(data.len())];
        (status == 0).then(|| {
            String::from_utf16_lossy(read)
                .trim_end_matches('\0')
                .to_owned()
        })
    };
    let adapters = keys
        .iter()
        .filter_map(|key| {
            Some(Adapter {
                name: value(key, "DriverDesc")?,
                driver: value(key, "DriverVersion").unwrap_or_default(),
            })
        })
        .collect();
    // SAFETY: `class` was opened above and is closed once.
    unsafe { RegCloseKey(class) };
    adapters
}
#[cfg(not(windows))]
fn display_adapters() -> Vec<Adapter> {
    Vec::new()
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
        statuses_of(models, &needed_models(chosen), fetch)
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
        let chosen = || needed_models(language.get());
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
        fetch_loop(
            dir.path(),
            &|| needed_models(None),
            &installs(&order, &during),
            &state,
        )
        .unwrap();
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
            &|| needed_models(None),
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
            let chosen = || needed_models(Some(language));
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
        let chosen = || needed_models(language.get());
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
        let chosen = || needed_models(language.get());
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
        let chosen = || needed_models(language.get());
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
        let english = || needed_models(Some("en"));
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
        fetch_loop(dir.path(), &|| needed_models(Some("en")), &download, &state).unwrap();
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
        let english = || needed_models(Some("en"));
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

    // Trimmed from logs of whisper.cpp b5454's static Vulkan build on a PC
    // with an RTX 5090 and AMD integrated graphics, and of its processor
    // build.
    const VULKAN_DEVICES: &str = "whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: gpu_device = 0
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = NVIDIA GeForce RTX 5090 (NVIDIA) | uma: 0 | fp16: 1 | bf16: 1 | fp4: 1 | warp size: 32 | shared memory: 49152 | int dot: 1 | matrix cores: NV_coopmat2v
ggml_vulkan: 1 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | fp4: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none
whisper_init_with_params_no_state: devices    = 3
whisper_init_with_params_no_state: backends   = 2
";
    const ON_CARD_0: &str = "whisper_model_load:      Vulkan0 total size =   487.01 MB
whisper_backend_init_gpu: device 0: Vulkan0 (type: 1)
whisper_backend_init_gpu: found GPU device 0: Vulkan0 (type: 1, cnt: 0)
whisper_backend_init_gpu: using Vulkan0 backend
whisper_print_timings:    total time =   998.59 ms
";
    const ON_CARD_1: &str = "whisper_model_load:      Vulkan1 total size =   487.01 MB
whisper_backend_init_gpu: device 0: Vulkan0 (type: 1)
whisper_backend_init_gpu: found GPU device 0: Vulkan0 (type: 1, cnt: 0)
whisper_backend_init_gpu: device 1: Vulkan1 (type: 2)
whisper_backend_init_gpu: found GPU device 1: Vulkan1 (type: 2, cnt: 1)
whisper_backend_init_gpu: using Vulkan1 backend
";
    /// `-dev 7` on that PC: no such card, so the run fell back to the
    /// processor and still exited with 0.
    const NO_SUCH_CARD: &str = "whisper_backend_init_gpu: device 0: Vulkan0 (type: 1)
whisper_backend_init_gpu: found GPU device 0: Vulkan0 (type: 1, cnt: 0)
whisper_backend_init_gpu: device 1: Vulkan1 (type: 2)
whisper_backend_init_gpu: found GPU device 1: Vulkan1 (type: 2, cnt: 1)
whisper_backend_init_gpu: device 2: CPU (type: 0)
whisper_backend_init_gpu: no GPU found
";
    const PROCESSOR_BUILD: &str = "whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: gpu_device = 0
whisper_init_with_params_no_state: devices    = 1
whisper_init_with_params_no_state: backends   = 1
whisper_backend_init_gpu: device 0: CPU (type: 0)
whisper_backend_init_gpu: no GPU found
whisper_print_timings:    total time =  2541.21 ms
";
    /// The timings at the end of a run of large-v3-turbo on the RTX 5090:
    /// 1505.64 ms from loading to the end, 1124.59 ms of them loading.
    const LARGE_TIMINGS: &str = "whisper_print_timings:     load time =  1124.59 ms
whisper_print_timings:     fallbacks =   0 p /   0 h
whisper_print_timings:      mel time =     8.33 ms
whisper_print_timings:   sample time =    88.48 ms /   279 runs (     0.32 ms per run)
whisper_print_timings:   encode time =    77.56 ms /     1 runs (    77.56 ms per run)
whisper_print_timings:   decode time =     0.00 ms /     1 runs (     0.00 ms per run)
whisper_print_timings:   batchd time =   105.01 ms /   277 runs (     0.38 ms per run)
whisper_print_timings:   prompt time =     5.28 ms /    54 runs (     0.10 ms per run)
whisper_print_timings:    total time =  1505.64 ms
";
    /// The load and total times `whisper-cli` logs at its end, in ms.
    fn timings(load: f64, total: f64) -> String {
        format!(
            "whisper_print_timings:     load time = {load:8.2} ms\n\
             whisper_print_timings:    total time = {total:8.2} ms\n"
        )
    }

    #[test]
    fn the_cards_and_the_card_in_use_are_read_from_the_vulkan_log() {
        let card = |index, name: &str| Card {
            index,
            name: name.into(),
        };
        let cards = [
            card(0, "NVIDIA GeForce RTX 5090"),
            card(1, "AMD Radeon(TM) Graphics"),
        ];
        for tail in [ON_CARD_0, ON_CARD_1, NO_SUCH_CARD] {
            assert_eq!(listed_cards(&format!("{VULKAN_DEVICES}{tail}")), cards);
        }
        assert_eq!(
            card_in_use(&format!("{VULKAN_DEVICES}{ON_CARD_0}")),
            Some(0)
        );
        assert_eq!(
            card_in_use(&format!("{VULKAN_DEVICES}{ON_CARD_1}")),
            Some(1)
        );
        // A run that ended on the processor, and the processor build.
        assert_eq!(
            card_in_use(&format!("{VULKAN_DEVICES}{NO_SUCH_CARD}")),
            None
        );
        assert_eq!(card_in_use(PROCESSOR_BUILD), None);
        assert!(listed_cards(PROCESSOR_BUILD).is_empty());
        // A Vulkan build that did not start writes nothing; a malformed line
        // names no card and no backend.
        assert!(listed_cards("").is_empty());
        for broken in [
            "ggml_vulkan: Found 1 Vulkan devices:",
            "ggml_vulkan: x = Card | uma: 0",
            "ggml_vulkan: 0 =  | uma: 0",
            "whisper_backend_init_gpu: using Vulkan backend",
            "whisper_backend_init_gpu: using VulkanX backend",
        ] {
            assert!(listed_cards(broken).is_empty(), "{broken}");
            assert_eq!(card_in_use(broken), None, "{broken}");
        }
        // A name without a driver group is kept whole.
        assert_eq!(
            listed_cards("ggml_vulkan: 2 = Intel(R) Arc(TM) A770 Graphics | uma: 0"),
            [card(2, "Intel(R) Arc(TM) A770 Graphics")]
        );
    }

    fn run(ok: bool, ms: u64, log: &str) -> Run {
        Run {
            ok,
            ms,
            log: log.into(),
        }
    }
    fn timed(index: u32, ms: Option<u64>) -> CardTime {
        CardTime {
            index,
            name: format!("Card {index}"),
            ms,
        }
    }

    #[test]
    fn the_measurement_counts_second_runs_and_ties_go_to_the_processor() {
        let card_0 = format!("{VULKAN_DEVICES}{ON_CARD_0}");
        let fell_back = format!("{VULKAN_DEVICES}{NO_SUCH_CARD}");
        // The second run counts: the first carries the card's warm-up.
        let warm = run(true, 17_300, &card_0);
        assert_eq!(
            counted([&warm, &run(true, 1_300, &card_0)], Some(0)),
            Some(1_300)
        );
        assert_eq!(
            counted([&run(true, 2_900, ""), &run(true, 2_700, "")], None),
            Some(2_700)
        );
        // A card whose log shows the processor, or another card, is left out,
        // and so is one whose run failed.
        assert_eq!(counted([&warm, &run(true, 900, &fell_back)], Some(0)), None);
        assert_eq!(counted([&warm, &run(true, 900, &card_0)], Some(1)), None);
        assert_eq!(counted([&run(false, 10, &card_0), &warm], Some(0)), None);
        assert_eq!(counted([&run(true, 1, ""), &run(false, 1, "")], None), None);
        // The fastest card wins when it beat the processor; a tie goes to the
        // processor, and a card left out never wins.
        let cards = [timed(0, Some(1_300)), timed(1, Some(6_000))];
        assert_eq!(fastest(2_700, &cards), Some(0));
        assert_eq!(fastest(2_700, &[timed(0, Some(2_700))]), None);
        assert_eq!(fastest(2_700, &[timed(0, Some(2_699))]), Some(0));
        assert_eq!(
            fastest(2_700, &[timed(0, None), timed(1, Some(2_000))]),
            Some(1)
        );
        assert_eq!(fastest(2_700, &[timed(0, None)]), None);
        assert_eq!(fastest(2_700, &[]), None);
    }

    #[test]
    fn the_larger_model_is_offered_at_two_thirds_of_the_processor_s_time() {
        assert!(offers_large(2_700, 1_300));
        assert!(offers_large(2_700, 1_800));
        assert!(!offers_large(2_700, 1_801));
        assert!(!offers_large(2_700, 2_600));
        let measured = |card_ms| Measured {
            cards: vec![timed(0, Some(card_ms))],
            chosen: Some(0),
            ..fast()
        };
        assert!(measured(1_800).large_offered());
        assert!(!measured(1_801).large_offered());
        // No card chosen, nothing offered.
        let processor = Measured {
            chosen: None,
            ..fast()
        };
        assert!(!processor.large_offered());
    }

    const RTX: &str = "NVIDIA GeForce RTX 5090 (NVIDIA)";
    const AMD: &str = "AMD Radeon(TM) Graphics (AMD proprietary driver)";
    /// A made-up runtime to time: the processor takes `processor_ms` for the
    /// sample, and each card its time, with its log showing it in use or
    /// the processor; a card's first run takes 16 s more for its warm-up.
    struct Bench {
        processor_ms: u64,
        cards: Vec<(&'static str, u64, bool)>,
        large_ms: u64,
        /// Whether the Vulkan build starts at all.
        starts: bool,
        /// The run at which a recording cuts the measurement short.
        cut_at: Option<usize>,
        /// The card has memory for the larger model once, not twice: of two
        /// runs of it at the same time, one fails.
        large_once: bool,
        runs: Mutex<Vec<(On, &'static str)>>,
    }
    impl Bench {
        fn new(processor_ms: u64, cards: &[(&'static str, u64, bool)]) -> Self {
            Self {
                processor_ms,
                cards: cards.to_vec(),
                large_ms: 2_000,
                starts: true,
                cut_at: None,
                large_once: false,
                runs: Default::default(),
            }
        }
        fn log(&self, in_use: Option<u32>) -> String {
            let mut log = format!("ggml_vulkan: Found {} Vulkan devices:\n", self.cards.len());
            for (index, (name, ..)) in self.cards.iter().enumerate() {
                log += &format!("ggml_vulkan: {index} = {name} | uma: 0 | fp16: 1\n");
            }
            log + &match in_use {
                Some(card) => format!("whisper_backend_init_gpu: using Vulkan{card} backend\n"),
                None => "whisper_backend_init_gpu: no GPU found\n".into(),
            }
        }
        fn sample(&self, on: On, model: &'static SpeechModel) -> Result<Run, Cut> {
            let mut runs = self.runs.lock().unwrap();
            if Some(runs.len()) == self.cut_at {
                return Err(Cut);
            }
            let warm = !runs.iter().any(|(done, _)| *done == on);
            let large_runs = runs.iter().filter(|(_, name)| *name == LARGE.name).count();
            runs.push((on, model.name));
            drop(runs);
            let card = match on {
                On::Processor => return Ok(run(true, self.processor_ms, PROCESSOR_BUILD)),
                On::Card(_) if !self.starts => return Ok(run(false, 30, "")),
                On::Card(card) => card,
            };
            Ok(match self.cards.get(card as usize) {
                // The second of two at the same time runs out of memory.
                Some(_) if model == &LARGE && self.large_once && large_runs == 3 => run(
                    false,
                    900,
                    "ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory",
                ),
                Some(&(_, ms, used)) => {
                    let ms = if model == &LARGE { self.large_ms } else { ms };
                    let warm_up = if warm { 16_000 } else { 0 };
                    run(true, ms + warm_up, &self.log(used.then_some(card)))
                }
                None => run(true, 3_000, &self.log(None)),
            })
        }
        fn runs(&self) -> Vec<(On, &'static str)> {
            std::mem::take(&mut *self.runs.lock().unwrap())
        }
        fn measure(&self) -> Option<Measured> {
            measure_with(computer(), &SMALL, &|on, model| self.sample(on, model)).unwrap()
        }
    }
    fn computer() -> Computer {
        Computer {
            app: "0.3.0".into(),
            runtime: vec![
                "avx2/whisper-cli.exe 2610688 1763500000".into(),
                "vulkan/whisper-cli.exe 47901184 1763500000".into(),
            ],
            adapters: vec![
                Adapter {
                    name: "NVIDIA GeForce RTX 5090".into(),
                    driver: "32.0.15.8180".into(),
                },
                Adapter {
                    name: "AMD Radeon(TM) Graphics".into(),
                    driver: "32.0.21025.1".into(),
                },
            ],
        }
    }
    /// What this PC measures: the RTX 5090 at half the processor's time.
    fn fast() -> Measured {
        Bench::new(2_700, &[(RTX, 1_300, true), (AMD, 6_000, true)])
            .measure()
            .unwrap()
    }
    /// A computer that has the Vulkan build and `measured`, made on it.
    fn ready(measured: Measured) -> Facts {
        Facts {
            card_build: true,
            saved: Some(measured),
            current: true,
            measuring: false,
            switch_on: true,
            large_chosen: false,
            large_installed: false,
        }
    }
    /// The processor transcribes on a computer with the Vulkan build, which
    /// can measure its devices.
    fn processor_here() -> SpeechDevice {
        SpeechDevice {
            measurable: true,
            ..SpeechDevice::processor()
        }
    }
    fn small() -> ModelChoice {
        ModelChoice {
            path: PathBuf::from("models").join(SMALL.file),
            dtw: Some(SMALL.dtw.into()),
        }
    }
    fn large() -> ModelChoice {
        ModelChoice {
            path: PathBuf::from("models").join(LARGE.file),
            dtw: Some(LARGE.dtw.into()),
        }
    }
    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_fastest_measured_device_transcribes() {
        // This PC: the RTX 5090 runs the sample in half the processor's
        // time, the integrated chip slower than the processor.
        let bench = Bench::new(2_700, &[(RTX, 1_300, true), (AMD, 6_000, true)]);
        let measured = bench.measure().unwrap();
        assert_eq!(
            bench.runs(),
            [
                (On::Processor, "small"),
                (On::Processor, "small"),
                (On::Card(0), "small"),
                (On::Card(0), "small"),
                (On::Card(1), "small"),
                (On::Card(1), "small"),
            ],
            "twice each, the processor first, then every card the first run listed"
        );
        assert_eq!(measured.processor_ms, 2_700);
        assert_eq!(
            measured.cards,
            [
                CardTime {
                    index: 0,
                    name: "NVIDIA GeForce RTX 5090".into(),
                    ms: Some(1_300)
                },
                CardTime {
                    index: 1,
                    name: "AMD Radeon(TM) Graphics".into(),
                    ms: Some(6_000)
                },
            ],
            "the warm-up of the first run is not counted"
        );
        assert_eq!(measured.chosen, Some(0));
        // Stretches and whole-take passes run on it, Standard with the small
        // models.
        let facts = ready(measured);
        assert_eq!(facts.card(), Some(0));
        let run = FinalRun::on(facts.card(), facts.large().then(large), small());
        assert_eq!(
            (run.card, &run.model, &run.small),
            (Some(0), &small(), &small())
        );
        let takes = TakeModels {
            english: small(),
            other: small(),
            large: None,
        };
        assert_eq!(takes.run_on(facts.card(), "de"), run);
        assert_eq!(
            facts.device(),
            SpeechDevice {
                state: DeviceState::Ready,
                kind: DeviceKind::GraphicsCard,
                name: Some("NVIDIA GeForce RTX 5090".into()),
                card: Some(SpeechCard {
                    name: "NVIDIA GeForce RTX 5090".into(),
                    stopped: false
                }),
                large_offered: true,
                large_slow: false,
                large_in_use: false,
                measurable: true,
            }
        );
        // The sample runs as a final transcription does on each: the Vulkan
        // build with `-dev` and four threads, the processor build with `-ng`
        // and the threads of a whole-take pass.
        let mut on_card = Command::new("whisper-cli");
        let (model, sample) = (Path::new("ggml-small.bin"), Path::new("jfk.wav"));
        sample_options(&mut on_card, On::Card(1), model, "small", sample, 8);
        assert_eq!(
            args(&on_card),
            [
                "-m",
                "ggml-small.bin",
                "-f",
                "jfk.wav",
                "-dtw",
                "small",
                "-nfa",
                "-l",
                "en",
                "-dev",
                "1",
                "-t",
                "4",
                "-mc",
                "0",
                "-nf",
                "-nth",
                "0.3"
            ]
        );
        let mut on_processor = Command::new("whisper-cli");
        sample_options(&mut on_processor, On::Processor, model, "small", sample, 8);
        assert_eq!(args(&on_processor)[9..12], ["-ng", "-t", "8"]);

        // A slow graphics card is left alone: the only card is slower than
        // the processor, which transcribes as it does today.
        let slow = Bench::new(2_700, &[(AMD, 6_000, true)]).measure().unwrap();
        assert_eq!(slow.chosen, None);
        let facts = ready(slow);
        assert_eq!(facts.card(), None);
        assert_eq!(
            FinalRun::on(facts.card(), None, small()),
            FinalRun::processor(small())
        );
        assert_eq!(facts.device(), processor_here());
    }

    #[test]
    fn devices_are_measured_again_only_when_the_computer_changed() {
        let root = tempfile::tempdir().unwrap();
        let installed = models(&[&BASE, &SMALL]);
        let bench = Bench::new(2_700, &[(RTX, 1_300, true), (AMD, 6_000, true)]);
        let sample = |on, model| bench.sample(on, model);
        // The first start: nothing is saved, so the devices are measured and
        // the result saved beside the settings.
        assert!(needs_measuring(None, &computer(), Some(&SMALL)));
        measure_into(root.path(), computer(), false, installed.path(), &sample).unwrap();
        assert_eq!(bench.runs().len(), 6);
        let saved = load_measured(root.path()).unwrap();
        assert_eq!((saved.chosen, saved.model.as_str()), (Some(0), "small"));
        let file = fs::read_to_string(root.path().join("speech-device.json")).unwrap();
        assert!(file.contains("\"processorMs\": 2700"), "{file}");
        assert_eq!(saved.sample, "jfk.wav twice");
        // Later starts use it without measuring.
        assert!(!needs_measuring(Some(&saved), &computer(), Some(&SMALL)));
        // One made on another sample is made again: a single jfk.wav, as
        // before, or a file without the field.
        let single = Measured {
            sample: "jfk.wav".into(),
            ..saved.clone()
        };
        assert!(needs_measuring(Some(&single), &computer(), Some(&SMALL)));
        let mut old = serde_json::to_value(&saved).unwrap();
        old.as_object_mut().unwrap().remove("sample");
        let old: Measured = serde_json::from_value(old).unwrap();
        assert!(needs_measuring(Some(&old), &computer(), Some(&SMALL)));
        save_measured(root.path(), &single);
        measure_into(root.path(), computer(), false, installed.path(), &sample).unwrap();
        assert_eq!(bench.runs().len(), 6);
        assert_eq!(load_measured(root.path()).unwrap().sample, "jfk.wav twice");
        measure_into(root.path(), computer(), false, installed.path(), &sample).unwrap();
        assert!(bench.runs().is_empty());
        // A new version of the app, another runtime, an updated driver, a
        // new adapter: measured again.
        let changed = |change: &dyn Fn(&mut Computer)| {
            let mut computer = computer();
            change(&mut computer);
            computer
        };
        let driver = changed(&|c| c.adapters[0].driver = "32.0.15.9000".into());
        for other in [
            changed(&|c| c.app = "0.4.0".into()),
            changed(&|c| c.runtime[1].push('1')),
            changed(&|c| {
                c.runtime.pop();
            }),
            driver.clone(),
            changed(&|c| {
                c.adapters.push(Adapter {
                    name: "Intel(R) Arc(TM) A770 Graphics".into(),
                    driver: "32.0.101.6078".into(),
                })
            }),
        ] {
            assert!(
                needs_measuring(Some(&saved), &other, Some(&SMALL)),
                "{other:?}"
            );
        }
        measure_into(
            root.path(),
            driver.clone(),
            false,
            installed.path(),
            &sample,
        )
        .unwrap();
        assert_eq!(bench.runs().len(), 6);
        assert_eq!(load_measured(root.path()).unwrap().computer, driver);
        // Asked for, it measures even though nothing changed.
        measure_into(root.path(), driver.clone(), true, installed.path(), &sample).unwrap();
        assert_eq!(bench.runs().len(), 6);
        // Without a model to time the sample with, nothing runs yet.
        let empty = tempfile::tempdir().unwrap();
        let bare = models(&[]);
        measure_into(empty.path(), computer(), false, bare.path(), &sample).unwrap();
        assert!(bench.runs().is_empty() && load_measured(empty.path()).is_none());
        // Base stands in for a missing small model.
        let base_only = models(&[&BASE]);
        measure_into(empty.path(), computer(), false, base_only.path(), &sample).unwrap();
        let runs = bench.runs();
        assert_eq!(runs.len(), 6);
        assert!(runs.iter().all(|(_, model)| *model == "base"));
        let with_base = load_measured(empty.path()).unwrap();
        assert_eq!(with_base.model, "base");
        // Against the processor running base the larger model is neither
        // offered nor timed.
        assert!(!with_base.large_offered() && !large_due(&with_base, true));
        assert!(!needs_measuring(Some(&with_base), &computer(), Some(&BASE)));
        // Once a small model is there, as after a fresh install, the devices
        // are measured again with it, and then not again.
        assert!(needs_measuring(Some(&with_base), &computer(), Some(&SMALL)));
        assert!(needs_measuring(
            Some(&with_base),
            &computer(),
            Some(&SMALL_EN)
        ));
        let both = models(&[&BASE, &SMALL]);
        measure_into(empty.path(), computer(), false, both.path(), &sample).unwrap();
        let runs = bench.runs();
        assert_eq!(runs.len(), 6);
        assert!(runs.iter().all(|(_, model)| *model == "small"));
        let with_small = load_measured(empty.path()).unwrap();
        assert_eq!(with_small.model, "small");
        assert!(with_small.large_offered());
        measure_into(empty.path(), computer(), false, both.path(), &sample).unwrap();
        assert!(bench.runs().is_empty());
        // Held to English, only small.en downloads: the sample is timed with
        // it (base first, then small.en once it is there), and it offers the
        // larger model as small does.
        let english = tempfile::tempdir().unwrap();
        measure_into(english.path(), computer(), false, base_only.path(), &sample).unwrap();
        bench.runs();
        let english_only = models(&[&BASE, &SMALL_EN]);
        assert_eq!(sample_model(english_only.path()), Some(&SMALL_EN));
        measure_into(
            english.path(),
            computer(),
            false,
            english_only.path(),
            &sample,
        )
        .unwrap();
        let runs = bench.runs();
        assert_eq!(runs.len(), 6);
        assert!(runs.iter().all(|(_, model)| *model == "small.en"));
        let with_small_en = load_measured(english.path()).unwrap();
        assert_eq!(with_small_en.model, "small.en");
        assert!(with_small_en.large_offered() && large_due(&with_small_en, true));
        // The multilingual small model arriving later, as with Auto, measures
        // nothing again: the two small models time the same.
        assert!(!needs_measuring(
            Some(&with_small_en),
            &computer(),
            Some(&SMALL)
        ));
        assert!(!needs_measuring(
            Some(&with_small),
            &computer(),
            Some(&SMALL_EN)
        ));
        let all = models(&[&BASE, &SMALL_EN, &SMALL]);
        measure_into(english.path(), computer(), false, all.path(), &sample).unwrap();
        assert!(bench.runs().is_empty());
        // Nor does a small measurement go back to base.
        assert!(!needs_measuring(
            Some(&with_small),
            &computer(),
            Some(&BASE)
        ));

        // In the background, one at a time.
        let state = Mutex::new(Measuring::default());
        let cancel = claim_measuring_in(&state, false, || true).unwrap();
        assert!(claim_measuring_in(&state, false, || true).is_none());
        assert!(claim_measuring_in(&state, true, || true).is_none());
        // A recording starts: the measurement stops at once and saves
        // nothing, so the last result stays.
        cancel_measuring_in(&state);
        assert!(cancel.load(Ordering::Acquire));
        let cut = Bench {
            cut_at: Some(3),
            ..Bench::new(2_700, &[(RTX, 900, true)])
        };
        let before = load_measured(root.path());
        assert_eq!(
            measure_into(
                root.path(),
                changed(&|c| c.app = "0.4.0".into()),
                false,
                installed.path(),
                &|on, model| cut.sample(on, model)
            ),
            Err(Cut)
        );
        assert_eq!(load_measured(root.path()), before);
        finish_measuring_in(&state, false);
        // It runs again at the next idle moment, being still due.
        assert!(claim_measuring_in(&state, false, || true).is_some());
        finish_measuring_in(&state, true);
        assert!(claim_measuring_in(&state, false, || false).is_none());
        // One the person asked for runs though nothing changed, and when a
        // recording cuts it short it is still asked for at the next idle
        // moment, until it ran to its end.
        assert!(claim_measuring_in(&state, true, || false).is_some());
        finish_measuring_in(&state, false);
        assert!(claim_measuring_in(&state, false, || false).is_some());
        finish_measuring_in(&state, true);
        assert!(claim_measuring_in(&state, false, || false).is_none());
    }

    const HANG_SAMPLE: &str = "CUEREVIEW_HANG_SAMPLE";
    #[test]
    fn hanging_sample_run() {
        if std::env::var_os(HANG_SAMPLE).is_some() {
            eprintln!("whisper_backend_init_gpu: using Vulkan0 backend");
            std::thread::sleep(Duration::from_secs(120));
        }
    }
    fn hanging_sample() -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "deps::tests::hanging_sample_run", "--nocapture"])
            .env(HANG_SAMPLE, "1");
        command
    }

    #[test]
    fn a_sample_run_is_timed_and_killed_by_a_recording_or_its_timeout() {
        // A run that ends: timed, its log kept.
        let quick = Command::new(std::env::current_exe().unwrap());
        let mut quick = quick;
        quick.arg("--list");
        let done = run_sample(quick, &AtomicBool::new(false), Duration::from_secs(60)).unwrap();
        assert!(done.ok, "{}", done.log);
        // One still going after its time fails, and is killed.
        let began = Instant::now();
        let hung = run_sample(
            hanging_sample(),
            &AtomicBool::new(false),
            Duration::from_millis(500),
        )
        .unwrap();
        assert!(!hung.ok);
        assert!(
            began.elapsed() < Duration::from_secs(20),
            "{:?}",
            began.elapsed()
        );
        // A recording that starts kills it and cuts the measurement short.
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            signal.store(true, Ordering::Release);
        });
        let began = Instant::now();
        assert_eq!(
            run_sample(hanging_sample(), &cancel, Duration::from_secs(60)).unwrap_err(),
            Cut
        );
        trigger.join().unwrap();
        assert!(
            began.elapsed() < Duration::from_secs(20),
            "{:?}",
            began.elapsed()
        );
        assert_eq!(
            run_sample(hanging_sample(), &cancel, Duration::from_secs(60)).unwrap_err(),
            Cut,
            "a cut measurement starts no run"
        );
        // A build that cannot start fails its run.
        let missing = Command::new("Z:\\no-such-folder\\whisper-cli.exe");
        let failed = run_sample(missing, &AtomicBool::new(false), Duration::from_secs(5)).unwrap();
        assert!(!failed.ok);
    }

    #[test]
    fn no_usable_graphics_card_means_the_processor_build() {
        // Without the Vulkan build nothing is measured, whatever was saved,
        // and the processor build its processor supports transcribes.
        let (dir, plain) = runtime(true);
        assert_eq!(card_build_beside(&plain), None);
        assert_eq!(
            vector_build(&plain, true),
            dir.path().join("avx2/whisper-cli.exe")
        );
        let without = Facts {
            card_build: false,
            ..ready(fast())
        };
        assert_eq!(without.card(), None);
        assert_eq!(without.device(), SpeechDevice::processor());
        assert!(!without.device().measurable, "nothing to measure or test");
        assert_eq!(
            FinalRun::on(without.card(), Some(large()), small()),
            FinalRun::processor(small())
        );
        // The Vulkan build sits beside the processor build.
        fs::create_dir(dir.path().join("vulkan")).unwrap();
        fs::write(dir.path().join("vulkan/whisper-cli.exe"), b"vulkan").unwrap();
        assert_eq!(
            card_build_beside(&plain),
            Some(dir.path().join("vulkan/whisper-cli.exe"))
        );
        // A Vulkan build that does not start, as without a Vulkan loader:
        // only the processor counts.
        let unstarted = Bench {
            starts: false,
            ..Bench::new(2_700, &[(RTX, 1_300, true)])
        };
        let measured = unstarted.measure().unwrap();
        assert!(measured.cards.is_empty() && measured.chosen.is_none());
        assert_eq!(ready(measured).device(), processor_here());
        assert!(processor_here().measurable, "it can be tested again");
        // A computer without a card the runtime can use: every run of the
        // card ended on the processor.
        let unusable = Bench::new(2_700, &[(AMD, 900, false)]).measure().unwrap();
        assert_eq!(unusable.cards[0].ms, None);
        assert_eq!(unusable.chosen, None);
        assert_eq!(ready(unusable).card(), None);
        // Nothing measured yet: the processor, and no error.
        let unmeasured = Facts {
            saved: None,
            current: false,
            ..ready(fast())
        };
        assert_eq!(unmeasured.card(), None);
        assert_eq!(unmeasured.device(), processor_here());
        // A processor build that cannot run the sample saves nothing.
        let broken = |on: On, _: &'static SpeechModel| {
            Ok(match on {
                On::Processor => run(false, 5, "error: failed to initialize whisper context"),
                On::Card(_) => panic!("no card is timed without the processor"),
            })
        };
        assert_eq!(measure_with(computer(), &SMALL, &broken), Ok(None));
    }

    #[test]
    fn the_switch_keeps_transcription_on_the_processor() {
        let off = Facts {
            switch_on: false,
            large_chosen: true,
            large_installed: true,
            ..ready(Measured {
                large: Some(LargeTime::Ms(2_000)),
                ..fast()
            })
        };
        // Every run goes to the processor, the larger model's too: the
        // stretches while recording (asked for each) and every pass after.
        assert_eq!(off.card(), None);
        assert!(!off.large());
        assert_eq!(
            FinalRun::on(off.card(), off.large().then(large), small()),
            FinalRun::processor(small())
        );
        let takes = TakeModels {
            english: small(),
            other: small(),
            large: Some(large()),
        };
        assert_eq!(takes.run_on(off.card(), "de"), FinalRun::processor(small()));
        // Settings name the processor, and still the card it can turn back to.
        assert_eq!(
            off.device(),
            SpeechDevice {
                state: DeviceState::Ready,
                kind: DeviceKind::Processor,
                name: None,
                card: Some(SpeechCard {
                    name: "NVIDIA GeForce RTX 5090".into(),
                    stopped: false
                }),
                large_offered: true,
                large_slow: false,
                large_in_use: false,
                measurable: true,
            }
        );
        // The choice is kept across restarts.
        let root = tempfile::tempdir().unwrap();
        let saved = settings::save(
            root.path(),
            &crate::models::Settings {
                graphics_card: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!settings::graphics_card_on(&saved));
        assert!(!settings::graphics_card_on(&settings::load(root.path())));
        // Turned on again, the card transcribes.
        let on = Facts {
            switch_on: true,
            ..off
        };
        assert_eq!(on.card(), Some(0));
        assert_eq!(takes.run_on(on.card(), "de").model, large());
        assert!(on.device().large_in_use);
    }

    #[test]
    fn a_failed_graphics_card_is_used_again_after_a_new_measurement() {
        let root = tempfile::tempdir().unwrap();
        let installed = models(&[&BASE, &SMALL]);
        let bench = Bench::new(2_700, &[(RTX, 1_300, true)]);
        let sample = |on, model| bench.sample(on, model);
        measure_into(root.path(), computer(), false, installed.path(), &sample).unwrap();
        bench.runs();
        let facts = || ready(load_measured(root.path()).unwrap());
        assert_eq!(facts().card(), Some(0));
        // A run on the card failed: the processor transcribes, and Settings
        // say the card stopped.
        stop_card_in(root.path(), "Processing failed (exit code: 0xc0000005)");
        assert_eq!(facts().card(), None);
        let device = facts().device();
        assert_eq!(device.kind, DeviceKind::Processor);
        assert_eq!(device.card.map(|card| card.stopped), Some(true));
        // Nothing changed on the computer, so nothing measures by itself.
        assert!(!needs_measuring(
            load_measured(root.path()).as_ref(),
            &computer(),
            Some(&SMALL)
        ));
        let state = Mutex::new(Measuring::default());
        assert!(claim_measuring_in(&state, false, || false).is_none());
        // The person asks for the card to be tested again: it measures
        // fastest and transcribes again.
        assert!(claim_measuring_in(&state, true, || false).is_some());
        measure_into(root.path(), computer(), true, installed.path(), &sample).unwrap();
        finish_measuring_in(&state, true);
        assert_eq!(bench.runs().len(), 4);
        assert!(!load_measured(root.path()).unwrap().stopped);
        assert_eq!(facts().card(), Some(0));
        assert_eq!(facts().device().kind, DeviceKind::GraphicsCard);
        // While it measures, the processor transcribes and Settings say so,
        // with the card of the last result.
        let measuring = Facts {
            measuring: true,
            ..facts()
        };
        assert_eq!(measuring.card(), None);
        let device = measuring.device();
        assert_eq!(
            (
                device.state,
                device.kind,
                device.card.is_some(),
                device.large_offered
            ),
            (DeviceState::Measuring, DeviceKind::Processor, true, true)
        );
        // Stopping an already stopped card, or one never chosen, writes
        // nothing new.
        let none = tempfile::tempdir().unwrap();
        stop_card_in(none.path(), "no measurement");
        assert!(load_measured(none.path()).is_none());
    }

    #[test]
    fn the_larger_model_transcribes_every_language_once_installed() {
        // Large downloads after the small models of the language, which
        // transcribe until it is there; Settings list it first.
        assert_eq!(wanted_models(None, true), [&SMALL_EN, &SMALL, &LARGE]);
        assert_eq!(wanted_models(Some("de"), true), [&SMALL, &LARGE]);
        assert_eq!(wanted_models(Some("en"), true), [&SMALL_EN, &LARGE]);
        assert_eq!(listed_models(None, true), [&LARGE, &SMALL_EN, &SMALL]);
        assert_eq!(listed_models(Some("de"), false), [&SMALL]);
        assert_eq!(LARGE.size, 1_624_555_275);
        let dir = models(&[&BASE]);
        let state = Mutex::new(Fetch::default());
        let order = std::cell::RefCell::new(Vec::new());
        let listed = listed_models(None, true);
        let during = |name: &'static str| {
            let fetch = locked(&state).clone();
            let now = statuses_of(dir.path(), &listed, &fetch);
            let large = (now[0].model.as_str(), now[0].state.as_str());
            assert_eq!(large, ("large-v3-turbo", "downloading"), "{name}");
            assert_eq!(now[0].total_bytes, 1_624_555_275);
        };
        assert!(claim(&state, &wanted_models(None, true)));
        let wanted = || wanted_models(None, true);
        fetch_loop(dir.path(), &wanted, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["small.en", "small", "large-v3-turbo"]);
        assert!(LARGE.installed_in(dir.path()));

        // Until it is installed the small models transcribe.
        let timed = Measured {
            large: Some(LargeTime::Ms(2_000)),
            ..fast()
        };
        let waiting = Facts {
            large_chosen: true,
            large_installed: false,
            ..ready(timed.clone())
        };
        assert!(!waiting.large_fits() && !waiting.large());
        assert!(!waiting.device().large_in_use);
        // Installed, then timed once on the card: its time is due.
        let untimed = fast();
        assert!(large_due(&untimed, true));
        assert!(!large_due(&untimed, false));
        let root = tempfile::tempdir().unwrap();
        save_measured(
            root.path(),
            &Measured {
                computer: computer(),
                ..untimed
            },
        );
        let bench = Bench::new(2_700, &[(RTX, 1_300, true)]);
        let with_large = models(&[&BASE, &SMALL, &LARGE]);
        measure_into(
            root.path(),
            computer(),
            false,
            with_large.path(),
            &|on, model| bench.sample(on, model),
        )
        .unwrap();
        assert_eq!(
            bench.runs(),
            [(On::Card(0), "large-v3-turbo"); 4],
            "two one after the other, then two at the same time"
        );
        let saved = load_measured(root.path()).unwrap();
        assert_eq!(
            saved.large,
            Some(LargeTime::Ms(2_000)),
            "the second run counts"
        );
        assert!(!large_due(&saved, true), "timed once");
        // Before that timing, Settings do not say it transcribes.
        let untimed_facts = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(fast())
        };
        assert!(!untimed_facts.large() && !untimed_facts.device().large_in_use);

        // Installed and timed no slower than the processor with the small
        // model: Large transcribes every take on the card, in every language,
        // held to it.
        let fits = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(timed)
        };
        assert!(fits.large());
        assert!(!fits.device().large_slow);
        assert!(fits.device().large_in_use);
        let takes = TakeModels {
            english: ModelChoice {
                path: PathBuf::from("models").join(SMALL_EN.file),
                dtw: Some(SMALL_EN.dtw.into()),
            },
            other: small(),
            large: fits.large_fits().then(large),
        };
        for (code, _) in settings::LANGUAGES {
            let run = FinalRun::on(fits.card(), fits.large().then(large), small());
            assert_eq!((run.card, &run.model), (Some(0), &large()), "{code}");
            let stretch = takes.run_on(fits.card(), code);
            assert_eq!(
                (stretch.card, &stretch.model),
                (Some(0), &large()),
                "{code}"
            );
            let args =
                settings::decoding_args_on(&Default::default(), &large().path, code, Some(0));
            assert_eq!(args[..5], ["-l", code, "-ojf", "-dev", "0"], "{code}");
        }
        assert_eq!(LARGE.dtw, "large.v3.turbo");
    }

    #[test]
    fn the_larger_model_never_runs_on_the_processor() {
        let fits = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(Measured {
                large: Some(LargeTime::Ms(2_000)),
                ..fast()
            })
        };
        assert!(fits.large());
        let stopped = Measured {
            stopped: true,
            ..fits.saved.clone().unwrap()
        };
        for (why, facts) in [
            (
                "the switch is off",
                Facts {
                    switch_on: false,
                    ..fits.clone()
                },
            ),
            (
                "the card stopped",
                Facts {
                    saved: Some(stopped),
                    ..fits.clone()
                },
            ),
            (
                "the devices are measured",
                Facts {
                    measuring: true,
                    ..fits.clone()
                },
            ),
            (
                "the computer changed",
                Facts {
                    current: false,
                    ..fits.clone()
                },
            ),
            (
                "no Vulkan build",
                Facts {
                    card_build: false,
                    ..fits.clone()
                },
            ),
        ] {
            assert!(!facts.large(), "{why}");
            assert!(!facts.device().large_in_use, "{why}");
            assert_eq!(
                FinalRun::on(facts.card(), facts.large().then(large), small()),
                FinalRun::processor(small()),
                "{why}"
            );
        }
        // A take that started with Large, whose card stops during it, goes on
        // with the small model on the processor.
        let takes = TakeModels {
            english: small(),
            other: small(),
            large: Some(large()),
        };
        assert_eq!(takes.run_on(None, "de"), FinalRun::processor(small()));
        // A failed run with Large is done again with the small model.
        let run = FinalRun::on(Some(0), Some(large()), small());
        assert_eq!((&run.model, &run.small), (&large(), &small()));

        // A card that is not fast enough is not offered Large, and one that
        // ran Large slower than the processor ran small, or failed with it,
        // transcribes with the small models; Settings say so.
        let barely = Measured {
            cards: vec![timed(0, Some(2_000))],
            large: Some(LargeTime::Ms(1_000)),
            ..fast()
        };
        let slow = Measured {
            large: Some(LargeTime::Ms(2_701)),
            ..fast()
        };
        let failed = Measured {
            large: Some(LargeTime::Failed),
            ..fast()
        };
        for (why, measured, offered, slow) in [
            ("not offered", barely, false, false),
            ("slower than the processor", slow, true, true),
            ("failed on the card", failed, true, true),
        ] {
            let facts = Facts {
                saved: Some(measured),
                ..fits.clone()
            };
            assert!(!facts.large(), "{why}");
            assert_eq!(facts.card(), Some(0), "{why}: the card still runs small");
            let device = facts.device();
            assert_eq!(
                (device.large_offered, device.large_slow),
                (offered, slow),
                "{why}"
            );
        }
    }

    #[test]
    fn standard_goes_back_to_the_small_models() {
        let large_chosen = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(Measured {
                large: Some(LargeTime::Ms(2_000)),
                ..fast()
            })
        };
        assert!(large_chosen.large());
        // Standard: the small models transcribe on the card again.
        let standard = Facts {
            large_chosen: false,
            ..large_chosen
        };
        assert!(!standard.large());
        assert_eq!(
            FinalRun::on(standard.card(), standard.large().then(large), small()),
            FinalRun {
                card: Some(0),
                model: small(),
                small: small()
            }
        );
        assert_eq!(wanted_models(Some("de"), false), [&SMALL]);
        assert_eq!(listed_models(None, false), [&SMALL_EN, &SMALL]);
        // The large model stays installed: Standard downloads nothing and
        // removes nothing.
        let dir = models(&[&BASE, &SMALL_EN, &SMALL, &LARGE]);
        let state = Mutex::new(Fetch::default());
        let order = std::cell::RefCell::new(Vec::new());
        assert!(claim(&state, &wanted_models(None, false)));
        fetch_loop(
            dir.path(),
            &|| wanted_models(None, false),
            &installs(&order, &|_| ()),
            &state,
        )
        .unwrap();
        assert!(order.borrow().is_empty());
        assert!(LARGE.installed_in(dir.path()));
        // Standard chosen while Large downloads stops that download, and the
        // small models are kept.
        let dir = models(&[&BASE, &SMALL]);
        let state = Mutex::new(Fetch::default());
        let order = std::cell::RefCell::new(Vec::new());
        let large = std::cell::Cell::new(true);
        let during = |name: &'static str| {
            if name == LARGE.name {
                large.set(false);
                stop_other(&state, &wanted_models(Some("de"), false));
                assert!(locked(&state).cancel, "Standard has no use for it");
            }
        };
        assert!(claim(&state, &wanted_models(Some("de"), true)));
        let wanted = || wanted_models(Some("de"), large.get());
        fetch_loop(dir.path(), &wanted, &installs(&order, &during), &state).unwrap();
        assert_eq!(*order.borrow(), ["large-v3-turbo"]);
        assert!(!LARGE.installed_in(dir.path()) && SMALL.installed_in(dir.path()));
        assert!(locked(&state).error.is_none());
    }

    #[test]
    fn the_larger_model_must_fit_twice_on_the_card() {
        let card_0 = format!("{VULKAN_DEVICES}{ON_CARD_0}");
        let fell_back = format!("{VULKAN_DEVICES}{NO_SUCH_CARD}");
        let fine = |ms| run(true, ms, &card_0);
        let (one, two) = (fine(18_000), fine(2_000));
        // Two runs at the same time on the card, as both tracks of a take:
        // when both end well there, the second run of the two before counts.
        assert_eq!(
            large_time([&one, &two], [&fine(2_600), &fine(2_700)], 0),
            LargeTime::Ms(2_000)
        );
        // One of them failing, or ending on the processor, is a larger model
        // that does not fit.
        let out_of_memory = run(false, 900, "ErrorOutOfDeviceMemory");
        for other in [&out_of_memory, &run(true, 9_000, &fell_back)] {
            assert_eq!(
                large_time([&one, &two], [&fine(2_600), other], 0),
                LargeTime::Failed
            );
        }
        assert_eq!(
            large_time([&one, &run(false, 1, "")], [&fine(1), &fine(1)], 0),
            LargeTime::Failed
        );

        // A card with memory for one run of it: timed, then failed with two.
        let root = tempfile::tempdir().unwrap();
        save_measured(root.path(), &fast());
        let bench = Bench {
            large_once: true,
            ..Bench::new(2_700, &[(RTX, 1_300, true)])
        };
        let with_large = models(&[&BASE, &SMALL, &LARGE]);
        measure_into(
            root.path(),
            computer(),
            false,
            with_large.path(),
            &|on, model| bench.sample(on, model),
        )
        .unwrap();
        assert_eq!(bench.runs(), [(On::Card(0), "large-v3-turbo"); 4]);
        let saved = load_measured(root.path()).unwrap();
        assert_eq!(saved.large, Some(LargeTime::Failed));
        // As for a slow larger model: Settings say so and the small models
        // go on transcribing on the card, which is not stopped.
        assert!(!saved.stopped && !large_due(&saved, true));
        let facts = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(saved)
        };
        assert_eq!(facts.card(), Some(0));
        assert!(!facts.large());
        let device = facts.device();
        assert_eq!(device.kind, DeviceKind::GraphicsCard);
        assert!(device.large_slow && !device.large_in_use);
    }

    #[test]
    fn loading_the_larger_model_does_not_count_against_it() {
        // A run's time spent transcribing is its total time less its load
        // time, from the timings it logs at its end, line ends of either kind.
        assert_eq!(transcribing_ms(LARGE_TIMINGS), Some(381));
        assert_eq!(
            transcribing_ms(&LARGE_TIMINGS.replace('\n', "\r\n")),
            Some(381)
        );
        assert_eq!(
            transcribing_ms(&format!("{VULKAN_DEVICES}{ON_CARD_0}{LARGE_TIMINGS}")),
            Some(381),
            "the last total time counts"
        );
        // Without either line, or with one unreadable, there is none.
        let load_only = "whisper_print_timings:     load time =  1124.59 ms\n";
        let unreadable = load_only.to_owned() + "whisper_print_timings:    total time =  n/a ms\n";
        for log in ["", PROCESSOR_BUILD, load_only, unreadable.as_str()] {
            assert_eq!(transcribing_ms(log), None, "{log}");
        }
        // A run without them counts whole.
        assert_eq!(run(true, 2_098, PROCESSOR_BUILD).transcribing_ms(), 2_098);
        assert_eq!(run(true, 2_098, LARGE_TIMINGS).transcribing_ms(), 381);

        // This PC: the whole run of the sample took 2088 ms on the processor
        // with small and 10 ms more on the RTX 5090 with Large, which spent
        // 1240 ms of it loading the model.
        let card_0 = format!("{VULKAN_DEVICES}{ON_CARD_0}");
        let card_1 = format!("{VULKAN_DEVICES}{ON_CARD_1}");
        let bench = |times: bool| {
            let timed = |log: &str, load, total| {
                if times {
                    format!("{log}{}", timings(load, total))
                } else {
                    log.to_owned()
                }
            };
            let (processor, large) = (
                timed(PROCESSOR_BUILD, 290.81, 1_990.81),
                timed(&card_0, 1_240.0, 1_662.0),
            );
            let (card_0, card_1) = (card_0.clone(), card_1.clone());
            move |on: On, model: &'static SpeechModel| -> Result<Run, Cut> {
                Ok(match on {
                    On::Processor => run(true, 2_088, &processor),
                    On::Card(0) if model == &LARGE => run(true, 2_098, &large),
                    On::Card(0) => run(true, 1_102, &card_0),
                    On::Card(_) => run(true, 5_022, &card_1),
                })
            }
        };
        let with_large = models(&[&BASE, &SMALL, &LARGE]);
        let measured = |times| {
            let root = tempfile::tempdir().unwrap();
            let sample = bench(times);
            measure_into(root.path(), computer(), false, with_large.path(), &sample).unwrap();
            load_measured(root.path()).unwrap()
        };
        let saved = measured(true);
        assert_eq!(
            saved.processor_ms, 2_088,
            "the card is chosen on whole runs"
        );
        assert_eq!(saved.chosen, Some(0));
        assert_eq!(saved.processor_transcribing_ms, Some(1_700));
        assert_eq!(saved.large, Some(LargeTime::Ms(422)));
        // Large is no slower, so with Large chosen it transcribes on the card,
        // and Settings and `cue setup` say so.
        let facts = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(saved)
        };
        assert!(facts.large());
        let device = facts.device();
        assert!(device.large_offered && !device.large_slow && device.large_in_use);
        assert_eq!(
            FinalRun::on(facts.card(), facts.large().then(large), small()).model,
            large()
        );
        // Runs whose logs lack the timings count whole: Large's 2098 ms is
        // slower than the processor's 2088 ms.
        let whole = measured(false);
        assert_eq!(
            (whole.processor_transcribing_ms, whole.large),
            (Some(2_088), Some(LargeTime::Ms(2_098)))
        );
        let facts = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(whole)
        };
        assert!(!facts.large() && facts.device().large_slow);
    }

    #[test]
    fn a_measurement_without_transcribing_times_is_made_again() {
        // A measurement saved with the processor's whole time only, and the
        // larger model's whole run 10 ms slower than it.
        let root = tempfile::tempdir().unwrap();
        let mut old = serde_json::to_value(Measured {
            processor_ms: 2_088,
            large: Some(LargeTime::Ms(2_098)),
            ..fast()
        })
        .unwrap();
        assert!(old
            .as_object_mut()
            .unwrap()
            .remove("processorTranscribingMs")
            .is_some());
        fs::write(
            root.path().join("speech-device.json"),
            serde_json::to_vec_pretty(&old).unwrap(),
        )
        .unwrap();
        let saved = load_measured(root.path()).unwrap();
        assert_eq!(saved.processor_transcribing_ms, None);
        // Until it is made again Large is judged neither slow nor fit: the
        // small models transcribe on the card.
        let facts = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(saved.clone())
        };
        assert_eq!(facts.card(), Some(0));
        assert!(!facts.large() && !facts.device().large_slow);
        // At the next start it is due without being asked: the devices are
        // timed again, then the larger model, once.
        assert!(needs_measuring(Some(&saved), &computer(), Some(&SMALL)));
        let bench = Bench::new(2_700, &[(RTX, 1_300, true), (AMD, 6_000, true)]);
        let sample = |on, model| bench.sample(on, model);
        let with_large = models(&[&BASE, &SMALL, &LARGE]);
        measure_into(root.path(), computer(), false, with_large.path(), &sample).unwrap();
        let runs = bench.runs();
        assert_eq!(runs.len(), 10, "{runs:?}");
        assert_eq!(runs[6..], [(On::Card(0), "large-v3-turbo"); 4]);
        let again = load_measured(root.path()).unwrap();
        assert_eq!(again.processor_transcribing_ms, Some(2_700));
        assert_eq!(again.large, Some(LargeTime::Ms(2_000)));
        assert!(!needs_measuring(Some(&again), &computer(), Some(&SMALL)));
        measure_into(root.path(), computer(), false, with_large.path(), &sample).unwrap();
        assert!(bench.runs().is_empty());
        let facts = Facts {
            large_chosen: true,
            large_installed: true,
            ..ready(again)
        };
        assert!(facts.large());
    }

    #[test]
    fn a_measurement_of_the_computer_as_it_was_reports_no_card() {
        // After an update, before the app has measured again: `cue setup`
        // names the processor and no card, and offers nothing.
        let stale = Facts {
            current: false,
            large_chosen: true,
            large_installed: true,
            ..ready(Measured {
                large: Some(LargeTime::Failed),
                ..fast()
            })
        };
        assert_eq!(stale.card(), None);
        assert_eq!(stale.device(), processor_here());
        // While the app measures again, the last result is shown.
        let measuring = Facts {
            measuring: true,
            ..stale
        };
        let device = measuring.device();
        assert_eq!(device.state, DeviceState::Measuring);
        assert_eq!(device.kind, DeviceKind::Processor);
        assert!(device.card.is_some() && device.large_offered && device.large_slow);
    }

    #[test]
    fn a_build_is_known_by_its_folder_name_size_and_time_whatever_its_path() {
        let key = |path: &str, size, at| build_key_of(Path::new(path), size, at);
        // The app's verbatim resource path and `cue`'s plain one, for the
        // same file, name the same build.
        if cfg!(windows) {
            for (path, other) in [
                (
                    r"\\?\C:\Program Files\CueReview\tools\whisper-b5454\avx2\whisper-cli.exe",
                    r"C:\Program Files\CueReview\tools\whisper-b5454\avx2\whisper-cli.exe",
                ),
                (
                    r"C:\Users\a\AppData\Local\CueReview\tools/whisper-b5454\vulkan\whisper-cli.exe",
                    r"C:\Program Files\CueReview\tools\whisper-b5454\Vulkan\WHISPER-CLI.EXE",
                ),
            ] {
                assert_eq!(
                    key(path, 47_901_696, 1_795_112_311),
                    key(other, 47_901_696, 1_795_112_311),
                    "{path}"
                );
            }
        }
        assert_eq!(
            key(
                "/opt/cuereview/tools/whisper-b5454/whisper-cli",
                2_383_360,
                1_795_112_311
            ),
            key(
                "/usr/lib/cuereview/tools/whisper-b5454/whisper-cli",
                2_383_360,
                1_795_112_311
            )
        );
        assert_eq!(
            key(
                "/x/tools/whisper-b5454/whisper-cli.exe",
                2_383_360,
                1_795_112_311
            ),
            "whisper-b5454/whisper-cli.exe 2383360 1795112311"
        );
        // Another build, size or time is another runtime.
        let avx2 = key("/x/avx2/whisper-cli.exe", 1, 2);
        assert_ne!(avx2, key("/x/vulkan/whisper-cli.exe", 1, 2));
        assert_ne!(avx2, key("/x/avx2/whisper-cli.exe", 3, 2));
        assert_ne!(avx2, key("/x/avx2/whisper-cli.exe", 1, 4));
        // Read from a real file through both kinds of path.
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("avx2");
        fs::create_dir(&folder).unwrap();
        let plain = folder.join("whisper-cli.exe");
        fs::write(&plain, b"build").unwrap();
        let read = build_key(&plain);
        assert!(read.starts_with("avx2/whisper-cli.exe 5 "), "{read}");
        if cfg!(windows) {
            let verbatim = PathBuf::from(format!(r"\\?\{}", plain.display()));
            assert_eq!(build_key(&verbatim), read);
        }
    }

    #[test]
    fn the_sample_is_jfk_twice_back_to_back() {
        let dir = tempfile::tempdir().unwrap();
        let wav = |name: &str, spec: hound::WavSpec, count: i32| {
            let path = dir.path().join(name);
            let mut writer = hound::WavWriter::create(&path, spec).unwrap();
            for sample in 0..count {
                match spec.sample_format {
                    hound::SampleFormat::Int => writer.write_sample(sample as i16).unwrap(),
                    hound::SampleFormat::Float => writer.write_sample(sample as f32).unwrap(),
                }
            }
            writer.finalize().unwrap();
            path
        };
        let speech = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let jfk = wav("jfk.wav", speech, 1_600);
        let target = dir.path().join("twice.wav");
        twice(&jfk, &target).unwrap();
        let reader = hound::WavReader::open(&target).unwrap();
        assert_eq!(reader.spec(), speech);
        assert_eq!(reader.duration(), 3_200);
        let samples: Vec<i16> = reader.into_samples().map(Result::unwrap).collect();
        let once: Vec<i16> = (0..1_600).collect();
        assert_eq!(samples, [once.clone(), once].concat());
        // The header: the RIFF size and the data chunk's.
        let bytes = fs::read(&target).unwrap();
        assert_eq!(bytes.len(), 44 + 6_400);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            36 + 6_400
        );
        assert_eq!(&bytes[36..40], b"data");
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 6_400);
        // Anything but 16 kHz mono 16-bit PCM, or no file, measures nothing.
        for (name, spec) in [
            (
                "stereo.wav",
                hound::WavSpec {
                    channels: 2,
                    ..speech
                },
            ),
            (
                "44100.wav",
                hound::WavSpec {
                    sample_rate: 44_100,
                    ..speech
                },
            ),
            (
                "float.wav",
                hound::WavSpec {
                    bits_per_sample: 32,
                    sample_format: hound::SampleFormat::Float,
                    ..speech
                },
            ),
        ] {
            let other = wav(name, spec, 160);
            let refused = dir.path().join(format!("twice-{name}"));
            assert!(twice(&other, &refused).is_err(), "{name}");
            assert!(!refused.exists(), "{name}");
        }
        assert!(twice(&dir.path().join("missing.wav"), &target).is_err());
        fs::write(dir.path().join("broken.wav"), b"RIFF").unwrap();
        assert!(twice(&dir.path().join("broken.wav"), &target).is_err());
    }

    #[test]
    fn the_display_adapters_are_read_from_the_registry() {
        // Read-only, from the machine running the tests.
        let adapters = display_adapters();
        assert!(
            adapters.iter().all(|adapter| !adapter.name.is_empty()),
            "{adapters:?}"
        );
        assert_eq!(display_adapters(), adapters, "the same on every read");
        eprintln!("{adapters:?}");
    }
}
