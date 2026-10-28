use crate::{
    cursor::{self, Click, CursorPoint, CursorTrack},
    deps,
    models::{Segment, Session, Transcript, Word},
    store::Store,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
pub fn handoff(store: &Store, id: &str, exe: &Path) -> Result<String, String> {
    let s = store.session(id)?;
    let root = std::path::absolute(&store.root).map_err(|e| e.to_string())?;
    Ok(handoff_text(
        &s.name,
        id,
        exe,
        &root,
        &store.session_dir(id)?,
    ))
}
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn handoff_text(name: &str, id: &str, exe: &Path, root: &Path, folder: &Path) -> String {
    let (command, session, shell, environment) = if cfg!(windows) {
        (
            format!("& {}", ps_quote(&exe.to_string_lossy())),
            ps_quote(id),
            "PowerShell",
            format!(
                "$env:CUEREVIEW_DATA_DIR = {}",
                ps_quote(&root.to_string_lossy())
            ),
        )
    } else {
        (
            sh_quote(&exe.to_string_lossy()),
            sh_quote(id),
            "a POSIX shell (bash or zsh)",
            format!(
                "export CUEREVIEW_DATA_DIR={}",
                sh_quote(&root.to_string_lossy())
            ),
        )
    };
    let folder = folder.display();
    format!(
        "Review CueReview session {id} ({name}) locally. Run these commands in {shell}.

Use the same local data directory as the app:
{environment}

Recommended workflow:
1. Read the compact transcript: one line per segment as [mm:ss | seekMs] text, with a divider at each take:
{command} transcript {session} --segments
2. Look at one frame per segment, scaled to at most 1600 px wide, with the pointer ringed where it was tracked:
{command} frames {session} --per-segment --max-width 1600 --mark-cursor
3. List spoken pointing moments (here, this, that, look at, ...) with the cursor position and clicks within 1 s:
{command} moments {session}
4. Inspect what you need with a targeted frame or clip, using seekMs, startMs and endMs from the steps above:
{command} frame {session} --at-ms SEEK_MS --max-width 1600 --mark-cursor
{command} clip {session} --start-ms START_MS --end-ms END_MS

More commands:
Word timestamps: {command} transcript {session} --json
Find a phrase (replace the example): {command} find {session} --phrase 'here'
Frame at a phrase: {command} frame {session} --phrase 'here' --occurrence 1
Frames at chosen times: {command} frames {session} --at-ms '1000,2500,4000' --max-width 1600
Moments with frames: {command} moments {session} --frames --max-width 1600 --mark-cursor
Rename the session: {command} rename {session} 'Short descriptive name'
Usage of any command: {command} help frames

Session folder: {folder}
The CLI is bundled with CueReview; use its full path as shown. Prefer seekMs, when present, for word-to-visual lookup; startMs/endMs retain the original model intervals. All timestamps are estimates; inspect surrounding frames when ambiguous. Frames and clips are written to new files and never overwrite existing ones. cursor is null or absent when no pointer track was recorded."
    )
}
/// `cue transcribe`: transcribes a finished session again.
pub fn transcribe_existing(store: &Store, id: &str) -> Result<Transcript, String> {
    transcribe_existing_with(
        store,
        id,
        crate::attach_finished_video,
        crate::transcribe::transcribe,
    )
}
/// [`transcribe_existing`] with the video check and the transcription passed
/// in. Both session writes re-read `session.json` under its lock, so a
/// concurrent `cue rename` or take update is never overwritten.
pub(crate) fn transcribe_existing_with(
    store: &Store,
    id: &str,
    attach: impl FnOnce(&Store, &mut Session) -> Result<(), String>,
    transcribe: impl FnOnce(&Store, &str) -> Result<Transcript, String>,
) -> Result<Transcript, String> {
    store.update_session(id, |session| {
        if matches!(session.status.as_str(), "recording" | "processing") {
            return Err("This session is recording or processing. Finish its active job first; reopen CueReview to recover an interrupted session.".into());
        }
        // Verify real video before a silent/no-audio session can complete successfully.
        attach(store, session)?;
        session.status = "processing".into();
        session.error = None;
        Ok(())
    })?;
    let result = transcribe(store, id);
    store.update_session(id, |session| {
        if let Ok(transcript) = &result {
            Store::apply_auto_title(session, transcript);
        }
        session.status = if result.is_ok() { "ready" } else { "error" }.into();
        session.error = result.as_ref().err().cloned();
        Ok(())
    })?;
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseMatch {
    pub occurrence: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seek_ms: Option<u64>,
    pub text: String,
    /// The pointer at the match's seek point; only present when the session
    /// has a cursor track.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CursorPoint>,
}
/// Lowercase letters and digits only, so "Here," matches "here".
pub(crate) fn normalized(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
/// The word's alignment point when present, otherwise its start, as in the app.
pub fn word_seek_ms(word: &Word) -> u64 {
    word.seek_ms.unwrap_or(word.start_ms)
}
/// The first word's alignment point when present, otherwise the segment
/// start, as in the app's transcript rows.
pub fn segment_seek_ms(segment: &Segment) -> u64 {
    segment
        .words
        .first()
        .and_then(|word| word.seek_ms)
        .unwrap_or(segment.start_ms)
}
/// [`find`] plus the pointer at each match, when the session has a cursor track.
pub fn find_with_cursor(store: &Store, id: &str, phrase: &str) -> Result<Vec<PhraseMatch>, String> {
    let mut matches = find(&store.transcript(id)?, phrase)?;
    if let Some(track) = cursor::load(store, id) {
        for found in &mut matches {
            found.cursor = track.at(found.seek_ms.unwrap_or(found.start_ms));
        }
    }
    Ok(matches)
}
/// The transcript as JSON with `cursor` on every segment (at its seek point)
/// and every word (at its seek point). Without a track, print the
/// [`Transcript`] itself so the output stays byte-identical.
pub fn transcript_with_cursor(transcript: &Transcript, track: &CursorTrack) -> Value {
    let mut value = serde_json::to_value(transcript).unwrap_or(Value::Null);
    let Some(items) = value.get_mut("segments").and_then(Value::as_array_mut) else {
        return value;
    };
    for (segment, item) in transcript.segments.iter().zip(items) {
        item["cursor"] = serde_json::json!(track.at(segment_seek_ms(segment)));
        if let Some(words) = item.get_mut("words").and_then(Value::as_array_mut) {
            for (word, entry) in segment.words.iter().zip(words) {
                entry["cursor"] = serde_json::json!(track.at(word_seek_ms(word)));
            }
        }
    }
    value
}
/// The seek point of the `occurrence`-th (1-based) match of `phrase`.
pub fn phrase_time(
    transcript: &Transcript,
    phrase: &str,
    occurrence: usize,
) -> Result<u64, String> {
    let matches = find(transcript, phrase)?;
    let matched = matches
        .iter()
        .find(|m| m.occurrence == occurrence)
        .ok_or("Phrase occurrence was not found.")?;
    Ok(matched.seek_ms.unwrap_or(matched.start_ms))
}
pub fn find(transcript: &Transcript, phrase: &str) -> Result<Vec<PhraseMatch>, String> {
    let query: Vec<_> = phrase
        .split_whitespace()
        .map(normalized)
        .filter(|s| !s.is_empty())
        .collect();
    if query.is_empty() {
        return Err("Provide a non-empty phrase.".into());
    }
    let words: Vec<&Word> = transcript
        .segments
        .iter()
        .flat_map(|s| s.words.iter())
        .collect();
    let mut result = vec![];
    for group in words.windows(query.len()) {
        if group
            .iter()
            .zip(&query)
            .all(|(word, q)| normalized(&word.text) == *q)
        {
            result.push(PhraseMatch {
                occurrence: result.len() + 1,
                start_ms: group[0].start_ms,
                end_ms: group.last().unwrap().end_ms,
                seek_ms: group[0].seek_ms,
                text: group
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                cursor: None,
            });
        }
    }
    Ok(result)
}
fn validate_range(duration: u64, start: u64, end: Option<u64>) -> Result<(), String> {
    if start >= duration {
        return Err(format!(
            "Start must be within the recording (0–{} ms).",
            duration.saturating_sub(1)
        ));
    }
    if end.is_some_and(|end| end <= start || end > duration) {
        return Err(
            "Clip end must be after start and no later than the recording duration.".into(),
        );
    }
    Ok(())
}
/// A path given with `--output` or `--output-dir`, made absolute. URLs and
/// FFmpeg protocol names (`pipe:1`, `tcp://…`, `file:…`) are refused, so an
/// export only ever goes to a local file. A drive letter is a path.
fn local_path(path: &Path) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    let protocol = text.split_once(':').is_some_and(|(name, _)| {
        name.len() > 1
            && name.starts_with(|c: char| c.is_ascii_alphabetic())
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    });
    if protocol || text.contains("://") {
        return Err(format!(
            "Use a local file path, not a URL or FFmpeg protocol: {text}. Put ./ before a file name that contains a colon."
        ));
    }
    std::path::absolute(path).map_err(|e| e.to_string())
}
/// FFmpeg's argument for a local output file. The `file:` prefix keeps FFmpeg
/// from reading the path as an option or another protocol.
fn ffmpeg_file(path: &Path) -> std::ffi::OsString {
    let mut argument = std::ffi::OsString::from("file:");
    argument.push(path);
    argument
}
/// The folder exports go to: `requested`, or the session's `exports` folder.
fn exports_dir(store: &Store, id: &str, requested: Option<&Path>) -> Result<PathBuf, String> {
    let dir = match requested {
        Some(dir) => local_path(dir)?,
        None => std::path::absolute(store.session_dir(id)?.join("exports"))
            .map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Create {}: {e}", dir.display()))?;
    Ok(dir)
}
/// A fresh `{at}-{uuid}.{extension}` name, so exports never collide.
fn unique_name(dir: &Path, at: u64, extension: &str) -> PathBuf {
    dir.join(format!("{at}-{}.{extension}", uuid::Uuid::new_v4()))
}
fn output_path(
    store: &Store,
    id: &str,
    at: u64,
    extension: &str,
    requested: Option<&Path>,
) -> Result<PathBuf, String> {
    let path = match requested {
        Some(path) => local_path(path)?,
        None => unique_name(&exports_dir(store, id, None)?, at, extension),
    };
    refuse_existing(&path)?;
    Ok(path)
}
fn refuse_existing(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "Output exists; choose another path: {}",
            path.display()
        ));
    }
    Ok(())
}

