use crate::{
    deps,
    models::{Segment, Transcript, Word},
    store::{atomic_write, Store},
};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

// Avoid carrying mistaken text into later windows or retrying noise at higher temperatures.
// This reduces silence hallucinations, but is not a replacement for speech activity detection.
const DECODING_OPTIONS: &[&str] = &[
    "-l", "auto", "-ojf", "-ng", "-mc", "0", "-nf", "-nth", "0.3",
];
fn dtw_preset(custom_model: bool, requested: Option<&str>) -> Result<Option<String>, String> {
    let preset = if custom_model {
        requested
    } else {
        Some("base")
    };
    match preset {
        None => Ok(None),
        Some(name) if matches!(name, "tiny" | "tiny.en" | "base" | "base.en" | "small" | "small.en" | "medium" | "medium.en" | "large.v1" | "large.v2" | "large.v3" | "large.v3.turbo") => Ok(Some(name.into())),
        Some(_) => Err("CUEREVIEW_DTW_MODEL must name a supported Whisper alignment preset (for example base or base.en).".into()),
    }
}
fn alignment_options(command: &mut std::process::Command) -> Result<(), String> {
    let requested = std::env::var("CUEREVIEW_DTW_MODEL").ok();
    if let Some(preset) = dtw_preset(
        std::env::var_os("CUEREVIEW_MODEL").is_some(),
        requested.as_deref(),
    )? {
        command.args(["-dtw", &preset, "-nfa"]);
    }
    Ok(())
}
fn token_anchor(token: &Value) -> Option<u64> {
    // CLI serializes this integer centisecond count as a JSON float.
    let time = token["t_dtw"].as_f64()?;
    if !time.is_finite() || time < 0.0 || time.fract() != 0.0 || time >= u64::MAX as f64 {
        return None;
    }
    (time as u64).checked_mul(10)
}

