use crate::{
    deps,
    models::{Segment, TakeStatus, Transcript, Word},
    settings,
    store::{atomic_write, Store},
    stretches::{self, Guess, Stretches},
    takes,
};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

/// Whisper threads for a final transcription: half the logical threads, at
/// most 8, and never fewer than whisper-cli's default of 4 where the
/// processor has them. More than eight barely speed it up.
fn final_threads(logical: usize) -> usize {
    (logical / 2).max(logical.min(4)).clamp(1, 8)
}
/// Whisper threads while recording: a quarter, at most 4 and never fewer
/// than 2 where the processor has them, beside the capture and its encoder.
fn live_threads(logical: usize) -> usize {
    (logical / 4).max(logical.min(2)).clamp(1, 4)
}
fn logical_threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get())
}
// The options live in settings.rs so the saved vocabulary can shape them;
// `language` is the language of this run.
fn decoding_options(root: &Path, model: &Path, language: &str) -> Vec<String> {
    settings::decoding_args(&settings::load(root), model, language)
}
/// `model` when its file is there to transcribe with.
fn installed(model: deps::ModelChoice) -> Result<deps::ModelChoice, String> {
    if model.path.is_file() {
        Ok(model)
    } else {
        Err(
            "Install the local speech model, then retry transcription. Your recording is saved."
                .into(),
        )
    }
}
fn dtw_preset(requested: Option<&str>) -> Result<Option<String>, String> {
    match requested {
        None => Ok(None),
        Some(name) if matches!(name, "tiny" | "tiny.en" | "base" | "base.en" | "small" | "small.en" | "medium" | "medium.en" | "large.v1" | "large.v2" | "large.v3" | "large.v3.turbo") => Ok(Some(name.into())),
        Some(_) => Err("CUEREVIEW_DTW_MODEL must name a supported Whisper alignment preset (for example base or base.en).".into()),
    }
}
fn alignment_options(
    command: &mut std::process::Command,
    model: &deps::ModelChoice,
) -> Result<(), String> {
    if let Some(preset) = dtw_preset(model.dtw.as_deref())? {
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
        language_detected: false,
        status: Some("complete".into()),
        error: None,
        takes: Vec::new(),
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
#[cfg(test)]
fn vad_count(output: &str) -> Result<usize, String> {
    vad_regions(output).map(|regions| regions.len())
}
/// The detector's speech regions, start and end in milliseconds (it prints
/// centiseconds).
fn vad_regions(output: &str) -> Result<Vec<(u64, u64)>, String> {
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
    let regions: Vec<_> = lines
        .enumerate()
        .map(|(i, line)| {
            let (start, end) = line
                .strip_prefix(&format!("Speech segment {i}: start = "))?
                .split_once(", end = ")?;
            let ms = |value: &str| {
                value
                    .trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .map(|v| (v * 10.0).round() as u64)
            };
            Some((ms(start)?, ms(end)?))
        })
        .collect::<Option<_>>()
        .ok_or("Speech detector returned inconsistent regions; see vad.txt.")?;
    if regions.len() != count {
        return Err("Speech detector returned inconsistent regions; see vad.txt.".into());
    }
    Ok(regions)
}
fn detect(
    speech: &Path,
    folder: &Path,
    cancel: &AtomicBool,
    pad_ms: u32,
) -> Result<Vec<(u64, u64)>, String> {
    let mut detector = deps::command("whisper-vad-speech-segments")?;
    detector
        .args(["-vm"])
        .arg(deps::vad_model_path())
        .arg("-f")
        .arg(speech)
        .args(["-vt", "0.35", "-vp"])
        .arg(pad_ms.to_string())
        .args(["-vspd", "100", "-np"]);
    let output = folder.join("vad.txt");
    run_live_output(detector, &folder.join("vad.log"), cancel, Some(&output))?;
    vad_regions(&fs::read_to_string(output).map_err(|e| e.to_string())?)
}
/// Where `speech` (16 kHz) holds speech, padded by only 100 ms so the pauses
/// that end a stretch stay visible.
pub(crate) fn speech_regions(
    speech: &Path,
    folder: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<(u64, u64)>, String> {
    detect(speech, folder, cancel, 100)
}
// Gate only wholly speech-free inputs. Never crop audio: the pinned CLI's --vad
// JSON token times are not mapped back to the original recording timeline.
fn has_speech(speech: &Path, folder: &Path, cancel: &AtomicBool) -> Result<bool, String> {
    Ok(!detect(speech, folder, cancel, 500)?.is_empty())
}
fn empty_transcript() -> Transcript {
    Transcript {
        status: Some("complete".into()),
        ..Default::default()
    }
}
fn accept_whisper_output(prefix: &Path, kept: &Path) -> Result<Transcript, String> {
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
    atomic_write(kept, &bytes)?;
    let _ = fs::remove_file(fresh);
    Ok(transcript)
}
/// Converts `source` to 16 kHz mono PCM in `target`, optionally from
/// `from_ms` and for `length_ms`.
fn to_speech(
    source: &Path,
    target: &Path,
    from_ms: Option<u64>,
    length_ms: Option<u64>,
    log: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut ffmpeg = deps::command("ffmpeg")?;
    ffmpeg.args(["-hide_banner", "-y", "-i"]).arg(source);
    if let Some(from_ms) = from_ms {
        ffmpeg.args(["-ss", &format!("{:.3}", from_ms as f64 / 1000.)]);
    }
    if let Some(length_ms) = length_ms {
        ffmpeg.args(["-t", &format!("{:.3}", length_ms as f64 / 1000.)]);
    }
    ffmpeg
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(target);
    match cancel {
        Some(cancel) => run_live(ffmpeg, log, cancel),
        None => run_logged(ffmpeg, log),
    }
}
/// Copies `from_ms..to_ms` of a 16 kHz PCM file into `target`.
fn wav_slice(source: &Path, target: &Path, from_ms: u64, to_ms: u64) -> Result<(), String> {
    wav_spans(source, target, &[(from_ms, to_ms)])
}
/// Copies `spans` (start and end in ms) of a 16 kHz PCM file into `target`,
/// back to back.
fn wav_spans(source: &Path, target: &Path, spans: &[(u64, u64)]) -> Result<(), String> {
    let mut reader = hound::WavReader::open(source).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let rate = spec.sample_rate as u64;
    let total = reader.duration() as u64;
    let mut writer = hound::WavWriter::create(target, spec).map_err(|e| e.to_string())?;
    for &(from_ms, to_ms) in spans {
        let start = (from_ms * rate / 1000).min(total);
        let end = (to_ms * rate / 1000).clamp(start, total);
        reader.seek(start as u32).map_err(|e| e.to_string())?;
        for sample in reader.samples::<i16>().take((end - start) as usize) {
            writer
                .write_sample(sample.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
    }
    writer.finalize().map_err(|e| e.to_string())
}
/// What `whisper-cli -dl` logs once it has heard a file: the top language
/// and its probability. `None`, no guess, without that line, or when it
/// names something the speech model's table does not hold.
fn parse_detected(log: &str) -> Option<Guess> {
    const MARK: &str = "auto-detected language: ";
    let rest = &log[log.find(MARK)? + MARK.len()..];
    let (language, rest) = rest.split_once(" (p = ")?;
    let p = rest.split_once(')')?.0.trim().parse::<f32>().ok()?;
    let language = settings::known_language(language.trim())?;
    (p.is_finite() && p >= 0.0).then(|| Guess {
        language: language.into(),
        p: p.min(1.0),
    })
}
/// The language of `speech` (16 kHz) as base hears it in its first 30 s:
/// `whisper-cli -dl` detects and exits without transcribing. Its log stays in
/// `folder` as `language.log`. Whatever goes wrong is no guess, never a
/// failure of the take.
fn detect_language(
    speech: &Path,
    folder: &Path,
    threads: usize,
    cancel: Option<&AtomicBool>,
) -> Option<Guess> {
    let mut whisper = deps::command("whisper-cli").ok()?;
    whisper
        .arg("-m")
        .arg(deps::live_model().path)
        .arg("-f")
        .arg(speech)
        .args(["-dl", "-ng", "-t"])
        .arg(threads.to_string());
    let log = folder.join("language.log");
    match cancel {
        Some(cancel) => run_live(whisper, &log, cancel),
        None => run_logged(whisper, &log),
    }
    .ok()?;
    parse_detected(&fs::read_to_string(log).ok()?)
}
/// How much speech one detection hears: Whisper's window.
const DETECT_WINDOW_MS: u64 = 30_000;
/// How many windows a whole-take pass hears at most before it settles.
const DETECT_WINDOWS: usize = 3;
/// The parts of the speech `regions` (start and end in ms, ordered) that
/// make up the `index`-th 30 s of speech-only audio; empty when the regions
/// hold less speech than that.
fn window_spans(regions: &[(u64, u64)], index: usize) -> Vec<(u64, u64)> {
    let from = index as u64 * DETECT_WINDOW_MS;
    let to = from + DETECT_WINDOW_MS;
    let mut spans = Vec::new();
    let mut heard = 0;
    for &(start, end) in regions {
        let length = end.saturating_sub(start);
        let (a, b) = (from.max(heard), to.min(heard + length));
        if a < b {
            spans.push((start + (a - heard), start + (b - heard)));
        }
        heard += length;
        if heard >= to {
            break;
        }
    }
    spans
}
/// The language of a take for a whole-take pass under Auto: detected on up
/// to three windows of 30 s of speech-only audio, cut from `speech` (16 kHz)
/// by its speech `regions`, so a quiet or noisy start decides nothing. The
/// first window with a confident guess decides; otherwise the language with
/// the largest summed probability. `None` when nothing was guessed.
fn detect_take_language(
    speech: &Path,
    regions: &[(u64, u64)],
    folder: &Path,
    threads: usize,
    cancel: Option<&AtomicBool>,
) -> Option<String> {
    let window = folder.join("language.wav");
    let mut guesses = Vec::new();
    for index in 0..DETECT_WINDOWS {
        let spans = window_spans(regions, index);
        if spans.is_empty() || wav_spans(speech, &window, &spans).is_err() {
            break;
        }
        guesses.extend(detect_language(&window, folder, threads, cancel));
        if stretches::decided(&guesses).is_some() {
            break;
        }
    }
    let _ = fs::remove_file(&window);
    stretches::decided(&guesses)
        .or_else(|| stretches::likeliest(&guesses))
        .map(str::to_owned)
}
/// Runs Whisper on `speech` (16 kHz) with `model`, held to `language`; its
/// raw output is kept as `raw`.
#[allow(clippy::too_many_arguments)]
fn run_whisper(
    root: &Path,
    speech: &Path,
    folder: &Path,
    model: &deps::ModelChoice,
    language: &str,
    threads: usize,
    cancel: Option<&AtomicBool>,
    raw: &Path,
) -> Result<Transcript, String> {
    let mut whisper = deps::command("whisper-cli")?;
    alignment_options(&mut whisper, model)?;
    run_whisper_with(
        whisper, root, speech, folder, model, language, threads, cancel, raw,
    )
}
/// A quick guess of the words of `speech` with base: one beam and no
/// alignment points, which a guess shown while recording never needs.
/// `language` is the take's, or [`settings::AUTO`] until it is decided.
fn guess_words(
    root: &Path,
    speech: &Path,
    folder: &Path,
    language: &str,
    cancel: &AtomicBool,
) -> Result<Transcript, String> {
    let mut whisper = deps::command("whisper-cli")?;
    whisper.args(["-bs", "1", "-bo", "1"]);
    let model = deps::live_model();
    let threads = live_threads(logical_threads());
    let raw = folder.join("whisper.json");
    run_whisper_with(
        whisper,
        root,
        speech,
        folder,
        &model,
        language,
        threads,
        Some(cancel),
        &raw,
    )
}
#[allow(clippy::too_many_arguments)]
fn run_whisper_with(
    mut whisper: std::process::Command,
    root: &Path,
    speech: &Path,
    folder: &Path,
    model: &deps::ModelChoice,
    language: &str,
    threads: usize,
    cancel: Option<&AtomicBool>,
    raw: &Path,
) -> Result<Transcript, String> {
    let prefix = folder.join(format!("whisper-{}", uuid::Uuid::new_v4()));
    whisper
        .arg("-m")
        .arg(&model.path)
        .arg("-f")
        .arg(speech)
        .args(decoding_options(root, &model.path, language))
        .arg("-t")
        .arg(threads.to_string())
        .arg("-of")
        .arg(&prefix);
    let log = folder.join("transcription.log");
    match cancel {
        Some(cancel) => run_live(whisper, &log, cancel)?,
        None => run_logged(whisper, &log)?,
    }
    accept_whisper_output(&prefix, raw)
}
/// [`media_source`] for Stop: saved stretches it cannot use are forgotten,
/// for they are no transcript to refine later.
fn reused_source(
    folder: &Path,
    usable: impl Fn(&str) -> Option<Stretches>,
) -> (std::path::PathBuf, Option<Stretches>) {
    let (source, saved) = media_source(folder, usable);
    if saved.is_none() {
        stretches::forget(folder);
    }
    (source, saved)
}
/// The audio a take folder is transcribed from, and the saved stretches to
/// reuse with it (`usable` gives them for a file name): `mic.wav`; else
/// `system.wav` when it has usable stretches, for a take without a
/// microphone was cut into stretches from its system audio; else the mix
/// `audio.wav`; else `video.mp4`.
fn media_source(
    folder: &Path,
    usable: impl Fn(&str) -> Option<Stretches>,
) -> (std::path::PathBuf, Option<Stretches>) {
    if folder.join("mic.wav").exists() {
        return (folder.join("mic.wav"), usable("mic.wav"));
    }
    if folder.join("system.wav").exists() {
        if let Some(saved) = usable("system.wav") {
            return (folder.join("system.wav"), Some(saved));
        }
    }
    if folder.join("audio.wav").exists() {
        return (folder.join("audio.wav"), None);
    }
    (folder.join("video.mp4"), None)
}
fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}
/// The take's live audio after its finished stretches, as one live update
/// found it: converted to 16 kHz, with its speech regions.
pub struct LiveAudio {
    speech: std::path::PathBuf,
    regions: Vec<(u64, u64)>,
    length_ms: u64,
}
/// The first half of a live update, which the person sees at once: converts
/// `snapshot` (the live audio from `stretches.until_ms`, `length_ms` long),
/// finds its speech and guesses its words with base, held to `language`,
/// the take's, or left to Whisper's own detection while the take is not
/// decided (`None`). Returns the guess, timed from the snapshot's start, and
/// the audio for [`live_commit`].
pub fn live_guess(
    root: &Path,
    folder: &Path,
    snapshot: &Path,
    length_ms: u64,
    language: Option<&str>,
    cancel: &AtomicBool,
) -> Result<(Transcript, Option<LiveAudio>), String> {
    // Too short to hold a word; the detector refuses an empty file.
    if length_ms < 300 {
        return Ok((Transcript::default(), None));
    }
    let speech = folder.join("speech.wav");
    to_speech(
        snapshot,
        &speech,
        None,
        None,
        &folder.join("transcode.log"),
        Some(cancel),
    )?;
    let regions = speech_regions(&speech, folder, cancel)?;
    let guess = if regions.is_empty() {
        Transcript::default()
    } else {
        guess_words(
            root,
            &speech,
            folder,
            language.unwrap_or(settings::AUTO),
            cancel,
        )?
    };
    let audio = LiveAudio {
        speech,
        regions,
        length_ms,
    };
    Ok((guess, Some(audio)))
}
/// The second half of a live update: transcribes every stretch of `audio`
/// that a pause has finished once and saves it, then returns the words of
/// `guess` after them, timed from the new `stretches.until_ms`, and how long
/// the audio after them is.
///
/// A stretch is transcribed in the take's language with that language's
/// model (`models`). Under Auto, until the take is decided, each stretch's
/// language is detected first and the stretch transcribed in its own guess;
/// a confident guess decides the take. When that leaves earlier stretches in
/// another language, this returns before newer stretches are handled, so
/// the caller transcribes those again first ([`redo_provisional`]).
#[allow(clippy::too_many_arguments)]
pub fn live_commit(
    root: &Path,
    take: &Path,
    folder: &Path,
    models: &deps::TakeModels,
    stretches: &mut Stretches,
    audio: &LiveAudio,
    guess: Transcript,
    cancel: &AtomicBool,
) -> Result<(Transcript, u64), String> {
    let after = |done: u64| -> Vec<(u64, u64)> {
        audio
            .regions
            .iter()
            .filter(|region| region.1 > done)
            .map(|&(start, end)| (start.saturating_sub(done), end - done))
            .collect()
    };
    let mut done = 0;
    while let Some(cut) = stretches::cut(&after(done), audio.length_ms.saturating_sub(done)) {
        let end_ms = stretches.until_ms + cut.at_ms;
        let redo_first = if cut.speech {
            let part = folder.join("stretch.wav");
            wav_slice(&audio.speech, &part, done, done + cut.at_ms)?;
            let threads = live_threads(logical_threads());
            let heard = if stretches.detects() {
                detect_language(&part, folder, threads, Some(cancel))
            } else {
                None
            };
            let language = stretches.language_for(heard.as_ref());
            let model = models.of(&language);
            fs::create_dir_all(stretches::folder(take)).map_err(|e| e.to_string())?;
            let raw = stretches::folder(take).join(format!("{}.json", stretches.until_ms));
            let words = run_whisper(
                root,
                &part,
                folder,
                model,
                &language,
                threads,
                Some(cancel),
                &raw,
            )?;
            stretches.push(words, end_ms, &language, &file_name(&model.path), heard)
        } else {
            stretches.skip(end_ms);
            false
        };
        stretches::save(take, stretches)?;
        done += cut.at_ms;
        if redo_first {
            break;
        }
    }
    Ok((stretches::after(guess, done), audio.length_ms - done))
}
/// Transcribes the stretch `part` of a take again, held to `language` with
/// `model`, and replaces its words in `stretches`, which it saves. `audio`
/// is a copy of the take's audio from the stretch's start; scratch files go
/// to `folder`.
#[allow(clippy::too_many_arguments)]
fn redo_stretch(
    root: &Path,
    take: &Path,
    folder: &Path,
    audio: &Path,
    part: &stretches::Part,
    language: &str,
    model: &deps::ModelChoice,
    cancel: &AtomicBool,
    stretches: &mut Stretches,
) -> Result<(), String> {
    let speech = folder.join("stretch.wav");
    to_speech(
        audio,
        &speech,
        None,
        Some(part.end_ms - part.start_ms),
        &folder.join("transcode.log"),
        Some(cancel),
    )?;
    fs::create_dir_all(stretches::folder(take)).map_err(|e| e.to_string())?;
    let raw = stretches::folder(take).join(format!("{}.json", part.start_ms));
    let threads = live_threads(logical_threads());
    let words = run_whisper(
        root,
        &speech,
        folder,
        model,
        language,
        threads,
        Some(cancel),
        &raw,
    )?;
    stretches.replace(part.start_ms, words, language, &file_name(&model.path));
    stretches::save(take, stretches)
}
/// While the take records: transcribes again, in the language the take was
/// just held to, the stretches made before that in another language
/// ([`stretches::Redo::run`]). `copy` copies the take's live audio from a
/// point (ms into the take) into a file, as a live snapshot is made, so the
/// copy starts where the stretch does and may run past its end.
#[allow(clippy::too_many_arguments)]
pub fn redo_provisional(
    root: &Path,
    take: &Path,
    folder: &Path,
    models: &deps::TakeModels,
    stretches: &mut Stretches,
    redo: &mut stretches::Redo,
    cancel: &AtomicBool,
    copy: &mut dyn FnMut(u64, &Path) -> Result<(), String>,
) -> stretches::Redone {
    let audio = folder.join("redo.wav");
    redo.run(
        stretches,
        &mut |part| copy(part.start_ms, &audio),
        &mut |part, language, stretches| {
            let model = models.of(language);
            redo_stretch(
                root, take, folder, &audio, part, language, model, cancel, stretches,
            )
        },
    )
}
/// Only scratch files are written here; final session transcript files are untouched.
/// `root` is the data root whose settings choose the decoding options; the
/// snapshot is held to the language chosen there, and to English under Auto.
pub fn transcribe_snapshot(
    root: &Path,
    source: &Path,
    folder: &Path,
    cancel: &AtomicBool,
) -> Result<Transcript, String> {
    let speech = folder.join("speech.wav");
    to_speech(
        source,
        &speech,
        None,
        None,
        &folder.join("transcode.log"),
        Some(cancel),
    )?;
    if !has_speech(&speech, folder, cancel)? {
        return Ok(empty_transcript());
    }
    let threads = live_threads(logical_threads());
    let raw = folder.join("whisper.json");
    let language =
        settings::chosen_language(&settings::load(root)).unwrap_or(stretches::FALLBACK_LANGUAGE);
    run_whisper(
        root,
        &speech,
        folder,
        &deps::live_model(),
        language,
        threads,
        Some(cancel),
        &raw,
    )
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
        language_detected: false,
        status: Some("provisional".into()),
        error: None,
        takes: Vec::new(),
    }
}
/// Transcribes one folder's media, as [`transcribe_media`] does for the data
/// root: the folder, how much of the media to read and whether it recorded
/// audio. Tests pass fakes, so the take logic runs without Whisper.
pub(crate) type Transcriber<'a> = &'a dyn Fn(&Path, u64, bool) -> Result<Transcript, String>;

/// Transcribes the session and saves its transcript. A session recorded
/// before takes existed is transcribed as one recording, as in v0.1. A
/// session with takes transcribes every take on the timeline and records each
/// take's outcome; it refuses while a take still waits to join the video.
pub fn transcribe(store: &Store, id: &str) -> Result<Transcript, String> {
    let root = store.root.clone();
    transcribe_with(store, id, &|folder, duration_ms, has_audio| {
        transcribe_media(&root, folder, duration_ms, has_audio)
    })
}
/// [`transcribe`] with each folder's media transcribed by `media`.
pub(crate) fn transcribe_with(
    store: &Store,
    id: &str,
    media: Transcriber<'_>,
) -> Result<Transcript, String> {
    let session = store.session(id)?;
    if session.takes.is_empty() {
        let transcript = media(
            &store.session_dir(id)?,
            session.duration_ms,
            session.microphone_id.is_some() || session.system_audio,
        )?;
        store.save_transcript(id, &transcript)?;
        return Ok(transcript);
    }
    let all = takes::list(&session);
    if let Some(take) = all.iter().find(|take| take.status == TakeStatus::Swapping) {
        return Err(format!(
            "Take {index} was saved by an earlier CueReview and still waits to be added to the recording: video.mp4 could not be read, and only it tells whether the take is already in it. Try again once video.mp4 can be read.",
            index = take.index
        ));
    }
    let dir = store.session_dir(id)?;
    let mut transcript = store.transcript(id)?;
    let mut outcomes = Vec::new();
    let mut failure = None;
    for take in all.iter().filter(|take| takes::on_timeline(take.status)) {
        let folder = takes::take_dir(&dir, take.index);
        match media(&folder, take.duration_ms, takes::records_audio(take)) {
            Ok(update) => {
                transcript = takes::merge_take(
                    &transcript,
                    update,
                    take.index,
                    take.offset_ms,
                    takes::marks(&all),
                );
                outcomes.push((take.index, TakeStatus::Ready));
            }
            Err(error) => {
                failure.get_or_insert(error);
                outcomes.push((take.index, TakeStatus::Error));
            }
        }
    }
    transcript.takes = takes::with_languages(takes::marks(&all), &transcript);
    store.save_transcript(id, &transcript)?;
    store.update_session(id, |session| {
        for (index, status) in &outcomes {
            if let Ok(take) = takes::take_mut(session, *index) {
                take.status = *status;
            }
        }
        Ok(())
    })?;
    failure.map_or(Ok(transcript), Err)
}
/// Transcribes only take `index` of a session with takes, shifted by its
/// offset, and replaces that take's segments in the saved transcript. The
/// take dividers are brought up to date even when transcription fails, so a
/// take without a transcript still shows where it starts.
pub fn transcribe_take(store: &Store, id: &str, index: u32) -> Result<Transcript, String> {
    let root = store.root.clone();
    transcribe_take_with(store, id, index, &|folder, duration_ms, has_audio| {
        transcribe_media(&root, folder, duration_ms, has_audio)
    })
}
fn transcribe_take_with(
    store: &Store,
    id: &str,
    index: u32,
    media: Transcriber<'_>,
) -> Result<Transcript, String> {
    let session = store.session(id)?;
    let take = takes::list(&session)
        .into_iter()
        .find(|take| take.index == index)
        .ok_or_else(|| format!("Take {index} is not part of this recording."))?;
    if !takes::on_timeline(take.status) {
        return Err(format!("Take {index} is not part of the recording yet."));
    }
    let folder = takes::take_dir(&store.session_dir(id)?, index);
    let result = media(&folder, take.duration_ms, takes::records_audio(&take));
    // Merge into a fresh read so concurrent writes to other takes are kept.
    let _lock = store.lock_session(id)?;
    let existing = store.transcript(id)?;
    let marks = takes::with_languages(takes::marks(&takes::list(&store.session(id)?)), &existing);
    match result {
        Ok(update) => {
            let merged = takes::merge_take(&existing, update, index, take.offset_ms, marks);
            store.save_transcript(id, &merged)?;
            Ok(merged)
        }
        Err(error) => {
            if existing.takes != marks {
                store.save_transcript(
                    id,
                    &Transcript {
                        takes: marks,
                        ..existing
                    },
                )?;
            }
            Err(error)
        }
    }
}
/// Transcribes one folder's media: `mic.wav`, else `audio.wav`, else
/// `video.mp4`, limited to `duration_ms`. Times are relative to that media.
/// Scratch files and the raw Whisper output stay in `folder`; nothing is
/// saved to the session. `root` is the data root whose settings choose the
/// language and the decoding options.
///
/// The take is held to the language chosen in Settings. Under Auto it is
/// held to the language its saved stretches decided, with the stretches made
/// in another language transcribed again first; without stretches its
/// language is detected from its speech ([`detect_take_language`]), so every
/// take is detected on its own. The transcript carries the language and
/// whether it was detected.
pub fn transcribe_media(
    root: &Path,
    folder: &Path,
    duration_ms: u64,
    has_audio: bool,
) -> Result<Transcript, String> {
    transcribe_media_with(root, folder, duration_ms, has_audio, true, None)
}
/// [`transcribe_media`], reusing saved stretches only when `reuse` (the
/// pass that refines a take made from them does not), and stopped by
/// `cancel`.
fn transcribe_media_with(
    root: &Path,
    folder: &Path,
    duration_ms: u64,
    has_audio: bool,
    reuse: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Transcript, String> {
    let never = AtomicBool::new(false);
    let threads = final_threads(logical_threads());
    let log = folder.join("transcode.log");
    let tools = Tools {
        convert: &|source, target, from_ms, length_ms| {
            to_speech(source, target, from_ms, length_ms, &log, None)
        },
        regions: &|speech| detect(speech, folder, cancel.unwrap_or(&never), 500),
        detect: &|speech, regions| detect_take_language(speech, regions, folder, threads, cancel),
        model: &|language| {
            installed(deps::final_model(language)).map(|model| file_name(&model.path))
        },
        whisper: &|speech, language, raw| {
            let model = installed(deps::final_model(language))?;
            run_whisper(root, speech, folder, &model, language, threads, cancel, raw)
        },
    };
    transcribe_media_in(root, folder, duration_ms, has_audio, reuse, &tools)
}
type Converter<'a> = &'a dyn Fn(&Path, &Path, Option<u64>, Option<u64>) -> Result<(), String>;
type SpeechFinder<'a> = &'a dyn Fn(&Path) -> Result<Vec<(u64, u64)>, String>;
type Detector<'a> = &'a dyn Fn(&Path, &[(u64, u64)]) -> Option<String>;
/// The work a whole-take pass leaves to FFmpeg, the speech detector and
/// Whisper. Tests pass fakes, so the pass itself runs without them.
pub(crate) struct Tools<'a> {
    /// Converts audio to 16 kHz PCM: source, target, and optionally from
    /// where and for how long (ms).
    pub convert: Converter<'a>,
    /// Where a 16 kHz file holds speech (start and end in ms).
    pub regions: SpeechFinder<'a>,
    /// The language heard in a 16 kHz file with those speech regions
    /// ([`detect_take_language`]); `None` for no guess.
    pub detect: Detector<'a>,
    /// The file name of the model that transcribes a language now, or why
    /// none can.
    pub model: &'a dyn Fn(&str) -> Result<String, String>,
    /// Transcribes a 16 kHz file held to a language, keeping the raw output
    /// at the given path.
    pub whisper: &'a dyn Fn(&Path, &str, &Path) -> Result<Transcript, String>,
}
/// [`transcribe_media_with`] with its outside work done by `tools`.
pub(crate) fn transcribe_media_in(
    root: &Path,
    folder: &Path,
    duration_ms: u64,
    has_audio: bool,
    reuse: bool,
    tools: &Tools<'_>,
) -> Result<Transcript, String> {
    if !has_audio {
        return Ok(Transcript {
            status: Some("complete".into()),
            ..Default::default()
        });
    }
    let settings = settings::load(root);
    let chosen = settings::chosen_language(&settings);
    // Base stands in for a language's model that is missing, so when this
    // one is missing no speech model is installed at all.
    (tools.model)(chosen.unwrap_or(stretches::FALLBACK_LANGUAGE))?;
    let model_file = |language: &str| (tools.model)(language).unwrap_or_default();
    let (source, mut saved) = if reuse {
        reused_source(folder, |name| {
            stretches::usable(folder, name, chosen, &model_file)
        })
    } else {
        media_source(folder, |_| None)
    };
    let mut held = held_language(&settings, folder, saved.as_ref(), !reuse);
    if let (Some(saved), Some((language, _))) = (saved.as_mut(), held) {
        // Stretches made before the take's language was decided, in another one.
        for part in saved.to_redo() {
            let speech = folder.join("stretch.wav");
            let from = (part.start_ms > 0).then_some(part.start_ms);
            (tools.convert)(&source, &speech, from, Some(part.end_ms - part.start_ms))?;
            fs::create_dir_all(stretches::folder(folder)).map_err(|e| e.to_string())?;
            let raw = stretches::folder(folder).join(format!("{}.json", part.start_ms));
            let words = (tools.whisper)(&speech, language, &raw)?;
            saved.replace(part.start_ms, words, language, &(tools.model)(language)?);
            stretches::save(folder, saved)?;
        }
    }
    let from_ms = saved
        .as_ref()
        .map_or(0, |saved| saved.until_ms.min(duration_ms));
    let rest_ms = duration_ms - from_ms;
    let rest = if rest_ms == 0 {
        empty_transcript()
    } else {
        let speech = folder.join("speech.wav");
        let from = (from_ms > 0).then_some(from_ms);
        (tools.convert)(&source, &speech, from, Some(rest_ms))?;
        let regions = (tools.regions)(&speech)?;
        if regions.is_empty() {
            empty_transcript()
        } else {
            let (language, _) = *held.get_or_insert_with(|| {
                // Auto, and nothing decided the take yet: hear its speech.
                let heard = (tools.detect)(&speech, &regions);
                let language = settings::held_language(&settings, heard.as_deref())
                    .unwrap_or(stretches::FALLBACK_LANGUAGE);
                (language, true)
            });
            (tools.whisper)(&speech, language, &folder.join("whisper.json"))?
        }
    };
    if let (Some(saved), Some((language, detected))) = (saved.as_mut(), held) {
        // Kept with the stretches for the pass that refines them, which
        // does not detect again.
        saved.language = Some(language.into());
        saved.language_detected = detected;
        stretches::save(folder, saved)?;
    }
    let mut transcript = match saved {
        Some(saved) => saved.join(rest, rest_ms),
        None => rest,
    };
    // A take without words has no language.
    let held = held.filter(|_| !transcript.segments.is_empty());
    transcript.language = held.map(|(language, _)| language.to_owned());
    transcript.language_detected = held.is_some_and(|(_, detected)| detected);
    Ok(transcript)
}
/// The language that holds a take before a whole-take pass hears its audio,
/// and whether it was detected. `None`: Auto, and the pass detects it.
///
/// Stop reuses stretches (`saved`, settled) and takes what they hold the take
/// to. The pass that refines them (`refining`) reads the same from the file
/// Stop left and keeps it, whatever Settings say by then. Otherwise the
/// language chosen in Settings holds the take: Retry and `cue transcribe`
/// forget the stretches first, so they follow the current choice and under
/// Auto detect again.
pub(crate) fn held_language(
    settings: &crate::models::Settings,
    folder: &Path,
    saved: Option<&Stretches>,
    refining: bool,
) -> Option<(&'static str, bool)> {
    let kept = match saved {
        Some(saved) => saved
            .language
            .clone()
            .map(|language| (language, saved.language_detected)),
        None if refining => stretches::language(folder),
        None => None,
    };
    kept.and_then(|(language, detected)| Some((settings::known_language(&language)?, detected)))
        .or_else(|| settings::chosen_language(settings).map(|language| (language, false)))
}
/// A whole-take pass whose outside work is faked, for tests here and of the
/// callers: speech everywhere unless `silent`, a detector that hears `heard`
/// and counts how often it is asked, and a Whisper that returns one word
/// naming the language it was held to.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakePass {
    pub heard: Option<&'static str>,
    pub silent: bool,
    pub detections: std::cell::Cell<usize>,
    /// The language of each Whisper run, in order.
    pub languages: std::cell::RefCell<Vec<String>>,
    /// From where and for how long each conversion read the take's audio.
    pub converted: std::cell::RefCell<Vec<(Option<u64>, Option<u64>)>>,
}
#[cfg(test)]
impl FakePass {
    pub fn hearing(heard: &'static str) -> Self {
        Self {
            heard: Some(heard),
            ..Default::default()
        }
    }
    pub fn run(
        &self,
        root: &Path,
        folder: &Path,
        duration_ms: u64,
        reuse: bool,
    ) -> Result<Transcript, String> {
        let tools = Tools {
            convert: &|_, _, from_ms, length_ms| {
                self.converted.borrow_mut().push((from_ms, length_ms));
                Ok(())
            },
            regions: &|_| Ok(if self.silent { vec![] } else { vec![(0, 1000)] }),
            detect: &|_, _| {
                self.detections.set(self.detections.get() + 1);
                self.heard.map(str::to_owned)
            },
            model: &|language| {
                Ok(if language == "en" {
                    "ggml-small.en.bin"
                } else {
                    "ggml-small.bin"
                }
                .into())
            },
            whisper: &|_, language, _| {
                self.languages.borrow_mut().push(language.into());
                let text = format!("{language}-words");
                Ok(Transcript {
                    segments: vec![Segment {
                        id: "segment-0".into(),
                        start_ms: 100,
                        end_ms: 400,
                        text: text.clone(),
                        words: vec![Word {
                            text,
                            start_ms: 100,
                            end_ms: 400,
                            seek_ms: Some(150),
                        }],
                    }],
                    language: Some(language.into()),
                    status: Some("complete".into()),
                    ..Default::default()
                })
            },
        };
        transcribe_media_in(root, folder, duration_ms, true, reuse, &tools)
    }
}
/// Replaces the words of every take of session `id` that Stop transcribed
/// from stretches with a whole-take pass, then forgets the stretches.
/// Returns whether any take was refined. Stops when `cancel` is set.
pub fn refine(store: &Store, id: &str, cancel: &AtomicBool) -> Result<bool, String> {
    let root = store.root.clone();
    refine_with(store, id, &|folder, duration_ms, has_audio| {
        transcribe_media_with(&root, folder, duration_ms, has_audio, false, Some(cancel))
    })
}
/// [`refine`] with each folder's whole-take pass done by `media`.
pub(crate) fn refine_with(store: &Store, id: &str, media: Transcriber<'_>) -> Result<bool, String> {
    let session = store.session(id)?;
    let dir = store.session_dir(id)?;
    let saved = |folder: &Path| stretches::folder(folder).join("stretches.json").is_file();
    if session.takes.is_empty() {
        if !saved(&dir) || session.status != "ready" {
            return Ok(false);
        }
        let transcript = media(
            &dir,
            session.duration_ms,
            session.microphone_id.is_some() || session.system_audio,
        )?;
        store.save_transcript(id, &transcript)?;
        stretches::forget(&dir);
        return Ok(true);
    }
    let mut refined = false;
    for take in takes::list(&session) {
        let folder = takes::take_dir(&dir, take.index);
        if take.status != TakeStatus::Ready || !saved(&folder) {
            continue;
        }
        transcribe_take_with(store, id, take.index, media)?;
        stretches::forget(&folder);
        refined = true;
    }
    Ok(refined)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::read_json;
    use serde_json::json;
    #[test]
    fn thread_counts_follow_the_processor() {
        let counts = |logical| (final_threads(logical), live_threads(logical));
        assert_eq!(counts(1), (1, 1));
        assert_eq!(counts(2), (2, 2));
        assert_eq!(counts(4), (4, 2));
        assert_eq!(counts(8), (4, 2));
        assert_eq!(counts(12), (6, 3));
        assert_eq!(counts(32), (8, 4));
    }
    #[test]
    fn detector_regions_are_read_in_milliseconds() {
        let output = "Detected 2 speech segments:
Speech segment 0: start = 136.00, end = 962.00
Speech segment 1: start = 984.00, end = 1131.50
";
        assert_eq!(vad_regions(output).unwrap(), [(1360, 9620), (9840, 11315)]);
        assert!(vad_regions(
            "Detected 1 speech segments:
Speech segment 0: start = x, end = 1.0
"
        )
        .is_err());
        assert!(vad_regions(
            "Detected 2 speech segments:
Speech segment 0: start = 1.0, end = 2.0
"
        )
        .is_err());
    }
    #[test]
    fn the_detected_language_is_read_from_the_log() {
        // What `whisper-cli -dl` writes for 30 s of German speech.
        let log = "whisper_init_with_params_no_state: use gpu    = 0\n\
            main: processing 'speech.wav' (480000 samples, 30.0 sec), 4 threads, 1 processors, 5 beams + best of 5, lang = auto, task = transcribe, timestamps = 1 ...\n\n\
            whisper_full_with_state: auto-detected language: de (p = 0.987654)\n\n\
            whisper_print_timings:     load time =   106.49 ms\n";
        assert_eq!(
            parse_detected(log),
            Some(Guess {
                language: "de".into(),
                p: 0.987654
            })
        );
        let guess = |line: &str| parse_detected(line).map(|guess| (guess.language, guess.p));
        assert_eq!(
            guess("auto-detected language: en (p = 0.42)"),
            Some(("en".into(), 0.42))
        );
        assert_eq!(
            guess("auto-detected language: su (p = 1.000001)"),
            Some(("su".into(), 1.0))
        );
        // No line is no guess: a model that is not multilingual, a runtime
        // that failed, an empty log.
        for none in [
            "",
            "whisper_lang_auto_detect_with_state: error: model is not multilingual\n",
            "error: failed to read audio file 'speech.wav'\n",
            "main: processing 'speech.wav' (480000 samples, 30.0 sec), lang = auto\n",
            // Malformed, or not a language the speech model's table holds.
            "auto-detected language: de",
            "auto-detected language: de (p = high)",
            "auto-detected language: de (p = nan)",
            "auto-detected language: de (p = -0.5)",
            "auto-detected language: xx (p = 0.99)",
            "auto-detected language:  (p = 0.99)",
        ] {
            assert_eq!(parse_detected(none), None, "{none}");
        }
    }
    #[test]
    fn a_take_is_heard_in_windows_of_speech_only_audio() {
        // The first 30 s of speech, the pauses and the noise between left out.
        let regions = [(5_000, 15_000), (40_000, 70_000), (100_000, 160_000)];
        assert_eq!(
            window_spans(&regions, 0),
            [(5_000, 15_000), (40_000, 60_000)]
        );
        assert_eq!(
            window_spans(&regions, 1),
            [(60_000, 70_000), (100_000, 120_000)]
        );
        assert_eq!(window_spans(&regions, 2), [(120_000, 150_000)]);
        assert_eq!(window_spans(&regions, 3), [(150_000, 160_000)]);
        assert!(window_spans(&regions, 4).is_empty());
        // Less than one window of speech: one short window, then nothing.
        assert_eq!(window_spans(&[(2_000, 9_500)], 0), [(2_000, 9_500)]);
        assert!(window_spans(&[(2_000, 9_500)], 1).is_empty());
        assert!(window_spans(&[], 0).is_empty());

        // The window's audio is those spans back to back.
        let folder = tempfile::tempdir().unwrap();
        let (speech, window) = (
            folder.path().join("speech.wav"),
            folder.path().join("w.wav"),
        );
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&speech, spec).unwrap();
        // Each sample holds the tenth of a second it lies in.
        for sample in 0..16_000 * 4 {
            writer.write_sample((sample / 1_600) as i16).unwrap();
        }
        writer.finalize().unwrap();
        wav_spans(
            &speech,
            &window,
            &[(500, 1_000), (3_000, 3_200), (3_900, 9_000)],
        )
        .unwrap();
        let samples: Vec<i16> = hound::WavReader::open(&window)
            .unwrap()
            .samples()
            .map(Result::unwrap)
            .collect();
        assert_eq!(samples.len(), 16 * (500 + 200 + 100));
        assert_eq!(
            (
                samples[0],
                samples[8_000 - 1],
                samples[8_000],
                samples[11_200]
            ),
            (5, 9, 30, 39)
        );
    }
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
        assert!(
            accept_whisper_output(&prefix, &folder.path().join("whisper.json"))
                .unwrap_err()
                .contains("fresh transcript")
        );
        assert_eq!(fs::read(&canonical).unwrap(), original);
        let fresh = prefix.with_extension("json");
        for malformed in [
            b"{broken".as_slice(),
            br#"{"transcription":[{"text":"untimed","tokens":[]}]}"#,
        ] {
            fs::write(&fresh, malformed).unwrap();
            assert!(accept_whisper_output(&prefix, &folder.path().join("whisper.json")).is_err());
            assert_eq!(fs::read(&canonical).unwrap(), original);
            assert_eq!(fs::read(&fresh).unwrap(), malformed);
        }
        let valid = b"{\n  \"transcription\": []\n}\n";
        fs::write(&fresh, valid).unwrap();
        assert!(
            accept_whisper_output(&prefix, &folder.path().join("whisper.json"))
                .unwrap()
                .segments
                .is_empty()
        );
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
    fn alignment_presets_must_be_known_whisper_presets() {
        assert_eq!(dtw_preset(None).unwrap(), None);
        for preset in ["base", "small.en", "small", "base.en"] {
            assert_eq!(dtw_preset(Some(preset)).unwrap().as_deref(), Some(preset));
        }
        assert!(dtw_preset(Some("guessed-file-name")).is_err());
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
    fn take(
        index: u32,
        offset_ms: u64,
        duration_ms: u64,
        status: TakeStatus,
        audio: bool,
    ) -> crate::models::Take {
        crate::models::Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: takes::folder_label(index),
            source_id: None,
            microphone_id: audio.then(|| "mic:Studio".into()),
            system_audio: false,
        }
    }
    /// A session in error whose takes are `takes`, in a fresh store.
    fn take_session(takes: Vec<crate::models::Take>) -> (tempfile::TempDir, Store, String) {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(temp.path().into()).unwrap();
        let mut session = store
            .create_session(
                None,
                Some("Takes"),
                &crate::models::CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: Some("mic:Studio".into()),
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        session.status = "error".into();
        session.duration_ms = takes
            .iter()
            .map(|t| t.offset_ms + t.duration_ms)
            .max()
            .unwrap();
        session.takes = takes;
        store.save_session(&session).unwrap();
        (temp, store, session.id)
    }
    #[test]
    fn the_audio_a_take_is_transcribed_from() {
        let folder = tempfile::tempdir().unwrap();
        let has = |name: &str| fs::write(folder.path().join(name), b"").unwrap();
        let saved = |name: &str| Some(Stretches::new(name, Some("en")));
        let source = |usable: &dyn Fn(&str) -> Option<Stretches>| {
            let (path, stretches) = media_source(folder.path(), usable);
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                stretches.map(|s| s.source),
            )
        };
        assert_eq!(source(&|_| None), ("video.mp4".into(), None));
        has("audio.wav");
        has("system.wav");
        // System audio replaces the mix only with stretches cut from it.
        assert_eq!(source(&|_| None), ("audio.wav".into(), None));
        assert_eq!(
            source(&saved),
            ("system.wav".into(), Some("system.wav".into()))
        );
        has("mic.wav");
        assert_eq!(source(&saved), ("mic.wav".into(), Some("mic.wav".into())));
        assert_eq!(source(&|_| None), ("mic.wav".into(), None));
        // Stop forgets stretches it cannot use, and keeps those it uses.
        let kept = Stretches::new("mic.wav", Some("en"));
        stretches::save(folder.path(), &kept).unwrap();
        let file = stretches::folder(folder.path()).join("stretches.json");
        reused_source(folder.path(), saved);
        assert!(file.exists());
        reused_source(folder.path(), |_| None);
        assert!(!file.exists());
    }
    #[test]
    fn stop_s_stretches_are_refined_by_a_whole_take_pass() {
        let (_temp, store, id) = take_session(vec![
            take(1, 0, 60_000, TakeStatus::Ready, true),
            take(2, 60_000, 30_000, TakeStatus::Ready, true),
        ]);
        let dir = store.session_dir(&id).unwrap();
        // Take 2 stopped with stretches; take 1 was transcribed whole.
        let take_two = takes::take_dir(&dir, 2);
        let mut saved = Stretches::new("mic.wav", Some("en"));
        saved.push(spoken("fast"), 20_000, "en", "ggml-small.en.bin", None);
        stretches::save(&take_two, &saved).unwrap();
        let fast = takes::merge_take(
            &Transcript::default(),
            spoken("fast"),
            2,
            60_000,
            Vec::new(),
        );
        store.save_transcript(&id, &fast).unwrap();
        let folders = std::cell::RefCell::new(Vec::new());
        let whole = |folder: &Path, _: u64, _: bool| {
            folders.borrow_mut().push(folder.to_owned());
            Ok(spoken("whole"))
        };
        assert!(refine_with(&store, &id, &whole).unwrap());
        assert_eq!(folders.borrow().as_slice(), std::slice::from_ref(&take_two));
        let words: Vec<_> = store
            .transcript(&id)
            .unwrap()
            .segments
            .iter()
            .flat_map(|s| &s.words)
            .map(|w| w.text.clone())
            .collect();
        assert_eq!(words, ["whole"]);
        // Refined once: the stretches are forgotten, so nothing is left to refine.
        assert!(stretches::language(&take_two).is_none());
        assert!(!refine_with(&store, &id, &whole).unwrap());
        assert_eq!(folders.borrow().len(), 1);
    }
    /// What a take's own transcript looks like: one segment 100 ms in.
    fn spoken(text: &str) -> Transcript {
        let mut transcript = sample_transcript(&[(text, 100, 900)]);
        transcript.segments[0].id = "segment-0".into();
        transcript
    }
    fn mark(index: u32, start_ms: u64) -> crate::models::TakeMark {
        crate::models::TakeMark {
            index,
            start_ms,
            ..Default::default()
        }
    }

    /// `transcript` as a whole-take pass returns it: in `language`,
    /// detected under Auto or chosen in Settings.
    fn heard_in(mut transcript: Transcript, language: &str, detected: bool) -> Transcript {
        transcript.language = Some(language.into());
        transcript.language_detected = detected;
        transcript
    }
    fn mark_in(
        index: u32,
        start_ms: u64,
        language: &str,
        detected: bool,
    ) -> crate::models::TakeMark {
        crate::models::TakeMark {
            index,
            start_ms,
            language: Some(language.into()),
            language_detected: detected,
        }
    }

    #[test]
    fn each_take_is_detected_on_its_own() {
        let (_temp, store, id) = take_session(vec![
            take(1, 0, 2000, TakeStatus::Ready, true),
            take(2, 2000, 1500, TakeStatus::Transcribing, true),
        ]);
        let dir = store.session_dir(&id).unwrap();
        // The session's first take was recorded alone, in German.
        store
            .save_transcript(&id, &heard_in(spoken("erste"), "de", true))
            .unwrap();
        // Record more, speaking English: only the new take's audio is heard.
        let heard = std::cell::RefCell::new(Vec::new());
        let english = |folder: &Path, _: u64, _: bool| {
            heard.borrow_mut().push(folder.to_owned());
            Ok(heard_in(spoken("second"), "en", true))
        };
        let merged = transcribe_take_with(&store, &id, 2, &english).unwrap();
        assert_eq!(*heard.borrow(), [takes::take_dir(&dir, 2)]);
        // The first take stays German, the new one is English.
        assert_eq!(
            merged.takes,
            [mark_in(1, 0, "de", true), mark_in(2, 2000, "en", true)]
        );
        let texts: Vec<_> = merged.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["erste", "second"]);
        assert_eq!(
            (merged.language.as_deref(), merged.language_detected),
            (Some("de"), true)
        );
        assert_eq!(store.transcript(&id).unwrap().takes, merged.takes);

        // Transcribing the whole session hears every take from its own
        // folder, so each gets its own language again.
        let each = |folder: &Path, _: u64, _: bool| {
            Ok(if folder == dir {
                heard_in(spoken("erste"), "de", true)
            } else {
                heard_in(spoken("second"), "en", true)
            })
        };
        let all = transcribe_with(&store, &id, &each).unwrap();
        assert_eq!(all.takes, merged.takes);

        // A take transcribed under a language chosen in Settings is marked
        // as chosen, and the other keeps what was detected in it.
        let french = |_: &Path, _: u64, _: bool| Ok(heard_in(spoken("deuxieme"), "fr", false));
        let chosen = transcribe_take_with(&store, &id, 2, &french).unwrap();
        assert_eq!(
            chosen.takes,
            [mark_in(1, 0, "de", true), mark_in(2, 2000, "fr", false)]
        );
        // A take that fails to transcribe keeps every take's language.
        let fails = |_: &Path, _: u64, _: bool| Err::<Transcript, _>("No model.".to_string());
        assert!(transcribe_take_with(&store, &id, 2, &fails).is_err());
        assert_eq!(store.transcript(&id).unwrap().takes, chosen.takes);
        // A take without words has no language.
        let silent = |_: &Path, _: u64, _: bool| Ok(empty_transcript());
        let quiet = transcribe_take_with(&store, &id, 2, &silent).unwrap();
        assert_eq!(quiet.takes, [mark_in(1, 0, "de", true), mark(2, 2000)]);
    }

    fn chosen(language: &str) -> crate::models::Settings {
        crate::models::Settings {
            language: Some(language.into()),
            ..Default::default()
        }
    }
    fn guessed(language: &str, p: f32) -> Guess {
        Guess {
            language: language.into(),
            p,
        }
    }
    /// A data root and in it a take folder with a microphone track.
    fn take_folder() -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("take");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("mic.wav"), b"").unwrap();
        (root, folder)
    }
    fn in_language(transcript: &Transcript) -> (Option<&str>, bool) {
        (transcript.language.as_deref(), transcript.language_detected)
    }

    #[test]
    fn a_whole_take_pass_is_held_by_settings_or_by_its_stretches() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("take");
        let auto = crate::models::Settings::default();
        let german = chosen("de");
        // Auto and no stretches: nothing holds the take, the pass detects.
        assert_eq!(held_language(&auto, &folder, None, false), None);
        // A language chosen in Settings holds it without detecting.
        assert_eq!(
            held_language(&german, &folder, None, false),
            Some(("de", false))
        );
        // Stop reuses stretches the live worker decided as French.
        let mut decided = Stretches::new("mic.wav", None);
        decided.push(
            spoken("oui"),
            10_000,
            "fr",
            "ggml-small.bin",
            Some(guessed("fr", 0.95)),
        );
        assert_eq!(
            held_language(&auto, &folder, Some(&decided), false),
            Some(("fr", true))
        );
        // The refining pass reads the same decision from the file Stop
        // left, and keeps it whatever Settings say by then.
        stretches::save(&folder, &decided).unwrap();
        assert_eq!(
            held_language(&auto, &folder, None, true),
            Some(("fr", true))
        );
        assert_eq!(
            held_language(&german, &folder, None, true),
            Some(("fr", true))
        );
        // Any other pass follows Settings, and Retry and `cue transcribe`
        // forget the stretches: under Auto they detect again.
        assert_eq!(
            held_language(&german, &folder, None, false),
            Some(("de", false))
        );
        stretches::forget(&folder);
        assert_eq!(held_language(&auto, &folder, None, true), None);
        assert_eq!(held_language(&auto, &folder, None, false), None);
    }

    #[test]
    fn a_whole_take_pass_detects_under_auto_and_never_under_a_chosen_language() {
        let (root, folder) = take_folder();
        // No language chosen and no stretches (Stop without usable ones,
        // Retry, `cue transcribe`): the pass asks the detector once and
        // transcribes in what it heard.
        let german = FakePass::hearing("de");
        let transcript = german.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(german.detections.get(), 1);
        assert_eq!(*german.languages.borrow(), ["de"]);
        assert_eq!(in_language(&transcript), (Some("de"), true));
        assert_eq!(transcript.segments[0].text, "de-words");
        // Each pass hears for itself: nothing of the last one holds the next.
        let english = FakePass::hearing("en");
        let transcript = english.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(english.detections.get(), 1);
        assert_eq!(*english.languages.borrow(), ["en"]);
        assert_eq!(in_language(&transcript), (Some("en"), true));
        // No guess at all: English.
        let unheard = FakePass::default();
        let transcript = unheard.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(unheard.detections.get(), 1);
        assert_eq!(*unheard.languages.borrow(), ["en"]);
        assert_eq!(in_language(&transcript), (Some("en"), true));
        // No speech: nothing to detect or transcribe, and no language.
        let silent = FakePass {
            silent: true,
            ..FakePass::hearing("de")
        };
        let transcript = silent.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(silent.detections.get(), 0);
        assert!(silent.languages.borrow().is_empty() && transcript.segments.is_empty());
        assert_eq!(in_language(&transcript), (None, false));

        // A language chosen in Settings: the detector is never asked,
        // whatever it would hear.
        settings::save(root.path(), &chosen("fr")).unwrap();
        let held = FakePass::hearing("de");
        let transcript = held.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(held.detections.get(), 0);
        assert_eq!(*held.languages.borrow(), ["fr"]);
        assert_eq!(in_language(&transcript), (Some("fr"), false));
    }

    #[test]
    fn the_refining_pass_keeps_the_language_stop_saved_with_the_stretches() {
        let (root, folder) = take_folder();
        // Recorded under Auto and decided as German; Stop left that with
        // the stretches. Then English is chosen in Settings.
        let mut german = Stretches::new("mic.wav", None);
        german.push(
            spoken("eins"),
            10_000,
            "de",
            "ggml-small.bin",
            Some(guessed("de", 0.97)),
        );
        stretches::save(&folder, &german).unwrap();
        settings::save(root.path(), &chosen("en")).unwrap();
        // The refining pass (it never reuses the stretches' words) stays in
        // German, still marked as detected, and detects nothing.
        let refine = FakePass::hearing("ja");
        let transcript = refine.run(root.path(), &folder, 20_000, false).unwrap();
        assert_eq!(*refine.languages.borrow(), ["de"]);
        assert_eq!(refine.detections.get(), 0);
        assert_eq!(in_language(&transcript), (Some("de"), true));
        // The whole take was transcribed, not only what follows the stretches.
        assert_eq!(*refine.converted.borrow(), [(None, Some(20_000))]);

        // Recorded under a chosen English; then Settings go back to Auto.
        // The refined take is still English, and not "detected".
        let mut english = Stretches::new("mic.wav", Some("en"));
        english.push(spoken("one"), 10_000, "en", "ggml-small.en.bin", None);
        stretches::save(&folder, &english).unwrap();
        settings::save(root.path(), &crate::models::Settings::default()).unwrap();
        let refine = FakePass::hearing("ja");
        let transcript = refine.run(root.path(), &folder, 20_000, false).unwrap();
        assert_eq!(*refine.languages.borrow(), ["en"]);
        assert_eq!(refine.detections.get(), 0);
        assert_eq!(in_language(&transcript), (Some("en"), false));

        // Retry and `cue transcribe` forget the stretches and follow the
        // choice that holds now: Auto, so they detect again.
        stretches::forget(&folder);
        let retry = FakePass::hearing("ja");
        let transcript = retry.run(root.path(), &folder, 20_000, true).unwrap();
        assert_eq!(retry.detections.get(), 1);
        assert_eq!(in_language(&transcript), (Some("ja"), true));
        // And a language chosen by then holds them.
        settings::save(root.path(), &chosen("fr")).unwrap();
        let retry = FakePass::hearing("ja");
        let transcript = retry.run(root.path(), &folder, 20_000, true).unwrap();
        assert_eq!(retry.detections.get(), 0);
        assert_eq!(in_language(&transcript), (Some("fr"), false));
    }

    #[test]
    fn stop_redoes_the_stretches_made_in_another_language_and_keeps_the_decision() {
        let (root, folder) = take_folder();
        // An unclear start taken for English, then German decided the take.
        let mut take = Stretches::new("mic.wav", None);
        take.push(
            spoken("nonsense"),
            12_000,
            "en",
            "ggml-small.en.bin",
            Some(guessed("en", 0.5)),
        );
        take.push(
            spoken("zwei"),
            30_000,
            "de",
            "ggml-small.bin",
            Some(guessed("de", 0.96)),
        );
        stretches::save(&folder, &take).unwrap();
        // Stop: the first stretch again from the take's audio in German,
        // then only the audio after the stretches, with nothing detected.
        let stop = FakePass::hearing("ja");
        let transcript = stop.run(root.path(), &folder, 40_000, true).unwrap();
        assert_eq!(stop.detections.get(), 0);
        assert_eq!(*stop.languages.borrow(), ["de", "de"]);
        assert_eq!(
            *stop.converted.borrow(),
            [(None, Some(12_000)), (Some(30_000), Some(10_000))]
        );
        assert_eq!(in_language(&transcript), (Some("de"), true));
        let texts: Vec<_> = transcript
            .segments
            .iter()
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(texts, ["de-words", "zwei", "de-words"]);
        let kept: Stretches = read_json(&folder.join("stretches/stretches.json")).unwrap();
        assert!(kept.to_redo().is_empty());
        assert_eq!(stretches::language(&folder), Some(("de".into(), true)));

        // Stopped undecided: settled on the likeliest language, which is
        // saved for the refining pass even when nothing had to be redone.
        let mut undecided = Stretches::new("mic.wav", None);
        undecided.push(
            spoken("eins"),
            12_000,
            "de",
            "ggml-small.bin",
            Some(guessed("de", 0.7)),
        );
        stretches::save(&folder, &undecided).unwrap();
        assert_eq!(stretches::language(&folder), None);
        let stop = FakePass::hearing("ja");
        let transcript = stop.run(root.path(), &folder, 40_000, true).unwrap();
        assert_eq!(*stop.languages.borrow(), ["de"]);
        assert_eq!(in_language(&transcript), (Some("de"), true));
        assert_eq!(stretches::language(&folder), Some(("de".into(), true)));
    }

    #[test]
    fn a_session_with_takes_is_transcribed_take_by_take_on_its_timeline() {
        let (_temp, store, id) = take_session(vec![
            take(1, 0, 2000, TakeStatus::Ready, true),
            take(2, 2000, 1500, TakeStatus::Error, true),
            take(3, 3500, 400, TakeStatus::Interrupted, true),
            take(4, 3500, 1000, TakeStatus::Ready, false),
        ]);
        let dir = store.session_dir(&id).unwrap();
        let calls = std::sync::Mutex::new(Vec::new());
        let second_fails = |fail: bool| {
            let calls = &calls;
            let dir = dir.clone();
            move |folder: &Path, duration_ms: u64, has_audio: bool| {
                calls
                    .lock()
                    .unwrap()
                    .push((folder.to_owned(), duration_ms, has_audio));
                if !has_audio {
                    return Ok(empty_transcript());
                }
                if folder == takes::take_dir(&dir, 2) {
                    if fail {
                        return Err("Install the local speech model.".to_string());
                    }
                    return Ok(spoken("second"));
                }
                Ok(spoken("first"))
            }
        };
        let error = transcribe_with(&store, &id, &second_fails(true)).unwrap_err();
        assert_eq!(error, "Install the local speech model.");
        // Every take on the timeline, from its own folder, for its own length.
        assert_eq!(
            *calls.lock().unwrap(),
            [
                (dir.clone(), 2000, true),
                (takes::take_dir(&dir, 2), 1500, true),
                (takes::take_dir(&dir, 4), 1000, false),
            ]
        );
        let session = store.session(&id).unwrap();
        let statuses: Vec<_> = session.takes.iter().map(|t| (t.index, t.status)).collect();
        assert_eq!(
            statuses,
            [
                (1, TakeStatus::Ready),
                (2, TakeStatus::Error),
                (3, TakeStatus::Interrupted),
                (4, TakeStatus::Ready)
            ]
        );
        let saved = store.transcript(&id).unwrap();
        assert_eq!(saved.segments.len(), 1);
        assert_eq!(saved.segments[0].text, "first");
        // Each take is marked; only the one with words has a language.
        assert_eq!(
            saved.takes,
            [mark_in(1, 0, "en", false), mark(2, 2000), mark(4, 3500)]
        );

        // Once take 2 succeeds, its words land at its offset with its prefix.
        let transcript = transcribe_with(&store, &id, &second_fails(false)).unwrap();
        let placed: Vec<_> = transcript
            .segments
            .iter()
            .map(|s| (s.id.as_str(), s.start_ms, s.words[0].start_ms))
            .collect();
        assert_eq!(
            placed,
            [("segment-0", 100, 100), ("t2-segment-0", 2100, 2100)]
        );
        assert_eq!(
            store.session(&id).unwrap().takes[1].status,
            TakeStatus::Ready
        );
        assert_eq!(
            serde_json::to_value(store.transcript(&id).unwrap()).unwrap(),
            serde_json::to_value(&transcript).unwrap()
        );

        // A take still waiting to be joined stops it, saying why it could not be checked.
        store
            .update_session(&id, |s| {
                s.takes.push(take(5, 4500, 800, TakeStatus::Swapping, true));
                Ok(())
            })
            .unwrap();
        let error = transcribe_with(&store, &id, &|_, _, _| panic!("transcribed")).unwrap_err();
        assert!(
            error.contains("Take 5 was saved by an earlier CueReview")
                && error.contains("Try again once video.mp4 can be read"),
            "{error}"
        );
    }

    #[test]
    fn a_take_that_fails_to_transcribe_still_gets_its_divider() {
        let (_temp, store, id) = take_session(vec![
            take(1, 0, 2000, TakeStatus::Ready, true),
            take(2, 2000, 1500, TakeStatus::Transcribing, true),
        ]);
        let first = spoken("first");
        store.save_transcript(&id, &first).unwrap();
        let missing = |_: &Path, _: u64, _: bool| {
            Err::<Transcript, _>("Install the local speech model.".to_string())
        };
        assert!(transcribe_take_with(&store, &id, 2, &missing).is_err());
        let saved = store.transcript(&id).unwrap();
        assert_eq!(saved.takes, [mark_in(1, 0, "en", false), mark(2, 2000)]);
        assert_eq!(saved.segments.len(), 1);
        assert_eq!(saved.segments[0].text, "first");
        // A later success adds the take's words beside the same dividers.
        let merged = transcribe_take_with(&store, &id, 2, &|_, _, _| Ok(spoken("second"))).unwrap();
        assert_eq!(merged.segments[1].id, "t2-segment-0");
        assert_eq!(merged.segments[1].start_ms, 2100);
        assert_eq!(
            merged.takes,
            [mark_in(1, 0, "en", false), mark_in(2, 2000, "en", false)]
        );
        // Takes off the timeline are refused before anything runs.
        store
            .update_session(&id, |s| {
                s.takes[1].status = TakeStatus::Swapping;
                Ok(())
            })
            .unwrap();
        assert!(
            transcribe_take_with(&store, &id, 2, &|_, _, _| panic!("ran"))
                .unwrap_err()
                .contains("not part of the recording yet")
        );
    }

    /// What the German sample says when a Windows voice reads it: a review
    /// of about 50 s.
    const GERMAN_REVIEW: &str = "Ich öffne jetzt die Bibliothek und schaue mir die Übersicht an. \
        Der Übergang zwischen den Seiten fühlt sich immer noch langsam an. \
        Wenn ich hier auf diese Schaltfläche klicke, wird die Detailansicht nicht aktualisiert. \
        Das sollten wir vor der nächsten Veröffentlichung unbedingt beheben. \
        Die Suche funktioniert inzwischen gut, aber die Ergebnisse erscheinen in der falschen Reihenfolge. \
        Außerdem ist der Text in der Seitenleiste zu klein und schwer zu lesen. \
        Bitte verschiebt diesen Knopf in die obere Werkzeugleiste, damit man ihn schneller findet. \
        Danach schauen wir uns gemeinsam die Einstellungen an und prüfen, ob die Sprache richtig erkannt wird. \
        Zum Schluss möchte ich noch einmal die Aufnahme abspielen und kontrollieren, ob der Ton und das Bild zusammenpassen. \
        Das war alles für heute, vielen Dank fürs Zuhören.";
    /// German speech for the test below: the file `CUEREVIEW_GERMAN_SAMPLE`
    /// names, else [`GERMAN_REVIEW`] read into `target` by an installed
    /// German Windows voice, written to the file without playing it, as
    /// `verify-pipeline.ps1` makes the English fixture.
    fn german_sample(target: &Path) -> std::path::PathBuf {
        if let Some(sample) = std::env::var_os("CUEREVIEW_GERMAN_SAMPLE") {
            return sample.into();
        }
        let script = "Add-Type -AssemblyName System.Speech; \
            $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
            $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'de' } | Select-Object -First 1; \
            if (-not $v) { exit 3 }; \
            $s.SelectVoice($v.VoiceInfo.Name); \
            $s.SetOutputToWaveFile($env:CUEREVIEW_SPEECH_TARGET); \
            $s.Speak($env:CUEREVIEW_SPEECH_TEXT); \
            $s.Dispose()";
        let spoken = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("CUEREVIEW_SPEECH_TARGET", target)
            .env("CUEREVIEW_SPEECH_TEXT", GERMAN_REVIEW)
            .status();
        assert!(
            spoken.is_ok_and(|status| status.success()) && target.is_file(),
            "No installed Windows voice speaks German. Set CUEREVIEW_GERMAN_SAMPLE to a recording of at least 31 s of German speech."
        );
        target.to_owned()
    }
    #[test]
    #[ignore = "Requires Whisper, FFmpeg, base, small.en, small and the detector in CUEREVIEW_DATA_DIR, and German speech: CUEREVIEW_GERMAN_SAMPLE or an installed German Windows voice"]
    fn actual_german_speech_is_detected_and_transcribed_as_german() {
        let scratch = tempfile::tempdir().unwrap();
        // A data root without settings.json: no language was ever chosen.
        let root = scratch.path().join("data");
        let take = root.join("take");
        let live = take.join("live");
        fs::create_dir_all(&live).unwrap();
        let sample = german_sample(&scratch.path().join("german.wav"));
        let mic = take.join("mic.wav");
        to_speech(&sample, &mic, None, None, &take.join("sample.log"), None).unwrap();
        let wav = hound::WavReader::open(&mic).unwrap();
        let length_ms = wav.duration() as u64 * 1000 / wav.spec().sample_rate as u64;
        assert!(
            length_ms >= 31_000,
            "the German sample lasts {length_ms} ms; one stretch needs at least 31 s"
        );
        let small = "ggml-small.bin";
        assert_eq!(
            file_name(&deps::final_model("de").path),
            small,
            "the multilingual small model is installed"
        );
        let languages = |transcript: &Transcript| {
            (
                transcript.language.clone().unwrap_or_default(),
                transcript.language_detected,
            )
        };
        let says = |transcript: &Transcript, word: &str| {
            !crate::agent::find(transcript, word).unwrap().is_empty()
        };
        // The words of the review the Windows voice reads; a sample of
        // one's own says what it says.
        let own = std::env::var_os("CUEREVIEW_GERMAN_SAMPLE").is_some();
        let keeps = |transcript: &Transcript, word: &str| own || says(transcript, word);

        // While it records: the live worker's two steps on the first 45 s.
        let cancel = AtomicBool::new(false);
        let heard_ms = length_ms.min(45_000);
        let snapshot = live.join("snapshot.wav");
        wav_slice(&mic, &snapshot, 0, heard_ms).unwrap();
        let models = deps::TakeModels::now();
        let mut stretches = Stretches::new("mic.wav", None);
        let (guess, audio) = live_guess(&root, &live, &snapshot, heard_ms, None, &cancel).unwrap();
        // Before the decision base detects by itself, and shows German words.
        assert_eq!(guess.language.as_deref(), Some("de"));
        live_commit(
            &root,
            &take,
            &live,
            &models,
            &mut stretches,
            &audio.unwrap(),
            guess,
            &cancel,
        )
        .unwrap();
        // The first finished stretch decided the take, and the multilingual
        // small model transcribed it held to German.
        let first = stretches.parts.first().expect("a stretch finished").clone();
        eprintln!("first stretch: {first:?}");
        assert_eq!(
            (stretches.language.as_deref(), stretches.language_detected),
            (Some("de"), true)
        );
        assert_eq!(
            (first.language.as_str(), first.model.as_str()),
            ("de", small)
        );
        assert!(first
            .guess
            .is_some_and(|guess| guess.language == "de" && guess.p >= stretches::CONFIDENT));
        assert!(stretches.to_redo().is_empty());
        let shown = stretches.live(Transcript::default(), 0, 0);
        assert_eq!(languages(&shown), ("de".into(), true));
        assert!(keeps(&shown, "Bibliothek"), "{:?}", shown.segments);

        // After Stop: the stretches are reused and the rest is held to German.
        let raw_language = || {
            let raw: Value = read_json(&take.join("whisper.json")).unwrap();
            raw["result"]["language"].as_str().map(str::to_owned)
        };
        let stopped = transcribe_media(&root, &take, length_ms, true).unwrap();
        assert_eq!(languages(&stopped), ("de".into(), true));
        assert_eq!(
            stretches::language(&take),
            Some(("de".into(), true)),
            "Stop reused the stretches"
        );
        assert_eq!(raw_language().as_deref(), Some("de"));
        assert!(keeps(&stopped, "Bibliothek") && keeps(&stopped, "Einstellungen"));

        // Retry and `cue transcribe`: the whole take, its language detected
        // from its speech again.
        stretches::forget(&take);
        fs::remove_file(live.join("language.log")).unwrap();
        let whole = transcribe_media(&root, &take, length_ms, true).unwrap();
        assert_eq!(languages(&whole), ("de".into(), true));
        assert_eq!(raw_language().as_deref(), Some("de"));
        let detection = fs::read_to_string(take.join("language.log")).unwrap();
        let heard = parse_detected(&detection).expect("a guess in language.log");
        eprintln!("whole take: {heard:?}");
        assert!(heard.language == "de" && heard.p >= stretches::CONFIDENT);
        let log = fs::read_to_string(take.join("transcription.log")).unwrap();
        assert!(log.contains(small), "the German take ran on {small}");
        for word in ["Bibliothek", "Schaltfläche", "Einstellungen"] {
            assert!(keeps(&whole, word), "the transcript lost {word}");
        }
        eprintln!(
            "{}",
            whole
                .segments
                .iter()
                .map(|segment| segment.text.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        );

        // While it still records: a stretch taken for French before the
        // take was decided is transcribed again from a copy of the live
        // track made as the live worker makes it, from the stretch's start
        // for up to 60 s.
        let mut early = Stretches::new("mic.wav", None);
        early.push(
            spoken("erste"),
            12_000,
            "de",
            small,
            Some(guessed("de", 0.6)),
        );
        early.push(
            spoken("faux"),
            first.end_ms,
            "fr",
            small,
            Some(guessed("fr", 0.5)),
        );
        let deciding = early.push(
            spoken("dritte"),
            first.end_ms + 5_000,
            "de",
            small,
            Some(guessed("de", 0.95)),
        );
        assert!(deciding, "the third stretch decides and leaves one to redo");
        let mut redo = stretches::Redo::default();
        let copies = std::cell::RefCell::new(Vec::new());
        let outcome = redo_provisional(
            &root,
            &take,
            &live,
            &models,
            &mut early,
            &mut redo,
            &cancel,
            &mut |from_ms, target| {
                copies.borrow_mut().push(from_ms);
                wav_slice(&mic, target, from_ms, from_ms + 60_000)
            },
        );
        assert_eq!(outcome, stretches::Redone::Done);
        assert_eq!(*copies.borrow(), [12_000]);
        assert!(early.to_redo().is_empty() && !redo.pending(&early));
        let again = &early.parts[1];
        assert_eq!(
            (
                again.language.as_str(),
                again.model.as_str(),
                again.provisional
            ),
            ("de", small, false)
        );
        // The stretch's words are what is said from 12 s on, in German; the
        // stretches around it keep theirs.
        let inside = |segment: &&Segment| (12_000..first.end_ms).contains(&segment.start_ms);
        let stretch = Transcript {
            segments: early.segments.iter().filter(inside).cloned().collect(),
            ..Default::default()
        };
        eprintln!(
            "redone while recording: {:?}",
            stretch.segments.iter().map(|s| &s.text).collect::<Vec<_>>()
        );
        assert!(!stretch.segments.is_empty() && !says(&stretch, "faux"));
        assert!(keeps(&stretch, "Ergebnisse") && (own || !says(&stretch, "Bibliothek")));
        let all = Transcript {
            segments: early.segments.clone(),
            ..Default::default()
        };
        assert!(says(&all, "erste") && says(&all, "dritte"));
        let saved_early: Stretches = read_json(&take.join("stretches/stretches.json")).unwrap();
        assert!(saved_early.to_redo().is_empty());

        // An unclear start: the first 10 s were taken for French before a
        // later stretch decided the take. Stop transcribes them again from
        // the take's audio, in German.
        let mut unclear = Stretches::new("mic.wav", None);
        unclear.push(
            spoken("faux"),
            10_000,
            "fr",
            small,
            Some(guessed("fr", 0.5)),
        );
        unclear.push(
            spoken("zweite"),
            first.end_ms,
            "de",
            small,
            Some(guessed("de", 0.95)),
        );
        assert_eq!(unclear.to_redo().len(), 1);
        stretches::save(&take, &unclear).unwrap();
        let redone = transcribe_media(&root, &take, length_ms, true).unwrap();
        assert_eq!(languages(&redone), ("de".into(), true));
        assert!(keeps(&redone, "Bibliothek") && !says(&redone, "faux"));
        assert!(says(&redone, "zweite"), "the decided stretch is kept");
        let kept: Stretches = read_json(&take.join("stretches/stretches.json")).unwrap();
        assert!(kept.to_redo().is_empty() && kept.parts.iter().all(|part| part.language == "de"));

        // A language chosen in Settings holds the take without detecting.
        stretches::forget(&take);
        let german = crate::models::Settings {
            language: Some("de".into()),
            ..Default::default()
        };
        settings::save(&root, &german).unwrap();
        fs::remove_file(take.join("language.log")).unwrap();
        let held = transcribe_media(&root, &take, length_ms, true).unwrap();
        assert_eq!(languages(&held), ("de".into(), false));
        assert!(
            !take.join("language.log").exists(),
            "nothing is detected under a chosen language"
        );
        assert!(keeps(&held, "Bibliothek"));
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
        let update =
            transcribe_snapshot(&folder, &source, &folder, &AtomicBool::new(false)).unwrap();
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
        let result = transcribe_snapshot(&cancel_dir, &source, &cancel_dir, &cancelled);
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
        let quiet = transcribe_snapshot(&output, &noise, &output, &AtomicBool::new(false)).unwrap();
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
        let spoken =
            transcribe_snapshot(&output, &attenuated, &output, &AtomicBool::new(false)).unwrap();
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
        let gated = transcribe_snapshot(
            output.path(),
            &fixture.join("delayed-speech.wav"),
            output.path(),
            &cancel,
        )
        .unwrap();
        let model = deps::live_model();
        let mut baseline = deps::command("whisper-cli").unwrap();
        alignment_options(&mut baseline, &model).unwrap();
        baseline
            .arg("-m")
            .arg(&model.path)
            .arg("-f")
            .arg(output.path().join("speech.wav"))
            .args(decoding_options(output.path(), &model.path, "en"))
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
                Some(&project.id),
                Some("Quiet mic"),
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
            output.path(),
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
            let transcript =
                transcribe_snapshot(output.path(), &source, output.path(), &cancel).unwrap();
            let found = crate::agent::find(&transcript, phrase).unwrap();
            assert!(!found.is_empty(), "Lost {phrase}");
            assert!(found[0].seek_ms.unwrap() < duration);
        }
    }
    #[test]
    #[ignore = "Requires both runtime builds (avx2 subfolder), an AVX2 processor, the model and test-results/speech/reference.wav"]
    fn actual_vector_build_is_faster_than_the_plain_build() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let speech = root.join("test-results/speech/reference.wav");
        let plain = deps::locate("whisper-cli").unwrap();
        let vector = deps::tool("whisper-cli").unwrap();
        assert_ne!(plain, vector, "no avx2 build beside {}", plain.display());
        let folder = tempfile::tempdir().unwrap();
        let time = |binary: &Path, label: &str| {
            let model = deps::live_model();
            let mut whisper = std::process::Command::new(binary);
            alignment_options(&mut whisper, &model).unwrap();
            whisper
                .arg("-m")
                .arg(&model.path)
                .arg("-f")
                .arg(&speech)
                .args(decoding_options(folder.path(), &model.path, "en"))
                .args(["-t", "4", "-of"])
                .arg(folder.path().join(label));
            let started = std::time::Instant::now();
            run_logged(whisper, &folder.path().join(format!("{label}.log"))).unwrap();
            let elapsed = started.elapsed();
            let words = accept_whisper_output(
                &folder.path().join(label),
                &folder.path().join("whisper.json"),
            )
            .unwrap()
            .segments
            .iter()
            .map(|segment| segment.words.len())
            .sum::<usize>();
            (elapsed, words)
        };
        let (slow, slow_words) = time(&plain, "plain");
        let (fast, fast_words) = time(&vector, "avx2");
        println!("plain {slow:?} ({slow_words} words), avx2 {fast:?} ({fast_words} words)");
        assert!(fast_words > 0 && fast_words.abs_diff(slow_words) <= slow_words / 10);
        assert!(
            fast * 3 < slow,
            "avx2 {fast:?} is not three times faster than {slow:?}"
        );
    }
    #[test]
    #[ignore = "Requires installed Whisper/model and test-results/speech/reference.wav; transcribes it as take 2"]
    fn actual_whisper_take_two_keeps_session_offsets() {
        use crate::models::{CaptureConfig, Take, TakeMark};
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let reference = root.join("test-results/speech/reference.wav");
        let wav = hound::WavReader::open(&reference).unwrap();
        let duration = wav.duration() as u64 * 1000 / wav.spec().sample_rate as u64;
        let temp = tempfile::tempdir().unwrap();
        let store = Store::open(temp.path().join("data")).unwrap();
        let mut session = store
            .create_session(
                None,
                Some("Two takes"),
                &CaptureConfig {
                    source_id: "fixture".into(),
                    microphone_id: Some("fixture".into()),
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        let offset = 61_000;
        let take = |index, offset_ms, duration_ms, status| Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: takes::folder_label(index),
            source_id: None,
            microphone_id: Some("fixture".into()),
            system_audio: false,
        };
        session.status = "processing".into();
        session.duration_ms = offset + duration;
        session.takes = vec![
            take(1, 0, offset, TakeStatus::Ready),
            take(2, offset, duration, TakeStatus::Transcribing),
        ];
        store.save_session(&session).unwrap();
        // Take 1's saved transcript must survive untouched.
        let earlier = Segment {
            id: "segment-0".into(),
            start_ms: 1000,
            end_ms: 2000,
            text: "Earlier take.".into(),
            words: vec![Word {
                text: "Earlier".into(),
                start_ms: 1000,
                end_ms: 2000,
                seek_ms: Some(1200),
            }],
        };
        store
            .save_transcript(
                &session.id,
                &Transcript {
                    segments: vec![earlier.clone()],
                    language: Some("en".into()),
                    status: Some("complete".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let folder = takes::take_dir(&store.session_dir(&session.id).unwrap(), 2);
        fs::create_dir_all(&folder).unwrap();
        fs::copy(&reference, folder.join("mic.wav")).unwrap();

        let merged = transcribe_take(&store, &session.id, 2).unwrap();
        // The take's own raw output, timed from the take's first sample.
        let raw: Value = read_json(&folder.join("whisper.json")).unwrap();
        let local = parse_whisper(&raw).unwrap();
        assert!(!local.segments.is_empty());
        assert_eq!(merged.segments[0].id, earlier.id);
        assert_eq!(merged.segments[0].start_ms, earlier.start_ms);
        let shifted = &merged.segments[1..];
        assert_eq!(shifted.len(), local.segments.len());
        for (placed, own) in shifted.iter().zip(&local.segments) {
            assert_eq!(placed.id, format!("t2-{}", own.id));
            assert_eq!(placed.text, own.text);
            assert_eq!(
                (placed.start_ms, placed.end_ms),
                (own.start_ms + offset, own.end_ms + offset)
            );
            for (word, own) in placed.words.iter().zip(&own.words) {
                assert_eq!(word.start_ms, own.start_ms + offset);
                assert_eq!(word.seek_ms, own.seek_ms.map(|seek| seek + offset));
                assert!(word.start_ms >= offset && word.end_ms <= offset + duration);
            }
        }
        let phrase = crate::agent::find(&merged, "click here").unwrap();
        let own = crate::agent::find(&local, "click here").unwrap();
        assert_eq!(phrase[0].start_ms, own[0].start_ms + offset);
        assert!(phrase[0].start_ms > offset);
        assert_eq!(
            merged.takes,
            [
                TakeMark {
                    index: 1,
                    start_ms: 0,
                    language: Some("en".into()),
                    language_detected: false,
                },
                TakeMark {
                    index: 2,
                    start_ms: offset,
                    language: Some("en".into()),
                    language_detected: true,
                }
            ]
        );
        assert_eq!(merged.language.as_deref(), Some("en"));
        // Detected as English under Auto, the take ran on English's model.
        let english = file_name(&deps::final_model("en").path);
        let log = fs::read_to_string(folder.join("transcription.log")).unwrap();
        assert!(log.contains(&english), "take 2 did not run on {english}");
        let saved = store.transcript(&session.id).unwrap();
        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            serde_json::to_value(&merged).unwrap()
        );
        fs::write(
            root.join("test-results/take-offset-transcript.json"),
            serde_json::to_vec_pretty(&merged).unwrap(),
        )
        .unwrap();
    }
}
