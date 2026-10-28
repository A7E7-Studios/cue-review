//! Takes: "Record more" continues a session as a new take (plan decision 10).
//!
//! Take N is recorded into `sessions/<id>/takes/<N>/`, and the legacy root
//! files are take 1. Each take starts at the validated duration of the
//! combined `video.mp4` before it. When a take stops, its own `video.mp4` is
//! appended to the combined file with the ffconcat demuxer (video copied, audio
//! re-encoded), and only that take is transcribed, shifted by its offset, with
//! `t{N}-` segment ids. The shared types live in [`crate::models`]:
//! [`Take`], [`TakeStatus`] and [`TakeMark`].
//!
//! Status of a take:
//! `recording` → `finalizing` → `swapping` → `transcribing` → `ready`/`error`.
//! A take is part of the combined video exactly when its status is
//! `transcribing`, `ready` or `error`, so `error` always means "on the
//! timeline, transcript missing". A take whose capture produced no usable
//! video, or that the app lost while recording, becomes `interrupted` and is
//! not on the timeline; its folder keeps whatever was captured.
//!
//! Folders are always derived from the take index, never from `Take.folder`
//! or other metadata, so a damaged `session.json` cannot redirect cleanup.

use crate::{
    deps,
    models::{Segment, Session, Take, TakeMark, TakeStatus, Transcript},
    store::{read_json, write_json, Store},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

/// The combined recording every take is appended to.
pub const ROOT_VIDEO: &str = "video.mp4";
const TAKE_VIDEO: &str = "video.mp4";
/// A take re-encoded to the combined video's size, only when they differ.
const NORMALIZED_VIDEO: &str = "normalized.mp4";
/// Names a validated combined file that is waiting to replace `video.mp4`.
const PENDING_SWAP: &str = "swap.json";
const SWAP_LOG: &str = "swap.log";
/// Waits between attempts to replace a `video.mp4` that is in use (about 6 s).
const SWAP_BACKOFF_MS: [u64; 6] = [100, 200, 400, 800, 1500, 3000];
const STARTUP_BACKOFF_MS: [u64; 3] = [100, 200, 400];
const MAX_TOLERANCE_MS: u64 = 150;

type Probe<'a> = &'a dyn Fn(&Path) -> Result<Media, String>;

/// Folder of take `index`: the session folder for take 1, `takes/<N>` after.
pub fn take_dir(session_dir: &Path, index: u32) -> PathBuf {
    if index <= 1 {
        session_dir.to_owned()
    } else {
        session_dir.join("takes").join(index.to_string())
    }
}
/// `Take.folder` for take `index`, relative to the session folder.
pub fn folder_label(index: u32) -> String {
    if index <= 1 {
        ".".into()
    } else {
        format!("takes/{index}")
    }
}

/// Every take of the session in order. Take 1 is implicit for sessions
/// recorded before takes existed and is synthesized from the session.
pub fn list(session: &Session) -> Vec<Take> {
    let mut takes = session.takes.clone();
    takes.sort_by_key(|take| take.index);
    if takes.first().is_none_or(|take| take.index != 1) {
        takes.insert(0, implicit_first(session));
    }
    takes
}
fn implicit_first(session: &Session) -> Take {
    let duration_ms = session
        .takes
        .iter()
        .filter(|take| take.index > 1)
        .map(|take| take.offset_ms)
        .min()
        .unwrap_or(session.duration_ms);
    Take {
        index: 1,
        offset_ms: 0,
        duration_ms,
        status: match session.status.as_str() {
            "recording" => TakeStatus::Recording,
            "processing" => TakeStatus::Transcribing,
            "error" => TakeStatus::Error,
            _ => TakeStatus::Ready,
        },
        folder: folder_label(1),
        source_id: None,
        microphone_id: session.microphone_id.clone(),
        system_audio: session.system_audio,
    }
}
/// Whether the take's media is part of the combined `video.mp4`.
pub fn on_timeline(status: TakeStatus) -> bool {
    matches!(
        status,
        TakeStatus::Transcribing | TakeStatus::Ready | TakeStatus::Error
    )
}
/// Transcript dividers: one mark per take on the timeline, empty when there
/// is only one.
pub fn marks(takes: &[Take]) -> Vec<TakeMark> {
    let marks: Vec<_> = takes
        .iter()
        .filter(|take| on_timeline(take.status))
        .map(|take| TakeMark {
            index: take.index,
            start_ms: take.offset_ms,
        })
        .collect();
    if marks.len() > 1 {
        marks
    } else {
        Vec::new()
    }
}
/// Whether the take recorded any audio to transcribe, as for a single recording.
pub fn records_audio(take: &Take) -> bool {
    take.microphone_id.is_some() || take.system_audio
}

/// Segment id prefix of take `index`: none for take 1, `t{N}-` after.
pub fn segment_prefix(index: u32) -> String {
    if index <= 1 {
        String::new()
    } else {
        format!("t{index}-")
    }
}
/// The take a transcript segment belongs to, from its id prefix.
pub fn segment_take(id: &str) -> u32 {
    id.strip_prefix('t')
        .and_then(|rest| rest.split_once('-'))
        .map(|(digits, _)| digits)
        .filter(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|digits| digits.parse::<u32>().ok())
        .filter(|index| *index >= 2)
        .unwrap_or(1)
}
/// Moves a take's own transcript onto the session timeline.
pub fn place(transcript: Transcript, index: u32, offset_ms: u64) -> Vec<Segment> {
    let prefix = segment_prefix(index);
    transcript
        .segments
        .into_iter()
        .map(|mut segment| {
            segment.id = format!("{prefix}{}", segment.id);
            segment.start_ms = segment.start_ms.saturating_add(offset_ms);
            segment.end_ms = segment.end_ms.saturating_add(offset_ms);
            for word in &mut segment.words {
                word.start_ms = word.start_ms.saturating_add(offset_ms);
                word.end_ms = word.end_ms.saturating_add(offset_ms);
                word.seek_ms = word.seek_ms.map(|seek| seek.saturating_add(offset_ms));
            }
            segment
        })
        .collect()
}
/// Replaces take `index`'s segments in `existing` with `update`, which is
/// timed relative to the take, and sets the take dividers to `marks`.
pub fn merge_take(
    existing: &Transcript,
    update: Transcript,
    index: u32,
    offset_ms: u64,
    marks: Vec<TakeMark>,
) -> Transcript {
    let language = existing.language.clone().or(update.language.clone());
    let mut segments: Vec<_> = existing
        .segments
        .iter()
        .filter(|segment| segment_take(&segment.id) != index)
        .cloned()
        .collect();
    segments.extend(place(update, index, offset_ms));
    // Takes never overlap, so take order is time order; the sort is stable.
    segments.sort_by_key(|segment| segment_take(&segment.id));
    Transcript {
        segments,
        language,
        status: Some("complete".into()),
        error: None,
        takes: marks,
    }
}

pub fn take_mut(session: &mut Session, index: u32) -> Result<&mut Take, String> {
    session
        .takes
        .iter_mut()
        .find(|take| take.index == index)
        .ok_or_else(|| format!("Take {index} is not part of this recording."))
}
fn needs_work(status: TakeStatus) -> bool {
    !matches!(status, TakeStatus::Ready | TakeStatus::Interrupted)
}
fn pending_message(take: &Take) -> String {
    match take.status {
        TakeStatus::Swapping => format!(
            "Take {} is saved but has not been added to the recording yet. Retry to finish adding it.",
            take.index
        ),
        _ => format!(
            "Take {} has no transcript yet. Retry transcription.",
            take.index
        ),
    }
}
/// Sets the session status once a take job ends: `error` with `failure`,
/// `error` while any take still needs work, otherwise `ready`.
pub fn settle(session: &mut Session, failure: Option<String>) {
    let pending = list(session)
        .into_iter()
        .find(|take| needs_work(take.status));
    match (failure, pending) {
        (Some(error), _) => {
            session.status = "error".into();
            session.error = Some(error);
        }
        (None, Some(take)) => {
            session.status = "error".into();
            session.error = Some(pending_message(&take));
        }
        (None, None) => {
            session.status = "ready".into();
            session.error = None;
        }
    }
}
/// Record more is allowed for a ready session, or one in error whose earlier
/// takes are all on the timeline. The caller also validates the video.
pub fn check_can_record_more(session: &Session) -> Result<(), String> {
    if !matches!(session.status.as_str(), "ready" | "error") {
        return Err("Finish recording and processing before recording more.".into());
    }
    if let Some(take) = list(session).iter().find(|take| {
        matches!(
            take.status,
            TakeStatus::Recording
                | TakeStatus::Finalizing
                | TakeStatus::Swapping
                | TakeStatus::Transcribing
        )
    }) {
        return Err(format!(
            "Take {} is not finished yet. Retry it before recording more.",
            take.index
        ));
    }
    Ok(())
}
/// Takes a Retry works on: the unfinished ones, or every take on the
/// timeline when none is unfinished.
pub fn retry_plan(session: &Session) -> Vec<u32> {
    let takes = list(session);
    let pending: Vec<_> = takes
        .iter()
        .filter(|take| {
            matches!(
                take.status,
                TakeStatus::Swapping | TakeStatus::Transcribing | TakeStatus::Error
            )
        })
        .map(|take| take.index)
        .collect();
    if pending.is_empty() {
        takes
            .iter()
            .filter(|take| on_timeline(take.status))
            .map(|take| take.index)
            .collect()
    } else {
        pending
    }
}

/// A take that has started recording, with what to restore if capture fails.
#[derive(Debug)]
pub struct Started {
    pub session: Session,
    pub take: Take,
    previous_status: String,
    previous_error: Option<String>,
    previous_takes: Vec<Take>,
}
fn next_index(session: &Session, dir: &Path) -> u32 {
    let mut index = list(session)
        .iter()
        .map(|take| take.index)
        .max()
        .unwrap_or(1)
        + 1;
    // Skip a folder left by an attempt that never reached session.json.
    while take_dir(dir, index).exists() {
        index += 1;
    }
    index
}
/// Appends a recording take at `base_ms`, the validated duration of the
/// combined video, and creates its folder. Take 1 is written out explicitly
/// the first time. The source stays the session's source.
pub fn begin(
    store: &Store,
    id: &str,
    base_ms: u64,
    microphone_id: Option<String>,
    system_audio: bool,
) -> Result<Started, String> {
    let dir = store.session_dir(id)?;
    let mut started = None;
    let session = store.update_session(id, |session| {
        check_can_record_more(session)?;
        let previous_status = session.status.clone();
        let previous_error = session.error.clone();
        let previous_takes = session.takes.clone();
        session.duration_ms = base_ms;
        session.video_path = Some(dir.join(ROOT_VIDEO).to_string_lossy().into());
        session.takes = list(session);
        let index = next_index(session, &dir);
        fs::create_dir_all(take_dir(&dir, index))
            .map_err(|e| format!("Could not create the folder for take {index}: {e}"))?;
        let take = Take {
            index,
            offset_ms: base_ms,
            duration_ms: 0,
            status: TakeStatus::Recording,
            folder: folder_label(index),
            source_id: None,
            microphone_id,
            system_audio,
        };
        session.takes.push(take.clone());
        session.status = "recording".into();
        session.error = None;
        started = Some((take, previous_status, previous_error, previous_takes));
        Ok(())
    })?;
    let (take, previous_status, previous_error, previous_takes) =
        started.ok_or("The take could not be started.")?;
    Ok(Started {
        session,
        take,
        previous_status,
        previous_error,
        previous_takes,
    })
}
/// Undoes [`begin`] when capture could not start: the session returns to its
/// previous state and the new, empty take folder is removed.
pub fn abandon(store: &Store, id: &str, started: Started) -> Result<(), String> {
    store.update_session(id, |session| {
        session.status = started.previous_status.clone();
        session.error = started.previous_error.clone();
        session.takes = started.previous_takes.clone();
        Ok(())
    })?;
    if started.take.index >= 2 {
        let _ = fs::remove_dir_all(take_dir(&store.session_dir(id)?, started.take.index));
    }
    Ok(())
}
/// Marks take `index` as finalizing while its capture stops.
pub fn mark_finalizing(
    store: &Store,
    id: &str,
    index: u32,
    elapsed_ms: u64,
) -> Result<Session, String> {
    store.update_session(id, |session| {
        let take = take_mut(session, index)?;
        take.status = TakeStatus::Finalizing;
        take.duration_ms = elapsed_ms;
        session.status = "processing".into();
        session.error = None;
        Ok(())
    })
}
/// Records the outcome of stopping take `index`. On success the take waits
/// for the swap with its probed duration and the session stays processing.
/// A capture error with a usable take video leaves the swap to Retry, as for
/// a single recording; an unusable take video makes the take interrupted.
pub fn finish_capture(
    store: &Store,
    id: &str,
    index: u32,
    stopped: Result<(), String>,
) -> Result<Session, String> {
    finish_capture_with(store, id, index, stopped, &probe)
}
fn finish_capture_with(
    store: &Store,
    id: &str,
    index: u32,
    stopped: Result<(), String>,
    probe: Probe<'_>,
) -> Result<Session, String> {
    let video = take_dir(&store.session_dir(id)?, index).join(TAKE_VIDEO);
    match (stopped, probe(&video)) {
        (stopped, Err(unreadable)) => {
            let cause = stopped.err().unwrap_or(unreadable);
            store.update_session(id, |session| {
                take_mut(session, index)?.status = TakeStatus::Interrupted;
                settle(session, None);
                Ok(())
            })?;
            Err(format!(
                "Take {index} could not be saved: {cause} The earlier takes are unchanged, and whatever was captured is kept in takes/{index}."
            ))
        }
        (Err(error), Ok(media)) => {
            store.update_session(id, |session| {
                let take = take_mut(session, index)?;
                take.status = TakeStatus::Swapping;
                take.duration_ms = media.duration_ms;
                settle(session, Some(error.clone()));
                Ok(())
            })?;
            Err(error)
        }
        (Ok(()), Ok(media)) => store.update_session(id, |session| {
            let take = take_mut(session, index)?;
            take.status = TakeStatus::Swapping;
            take.duration_ms = media.duration_ms;
            session.status = "processing".into();
            Ok(())
        }),
    }
}
/// Sets one take's status, re-reading the session first.
pub fn set_status(
    store: &Store,
    id: &str,
    index: u32,
    status: TakeStatus,
) -> Result<Session, String> {
    store.update_session(id, |session| {
        take_mut(session, index)?.status = status;
        Ok(())
    })
}
/// Appends swapping take `index` to the combined `video.mp4`, or finishes an
/// earlier attempt, then records the new duration and marks the take
/// transcribing. On failure the take stays swapping for Retry or the next
/// start.
pub fn complete_swap(store: &Store, id: &str, index: u32) -> Result<Session, String> {
    let session = store.session(id)?;
    let take = list(&session)
        .into_iter()
        .find(|take| take.index == index && index >= 2)
        .ok_or_else(|| format!("Take {index} is not part of this recording."))?;
    if take.status != TakeStatus::Swapping {
        return Err(format!("Take {index} is not waiting to be added."));
    }
    let dir = store.session_dir(id)?;
    let combined = swap_media(&dir, &take, &SWAP_BACKOFF_MS, true, &probe)?
        .ok_or_else(|| format!("Take {index} could not be added to the recording."))?;
    store.update_session(id, |session| {
        session.duration_ms = combined;
        session.video_path = Some(dir.join(ROOT_VIDEO).to_string_lossy().into());
        let take = take_mut(session, index)?;
        if take.status == TakeStatus::Swapping {
            take.status = TakeStatus::Transcribing;
        }
        Ok(())
    })
}

/// Startup repair for a session with takes:
/// - recording or finalizing → interrupted, raw tracks kept, earlier takes intact;
/// - swapping → `video.mp4`'s duration says whether the swap happened; a
///   validated combined file still waiting is moved into place, otherwise the
///   take stays swapping for Retry;
/// - transcribing → error, so Retry transcribes only that take;
/// - stray `video.*.tmp.mp4` files are deleted.
pub fn recover(store: &Store, id: &str) -> Result<(), String> {
    recover_with(store, id, &probe, &STARTUP_BACKOFF_MS)
}
fn recover_with(store: &Store, id: &str, probe: Probe<'_>, backoff: &[u64]) -> Result<(), String> {
    let dir = store.session_dir(id)?;
    let _lock = store.lock_session(id)?;
    let mut session = store.session(id)?;
    if session.takes.is_empty() {
        return Ok(());
    }
    let before = serde_json::to_value(&session).map_err(|e| e.to_string())?;
    let keep: Vec<String> = session
        .takes
        .iter()
        .filter(|take| take.status == TakeStatus::Swapping && take.index >= 2)
        .filter_map(|take| read_pending(&dir, take.index).map(|pending| pending.temp))
        .collect();
    remove_stray_files(&dir, &keep);
    let mut combined = None;
    let mut changed = false;
    for take in &mut session.takes {
        let next = match take.status {
            TakeStatus::Recording | TakeStatus::Finalizing => Some(TakeStatus::Interrupted),
            TakeStatus::Transcribing => Some(TakeStatus::Error),
            TakeStatus::Swapping if take.index >= 2 => {
                match swap_media(&dir, take, backoff, false, probe) {
                    // In the combined video now; transcription waits for Retry.
                    Ok(Some(duration_ms)) => {
                        combined = Some(duration_ms);
                        Some(TakeStatus::Error)
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some(next) = next {
            take.status = next;
            changed = true;
        }
    }
    if let Some(duration_ms) = combined {
        session.duration_ms = duration_ms;
    }
    // A settled session keeps its detailed error until something changes.
    if changed || matches!(session.status.as_str(), "recording" | "processing") {
        let video = dir.join(ROOT_VIDEO);
        if video.is_file() {
            session.video_path = Some(video.to_string_lossy().into());
        }
        settle(&mut session, None);
    }
    if serde_json::to_value(&session).map_err(|e| e.to_string())? != before {
        store.save_session(&session)?;
    }
    Ok(())
}
fn is_temp_name(name: &str) -> bool {
    name.len() > "video..tmp.mp4".len()
        && name.starts_with("video.")
        && name.ends_with(".tmp.mp4")
        && !name.contains(['/', '\\'])
}
fn remove_stray_files(dir: &Path, keep: &[String]) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stray = (is_temp_name(&name) && !keep.contains(&name))
            || (name.starts_with("concat-t") && name.ends_with(".ffconcat"));
        if stray && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// What ffprobe reports about a recording.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Media {
    pub duration_ms: u64,
    pub video: VideoFormat,
    pub audio: bool,
}
/// The video stream properties a stream copy must keep identical.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VideoFormat {
    pub codec: String,
    pub profile: String,
    pub width: u64,
    pub height: u64,
    pub pix_fmt: String,
    pub frame_rate: String,
    /// Codec configuration (SPS/PPS) as ffprobe prints it.
    pub extradata: String,
}
impl VideoFormat {
    fn compatible(&self, other: &Self) -> bool {
        self.codec == other.codec
            && self.width == other.width
            && self.height == other.height
            && self.pix_fmt == other.pix_fmt
            && self.frame_rate == other.frame_rate
    }
}
fn parse_probe(value: &Value) -> Result<Media, String> {
    let seconds = value["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or("The recording has no valid duration.")?;
    let streams = value["streams"]
        .as_array()
        .ok_or("The recording has no streams.")?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or("The recording has no video stream.")?;
    let text = |key: &str| video[key].as_str().unwrap_or("").to_owned();
    Ok(Media {
        duration_ms: (seconds * 1000.0).round() as u64,
        video: VideoFormat {
            codec: text("codec_name"),
            profile: text("profile"),
            width: video["width"].as_u64().unwrap_or(0),
            height: video["height"].as_u64().unwrap_or(0),
            pix_fmt: text("pix_fmt"),
            frame_rate: text("r_frame_rate"),
            extradata: text("extradata").split_whitespace().collect(),
        },
        audio: streams.iter().any(|stream| stream["codec_type"] == "audio"),
    })
}
/// Probes a recording's duration, video format and audio presence.
pub fn probe(path: &Path) -> Result<Media, String> {
    let output = deps::command("ffprobe")?
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,profile,width,height,pix_fmt,r_frame_rate,extradata:format=duration",
            "-show_data",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{} could not be read: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let media = parse_probe(&value)?;
    if media.video.width == 0 || media.video.height == 0 {
        return Err(format!("{} has no usable video frames.", path.display()));
    }
    Ok(media)
}

/// How closely durations must agree, in ms, for a take of `take_ms`.
pub fn tolerance_ms(take_ms: u64) -> u64 {
    (take_ms / 3).clamp(2, MAX_TOLERANCE_MS)
}
/// Whether the combined video already contains a take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapState {
    /// `video.mp4` lasts as long as the takes before plus this take.
    Applied,
    /// `video.mp4` still lasts as long as the takes before.
    Pending,
    /// Neither: something else changed the file.
    Unknown,
}
pub fn swap_state(root_ms: u64, offset_ms: u64, take_ms: u64) -> SwapState {
    let tolerance = tolerance_ms(take_ms);
    let to_total = root_ms.abs_diff(offset_ms.saturating_add(take_ms));
    let to_base = root_ms.abs_diff(offset_ms);
    if to_total <= tolerance && to_total < to_base {
        SwapState::Applied
    } else if to_base <= tolerance && to_base < to_total {
        SwapState::Pending
    } else {
        SwapState::Unknown
    }
}

/// Seconds with millisecond precision, as ffconcat directives take them.
fn seconds(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}
/// A relative path with `/` separators. ffconcat reads `\` as an escape
/// character, so Windows separators would corrupt the path.
fn portable_relative(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(
                part.to_str()
                    .ok_or("Media paths must be valid Unicode.")?
                    .to_owned(),
            ),
            Component::CurDir => (),
            _ => return Err(format!("{} is not a relative media path.", path.display())),
        }
    }
    if parts.is_empty() {
        return Err("Empty media path.".into());
    }
    Ok(parts.join("/"))
}
/// Quotes a value for an ffconcat `file` line. Inside single quotes only the
/// quote itself needs escaping.
fn ffconcat_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}
/// An ffconcat script listing `files` (relative to the script) with their
/// durations, so each file starts exactly where the previous one ends.
pub fn ffconcat_list(files: &[(&Path, u64)]) -> Result<String, String> {
    let mut list = String::from("ffconcat version 1.0\n");
    for (path, duration_ms) in files {
        list.push_str(&format!(
            "file {}\nduration {}\n",
            ffconcat_quote(&portable_relative(path)?),
            seconds(*duration_ms)
        ));
    }
    Ok(list)
}

