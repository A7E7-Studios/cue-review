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

/// A take of a session with takes, placed on the session timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TakeRef {
    index: u32,
    offset_ms: u64,
}
#[derive(Default)]
struct Runtime {
    active: Option<(Session, capture::ActiveCapture)>,
    /// Set while the active capture is a take recorded by Record more.
    active_take: Option<TakeRef>,
    processing: Option<String>,
    /// The take the processing job is working on, if it is a take job.
    processing_take: Option<TakeRef>,
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
    /// Reports which take the job is working on in the recording status.
    fn working_on(&self, take: Option<TakeRef>) {
        if let Ok(mut runtime) = self.state.runtime.lock() {
            if runtime.processing.as_deref() == Some(self.id.as_str()) {
                runtime.processing_take = take;
            }
        }
    }
}
impl Drop for ProcessingJob {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.state.runtime.lock() {
            if runtime.processing.as_deref() == Some(self.id.as_str()) {
                runtime.processing = None;
                runtime.processing_take = None;
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
/// Moves a snapshot's take-relative bounds onto the session timeline.
fn on_session_clock(take: Option<TakeRef>, (start, end): (u64, u64)) -> (u64, u64) {
    let offset = take.map_or(0, |take| take.offset_ms);
    (start.saturating_add(offset), end.saturating_add(offset))
}
/// The live transcript covers only the capture in progress: a whole first
/// recording, or just the take being recorded, timed on the session timeline.
fn live_transcription(s: Shared, id: String, cancel: Arc<AtomicBool>, take: Option<TakeRef>) {
    if !deps::setup_status().ready {
        publish_live(&s,&id,&cancel,Err("Install local transcription tools to see words while recording. The recording will still be saved.".into()));
        return;
    }
    let folder = match s.store.session_dir(&id) {
        Ok(folder) => takes::take_dir(&folder, take.map_or(1, |take| take.index)).join("live"),
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
        let result = bounds.and_then(|bounds| {
            let (start, end) = on_session_clock(take, bounds);
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
/// Installs a started capture as the active recording. Returns the live
/// transcription's cancel flag.
fn activate(
    runtime: &mut Runtime,
    session: &Session,
    active: capture::ActiveCapture,
    take: Option<TakeRef>,
) -> Arc<AtomicBool> {
    runtime.last_error = None;
    runtime.live_transcript = None;
    let cancel = Arc::new(AtomicBool::new(false));
    runtime.live_cancel = Some(cancel.clone());
    runtime.active = Some((session.clone(), active));
    runtime.active_take = take;
    cancel
}
fn spawn_live(s: &Shared, id: &str, cancel: Arc<AtomicBool>, take: Option<TakeRef>) {
    let state = s.clone();
    let id = id.to_owned();
    if let Err(error) = std::thread::Builder::new()
        .name("live-transcription".into())
        .spawn(move || live_transcription(state, id, cancel, take))
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
        // What the chosen window or display is, so Record more can make sure
        // it captures the same one again.
        let identity = capture::source_identity(&config.source_id);
        let mut session =
            s.store
                .create_session(project_id.as_deref(), name.as_deref(), &config)?;
        if identity.is_some() {
            session.source_identity = identity;
            s.store.save_session(&session)?;
        }
        match capture::start_muted(
            config,
            &s.store.session_dir(&session.id)?,
            muted.unwrap_or(false),
        ) {
            Ok(active) => {
                let cancel = activate(&mut runtime, &session, active, None);
                drop(runtime);
                if session.microphone_id.is_some()
                    || (session.system_audio && !session.source_id.starts_with("android:"))
                {
                    spawn_live(&s, &session.id, cancel, None);
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
    // Re-read under the session lock so a concurrent rename is kept.
    let saved = s.store.update_session(id, |session| {
        match &result {
            Ok(transcript) => {
                Store::apply_auto_title(session, transcript);
                session.status = "ready".into();
                session.error = None;
            }
            Err(e) => {
                session.status = "error".into();
                session.error = Some(e.clone());
            }
        }
        Ok(())
    });
    match saved {
        Ok(_) => {
            if let Err(error) = result {
                job.fail(error);
            }
        }
        Err(update) => job.fail(if s.store.session(id).is_err() {
            "Session metadata could not be read after transcription.".into()
        } else {
            result.err().unwrap_or(update)
        }),
    }
}
/// Adds one finished take to the combined video when it still waits for
/// that, then transcribes only that take. The take ends ready or error, or
/// stays swapping when the video could not be updated.
fn run_take(s: &Shared, id: &str, index: u32) -> Result<(), String> {
    let session = s.store.session(id)?;
    let take = takes::list(&session)
        .into_iter()
        .find(|take| take.index == index)
        .ok_or_else(|| format!("Take {index} is not part of this recording."))?;
    if take.status == TakeStatus::Swapping {
        takes::complete_swap(&s.store, id, index)?;
    } else {
        takes::set_status(&s.store, id, index, TakeStatus::Transcribing)?;
    }
    let result = s
        .inference
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|_guard| transcribe::transcribe_take(&s.store, id, index));
    let status = if result.is_ok() {
        TakeStatus::Ready
    } else {
        TakeStatus::Error
    };
    takes::set_status(&s.store, id, index, status)?;
    result.map(|_| ())
}
/// Background job for takes: works through `indices` in order, then settles
/// the session status from every take's outcome.
fn finish_takes(job: ProcessingJob, indices: Vec<u32>) {
    let s = &job.state;
    let mut failure = None;
    for index in indices {
        let offset_ms = s
            .store
            .session(&job.id)
            .ok()
            .and_then(|session| takes::list(&session).into_iter().find(|t| t.index == index))
            .map_or(0, |take| take.offset_ms);
        job.working_on(Some(TakeRef { index, offset_ms }));
        if let Err(error) = run_take(s, &job.id, index) {
            failure.get_or_insert(error);
        }
    }
    let transcript = s.store.transcript(&job.id).ok();
    let settled = s.store.update_session(&job.id, |session| {
        if let Some(transcript) = &transcript {
            Store::apply_auto_title(session, transcript);
        }
        takes::settle(session, failure.clone());
        Ok(())
    });
    if let Some(error) = failure.or(settled.err()) {
        job.fail(error);
    }
}
#[tauri::command]
async fn stop_recording(s: CmdState<'_>) -> Result<Session, String> {
    let s = s.inner().clone();
    blocking(move || {
        let (session, active, take) = {
            let mut runtime = s.runtime.lock().map_err(|e| e.to_string())?;
            let (session, active) = runtime.active.take().ok_or("No recording is active.")?;
            if let Some(cancel) = runtime.live_cancel.take() {
                cancel.store(true, Ordering::Release);
            }
            let take = runtime.active_take.take();
            runtime.processing = Some(session.id.clone());
            runtime.processing_take = take;
            (session, active, take)
        };
        let job = ProcessingJob {
            state: s.clone(),
            id: session.id.clone(),
        };
        match take {
            Some(take) => stop_take(job, active, take),
            None => stop_first(job, active),
        }
    })
    .await
}
/// Stops a first recording, exactly as before takes existed.
fn stop_first(job: ProcessingJob, mut active: capture::ActiveCapture) -> Result<Session, String> {
    let s = job.state.clone();
    let id = job.id.clone();
    let elapsed = active.elapsed_ms();
    let _ = s.store.update_session(&id, |session| {
        session.duration_ms = elapsed;
        session.status = "processing".into();
        Ok(())
    });
    let stopped = active.stop();
    let elapsed = active.elapsed_ms();
    let mut failure = None;
    let saved = s.store.update_session(&id, |session| {
        session.duration_ms = elapsed;
        session.status = "processing".into();
        // A source/device failure may still leave a completely usable final video.
        let video = attach_finished_video(&s.store, session);
        if let Err(error) = stopped.and(video) {
            session.status = "error".into();
            session.error = Some(error.clone());
            failure = Some(error);
        }
        Ok(())
    });
    let error = match (saved, failure) {
        (Ok(session), None) => {
            std::thread::Builder::new()
                .name("transcription".into())
                .spawn(move || finish_transcription(job))
                .map_err(|e| e.to_string())?;
            return Ok(session);
        }
        (Ok(_), Some(error)) => error,
        (Err(save), Some(error)) => format!("{error}; saving session metadata failed: {save}"),
        (Err(save), None) => {
            let saved = s.store.update_session(&id, |session| {
                session.status = "error".into();
                session.error = Some(save.clone());
                Ok(())
            });
            match saved {
                Ok(_) => save,
                Err(again) => format!("{save}; saving session metadata failed: {again}"),
            }
        }
    };
    job.fail(error.clone());
    Err(error)
}
/// Stops a take: finalizes its own files, probes them, and leaves the swap
/// and the transcription of only this take to a background job.
fn stop_take(
    job: ProcessingJob,
    mut active: capture::ActiveCapture,
    take: TakeRef,
) -> Result<Session, String> {
    let s = job.state.clone();
    let id = job.id.clone();
    let _ = takes::mark_finalizing(&s.store, &id, take.index, active.elapsed_ms());
    let stopped = active.stop();
    match takes::finish_capture(&s.store, &id, take.index, stopped) {
        Ok(session) => {
            std::thread::Builder::new()
                .name("take".into())
                .spawn(move || finish_takes(job, vec![take.index]))
                .map_err(|e| e.to_string())?;
            Ok(session)
        }
        Err(error) => {
            job.fail(error.clone());
            Err(error)
        }
    }
}
#[tauri::command]
async fn retry_transcription(s: CmdState<'_>, id: String) -> Result<(), String> {
    let s = s.inner().clone();
    blocking(move || {
        let session = {
            let mut runtime = s.runtime.lock().map_err(|e| e.to_string())?;
            if runtime.active.is_some() || runtime.processing.is_some() {
                return Err("Finish the current job first.".into());
            }
            let session = s.store.session(&id)?;
            runtime.processing = Some(id.clone());
            runtime.processing_take = None;
            runtime.last_error = None;
            session
        };
        let job = ProcessingJob {
            state: s.clone(),
            id: id.clone(),
        };
        // Sessions with takes retry only their unfinished takes.
        let plan = (!session.takes.is_empty()).then(|| takes::retry_plan(&session));
        let prepared = s.store.update_session(&id, |session| {
            attach_finished_video(&s.store, session)?;
            session.status = "processing".into();
            session.error = None;
            Ok(())
        });
        if let Err(error) = prepared {
            job.fail(error.clone());
            return Err(error);
        }
        let worker = std::thread::Builder::new().name("transcription".into());
        match plan {
            Some(plan) => worker.spawn(move || finish_takes(job, plan)),
            None => worker.spawn(move || finish_transcription(job)),
        }
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
/// Starts take N of session `id`: validates that the session is ready (or in
/// error with a usable video) and that nothing else is recording or
/// processing, probes the combined video for the take's offset and starts
/// capture into `takes/<N>/` from the session's own source.
fn start_take(
    s: &Shared,
    id: &str,
    microphone_id: Option<String>,
    system_audio: Option<bool>,
    muted: bool,
) -> Result<Session, String> {
    let mut runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    if runtime.active.is_some() || runtime.processing.is_some() {
        return Err("Finish the current recording or processing job first.".into());
    }
    let mut session = s.store.session(id)?;
    takes::check_can_record_more(&session)?;
    // A window handle or display number can name something else by now.
    takes::check_source(
        &session,
        capture::source_identity(&session.source_id).as_ref(),
    )?;
    // The offset is the duration of the combined video as it is on disk.
    attach_finished_video(&s.store, &mut session)
        .map_err(|e| format!("Record more needs a playable recording: {e}"))?;
    s.preview
        .lock()
        .map_err(|e| e.to_string())?
        .stop_for_recording(&session.source_id);
    let system_audio = system_audio.unwrap_or(session.system_audio);
    let started = takes::begin(
        &s.store,
        id,
        session.duration_ms,
        microphone_id,
        system_audio,
    )?;
    let take = TakeRef {
        index: started.take.index,
        offset_ms: started.take.offset_ms,
    };
    let config = CaptureConfig {
        source_id: started.session.source_id.clone(),
        microphone_id: started.take.microphone_id.clone(),
        system_audio,
        fps: 30,
    };
    let folder = takes::take_dir(&s.store.session_dir(id)?, take.index);
    match capture::start_muted(config, &folder, muted) {
        Ok(active) => {
            let session = started.session.clone();
            let cancel = activate(&mut runtime, &session, active, Some(take));
            drop(runtime);
            if started.take.microphone_id.is_some()
                || (system_audio && !session.source_id.starts_with("android:"))
            {
                spawn_live(s, id, cancel, Some(take));
            }
            Ok(session)
        }
        Err(error) => {
            let restored = takes::abandon(&s.store, id, started);
            Err(match restored {
                Ok(()) => error,
                Err(restore) => format!("{error}; restoring the session failed: {restore}"),
            })
        }
    }
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
    let s = s.inner().clone();
    blocking(move || start_take(&s, &id, microphone_id, system_audio, muted.unwrap_or(false))).await
}
/// Drops take `index` of session `id` when it cannot be added to the
/// recording; see [`takes::discard`]. Refused while that session records or
/// processes.
fn discard_take_in(s: &Shared, id: &str, index: u32) -> Result<Session, String> {
    // Held throughout, so Retry or Record more cannot start meanwhile.
    let runtime = s.runtime.lock().map_err(|e| e.to_string())?;
    ensure_session_not_in_use(&runtime, id)?;
    takes::discard(&s.store, id, index)
}
/// Drops a take whose swap keeps failing (index 2 or later): it becomes
/// interrupted, keeps its folder, and the session settles, usually to ready.
/// Returns the updated session; the transcript's take dividers are updated.
#[tauri::command]
async fn discard_take(s: CmdState<'_>, id: String, index: u32) -> Result<Session, String> {
    let s = s.inner().clone();
    blocking(move || discard_take_in(&s, &id, index)).await
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
            // elapsedMs stays relative to the take; takeOffsetMs places it.
            return Ok(RecordingStatus {
                state: "recording".into(),
                session_id: Some(session.id.clone()),
                elapsed_ms: active.elapsed_ms(),
                audio_level: active.audio_level(),
                error: active.error(),
                live_transcript: runtime.live_transcript.clone(),
                take_index: runtime.active_take.map(|take| take.index),
                take_offset_ms: runtime.active_take.map(|take| take.offset_ms),
            });
        }
        Ok(idle_status(&runtime))
    })
    .await
}
fn idle_status(runtime: &Runtime) -> RecordingStatus {
    RecordingStatus {
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
        take_index: runtime.processing_take.map(|take| take.index),
        take_offset_ms: runtime.processing_take.map(|take| take.offset_ms),
    }
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            deps::set_resource_dir(app.path().resource_dir()?);
            let store = Store::open(store::data_root()).map_err(std::io::Error::other)?;
            let ownership = store.acquire_ownership().map_err(std::io::Error::other)?;
            // A recording that cannot be recovered never keeps the app from
            // starting. One that was still recording or processing is marked
            // as failed with a message the app shows, so it can be retried or
            // deleted; every skipped one is also logged here.
            match store.recover_interrupted() {
                Ok(skipped) => skipped.iter().for_each(|problem| eprintln!("{problem}")),
                Err(error) => eprintln!("Interrupted recordings were not checked: {error}"),
            }
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
            discard_take,
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
    fn word(text: &str, start_ms: u64, end_ms: u64) -> Word {
        Word {
            text: text.into(),
            start_ms,
            end_ms,
            seek_ms: None,
        }
    }
    #[test]
    fn take_snapshots_are_placed_on_the_session_timeline() {
        assert_eq!(on_session_clock(None, (5000, 8000)), (5000, 8000));
        let take = Some(TakeRef {
            index: 2,
            offset_ms: 80000,
        });
        let (start, end) = on_session_clock(take, (5000, 8000));
        assert_eq!((start, end), (85000, 88000));
        let update = Transcript {
            segments: vec![Segment {
                id: "segment-0".into(),
                start_ms: 100,
                end_ms: 500,
                text: "here".into(),
                words: vec![word("here", 100, 500)],
            }],
            ..Default::default()
        };
        let live = transcribe::merge_live(&Transcript::default(), update, start, end);
        assert_eq!(live.segments[0].id, "live-85000-0");
        assert_eq!(
            (
                live.segments[0].words[0].start_ms,
                live.segments[0].words[0].end_ms
            ),
            (85100, 85500)
        );
    }
    #[test]
    fn processing_status_reports_the_take_until_the_job_ends() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        let take = TakeRef {
            index: 3,
            offset_ms: 134000,
        };
        {
            let mut runtime = state.runtime.lock().unwrap();
            runtime.processing = Some("take-job".into());
            runtime.processing_take = Some(take);
        }
        let status = idle_status(&state.runtime.lock().unwrap());
        assert_eq!(status.state, "processing");
        assert_eq!(status.session_id.as_deref(), Some("take-job"));
        assert_eq!(
            (status.take_index, status.take_offset_ms),
            (Some(3), Some(134000))
        );
        let other = ProcessingJob {
            state: state.clone(),
            id: "other".into(),
        };
        other.working_on(None);
        drop(other);
        assert_eq!(state.runtime.lock().unwrap().processing_take, Some(take));
        drop(ProcessingJob {
            state: state.clone(),
            id: "take-job".into(),
        });
        let status = idle_status(&state.runtime.lock().unwrap());
        assert_eq!(status.state, "idle");
        assert_eq!((status.take_index, status.take_offset_ms), (None, None));
    }
    fn ready_with_takes(state: &Shared) -> Session {
        ready_from(state, "android:R3CN90")
    }
    /// A ready single-take session recorded from `source_id`.
    fn ready_from(state: &Shared, source_id: &str) -> Session {
        let mut session = state
            .store
            .create_session(
                None,
                Some("Takes"),
                &CaptureConfig {
                    source_id: source_id.into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        session.status = "ready".into();
        session.duration_ms = 2000;
        state.store.save_session(&session).unwrap();
        session
    }
    #[test]
    fn record_more_is_refused_while_busy_or_without_a_playable_recording() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        let session = ready_with_takes(&state);
        state.runtime.lock().unwrap().processing = Some("other".into());
        assert!(start_take(&state, &session.id, None, None, false)
            .unwrap_err()
            .contains("Finish the current"));
        state.runtime.lock().unwrap().processing = None;
        // No combined video on disk: nothing to continue from.
        assert!(start_take(&state, &session.id, None, None, false)
            .unwrap_err()
            .contains("playable recording"));
        state
            .store
            .update_session(&session.id, |s| {
                s.status = "processing".into();
                Ok(())
            })
            .unwrap();
        assert!(start_take(&state, &session.id, None, None, false).is_err());
        let unchanged = state.store.session(&session.id).unwrap();
        assert!(unchanged.takes.is_empty());
        assert!(state.runtime.lock().unwrap().active.is_none());
        assert!(!state
            .store
            .session_dir(&session.id)
            .unwrap()
            .join("takes")
            .exists());
    }
    #[test]
    fn record_more_refuses_a_window_or_display_that_is_gone() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        // HWND 1 is never a window, and display 99 is never attached. A
        // window recorded before identities were stored is refused outright.
        let window = SourceIdentity::Window {
            title: "Review".into(),
            process: "notes.exe".into(),
            class: "NotesWindow".into(),
            pid: Some(4242),
            process_created_ms: Some(1_793_000_000_000),
        };
        let display = SourceIdentity::Display {
            device: r"\\.\DISPLAY99".into(),
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        for (source, identity) in [
            ("window:1", None),
            ("window:1", Some(window)),
            ("monitor:99", None),
            ("monitor:99", Some(display)),
        ] {
            let mut session = ready_from(&state, source);
            session.source_identity = identity;
            state.store.save_session(&session).unwrap();
            let before = std::fs::read(
                state
                    .store
                    .session_dir(&session.id)
                    .unwrap()
                    .join("session.json"),
            )
            .unwrap();
            assert_eq!(
                start_take(&state, &session.id, None, None, false).unwrap_err(),
                "The original window/display for this recording is no longer available. Start a new recording to capture another source.",
                "{source}"
            );
            let dir = state.store.session_dir(&session.id).unwrap();
            assert_eq!(std::fs::read(dir.join("session.json")).unwrap(), before);
            assert!(!dir.join("takes").exists());
            assert!(state.runtime.lock().unwrap().active.is_none());
        }
    }
    #[test]
    fn discarding_a_take_waits_until_the_session_is_not_in_use() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        let mut session = ready_with_takes(&state);
        let take = |index, offset_ms, duration_ms, status| Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: takes::folder_label(index),
            source_id: None,
            microphone_id: None,
            system_audio: false,
        };
        session.status = "error".into();
        session.error = Some("Take 2 could not be added.".into());
        session.takes = vec![
            take(1, 0, 2000, TakeStatus::Ready),
            take(2, 2000, 1500, TakeStatus::Swapping),
        ];
        state.store.save_session(&session).unwrap();
        state.runtime.lock().unwrap().processing = Some(session.id.clone());
        assert!(discard_take_in(&state, &session.id, 2)
            .unwrap_err()
            .contains("Finish recording and processing"));
        assert_eq!(
            state.store.session(&session.id).unwrap().takes[1].status,
            TakeStatus::Swapping
        );
        state.runtime.lock().unwrap().processing = None;
        let discarded = discard_take_in(&state, &session.id, 2).unwrap();
        assert_eq!(discarded.takes[1].status, TakeStatus::Interrupted);
        assert_eq!(
            (discarded.status.as_str(), discarded.error.as_deref()),
            ("ready", None)
        );
        assert!(takes::check_can_record_more(&discarded).is_ok());
    }
    #[test]
    fn retrying_a_take_transcribes_only_it_and_settles_the_session() {
        let folder = tempfile::tempdir().unwrap();
        let state = state(folder.path().into());
        let mut session = ready_with_takes(&state);
        // Video-only takes need no speech tools: each transcribes as empty.
        let take = |index, offset_ms, duration_ms, status| Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: takes::folder_label(index),
            source_id: None,
            microphone_id: None,
            system_audio: false,
        };
        session.status = "processing".into();
        session.duration_ms = 3500;
        session.takes = vec![
            take(1, 0, 2000, TakeStatus::Ready),
            take(2, 2000, 1500, TakeStatus::Error),
        ];
        state.store.save_session(&session).unwrap();
        let kept = Segment {
            id: "segment-0".into(),
            start_ms: 100,
            end_ms: 900,
            text: "Take one".into(),
            words: vec![word("Take", 100, 400), word("one", 500, 900)],
        };
        state
            .store
            .save_transcript(
                &session.id,
                &Transcript {
                    segments: vec![kept.clone()],
                    status: Some("complete".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        state.runtime.lock().unwrap().processing = Some(session.id.clone());
        let plan = takes::retry_plan(&state.store.session(&session.id).unwrap());
        assert_eq!(plan, [2]);
        finish_takes(
            ProcessingJob {
                state: state.clone(),
                id: session.id.clone(),
            },
            plan,
        );
        let done = state.store.session(&session.id).unwrap();
        assert_eq!(
            (done.status.as_str(), done.error.as_deref()),
            ("ready", None)
        );
        assert_eq!(done.takes[1].status, TakeStatus::Ready);
        let transcript = state.store.transcript(&session.id).unwrap();
        assert_eq!(transcript.segments.len(), 1);
        assert_eq!(transcript.segments[0].text, kept.text);
        assert_eq!(
            transcript.takes,
            [
                TakeMark {
                    index: 1,
                    start_ms: 0
                },
                TakeMark {
                    index: 2,
                    start_ms: 2000
                }
            ]
        );
        let runtime = state.runtime.lock().unwrap();
        assert!(runtime.processing.is_none() && runtime.processing_take.is_none());
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
