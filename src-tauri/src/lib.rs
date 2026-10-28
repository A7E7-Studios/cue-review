pub mod agent;
pub mod capture;
pub mod cli;
pub mod cursor;
pub mod deps;
pub mod models;
pub mod preview;
pub mod settings;
pub mod store;
pub mod takes;
pub mod transcribe;

use models::*;
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use store::Store;
use tauri::{Emitter, Manager};

#[derive(Default)]
struct Runtime {
    active: Option<(Session, capture::ActiveCapture)>,
    processing: Option<String>,
    last_error: Option<String>,
    live_transcript: Option<Transcript>,
    live_cancel: Option<Arc<AtomicBool>>,
}
struct AppState {
    store: Store,
    _ownership: std::fs::File,
    runtime: Mutex<Runtime>,
    installer: Mutex<()>,
    inference: Mutex<()>,
    preview: Mutex<preview::Preview>,
}
type Shared = Arc<AppState>;
type CmdState<'a> = tauri::State<'a, Shared>;
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// Ownership of this guard follows the worker, so every return path releases the job.
struct ProcessingJob {
    state: Shared,
    id: String,
}
impl ProcessingJob {
    fn fail(&self, error: String) {
        if let Ok(mut runtime) = self.state.runtime.lock() {
            runtime.last_error = Some(error);
        }
    }
}
impl Drop for ProcessingJob {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.state.runtime.lock() {
            if runtime.processing.as_deref() == Some(self.id.as_str()) {
                runtime.processing = None;
            }
        }
    }
}
pub fn attach_finished_video(store: &Store, session: &mut Session) -> Result<(), String> {
    let path = store.session_dir(&session.id)?.join("video.mp4");
    let output = deps::command("ffprobe")?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type:format=duration",
            "-of",
            "json",
        ])
        .arg(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "The finalized recording could not be read: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or("The finalized recording has no valid duration.")?;
    if value["streams"][0]["codec_type"].as_str() != Some("video") {
        return Err("The finalized recording has no video stream.".into());
    }
    session.video_path = Some(path.to_string_lossy().into());
    session.duration_ms = (duration * 1000.0).round() as u64;
    Ok(())
}
fn accepts_live_update(runtime: &Runtime, id: &str, cancel: &AtomicBool) -> bool {
    !cancel.load(Ordering::Acquire)
        && runtime
            .active
            .as_ref()
            .is_some_and(|(session, _)| session.id == id)
}
fn publish_live(
    s: &Shared,
    id: &str,
    cancel: &AtomicBool,
    result: Result<(Transcript, u64, u64), String>,
) {
    if let Ok(mut runtime) = s.runtime.lock() {
        if !accepts_live_update(&runtime, id, cancel) {
            return;
        }
        let previous = runtime.live_transcript.take().unwrap_or_default();
        runtime.live_transcript = Some(match result {
            Ok((update, start, end)) => transcribe::merge_live(&previous, update, start, end),
            Err(error) => Transcript {
                status: Some("error".into()),
                error: Some(error),
                ..previous
            },
        });
    }
}
fn live_transcription(s: Shared, id: String, cancel: Arc<AtomicBool>) {
    if !deps::setup_status().ready {
        publish_live(&s,&id,&cancel,Err("Install local transcription tools to see words while recording. The recording will still be saved.".into()));
        return;
    }
    let folder = match s.store.session_dir(&id) {
        Ok(folder) => folder.join("live"),
        Err(_) => return,
    };
    if let Err(error) = std::fs::create_dir_all(&folder) {
        publish_live(&s, &id, &cancel, Err(error.to_string()));
        return;
    }
    let snapshot = folder.join("snapshot.wav");
    let mut next = Instant::now() + Duration::from_secs(8);
    loop {
        while Instant::now() < next {
            if cancel.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Snapshot copying is bounded to 30 seconds. Never hold runtime during inference.
        let bounds = {
            let runtime = match s.runtime.lock() {
                Ok(runtime) => runtime,
                Err(_) => return,
            };
            if !accepts_live_update(&runtime, &id, &cancel) {
                return;
            }
            runtime.active.as_ref().unwrap().1.snapshot_audio(&snapshot)
        };
        let result = bounds.and_then(|(start, end)| {
            let _inference = s.inference.lock().map_err(|e| e.to_string())?;
            if cancel.load(Ordering::Acquire) {
                return Err("Live transcription cancelled.".into());
            }
            transcribe::transcribe_snapshot(&s.store.root, &snapshot, &folder, &cancel)
                .map(|update| (update, start, end))
        });
        publish_live(&s, &id, &cancel, result);
        if cancel.load(Ordering::Acquire) {
            return;
        }
        next = Instant::now() + Duration::from_secs(8);
    }
}
#[tauri::command]
fn list_projects(s: CmdState<'_>) -> Result<Vec<Project>, String> {
    let _runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    s.store.projects()
}
#[tauri::command]
fn create_project(s: CmdState<'_>, name: String) -> Result<Project, String> {
    let _runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    s.store.create_project(&name)
}
#[tauri::command]
fn rename_project(s: CmdState<'_>, id: String, name: String) -> Result<Project, String> {
    let _runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    s.store.rename_project(&id, &name)
}
#[tauri::command]
fn reorder_projects(s: CmdState<'_>, ids: Vec<String>) -> Result<(), String> {
    let _runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    s.store.reorder_projects(&ids)
}
fn ensure_session_not_in_use(runtime: &Runtime, id: &str) -> Result<(), String> {
    if runtime.processing.as_deref() == Some(id)
        || runtime
            .active
            .as_ref()
            .is_some_and(|(session, _)| session.id == id)
    {
        return Err("Finish recording and processing before changing this recording.".into());
    }
    Ok(())
}
fn delete_section_from_store(s: &Shared, id: &str) -> Result<(), String> {
    // Keep start/retry and other library mutations from racing the metadata updates.
    let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    for session in s.store.sessions(Some(id))? {
        ensure_session_not_in_use(&runtime, &session.id)?;
    }
    s.store.delete_project(id)
}
fn delete_session_from_store(s: &Shared, id: &str) -> Result<(), String> {
    let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    ensure_session_not_in_use(&runtime, id)?;
    s.store.delete_session(id)
}
#[tauri::command]
async fn delete_project(s: CmdState<'_>, id: String) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || delete_section_from_store(&s, &id)).await
}
#[tauri::command]
async fn delete_session(s: CmdState<'_>, id: String) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || delete_session_from_store(&s, &id)).await
}
#[tauri::command]
fn list_sessions(s: CmdState<'_>, project_id: Option<String>) -> Result<Vec<Session>, String> {
    let _runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    s.store.sessions(project_id.as_deref())
}
#[tauri::command]
fn rename_session(s: CmdState<'_>, id: String, name: String) -> Result<Session, String> {
    let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    ensure_session_not_in_use(&runtime, &id)?;
    s.store.rename_session(&id, &name)
}
#[tauri::command]
fn move_session(
    s: CmdState<'_>,
    id: String,
    project_id: Option<String>,
) -> Result<Session, String> {
    let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    ensure_session_not_in_use(&runtime, &id)?;
    s.store.move_session(&id, project_id.as_deref())
}
#[tauri::command]
fn get_session(s: CmdState<'_>, id: String) -> Result<Session, String> {
    s.store.session(&id)
}
#[tauri::command]
fn get_transcript(s: CmdState<'_>, id: String) -> Result<Transcript, String> {
    s.store.transcript(&id)
}
#[tauri::command]
fn get_markers(s: CmdState<'_>, id: String) -> Result<Vec<Marker>, String> {
    s.store.markers(&id)
}
#[tauri::command]
fn add_marker(s: CmdState<'_>, id: String, time_ms: u64, label: String) -> Result<Marker, String> {
    s.store.add_marker(&id, time_ms, &label)
}
#[tauri::command]
async fn list_sources() -> Result<Vec<CaptureSource>, String> {
    blocking(capture::sources).await
}
#[tauri::command]
async fn list_microphones() -> Result<Vec<Microphone>, String> {
    blocking(capture::microphones).await
}
#[tauri::command]
async fn start_preview(
    s: CmdState<'_>,
    id: String,
    source_id: String,
    errors: tauri::ipc::Channel<String>,
) -> Result<preview::StreamInfo, String> {
    let s = s.inner().clone();
    blocking(move || {
        // The runtime lock precedes preview everywhere both are needed. Keep it
        // through startup so preview cannot reopen an exclusive camera mid-start.
        let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
        if preview::requires_exclusive_capture(&source_id)
            && runtime.active.as_ref().is_some_and(|(session, _)| session.source_id == source_id)
        {
            return Err("Camera preview is paused while recording because this device supports one capture stream. Stop recording to preview it again.".into());
        }
        s.preview.lock().map_err(|e| e.to_string())?.start(
            id,
            &source_id,
            Arc::new(move |error| {
                let _ = errors.send(error);
            }),
        )
    })
    .await
}
#[tauri::command]
async fn stop_preview(s: CmdState<'_>, id: String) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || {
        s.preview.lock().map_err(|e| e.to_string())?.stop(&id);
        Ok(())
    })
    .await
}
#[tauri::command]
async fn get_setup_status() -> Result<SetupStatus, String> {
    blocking(|| Ok(deps::setup_status())).await
}
#[tauri::command]
async fn install_transcription(s: CmdState<'_>) -> Result<SetupStatus, String> {
    let s = s.inner().clone();
    blocking(move || {
        let _guard = s.installer.lock().map_err(|e| e.to_string())?;
        deps::install_transcription()
    })
    .await
}
#[tauri::command]
fn get_agent_handoff(s: CmdState<'_>, app: tauri::AppHandle, id: String) -> Result<String, String> {
    let name = if cfg!(windows) { "cue.exe" } else { "cue" };
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(name);
    let sibling = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(name);
    agent::handoff(
        &s.store,
        &id,
        if bundled.is_file() {
            &bundled
        } else {
            &sibling
        },
    )
}
#[tauri::command]
fn open_session_folder(s: CmdState<'_>, id: String) -> Result<(), String> {
    let folder = session_folder_for_shell(&s.store, &id)?;
    let opener = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(opener).arg(&folder).spawn().map_err(|e| {
        format!(
            "Could not open {} in the file manager: {e}",
            folder.display()
        )
    })?;
    Ok(())
}
fn session_folder_for_shell(store: &Store, id: &str) -> Result<std::path::PathBuf, String> {
    store.session(id)?;
    // A packaged launcher can redirect LocalAppData for its child processes.
    // Explorer is outside that context, so give it the physical filesystem path
    // in a shell-compatible form rather than the virtualized logical path.
    let folder = store.session_dir(id)?;
    dunce::canonicalize(&folder).map_err(|e| {
        format!(
            "The recording folder {} is unavailable: {e}",
            folder.display()
        )
    })
}
#[tauri::command]
async fn start_recording(
    s: CmdState<'_>,
    project_id: Option<String>,
    name: Option<String>,
    source_id: String,
    microphone_id: Option<String>,
    system_audio: bool,
    muted: Option<bool>,
) -> Result<Session, String> {
    let s = s.inner().clone();
    blocking(move || {
        let mut runtime = s.runtime.lock().map_err(|e| e.to_string())?;
        if runtime.active.is_some() || runtime.processing.is_some() {
            return Err("Finish the current recording or processing job first.".into());
        }
        s.preview
            .lock()
            .map_err(|e| e.to_string())?
            .stop_for_recording(&source_id);
        let config = CaptureConfig {
            source_id,
            microphone_id,
            system_audio,
            fps: 30,
        };
        let mut session =
            s.store
                .create_session(project_id.as_deref(), name.as_deref(), &config)?;
        match capture::start_muted(
            config,
            &s.store.session_dir(&session.id)?,
            muted.unwrap_or(false),
        ) {
            Ok(active) => {
                runtime.last_error = None;
                runtime.live_transcript = None;
                let cancel = Arc::new(AtomicBool::new(false));
                runtime.live_cancel = Some(cancel.clone());
                runtime.active = Some((session.clone(), active));
                drop(runtime);
                if session.microphone_id.is_some()
                    || (session.system_audio && !session.source_id.starts_with("android:"))
                {
                    let state = s.clone();
                    let id = session.id.clone();
                    if let Err(error) = std::thread::Builder::new()
                        .name("live-transcription".into())
                        .spawn(move || live_transcription(state, id, cancel))
                    {
                        if let Ok(mut runtime) = s.runtime.lock() {
                            runtime.live_transcript = Some(Transcript {
                                status: Some("error".into()),
                                error: Some(format!("Live transcript could not start: {error}")),
                                ..Default::default()
                            });
                        }
                    }
                }
                Ok(session)
            }
            Err(e) => {
                session.status = "error".into();
                session.error = Some(e.clone());
                s.store.save_session(&session)?;
                Err(e)
            }
        }
    })
    .await
}
fn finish_transcription(job: ProcessingJob) {
    let s = &job.state;
    let id = &job.id;
    let result = s
        .inference
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|_guard| transcribe::transcribe(&s.store, id));
    if let Ok(mut session) = s.store.session(id) {
        match &result {
            Ok(transcript) => {
                Store::apply_auto_title(&mut session, transcript);
                session.status = "ready".into();
                session.error = None;
            }
            Err(e) => {
                session.status = "error".into();
                session.error = Some(e.clone());
            }
        }
        let save = s.store.save_session(&session);
        if let Some(error) = result.err().or(save.err()) {
            job.fail(error);
        }
    } else {
        job.fail("Session metadata could not be read after transcription.".into());
    }
}
#[tauri::command]
async fn stop_recording(s: CmdState<'_>) -> Result<Session, String> {
    let s = s.inner().clone();
    blocking(move || {
        let (mut session, mut active) = {
            let mut runtime = s.runtime.lock().map_err(|e| e.to_string())?;
            let pair = runtime.active.take().ok_or("No recording is active.")?;
            if let Some(cancel) = runtime.live_cancel.take() {
                cancel.store(true, Ordering::Release);
            }
            runtime.processing = Some(pair.0.id.clone());
            pair
        };
        let job = ProcessingJob {
            state: s.clone(),
            id: session.id.clone(),
        };
        session.duration_ms = active.elapsed_ms();
        session.status = "processing".into();
        let _ = s.store.save_session(&session);
        let stopped = active.stop();
        session.duration_ms = active.elapsed_ms();
        // A source/device failure may still leave a completely usable final video.
        let video = attach_finished_video(&s.store, &mut session);
        if let Err(error) = stopped
            .and(video)
            .and_then(|_| s.store.save_session(&session))
        {
            session.status = "error".into();
            session.error = Some(error.clone());
            let saved = s.store.save_session(&session);
            let error = match saved {
                Ok(()) => error,
                Err(save) => format!("{error}; saving session metadata failed: {save}"),
            };
            job.fail(error.clone());
            return Err(error);
        }
        std::thread::Builder::new()
            .name("transcription".into())
            .spawn(move || finish_transcription(job))
            .map_err(|e| e.to_string())?;
        Ok(session)
    })
    .await
}
#[tauri::command]
async fn retry_transcription(s: CmdState<'_>, id: String) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || {
        let mut session = {
            let mut runtime = s.runtime.lock().map_err(|e| e.to_string())?;
            if runtime.active.is_some() || runtime.processing.is_some() {
                return Err("Finish the current job first.".into());
            }
            let session = s.store.session(&id)?;
            runtime.processing = Some(id.clone());
            runtime.last_error = None;
            session
        };
        let job = ProcessingJob {
            state: s.clone(),
            id,
        };
        if let Err(error) = attach_finished_video(&s.store, &mut session) {
            job.fail(error.clone());
            return Err(error);
        }
        session.status = "processing".into();
        session.error = None;
        if let Err(error) = s.store.save_session(&session) {
            job.fail(error.clone());
            return Err(error);
        }
        std::thread::Builder::new()
            .name("transcription".into())
            .spawn(move || finish_transcription(job))
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
/// Continues a ready session as a new take, locked to the session's source.
/// As in `start_recording`, `None` for `microphone_id` records without a
/// microphone and `muted` defaults to false; `None` for `system_audio` keeps
/// the session's choice. Returns the session with the new take recording.
#[tauri::command]
async fn record_more(
    s: CmdState<'_>,
    id: String,
    microphone_id: Option<String>,
    system_audio: Option<bool>,
    muted: Option<bool>,
) -> Result<Session, String> {
    // WP C fills this
    let _ = (s, id, microphone_id, system_audio, muted);
    Err("Record more is not available yet".into())
}
#[tauri::command]
fn get_settings(s: CmdState<'_>) -> Settings {
    settings::load(&s.store.root)
}
#[tauri::command]
fn save_settings(s: CmdState<'_>, settings: Settings) -> Result<Settings, String> {
    settings::save(&s.store.root, &settings)
}
#[tauri::command]
async fn set_microphone_muted(s: CmdState<'_>, muted: bool) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || {
        let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
        if let Some((_, active)) = &runtime.active {
            active.set_muted(muted);
        }
        Ok(())
    })
    .await
}
#[tauri::command]
async fn get_recording_status(s: CmdState<'_>) -> Result<RecordingStatus, String> {
    let s = s.inner().clone();
    blocking(move || {
        let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
        if let Some((session, active)) = &runtime.active {
            return Ok(RecordingStatus {
                state: "recording".into(),
                session_id: Some(session.id.clone()),
                elapsed_ms: active.elapsed_ms(),
                audio_level: active.audio_level(),
                error: active.error(),
                live_transcript: runtime.live_transcript.clone(),
                take_index: None,
                take_offset_ms: None,
            });
        }
        Ok(RecordingStatus {
            state: if runtime.processing.is_some() {
                "processing"
            } else {
                "idle"
            }
            .into(),
            session_id: runtime.processing.clone(),
            elapsed_ms: 0,
            audio_level: 0.,
            error: runtime.last_error.clone(),
            live_transcript: None,
            take_index: None,
            take_offset_ms: None,
        })
    })
    .await
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            deps::set_resource_dir(app.path().resource_dir()?);
            let store = Store::open(store::data_root()).map_err(std::io::Error::other)?;
            let ownership = store.acquire_ownership().map_err(std::io::Error::other)?;
            store.recover_interrupted().map_err(std::io::Error::other)?;
            app.asset_protocol_scope()
                .allow_directory(store.root.join("sessions"), true)?;
            app.manage(Arc::new(AppState {
                store,
                _ownership: ownership,
                runtime: Mutex::new(Runtime::default()),
                installer: Mutex::new(()),
                inference: Mutex::new(()),
                preview: Mutex::new(preview::Preview::default()),
            }));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let s = window.state::<Shared>();
                let busy = match s.runtime.try_lock() {
                    Ok(runtime) => runtime.active.is_some() || runtime.processing.is_some(),
                    Err(_) => true,
                };
                if busy {
                    api.prevent_close();
                    let _ = window.emit(
                        "close-blocked",
                        "Finish recording and processing before closing CueReview.",
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            rename_project,
            reorder_projects,
            delete_project,
            list_sessions,
            rename_session,
            move_session,
            delete_session,
            get_session,
            get_transcript,
            get_markers,
            add_marker,
            list_sources,
            list_microphones,
            start_preview,
            stop_preview,
            get_setup_status,
            install_transcription,
            get_agent_handoff,
            open_session_folder,
            start_recording,
            stop_recording,
            record_more,
            retry_transcription,
            set_microphone_muted,
            get_recording_status,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("CueReview failed to start");
}

#[cfg(test)]
mod orchestration_tests {
    use super::*;
    #[test]
    fn shell_folder_resolves_the_physical_path_and_preserves_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(temp.path().join("recordings with spaces")).unwrap();
        let session = store
            .create_session(
                None,
                None,
                &CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        let folder = session_folder_for_shell(&store, &session.id).unwrap();
        assert_eq!(
            folder,
            dunce::canonicalize(store.session_dir(&session.id).unwrap()).unwrap()
        );
        assert!(folder.join("session.json").is_file());
        assert!(!folder.to_string_lossy().starts_with(r"\\?\"));
        assert!(session_folder_for_shell(&store, "../outside").is_err());
        assert!(session_folder_for_shell(&store, &uuid::Uuid::new_v4().to_string()).is_err());
    }
    fn state(root: std::path::PathBuf) -> Shared {
        let store = Store::open(root).unwrap();
        let ownership = store.acquire_ownership().unwrap();
        Arc::new(AppState {
            store,
            _ownership: ownership,
            runtime: Mutex::new(Runtime::default()),
            installer: Mutex::new(()),
            inference: Mutex::new(()),
            preview: Mutex::new(preview::Preview::default()),
        })
    }
    #[test]
    fn deletion_waits_for_runtime_ownership_even_after_metadata_is_ready() {
        let root = tempfile::tempdir().unwrap();
        let state = state(root.path().into());
        let section = state.store.create_project("Keep recordings").unwrap();
        let mut session = state
            .store
            .create_session(
                Some(&section.id),
                None,
                &CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        session.status = "ready".into();
        state.store.save_session(&session).unwrap();
        state.runtime.lock().unwrap().processing = Some(session.id.clone());
        assert!(delete_session_from_store(&state, &session.id).is_err());
        assert!(delete_section_from_store(&state, &section.id).is_err());
        assert!(state.store.session(&session.id).is_ok());
        assert!(state.store.project(&section.id).is_ok());
        state.runtime.lock().unwrap().processing = None;
        delete_section_from_store(&state, &section.id).unwrap();
        assert!(state
            .store
            .session(&session.id)
            .unwrap()
            .project_id
            .is_none());
        delete_session_from_store(&state, &session.id).unwrap();
        assert!(!state.store.session_dir(&session.id).unwrap().exists());
    }
    #[test]
    fn unreadable_session_releases_processing_job() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        let id = uuid::Uuid::new_v4().to_string();
        state.runtime.lock().unwrap().processing = Some(id.clone());
        finish_transcription(ProcessingJob {
            state: state.clone(),
            id,
        });
        let runtime = state.runtime.lock().unwrap();
        assert!(runtime.processing.is_none());
        assert!(runtime.last_error.as_ref().unwrap().contains("metadata"));
    }
    #[test]
    fn failed_job_guard_does_not_clear_another_session() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        state.runtime.lock().unwrap().processing = Some("new-job".into());
        drop(ProcessingJob {
            state: state.clone(),
            id: "old-job".into(),
        });
        assert_eq!(
            state.runtime.lock().unwrap().processing.as_deref(),
            Some("new-job")
        );
    }
    #[test]
    fn stopped_recording_discards_late_live_results() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        state.runtime.lock().unwrap().live_transcript = Some(Transcript {
            status: Some("previous".into()),
            ..Default::default()
        });
        let cancel = AtomicBool::new(false);
        publish_live(
            &state,
            "stopped-session",
            &cancel,
            Ok((Transcript::default(), 0, 1000)),
        );
        publish_live(
            &state,
            "stopped-session",
            &cancel,
            Err("stale worker failure".into()),
        );
        let runtime = state.runtime.lock().unwrap();
        let transcript = runtime.live_transcript.as_ref().unwrap();
        assert_eq!(transcript.status.as_deref(), Some("previous"));
        assert!(transcript.error.is_none());
        assert!(runtime.last_error.is_none());
    }
    #[test]
    #[ignore = "Requires installed FFmpeg/ffprobe; creates and validates a real test video"]
    fn recovered_video_becomes_playable_metadata() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        let project = state.store.create_project("Recovery").unwrap();
        let mut session = state
            .store
            .create_session(
                Some(&project.id),
                Some("Interrupted source"),
                &CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        let video = state
            .store
            .session_dir(&session.id)
            .unwrap()
            .join("video.mp4");
        let output = deps::command("ffmpeg")
            .unwrap()
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=64x64:r=10",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&video)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(session.video_path.is_none());
        attach_finished_video(&state.store, &mut session).unwrap();
        assert_eq!(session.video_path.as_deref(), video.to_str());
        assert!((900..=1100).contains(&session.duration_ms));
        session.status = "error".into();
        session.video_path = None;
        state.store.save_session(&session).unwrap();
        assert!(agent::transcribe_existing(&state.store, &session.id)
            .unwrap()
            .segments
            .is_empty());
        let restored = state.store.session(&session.id).unwrap();
        assert_eq!(restored.status, "ready");
        assert_eq!(restored.video_path.as_deref(), video.to_str());
        session.status = "error".into();
        state.store.save_session(&session).unwrap();
        std::fs::write(&video, b"not a video").unwrap();
        assert!(attach_finished_video(&state.store, &mut session).is_err());
        assert!(agent::transcribe_existing(&state.store, &session.id).is_err());
        assert_eq!(state.store.session(&session.id).unwrap().status, "error");
    }
}