/// Why replacing `video.mp4` failed.
#[derive(Debug)]
pub enum ReplaceError {
    /// Another program kept the file open through every retry.
    InUse(io::Error),
    Failed(io::Error),
}
/// Windows refuses to replace a file that a player or reader holds open.
fn is_in_use(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || (cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33)))
}
/// Renames `from` over `to`, waiting `backoff_ms[i]` after the i-th refusal
/// because the target is in use. Other errors fail at once.
pub fn replace_with_retry(
    from: &Path,
    to: &Path,
    backoff_ms: &[u64],
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
    mut sleep: impl FnMut(Duration),
) -> Result<(), ReplaceError> {
    let mut waits = backoff_ms.iter();
    loop {
        match rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if is_in_use(&error) => match waits.next() {
                Some(ms) => sleep(Duration::from_millis(*ms)),
                None => return Err(ReplaceError::InUse(error)),
            },
            Err(error) => return Err(ReplaceError::Failed(error)),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingSwap {
    /// File name of the validated combined video in the session folder.
    temp: String,
    expected_ms: u64,
    bytes: u64,
}
fn read_pending(dir: &Path, index: u32) -> Option<PendingSwap> {
    let marker = take_dir(dir, index).join(PENDING_SWAP);
    if !marker.is_file() {
        return None;
    }
    read_json::<PendingSwap>(&marker)
        .ok()
        .filter(|pending| is_temp_name(&pending.temp))
}
fn clear_pending(dir: &Path, index: u32) {
    if index >= 2 {
        let _ = fs::remove_file(take_dir(dir, index).join(PENDING_SWAP));
    }
}
/// A combined video left by an attempt whose replace was refused, if it is
/// still intact. Anything else it names is removed.
fn pending_temp(dir: &Path, take: &Take, probe: Probe<'_>) -> Option<PathBuf> {
    let pending = read_pending(dir, take.index)?;
    let path = dir.join(&pending.temp);
    let intact = path
        .metadata()
        .is_ok_and(|meta| meta.len() == pending.bytes)
        && pending.expected_ms == take.offset_ms + take.duration_ms
        && probe(&path).is_ok_and(|media| {
            swap_state(media.duration_ms, take.offset_ms, take.duration_ms) == SwapState::Applied
        });
    if intact {
        return Some(path);
    }
    let _ = fs::remove_file(&path);
    clear_pending(dir, take.index);
    None
}
/// After a verified swap only the take's lossless audio tracks remain.
fn remove_take_video(dir: &Path, index: u32) {
    if index < 2 {
        return;
    }
    let folder = take_dir(dir, index);
    for name in [TAKE_VIDEO, NORMALIZED_VIDEO] {
        let _ = fs::remove_file(folder.join(name));
    }
    clear_pending(dir, index);
}
/// Makes the combined video contain `take`. Returns its new duration, or
/// `None` when `rebuild` is false and no validated combined file is waiting.
fn swap_media(
    dir: &Path,
    take: &Take,
    backoff_ms: &[u64],
    rebuild: bool,
    probe: Probe<'_>,
) -> Result<Option<u64>, String> {
    let root = dir.join(ROOT_VIDEO);
    let current = probe(&root)?;
    let expected = take.offset_ms + take.duration_ms;
    match swap_state(current.duration_ms, take.offset_ms, take.duration_ms) {
        SwapState::Applied => {
            // A previous attempt replaced the file; only bookkeeping was left.
            remove_take_video(dir, take.index);
            return Ok(Some(current.duration_ms));
        }
        SwapState::Unknown => {
            return Err(format!(
                "video.mp4 lasts {} ms, which matches neither the recording before take {} ({} ms) nor the recording with it ({expected} ms). The take's files are kept in takes/{}.",
                current.duration_ms, take.index, take.offset_ms, take.index
            ))
        }
        SwapState::Pending => (),
    }
    let temp = match pending_temp(dir, take, probe) {
        Some(temp) => temp,
        None if rebuild => build(dir, take, &current, probe)?,
        None => return Ok(None),
    };
    match replace_with_retry(
        &temp,
        &root,
        backoff_ms,
        |from, to| fs::rename(from, to),
        std::thread::sleep,
    ) {
        Ok(()) => (),
        Err(ReplaceError::InUse(error)) => {
            let bytes = temp.metadata().map(|meta| meta.len()).unwrap_or(0);
            let name = temp
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            let _ = write_json(
                &take_dir(dir, take.index).join(PENDING_SWAP),
                &PendingSwap {
                    temp: name,
                    expected_ms: expected,
                    bytes,
                },
            );
            return Err(format!(
                "Take {} is saved, but video.mp4 is in use by another program ({error}), so it could not be updated yet. Close any player or command using it and choose Retry; CueReview also finishes this the next time it starts.",
                take.index
            ));
        }
        Err(ReplaceError::Failed(error)) => {
            let _ = fs::remove_file(&temp);
            clear_pending(dir, take.index);
            return Err(format!(
                "Take {} could not be added to video.mp4: {error}",
                take.index
            ));
        }
    }
    let combined = probe(&root)?;
    if swap_state(combined.duration_ms, take.offset_ms, take.duration_ms) != SwapState::Applied {
        return Err(format!(
            "After adding take {}, video.mp4 lasts {} ms instead of {expected} ms.",
            take.index, combined.duration_ms
        ));
    }
    remove_take_video(dir, take.index);
    Ok(Some(combined.duration_ms))
}
fn run_ffmpeg(mut command: Command, log: &Path, what: &str) -> Result<(), String> {
    let file = fs::File::create(log).map_err(|e| e.to_string())?;
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(file)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        let detail = fs::read_to_string(log).unwrap_or_default();
        let tail: String = detail
            .chars()
            .rev()
            .take(1200)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("{what} failed ({status}): {}", tail.trim()));
    }
    Ok(())
}
/// How a take of another size is placed in the combined video's frame:
/// scaled uniformly to fit, then centered with padding.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    /// Uniform factor from take pixels to combined-video pixels. Exact along
    /// the limiting axis; the other axis rounds to an even size (under 2 px).
    pub scale: f64,
    pub width: u64,
    pub height: u64,
    pub pad_x: u64,
    pub pad_y: u64,
}
/// Fits a `width`×`height` take into a `base_width`×`base_height` frame. Sizes
/// and offsets stay even, as 4:2:0 video requires.
pub fn fit(width: u64, height: u64, base_width: u64, base_height: u64) -> Fit {
    let (width, height) = (width.max(1), height.max(1));
    let scale = (base_width as f64 / width as f64).min(base_height as f64 / height as f64);
    let even = |value: f64, limit: u64| (((value / 2.0).round() as u64) * 2).clamp(2, limit.max(2));
    let fitted_width = even(width as f64 * scale, base_width);
    let fitted_height = even(height as f64 * scale, base_height);
    Fit {
        scale,
        width: fitted_width,
        height: fitted_height,
        pad_x: (base_width.saturating_sub(fitted_width) / 2) & !1,
        pad_y: (base_height.saturating_sub(fitted_height) / 2) & !1,
    }
}
/// Adds `"normalize": {"scale", "padX", "padY", "baseWidth", "baseHeight"}`
/// to a take's `capture-timing.json`, so cursor positions recorded in take
/// pixels can be mapped onto the combined video. Existing bytes, including an
/// earlier `normalize` entry, are kept as they are; the file is created when
/// the capture wrote none.
pub fn record_normalization(
    timing: &Path,
    fit: &Fit,
    base_width: u64,
    base_height: u64,
) -> Result<(), String> {
    let entry = serde_json::json!({
        "scale": fit.scale,
        "padX": fit.pad_x,
        "padY": fit.pad_y,
        "baseWidth": base_width,
        "baseHeight": base_height,
    });
    let entry = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let text = if timing.is_file() {
        let existing =
            fs::read_to_string(timing).map_err(|e| format!("Read {}: {e}", timing.display()))?;
        let parsed: Value = serde_json::from_str(&existing)
            .map_err(|e| format!("Invalid {}: {e}", timing.display()))?;
        let object = parsed
            .as_object()
            .ok_or_else(|| format!("{} is not a JSON object.", timing.display()))?;
        if object.contains_key("normalize") {
            return Ok(());
        }
        // Insert textually before the closing brace so every existing key
        // keeps its exact bytes and order.
        let end = existing.rfind('}').ok_or("Unterminated capture timing.")?;
        let separator = if object.is_empty() { "" } else { "," };
        let head = existing[..end].trim_end();
        format!(
            "{head}{separator}\n  \"normalize\": {entry}\n}}{}",
            &existing[end + 1..]
        )
    } else {
        format!("{{\n  \"normalize\": {entry}\n}}")
    };
    serde_json::from_str::<Value>(&text)
        .map_err(|e| format!("Could not extend {}: {e}", timing.display()))?;
    crate::store::atomic_write(timing, text.as_bytes())
}
/// Re-encodes a take to the combined video's size (scaled to fit, padded),
/// frame rate and pixel format, with the capture pipeline's encoder settings.
fn normalize(
    source: &Path,
    target: &Path,
    base: &VideoFormat,
    fit: &Fit,
    log: &Path,
) -> Result<(), String> {
    let filter = format!(
        "scale={}:{},pad={}:{}:{}:{},setsar=1",
        fit.width, fit.height, base.width, base.height, fit.pad_x, fit.pad_y
    );
    let mut ffmpeg = deps::command("ffmpeg")?;
    ffmpeg
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args(["-map", "0:v:0", "-map", "0:a:0", "-vf", &filter])
        .args(["-r", &base.frame_rate, "-pix_fmt", &base.pix_fmt])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
        ])
        .arg(target);
    run_ffmpeg(ffmpeg, log, "Resizing the take")
}
/// Counts decoded frames around `boundary_ms` in ffprobe's
/// `media_type,best_effort_timestamp_time` CSV: video before, video after
/// and audio after the boundary.
fn boundary_frames(csv: &str, boundary_ms: u64) -> (usize, usize, usize) {
    let boundary = boundary_ms as f64 / 1000.0 - 0.0005;
    let mut counts = (0, 0, 0);
    for line in csv.lines() {
        let mut fields = line.trim().trim_end_matches(',').split(',');
        let (Some(kind), Some(time)) = (fields.next(), fields.next()) else {
            continue;
        };
        let Ok(time) = time.trim().parse::<f64>() else {
            continue;
        };
        match (kind.trim(), time < boundary) {
            ("video", true) => counts.0 += 1,
            ("video", false) => counts.1 += 1,
            ("audio", false) => counts.2 += 1,
            _ => (),
        }
    }
    counts
}
/// Decodes about a second on each side of the boundary between the earlier
/// takes and the new one; both sides must decode without errors.
fn verify_boundary(path: &Path, boundary_ms: u64, take_ms: u64) -> Result<(), String> {
    let start = boundary_ms.saturating_sub(1000);
    let end = boundary_ms + take_ms.clamp(1, 1000);
    let output = deps::command("ffprobe")?
        .args([
            "-v",
            "error",
            "-read_intervals",
            &format!("{}%{}", seconds(start), seconds(end)),
            "-show_entries",
            "frame=media_type,best_effort_timestamp_time",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    let errors = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() || !errors.trim().is_empty() {
        return Err(format!(
            "The combined recording does not decode cleanly where the take starts: {}",
            errors.trim()
        ));
    }
    let (before, after, audio) =
        boundary_frames(&String::from_utf8_lossy(&output.stdout), boundary_ms);
    if before == 0 || after == 0 || audio == 0 {
        return Err("The combined recording is missing frames where the take starts.".into());
    }
    Ok(())
}
/// Writes and validates `video.<uuid>.tmp.mp4`: the combined video followed
/// by the take, with the take starting at exactly its offset.
fn build(dir: &Path, take: &Take, base: &Media, probe: Probe<'_>) -> Result<PathBuf, String> {
    let index = take.index;
    let folder = take_dir(dir, index);
    let log = folder.join(SWAP_LOG);
    let own = probe(&folder.join(TAKE_VIDEO))
        .map_err(|e| format!("Take {index}'s own video is unavailable: {e}"))?;
    if !base.audio || !own.audio {
        return Err(format!(
            "Take {index} or the recording before it has no audio track."
        ));
    }
    let source = if own.video == base.video {
        TAKE_VIDEO
    } else {
        // A copied stream must keep the first file's size and codec setup.
        let placed = fit(
            own.video.width,
            own.video.height,
            base.video.width,
            base.video.height,
        );
        normalize(
            &folder.join(TAKE_VIDEO),
            &folder.join(NORMALIZED_VIDEO),
            &base.video,
            &placed,
            &log,
        )?;
        record_normalization(
            &folder.join("capture-timing.json"),
            &placed,
            base.video.width,
            base.video.height,
        )?;
        let normalized = probe(&folder.join(NORMALIZED_VIDEO))?;
        if !normalized.video.compatible(&base.video) || !normalized.audio {
            return Err(format!(
                "Take {index} could not be matched to the recording's video format."
            ));
        }
        NORMALIZED_VIDEO
    };
    let take_source = Path::new("takes").join(index.to_string()).join(source);
    let list = ffconcat_list(&[
        (Path::new(ROOT_VIDEO), take.offset_ms),
        (&take_source, take.duration_ms),
    ])?;
    let list_path = dir.join(format!("concat-t{index}.ffconcat"));
    fs::write(&list_path, list).map_err(|e| e.to_string())?;
    let temp = dir.join(format!("video.{}.tmp.mp4", uuid::Uuid::new_v4()));
    let mut ffmpeg = deps::command("ffmpeg")?;
    // -copyts keeps the first file's timestamps. Without it the AAC priming
    // packet's negative start shifts the whole timeline by about 21 ms.
    ffmpeg
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-copyts",
            "-f",
            "concat",
            "-i",
        ])
        .arg(&list_path)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-ac",
            "1",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
        ])
        .arg(&temp);
    let result = run_ffmpeg(ffmpeg, &log, "Adding the take to the recording").and_then(|()| {
        let combined = probe(&temp)?;
        if !combined.audio
            || swap_state(combined.duration_ms, take.offset_ms, take.duration_ms)
                != SwapState::Applied
        {
            return Err(format!(
                "The combined recording lasts {} ms instead of {} ms.",
                combined.duration_ms,
                take.offset_ms + take.duration_ms
            ));
        }
        verify_boundary(&temp, take.offset_ms, take.duration_ms)
    });
    let _ = fs::remove_file(&list_path);
    match result {
        Ok(()) => Ok(temp),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CaptureConfig, Word};

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        (dir, store)
    }
    fn config() -> CaptureConfig {
        CaptureConfig {
            source_id: "monitor:1".into(),
            microphone_id: Some("mic:Studio".into()),
            system_audio: false,
            fps: 30,
        }
    }
    /// A ready single-take session whose fake root video lasts `duration_ms`.
    fn ready(store: &Store, duration_ms: u64) -> Session {
        let mut session = store
            .create_session(None, Some("Review"), &config())
            .unwrap();
        session.status = "ready".into();
        session.duration_ms = duration_ms;
        store.save_session(&session).unwrap();
        let dir = store.session_dir(&session.id).unwrap();
        fs::write(dir.join(ROOT_VIDEO), duration_ms.to_string()).unwrap();
        session
    }
    /// Stands in for ffprobe: a fake media file holds its duration in ms.
    fn fake_probe(path: &Path) -> Result<Media, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        Ok(Media {
            duration_ms: text.trim().parse().map_err(|_| "not media".to_string())?,
            video: VideoFormat::default(),
            audio: true,
        })
    }
    fn take(index: u32, offset_ms: u64, duration_ms: u64, status: TakeStatus) -> Take {
        Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: folder_label(index),
            source_id: None,
            microphone_id: Some("mic:Studio".into()),
            system_audio: false,
        }
    }
    fn segment(id: &str, start_ms: u64, end_ms: u64) -> Segment {
        Segment {
            id: id.into(),
            start_ms,
            end_ms,
            text: id.into(),
            words: vec![Word {
                text: id.into(),
                start_ms,
                end_ms,
                seek_ms: Some(start_ms + 10),
            }],
        }
    }
    fn ids(transcript: &Transcript) -> Vec<&str> {
        transcript.segments.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn segment_ids_name_their_take() {
        assert_eq!(segment_prefix(1), "");
        assert_eq!(segment_prefix(2), "t2-");
        assert_eq!(segment_prefix(12), "t12-");
        for (id, take) in [
            ("segment-0", 1),
            ("t2-segment-0", 2),
            ("t12-segment-3", 12),
            ("t2-live-80000-0", 2),
            ("t1-segment-0", 1),
            ("t-segment", 1),
            ("t+2-segment", 1),
            ("tx-segment", 1),
            ("t2segment", 1),
            ("", 1),
        ] {
            assert_eq!(segment_take(id), take, "{id}");
        }
    }

    #[test]
    fn merge_shifts_prefixes_and_replaces_only_that_take() {
        let existing = Transcript {
            segments: vec![
                segment("segment-0", 100, 900),
                segment("t2-segment-0", 2100, 2500),
                segment("t3-segment-0", 4200, 4400),
            ],
            language: Some("en".into()),
            status: Some("complete".into()),
            error: None,
            takes: Vec::new(),
        };
        let update = Transcript {
            segments: vec![
                segment("segment-0", 50, 400),
                segment("segment-1", 500, 900),
            ],
            language: Some("de".into()),
            status: Some("complete".into()),
            ..Default::default()
        };
        let marks = vec![
            TakeMark {
                index: 1,
                start_ms: 0,
            },
            TakeMark {
                index: 2,
                start_ms: 2000,
            },
            TakeMark {
                index: 3,
                start_ms: 4000,
            },
        ];
        let merged = merge_take(&existing, update, 2, 2000, marks.clone());
        assert_eq!(
            ids(&merged),
            ["segment-0", "t2-segment-0", "t2-segment-1", "t3-segment-0"]
        );
        let shifted = &merged.segments[1];
        assert_eq!((shifted.start_ms, shifted.end_ms), (2050, 2400));
        let word = &shifted.words[0];
        assert_eq!(
            (word.start_ms, word.end_ms, word.seek_ms),
            (2050, 2400, Some(2060))
        );
        assert_eq!(merged.segments[2].start_ms, 2500);
        // Other takes keep their exact timing; the session keeps its language.
        assert_eq!(merged.segments[0].start_ms, 100);
        assert_eq!(merged.segments[3].start_ms, 4200);
        assert_eq!(merged.language.as_deref(), Some("en"));
        assert_eq!(merged.status.as_deref(), Some("complete"));
        assert_eq!(merged.takes, marks);

        // Re-transcribing take 1 keeps it first and unprefixed.
        let again = merge_take(
            &merged,
            Transcript {
                segments: vec![segment("segment-0", 300, 600)],
                ..Default::default()
            },
            1,
            0,
            marks,
        );
        assert_eq!(
            ids(&again),
            ["segment-0", "t2-segment-0", "t2-segment-1", "t3-segment-0"]
        );
        assert_eq!(again.segments[0].start_ms, 300);

        // A silent take removes only its own earlier segments.
        let silent = merge_take(&again, Transcript::default(), 3, 4000, Vec::new());
        assert_eq!(ids(&silent), ["segment-0", "t2-segment-0", "t2-segment-1"]);
        let empty = merge_take(
            &Transcript::default(),
            Transcript::default(),
            2,
            10,
            Vec::new(),
        );
        assert!(empty.segments.is_empty() && empty.language.is_none());
    }

    #[test]
    fn listing_synthesizes_take_one_and_marks_only_the_timeline() {
        let (_dir, store) = store();
        let mut session = ready(&store, 80000);
        let legacy = list(&session);
        assert_eq!(legacy.len(), 1);
        assert_eq!(
            legacy[0],
            Take {
                index: 1,
                offset_ms: 0,
                duration_ms: 80000,
                status: TakeStatus::Ready,
                folder: ".".into(),
                source_id: None,
                microphone_id: Some("mic:Studio".into()),
                system_audio: false,
            }
        );
        assert!(marks(&legacy).is_empty());
        for (status, take) in [
            ("recording", TakeStatus::Recording),
            ("processing", TakeStatus::Transcribing),
            ("error", TakeStatus::Error),
        ] {
            session.status = status.into();
            assert_eq!(list(&session)[0].status, take);
        }
        // Take 1 stays implicit when only later takes are stored.
        session.status = "ready".into();
        session.duration_ms = 134000;
        session.takes = vec![
            take(3, 134000, 2000, TakeStatus::Recording),
            take(2, 80000, 54000, TakeStatus::Ready),
        ];
        let listed = list(&session);
        assert_eq!(
            listed
                .iter()
                .map(|t| (t.index, t.duration_ms))
                .collect::<Vec<_>>(),
            [(1, 80000), (2, 54000), (3, 2000)]
        );
        assert_eq!(
            marks(&listed),
            [
                TakeMark {
                    index: 1,
                    start_ms: 0
                },
                TakeMark {
                    index: 2,
                    start_ms: 80000
                }
            ]
        );
        for status in [
            TakeStatus::Interrupted,
            TakeStatus::Swapping,
            TakeStatus::Finalizing,
        ] {
            session.takes = vec![take(2, 80000, 54000, status)];
            assert!(marks(&list(&session)).is_empty(), "{status:?}");
        }
        for status in [
            TakeStatus::Transcribing,
            TakeStatus::Ready,
            TakeStatus::Error,
        ] {
            session.takes = vec![take(2, 80000, 54000, status)];
            assert_eq!(marks(&list(&session)).len(), 2, "{status:?}");
        }
    }

    #[test]
    fn record_more_starts_a_take_and_restores_the_session_on_failure() {
        let (_dir, store) = store();
        let session = ready(&store, 80000);
        let dir = store.session_dir(&session.id).unwrap();
        let started = begin(&store, &session.id, 80000, None, true).unwrap();
        assert_eq!(started.take, {
            let mut expected = take(2, 80000, 0, TakeStatus::Recording);
            expected.microphone_id = None;
            expected.system_audio = true;
            expected
        });
        let saved = store.session(&session.id).unwrap();
        assert_eq!(saved.status, "recording");
        assert_eq!(saved.source_id, "monitor:1");
        assert_eq!(saved.takes.len(), 2);
        assert_eq!(saved.takes[0], take(1, 0, 80000, TakeStatus::Ready));
        assert_eq!(saved.video_path.as_deref(), dir.join(ROOT_VIDEO).to_str());
        assert!(take_dir(&dir, 2).is_dir());
        assert!(begin(&store, &session.id, 80000, None, false)
            .unwrap_err()
            .contains("Finish recording"));
        abandon(&store, &session.id, started).unwrap();
        let restored = store.session(&session.id).unwrap();
        assert_eq!(restored.status, "ready");
        assert!(restored.takes.is_empty());
        assert!(!take_dir(&dir, 2).exists());
        assert!(dir.join(ROOT_VIDEO).is_file());

        // A folder left by an attempt that never saved is skipped, not reused.
        fs::create_dir_all(take_dir(&dir, 2)).unwrap();
        fs::write(take_dir(&dir, 2).join("mic.wav"), b"orphan").unwrap();
        let started = begin(&store, &session.id, 80000, None, false).unwrap();
        assert_eq!(started.take.index, 3);
        assert_eq!(
            fs::read(take_dir(&dir, 2).join("mic.wav")).unwrap(),
            b"orphan"
        );
    }

    #[test]
    fn record_more_requires_finished_takes() {
        let (_dir, store) = store();
        let mut session = ready(&store, 2000);
        assert!(check_can_record_more(&session).is_ok());
        session.status = "error".into();
        assert!(check_can_record_more(&session).is_ok());
        for status in ["recording", "processing"] {
            session.status = status.into();
            assert!(check_can_record_more(&session).is_err());
        }
        session.status = "error".into();
        for (status, allowed) in [
            (TakeStatus::Ready, true),
            (TakeStatus::Error, true),
            (TakeStatus::Interrupted, true),
            (TakeStatus::Recording, false),
            (TakeStatus::Finalizing, false),
            (TakeStatus::Swapping, false),
            (TakeStatus::Transcribing, false),
        ] {
            session.takes = vec![
                take(1, 0, 2000, TakeStatus::Ready),
                take(2, 2000, 1000, status),
            ];
            assert_eq!(
                check_can_record_more(&session).is_ok(),
                allowed,
                "{status:?}"
            );
        }
        // A first recording in error makes take 1 an error take, for Retry.
        session.takes.clear();
        store.save_session(&session).unwrap();
        let started = begin(&store, &session.id, 2000, None, false).unwrap();
        assert_eq!(started.session.takes[0].status, TakeStatus::Error);
    }

    #[test]
    fn stopping_a_take_moves_it_to_swapping_or_interrupted() {
        let (_dir, store) = store();
        let session = ready(&store, 2000);
        let id = session.id.as_str();
        let dir = store.session_dir(id).unwrap();
        begin(&store, id, 2000, Some("mic:Studio".into()), false).unwrap();
        let finalizing = mark_finalizing(&store, id, 2, 1480).unwrap();
        assert_eq!(finalizing.status, "processing");
        assert_eq!(finalizing.takes[1].status, TakeStatus::Finalizing);
        assert_eq!(finalizing.takes[1].duration_ms, 1480);

        // Clean stop: the probed take duration wins over the wall clock.
        fs::write(take_dir(&dir, 2).join(TAKE_VIDEO), "1500").unwrap();
        let stopped = finish_capture_with(&store, id, 2, Ok(()), &fake_probe).unwrap();
        assert_eq!(stopped.status, "processing");
        assert_eq!(stopped.takes[1].status, TakeStatus::Swapping);
        assert_eq!(stopped.takes[1].duration_ms, 1500);

        // A capture error with a usable take video waits for Retry.
        let error = finish_capture_with(&store, id, 2, Err("Source closed".into()), &fake_probe)
            .unwrap_err();
        assert_eq!(error, "Source closed");
        let saved = store.session(id).unwrap();
        assert_eq!(saved.status, "error");
        assert_eq!(saved.error.as_deref(), Some("Source closed"));
        assert_eq!(saved.takes[1].status, TakeStatus::Swapping);
        assert_eq!(retry_plan(&saved), [2]);

        // No usable take video: interrupted, earlier takes intact, raw tracks kept.
        fs::remove_file(take_dir(&dir, 2).join(TAKE_VIDEO)).unwrap();
        fs::write(take_dir(&dir, 2).join("mic.wav"), b"raw").unwrap();
        let error = finish_capture_with(&store, id, 2, Ok(()), &fake_probe).unwrap_err();
        assert!(error.contains("Take 2 could not be saved"), "{error}");
        let saved = store.session(id).unwrap();
        assert_eq!(saved.status, "ready");
        assert!(saved.error.is_none());
        assert_eq!(saved.takes[0].status, TakeStatus::Ready);
        assert_eq!(saved.takes[1].status, TakeStatus::Interrupted);
        assert_eq!(fs::read(take_dir(&dir, 2).join("mic.wav")).unwrap(), b"raw");
        assert_eq!(fs::read_to_string(dir.join(ROOT_VIDEO)).unwrap(), "2000");
    }

    #[test]
    fn settling_reports_the_first_unfinished_take() {
        let (_dir, store) = store();
        let mut session = ready(&store, 2000);
        session.status = "processing".into();
        session.takes = vec![
            take(1, 0, 2000, TakeStatus::Ready),
            take(2, 2000, 1000, TakeStatus::Ready),
            take(3, 3000, 500, TakeStatus::Interrupted),
        ];
        settle(&mut session, None);
        assert_eq!(
            (session.status.as_str(), session.error.as_deref()),
            ("ready", None)
        );
        assert_eq!(retry_plan(&session), [1, 2]);
        settle(&mut session, Some("Model missing".into()));
        assert_eq!(
            (session.status.as_str(), session.error.as_deref()),
            ("error", Some("Model missing"))
        );
        session.takes[0].status = TakeStatus::Error;
        settle(&mut session, None);
        assert_eq!(session.status, "error");
        assert!(session
            .error
            .as_deref()
            .unwrap()
            .contains("Take 1 has no transcript"));
        assert_eq!(retry_plan(&session), [1]);
        session.takes[0].status = TakeStatus::Ready;
        session.takes[1].status = TakeStatus::Swapping;
        settle(&mut session, None);
        assert!(session
            .error
            .as_deref()
            .unwrap()
            .contains("Take 2 is saved"));
        assert_eq!(retry_plan(&session), [2]);
    }

    #[test]
    fn swap_state_compares_the_combined_duration() {
        for (root, state) in [
            (3500, SwapState::Applied),
            (3600, SwapState::Applied),
            (3400, SwapState::Applied),
            (2000, SwapState::Pending),
            (2001, SwapState::Pending),
            (2150, SwapState::Pending),
            (2700, SwapState::Unknown),
            (3700, SwapState::Unknown),
            (0, SwapState::Unknown),
        ] {
            assert_eq!(swap_state(root, 2000, 1500), state, "{root}");
        }
        // Very short takes tighten the tolerance so the two cases never meet.
        assert_eq!(tolerance_ms(30), 10);
        assert_eq!(swap_state(2030, 2000, 30), SwapState::Applied);
        assert_eq!(swap_state(2000, 2000, 30), SwapState::Pending);
        assert_eq!(swap_state(2015, 2000, 30), SwapState::Unknown);
        assert_eq!(swap_state(2000, 2000, 0), SwapState::Unknown);
        assert_eq!(tolerance_ms(60_000), 150);
    }

    #[test]
    fn ffconcat_scripts_use_forward_slashes_and_escape_quotes() {
        let take = Path::new("takes").join("2").join("video.mp4");
        assert_eq!(
            ffconcat_list(&[(Path::new("video.mp4"), 80000), (&take, 54321)]).unwrap(),
            "ffconcat version 1.0\nfile 'video.mp4'\nduration 80.000\nfile 'takes/2/video.mp4'\nduration 54.321\n"
        );
        assert_eq!(
            ffconcat_list(&[(Path::new("./it's here.mp4"), 5)]).unwrap(),
            "ffconcat version 1.0\nfile 'it'\\''s here.mp4'\nduration 0.005\n"
        );
        assert_eq!(ffconcat_quote(r"a\b"), r"'a\b'");
        assert!(ffconcat_list(&[(Path::new("../video.mp4"), 1)]).is_err());
        assert!(ffconcat_list(&[(&std::env::temp_dir().join("video.mp4"), 1)]).is_err());
        assert!(ffconcat_list(&[(Path::new(""), 1)]).is_err());
        assert_eq!(seconds(0), "0.000");
        assert_eq!(seconds(3_723_045), "3723.045");
    }

    #[test]
    fn a_take_of_another_size_is_fitted_and_centered() {
        assert_eq!(
            fit(256, 256, 320, 240),
            Fit {
                scale: 0.9375,
                width: 240,
                height: 240,
                pad_x: 40,
                pad_y: 0
            }
        );
        let wide = fit(3840, 1080, 1920, 1080);
        assert_eq!((wide.scale, wide.width, wide.height), (0.5, 1920, 540));
        assert_eq!((wide.pad_x, wide.pad_y), (0, 270));
        // Odd results round to even sizes and offsets.
        let odd = fit(1001, 999, 1280, 720);
        assert_eq!(
            (odd.width % 2, odd.height % 2, odd.pad_x % 2, odd.pad_y % 2),
            (0, 0, 0, 0)
        );
        assert!(odd.width <= 1280 && odd.height == 720);
        assert!((odd.width as f64 - 1001.0 * odd.scale).abs() < 2.0);
        let same = fit(1920, 1080, 1920, 1080);
        assert_eq!((same.scale, same.pad_x, same.pad_y), (1.0, 0, 0));
        let upscaled = fit(640, 360, 1920, 1080);
        assert_eq!(
            (upscaled.scale, upscaled.width, upscaled.height),
            (3.0, 1920, 1080)
        );
    }

    #[test]
    fn normalization_is_added_to_capture_timing_without_rewriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let timing = dir.path().join("capture-timing.json");
        let original = "{\n  \"videoHostStartMs\": 41.66666666666667,\n  \"recordingStopMs\": 1500.0,\n  \"canvasWidth\": 256,\n  \"canvasHeight\": 256\n}";
        fs::write(&timing, original).unwrap();
        let placed = fit(256, 256, 320, 240);
        record_normalization(&timing, &placed, 320, 240).unwrap();
        let written = fs::read_to_string(&timing).unwrap();
        let end = original.rfind('}').unwrap();
        assert!(written.starts_with(original[..end].trim_end()), "{written}");
        let value: Value = serde_json::from_str(&written).unwrap();
        assert_eq!(
            value["normalize"],
            serde_json::json!({"scale":0.9375,"padX":40,"padY":0,"baseWidth":320,"baseHeight":240})
        );
        assert_eq!(value["videoHostStartMs"], 41.66666666666667);
        assert_eq!(value["canvasWidth"], 256);
        // Never rewritten once present.
        record_normalization(&timing, &fit(100, 100, 320, 240), 320, 240).unwrap();
        assert_eq!(fs::read_to_string(&timing).unwrap(), written);
        // Created when the capture wrote no timing; an empty object stays valid.
        let missing = dir.path().join("missing.json");
        record_normalization(&missing, &placed, 320, 240).unwrap();
        let created: Value = serde_json::from_str(&fs::read_to_string(&missing).unwrap()).unwrap();
        assert_eq!(created["normalize"]["padX"], 40);
        let empty = dir.path().join("empty.json");
        fs::write(&empty, "{}\n").unwrap();
        record_normalization(&empty, &placed, 320, 240).unwrap();
        let text = fs::read_to_string(&empty).unwrap();
        assert!(text.ends_with("}\n"));
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap()["normalize"]["baseWidth"],
            320
        );
        // Damaged timing is reported, not replaced.
        let damaged = dir.path().join("damaged.json");
        fs::write(&damaged, "[1, 2]").unwrap();
        assert!(record_normalization(&damaged, &placed, 320, 240).is_err());
        assert_eq!(fs::read_to_string(&damaged).unwrap(), "[1, 2]");
    }

    #[test]
    fn replacing_retries_only_while_the_file_is_in_use() {
        let (from, to) = (Path::new("video.tmp.mp4"), Path::new("video.mp4"));
        let busy = || io::Error::from(io::ErrorKind::PermissionDenied);
        let mut calls = 0;
        let mut slept = Vec::new();
        let result = replace_with_retry(
            from,
            to,
            &[10, 20, 30],
            |a, b| {
                assert_eq!((a, b), (from, to));
                calls += 1;
                if calls < 3 {
                    Err(busy())
                } else {
                    Ok(())
                }
            },
            |wait| slept.push(wait),
        );
        assert!(result.is_ok());
        assert_eq!(calls, 3);
        assert_eq!(
            slept,
            [Duration::from_millis(10), Duration::from_millis(20)]
        );

        let mut calls = 0;
        let mut slept = Vec::new();
        let result = replace_with_retry(
            from,
            to,
            &[10, 20, 30],
            |_, _| {
                calls += 1;
                Err(busy())
            },
            |wait| slept.push(wait),
        );
        assert!(matches!(result, Err(ReplaceError::InUse(_))));
        assert_eq!((calls, slept.len()), (4, 3));

        let mut calls = 0;
        let result = replace_with_retry(
            from,
            to,
            &[10],
            |_, _| {
                calls += 1;
                Err(io::Error::from(io::ErrorKind::NotFound))
            },
            |_| panic!("must not wait for a missing file"),
        );
        assert!(matches!(result, Err(ReplaceError::Failed(_))));
        assert_eq!(calls, 1);
        #[cfg(windows)]
        for code in [32, 33] {
            assert!(is_in_use(&io::Error::from_raw_os_error(code)));
        }
        assert!(!is_in_use(&io::Error::from(io::ErrorKind::NotFound)));
    }

    #[cfg(windows)]
    #[test]
    fn a_video_open_without_delete_sharing_counts_as_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (temp, root) = (
            dir.path().join("video.new.tmp.mp4"),
            dir.path().join(ROOT_VIDEO),
        );
        fs::write(&temp, b"combined").unwrap();
        fs::write(&root, b"original").unwrap();
        // Like a media player: read access, readers allowed, no delete sharing.
        let reader = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&root)
            .unwrap();
        let rename = |a: &Path, b: &Path| fs::rename(a, b);
        let result = replace_with_retry(&temp, &root, &[5, 5], rename, std::thread::sleep);
        assert!(matches!(result, Err(ReplaceError::InUse(_))), "{result:?}");
        assert_eq!(fs::read(&root).unwrap(), b"original");
        drop(reader);
        replace_with_retry(&temp, &root, &[5], rename, std::thread::sleep).unwrap();
        assert_eq!(fs::read(&root).unwrap(), b"combined");
        assert!(!temp.exists());
    }

    #[test]
    fn probe_output_and_boundary_frames_parse() {
        let value = serde_json::json!({"streams":[
            {"codec_name":"h264","profile":"High","codec_type":"video","width":320,"height":240,
             "pix_fmt":"yuv420p","r_frame_rate":"30/1","extradata":"\n00000000: 0164 000d  .d..\n"},
            {"codec_name":"aac","codec_type":"audio"}],
            "format":{"duration":"3.500000"}});
        let media = parse_probe(&value).unwrap();
        assert_eq!(media.duration_ms, 3500);
        assert!(media.audio);
        assert_eq!(
            media.video,
            VideoFormat {
                codec: "h264".into(),
                profile: "High".into(),
                width: 320,
                height: 240,
                pix_fmt: "yuv420p".into(),
                frame_rate: "30/1".into(),
                extradata: "00000000:0164000d.d..".into(),
            }
        );
        let mut other = media.video.clone();
        other.extradata.clear();
        assert!(media.video.compatible(&other) && media.video != other);
        other.width = 256;
        assert!(!media.video.compatible(&other));
        assert!(parse_probe(&serde_json::json!({"streams":[],"format":{"duration":"1"}})).is_err());
        assert!(parse_probe(
            &serde_json::json!({"streams":[{"codec_type":"video"}],"format":{"duration":"N/A"}})
        )
        .is_err());

        let csv = "video,1.966667\naudio,1.984000\nvideo,2.000000,\naudio,2.005333\nvideo,N/A\n\n";
        assert_eq!(boundary_frames(csv, 2000), (1, 1, 1));
        assert_eq!(boundary_frames("video,1.5\n", 2000), (1, 0, 0));
    }

    /// One crashed session in a state the recovery matrix covers.
    fn crashed(store: &Store, status: &str, takes: Vec<Take>, root_ms: u64) -> (String, PathBuf) {
        let mut session = ready(store, 2000);
        session.status = status.into();
        session.takes = takes;
        store.save_session(&session).unwrap();
        let dir = store.session_dir(&session.id).unwrap();
        fs::write(dir.join(ROOT_VIDEO), root_ms.to_string()).unwrap();
        for take in &session.takes {
            if take.index >= 2 {
                let folder = take_dir(&dir, take.index);
                fs::create_dir_all(&folder).unwrap();
                fs::write(folder.join(TAKE_VIDEO), take.duration_ms.to_string()).unwrap();
                fs::write(folder.join("audio.wav"), b"lossless").unwrap();
                fs::write(folder.join("mic.wav"), b"lossless").unwrap();
            }
        }
        (session.id, dir)
    }
    fn waiting_file(dir: &Path, temp: &str, content: &str) {
        fs::write(dir.join(temp), content).unwrap();
        write_json(
            &take_dir(dir, 2).join(PENDING_SWAP),
            &PendingSwap {
                temp: temp.into(),
                expected_ms: 3500,
                bytes: 4,
            },
        )
        .unwrap();
    }

    #[test]
    fn recovery_repairs_each_take_state() {
        let (_dir, store) = store();
        let first = || take(1, 0, 2000, TakeStatus::Ready);
        let second = |status| vec![first(), take(2, 2000, 1500, status)];

        // recording → interrupted; the session is ready again with take 1 intact.
        let (recording, dir) = crashed(&store, "recording", second(TakeStatus::Recording), 2000);
        recover_with(&store, &recording, &fake_probe, &[]).unwrap();
        let session = store.session(&recording).unwrap();
        assert_eq!(
            (session.status.as_str(), session.error.as_deref()),
            ("ready", None)
        );
        assert_eq!(session.takes[0], first());
        assert_eq!(session.takes[1].status, TakeStatus::Interrupted);
        assert_eq!(session.duration_ms, 2000);
        assert!(take_dir(&dir, 2).join("mic.wav").is_file());

        // finalizing → interrupted, raw tracks kept.
        let (finalizing, dir) = crashed(&store, "processing", second(TakeStatus::Finalizing), 2000);
        fs::write(take_dir(&dir, 2).join("native-video.mp4"), b"raw").unwrap();
        recover_with(&store, &finalizing, &fake_probe, &[]).unwrap();
        let session = store.session(&finalizing).unwrap();
        assert_eq!(session.status, "ready");
        assert_eq!(session.takes[1].status, TakeStatus::Interrupted);
        for raw in ["native-video.mp4", "mic.wav", "audio.wav", TAKE_VIDEO] {
            assert!(take_dir(&dir, 2).join(raw).is_file(), "{raw}");
        }

        // transcribing → error, and Retry covers only that take.
        let (transcribing, _) =
            crashed(&store, "processing", second(TakeStatus::Transcribing), 3500);
        recover_with(&store, &transcribing, &fake_probe, &[]).unwrap();
        let session = store.session(&transcribing).unwrap();
        assert_eq!(session.status, "error");
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert!(session.error.as_deref().unwrap().contains("Take 2"));
        assert_eq!(retry_plan(&session), [2]);

        // swapping, and video.mp4 already includes the take: bookkeeping only.
        let (swapped, dir) = crashed(&store, "processing", second(TakeStatus::Swapping), 3500);
        recover_with(&store, &swapped, &fake_probe, &[]).unwrap();
        let session = store.session(&swapped).unwrap();
        assert_eq!(session.duration_ms, 3500);
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert_eq!(session.status, "error");
        assert!(!take_dir(&dir, 2).join(TAKE_VIDEO).exists());
        assert!(take_dir(&dir, 2).join("audio.wav").is_file());
        assert_eq!(retry_plan(&session), [2]);

        // swapping with a validated combined file waiting: moved into place now.
        let (waiting, dir) = crashed(&store, "error", second(TakeStatus::Swapping), 2000);
        let temp = "video.5d0c7a3e-waiting.tmp.mp4";
        waiting_file(&dir, temp, "3500");
        let stray = "video.0e1f-stray.tmp.mp4";
        fs::write(dir.join(stray), "9").unwrap();
        fs::write(dir.join("concat-t2.ffconcat"), "ffconcat version 1.0").unwrap();
        recover_with(&store, &waiting, &fake_probe, &[]).unwrap();
        let session = store.session(&waiting).unwrap();
        assert_eq!(fs::read_to_string(dir.join(ROOT_VIDEO)).unwrap(), "3500");
        assert_eq!(session.duration_ms, 3500);
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        for gone in [temp, stray, "concat-t2.ffconcat"] {
            assert!(!dir.join(gone).exists(), "{gone}");
        }
        assert!(!take_dir(&dir, 2).join(PENDING_SWAP).exists());
        assert!(!take_dir(&dir, 2).join(TAKE_VIDEO).exists());

        // swapping without a waiting file: stays swapping for Retry; strays go.
        let (pending, dir) = crashed(&store, "processing", second(TakeStatus::Swapping), 2000);
        fs::write(dir.join(stray), "9").unwrap();
        recover_with(&store, &pending, &fake_probe, &[]).unwrap();
        let session = store.session(&pending).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Swapping);
        assert_eq!(session.status, "error");
        assert!(session
            .error
            .as_deref()
            .unwrap()
            .contains("Retry to finish adding it"));
        assert_eq!(session.duration_ms, 2000);
        assert!(take_dir(&dir, 2).join(TAKE_VIDEO).is_file());
        assert!(!dir.join(stray).exists());

        // A waiting file that no longer matches is discarded, not swapped in.
        let (damaged, dir) = crashed(&store, "error", second(TakeStatus::Swapping), 2000);
        waiting_file(&dir, temp, "35");
        recover_with(&store, &damaged, &fake_probe, &[]).unwrap();
        assert_eq!(fs::read_to_string(dir.join(ROOT_VIDEO)).unwrap(), "2000");
        assert!(!dir.join(temp).exists());
        assert!(!take_dir(&dir, 2).join(PENDING_SWAP).exists());
        let session = store.session(&damaged).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Swapping);

        // swapping, but video.mp4 matches neither duration: nothing is touched.
        let (unknown, dir) = crashed(&store, "processing", second(TakeStatus::Swapping), 2700);
        recover_with(&store, &unknown, &fake_probe, &[]).unwrap();
        let session = store.session(&unknown).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Swapping);
        assert!(take_dir(&dir, 2).join(TAKE_VIDEO).is_file());

        // A settled session with takes is left byte-for-byte alone.
        let (settled, dir) = crashed(
            &store,
            "error",
            vec![
                take(1, 0, 2000, TakeStatus::Error),
                take(2, 2000, 1500, TakeStatus::Ready),
            ],
            3500,
        );
        store
            .update_session(&settled, |s| {
                s.error = Some("Install the local speech model.".into());
                Ok(())
            })
            .unwrap();
        let before = fs::read(dir.join("session.json")).unwrap();
        recover_with(&store, &settled, &fake_probe, &[]).unwrap();
        assert_eq!(fs::read(dir.join("session.json")).unwrap(), before);
    }

    #[test]
    fn store_recovery_routes_sessions_with_takes_and_keeps_legacy_behavior() {
        let (_dir, store) = store();
        let legacy = ready(&store, 2000);
        let mut interrupted = store.create_session(None, None, &config()).unwrap();
        interrupted.status = "processing".into();
        store.save_session(&interrupted).unwrap();
        let (with_takes, _) = crashed(
            &store,
            "recording",
            vec![
                take(1, 0, 2000, TakeStatus::Ready),
                take(2, 2000, 0, TakeStatus::Recording),
            ],
            2000,
        );
        let legacy_file = store.session_dir(&legacy.id).unwrap().join("session.json");
        let legacy_bytes = fs::read(&legacy_file).unwrap();
        store.recover_interrupted().unwrap();
        assert_eq!(fs::read(&legacy_file).unwrap(), legacy_bytes);
        let interrupted = store.session(&interrupted.id).unwrap();
        assert_eq!(interrupted.status, "error");
        assert!(interrupted.error.unwrap().contains("The app closed"));
        assert!(interrupted.takes.is_empty());
        let with_takes = store.session(&with_takes).unwrap();
        assert_eq!(with_takes.status, "ready");
        assert_eq!(with_takes.takes[1].status, TakeStatus::Interrupted);
    }

    #[test]
    fn swapping_media_finishes_only_with_a_verified_combined_file() {
        let (_dir, store) = store();
        let (id, dir) = crashed(
            &store,
            "processing",
            vec![
                take(1, 0, 2000, TakeStatus::Ready),
                take(2, 2000, 1500, TakeStatus::Swapping),
            ],
            2000,
        );
        let swapping = store.session(&id).unwrap().takes[1].clone();
        // Without rebuilding, nothing is waiting yet.
        assert_eq!(
            swap_media(&dir, &swapping, &[], false, &fake_probe).unwrap(),
            None
        );
        assert!(take_dir(&dir, 2).join(TAKE_VIDEO).is_file());
        fs::write(dir.join(ROOT_VIDEO), "3500").unwrap();
        assert_eq!(
            swap_media(&dir, &swapping, &[], false, &fake_probe).unwrap(),
            Some(3500)
        );
        assert!(!take_dir(&dir, 2).join(TAKE_VIDEO).exists());
        assert!(take_dir(&dir, 2).join("mic.wav").is_file());
        fs::write(dir.join(ROOT_VIDEO), "9000").unwrap();
        assert!(swap_media(&dir, &swapping, &[], true, &fake_probe)
            .unwrap_err()
            .contains("matches neither"));
        fs::remove_file(dir.join(ROOT_VIDEO)).unwrap();
        assert!(swap_media(&dir, &swapping, &[], true, &fake_probe).is_err());
    }

    // ---- Real media (ignored: requires FFmpeg and ffprobe) ----

    fn lavfi(target: &Path, color: &str, size: &str, seconds: &str, tone: &str) {
        let output = deps::command("ffmpeg")
            .unwrap()
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
            ])
            .arg(format!("color=c={color}:s={size}:r=30"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("aevalsrc={tone}:s=48000:d={seconds}"))
            .args([
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-t",
                seconds,
                "-r",
                "30",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ac",
                "1",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
            ])
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn pixel(video: &Path, at: &str, x: u32, y: u32) -> [u8; 3] {
        let output = deps::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-ss", at, "-i"])
            .arg(video)
            .args(["-frames:v", "1", "-vf"])
            .arg(format!("crop=2:2:{x}:{y},scale=1:1"))
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .unwrap();
        assert!(
            output.status.success() && output.stdout.len() >= 3,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        [output.stdout[0], output.stdout[1], output.stdout[2]]
    }
    fn samples(video: &Path) -> Vec<i16> {
        let output = deps::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-i"])
            .arg(video)
            .args([
                "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        output
            .stdout
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    }
    /// Dominant frequency from zero crossings between two times in seconds.
    fn frequency(samples: &[i16], from: f64, to: f64) -> f64 {
        let window = &samples[(from * 48000.0) as usize..(to * 48000.0) as usize];
        let crossings = window
            .windows(2)
            .filter(|pair| (pair[0] < 0) != (pair[1] < 0))
            .count();
        crossings as f64 / 2.0 / (to - from)
    }
    fn is_color(rgb: [u8; 3], expected: [u8; 3]) -> bool {
        rgb.iter().zip(expected).all(|(a, b)| a.abs_diff(b) < 48)
    }

    #[test]
    #[ignore = "Requires FFmpeg/ffprobe; appends lavfi takes and checks boundary frames, durations and audio onset"]
    fn actual_ffmpeg_takes_concatenate_at_their_offsets() {
        let (_dir, store) = store();
        let session = ready(&store, 2000);
        let id = session.id.as_str();
        let dir = store.session_dir(id).unwrap();
        let root = dir.join(ROOT_VIDEO);
        // Take 1: red, 440 Hz for its first second, then silence.
        lavfi(
            &root,
            "red",
            "320x240",
            "2",
            r"if(lt(t\,1)\,0.5*sin(2*PI*440*t)\,0)",
        );
        let base = probe(&root).unwrap().duration_ms;
        assert_eq!(base, 2000);
        // What the app's take job does once transcription is done.
        let transcribed = |index| {
            set_status(&store, id, index, TakeStatus::Ready).unwrap();
            let session = store
                .update_session(id, |s| {
                    settle(s, None);
                    Ok(())
                })
                .unwrap();
            assert_eq!(session.status, "ready");
        };

        // Take 2: blue at the same size, 880 Hz from its very first sample.
        begin(&store, id, base, Some("mic:Studio".into()), false).unwrap();
        let two = take_dir(&dir, 2);
        lavfi(
            &two.join(TAKE_VIDEO),
            "blue",
            "320x240",
            "1.5",
            "0.5*sin(2*PI*880*t)",
        );
        fs::write(two.join("audio.wav"), b"lossless").unwrap();
        finish_capture(&store, id, 2, Ok(())).unwrap();
        let session = complete_swap(&store, id, 2).unwrap();
        assert_eq!(session.duration_ms, 3500);
        assert_eq!(session.takes[1].status, TakeStatus::Transcribing);
        assert_eq!(session.takes[1].offset_ms, 2000);
        assert!(!two.join(TAKE_VIDEO).exists());
        assert!(two.join("audio.wav").is_file());
        transcribed(2);

        // Take 3: a different size, so only the take is re-encoded (scale+pad).
        let base = probe(&root).unwrap().duration_ms;
        assert_eq!(base, 3500);
        begin(&store, id, base, Some("mic:Studio".into()), false).unwrap();
        lavfi(
            &take_dir(&dir, 3).join(TAKE_VIDEO),
            "lime",
            "256x256",
            "1",
            "0.5*sin(2*PI*660*t)",
        );
        let timing = take_dir(&dir, 3).join("capture-timing.json");
        fs::write(
            &timing,
            "{\n  \"canvasWidth\": 256,\n  \"canvasHeight\": 256\n}",
        )
        .unwrap();
        finish_capture(&store, id, 3, Ok(())).unwrap();
        let session = complete_swap(&store, id, 3).unwrap();
        assert_eq!(session.duration_ms, 4500);
        assert!(!take_dir(&dir, 3).join(NORMALIZED_VIDEO).exists());
        let timing: Value = serde_json::from_slice(&fs::read(&timing).unwrap()).unwrap();
        assert_eq!(timing["canvasWidth"], 256);
        assert_eq!(
            timing["normalize"],
            serde_json::json!({"scale":0.9375,"padX":40,"padY":0,"baseWidth":320,"baseHeight":240})
        );
        // Take 2 had the base size and needed no normalization.
        assert!(!take_dir(&dir, 2).join("capture-timing.json").exists());
        let combined = probe(&root).unwrap();
        assert_eq!((combined.video.width, combined.video.height), (320, 240));
        assert!(combined.audio);
        transcribed(3);

        // Boundary frames: the last frame of each take, then the first of the next.
        let (red, blue, lime, black) = ([255, 0, 0], [0, 0, 255], [0, 255, 0], [0, 0, 0]);
        for (at, x, color) in [
            ("0.5", 159, red),
            ("1.95", 159, red),
            ("2.0", 159, blue),
            ("3.45", 159, blue),
            ("3.5", 159, lime),
            ("4.4", 159, lime),
            ("4.0", 4, black),
        ] {
            let found = pixel(&root, at, x, 119);
            assert!(is_color(found, color), "at {at}s x={x}: {found:?}");
        }

        // Audio: silent before take 2, whose tone starts at its offset.
        let audio = samples(&root);
        assert!(
            (audio.len() as f64 / 48000.0 - 4.5).abs() < 0.03,
            "{}",
            audio.len()
        );
        let quiet = &audio[(1.05 * 48000.0) as usize..(1.95 * 48000.0) as usize];
        assert!(quiet.iter().all(|s| s.unsigned_abs() < 300));
        let onset = audio
            .iter()
            .enumerate()
            .skip((1.5 * 48000.0) as usize)
            .find(|(_, s)| s.unsigned_abs() > 3000)
            .map(|(i, _)| i as f64 / 48.0)
            .unwrap();
        assert!(
            (onset - 2000.0).abs() < 5.0,
            "take 2 audio starts at {onset} ms"
        );
        for (from, to, hz) in [(0.2, 0.8, 440.0), (2.2, 3.3, 880.0), (3.6, 4.4, 660.0)] {
            let found = frequency(&audio, from, to);
            assert!((found - hz).abs() < 15.0, "{from}-{to}s: {found} Hz");
        }

        // A reader holding video.mp4 open defers the swap; the next start finishes it.
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            begin(&store, id, 4500, Some("mic:Studio".into()), false).unwrap();
            lavfi(
                &take_dir(&dir, 4).join(TAKE_VIDEO),
                "white",
                "320x240",
                "0.5",
                "0",
            );
            finish_capture(&store, id, 4, Ok(())).unwrap();
            let reader = fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&root)
                .unwrap();
            let error = complete_swap(&store, id, 4).unwrap_err();
            assert!(error.contains("in use"), "{error}");
            store
                .update_session(id, |s| {
                    settle(s, Some(error.clone()));
                    Ok(())
                })
                .unwrap();
            let waiting = read_pending(&dir, 4).unwrap();
            assert!(dir.join(&waiting.temp).is_file());
            let session = store.session(id).unwrap();
            assert_eq!(session.takes[3].status, TakeStatus::Swapping);
            assert!(check_can_record_more(&session).is_err());
            assert_eq!(probe(&root).unwrap().duration_ms, 4500);
            drop(reader);
            store.recover_interrupted().unwrap();
            let session = store.session(id).unwrap();
            assert_eq!(session.duration_ms, 5000);
            assert_eq!(probe(&root).unwrap().duration_ms, 5000);
            assert_eq!(session.takes[3].status, TakeStatus::Error);
            assert_eq!(retry_plan(&session), [4]);
            assert!(!dir.join(&waiting.temp).exists());
            assert!(is_color(pixel(&root, "4.6", 159, 119), [255, 255, 255]));
        }
    }
}
