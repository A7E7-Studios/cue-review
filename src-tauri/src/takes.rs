//! Takes: "Record more" continues a session as a new take (plan decision 10).
//!
//! Take N is recorded into `sessions/<id>/takes/<N>/`, and the legacy root
//! files are take 1. Each take records the source chosen for it and keeps
//! its own `video.mp4`; nothing is joined. A take starts on the session
//! timeline where the takes before it end, `Session.videos` lists each take
//! video with its place (format 2), and only the new take is transcribed,
//! shifted by its offset, with `t{N}-` segment ids. The shared types live in
//! [`crate::models`]: [`Take`], [`TakeStatus`], [`TakeMark`] and [`TakeVideo`].
//!
//! Status of a take: `recording` → `finalizing` → `transcribing` →
//! `ready`/`error`. A take is on the timeline exactly when its status is
//! `transcribing`, `ready` or `error`, so `error` always means "on the
//! timeline, transcript missing". A take whose capture produced no usable
//! video, or that the app lost while recording, becomes `interrupted` and is
//! not on the timeline; its folder keeps whatever was captured.
//!
//! Sessions saved before takes kept their own videos (format 1) joined every
//! take into the root `video.mp4`, which then plays the whole timeline; see
//! [`videos`]. A take of such a session still `swapping` (waiting to be
//! joined) is upgraded by [`recover`].
//!
//! Folders are always derived from the take index, never from `Take.folder`
//! or other metadata, so a damaged `session.json` cannot redirect cleanup.

use crate::{
    deps,
    models::{Segment, Session, Take, TakeMark, TakeStatus, TakeVideo, Transcript, FORMAT_VERSION},
    store::Store,
};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Take 1's video, in the session folder. In a format-1 session it holds
/// every take, joined.
pub const ROOT_VIDEO: &str = "video.mp4";
const TAKE_VIDEO: &str = "video.mp4";
/// Left in a take folder by joining a take in format 1; deleted when the
/// take is upgraded.
const JOIN_LEFTOVERS: [&str; 3] = ["normalized.mp4", "swap.json", "swap.log"];
const MAX_TOLERANCE_MS: u64 = 150;
/// What `cue discard-take` answers: no take waits to be joined any more.
pub const NOTHING_TO_DISCARD: &str =
    "Takes keep their own videos now, so no take waits to be added.";