/// How exported frames are drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameStyle {
    /// Frames wider than this are scaled down to it, keeping the aspect ratio.
    pub max_width: Option<u32>,
    /// Draw a ring where the pointer was, when the session has a cursor track.
    pub mark_cursor: bool,
}
/// When `cue frame` exports its frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameTime {
    AtMs(u64),
    /// The seek point of the `occurrence`-th (1-based) match of a phrase.
    Phrase {
        phrase: String,
        occurrence: usize,
    },
}
/// When `cue frames` exports its frames.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrameTimes {
    AtMs(Vec<u64>),
    /// Each transcript segment's seek point.
    PerSegment,
}
/// One exported PNG, serialized as `{path,timeMs,width,height,cursor}`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameExport {
    pub path: PathBuf,
    pub time_ms: u64,
    /// Size of the written PNG, after any `max_width` scaling.
    pub width: u32,
    pub height: u32,
    /// The pointer at `time_ms`; `null` when no cursor track covers it.
    pub cursor: Option<CursorPoint>,
    /// The segment whose seek point this is, for `--per-segment`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_id: Option<String>,
}

/// Writes the frame displayed at `at` to `path`, which must not exist.
fn extract_frame(
    video: &Path,
    duration_ms: u64,
    at: u64,
    path: &Path,
    max_width: Option<u32>,
) -> Result<(), String> {
    let scale = max_width.map(|width| format!("scale='min(iw,{width})':-2"));
    let mut cmd = deps::command("ffmpeg")?;
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-n",
        "-ss",
        &format!("{:.3}", at as f64 / 1000.),
        "-i",
    ])
    .arg(video);
    if let Some(scale) = &scale {
        cmd.args(["-vf", scale]);
    }
    let mut out = cmd
        .args(["-frames:v", "1", "-update", "1"])
        .arg(ffmpeg_file(path))
        .output()
        .map_err(|e| e.to_string())?;
    // Accurate seeking can land after the last frame's PTS while still inside its
    // displayed duration. Decode at most the final second and return its last frame.
    if out.status.success() && !path.is_file() && at >= duration_ms.saturating_sub(1000) {
        let filter = match &scale {
            Some(scale) => format!("reverse,{scale}"),
            None => "reverse".into(),
        };
        let mut tail = deps::command("ffmpeg")?;
        out = tail
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-n",
                "-sseof",
                "-1",
                "-i",
            ])
            .arg(video)
            .args(["-an", "-vf", &filter, "-frames:v", "1", "-update", "1"])
            .arg(ffmpeg_file(path))
            .output()
            .map_err(|e| e.to_string())?;
    }
    if !out.status.success() || !path.is_file() {
        return Err(format!(
            "Frame extraction failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}
/// Extracts, optionally marks, and measures one frame.
fn export_frame(
    video: &Path,
    session: &Session,
    at: u64,
    path: PathBuf,
    style: FrameStyle,
    track: Option<&CursorTrack>,
) -> Result<FrameExport, String> {
    refuse_existing(&path)?;
    extract_frame(video, session.duration_ms, at, &path, style.max_width)?;
    let cursor = track.and_then(|track| track.at(at));
    let finished = (|| {
        if let (true, Some(point)) = (style.mark_cursor, &cursor) {
            cursor::mark_png(&path, point, style.max_width)?;
        }
        image::image_dimensions(&path).map_err(|e| format!("Exported frame could not be read: {e}"))
    })();
    // A frame that could not be finished is not left behind.
    let (width, height) = finished.inspect_err(|_| {
        let _ = fs::remove_file(&path);
    })?;
    Ok(FrameExport {
        path,
        time_ms: at,
        width,
        height,
        cursor,
        segment_id: None,
    })
}
/// `cue frame`: one frame at a time or at a phrase.
pub fn frame_at(
    store: &Store,
    id: &str,
    at: &FrameTime,
    output: Option<&Path>,
    style: FrameStyle,
) -> Result<FrameExport, String> {
    let session = store.session(id)?;
    let at = match at {
        FrameTime::AtMs(at) => *at,
        FrameTime::Phrase { phrase, occurrence } => {
            phrase_time(&store.transcript(id)?, phrase, *occurrence)?
        }
    };
    validate_range(session.duration_ms, at, None)?;
    let path = output_path(store, id, at, "png", output)?;
    let video = store.session_dir(id)?.join("video.mp4");
    export_frame(
        &video,
        &session,
        at,
        path,
        style,
        cursor::load(store, id).as_ref(),
    )
}
pub fn frame(store: &Store, id: &str, at: u64, output: Option<&Path>) -> Result<PathBuf, String> {
    frame_at(
        store,
        id,
        &FrameTime::AtMs(at),
        output,
        FrameStyle::default(),
    )
    .map(|f| f.path)
}
/// The last millisecond with a frame; segment and word seek points are
/// clamped to it so a final word aligned at the very end still exports.
fn last_ms(session: &Session) -> u64 {
    session.duration_ms.saturating_sub(1)
}
/// Runs `f` on every item with up to four workers, keeping the input order.
fn parallel_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let workers = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(4)
        .min(items.len());
    if workers <= 1 {
        return items.iter().map(f).collect();
    }
    let next = AtomicUsize::new(0);
    let results = Mutex::new((0..items.len()).map(|_| None).collect::<Vec<_>>());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(item) = items.get(index) else {
                    break;
                };
                let result = f(item);
                results.lock().unwrap_or_else(|e| e.into_inner())[index] = Some(result);
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .map(|result| result.expect("every index is processed once"))
        .collect()
}
/// Exports one new PNG per request into `dir`, in request order.
fn export_batch(
    store: &Store,
    session: &Session,
    requests: &[(u64, Option<String>)],
    dir: &Path,
    style: FrameStyle,
) -> Result<Vec<FrameExport>, String> {
    let video = store.session_dir(&session.id)?.join("video.mp4");
    let track = cursor::load(store, &session.id);
    export_all(requests, |(at, segment_id)| {
        export_frame(
            &video,
            session,
            *at,
            unique_name(dir, *at, "png"),
            style,
            track.as_ref(),
        )
        .map(|export| FrameExport {
            segment_id: segment_id.clone(),
            ..export
        })
        .map_err(|e| format!("Frame at {at} ms: {e}"))
    })
}
/// Runs `export` on every request, keeping their order. When one fails, the
/// frames the others wrote are deleted too, so a failed batch writes nothing.
fn export_all<T: Sync>(
    requests: &[T],
    export: impl Fn(&T) -> Result<FrameExport, String> + Sync,
) -> Result<Vec<FrameExport>, String> {
    let results = parallel_map(requests, export);
    if let Some(error) = results.iter().find_map(|result| result.as_ref().err()) {
        let error = error.clone();
        for written in results.iter().flatten() {
            let _ = fs::remove_file(&written.path);
        }
        return Err(error);
    }
    results.into_iter().collect()
}
/// `cue frames`: several frames in one call. Every time is validated before
/// the first export, and every frame gets a new file.
pub fn frames(
    store: &Store,
    id: &str,
    times: &FrameTimes,
    output_dir: Option<&Path>,
    style: FrameStyle,
) -> Result<Vec<FrameExport>, String> {
    let session = store.session(id)?;
    let requests: Vec<(u64, Option<String>)> = match times {
        FrameTimes::AtMs(times) => times.iter().map(|&at| (at, None)).collect(),
        FrameTimes::PerSegment => {
            let transcript = store.transcript(id)?;
            if transcript.segments.is_empty() {
                return Err(
                    "This session has no transcript segments. Transcribe it first, or pass --at-ms."
                        .into(),
                );
            }
            transcript
                .segments
                .iter()
                .map(|s| {
                    (
                        segment_seek_ms(s).min(last_ms(&session)),
                        Some(s.id.clone()),
                    )
                })
                .collect()
        }
    };
    if requests.is_empty() {
        return Err("Pass at least one time.".into());
    }
    for (at, _) in &requests {
        validate_range(session.duration_ms, *at, None).map_err(|e| format!("{at} ms: {e}"))?;
    }
    let dir = exports_dir(store, id, output_dir)?;
    export_batch(store, &session, &requests, &dir, style)
}

/// One spoken pointing moment, from `cue moments`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    pub segment_id: String,
    /// The matched words, normalized, for example `"look at this"`.
    pub term: String,
    /// The matched words as transcribed, punctuation included.
    pub phrase: String,
    /// Seek point of the first matched word.
    pub seek_ms: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    /// The whole segment's text.
    pub text: String,
    /// The pointer at `seek_ms`; `null` without a cursor track.
    pub cursor: Option<CursorPoint>,
    /// Presses within one second either side of `seek_ms`.
    pub clicks: Vec<Click>,
    /// The PNG exported at `seek_ms`, with `--frames`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<PathBuf>,
}
/// Clicks this close to a moment's seek point count as part of it.
const CLICK_WINDOW_MS: u64 = 1000;
/// Moments built from the transcript alone, without frames.
pub fn moments_in(transcript: &Transcript, track: Option<&CursorTrack>) -> Vec<Moment> {
    crate::cli::deictic_matches(transcript)
        .into_iter()
        .map(|found| {
            let segment = &transcript.segments[found.segment];
            let words = &segment.words[found.first..=found.last];
            let seek_ms = word_seek_ms(&words[0]);
            Moment {
                segment_id: segment.id.clone(),
                term: found.term,
                phrase: words
                    .iter()
                    .map(|w| w.text.trim())
                    .collect::<Vec<_>>()
                    .join(" "),
                seek_ms,
                start_ms: words[0].start_ms,
                end_ms: words[words.len() - 1].end_ms,
                text: segment.text.trim().to_owned(),
                cursor: track.and_then(|t| t.at(seek_ms)),
                clicks: track
                    .map(|t| {
                        t.clicks(
                            seek_ms.saturating_sub(CLICK_WINDOW_MS),
                            seek_ms.saturating_add(CLICK_WINDOW_MS),
                        )
                    })
                    .unwrap_or_default(),
                frame: None,
            }
        })
        .collect()
}
/// `cue moments`: pointing moments, optionally with a new frame for each.
pub fn moments(
    store: &Store,
    id: &str,
    with_frames: bool,
    style: FrameStyle,
) -> Result<Vec<Moment>, String> {
    let session = store.session(id)?;
    let transcript = store.transcript(id)?;
    let mut found = moments_in(&transcript, cursor::load(store, id).as_ref());
    if with_frames && !found.is_empty() {
        let requests: Vec<_> = found
            .iter()
            .map(|m| (m.seek_ms.min(last_ms(&session)), None))
            .collect();
        for (at, _) in &requests {
            validate_range(session.duration_ms, *at, None)?;
        }
        let dir = exports_dir(store, id, None)?;
        for (moment, export) in found
            .iter_mut()
            .zip(export_batch(store, &session, &requests, &dir, style)?)
        {
            moment.frame = Some(export.path);
        }
    }
    Ok(found)
}
pub fn clip(
    store: &Store,
    id: &str,
    start: u64,
    end: u64,
    output: Option<&Path>,
) -> Result<PathBuf, String> {
    let session = store.session(id)?;
    validate_range(session.duration_ms, start, Some(end))?;
    let path = output_path(store, id, start, "mp4", output)?;
    let mut cmd = deps::command("ffmpeg")?;
    let out = cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-ss",
            &format!("{:.3}", start as f64 / 1000.),
            "-i",
        ])
        .arg(store.session_dir(id)?.join("video.mp4"))
        .args([
            "-t",
            &format!("{:.3}", (end - start) as f64 / 1000.),
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
        ])
        .arg(ffmpeg_file(&path))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "Clip extraction failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let probe = deps::command("ffprobe")?
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "json",
        ])
        .arg(ffmpeg_file(&path))
        .output()
        .map_err(|e| e.to_string())?;
    if !probe.status.success() {
        return Err(format!(
            "Exported clip could not be verified: {}",
            String::from_utf8_lossy(&probe.stderr)
        ));
    }
    let info: serde_json::Value =
        serde_json::from_slice(&probe.stdout).map_err(|e| e.to_string())?;
    if info["streams"][0]["codec_type"].as_str() != Some("video") {
        let _ = fs::remove_file(&path);
        return Err("No video frames in the requested interval; widen the range.".into());
    }
    Ok(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Segment;
    #[test]
    fn phrase_matches_punctuation_across_segments() {
        let t = Transcript {
            segments: vec![
                Segment {
                    id: "1".into(),
                    start_ms: 0,
                    end_ms: 10,
                    text: "click".into(),
                    words: vec![Word {
                        text: "Click".into(),
                        start_ms: 0,
                        end_ms: 10,
                        seek_ms: Some(5),
                    }],
                },
                Segment {
                    id: "2".into(),
                    start_ms: 11,
                    end_ms: 20,
                    text: "here".into(),
                    words: vec![Word {
                        text: "here,".into(),
                        start_ms: 11,
                        end_ms: 20,
                        seek_ms: None,
                    }],
                },
            ],
            ..Default::default()
        };
        let m = find(&t, "click HERE").unwrap();
        assert_eq!(m[0].seek_ms, Some(5));
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].start_ms, 0);
        assert_eq!(m[0].end_ms, 20);
        assert!(find(&t, " ").is_err());
    }
    #[test]
    fn reject_invalid_clip_bounds() {
        assert!(validate_range(1000, 1000, None).is_err());
        assert!(validate_range(1000, 200, Some(100)).is_err());
        assert!(validate_range(1000, 0, Some(1001)).is_err());
        assert!(validate_range(1000, 0, Some(1000)).is_ok());
    }
    #[test]
    fn handoff_quotes_executable_and_data_directory() {
        let text = handoff_text(
            "Review",
            "session",
            Path::new("C:\\User's Tools\\cue.exe"),
            Path::new("D:\\Review's Data"),
            Path::new("D:\\Review's Data\\sessions\\session"),
        );
        let cue = if cfg!(windows) {
            assert!(text.contains("$env:CUEREVIEW_DATA_DIR = 'D:\\Review''s Data'"));
            "& 'C:\\User''s Tools\\cue.exe'"
        } else {
            assert!(text.contains("export CUEREVIEW_DATA_DIR='D:\\Review'\"'\"'s Data'"));
            "'C:\\User'\"'\"'s Tools\\cue.exe'"
        };
        // The recommended workflow, in order, then the other commands.
        let workflow = [
            "transcript 'session' --segments",
            "frames 'session' --per-segment --max-width 1600 --mark-cursor",
            "moments 'session'",
            "frame 'session' --at-ms SEEK_MS --max-width 1600 --mark-cursor",
            "clip 'session' --start-ms START_MS --end-ms END_MS",
        ];
        let mut from = 0;
        for step in workflow {
            let line = format!("{cue} {step}\n");
            let at = text[from..]
                .find(&line)
                .unwrap_or_else(|| panic!("{line:?} missing or out of order in:\n{text}"));
            from += at + line.len();
        }
        for other in [
            "transcript 'session' --json",
            "find 'session' --phrase 'here'",
            "frame 'session' --phrase 'here' --occurrence 1",
            "frames 'session' --at-ms '1000,2500,4000' --max-width 1600",
            "moments 'session' --frames --max-width 1600 --mark-cursor",
            "rename 'session' 'Short descriptive name'",
            "help frames",
        ] {
            assert!(
                text.contains(&format!("{cue} {other}\n")),
                "{other} missing"
            );
        }
        assert!(text.contains("Session folder: D:\\Review's Data\\sessions\\session\n"));
        assert!(text.contains("never overwrite"));
        // Every command the handoff names parses.
        for line in text
            .lines()
            .filter_map(|l| l.split_once(&format!("{cue} ")))
        {
            let args: Vec<String> = line
                .1
                .replace("'session'", "0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10")
                .replace('\'', "")
                .replace("SEEK_MS", "1")
                .replace("START_MS", "1")
                .replace("END_MS", "2")
                .replace("Short descriptive name", "Short")
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            crate::cli::parse(&args).unwrap_or_else(|e| panic!("{args:?}: {e}"));
        }
    }
    #[test]
    fn moments_carry_seek_points_segment_text_and_no_cursor_without_a_track() {
        let transcript = Transcript {
            segments: vec![
                Segment {
                    id: "segment-0".into(),
                    start_ms: 0,
                    end_ms: 900,
                    text: " I think that it works.".into(),
                    words: ["I", "think", "that", "it", "works."]
                        .iter()
                        .enumerate()
                        .map(|(i, w)| Word {
                            text: (*w).into(),
                            start_ms: i as u64 * 100,
                            end_ms: i as u64 * 100 + 90,
                            seek_ms: None,
                        })
                        .collect(),
                },
                Segment {
                    id: "segment-1".into(),
                    start_ms: 1000,
                    end_ms: 2000,
                    text: "Look at this, here.".into(),
                    words: vec![
                        Word {
                            text: "Look".into(),
                            start_ms: 1000,
                            end_ms: 1200,
                            seek_ms: Some(1100),
                        },
                        Word {
                            text: "at".into(),
                            start_ms: 1200,
                            end_ms: 1300,
                            seek_ms: None,
                        },
                        Word {
                            text: "this,".into(),
                            start_ms: 1300,
                            end_ms: 1600,
                            seek_ms: Some(1450),
                        },
                        Word {
                            text: "here.".into(),
                            start_ms: 1700,
                            end_ms: 2000,
                            seek_ms: None,
                        },
                    ],
                },
            ],
            ..Default::default()
        };
        let found = moments_in(&transcript, None);
        let summary: Vec<_> = found
            .iter()
            .map(|m| {
                (
                    m.segment_id.as_str(),
                    m.term.as_str(),
                    m.phrase.as_str(),
                    m.seek_ms,
                    m.start_ms,
                    m.end_ms,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "segment-1",
                    "look at this",
                    "Look at this,",
                    1100,
                    1000,
                    1600
                ),
                ("segment-1", "here", "here.", 1700, 1700, 2000),
            ]
        );
        let json = serde_json::to_value(&found[0]).unwrap();
        assert_eq!(json["text"], "Look at this, here.");
        assert!(json["cursor"].is_null() && json["clicks"] == serde_json::json!([]));
        assert!(json.get("frame").is_none());
        assert_eq!(segment_seek_ms(&transcript.segments[1]), 1100);
        assert_eq!(segment_seek_ms(&transcript.segments[0]), 0);

        // With a track, segments and words gain cursor; the struct itself never does.
        let with = transcript_with_cursor(&transcript, &CursorTrack::default());
        assert!(with["segments"][1]["cursor"].is_null());
        assert!(with["segments"][1]["words"][3]
            .as_object()
            .unwrap()
            .contains_key("cursor"));
        let plain = serde_json::to_value(&transcript).unwrap();
        assert!(plain["segments"][1].get("cursor").is_none());
    }
    #[test]
    fn cli_transcription_rejects_active_session_before_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("P").unwrap();
        let session = store
            .create_session(
                Some(&project.id),
                Some("S"),
                &crate::models::CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        assert!(transcribe_existing(&store, &session.id)
            .unwrap_err()
            .contains("active job"));
        assert_eq!(store.session(&session.id).unwrap().status, "recording");
    }
    fn session_in(store: &Store, takes: Vec<crate::models::Take>) -> String {
        let mut session = store
            .create_session(
                None,
                Some("Before"),
                &crate::models::CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: Some("mic:Studio".into()),
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        session.status = "error".into();
        session.takes = takes;
        store.save_session(&session).unwrap();
        session.id
    }
    /// What `attach_finished_video` records for a 3.5 s video.
    fn attached(store: &Store, session: &mut Session) -> Result<(), String> {
        session.video_path = Some(
            store
                .session_dir(&session.id)?
                .join("video.mp4")
                .to_string_lossy()
                .into(),
        );
        session.duration_ms = 3500;
        Ok(())
    }

    #[test]
    fn transcribing_again_never_loses_a_concurrent_rename() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let id = session_in(&store, Vec::new());
        let (done, renamed) = std::sync::mpsc::channel();
        let mut rename = None;
        let result = transcribe_existing_with(
            &store,
            &id,
            |store, session| {
                // `cue rename` runs while the video is being checked.
                let (cli, id, done) = (store.clone(), id.clone(), done.clone());
                rename = Some(std::thread::spawn(move || {
                    let result = cli.rename_session(&id, "Renamed from the CLI");
                    let _ = done.send(());
                    result
                }));
                let _ = renamed.recv_timeout(std::time::Duration::from_millis(300));
                attached(store, session)
            },
            |_, _| {
                Ok(Transcript {
                    status: Some("complete".into()),
                    ..Default::default()
                })
            },
        );
        assert!(result.is_ok());
        let rename = rename.unwrap().join().unwrap();
        let saved = store.session(&id).unwrap();
        assert_eq!(saved.status, "ready");
        assert_eq!(saved.duration_ms, 3500);
        // The rename is either kept or refused, never silently overwritten.
        match rename {
            Ok(_) => assert_eq!(saved.name, "Renamed from the CLI"),
            Err(error) => {
                assert!(error.contains("Finish recording and processing"), "{error}");
                assert_eq!(saved.name, "Before");
            }
        }
    }

    #[test]
    fn transcribing_a_session_with_takes_again_settles_every_take() {
        use crate::models::{Take, TakeStatus};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let take = |index, offset_ms, duration_ms, status| Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: crate::takes::folder_label(index),
            source_id: None,
            microphone_id: Some("mic:Studio".into()),
            system_audio: false,
        };
        let id = session_in(
            &store,
            vec![
                take(1, 0, 2000, TakeStatus::Error),
                take(2, 2000, 1500, TakeStatus::Error),
                take(3, 3500, 700, TakeStatus::Interrupted),
            ],
        );
        let folder = store.session_dir(&id).unwrap();
        let words = |text: &str| Transcript {
            segments: vec![Segment {
                id: "segment-0".into(),
                start_ms: 200,
                end_ms: 600,
                text: text.into(),
                words: vec![Word {
                    text: text.into(),
                    start_ms: 200,
                    end_ms: 600,
                    seek_ms: Some(250),
                }],
            }],
            status: Some("complete".into()),
            ..Default::default()
        };
        let media = |path: &Path, _: u64, _: bool| {
            Ok::<_, String>(words(if path == folder { "First" } else { "Second" }))
        };
        let transcript = transcribe_existing_with(&store, &id, attached, |store, id| {
            crate::transcribe::transcribe_with(store, id, &media)
        })
        .unwrap();
        let placed: Vec<_> = transcript
            .segments
            .iter()
            .map(|s| (s.id.as_str(), s.words[0].seek_ms))
            .collect();
        assert_eq!(
            placed,
            [("segment-0", Some(250)), ("t2-segment-0", Some(2250))]
        );
        let saved = store.session(&id).unwrap();
        assert_eq!(
            (saved.status.as_str(), saved.error.as_deref()),
            ("ready", None)
        );
        let statuses: Vec<_> = saved.takes.iter().map(|t| t.status).collect();
        assert_eq!(
            statuses,
            [
                TakeStatus::Ready,
                TakeStatus::Ready,
                TakeStatus::Interrupted
            ]
        );
        assert_eq!(saved.name, "Before", "a named session keeps its name");
        assert_eq!(store.transcript(&id).unwrap().takes.len(), 2);

        // A failure leaves the session in error with the take to retry.
        let failed = transcribe_existing_with(&store, &id, attached, |store, id| {
            crate::transcribe::transcribe_with(store, id, &|path: &Path, _, _| {
                if path == folder {
                    Ok(words("First"))
                } else {
                    Err("Install the local speech model.".to_string())
                }
            })
        });
        assert_eq!(failed.unwrap_err(), "Install the local speech model.");
        let saved = store.session(&id).unwrap();
        assert_eq!(saved.status, "error");
        assert_eq!(saved.takes[1].status, TakeStatus::Error);
        assert_eq!(crate::takes::retry_plan(&saved), [2]);
    }

    #[test]
    fn a_failed_frame_batch_removes_the_frames_it_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let export = |at: &u64| {
            let path = dir.path().join(format!("{at}.png"));
            fs::write(&path, b"png").unwrap();
            if *at == 3000 {
                return Err(format!("Frame at {at} ms: decoding failed"));
            }
            Ok(FrameExport {
                path,
                time_ms: *at,
                width: 1,
                height: 1,
                cursor: None,
                segment_id: None,
            })
        };
        let error = export_all(&[0, 1000, 2000, 3000, 4000], |at| {
            export(at).inspect_err(|_| {
                let _ = fs::remove_file(dir.path().join(format!("{at}.png")));
            })
        })
        .unwrap_err();
        assert_eq!(error, "Frame at 3000 ms: decoding failed");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
        let written = export_all(&[0, 1000], export).unwrap();
        assert_eq!(
            written.iter().map(|f| f.time_ms).collect::<Vec<_>>(),
            [0, 1000]
        );
        assert!(written.iter().all(|f| f.path.is_file()));
    }

    #[test]
    fn exports_refuse_urls_and_give_ffmpeg_only_local_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let id = session_in(&store, Vec::new());
        for url in [
            "pipe:1",
            "tcp://127.0.0.1:9999/frame.png",
            "file:frame.png",
            "http://example.com/clip.mp4",
            "data:image/png,x",
        ] {
            let error = output_path(&store, &id, 0, "png", Some(Path::new(url))).unwrap_err();
            assert!(error.contains("local file path"), "{url}: {error}");
            assert!(
                exports_dir(&store, &id, Some(Path::new(url))).is_err(),
                "{url}"
            );
        }
        // An output starting with a dash stays a file, not an FFmpeg option.
        let dashed = output_path(&store, &id, 0, "png", Some(Path::new("-y.png"))).unwrap();
        assert!(dashed.is_absolute() && dashed.ends_with("-y.png"));
        let argument = ffmpeg_file(&dashed);
        assert!(argument.to_string_lossy().starts_with("file:"));
        assert!(argument.to_string_lossy().ends_with("-y.png"));
        // Default exports and given folders are absolute local paths too.
        let default = output_path(&store, &id, 5, "png", None).unwrap();
        assert!(default.is_absolute() && default.starts_with(dir.path()));
        let given = dir.path().join("shots");
        assert_eq!(exports_dir(&store, &id, Some(&given)).unwrap(), given);
        #[cfg(windows)]
        assert!(local_path(Path::new(r"C:\Exports\frame.png")).is_ok());
        assert!(local_path(Path::new("./a:b.png")).is_ok());
    }

    #[test]
    fn repeated_phrases_keep_distinct_original_times() {
        let transcript = Transcript {
            segments: vec![Segment {
                id: "s".into(),
                start_ms: 100,
                end_ms: 2200,
                text: "Click here. Click here!".into(),
                words: vec![
                    Word {
                        text: "Click".into(),
                        start_ms: 100,
                        end_ms: 200,
                        seek_ms: None,
                    },
                    Word {
                        text: "here.".into(),
                        start_ms: 200,
                        end_ms: 300,
                        seek_ms: None,
                    },
                    Word {
                        text: "Click".into(),
                        start_ms: 2000,
                        end_ms: 2100,
                        seek_ms: None,
                    },
                    Word {
                        text: "here!".into(),
                        start_ms: 2100,
                        end_ms: 2200,
                        seek_ms: None,
                    },
                ],
            }],
            ..Default::default()
        };
        let found = find(&transcript, "click here").unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(
            (found[0].occurrence, found[0].start_ms, found[0].end_ms),
            (1, 100, 300)
        );
        assert_eq!(
            (found[1].occurrence, found[1].start_ms, found[1].end_ms),
            (2, 2000, 2200)
        );
        assert!(find(&transcript, "missing phrase").unwrap().is_empty());
    }
    #[test]
    #[ignore = "Requires FFmpeg/ffprobe; creates real video-only media and verifies final-frame/full-clip boundaries"]
    fn actual_last_frame_and_video_only_full_clip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("Boundary").unwrap();
        let mut session = store
            .create_session(
                Some(&project.id),
                Some("Video only"),
                &crate::models::CaptureConfig {
                    source_id: "test".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 2,
                },
            )
            .unwrap();
        let video = store.session_dir(&session.id).unwrap().join("video.mp4");
        let output=deps::command("ffmpeg").unwrap().args(["-y","-v","error","-f","lavfi","-i","color=c=red:s=64x64:r=2:d=1[a];color=c=blue:s=64x64:r=2:d=1[b];[a][b]concat=n=2:v=1:a=0","-an","-c:v","libx264","-pix_fmt","yuv420p"]).arg(&video).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        crate::attach_finished_video(&store, &mut session).unwrap();
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        let first = frame(&store, &session.id, 0, None).unwrap();
        let last = frame(&store, &session.id, session.duration_ms - 1, None).unwrap();
        let first = image::open(first).unwrap().to_rgb8();
        let last = image::open(last).unwrap().to_rgb8();
        assert!(first.get_pixel(32, 32)[0] > 200);
        assert!(
            last.get_pixel(32, 32)[2] > 200,
            "Last displayed frame should be blue"
        );
        assert!(frame(&store, &session.id, session.duration_ms, None).is_err());
        let empty = dir.path().join("empty.mp4");
        assert!(clip(
            &store,
            &session.id,
            session.duration_ms - 1,
            session.duration_ms,
            Some(&empty)
        )
        .unwrap_err()
        .contains("widen the range"));
        assert!(!empty.exists());
        let clip = clip(&store, &session.id, 0, session.duration_ms, None).unwrap();
        let probe = deps::command("ffprobe")
            .unwrap()
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type:format=duration",
                "-of",
                "json",
            ])
            .arg(&clip)
            .output()
            .unwrap();
        assert!(probe.status.success());
        let info: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
        let streams = info["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0]["codec_type"], "video");
        let duration: f64 = info["format"]["duration"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((duration - session.duration_ms as f64 / 1000.0).abs() < 0.1);
        let decoded = deps::command("ffmpeg")
            .unwrap()
            .args(["-v", "error", "-i"])
            .arg(clip)
            .args(["-f", "null", "-"])
            .output()
            .unwrap();
        assert!(decoded.status.success());
    }
    #[test]
    #[ignore = "Requires FFmpeg; exports scaled frame batches from real media and checks colours, sizes and no-overwrite"]
    fn actual_frames_batch_scaling_and_no_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let mut session = store
            .create_session(
                None,
                Some("Frames"),
                &crate::models::CaptureConfig {
                    source_id: "test".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 10,
                },
            )
            .unwrap();
        let folder = store.session_dir(&session.id).unwrap();
        // Two seconds red, then two seconds blue, at 640x360.
        let output = deps::command("ffmpeg")
            .unwrap()
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg("color=c=red:s=640x360:r=10:d=2[a];color=c=blue:s=640x360:r=10:d=2[b];[a][b]concat=n=2:v=1:a=0")
            .args(["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(folder.join("video.mp4"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        crate::attach_finished_video(&store, &mut session).unwrap();
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        let words = |items: &[(&str, u64)]| {
            items
                .iter()
                .map(|(text, start_ms)| Word {
                    text: (*text).into(),
                    start_ms: *start_ms,
                    end_ms: start_ms + 200,
                    seek_ms: None,
                })
                .collect::<Vec<_>>()
        };
        let transcript = Transcript {
            segments: vec![
                Segment {
                    id: "segment-0".into(),
                    start_ms: 500,
                    end_ms: 1200,
                    text: "Click here.".into(),
                    words: words(&[("Click", 500), ("here.", 900)]),
                },
                Segment {
                    id: "segment-1".into(),
                    start_ms: 2500,
                    end_ms: 3400,
                    text: "Now look at this.".into(),
                    words: words(&[("Now", 2500), ("look", 2800), ("at", 3000), ("this.", 3200)]),
                },
                // Alignment can place the last words past the final frame; they are clamped.
                Segment {
                    id: "segment-2".into(),
                    start_ms: 4100,
                    end_ms: 4500,
                    text: "Over there.".into(),
                    words: words(&[("Over", 4100), ("there.", 4300)]),
                },
            ],
            ..Default::default()
        };
        store.save_transcript(&session.id, &transcript).unwrap();
        let red = |path: &Path| {
            let pixel = *image::open(path).unwrap().to_rgb8().get_pixel(10, 10);
            pixel[0] > 200 && pixel[2] < 60
        };

        let style = FrameStyle {
            max_width: Some(320),
            mark_cursor: true,
        };
        let batch = frames(
            &store,
            &session.id,
            &FrameTimes::AtMs(vec![0, 1500, 3000, 3000]),
            None,
            style,
        )
        .unwrap();
        assert_eq!(
            batch.iter().map(|f| f.time_ms).collect::<Vec<_>>(),
            [0, 1500, 3000, 3000]
        );
        for export in &batch {
            assert_eq!((export.width, export.height), (320, 180));
            assert_eq!(image::image_dimensions(&export.path).unwrap(), (320, 180));
            assert!(export.cursor.is_none() && export.segment_id.is_none());
            assert!(export.path.starts_with(folder.join("exports")));
        }
        assert!(red(&batch[0].path) && red(&batch[1].path) && !red(&batch[2].path));
        assert_ne!(batch[2].path, batch[3].path, "same time, new file");
        let json = serde_json::to_value(&batch[0]).unwrap();
        assert!(json["cursor"].is_null() && json.get("segmentId").is_none());

        // Without --max-width the native size stays; a larger limit never upscales.
        let native = frame_at(
            &store,
            &session.id,
            &FrameTime::AtMs(100),
            None,
            FrameStyle {
                max_width: Some(4000),
                mark_cursor: false,
            },
        )
        .unwrap();
        assert_eq!((native.width, native.height), (640, 360));

        let per_segment_dir = dir.path().join("per segment");
        let per_segment = frames(
            &store,
            &session.id,
            &FrameTimes::PerSegment,
            Some(&per_segment_dir),
            style,
        )
        .unwrap();
        let last = session.duration_ms - 1;
        assert!((3900..4100).contains(&session.duration_ms));
        assert_eq!(
            per_segment
                .iter()
                .map(|f| (f.time_ms, f.segment_id.as_deref().unwrap()))
                .collect::<Vec<_>>(),
            [(500, "segment-0"), (2500, "segment-1"), (last, "segment-2")]
        );
        assert!(per_segment
            .iter()
            .all(|f| f.path.starts_with(&per_segment_dir) && f.path.is_absolute()));
        assert!(
            red(&per_segment[0].path) && !red(&per_segment[1].path) && !red(&per_segment[2].path)
        );

        // Moments keep the spoken seek point; the clamped one still exports a frame.
        let found = moments(&store, &session.id, true, style).unwrap();
        assert_eq!(
            found
                .iter()
                .map(|m| (m.term.as_str(), m.seek_ms))
                .collect::<Vec<_>>(),
            [("here", 900), ("look at this", 2800), ("over there", 4100)]
        );
        for moment in &found {
            let frame = moment.frame.as_ref().unwrap();
            assert_eq!(image::image_dimensions(frame).unwrap(), (320, 180));
        }

        // Existing files are never overwritten, by frame or by frames.
        let target = dir.path().join("taken.png");
        fs::write(&target, b"keep").unwrap();
        let error = frame_at(
            &store,
            &session.id,
            &FrameTime::Phrase {
                phrase: "click here".into(),
                occurrence: 1,
            },
            Some(&target),
            style,
        )
        .unwrap_err();
        assert!(error.contains("Output exists"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        let before: Vec<_> = batch.iter().map(|f| fs::read(&f.path).unwrap()).collect();
        frames(
            &store,
            &session.id,
            &FrameTimes::AtMs(vec![0, 1500, 3000, 3000]),
            None,
            style,
        )
        .unwrap();
        let after: Vec<_> = batch.iter().map(|f| fs::read(&f.path).unwrap()).collect();
        assert_eq!(before, after);
        assert_eq!(
            fs::read_dir(folder.join("exports")).unwrap().count(),
            4 + 1 + 3 + 4
        );

        // Out-of-range times fail before anything is written.
        let error = frames(
            &store,
            &session.id,
            &FrameTimes::AtMs(vec![0, session.duration_ms]),
            Some(&dir.path().join("never")),
            style,
        )
        .unwrap_err();
        assert!(error.contains("within the recording"), "{error}");
        assert!(!dir.path().join("never").exists());
    }
}
