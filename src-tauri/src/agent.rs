use crate::{
    deps,
    models::{Transcript, Word},
    store::Store,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
pub fn handoff(store: &Store, id: &str) -> Result<String, String> {
    let s = store.session(id)?;
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name(if cfg!(windows) { "cue.exe" } else { "cue" });
    let root = std::path::absolute(&store.root).map_err(|e| e.to_string())?;
    Ok(handoff_text(
        &s.name,
        id,
        &exe,
        &root,
        &store.session_dir(id)?,
    ))
}
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn handoff_text(name: &str, id: &str, exe: &Path, root: &Path, folder: &Path) -> String {
    let command = format!("& {}", ps_quote(&exe.to_string_lossy()));
    let session = ps_quote(id);
    format!("Review CueReview session {id} ({name}) locally. Run these commands in PowerShell.\n\nUse the same local data directory as the app:\n$env:CUEREVIEW_DATA_DIR = {}\n\nRead word timestamps:\n{command} transcript {session} --json\n\nFind a visual reference (replace the example phrase):\n{command} find {session} --phrase 'here'\n\nInspect its frame:\n{command} frame {session} --phrase 'here' --occurrence 1\n\nExport a clip using millisecond bounds from the transcript:\n{command} clip {session} --start-ms START_MS --end-ms END_MS\n\nSession folder: {}\nThe CLI is installed beside CueReview; use its full path as shown. Prefer seekMs, when present, for word-to-visual lookup; startMs/endMs retain the original model intervals. All timestamps are estimates; inspect surrounding frames when ambiguous.",ps_quote(&root.to_string_lossy()),folder.display())
}
pub fn transcribe_existing(store: &Store, id: &str) -> Result<Transcript, String> {
    let mut session = store.session(id)?;
    if matches!(session.status.as_str(), "recording" | "processing") {
        return Err("This session is recording or processing. Finish its active job first; reopen CueReview to recover an interrupted session.".into());
    }
    // Verify real video before a silent/no-audio session can complete successfully.
    crate::attach_finished_video(store, &mut session)?;
    session.status = "processing".into();
    session.error = None;
    store.save_session(&session)?;
    let result = crate::transcribe::transcribe(store, id);
    session.status = if result.is_ok() { "ready" } else { "error" }.into();
    session.error = result.as_ref().err().cloned();
    store.save_session(&session)?;
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
}
fn normalized(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
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
fn output_path(
    store: &Store,
    id: &str,
    at: u64,
    extension: &str,
    requested: Option<&Path>,
) -> Result<PathBuf, String> {
    let path = if let Some(path) = requested {
        path.to_path_buf()
    } else {
        let dir = store.session_dir(id)?.join("exports");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        dir.join(format!("{at}-{}.{}", uuid::Uuid::new_v4(), extension))
    };
    if path.exists() {
        return Err(format!(
            "Output exists; choose another path: {}",
            path.display()
        ));
    }
    Ok(path)
}
pub fn frame(store: &Store, id: &str, at: u64, output: Option<&Path>) -> Result<PathBuf, String> {
    let session = store.session(id)?;
    validate_range(session.duration_ms, at, None)?;
    let path = output_path(store, id, at, "png", output)?;
    let mut cmd = deps::command("ffmpeg")?;
    let mut out = cmd
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-n",
            "-ss",
            &format!("{:.3}", at as f64 / 1000.),
            "-i",
        ])
        .arg(store.session_dir(id)?.join("video.mp4"))
        .args(["-frames:v", "1", "-update", "1"])
        .arg(&path)
        .output()
        .map_err(|e| e.to_string())?;
    // Accurate seeking can land after the last frame's PTS while still inside its
    // displayed duration. Decode at most the final second and return its last frame.
    if out.status.success() && !path.is_file() && at >= session.duration_ms.saturating_sub(1000) {
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
            .arg(store.session_dir(id)?.join("video.mp4"))
            .args(["-an", "-vf", "reverse", "-frames:v", "1", "-update", "1"])
            .arg(&path)
            .output()
            .map_err(|e| e.to_string())?;
    }
    if !out.status.success() || !path.is_file() {
        return Err(format!(
            "Frame extraction failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(path)
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
        .arg(&path)
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
        .arg(&path)
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
        assert!(text.contains("& 'C:\\User''s Tools\\cue.exe' transcript 'session' --json"));
        assert!(text.contains("$env:CUEREVIEW_DATA_DIR = 'D:\\Review''s Data'"));
    }
    #[test]
    fn cli_transcription_rejects_active_session_before_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("P").unwrap();
        let session = store
            .create_session(
                &project.id,
                "S",
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
                &project.id,
                "Video only",
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
}