/// Keep raw whisper output beside normalized words: timings are model estimates,
/// never synthesized by evenly dividing a sentence.
pub fn parse_whisper(value: &Value) -> Result<Transcript, String> {
    let entries = value["transcription"]
        .as_array()
        .ok_or("Whisper output has no transcription array.")?;
    let mut segments = vec![];
    for (index, item) in entries.iter().enumerate() {
        let text = item["text"].as_str().unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let mut words: Vec<Word> = vec![];
        if let Some(tokens) = item["tokens"].as_array() {
            for token in tokens {
                let raw = token["text"].as_str().unwrap_or("");
                if raw.trim().is_empty() || raw.starts_with("[_") || raw.starts_with("<|") {
                    continue;
                }
                let Some(start) = token["offsets"]["from"].as_u64() else {
                    continue;
                };
                let Some(end) = token["offsets"]["to"].as_u64() else {
                    continue;
                };
                if end < start {
                    continue;
                }
                let starts_word = raw.starts_with(char::is_whitespace) || words.is_empty();
                if starts_word {
                    words.push(Word {
                        text: raw.trim().into(),
                        start_ms: start,
                        end_ms: end,
                        seek_ms: token_anchor(token),
                    });
                } else if let Some(last) = words.last_mut() {
                    last.text.push_str(raw);
                    last.end_ms = last.end_ms.max(end);
                    if last.seek_ms.is_none() {
                        last.seek_ms = token_anchor(token);
                    }
                }
            }
        }
        if words.is_empty() {
            return Err("Speech was recognized without usable word timestamps. Raw output is retained; retry transcription.".into());
        }
        let start_ms = words.first().unwrap().start_ms;
        let end_ms = words.last().unwrap().end_ms;
        segments.push(Segment {
            id: format!("segment-{index}"),
            start_ms,
            end_ms,
            text,
            words,
        });
    }
    Ok(Transcript {
        segments,
        language: value["result"]["language"].as_str().map(str::to_owned),
        status: Some("complete".into()),
        error: None,
    })
}
fn run_logged(mut command: std::process::Command, log: &Path) -> Result<(), String> {
    let file = fs::File::create(log).map_err(|e| e.to_string())?;
    let status = command
        .stdout(Stdio::null())
        .stderr(file)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        let detail = fs::read_to_string(log).unwrap_or_default();
        return Err(format!(
            "Processing failed ({status}): {}",
            detail
                .chars()
                .rev()
                .take(1800)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(())
}
fn run_live(command: std::process::Command, log: &Path, cancel: &AtomicBool) -> Result<(), String> {
    run_live_output(command, log, cancel, None)
}
fn run_live_output(
    mut command: std::process::Command,
    log: &Path,
    cancel: &AtomicBool,
    output: Option<&Path>,
) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Live transcription cancelled.".into());
    }
    let file = fs::File::create(log).map_err(|e| e.to_string())?;
    let stdout = match output {
        Some(path) => Stdio::from(fs::File::create(path).map_err(|e| e.to_string())?),
        None => Stdio::null(),
    };
    let mut child = command
        .stdout(stdout)
        .stderr(file)
        .spawn()
        .map_err(|e| e.to_string())?;
    loop {
        if cancel.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Live transcription cancelled.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "Local speech processing failed ({status}); see {}.",
                        log.display()
                    ))
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    }
}
fn vad_count(output: &str) -> Result<usize, String> {
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let count = lines
        .next()
        .and_then(|line| line.strip_prefix("Detected "))
        .and_then(|line| line.strip_suffix(" speech segments:"))
        .filter(|count| !count.is_empty() && count.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|count| count.parse::<usize>().ok())
        .ok_or("Speech detector returned an invalid result; see vad.txt.")?;
    let regions: Vec<_> = lines.collect();
    if regions.len() != count
        || regions
            .iter()
            .enumerate()
            .any(|(i, line)| !line.starts_with(&format!("Speech segment {i}: start = ")))
    {
        return Err("Speech detector returned inconsistent regions; see vad.txt.".into());
    }
    Ok(count)
}
// Gate only wholly speech-free inputs. Never crop audio: the pinned CLI's --vad
// JSON token times are not mapped back to the original recording timeline.
fn has_speech(speech: &Path, folder: &Path, cancel: &AtomicBool) -> Result<bool, String> {
    let mut detector = deps::command("whisper-vad-speech-segments")?;
    detector
        .args(["-vm"])
        .arg(deps::vad_model_path())
        .arg("-f")
        .arg(speech)
        .args(["-vt", "0.35", "-vp", "500", "-vspd", "100", "-np"]);
    let output = folder.join("vad.txt");
    run_live_output(detector, &folder.join("vad.log"), cancel, Some(&output))?;
    Ok(vad_count(&fs::read_to_string(output).map_err(|e| e.to_string())?)? > 0)
}
fn empty_transcript() -> Transcript {
    Transcript {
        status: Some("complete".into()),
        ..Default::default()
    }
}
fn accept_whisper_output(prefix: &Path, folder: &Path) -> Result<Transcript, String> {
    let fresh = prefix.with_extension("json");
    let bytes = fs::read(&fresh).map_err(|error| format!(
        "The speech runtime produced no readable fresh transcript ({}: {error}). Reinstall local transcription and retry; see transcription.log. Previous raw output was retained.",
        fresh.display()
    ))?;
    let raw: Value = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Invalid fresh transcript {}: {error}. Previous raw output was retained.",
            fresh.display()
        )
    })?;
    let transcript = parse_whisper(&raw)?;
    atomic_write(&folder.join("whisper.json"), &bytes)?;
    let _ = fs::remove_file(fresh);
    Ok(transcript)
}
/// Only scratch files are written here; final session transcript files are untouched.
pub fn transcribe_snapshot(
    source: &Path,
    folder: &Path,
    cancel: &AtomicBool,
) -> Result<Transcript, String> {
    let speech = folder.join("speech.wav");
    let mut ffmpeg = deps::command("ffmpeg")?;
    ffmpeg
        .args(["-hide_banner", "-y", "-i"])
        .arg(source)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&speech);
    run_live(ffmpeg, &folder.join("transcode.log"), cancel)?;
    if !has_speech(&speech, folder, cancel)? {
        return Ok(empty_transcript());
    }
    let mut whisper = deps::command("whisper-cli")?;
    alignment_options(&mut whisper)?;
    let prefix = folder.join(format!("whisper-{}", uuid::Uuid::new_v4()));
    whisper
        .arg("-m")
        .arg(deps::model_path())
        .arg("-f")
        .arg(&speech)
        .args(DECODING_OPTIONS)
        .args(["-t", "2", "-of"])
        .arg(&prefix);
    run_live(whisper, &folder.join("transcription.log"), cancel)?;
    accept_whisper_output(&prefix, folder)
}
/// Replace the overlapping provisional tail, retaining words wholly before the snapshot.
pub fn merge_live(
    previous: &Transcript,
    mut update: Transcript,
    start_ms: u64,
    end_ms: u64,
) -> Transcript {
    let mut segments = Vec::new();
    for segment in &previous.segments {
        let words: Vec<_> = segment
            .words
            .iter()
            .filter(|w| {
                w.seek_ms
                    .map_or(w.end_ms <= start_ms, |seek| seek < start_ms)
            })
            .cloned()
            .collect();
        if let (Some(first), Some(last)) = (words.first(), words.last()) {
            segments.push(Segment {
                id: segment.id.clone(),
                start_ms: first.start_ms,
                end_ms: last.end_ms,
                text: words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                words,
            });
        }
    }
    for (index, segment) in update.segments.drain(..).enumerate() {
        let words: Vec<_> = segment
            .words
            .into_iter()
            .filter_map(|word| {
                let start = word.start_ms.saturating_add(start_ms);
                let raw_end = word.end_ms.saturating_add(start_ms);
                let seek_ms = word
                    .seek_ms
                    .and_then(|seek| seek.checked_add(start_ms))
                    .filter(|seek| *seek < end_ms);
                // Alignment decides inclusion when present. Preserve its raw interval
                // rather than manufacturing a boundary from an unrelated estimate.
                let (include, end) = if word.seek_ms.is_some() {
                    (seek_ms.is_some(), raw_end)
                } else {
                    let end = raw_end.min(end_ms);
                    (start < end && start < end_ms, end)
                };
                include.then_some(Word {
                    text: word.text,
                    start_ms: start,
                    end_ms: end,
                    seek_ms,
                })
            })
            .collect();
        if let (Some(first), Some(last)) = (words.first(), words.last()) {
            segments.push(Segment {
                id: format!("live-{start_ms}-{index}"),
                start_ms: first.start_ms,
                end_ms: last.end_ms,
                text: words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                words,
            });
        }
    }
    Transcript {
        segments,
        language: update.language.or_else(|| previous.language.clone()),
        status: Some("provisional".into()),
        error: None,
    }
}
pub fn transcribe(store: &Store, id: &str) -> Result<Transcript, String> {
    let folder = store.session_dir(id)?;
    let session = store.session(id)?;
    if session.microphone_id.is_none() && !session.system_audio {
        let t = Transcript {
            status: Some("complete".into()),
            ..Default::default()
        };
        store.save_transcript(id, &t)?;
        return Ok(t);
    }
    let mic = folder.join("mic.wav");
    let mix = folder.join("audio.wav");
    let source = if mic.exists() {
        mic
    } else if mix.exists() {
        mix
    } else {
        folder.join("video.mp4")
    };
    if !deps::model_path().is_file() {
        return Err(
            "Install the local speech model, then retry transcription. Your recording is saved."
                .into(),
        );
    }
    let speech = folder.join("speech.wav");
    let mut ffmpeg = deps::command("ffmpeg")?;
    ffmpeg
        .args(["-hide_banner", "-y", "-i"])
        .arg(source)
        .args([
            "-t",
            &format!("{:.3}", session.duration_ms as f64 / 1000.),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&speech);
    run_logged(ffmpeg, &folder.join("transcode.log"))?;
    if !has_speech(&speech, &folder, &AtomicBool::new(false))? {
        let transcript = empty_transcript();
        store.save_transcript(id, &transcript)?;
        return Ok(transcript);
    }
    let mut whisper = deps::command("whisper-cli")?;
    alignment_options(&mut whisper)?;
    let prefix = folder.join(format!("whisper-{}", uuid::Uuid::new_v4()));
    whisper
        .arg("-m")
        .arg(deps::model_path())
        .arg("-f")
        .arg(speech)
        .args(DECODING_OPTIONS)
        .arg("-of")
        .arg(&prefix);
    run_logged(whisper, &folder.join("transcription.log"))?;
    let transcript = accept_whisper_output(&prefix, &folder)?;
    store.save_transcript(id, &transcript)?;
    Ok(transcript)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::read_json;
    use serde_json::json;
    #[test]
    fn successful_process_cannot_reuse_old_or_malformed_output() {
        let folder = tempfile::tempdir().unwrap();
        let canonical = folder.path().join("whisper.json");
        let original = br#"{"transcription":[{"text":"old","tokens":[{"text":" old","offsets":{"from":10,"to":20}}]}]}"#;
        fs::write(&canonical, original).unwrap();
        let prefix = folder
            .path()
            .join(format!("whisper-{}", uuid::Uuid::new_v4()));
        // A genuine successful subprocess that writes no transcript, like an
        // incompatible runtime exiting successfully after printing usage.
        let mut no_output = std::process::Command::new(std::env::current_exe().unwrap());
        no_output.arg("--list");
        run_logged(no_output, &folder.path().join("transcription.log")).unwrap();
        assert!(accept_whisper_output(&prefix, folder.path())
            .unwrap_err()
            .contains("fresh transcript"));
        assert_eq!(fs::read(&canonical).unwrap(), original);
        let fresh = prefix.with_extension("json");
        for malformed in [
            b"{broken".as_slice(),
            br#"{"transcription":[{"text":"untimed","tokens":[]}]}"#,
        ] {
            fs::write(&fresh, malformed).unwrap();
            assert!(accept_whisper_output(&prefix, folder.path()).is_err());
            assert_eq!(fs::read(&canonical).unwrap(), original);
            assert_eq!(fs::read(&fresh).unwrap(), malformed);
        }
        let valid = b"{\n  \"transcription\": []\n}\n";
        fs::write(&fresh, valid).unwrap();
        assert!(accept_whisper_output(&prefix, folder.path())
            .unwrap()
            .segments
            .is_empty());
        assert_eq!(fs::read(&canonical).unwrap(), valid);
        assert!(!fresh.exists());
    }
    #[test]
    fn anchors_preserve_raw_intervals_and_old_transcripts() {
        let raw = json!({"transcription":[{"text":"click here", "tokens":[
            {"text":" click","offsets":{"from":0,"to":1300},"t_dtw":1022.0},
            {"text":" he","offsets":{"from":1300,"to":1400},"t_dtw":-1},
            {"text":"re","offsets":{"from":1400,"to":1500},"t_dtw":1040},
            {"text":".","offsets":{"from":1500,"to":1500},"t_dtw":1050}
        ]}]});
        let transcript = parse_whisper(&raw).unwrap();
        let words = &transcript.segments[0].words;
        assert_eq!(
            (words[0].start_ms, words[0].end_ms, words[0].seek_ms),
            (0, 1300, Some(10220))
        );
        assert_eq!(
            (
                words[1].text.as_str(),
                words[1].start_ms,
                words[1].end_ms,
                words[1].seek_ms
            ),
            ("here.", 1300, 1500, Some(10400))
        );
        let old: Word =
            serde_json::from_value(json!({"text":"old","startMs":10,"endMs":20})).unwrap();
        assert_eq!(old.seek_ms, None);
        assert!(serde_json::to_value(old).unwrap().get("seekMs").is_none());
        for invalid in [
            json!(-1),
            json!(1.5),
            json!("1022"),
            json!(null),
            json!(u64::MAX),
            json!(1e30),
        ] {
            assert_eq!(token_anchor(&json!({"t_dtw":invalid})), None);
        }
        assert_eq!(token_anchor(&json!({"t_dtw":0.0})), Some(0));
    }
    #[test]
    fn custom_models_require_an_explicit_alignment_preset() {
        assert_eq!(dtw_preset(false, None).unwrap().as_deref(), Some("base"));
        assert_eq!(dtw_preset(true, None).unwrap(), None);
        assert_eq!(
            dtw_preset(true, Some("base.en")).unwrap().as_deref(),
            Some("base.en")
        );
        assert!(dtw_preset(true, Some("guessed-file-name")).is_err());
    }
    #[test]
    fn live_anchors_control_overlap_and_preserve_zero_duration_words() {
        let mut previous = sample_transcript(&[("old", 0, 1300)]);
        previous.segments[0].words[0].seek_ms = Some(10220);
        let mut update = sample_transcript(&[
            ("When", 0, 0),
            ("outside", 0, 1000),
            ("overflow", 0, 0),
            ("bad interval", 10000, 11000),
        ]);
        update.segments[0].words[0].seek_ms = Some(5220);
        update.segments[0].words[1].seek_ms = Some(7000);
        update.segments[0].words[2].seek_ms = Some(u64::MAX);
        update.segments[0].words[3].seek_ms = Some(6000);
        let merged = merge_live(&previous, update, 5000, 12000);
        let words: Vec<_> = merged.segments.iter().flat_map(|s| &s.words).collect();
        assert_eq!(words.len(), 2);
        assert_eq!(
            (
                words[0].text.as_str(),
                words[0].start_ms,
                words[0].end_ms,
                words[0].seek_ms
            ),
            ("When", 5000, 5000, Some(10220))
        );
        assert_eq!(
            (words[1].start_ms, words[1].end_ms, words[1].seek_ms),
            (15000, 16000, Some(11000))
        );
    }
    #[test]
    fn detector_requires_explicit_consistent_count() {
        assert_eq!(vad_count("\nDetected 0 speech segments:\n").unwrap(), 0);
        assert_eq!(
            vad_count("Detected 1 speech segments:\nSpeech segment 0: start = 1.00, end = 50.00\n")
                .unwrap(),
            1
        );
        for invalid in [
            "",
            "error loading model",
            "Detected -1 speech segments:",
            "Detected 999999999999999999999999999 speech segments:",
            "Detected 1 speech segments:",
            "Detected 0 speech segments:\nSpeech segment 0: start = 0, end = 1",
            "Detected 0 speech segments:\nDetected 0 speech segments:",
            "Detected 1 speech segments:\nSpeech segment 2: start = 0, end = 1",
        ] {
            assert!(
                vad_count(invalid).is_err(),
                "Accepted invalid detector output: {invalid}"
            );
        }
    }
    #[test]
    fn merges_subwords_and_punctuation_preserving_offsets() {
        let raw = json!({"result":{"language":"en"},"transcription":[{"text":"Click here, please.","tokens":[
            {"text":"[_BEG_]","offsets":{"from":0,"to":0}},
            {"text":" Click","offsets":{"from":100,"to":230}},
            {"text":" he","offsets":{"from":240,"to":300}},
            {"text":"re","offsets":{"from":300,"to":350}},
            {"text":",","offsets":{"from":350,"to":350}},
            {"text":" please","offsets":{"from":400,"to":500}},
            {"text":".","offsets":{"from":500,"to":500}}]}]});
        let t = parse_whisper(&raw).unwrap();
        let w = &t.segments[0].words;
        assert_eq!(w.len(), 3);
        assert_eq!(w[1].text, "here,");
        assert_eq!(w[1].start_ms, 240);
        assert_eq!(w[1].end_ms, 350);
    }
    #[test]
    fn refuses_invented_timing() {
        assert!(parse_whisper(&json!({"transcription":[{"text":"hello","tokens":[]}]})).is_err());
    }
    #[test]
    fn silent_audio_is_valid() {
        assert!(parse_whisper(&json!({"transcription":[]}))
            .unwrap()
            .segments
            .is_empty());
    }
    fn sample_transcript(words: &[(&str, u64, u64)]) -> Transcript {
        Transcript {
            segments: vec![Segment {
                id: "original".into(),
                start_ms: words.first().unwrap().1,
                end_ms: words.last().unwrap().2,
                text: words.iter().map(|w| w.0).collect::<Vec<_>>().join(" "),
                words: words
                    .iter()
                    .map(|w| Word {
                        text: w.0.into(),
                        start_ms: w.1,
                        end_ms: w.2,
                        seek_ms: None,
                    })
                    .collect(),
            }],
            language: Some("en".into()),
            ..Default::default()
        }
    }
    #[test]
    fn live_merge_offsets_words_and_replaces_overlapping_tail() {
        let previous = sample_transcript(&[
            ("keep", 1000, 2000),
            ("boundary", 4000, 5000),
            ("revise", 4900, 5500),
            ("old", 6000, 7000),
        ]);
        let update = sample_transcript(&[("corrected", 100, 500), ("new", 600, 1200)]);
        let merged = merge_live(&previous, update, 5000, 6500);
        let words: Vec<_> = merged.segments.iter().flat_map(|s| &s.words).collect();
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            vec!["keep", "boundary", "corrected", "new"]
        );
        assert_eq!((words[2].start_ms, words[2].end_ms), (5100, 5500));
        assert_eq!(
            (merged.segments[0].end_ms, merged.segments[1].start_ms),
            (5000, 5100)
        );
        assert_eq!(merged.segments[0].text, "keep boundary");
        assert_eq!(merged.status.as_deref(), Some("provisional"));
    }
    #[test]
    fn silent_live_update_removes_revised_tail_without_changing_earlier_words() {
        let previous = sample_transcript(&[("keep", 1000, 2000), ("false", 6000, 7000)]);
        let merged = merge_live(&previous, Transcript::default(), 5000, 8000);
        assert_eq!(merged.segments.len(), 1);
        assert_eq!(merged.segments[0].text, "keep");
        assert_eq!(merged.language.as_deref(), Some("en"));
    }
    #[test]
    fn live_words_cannot_run_past_captured_audio() {
        let update = sample_transcript(&[("trim", 500, 2000), ("outside", 2500, 3000)]);
        let merged = merge_live(&Transcript::default(), update, 10000, 11000);
        assert_eq!(merged.segments[0].words.len(), 1);
        assert_eq!(merged.segments[0].words[0].end_ms, 11000);
    }
    #[test]
    #[ignore = "Requires FFmpeg; verifies live subprocess cancellation"]
    fn cancelling_live_job_terminates_its_media_process() {
        let dir = tempfile::tempdir().unwrap();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            signal.store(true, Ordering::Release);
        });
        let mut command = deps::command("ffmpeg").unwrap();
        command.args([
            "-v",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=16000:cl=mono",
            "-t",
            "60",
            "-f",
            "null",
            "-",
        ]);
        let began = std::time::Instant::now();
        let error = run_live(command, &dir.path().join("cancel.log"), &cancelled).unwrap_err();
        trigger.join().unwrap();
        assert!(error.contains("cancelled"));
        assert!(began.elapsed() < Duration::from_secs(5));
    }
    #[test]
    #[ignore = "Requires installed Whisper/model and test-results/speech/reference.wav from verify-pipeline.ps1"]
    fn actual_whisper_snapshot_keeps_absolute_offsets_and_cancels() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let source = root.join("test-results/speech/reference.wav");
        let folder = root.join("test-results/live-transcription");
        fs::create_dir_all(&folder).unwrap();
        let wav = hound::WavReader::open(&source).unwrap();
        let duration_ms = wav.duration() as u64 * 1000 / wav.spec().sample_rate as u64;
        let update = transcribe_snapshot(&source, &folder, &AtomicBool::new(false)).unwrap();
        let transcript = merge_live(&Transcript::default(), update, 30000, 30000 + duration_ms);
        let phrases = crate::agent::find(&transcript, "click here").unwrap();
        assert!(!phrases.is_empty());
        assert!(phrases[0].start_ms >= 30000);
        assert!(phrases[0].end_ms <= 30000 + duration_ms);
        assert!(transcript
            .segments
            .iter()
            .flat_map(|s| &s.words)
            .all(|w| w.start_ms >= 30000 && w.end_ms <= 30000 + duration_ms));
        fs::write(
            folder.join("absolute-transcript.json"),
            serde_json::to_vec_pretty(&transcript).unwrap(),
        )
        .unwrap();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        let cancel_dir = folder.join("cancelled");
        fs::create_dir_all(&cancel_dir).unwrap();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            signal.store(true, Ordering::Release);
        });
        let began = std::time::Instant::now();
        let result = transcribe_snapshot(&source, &cancel_dir, &cancelled);
        trigger.join().unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(began.elapsed() < Duration::from_secs(5));
    }
    #[test]
    #[ignore = "Requires installed Whisper/model, speech/reference.wav and silence-check/quiet-noise.wav fixtures"]
    fn actual_quiet_noise_is_empty_and_quiet_speech_is_preserved() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let noise = root.join("test-results/silence-check/quiet-noise.wav");
        let output = root.join("test-results/silence-check/regression");
        fs::create_dir_all(&output).unwrap();
        let quiet = transcribe_snapshot(&noise, &output, &AtomicBool::new(false)).unwrap();
        assert!(
            quiet.segments.is_empty(),
            "The known quiet microphone snapshot should not generate text"
        );
        let speech = root.join("test-results/speech/reference.wav");
        let attenuated = output.join("quiet-speech.wav");
        let mut ffmpeg = deps::command("ffmpeg").unwrap();
        ffmpeg
            .args(["-y", "-v", "error", "-i"])
            .arg(speech)
            .args([
                "-af",
                "volume=0.005",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&attenuated);
        run_logged(ffmpeg, &output.join("attenuate.log")).unwrap();
        let spoken = transcribe_snapshot(&attenuated, &output, &AtomicBool::new(false)).unwrap();
        for phrase in ["open the library", "click here", "top toolbar"] {
            assert!(
                !crate::agent::find(&spoken, phrase).unwrap().is_empty(),
                "Quiet speech lost phrase: {phrase}"
            );
        }
    }
    #[test]
    #[ignore = "Requires installed tools/models and test-results/vad-experiment fixtures; CUEREVIEW_VAD_MODEL may point to the isolated verified model"]
    fn actual_vad_gate_preserves_words_clock_and_rejects_noise() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let fixture = root.join("test-results/vad-experiment");
        let output = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        for name in ["short-fast-No.wav", "short-fast-Stop.wav"] {
            let source = fixture.join(name);
            let wav = hound::WavReader::open(&source).unwrap();
            assert!(
                wav.duration() < wav.spec().sample_rate,
                "Expected sub-second speech"
            );
            assert!(
                has_speech(&source, output.path(), &cancel).unwrap(),
                "Lost short feedback: {name}"
            );
        }
        assert!(has_speech(&fixture.join("missing.wav"), output.path(), &cancel).is_err());
        assert!(has_speech(
            &fixture.join("delayed-speech.wav"),
            output.path(),
            &AtomicBool::new(true)
        )
        .unwrap_err()
        .contains("cancelled"));

        // The gate must not compress silence or rewrite raw ASR word timing.
        let gated =
            transcribe_snapshot(&fixture.join("delayed-speech.wav"), output.path(), &cancel)
                .unwrap();
        let mut baseline = deps::command("whisper-cli").unwrap();
        alignment_options(&mut baseline).unwrap();
        baseline
            .arg("-m")
            .arg(deps::model_path())
            .arg("-f")
            .arg(output.path().join("speech.wav"))
            .args(DECODING_OPTIONS)
            .args(["-t", "2", "-of"])
            .arg(output.path().join("baseline"));
        run_logged(baseline, &output.path().join("baseline.log")).unwrap();
        let raw: Value = read_json(&output.path().join("baseline.json")).unwrap();
        let ungated = parse_whisper(&raw).unwrap();
        assert_eq!(
            serde_json::to_value(&gated).unwrap(),
            serde_json::to_value(&ungated).unwrap()
        );
        let click = crate::agent::find(&gated, "click here").unwrap();
        assert!((14000..16000).contains(&click[0].start_ms));
        let merged = merge_live(&Transcript::default(), gated, 30000, 51000);
        assert_eq!(
            crate::agent::find(&merged, "click here").unwrap()[0].start_ms,
            click[0].start_ms + 30000
        );

        // Exercise final persistence, without modifying the original noisy recording.
        let store = Store::open(output.path().join("data")).unwrap();
        let project = store.create_project("VAD verification").unwrap();
        let mut session = store
            .create_session(
                &project.id,
                "Quiet mic",
                &crate::models::CaptureConfig {
                    source_id: "fixture".into(),
                    microphone_id: Some("fixture".into()),
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        let source = fixture.join("long-noise.wav");
        let wav = hound::WavReader::open(&source).unwrap();
        session.duration_ms = wav.duration() as u64 * 1000 / wav.spec().sample_rate as u64;
        store.save_session(&session).unwrap();
        let folder = store.session_dir(&session.id).unwrap();
        fs::copy(source, folder.join("mic.wav")).unwrap();
        let transcript = transcribe(&store, &session.id).unwrap();
        assert!(transcript.segments.is_empty());
        assert_eq!(transcript.status.as_deref(), Some("complete"));
        assert!(store.transcript(&session.id).unwrap().segments.is_empty());
        assert!(folder.join("vad.txt").is_file());
        assert!(
            !folder.join("whisper.json").exists(),
            "Skipped ASR must not fabricate raw output"
        );
    }
    #[test]
    #[ignore = "Requires installed base model/DTW preset and delayed, quiet, short-word fixtures in test-results"]
    fn actual_dtw_anchors_keep_delayed_and_quiet_word_context() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let output = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let delayed = transcribe_snapshot(
            &root.join("test-results/vad-experiment/delayed-speech.wav"),
            output.path(),
            &cancel,
        )
        .unwrap();
        let first = &delayed.segments[0].words[0];
        assert_eq!(first.text, "When");
        assert!((10000..10500).contains(&first.seek_ms.unwrap()));
        let raw: Value = read_json(&output.path().join("whisper.json")).unwrap();
        let raw_first = &raw["transcription"][0]["tokens"][1];
        assert_eq!(
            first.start_ms,
            raw_first["offsets"]["from"].as_u64().unwrap()
        );
        assert_eq!(first.end_ms, raw_first["offsets"]["to"].as_u64().unwrap());
        let phrase = crate::agent::find(&delayed, "click here").unwrap();
        assert!((14000..15000).contains(&phrase[0].seek_ms.unwrap()));
        let original_anchor = first.seek_ms.unwrap();
        let shifted = merge_live(&Transcript::default(), delayed, 30000, 51000);
        assert_eq!(
            shifted.segments[0].words[0].seek_ms,
            Some(original_anchor + 30000)
        );
        for (fixture, phrase) in [
            (
                "test-results/silence-check/quiet-speech.wav",
                "When I open the library",
            ),
            ("test-results/vad-experiment/short-fast-No.wav", "No"),
            ("test-results/vad-experiment/short-fast-Stop.wav", "Stop"),
        ] {
            let source = root.join(fixture);
            let wav = hound::WavReader::open(&source).unwrap();
            let duration = wav.duration() as u64 * 1000 / wav.spec().sample_rate as u64;
            let transcript = transcribe_snapshot(&source, output.path(), &cancel).unwrap();
            let found = crate::agent::find(&transcript, phrase).unwrap();
            assert!(!found.is_empty(), "Lost {phrase}");
            assert!(found[0].seek_ms.unwrap() < duration);
        }
    }
}