/// Folder of take `index`: the session folder for take 1, `takes/<N>` after.
pub fn take_dir(session_dir: &Path, index: u32) -> PathBuf {
    if index <= 1 {
        session_dir.to_owned()
    } else {
        session_dir.join("takes").join(index.to_string())
    }
}
/// Take `index`'s own video: `video.mp4` in its folder.
pub fn video_file(session_dir: &Path, index: u32) -> PathBuf {
    take_dir(session_dir, index).join(TAKE_VIDEO)
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
/// Whether the take is part of the session timeline.
pub fn on_timeline(status: TakeStatus) -> bool {
    matches!(
        status,
        TakeStatus::Transcribing | TakeStatus::Ready | TakeStatus::Error
    )
}

/// The take videos of the session timeline, in order. Format 2 lists them;
/// a format-1 session has one, the root `video.mp4`, from 0 for its whole
/// `duration_ms`: one take, or every take joined into it.
pub fn videos(session: &Session) -> Vec<TakeVideo> {
    if session.videos.is_empty() {
        return vec![TakeVideo {
            take: 1,
            start_ms: 0,
            duration_ms: session.duration_ms,
        }];
    }
    let mut videos = session.videos.clone();
    videos.sort_by_key(|video| video.start_ms);
    videos
}
/// The take video that session time `at_ms` falls in, and the time inside
/// it, kept within the video: the last video starting at or before `at_ms`.
pub fn video_at(videos: &[TakeVideo], at_ms: u64) -> Option<(TakeVideo, u64)> {
    let video = *videos
        .iter()
        .rev()
        .find(|video| video.start_ms <= at_ms)
        .or(videos.first())?;
    let local = at_ms
        .saturating_sub(video.start_ms)
        .min(video.duration_ms.saturating_sub(1));
    Some((video, local))
}
/// Puts take `index`'s own video on the timeline at `offset_ms`, making the
/// session format 2. A format-1 session first gets take 1's entry: its
/// `video.mp4` holds everything before this take, joined takes included.
/// The session lasts until the end of its last video.
fn place_video(session: &mut Session, index: u32, offset_ms: u64, duration_ms: u64) {
    if session.videos.is_empty() {
        session.videos.push(TakeVideo {
            take: 1,
            start_ms: 0,
            duration_ms: offset_ms,
        });
    }
    session.videos.retain(|video| video.take != index);
    session.videos.push(TakeVideo {
        take: index,
        start_ms: offset_ms,
        duration_ms,
    });
    session.videos.sort_by_key(|video| video.start_ms);
    session.format_version = FORMAT_VERSION;
    session.duration_ms = session
        .videos
        .iter()
        .map(|video| video.start_ms.saturating_add(video.duration_ms))
        .max()
        .unwrap_or(0);
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
            "Take {} was saved by an earlier CueReview and could not be checked yet. Retry to add it.",
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
/// Appends a take recording `source_id` at `base_ms`, the end of the session
/// timeline, and creates its folder. Take 1 is written out explicitly the
/// first time.
pub fn begin(
    store: &Store,
    id: &str,
    base_ms: u64,
    source_id: String,
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
            source_id: Some(source_id),
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
/// Records the outcome of stopping take `index`. A usable take video goes on
/// the timeline with its probed duration: on a clean stop the take waits to
/// be transcribed and the session stays processing; after a capture error
/// the take is `error`, its transcript left to Retry, as for a single
/// recording. An unusable take video makes the take interrupted.
pub fn finish_capture(
    store: &Store,
    id: &str,
    index: u32,
    stopped: Result<(), String>,
) -> Result<Session, String> {
    finish_capture_with(store, id, index, stopped, &Ffmpeg)
}
fn finish_capture_with(
    store: &Store,
    id: &str,
    index: u32,
    stopped: Result<(), String>,
    tools: &dyn Tools,
) -> Result<Session, String> {
    let video = video_file(&store.session_dir(id)?, index);
    let placed = |session: &mut Session, status: TakeStatus, media: &Media| {
        let take = take_mut(session, index)?;
        take.status = status;
        take.duration_ms = media.duration_ms;
        let offset_ms = take.offset_ms;
        place_video(session, index, offset_ms, media.duration_ms);
        Ok::<(), String>(())
    };
    match (stopped, tools.probe(&video)) {
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
                placed(session, TakeStatus::Error, &media)?;
                settle(session, Some(error.clone()));
                Ok(())
            })?;
            Err(error)
        }
        (Ok(()), Ok(media)) => store.update_session(id, |session| {
            placed(session, TakeStatus::Transcribing, &media)?;
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

/// Startup repair for a session with takes, also run by `cue transcribe`:
/// - recording → interrupted, raw tracks kept, earlier takes intact;
/// - finalizing → on the timeline as `error` (transcript to Retry) when the
///   take's own `video.mp4` was finished and probes as valid; otherwise
///   interrupted, as recording;
/// - swapping, a take of a format-1 session waiting to be joined: inside
///   take 1's video when `video.mp4` already holds it, else on the timeline
///   with its own video; either way `error`, its join leftovers deleted, or
///   interrupted when neither video has it;
/// - transcribing → error, so Retry transcribes only that take;
/// - stray `video.*.tmp.mp4` files and ffconcat lists are deleted.
pub fn recover(store: &Store, id: &str) -> Result<(), String> {
    recover_with(store, id, &Ffmpeg)
}
fn recover_with(store: &Store, id: &str, tools: &dyn Tools) -> Result<(), String> {
    let dir = store.session_dir(id)?;
    let _lock = store.lock_session(id)?;
    let mut session = store.session(id)?;
    if session.takes.is_empty() {
        return Ok(());
    }
    let before = serde_json::to_value(&session).map_err(|e| e.to_string())?;
    remove_stray_files(&dir);
    let mut changed = false;
    let mut indexes: Vec<u32> = session.takes.iter().map(|take| take.index).collect();
    indexes.sort_unstable();
    for index in indexes {
        let take = take_mut(&mut session, index)?.clone();
        let next = match take.status {
            TakeStatus::Finalizing if index >= 2 => {
                match tools.probe(&video_file(&dir, index)) {
                    // Finalized before the app closed: only the transcript is left.
                    Ok(media) => {
                        take_mut(&mut session, index)?.duration_ms = media.duration_ms;
                        place_video(&mut session, index, take.offset_ms, media.duration_ms);
                        Some(TakeStatus::Error)
                    }
                    Err(_) => Some(TakeStatus::Interrupted),
                }
            }
            TakeStatus::Recording | TakeStatus::Finalizing => Some(TakeStatus::Interrupted),
            TakeStatus::Transcribing => Some(TakeStatus::Error),
            TakeStatus::Swapping if index >= 2 => upgrade_waiting(&dir, &mut session, &take, tools),
            _ => None,
        };
        if let Some(next) = next {
            take_mut(&mut session, index)?.status = next;
            changed = true;
        }
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
/// The status a format-1 take still waiting to be joined into `video.mp4`
/// moves to, placing its video. When the root video already holds it
/// (joined, then the app closed before the bookkeeping), it plays inside take
/// 1's video; otherwise from its own video when that is usable, else it is
/// interrupted. Either way the files left from joining it are deleted.
/// `None`, changing nothing, while the root video cannot be read: only it
/// tells a joined take, whose own copy is gone, from a lost one.
fn upgrade_waiting(
    dir: &Path,
    session: &mut Session,
    take: &Take,
    tools: &dyn Tools,
) -> Option<TakeStatus> {
    let joined = if session.videos.is_empty() {
        let root = tools.probe(&dir.join(ROOT_VIDEO)).ok()?;
        (swap_state(root.duration_ms, take.offset_ms, take.duration_ms) == SwapState::Applied)
            .then_some(root.duration_ms)
    } else {
        None
    };
    let folder = take_dir(dir, take.index);
    for name in JOIN_LEFTOVERS {
        let _ = fs::remove_file(folder.join(name));
    }
    let _ = fs::remove_file(dir.join(format!("concat-t{}.ffconcat", take.index)));
    if let Some(root_ms) = joined {
        session.duration_ms = root_ms;
        return Some(TakeStatus::Error);
    }
    Some(match tools.probe(&video_file(dir, take.index)) {
        Ok(media) => {
            if let Some(own) = session.takes.iter_mut().find(|t| t.index == take.index) {
                own.duration_ms = media.duration_ms;
            }
            place_video(session, take.index, take.offset_ms, media.duration_ms);
            TakeStatus::Error
        }
        Err(_) => TakeStatus::Interrupted,
    })
}
/// Upgrades the format-1 takes of session `id` still waiting to be joined,
/// as [`recover`] does, but leaves the session's status alone, for a job
/// about to transcribe them (Retry, `cue transcribe`).
pub fn upgrade(store: &Store, id: &str) -> Result<(), String> {
    upgrade_with(store, id, &probe)
}
/// [`upgrade`] with the media probe passed in.
pub(crate) fn upgrade_with(
    store: &Store,
    id: &str,
    probe: &dyn Fn(&Path) -> Result<Media, String>,
) -> Result<(), String> {
    struct Probe<'a>(&'a dyn Fn(&Path) -> Result<Media, String>);
    impl Tools for Probe<'_> {
        fn probe(&self, path: &Path) -> Result<Media, String> {
            (self.0)(path)
        }
    }
    let dir = store.session_dir(id)?;
    let _lock = store.lock_session(id)?;
    let mut session = store.session(id)?;
    let mut waiting: Vec<Take> = session
        .takes
        .iter()
        .filter(|take| take.status == TakeStatus::Swapping && take.index >= 2)
        .cloned()
        .collect();
    if waiting.is_empty() {
        return Ok(());
    }
    waiting.sort_by_key(|take| take.index);
    for take in waiting {
        if let Some(next) = upgrade_waiting(&dir, &mut session, &take, &Probe(probe)) {
            take_mut(&mut session, take.index)?.status = next;
        }
    }
    store.save_session(&session)
}
fn is_temp_name(name: &str) -> bool {
    name.len() > "video..tmp.mp4".len()
        && name.starts_with("video.")
        && name.ends_with(".tmp.mp4")
        && !name.contains(['/', '\\'])
}
/// Deletes what an interrupted format-1 join left in the session folder.
fn remove_stray_files(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stray =
            is_temp_name(&name) || (name.starts_with("concat-t") && name.ends_with(".ffconcat"));
        if stray && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}
/// `cue discard-take`: no take waits to be joined, so every take is refused
/// and nothing changes. An unknown take is named as such.
pub fn discard(store: &Store, id: &str, index: u32) -> Result<Session, String> {
    let mut session = store.session(id)?;
    if index >= 2 {
        take_mut(&mut session, index)?;
    }
    Err(NOTHING_TO_DISCARD.into())
}

/// What ffprobe reports about a recording.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Media {
    pub duration_ms: u64,
    pub width: u64,
    pub height: u64,
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
    Ok(Media {
        duration_ms: (seconds * 1000.0).round() as u64,
        width: video["width"].as_u64().unwrap_or(0),
        height: video["height"].as_u64().unwrap_or(0),
    })
}
/// Probes a recording's duration and frame size.
pub fn probe(path: &Path) -> Result<Media, String> {
    let output = deps::command("ffprobe")?
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height:format=duration",
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
    if media.width == 0 || media.height == 0 {
        return Err(format!("{} has no usable video frames.", path.display()));
    }
    Ok(media)
}

/// How closely durations must agree, in ms, for a take of `take_ms`.
pub fn tolerance_ms(take_ms: u64) -> u64 {
    (take_ms / 3).clamp(2, MAX_TOLERANCE_MS)
}
/// Whether a format-1 `video.mp4` already holds a take waiting to be joined.
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

/// The media probe, replaceable in tests.
trait Tools {
    fn probe(&self, path: &Path) -> Result<Media, String>;
}
struct Ffmpeg;
impl Tools for Ffmpeg {
    fn probe(&self, path: &Path) -> Result<Media, String> {
        probe(path)
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
    /// Stands in for ffprobe: a fake media file holds its duration in ms,
    /// optionally followed by its frame size, as in `"1500 320x240"`.
    fn fake_probe(path: &Path) -> Result<Media, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let mut fields = text.split_whitespace();
        let duration_ms = fields
            .next()
            .and_then(|ms| ms.parse().ok())
            .ok_or("not media")?;
        let (width, height) = fields
            .next()
            .and_then(|size| size.split_once('x'))
            .map(|(w, h)| (w.parse().unwrap(), h.parse().unwrap()))
            .unwrap_or((320, 240));
        Ok(Media {
            duration_ms,
            width,
            height,
        })
    }
    struct Fake;
    impl Tools for Fake {
        fn probe(&self, path: &Path) -> Result<Media, String> {
            fake_probe(path)
        }
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
    fn video(take: u32, start_ms: u64, duration_ms: u64) -> TakeVideo {
        TakeVideo {
            take,
            start_ms,
            duration_ms,
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
        let window = "window:4242".to_string();
        let started = begin(&store, &session.id, 80000, window.clone(), None, true).unwrap();
        assert_eq!(started.take, {
            let mut expected = take(2, 80000, 0, TakeStatus::Recording);
            expected.source_id = Some(window.clone());
            expected.microphone_id = None;
            expected.system_audio = true;
            expected
        });
        let saved = store.session(&session.id).unwrap();
        assert_eq!(saved.status, "recording");
        // The session keeps its first source; the take names its own.
        assert_eq!(saved.source_id, "monitor:1");
        assert_eq!(saved.takes[1].source_id.as_deref(), Some("window:4242"));
        assert_eq!(saved.takes.len(), 2);
        assert_eq!(saved.takes[0], take(1, 0, 80000, TakeStatus::Ready));
        assert_eq!(saved.video_path.as_deref(), dir.join(ROOT_VIDEO).to_str());
        assert!(take_dir(&dir, 2).is_dir());
        assert!(
            begin(&store, &session.id, 80000, window.clone(), None, false)
                .unwrap_err()
                .contains("Finish recording")
        );
        abandon(&store, &session.id, started).unwrap();
        let restored = store.session(&session.id).unwrap();
        assert_eq!(restored.status, "ready");
        assert!(restored.takes.is_empty());
        assert!(!take_dir(&dir, 2).exists());
        assert!(dir.join(ROOT_VIDEO).is_file());

        // A folder left by an attempt that never saved is skipped, not reused.
        fs::create_dir_all(take_dir(&dir, 2)).unwrap();
        fs::write(take_dir(&dir, 2).join("mic.wav"), b"orphan").unwrap();
        let started = begin(&store, &session.id, 80000, window, None, false).unwrap();
        assert_eq!(started.take.index, 3);
        assert_eq!(
            fs::read(take_dir(&dir, 2).join("mic.wav")).unwrap(),
            b"orphan"
        );
    }

    #[test]
    fn stopping_a_take_keeps_its_own_video_on_the_timeline() {
        let (_dir, store) = store();
        let session = ready(&store, 72000);
        let id = session.id.as_str();
        let dir = store.session_dir(id).unwrap();
        begin(
            &store,
            id,
            72000,
            "window:7".into(),
            Some("mic:Studio".into()),
            false,
        )
        .unwrap();
        let finalizing = mark_finalizing(&store, id, 2, 1480).unwrap();
        assert_eq!(finalizing.status, "processing");
        assert_eq!(finalizing.takes[1].status, TakeStatus::Finalizing);
        assert_eq!(finalizing.takes[1].duration_ms, 1480);

        // Clean stop: the probed take duration wins over the wall clock, and
        // the take's video goes on the timeline after take 1's.
        fs::write(video_file(&dir, 2), "1500 1280x720").unwrap();
        let stopped = finish_capture_with(&store, id, 2, Ok(()), &Fake).unwrap();
        assert_eq!(stopped.status, "processing");
        assert_eq!(stopped.takes[1].status, TakeStatus::Transcribing);
        assert_eq!(stopped.takes[1].duration_ms, 1500);
        assert_eq!(stopped.format_version, FORMAT_VERSION);
        assert_eq!(stopped.videos, [video(1, 0, 72000), video(2, 72000, 1500)]);
        assert_eq!(stopped.duration_ms, 73500);
        // Nothing is joined: both videos are as their takes recorded them.
        assert_eq!(fs::read_to_string(dir.join(ROOT_VIDEO)).unwrap(), "72000");
        assert_eq!(
            fs::read_to_string(video_file(&dir, 2)).unwrap(),
            "1500 1280x720"
        );
        assert_eq!(retry_plan(&stopped), [2]);

        // A capture error with a usable take video leaves only the transcript to Retry.
        let error =
            finish_capture_with(&store, id, 2, Err("Source closed".into()), &Fake).unwrap_err();
        assert_eq!(error, "Source closed");
        let saved = store.session(id).unwrap();
        assert_eq!(saved.status, "error");
        assert_eq!(saved.error.as_deref(), Some("Source closed"));
        assert_eq!(saved.takes[1].status, TakeStatus::Error);
        assert_eq!(saved.videos, [video(1, 0, 72000), video(2, 72000, 1500)]);
        assert_eq!(retry_plan(&saved), [2]);

        // No usable take video: interrupted, off the timeline, raw tracks kept.
        let (_dir, store) = self::store();
        let session = ready(&store, 2000);
        let id = session.id.as_str();
        let dir = store.session_dir(id).unwrap();
        begin(&store, id, 2000, "monitor:2".into(), None, false).unwrap();
        fs::write(take_dir(&dir, 2).join("mic.wav"), b"raw").unwrap();
        let error = finish_capture_with(&store, id, 2, Ok(()), &Fake).unwrap_err();
        assert!(error.contains("Take 2 could not be saved"), "{error}");
        let saved = store.session(id).unwrap();
        assert_eq!(saved.status, "ready");
        assert!(saved.error.is_none());
        assert_eq!(saved.takes[0].status, TakeStatus::Ready);
        assert_eq!(saved.takes[1].status, TakeStatus::Interrupted);
        assert!(saved.videos.is_empty());
        assert_eq!(saved.duration_ms, 2000);
        assert_eq!(fs::read(take_dir(&dir, 2).join("mic.wav")).unwrap(), b"raw");
    }

    #[test]
    fn videos_place_each_take_on_the_timeline() {
        let (_dir, store) = store();
        let mut session = ready(&store, 2000);
        // Format 1: one video, video.mp4, for the whole timeline.
        assert_eq!(videos(&session), [video(1, 0, 2000)]);
        session.takes = vec![
            take(1, 0, 2000, TakeStatus::Ready),
            take(2, 2000, 1500, TakeStatus::Ready),
        ];
        session.duration_ms = 3500;
        assert_eq!(videos(&session), [video(1, 0, 3500)]);
        // Each take with its own video adds an entry; take 1's spans what
        // came before.
        place_video(&mut session, 3, 3500, 1000);
        assert_eq!(session.format_version, 2);
        assert_eq!(videos(&session), [video(1, 0, 3500), video(3, 3500, 1000)]);
        assert_eq!(session.duration_ms, 4500);
        place_video(&mut session, 4, 4500, 250);
        // Placing a take again replaces its entry.
        place_video(&mut session, 4, 4500, 300);
        assert_eq!(
            videos(&session),
            [video(1, 0, 3500), video(3, 3500, 1000), video(4, 4500, 300)]
        );
        assert_eq!(session.duration_ms, 4800);
        // The files come from the take index alone.
        let dir = Path::new("session");
        assert_eq!(video_file(dir, 1), dir.join("video.mp4"));
        assert_eq!(
            video_file(dir, 3),
            dir.join("takes").join("3").join("video.mp4")
        );
    }

    #[test]
    fn video_at_picks_the_take_video_by_session_time() {
        let list = [
            video(1, 0, 72000),
            video(2, 72000, 30000),
            video(4, 102000, 5000),
        ];
        for (at, take, local) in [
            (0, 1, 0),
            (71999, 1, 71999),
            (72000, 2, 0),
            (80000, 2, 8000),
            (101999, 2, 29999),
            (102000, 4, 0),
            (106999, 4, 4999),
            // Past the end stays on the last frame of the last video.
            (200000, 4, 4999),
        ] {
            let (found, inside) = video_at(&list, at).unwrap();
            assert_eq!((found.take, inside), (take, local), "{at}");
        }
        assert!(video_at(&[], 10).is_none());
        // A video that does not start at 0 still answers for earlier times.
        assert_eq!(
            video_at(&[video(1, 500, 1000)], 0).unwrap(),
            (video(1, 500, 1000), 0)
        );
    }

    #[test]
    fn a_session_with_joined_takes_keeps_its_video() {
        // Saved by an earlier CueReview: takes 1 to 3 joined into video.mp4,
        // no formatVersion and no videos.
        let (_dir, store) = store();
        let session = ready(&store, 6000);
        let id = session.id.as_str();
        let dir = store.session_dir(id).unwrap();
        store
            .update_session(id, |session| {
                session.takes = vec![
                    take(1, 0, 2000, TakeStatus::Ready),
                    take(2, 2000, 1500, TakeStatus::Ready),
                    take(3, 3500, 2500, TakeStatus::Ready),
                ];
                Ok(())
            })
            .unwrap();
        let raw: Value =
            serde_json::from_slice(&fs::read(dir.join("session.json")).unwrap()).unwrap();
        assert!(raw.get("formatVersion").is_none() && raw.get("videos").is_none());
        let joined = store.session(id).unwrap();
        assert_eq!(joined.format_version, 1);
        assert_eq!(videos(&joined), [video(1, 0, 6000)]);
        assert_eq!(
            video_at(&videos(&joined), 4000).unwrap(),
            (video(1, 0, 6000), 4000)
        );
        // Take 4 gets its own video, starting where video.mp4 ends.
        begin(
            &store,
            id,
            joined.duration_ms,
            "window:9".into(),
            None,
            false,
        )
        .unwrap();
        fs::write(video_file(&dir, 4), "1000").unwrap();
        let upgraded = finish_capture_with(&store, id, 4, Ok(()), &Fake).unwrap();
        assert_eq!(upgraded.videos, [video(1, 0, 6000), video(4, 6000, 1000)]);
        assert_eq!(upgraded.takes[3].offset_ms, 6000);
        let raw: Value =
            serde_json::from_slice(&fs::read(dir.join("session.json")).unwrap()).unwrap();
        assert_eq!(raw["formatVersion"], 2);
        assert_eq!(
            raw["videos"],
            serde_json::json!([{"take":1,"startMs":0,"durationMs":6000},{"take":4,"startMs":6000,"durationMs":1000}])
        );
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

    #[test]
    fn recovery_repairs_each_take_state() {
        let (_dir, store) = store();
        let first = || take(1, 0, 2000, TakeStatus::Ready);
        let second = |status| vec![first(), take(2, 2000, 1500, status)];

        // recording → interrupted; the session is ready again with take 1 intact.
        let (recording, dir) = crashed(&store, "recording", second(TakeStatus::Recording), 2000);
        recover_with(&store, &recording, &Fake).unwrap();
        let session = store.session(&recording).unwrap();
        assert_eq!(
            (session.status.as_str(), session.error.as_deref()),
            ("ready", None)
        );
        assert_eq!(session.takes[0], first());
        assert_eq!(session.takes[1].status, TakeStatus::Interrupted);
        assert_eq!(session.duration_ms, 2000);
        assert!(session.videos.is_empty());
        assert!(take_dir(&dir, 2).join("mic.wav").is_file());

        // finalizing with a finished take video → on the timeline, transcript to Retry.
        let (finalized, dir) = crashed(&store, "processing", second(TakeStatus::Finalizing), 2000);
        fs::write(video_file(&dir, 2), "1520").unwrap();
        recover_with(&store, &finalized, &Fake).unwrap();
        let session = store.session(&finalized).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert_eq!(session.takes[1].duration_ms, 1520);
        assert_eq!(session.videos, [video(1, 0, 2000), video(2, 2000, 1520)]);
        assert_eq!(session.duration_ms, 3520);
        assert_eq!(session.status, "error");
        assert!(session
            .error
            .as_deref()
            .unwrap()
            .contains("Take 2 has no transcript"));
        assert_eq!(retry_plan(&session), [2]);

        // finalizing without a usable take video → interrupted, raw tracks kept.
        let (finalizing, dir) = crashed(&store, "processing", second(TakeStatus::Finalizing), 2000);
        fs::write(take_dir(&dir, 2).join("native-video.mp4"), b"raw").unwrap();
        fs::write(video_file(&dir, 2), b"truncated").unwrap();
        recover_with(&store, &finalizing, &Fake).unwrap();
        let session = store.session(&finalizing).unwrap();
        assert_eq!(session.status, "ready");
        assert_eq!(session.takes[1].status, TakeStatus::Interrupted);
        assert!(session.videos.is_empty());
        for raw in ["native-video.mp4", "mic.wav", "audio.wav", TAKE_VIDEO] {
            assert!(take_dir(&dir, 2).join(raw).is_file(), "{raw}");
        }

        // transcribing → error, and Retry covers only that take.
        let (transcribing, _) =
            crashed(&store, "processing", second(TakeStatus::Transcribing), 3500);
        recover_with(&store, &transcribing, &Fake).unwrap();
        let session = store.session(&transcribing).unwrap();
        assert_eq!(session.status, "error");
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert!(session.error.as_deref().unwrap().contains("Take 2"));
        assert_eq!(retry_plan(&session), [2]);

        // Strays of an interrupted format-1 join go.
        let (strays, dir) = crashed(&store, "recording", second(TakeStatus::Recording), 2000);
        let stray = "video.0e1f-stray.tmp.mp4";
        fs::write(dir.join(stray), "9").unwrap();
        fs::write(dir.join("concat-t2.ffconcat"), "ffconcat version 1.0").unwrap();
        recover_with(&store, &strays, &Fake).unwrap();
        for gone in [stray, "concat-t2.ffconcat"] {
            assert!(!dir.join(gone).exists(), "{gone}");
        }

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
        recover_with(&store, &settled, &Fake).unwrap();
        assert_eq!(fs::read(dir.join("session.json")).unwrap(), before);
    }

    #[test]
    fn recovery_upgrades_a_take_waiting_to_be_joined() {
        let (_dir, store) = store();
        let first = || take(1, 0, 2000, TakeStatus::Ready);
        let waiting = || vec![first(), take(2, 2000, 1500, TakeStatus::Swapping)];
        let leftovers = |dir: &Path| {
            let folder = take_dir(dir, 2);
            for name in JOIN_LEFTOVERS {
                fs::write(folder.join(name), "left").unwrap();
            }
            fs::write(dir.join("video.5d0c7a3e-waiting.tmp.mp4"), "3500").unwrap();
            fs::write(dir.join("concat-t2.ffconcat"), "ffconcat version 1.0").unwrap();
        };
        let cleaned = |dir: &Path| {
            for name in JOIN_LEFTOVERS {
                assert!(!take_dir(dir, 2).join(name).exists(), "{name}");
            }
            assert!(!dir.join("video.5d0c7a3e-waiting.tmp.mp4").exists());
            assert!(!dir.join("concat-t2.ffconcat").exists());
        };

        // Not joined yet: it plays from its own video, its transcript to Retry.
        let (pending, dir) = crashed(&store, "processing", waiting(), 2000);
        leftovers(&dir);
        recover_with(&store, &pending, &Fake).unwrap();
        let session = store.session(&pending).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert_eq!(session.videos, [video(1, 0, 2000), video(2, 2000, 1500)]);
        assert_eq!(session.format_version, 2);
        assert_eq!(session.duration_ms, 3500);
        assert_eq!(session.status, "error");
        assert_eq!(retry_plan(&session), [2]);
        assert_eq!(fs::read_to_string(dir.join(ROOT_VIDEO)).unwrap(), "2000");
        assert!(video_file(&dir, 2).is_file());
        cleaned(&dir);

        // Already joined into video.mp4: it plays inside take 1's video.
        let (joined, dir) = crashed(&store, "processing", waiting(), 3500);
        fs::remove_file(video_file(&dir, 2)).unwrap();
        leftovers(&dir);
        recover_with(&store, &joined, &Fake).unwrap();
        let session = store.session(&joined).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert!(session.videos.is_empty());
        assert_eq!(session.duration_ms, 3500);
        assert_eq!(videos(&session), [video(1, 0, 3500)]);
        assert_eq!(retry_plan(&session), [2]);
        cleaned(&dir);

        // While video.mp4 cannot be read, nothing tells a joined take from a
        // lost one: the take keeps waiting, with its leftovers.
        let (unreadable, dir) = crashed(&store, "processing", waiting(), 3500);
        fs::remove_file(video_file(&dir, 2)).unwrap();
        fs::write(dir.join(ROOT_VIDEO), b"locked").unwrap();
        leftovers(&dir);
        recover_with(&store, &unreadable, &Fake).unwrap();
        let session = store.session(&unreadable).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Swapping);
        for name in JOIN_LEFTOVERS {
            assert!(take_dir(&dir, 2).join(name).is_file(), "{name}");
        }
        // Stray temporary files in the session folder go either way.
        assert!(!dir.join("video.5d0c7a3e-waiting.tmp.mp4").exists());
        assert!(!dir.join("concat-t2.ffconcat").exists());

        // In neither video: interrupted, the session ready again.
        let (lost, dir) = crashed(&store, "error", waiting(), 2000);
        fs::write(video_file(&dir, 2), b"truncated").unwrap();
        recover_with(&store, &lost, &Fake).unwrap();
        let session = store.session(&lost).unwrap();
        assert_eq!(session.takes[1].status, TakeStatus::Interrupted);
        assert_eq!(session.status, "ready");
        assert!(session.videos.is_empty());
    }

    #[test]
    fn upgrading_a_waiting_take_leaves_the_session_status_alone() {
        // Retry and `cue transcribe` upgrade the take inside their own job.
        let (_dir, store) = store();
        let (id, _) = crashed(
            &store,
            "processing",
            vec![
                take(1, 0, 2000, TakeStatus::Ready),
                take(2, 2000, 1500, TakeStatus::Swapping),
            ],
            2000,
        );
        upgrade_with(&store, &id, &fake_probe).unwrap();
        let session = store.session(&id).unwrap();
        assert_eq!(session.status, "processing");
        assert!(session.error.is_none());
        assert_eq!(session.takes[1].status, TakeStatus::Error);
        assert_eq!(session.videos, [video(1, 0, 2000), video(2, 2000, 1500)]);
        // Nothing waiting: the file is not rewritten.
        let file = store.session_dir(&id).unwrap().join("session.json");
        let before = fs::read(&file).unwrap();
        upgrade_with(&store, &id, &fake_probe).unwrap();
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn discarding_refuses_every_take() {
        let (_dir, store) = store();
        let (id, dir) = crashed(
            &store,
            "ready",
            vec![
                take(1, 0, 2000, TakeStatus::Ready),
                take(2, 2000, 1500, TakeStatus::Ready),
            ],
            3500,
        );
        let before = fs::read(dir.join("session.json")).unwrap();
        for index in [1, 2] {
            assert_eq!(discard(&store, &id, index).unwrap_err(), NOTHING_TO_DISCARD);
        }
        assert!(discard(&store, &id, 7)
            .unwrap_err()
            .contains("Take 7 is not part of this recording"));
        assert_eq!(fs::read(dir.join("session.json")).unwrap(), before);
    }

    #[test]
    fn probe_output_parses() {
        let value = serde_json::json!({"streams":[
            {"codec_type":"video","width":320,"height":240},
            {"codec_type":"audio"}],
            "format":{"duration":"3.500000"}});
        assert_eq!(
            parse_probe(&value).unwrap(),
            Media {
                duration_ms: 3500,
                width: 320,
                height: 240
            }
        );
        assert!(parse_probe(&serde_json::json!({"streams":[],"format":{"duration":"1"}})).is_err());
        assert!(parse_probe(
            &serde_json::json!({"streams":[{"codec_type":"video"}],"format":{"duration":"N/A"}})
        )
        .is_err());
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
        let started = begin(&store, &session.id, 2000, "monitor:1".into(), None, false).unwrap();
        assert_eq!(started.session.takes[0].status, TakeStatus::Error);
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
            .contains("Take 2 was saved by an earlier CueReview"));
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
}
