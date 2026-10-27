use crate::{
    deps,
    models::{Segment, Transcript, Word},
    store::{read_json, Store},
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
                    });
                } else if let Some(last) = words.last_mut() {
                    last.text.push_str(raw);
                    last.end_ms = last.end_ms.max(end);
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
    whisper
        .arg("-m")
        .arg(deps::model_path())
        .arg("-f")
        .arg(&speech)
        .args(DECODING_OPTIONS)
        .args(["-t", "2", "-of"])
        .arg(folder.join("whisper"));
    run_live(whisper, &folder.join("transcription.log"), cancel)?;
    let raw: Value = read_json(&folder.join("whisper.json"))?;
    parse_whisper(&raw)
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
            .filter(|w| w.end_ms <= start_ms)
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
                let end = word.end_ms.saturating_add(start_ms).min(end_ms);
                (start < end && start < end_ms).then_some(Word {
                    text: word.text,
                    start_ms: start,
                    end_ms: end,
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
    whisper
        .arg("-m")
        .arg(deps::model_path())
        .arg("-f")
        .arg(speech)
        .args(DECODING_OPTIONS)
        .arg("-of")
        .arg(folder.join("whisper"));
    run_logged(whisper, &folder.join("transcription.log"))?;
    let raw: Value = read_json(&folder.join("whisper.json"))?;
    let transcript = parse_whisper(&raw)?;
    store.save_transcript(id, &transcript)?;
    Ok(transcript)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
}
