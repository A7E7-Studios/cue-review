use crate::{
    deps, echo,
    models::{Segment, TakeStatus, Track, TrackLanguages, Transcript, Word},
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
/// Whisper threads for each track of a take with two, whose two final
/// transcriptions run at the same time: [`final_threads`] where the two
/// together fit the processor, which is from 8 logical threads on (4 each
/// there, 8 each from 16), and half the logical threads below that, so the
/// two never ask for more threads than there are; on a single thread each
/// still gets one.
fn track_threads(logical: usize) -> usize {
    final_threads(logical).min((logical / 2).max(1))
}
fn logical_threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get())
}
/// Whisper threads of a whole-take pass over a take with one track on the
/// processor, which the measurement of the devices times the processor with.
pub(crate) fn whole_take_threads() -> usize {
    final_threads(logical_threads())
}
// The options live in settings.rs so the saved vocabulary can shape them;
// `language` is the language of this run.
#[cfg(test)]
fn decoding_options(root: &Path, model: &Path, language: &str) -> Vec<String> {
    decoding_options_on(root, model, language, None)
}
/// [`decoding_options`] for a run on graphics card `card`, or on the
/// processor with `None`.
fn decoding_options_on(
    root: &Path,
    model: &Path,
    language: &str,
    card: Option<u32>,
) -> Vec<String> {
    settings::decoding_args_on(&settings::load(root), model, language, card)
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
            track: None,
        });
    }
    Ok(Transcript {
        segments,
        language: value["result"]["language"].as_str().map(str::to_owned),
        status: Some("complete".into()),
        ..Default::default()
    })
}
/// What a command that ran to its end and failed is reported as: its exit
/// status and the end of its log.
fn failure(status: std::process::ExitStatus, log: &Path) -> String {
    let detail = fs::read_to_string(log).unwrap_or_default();
    format!(
        "Processing failed ({status}): {}",
        detail
            .chars()
            .rev()
            .take(1800)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    )
}
fn run_logged(mut command: std::process::Command, log: &Path) -> Result<(), String> {
    let file = fs::File::create(log).map_err(|e| e.to_string())?;
    let status = command
        .stdout(Stdio::null())
        .stderr(file)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(failure(status, log));
    }
    Ok(())
}
/// What work that was stopped before its end is reported as.
const CANCELLED: &str = "Live transcription cancelled.";
/// [`run_logged`], with the command killed once `stop` is set: a failure is
/// reported as [`run_logged`] reports it, a stop as [`CANCELLED`].
fn run_stoppable(
    mut command: std::process::Command,
    log: &Path,
    stop: &AtomicBool,
) -> Result<(), String> {
    if stop.load(Ordering::Acquire) {
        return Err(CANCELLED.into());
    }
    let file = fs::File::create(log).map_err(|e| e.to_string())?;
    let mut child = command
        .stdout(Stdio::null())
        .stderr(file)
        .spawn()
        .map_err(|e| e.to_string())?;
    loop {
        if stop.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(failure(status, log)),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    }
}
/// How long a command of a transcription runs.
#[derive(Clone, Copy)]
enum Until<'a> {
    /// To its end ([`run_logged`]).
    Done,
    /// Until a live job or a refinement is cancelled ([`run_live`]).
    Cancelled(&'a AtomicBool),
    /// To its end, unless the pass is stopped ([`run_stoppable`]): a track
    /// of two when the other one has failed.
    Stopped(&'a AtomicBool),
}
impl<'a> From<Option<&'a AtomicBool>> for Until<'a> {
    fn from(cancel: Option<&'a AtomicBool>) -> Self {
        cancel.map_or(Until::Done, Until::Cancelled)
    }
}
fn run_until(command: std::process::Command, log: &Path, until: Until<'_>) -> Result<(), String> {
    match until {
        Until::Done => run_logged(command, log),
        Until::Cancelled(cancel) => run_live(command, log, cancel),
        Until::Stopped(stop) => run_stoppable(command, log, stop),
    }
}
/// The scratch file `name` of the track `speech` belongs to. A take with
/// two tracks is transcribed from both at the same time: the system track's
/// speech files start with `system-`, and so does every file made of them,
/// so no two passes write the same file.
fn scratch(folder: &Path, speech: &Path, name: &str) -> std::path::PathBuf {
    if file_name(speech).starts_with("system-") {
        folder.join(format!("system-{name}"))
    } else {
        folder.join(name)
    }
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
    let output = scratch(folder, speech, "vad.txt");
    let log = scratch(folder, speech, "vad.log");
    run_live_output(detector, &log, cancel, Some(&output))?;
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
/// How far from the speech the detector found a row's time still counts as
/// heard: Whisper's row times drift from the speech they belong to.
const HEARD_SLACK_MS: u64 = 1_000;
/// `transcript` without the rows Whisper made up over silence or noise: a
/// row stays when at least a tenth of its time lies within
/// [`HEARD_SLACK_MS`] of `regions`, the speech found in the same audio, and
/// a row of no length when it lies there at all. The raw output it was read
/// from keeps every row.
fn heard_rows(mut transcript: Transcript, regions: &[(u64, u64)]) -> Transcript {
    let mut sorted = regions.to_vec();
    sorted.sort_unstable();
    // Widened regions that touch are joined, so no time counts twice.
    let mut near: Vec<(u64, u64)> = Vec::with_capacity(sorted.len());
    for (start, end) in sorted {
        let start = start.saturating_sub(HEARD_SLACK_MS);
        let end = end.saturating_add(HEARD_SLACK_MS);
        match near.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => near.push((start, end)),
        }
    }
    transcript.segments.retain(|row| {
        let (start, end) = (row.start_ms, row.end_ms);
        if end <= start {
            return near.iter().any(|&(from, to)| from <= start && start <= to);
        }
        let heard: u64 = near
            .iter()
            .map(|&(from, to)| end.min(to).saturating_sub(start.max(from)))
            .sum();
        heard * 10 >= end - start
    });
    transcript
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
    to_speech_until(source, target, from_ms, length_ms, log, cancel.into())
}
/// [`to_speech`], running as `until` says.
fn to_speech_until(
    source: &Path,
    target: &Path,
    from_ms: Option<u64>,
    length_ms: Option<u64>,
    log: &Path,
    until: Until<'_>,
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
    run_until(ffmpeg, log, until)
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
    let log = scratch(folder, speech, "language.log");
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
    let window = scratch(folder, speech, "language.wav");
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
/// Runs Whisper on `speech` (16 kHz) with `model` on the processor build,
/// held to `language`; its raw output is kept as `raw`.
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
        whisper,
        root,
        speech,
        folder,
        model,
        language,
        None,
        threads,
        cancel.into(),
        raw,
    )
}
/// A final transcription of `speech` (16 kHz) as `run` says, held to
/// `language`, running as `until` says; its raw output is kept as `raw`. On
/// the processor it has `threads`; on a graphics card the Vulkan build runs
/// with `-dev <card>` and four threads ([`settings::CARD_THREADS`]), and a
/// failure there is repeated on the processor ([`on_device`]). Returns the
/// words and the model that made them. Stretches, the pass after Stop,
/// Retry, `cue transcribe` and the refining pass all come here.
#[allow(clippy::too_many_arguments)]
fn run_final(
    root: &Path,
    speech: &Path,
    folder: &Path,
    run: &deps::FinalRun,
    language: &str,
    threads: usize,
    until: Until<'_>,
    raw: &Path,
) -> Result<(Transcript, deps::ModelChoice), String> {
    let log = scratch(folder, speech, "transcription.log");
    let attempt = |card: Option<u32>, model: &deps::ModelChoice| {
        let (mut whisper, threads) = match card {
            Some(_) => (deps::card_command()?, settings::CARD_THREADS),
            None => (deps::command("whisper-cli")?, threads),
        };
        alignment_options(&mut whisper, model)?;
        let words = run_whisper_with(
            whisper, root, speech, folder, model, language, card, threads, until, raw,
        )?;
        let log = match card {
            Some(_) => fs::read_to_string(&log).unwrap_or_default(),
            None => String::new(),
        };
        Ok((words, log))
    };
    on_device(run, &attempt, &deps::stop_card)
}
/// What one run of Whisper gave: its words and its log.
type Attempt<'a> =
    &'a dyn Fn(Option<u32>, &deps::ModelChoice) -> Result<(Transcript, String), String>;
/// Runs one final transcription as `run` says, through `attempt`, which runs
/// Whisper on the graphics card it is given, or on the processor build with
/// `None`, with the model it is given. A run on the card that fails, and was
/// not cancelled, is done again on the processor build with the small model
/// of its language, and `stop` marks the card as stopped, so the runs after
/// it use the processor; a run that ends well but whose log shows the
/// processor is kept, and the card is marked the same way. Returns the
/// words and the model that made them.
fn on_device(
    run: &deps::FinalRun,
    attempt: Attempt<'_>,
    stop: &dyn Fn(&str),
) -> Result<(Transcript, deps::ModelChoice), String> {
    if let Some(card) = run.card {
        match attempt(Some(card), &run.model) {
            Ok((words, log)) => {
                if deps::card_in_use(&log) != Some(card) {
                    stop("a run on it used the processor");
                }
                return Ok((words, run.model.clone()));
            }
            Err(error) if error == CANCELLED => return Err(error),
            Err(error) => stop(error.lines().next().unwrap_or_default()),
        }
    }
    let (words, _) = attempt(None, &run.small)?;
    Ok((words, run.small.clone()))
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
        None,
        threads,
        Until::Cancelled(cancel),
        &raw,
    )
}
/// Runs `whisper`, the processor build or with `card` the Vulkan build.
#[allow(clippy::too_many_arguments)]
fn run_whisper_with(
    mut whisper: std::process::Command,
    root: &Path,
    speech: &Path,
    folder: &Path,
    model: &deps::ModelChoice,
    language: &str,
    card: Option<u32>,
    threads: usize,
    until: Until<'_>,
    raw: &Path,
) -> Result<Transcript, String> {
    let prefix = folder.join(format!("whisper-{}", uuid::Uuid::new_v4()));
    whisper
        .arg("-m")
        .arg(&model.path)
        .arg("-f")
        .arg(speech)
        .args(decoding_options_on(root, &model.path, language, card))
        .arg("-t")
        .arg(threads.to_string())
        .arg("-of")
        .arg(&prefix);
    run_until(
        whisper,
        &scratch(folder, speech, "transcription.log"),
        until,
    )?;
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
/// Whether a take folder holds both tracks, the microphone's and the system
/// audio's: such a take is transcribed from each, the others from one file.
pub(crate) fn two_tracks(folder: &Path) -> bool {
    [Track::Microphone, Track::System]
        .iter()
        .all(|track| folder.join(track.file()).exists())
}
/// The transcript of a take with two tracks from the transcript of each:
/// the rows of both in the order they were spoken ([`stretches::by_time`]),
/// the system row first where two start together, numbered anew and marked
/// with their track.
/// Each track keeps its language in `trackLanguages`; the transcript's own
/// is the microphone's, or the system's when the microphone has no words.
pub(crate) fn merge_tracks(system: Transcript, microphone: Transcript) -> Transcript {
    let language = |heard: &Transcript| Some((heard.language.clone()?, heard.language_detected));
    let track_languages = TrackLanguages::of(language(&microphone), language(&system));
    let first = track_languages
        .as_ref()
        .and_then(|languages| languages.first());
    let on = |track: Track, mut rows: Vec<Segment>| {
        for row in &mut rows {
            row.track = Some(track);
        }
        rows
    };
    let mut segments = stretches::by_time(
        on(Track::System, system.segments),
        on(Track::Microphone, microphone.segments),
    );
    for (index, segment) in segments.iter_mut().enumerate() {
        segment.id = format!("segment-{index}");
    }
    Transcript {
        segments,
        language: first.map(|first| first.language.clone()),
        language_detected: first.is_some_and(|first| first.language_detected),
        track_languages,
        status: Some("complete".into()),
        ..Default::default()
    }
}
/// The audio a take folder with one track is transcribed from, and the
/// saved stretches to reuse with it (`usable` gives them for a file name):
/// `mic.wav`; else `system.wav` when it has usable stretches, for a take
/// without a microphone was cut into stretches from its system audio; else
/// the mix `audio.wav`; else `video.mp4`.
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
    /// The microphone's speech regions silenced as echo (ms from the copy's
    /// start); they are no longer among `regions`.
    echo: Vec<(u64, u64)>,
    length_ms: u64,
}
impl LiveAudio {
    /// The speech regions of the microphone's copy that were silenced as
    /// echo of the system audio, start and end in ms from the copy's start.
    pub fn silenced(&self) -> &[(u64, u64)] {
        &self.echo
    }
}
/// Silences in the 16 kHz microphone file `speech` what the microphone
/// heard of the system audio from the loudspeakers ([`echo`]). `system` is a
/// copy of the system track over the same span, in any format; it is
/// converted to `reference` first. Returns the regions of `regions` that
/// are still speech, and those silenced.
fn silence_echo(
    speech: &Path,
    regions: &[(u64, u64)],
    system: &Path,
    reference: &Path,
    log: &Path,
    cancel: &AtomicBool,
) -> Result<echo::Gated, String> {
    if regions.is_empty() {
        return Ok(echo::Gated::default());
    }
    to_speech(system, reference, None, None, log, Some(cancel))?;
    echo::silence_echo(speech, reference, regions)
}
/// The first half of a live update, which the person sees at once: converts
/// `snapshot` (the live audio from `stretches.until_ms`, `length_ms` long),
/// finds its speech and, when `guess`, guesses its words with base, held to
/// `language`, the take's, or left to Whisper's own detection while the take
/// is not decided (`None`). Returns the guess, timed from the snapshot's
/// start (`None` when none was asked for), and the audio for
/// [`live_commit`].
///
/// For the microphone of a take with two tracks, `system` is a copy of the
/// system track over the same span: what the microphone heard of it from
/// the loudspeakers is silenced before anything is guessed or cut into
/// stretches.
#[allow(clippy::too_many_arguments)]
pub fn live_guess(
    root: &Path,
    folder: &Path,
    snapshot: &Path,
    length_ms: u64,
    language: Option<&str>,
    system: Option<&Path>,
    guess: bool,
    cancel: &AtomicBool,
) -> Result<(Option<Transcript>, Option<LiveAudio>), String> {
    // Too short to hold a word; the detector refuses an empty file.
    if length_ms < 300 {
        return Ok((guess.then(Transcript::default), None));
    }
    let speech = folder.join("speech.wav");
    let log = folder.join("transcode.log");
    to_speech(snapshot, &speech, None, None, &log, Some(cancel))?;
    let mut regions = speech_regions(&speech, folder, cancel)?;
    let mut echo = Vec::new();
    if let Some(system) = system {
        let reference = folder.join("echo-reference.wav");
        let gated = silence_echo(&speech, &regions, system, &reference, &log, cancel)?;
        (regions, echo) = (gated.speech, gated.echo);
    }
    let guess = match guess {
        false => None,
        true if regions.is_empty() => Some(Transcript::default()),
        true => Some(guess_words(
            root,
            &speech,
            folder,
            language.unwrap_or(settings::AUTO),
            cancel,
        )?),
    };
    let audio = LiveAudio {
        speech,
        regions,
        echo,
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
            let run = models.run_of(&language);
            fs::create_dir_all(stretches::folder(take)).map_err(|e| e.to_string())?;
            let raw = stretches::raw(take, stretches.track, stretches.until_ms);
            let (words, model) = run_final(
                root,
                &part,
                folder,
                &run,
                &language,
                threads,
                Until::Cancelled(cancel),
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
/// Transcribes the stretch `part` of a take again, held to `language`, as
/// `run` says, and replaces its words in `stretches`, which it saves. `audio`
/// is a copy of the take's audio from the stretch's start, and `system`, for
/// the microphone of a take with two tracks, one of the system track from
/// there, by which the echo is silenced again; scratch files go to `folder`.
#[allow(clippy::too_many_arguments)]
fn redo_stretch(
    root: &Path,
    take: &Path,
    folder: &Path,
    audio: &Path,
    system: Option<&Path>,
    part: &stretches::Part,
    language: &str,
    run: &deps::FinalRun,
    cancel: &AtomicBool,
    stretches: &mut Stretches,
) -> Result<(), String> {
    let speech = folder.join("stretch.wav");
    let length = Some(part.end_ms - part.start_ms);
    let log = folder.join("transcode.log");
    to_speech(audio, &speech, None, length, &log, Some(cancel))?;
    let mut spoken = true;
    if let Some(system) = system {
        let reference = folder.join("echo-reference.wav");
        to_speech(system, &reference, None, length, &log, Some(cancel))?;
        let regions = speech_regions(&speech, folder, cancel)?;
        spoken = !echo::silence_echo(&speech, &reference, &regions)?
            .speech
            .is_empty();
    }
    let (words, model) = if spoken {
        fs::create_dir_all(stretches::folder(take)).map_err(|e| e.to_string())?;
        let raw = stretches::raw(take, stretches.track, part.start_ms);
        let threads = live_threads(logical_threads());
        run_final(
            root,
            &speech,
            folder,
            run,
            language,
            threads,
            Until::Cancelled(cancel),
            &raw,
        )?
    } else {
        // Nothing but echo is left of it.
        (Transcript::default(), run.model.clone())
    };
    stretches.replace(part.start_ms, words, language, &file_name(&model.path));
    stretches::save(take, stretches)
}
/// Copies a take's live audio for a stretch that is transcribed again: the
/// track `own` from `from_ms` into `audio` and, for the microphone of a take
/// with two tracks, the system track from there into `system`. Returns
/// whether the system copy can be compared with the stretch
/// ([`stretches::is_reference`]): it was made and starts at the same point,
/// whatever the two devices' rates. A stretch whose own track cannot be
/// copied is an error, to be tried again.
fn redo_copies(
    own: Track,
    from_ms: u64,
    audio: &Path,
    system: Option<&Path>,
    copy: &mut dyn FnMut(Track, u64, &Path) -> stretches::Bounds,
) -> Result<bool, String> {
    let (start, _) = copy(own, from_ms, audio)?;
    Ok(system.is_some_and(|system| {
        stretches::is_reference(start, &copy(Track::System, from_ms, system))
    }))
}
/// While the take records: transcribes again, in the language the take was
/// just held to, the stretches made before that in another language
/// ([`stretches::Redo::run`]). `copy` copies a live track of the take from a
/// point (ms into the take) into a file, as a live snapshot is made, so the
/// copy starts where the stretch does and may run past its end; it returns
/// the copy's bounds in the take (ms). For the microphone of a take with two
/// tracks it is asked for the system track too, by which the echo in the
/// stretch is silenced again; when that copy cannot be made, or does not
/// start where the stretch does, nothing in the stretch counts as echo
/// ([`stretches::is_reference`]).
#[allow(clippy::too_many_arguments)]
pub fn redo_provisional(
    root: &Path,
    take: &Path,
    folder: &Path,
    models: &deps::TakeModels,
    stretches: &mut Stretches,
    redo: &mut stretches::Redo,
    cancel: &AtomicBool,
    copy: &mut dyn FnMut(Track, u64, &Path) -> stretches::Bounds,
) -> stretches::Redone {
    let audio = folder.join("redo.wav");
    let own = stretches.audio();
    let system =
        (stretches.track == Some(Track::Microphone)).then(|| folder.join("redo-system.wav"));
    // Whether the system track was copied for the stretch in hand.
    let compared = std::cell::Cell::new(false);
    redo.run(
        stretches,
        &mut |part| {
            compared.set(redo_copies(
                own,
                part.start_ms,
                &audio,
                system.as_deref(),
                copy,
            )?);
            Ok(())
        },
        &mut |part, language, stretches| {
            redo_stretch(
                root,
                take,
                folder,
                &audio,
                system.as_deref().filter(|_| compared.get()),
                part,
                language,
                &models.run_of(language),
                cancel,
                stretches,
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
                track: segment.track,
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
                track: segment.track,
            });
        }
    }
    Transcript {
        segments,
        language: update.language.or_else(|| previous.language.clone()),
        status: Some("provisional".into()),
        ..Default::default()
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
/// Transcribes one folder's media, limited to `duration_ms`. Times are
/// relative to that media. Scratch files and the raw Whisper output stay in
/// `folder`; nothing is saved to the session. `root` is the data root whose
/// settings choose the language and the decoding options.
///
/// A folder with both `mic.wav` and `system.wav` is transcribed from each,
/// the two at the same time ([`Pass::run_both`]), and the rows are merged
/// by time ([`merge_tracks`]). What the microphone heard of the system audio from
/// the loudspeakers is silenced before its speech is looked for, detected
/// or transcribed ([`echo`]). Any other folder is transcribed from one
/// file: `mic.wav`, else `audio.wav`, else `video.mp4`.
///
/// Each track is held to the language chosen in Settings. Under Auto it is
/// held to the language its saved stretches decided, with the stretches made
/// in another language transcribed again first; without stretches its
/// language is detected from its speech ([`detect_take_language`]), so every
/// take, and each track of it, is detected on its own. The transcript
/// carries the language and whether it was detected.
///
/// Every Whisper run of the pass goes where [`deps::final_run`] says: on
/// the graphics card the devices measured fastest, both tracks of a take
/// with two at once, or on the processor ([`run_final`]).
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
    // What stops the pass: the refinement's own cancel flag, or for the
    // two tracks of a take, which are transcribed at the same time, a flag
    // one sets when it fails so the other does not run on. A take with one
    // track runs as ever: to the end, or until a refinement is cancelled.
    let own = AtomicBool::new(false);
    let stop = cancel.unwrap_or(&own);
    let two = has_audio && two_tracks(folder);
    let (threads, until, converting) = match (two, cancel) {
        (false, _) => (final_threads(logical_threads()), cancel.into(), Until::Done),
        (true, Some(cancel)) => {
            let until = Until::Cancelled(cancel);
            (track_threads(logical_threads()), until, until)
        }
        (true, None) => {
            let until = Until::Stopped(stop);
            (track_threads(logical_threads()), until, until)
        }
    };
    // Detection's failures are no failures of the take: it only has to end.
    let detecting = if two { Some(stop) } else { cancel };
    let tools = Tools {
        convert: &|source, target, from_ms, length_ms| {
            let log = scratch(folder, target, "transcode.log");
            to_speech_until(source, target, from_ms, length_ms, &log, converting)
        },
        regions: &|speech| detect(speech, folder, stop, 500),
        detect: &|speech, regions| {
            detect_take_language(speech, regions, folder, threads, detecting)
        },
        model: &|language| {
            installed(deps::final_run(language).model).map(|model| file_name(&model.path))
        },
        whisper: &|speech, language, raw| {
            // Chosen for each run: a card that stopped during the pass is
            // not used again.
            let run = deps::final_run(language);
            installed(run.model.clone())?;
            run_final(root, speech, folder, &run, language, threads, until, raw)
                .map(|(words, _)| words)
        },
        echo: &|microphone, system| {
            // Padded by only 100 ms, as the regions the rule was measured on.
            let regions = detect(microphone, folder, stop, 100)?;
            echo::silence_echo(microphone, system, &regions).map(|_| ())
        },
        stop,
    };
    transcribe_media_in(root, folder, duration_ms, has_audio, reuse, &tools)
}
type Converter<'a> =
    &'a (dyn Fn(&Path, &Path, Option<u64>, Option<u64>) -> Result<(), String> + Sync);
type SpeechFinder<'a> = &'a (dyn Fn(&Path) -> Result<Vec<(u64, u64)>, String> + Sync);
type Detector<'a> = &'a (dyn Fn(&Path, &[(u64, u64)]) -> Option<String> + Sync);
/// The work a whole-take pass leaves to FFmpeg, the speech detector and
/// Whisper. Tests pass fakes, so the pass itself runs without them. The two
/// tracks of a take are transcribed at the same time, so every tool is
/// called from two threads at once.
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
    pub model: &'a (dyn Fn(&str) -> Result<String, String> + Sync),
    /// Transcribes a 16 kHz file held to a language, keeping the raw output
    /// at the given path.
    pub whisper: &'a (dyn Fn(&Path, &str, &Path) -> Result<Transcript, String> + Sync),
    /// Silences in a 16 kHz microphone file what it heard of the system
    /// audio, a 16 kHz file of the same span, from the loudspeakers
    /// ([`echo::silence_echo`]).
    pub echo: &'a (dyn Fn(&Path, &Path) -> Result<(), String> + Sync),
    /// Stops the work under way once it is set: every tool then ends with
    /// an error as soon as it can. The pass of a take with two tracks sets
    /// it when one track fails, so the other does not run on.
    pub stop: &'a AtomicBool,
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
    let pass = Pass {
        settings: &settings,
        folder,
        duration_ms,
        reuse,
        tools,
    };
    if two_tracks(folder) {
        return pass.run_both();
    }
    pass.run(None)
}
/// Sets a flag when it is dropped by a panic, so a pass on another thread
/// does not run on.
struct StopOnPanic<'a>(&'a AtomicBool);
impl Drop for StopOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.store(true, Ordering::Release);
        }
    }
}
/// Whether `speech` is an audio file without a single sample.
fn holds_no_audio(speech: &Path) -> bool {
    hound::WavReader::open(speech).is_ok_and(|reader| reader.duration() == 0)
}
/// One whole-take pass over a take folder: what [`transcribe_media_in`] is
/// given, for each track it transcribes.
struct Pass<'a> {
    settings: &'a crate::models::Settings,
    folder: &'a Path,
    duration_ms: u64,
    reuse: bool,
    tools: &'a Tools<'a>,
}
impl Pass<'_> {
    /// Transcribes both tracks of a take with two, at the same time, and
    /// merges their rows. Neither pass needs anything of the other: the
    /// microphone's echo is recognised by the system track's audio, which it
    /// converts for itself, and every scratch and output file carries its
    /// track ([`scratch`]). The result is that of one pass after the other.
    ///
    /// When a track fails, the take fails with its error, as it would one
    /// after the other, and the other track is stopped; when both fail, the
    /// system track's error is the take's, unless it was only stopped.
    fn run_both(&self) -> Result<Transcript, String> {
        let stop = self.tools.stop;
        let run = |track: Track| {
            let _stop = StopOnPanic(stop);
            let result = self.run(Some(track));
            if result.is_err() {
                stop.store(true, Ordering::Release);
            }
            result
        };
        let (system, microphone) = std::thread::scope(|scope| {
            let system = scope.spawn(|| run(Track::System));
            let microphone = run(Track::Microphone);
            let system = system
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic));
            (system, microphone)
        });
        match (system, microphone) {
            (Ok(system), Ok(microphone)) => Ok(merge_tracks(system, microphone)),
            (Ok(_), Err(error)) => Err(error),
            (Err(stopped), Err(error)) if stopped == CANCELLED && error != CANCELLED => Err(error),
            (Err(error), _) => Err(error),
        }
    }
    /// Transcribes `track` of a take with two tracks, or with `None` the
    /// one file a take with one track is transcribed from.
    fn run(&self, track: Option<Track>) -> Result<Transcript, String> {
        let Self {
            settings,
            folder,
            duration_ms,
            reuse,
            tools,
        } = *self;
        // A track of two ends here once the other has failed or the pass is
        // cancelled; its tools end by themselves too.
        let going = || match track {
            Some(_) if tools.stop.load(Ordering::Acquire) => Err(CANCELLED.to_string()),
            _ => Ok(()),
        };
        going()?;
        let chosen = settings::chosen_language(settings);
        let model_file = |language: &str| (tools.model)(language).unwrap_or_default();
        let usable = |name: &str| stretches::usable(folder, track, name, chosen, &model_file);
        let (source, mut saved) = match track {
            Some(track) => {
                let saved = reuse.then(|| usable(track.file())).flatten();
                if reuse && saved.is_none() {
                    stretches::forget_track(folder, Some(track));
                }
                (folder.join(track.file()), saved)
            }
            None if reuse => reused_source(folder, usable),
            None => media_source(folder, |_| None),
        };
        // The system track's scratch files and raw output carry its name;
        // the microphone's, as a single file's, do not.
        let named = |name: &str| match track {
            Some(Track::System) => folder.join(format!("system-{name}")),
            _ => folder.join(name),
        };
        // `length_ms` of the track from `from_ms` as 16 kHz speech in
        // `speech`, the microphone's without what it heard of the system
        // audio.
        let convert = |speech: &Path, from_ms: u64, length_ms: u64| -> Result<(), String> {
            going()?;
            let from = (from_ms > 0).then_some(from_ms);
            (tools.convert)(&source, speech, from, Some(length_ms))?;
            if track == Some(Track::Microphone) && !holds_no_audio(speech) {
                let reference = folder.join("echo-reference.wav");
                let system = folder.join(Track::System.file());
                (tools.convert)(&system, &reference, from, Some(length_ms))?;
                (tools.echo)(speech, &reference)?;
            }
            Ok(())
        };
        let mut held = held_language(settings, folder, track, saved.as_ref(), !reuse);
        if let (Some(saved), Some((language, _))) = (saved.as_mut(), held) {
            // Stretches made before the take's language was decided, in another one.
            for part in saved.to_redo() {
                let speech = named("stretch.wav");
                convert(&speech, part.start_ms, part.end_ms - part.start_ms)?;
                fs::create_dir_all(stretches::folder(folder)).map_err(|e| e.to_string())?;
                let raw = stretches::raw(folder, track, part.start_ms);
                going()?;
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
            let speech = named("speech.wav");
            convert(&speech, from_ms, rest_ms)?;
            // A track of two that holds no audio there, as one that never
            // got a sample and was not finished, has no speech; the
            // detector refuses an empty file.
            let regions = if track.is_some() && holds_no_audio(&speech) {
                Vec::new()
            } else {
                (tools.regions)(&speech)?
            };
            if regions.is_empty() {
                empty_transcript()
            } else {
                let (language, _) = *held.get_or_insert_with(|| {
                    // Auto, and nothing decided the take yet: hear its speech.
                    let heard = (tools.detect)(&speech, &regions);
                    let language = settings::held_language(settings, heard.as_deref())
                        .unwrap_or(stretches::FALLBACK_LANGUAGE);
                    (language, true)
                });
                let raw = match track {
                    Some(Track::System) => folder.join("whisper-system.json"),
                    _ => folder.join("whisper.json"),
                };
                going()?;
                heard_rows((tools.whisper)(&speech, language, &raw)?, &regions)
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
}
/// The language that holds a take, or its `track` when it has two, before a
/// whole-take pass hears its audio, and whether it was detected. `None`:
/// Auto, and the pass detects it.
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
    track: Option<Track>,
    saved: Option<&Stretches>,
    refining: bool,
) -> Option<(&'static str, bool)> {
    let kept = match saved {
        Some(saved) => saved
            .language
            .clone()
            .map(|language| (language, saved.language_detected)),
        None if refining => stretches::language(folder, track),
        None => None,
    };
    kept.and_then(|(language, detected)| Some((settings::known_language(&language)?, detected)))
        .or_else(|| settings::chosen_language(settings).map(|language| (language, false)))
}
/// A whole-take pass whose outside work is faked, for tests here and of the
/// callers: speech in the first second unless `silent`, a detector that
/// hears `heard` (`heard_on_system` in the system track of a take with two)
/// and counts how often it is asked, and a Whisper that returns one word
/// naming the language it was held to.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakePass {
    pub heard: Option<&'static str>,
    pub heard_on_system: Option<&'static str>,
    pub silent: bool,
    /// Whisper also makes up "Vielen Dank." over the silence from 20 s to
    /// 50 s, and keeps both rows in its raw output, as the real one does.
    pub made_up: bool,
    pub detections: Count,
    /// The language of each Whisper run, in order. (The two tracks of a
    /// take run at the same time: see [`FakePass::languages_of`].)
    pub languages: Noted<Vec<String>>,
    /// From where and for how long each conversion read the take's audio.
    pub converted: Noted<Vec<(Option<u64>, Option<u64>)>>,
    /// The work in order: `convert <source file>`, `echo` for each time the
    /// microphone's echo is silenced, `whisper <raw output file> <language>`.
    pub work: Noted<Vec<String>>,
    /// The same work with the track whose pass did it: the system track's
    /// files are named for it, every other file is the microphone's or the
    /// one track's.
    pub tracked: Noted<Vec<(Track, String)>>,
    pub stop: AtomicBool,
}
/// What a fake tool noted, from whichever thread called it.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Noted<T>(std::sync::Mutex<T>);
#[cfg(test)]
impl<T> Noted<T> {
    pub fn borrow(&self) -> std::sync::MutexGuard<'_, T> {
        self.0.lock().unwrap()
    }
    pub fn borrow_mut(&self) -> std::sync::MutexGuard<'_, T> {
        self.0.lock().unwrap()
    }
    pub fn take(&self) -> T
    where
        T: Default,
    {
        std::mem::take(&mut *self.borrow_mut())
    }
}
/// How often a fake tool was called, from whichever thread.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Count(std::sync::atomic::AtomicUsize);
#[cfg(test)]
impl Count {
    pub fn get(&self) -> usize {
        self.0.load(Ordering::Acquire)
    }
    pub fn add(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }
}
#[cfg(test)]
impl FakePass {
    pub fn hearing(heard: &'static str) -> Self {
        Self {
            heard: Some(heard),
            ..Default::default()
        }
    }
    /// The work the pass of `track` did, in its order.
    pub fn work_of(&self, track: Track) -> Vec<String> {
        let tracked = self.tracked.borrow();
        let of = tracked.iter().filter(|(by, _)| *by == track);
        of.map(|(_, step)| step.clone()).collect()
    }
    /// The language of each Whisper run of the pass of `track`.
    pub fn languages_of(&self, track: Track) -> Vec<String> {
        self.work_of(track)
            .iter()
            .filter(|step| step.starts_with("whisper "))
            .filter_map(|step| step.rsplit(' ').next().map(str::to_owned))
            .collect()
    }
    fn note(&self, file: &Path, step: String) {
        // The system track's speech and raw output carry its name.
        let name = file_name(file);
        let track = if name.starts_with("system-") || name == "whisper-system.json" {
            Track::System
        } else {
            Track::Microphone
        };
        self.work.borrow_mut().push(step.clone());
        self.tracked.borrow_mut().push((track, step));
    }
    pub fn run(
        &self,
        root: &Path,
        folder: &Path,
        duration_ms: u64,
        reuse: bool,
    ) -> Result<Transcript, String> {
        let tools = Tools {
            convert: &|source, target, from_ms, length_ms| {
                self.converted.borrow_mut().push((from_ms, length_ms));
                self.note(target, format!("convert {}", file_name(source)));
                Ok(())
            },
            regions: &|_| Ok(if self.silent { vec![] } else { vec![(0, 1000)] }),
            detect: &|speech, _| {
                self.detections.add();
                let system = file_name(speech).starts_with("system-");
                let heard = self.heard_on_system.filter(|_| system).or(self.heard);
                heard.map(str::to_owned)
            },
            model: &|language| {
                Ok(if language == "en" {
                    "ggml-small.en.bin"
                } else {
                    "ggml-small.bin"
                }
                .into())
            },
            echo: &|microphone, _| {
                self.note(microphone, "echo".into());
                Ok(())
            },
            stop: &self.stop,
            whisper: &|_, language, raw| {
                self.languages.borrow_mut().push(language.into());
                self.note(raw, format!("whisper {} {language}", file_name(raw)));
                let row = |index: usize, text: String, start_ms: u64, end_ms: u64| Segment {
                    id: format!("segment-{index}"),
                    start_ms,
                    end_ms,
                    text: text.clone(),
                    words: vec![Word {
                        text,
                        start_ms,
                        end_ms,
                        seek_ms: Some(start_ms + 50),
                    }],
                    track: None,
                };
                let mut segments = vec![row(0, format!("{language}-words"), 100, 400)];
                if self.made_up {
                    segments.push(row(1, "Vielen Dank.".into(), 20_000, 50_000));
                    let rows = segments.iter().map(|row| row.text.as_str());
                    let raw_rows: Vec<_> = rows
                        .map(|text| serde_json::json!({ "text": text }))
                        .collect();
                    let bytes =
                        serde_json::to_vec(&serde_json::json!({ "transcription": raw_rows }));
                    fs::write(raw, bytes.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                }
                Ok(Transcript {
                    segments,
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
    let saved = stretches::any_saved;
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
        // The two tracks of a take are transcribed at the same time: each
        // keeps the final count where both fit the processor, from 8
        // logical threads on, and has half the processor below that.
        for (logical, each) in [
            (32, 8),
            (16, 8),
            (12, 6),
            (8, 4),
            (6, 3),
            (4, 2),
            (2, 1),
            (1, 1),
        ] {
            assert_eq!(track_threads(logical), each, "{logical} logical threads");
            assert!(each * 2 <= logical.max(2));
            assert!(logical < 8 || each == final_threads(logical));
        }
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
    /// A transcript of one row for each `(text, start, end)`.
    fn rows_at(rows: &[(&str, u64, u64)]) -> Transcript {
        let row = |(index, &(text, start_ms, end_ms)): (usize, &(&str, u64, u64))| Segment {
            id: format!("segment-{index}"),
            start_ms,
            end_ms,
            text: text.into(),
            words: vec![Word {
                text: text.into(),
                start_ms,
                end_ms,
                seek_ms: None,
            }],
            track: None,
        };
        Transcript {
            segments: rows.iter().enumerate().map(row).collect(),
            language: Some("de".into()),
            status: Some("complete".into()),
            ..Default::default()
        }
    }
    fn texts(transcript: &Transcript) -> Vec<&str> {
        let rows = transcript.segments.iter();
        rows.map(|row| row.text.as_str()).collect()
    }
    #[test]
    fn a_row_is_kept_by_its_share_of_detected_speech() {
        // Speech from 10 s to 20 s: within a second of it is 9 s to 21 s.
        let speech = [(10_000, 20_000)];
        let transcript = heard_rows(
            rows_at(&[
                ("said", 12_000, 15_000),
                // A short reply just after the speech the detector found.
                ("Ja.", 20_500, 20_900),
                // Made up over silence.
                ("Vielen Dank.", 40_000, 70_000),
                // 1 s of its 10 s near speech, a tenth: kept.
                ("a tenth", 20_000, 30_000),
                // 0.9 s of its 10 s: left out.
                ("less", 20_100, 30_100),
                // Rows of no length: kept within a second of speech.
                ("at its edge", 21_000, 21_000),
                ("past it", 21_001, 21_001),
            ]),
            &speech,
        );
        assert_eq!(
            texts(&transcript),
            ["said", "Ja.", "a tenth", "at its edge"]
        );
        assert_eq!(transcript.language.as_deref(), Some("de"));
        assert_eq!(transcript.segments[1].id, "segment-1");
        // Widened regions that overlap count once: 9 s to 11.6 s is 2.6 s,
        // short of a tenth of 31 s, though each region's second adds 2.1 s.
        let close = [(10_000, 10_100), (10_500, 10_600)];
        let long = rows_at(&[("long", 9_000, 40_000), ("tenth", 9_000, 35_000)]);
        assert_eq!(texts(&heard_rows(long, &close)), ["tenth"]);
        // Regions in any order; near the start of the audio.
        let unordered = [(50_000, 60_000), (0, 300)];
        let rows = rows_at(&[("first", 0, 900), ("later", 52_000, 55_000)]);
        assert_eq!(texts(&heard_rows(rows, &unordered)), ["first", "later"]);
        // No speech found keeps no row.
        assert!(heard_rows(rows_at(&[("said", 0, 500)]), &[])
            .segments
            .is_empty());
    }
    #[test]
    fn rows_over_silence_are_left_out_of_a_take() {
        let (root, folder) = take_folder();
        // Stop without stretches, then Retry and `cue transcribe`.
        for reuse in [true, false] {
            let pass = FakePass {
                made_up: true,
                ..FakePass::hearing("de")
            };
            let transcript = pass.run(root.path(), &folder, 60_000, reuse).unwrap();
            assert_eq!(texts(&transcript), ["de-words"], "reuse {reuse}");
        }
    }
    #[test]
    fn rows_over_silence_are_left_out_of_both_tracks() {
        let (root, folder) = two_track_folder();
        let pass = FakePass {
            made_up: true,
            ..FakePass::hearing("de")
        };
        let transcript = pass.run(root.path(), &folder, 60_000, false).unwrap();
        assert_eq!(
            rows(&transcript),
            [(SYSTEM, "de-words", 100), (MICROPHONE, "de-words", 100)]
        );
    }
    #[test]
    fn the_raw_output_keeps_the_rows_left_out() {
        let (root, folder) = two_track_folder();
        let pass = FakePass {
            made_up: true,
            ..FakePass::hearing("de")
        };
        let transcript = pass.run(root.path(), &folder, 60_000, false).unwrap();
        assert!(!texts(&transcript).contains(&"Vielen Dank."));
        for raw in ["whisper.json", "whisper-system.json"] {
            let raw: Value = serde_json::from_slice(&fs::read(folder.join(raw)).unwrap()).unwrap();
            let rows = raw["transcription"].as_array().unwrap().iter();
            let rows: Vec<_> = rows.map(|row| row["text"].as_str().unwrap()).collect();
            assert_eq!(rows, ["de-words", "Vielen Dank."]);
        }
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
                track: None,
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

        // A take with only a microphone, or only system audio, is
        // transcribed from that one file, and its rows carry no track.
        let root = tempfile::tempdir().unwrap();
        for (name, track, source) in [
            ("microphone", "mic.wav", "mic.wav"),
            ("system", "system.wav", "audio.wav"),
        ] {
            let take = root.path().join(name);
            fs::create_dir_all(&take).unwrap();
            fs::write(take.join(track), b"").unwrap();
            fs::write(take.join("audio.wav"), b"").unwrap();
            assert!(!two_tracks(&take));
            let pass = FakePass::hearing("de");
            let transcript = pass.run(root.path(), &take, 5000, true).unwrap();
            assert_eq!(
                *pass.work.borrow(),
                [
                    format!("convert {source}"),
                    "whisper whisper.json de".into()
                ],
                "one pass over one file, with nothing compared"
            );
            assert_eq!(transcript.segments.len(), 1);
            assert_eq!(transcript.segments[0].track, None);
            assert_eq!(transcript.track_languages, None);
            let saved = serde_json::to_value(&transcript).unwrap();
            assert!(saved.get("trackLanguages").is_none());
            assert!(saved["segments"][0].get("track").is_none());
            assert_eq!(in_language(&transcript), (Some("de"), true));
        }
        fs::write(root.path().join("microphone/system.wav"), b"").unwrap();
        assert!(two_tracks(&root.path().join("microphone")));
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
        assert!(stretches::language(&take_two, None).is_none());
        assert!(!refine_with(&store, &id, &whole).unwrap());
        assert_eq!(folders.borrow().len(), 1);
    }
    /// What a take's own transcript looks like: one segment 100 ms in.
    fn spoken(text: &str) -> Transcript {
        let mut transcript = sample_transcript(&[(text, 100, 900)]);
        transcript.segments[0].id = "segment-0".into();
        transcript
    }
    #[test]
    fn a_failed_graphics_card_run_is_repeated_on_the_processor() {
        use crate::models::DeviceKind;
        use deps::{CardTime, Facts, FinalRun, LargeTime, Measured, ModelChoice};
        let root = tempfile::tempdir().unwrap();
        // A computer that transcribes on its graphics card, here with the
        // larger model.
        let measured = Measured {
            computer: Default::default(),
            sample: deps::SAMPLE.into(),
            model: "small".into(),
            processor_ms: 2_700,
            cards: vec![CardTime {
                index: 0,
                name: "NVIDIA GeForce RTX 5090".into(),
                ms: Some(1_300),
            }],
            chosen: Some(0),
            stopped: false,
            large: Some(LargeTime::Ms(2_000)),
        };
        let saved = root.path().join("speech-device.json");
        let reset = || crate::store::write_json(&saved, &measured).unwrap();
        let stopped = || deps::load_measured(root.path()).unwrap().stopped;
        let facts = || Facts {
            card_build: true,
            saved: deps::load_measured(root.path()),
            current: true,
            measuring: false,
            switch_on: true,
            large_chosen: true,
            large_installed: true,
        };
        let model = |file: &str| ModelChoice {
            path: Path::new("models").join(file),
            dtw: None,
        };
        let (small, large) = (model("ggml-small.bin"), model("ggml-large-v3-turbo.bin"));
        let run_now = || {
            let facts = facts();
            FinalRun::on(
                facts.card(),
                facts.large().then(|| large.clone()),
                small.clone(),
            )
        };
        let stop = |why: &str| deps::stop_card_in(root.path(), why);
        let tried = Noted::<Vec<(Option<u32>, String)>>::default();
        let note = |card: Option<u32>, model: &ModelChoice| {
            tried.borrow_mut().push((card, file_name(&model.path)));
        };
        let on = |card: Option<u32>, file: &str| (card, file.to_owned());
        reset();
        let run = run_now();
        assert_eq!((run.card, &run.model), (Some(0), &large));

        // The run on the card crashes, or exits with an error.
        for error in [
            "Processing failed (exit code: 0xc0000005): ggml_vulkan: Device lost",
            "Processing failed (exit code: 1): ggml_vulkan: vk::Device::allocateMemory: ErrorOutOfDeviceMemory",
        ] {
            reset();
            let failing = |card: Option<u32>, model: &ModelChoice| {
                note(card, model);
                match card {
                    Some(_) => Err(error.to_owned()),
                    None => Ok((spoken("ask not what your country"), String::new())),
                }
            };
            let (words, made_by) = on_device(&run_now(), &failing, &stop).unwrap();
            // The same audio is transcribed on the processor with the small
            // model, and the take gets its transcript.
            assert_eq!(
                tried.take(),
                [
                    on(Some(0), "ggml-large-v3-turbo.bin"),
                    on(None, "ggml-small.bin")
                ]
            );
            assert_eq!(made_by, small);
            assert_eq!(words.segments[0].text, "ask not what your country");
            // The transcriptions after it run on the processor.
            assert!(stopped());
            assert_eq!(run_now(), FinalRun::processor(small.clone()));
            let device = facts().device();
            assert_eq!(device.kind, DeviceKind::Processor);
            assert_eq!(device.card.map(|card| card.stopped), Some(true));
            on_device(&run_now(), &failing, &stop).unwrap();
            assert_eq!(tried.take(), [on(None, "ggml-small.bin")]);
        }

        // A run that ends well but whose log shows the processor is kept,
        // and the card is marked as stopped all the same.
        reset();
        let fell_back = |card: Option<u32>, model: &ModelChoice| {
            note(card, model);
            Ok((
                spoken("kept"),
                "whisper_backend_init_gpu: no GPU found\n".to_owned(),
            ))
        };
        let (words, made_by) = on_device(&run_now(), &fell_back, &stop).unwrap();
        assert_eq!(tried.take(), [on(Some(0), "ggml-large-v3-turbo.bin")]);
        assert_eq!(
            (words.segments[0].text.as_str(), made_by),
            ("kept", large.clone())
        );
        assert!(stopped());

        // A run whose log shows the card is kept, and the card goes on.
        reset();
        let on_card = |card: Option<u32>, model: &ModelChoice| {
            note(card, model);
            Ok((
                spoken("on the card"),
                "whisper_backend_init_gpu: using Vulkan0 backend\n".to_owned(),
            ))
        };
        on_device(&run_now(), &on_card, &stop).unwrap();
        assert_eq!(tried.take(), [on(Some(0), "ggml-large-v3-turbo.bin")]);
        assert!(!stopped());
        assert_eq!(run_now().card, Some(0));

        // A cancelled run is no failure: nothing is repeated, and the card
        // goes on.
        let cancelled = |card: Option<u32>, model: &ModelChoice| {
            note(card, model);
            Err(CANCELLED.to_owned())
        };
        assert_eq!(
            on_device(&run_now(), &cancelled, &stop).unwrap_err(),
            CANCELLED
        );
        assert_eq!(tried.take(), [on(Some(0), "ggml-large-v3-turbo.bin")]);
        assert!(!stopped());

        // On the processor a failure stays one: there is nothing to repeat it
        // on, and the card is not to blame.
        let failing = |card: Option<u32>, model: &ModelChoice| {
            note(card, model);
            Err("Processing failed (exit code: 1)".to_owned())
        };
        let processor = FinalRun::processor(small.clone());
        assert!(on_device(&processor, &failing, &stop).is_err());
        assert_eq!(tried.take(), [on(None, "ggml-small.bin")]);
        assert!(!stopped());
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
            track_languages: None,
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
        assert_eq!(held_language(&auto, &folder, None, None, false), None);
        // A language chosen in Settings holds it without detecting.
        assert_eq!(
            held_language(&german, &folder, None, None, false),
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
            held_language(&auto, &folder, None, Some(&decided), false),
            Some(("fr", true))
        );
        // The refining pass reads the same decision from the file Stop
        // left, and keeps it whatever Settings say by then.
        stretches::save(&folder, &decided).unwrap();
        assert_eq!(
            held_language(&auto, &folder, None, None, true),
            Some(("fr", true))
        );
        assert_eq!(
            held_language(&german, &folder, None, None, true),
            Some(("fr", true))
        );
        // Any other pass follows Settings, and Retry and `cue transcribe`
        // forget the stretches: under Auto they detect again.
        assert_eq!(
            held_language(&german, &folder, None, None, false),
            Some(("de", false))
        );
        stretches::forget(&folder);
        assert_eq!(held_language(&auto, &folder, None, None, true), None);
        assert_eq!(held_language(&auto, &folder, None, None, false), None);
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
        assert_eq!(
            stretches::language(&folder, None),
            Some(("de".into(), true))
        );

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
        assert_eq!(stretches::language(&folder, None), None);
        let stop = FakePass::hearing("ja");
        let transcript = stop.run(root.path(), &folder, 40_000, true).unwrap();
        assert_eq!(*stop.languages.borrow(), ["de"]);
        assert_eq!(in_language(&transcript), (Some("de"), true));
        assert_eq!(
            stretches::language(&folder, None),
            Some(("de".into(), true))
        );
    }

    /// A data root and in it a take folder with both tracks.
    fn two_track_folder() -> (tempfile::TempDir, std::path::PathBuf) {
        let (root, folder) = take_folder();
        fs::write(folder.join("system.wav"), b"").unwrap();
        (root, folder)
    }
    /// Each row's track, text and start.
    fn rows(transcript: &Transcript) -> Vec<(Option<Track>, &str, u64)> {
        transcript
            .segments
            .iter()
            .map(|row| (row.track, row.text.as_str(), row.start_ms))
            .collect()
    }
    const MICROPHONE: Option<Track> = Some(Track::Microphone);
    const SYSTEM: Option<Track> = Some(Track::System);

    #[test]
    fn rows_of_two_tracks_are_merged_by_time() {
        // The call asks, the reviewer answers, and both start at 9 s.
        let mut system = heard_in(sample_transcript(&[("frage", 1_000, 1_800)]), "de", true);
        system
            .segments
            .extend(sample_transcript(&[("danke", 9_000, 9_500)]).segments);
        system
            .segments
            .extend(sample_transcript(&[("ende", 20_000, 20_400)]).segments);
        let mut microphone = heard_in(sample_transcript(&[("answer", 4_000, 5_000)]), "en", true);
        microphone
            .segments
            .extend(sample_transcript(&[("thanks", 9_000, 9_400)]).segments);
        let merged = merge_tracks(system.clone(), microphone.clone());
        // In the order they were spoken, the system row first on a tie.
        assert_eq!(
            rows(&merged),
            [
                (SYSTEM, "frage", 1_000),
                (MICROPHONE, "answer", 4_000),
                (SYSTEM, "danke", 9_000),
                (MICROPHONE, "thanks", 9_000),
                (SYSTEM, "ende", 20_000),
            ]
        );
        let ids: Vec<_> = merged.segments.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "segment-0",
                "segment-1",
                "segment-2",
                "segment-3",
                "segment-4"
            ]
        );
        assert_eq!(merged.status.as_deref(), Some("complete"));
        // The words keep their times.
        assert_eq!(merged.segments[1].words[0].start_ms, 4_000);
        // Whisper starts a row where the one before it ended: the
        // reviewer's first words after 16 s of the call's echo, silenced,
        // start "at 0". Where they were spoken is their alignment point,
        // and that is what orders them.
        let mut late = sample_transcript(&[("finally", 0, 17_500)]);
        late.segments[0].words[0].seek_ms = Some(16_700);
        let ordered = merge_tracks(system.clone(), late);
        let texts: Vec<_> = ordered
            .segments
            .iter()
            .map(|row| row.text.as_str())
            .collect();
        assert_eq!(texts, ["frage", "danke", "finally", "ende"]);
        assert_eq!(ordered.segments[2].start_ms, 0, "its own times stay");
        // Each track keeps its language; the transcript's own is the
        // microphone's.
        assert_eq!(in_language(&merged), (Some("en"), true));
        let saved = serde_json::to_value(&merged).unwrap();
        assert_eq!(
            saved["trackLanguages"],
            json!({"microphone":{"language":"en","languageDetected":true},
                "system":{"language":"de","languageDetected":true}})
        );
        assert_eq!(saved["segments"][0]["track"], json!("system"));
        assert_eq!(saved["segments"][1]["track"], json!("microphone"));
        // What is saved reads back as it was.
        let read: Transcript = serde_json::from_value(saved).unwrap();
        assert_eq!(rows(&read), rows(&merged));
        assert_eq!(read.track_languages, merged.track_languages);

        // A microphone without words: the transcript's language is the
        // system track's, chosen in Settings here.
        let chosen = heard_in(system.clone(), "de", false);
        let only_system = merge_tracks(chosen, empty_transcript());
        assert_eq!(in_language(&only_system), (Some("de"), false));
        assert_eq!(
            serde_json::to_value(&only_system).unwrap()["trackLanguages"],
            json!({"system":{"language":"de"}})
        );
        assert!(only_system.segments.iter().all(|row| row.track == SYSTEM));
        // A system track without words.
        let only_microphone = merge_tracks(empty_transcript(), microphone);
        assert_eq!(in_language(&only_microphone), (Some("en"), true));
        assert_eq!(
            only_microphone.track_languages.unwrap().system,
            None,
            "a track without words has no language"
        );
        // Neither track has words: an empty transcript without languages.
        let silent = merge_tracks(empty_transcript(), empty_transcript());
        assert!(silent.segments.is_empty() && silent.track_languages.is_none());
        assert_eq!(in_language(&silent), (None, false));
    }

    #[test]
    fn a_take_with_two_tracks_is_transcribed_from_both() {
        let (root, folder) = two_track_folder();
        assert!(two_tracks(&folder));
        // Stop without stretches, Retry, `cue transcribe`: the system track
        // and, at the same time, the microphone, compared with the system
        // audio of the same span before its speech is looked for.
        let pass = FakePass::hearing("en");
        let transcript = pass.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(
            pass.work_of(Track::System),
            ["convert system.wav", "whisper whisper-system.json en"]
        );
        assert_eq!(
            pass.work_of(Track::Microphone),
            [
                "convert mic.wav",
                "convert system.wav",
                "echo",
                "whisper whisper.json en",
            ]
        );
        assert_eq!(pass.work.borrow().len(), 6);
        assert_eq!(*pass.converted.borrow(), [(None, Some(5000)); 3]);
        assert_eq!(
            rows(&transcript),
            [(SYSTEM, "en-words", 100), (MICROPHONE, "en-words", 100)]
        );
        assert_eq!(pass.detections.get(), 2, "each track is heard for itself");
        assert_eq!(in_language(&transcript), (Some("en"), true));

        // Stop after a recording: each track's stretches are reused, and
        // only the audio after them is transcribed.
        let mut system = Stretches::of_track(Track::System, Some("en"));
        system.push(spoken("call"), 10_000, "en", "ggml-small.en.bin", None);
        stretches::save(&folder, &system).unwrap();
        let mut microphone = Stretches::of_track(Track::Microphone, Some("en"));
        microphone.push(spoken("reviewer"), 12_000, "en", "ggml-small.en.bin", None);
        stretches::save(&folder, &microphone).unwrap();
        settings::save(root.path(), &chosen("en")).unwrap();
        let stop = FakePass::default();
        let transcript = stop.run(root.path(), &folder, 20_000, true).unwrap();
        let mut converted = stop.converted.take();
        converted.sort();
        assert_eq!(
            converted,
            [
                (Some(10_000), Some(10_000)),
                (Some(12_000), Some(8_000)),
                (Some(12_000), Some(8_000)),
            ]
        );
        assert_eq!(
            rows(&transcript),
            [
                (SYSTEM, "call", 100),
                (MICROPHONE, "reviewer", 100),
                (SYSTEM, "en-words", 10_100),
                (MICROPHONE, "en-words", 12_100),
            ]
        );
        assert_eq!(in_language(&transcript), (Some("en"), false));
        assert!(stretches::any_saved(&folder), "kept for the refining pass");
        // The refining pass transcribes both tracks whole.
        let refine = FakePass::default();
        let whole = refine.run(root.path(), &folder, 20_000, false).unwrap();
        assert_eq!(*refine.converted.borrow(), [(None, Some(20_000)); 3]);
        assert_eq!(
            rows(&whole),
            [(SYSTEM, "en-words", 100), (MICROPHONE, "en-words", 100)]
        );
        // One track's stretches that cannot be used are forgotten, the
        // other's are still reused.
        let mut german = Stretches::of_track(Track::System, Some("de"));
        german.push(spoken("anruf"), 10_000, "de", "ggml-small.bin", None);
        stretches::save(&folder, &german).unwrap();
        let stop = FakePass::default();
        let transcript = stop.run(root.path(), &folder, 20_000, true).unwrap();
        // (The stretch's word is shown at its start, the pass's word at its
        // alignment point 50 ms in.)
        assert_eq!(
            rows(&transcript),
            [
                (MICROPHONE, "reviewer", 100),
                (SYSTEM, "en-words", 100),
                (MICROPHONE, "en-words", 12_100),
            ]
        );
        assert!(stretches::language(&folder, SYSTEM).is_none());
        assert!(stretches::language(&folder, MICROPHONE).is_some());
    }

    #[test]
    fn each_track_is_detected_on_its_own() {
        let (root, folder) = two_track_folder();
        // Auto, a German call and an English reviewer.
        let call = || FakePass {
            heard: Some("en"),
            heard_on_system: Some("de"),
            ..Default::default()
        };
        let pass = call();
        let transcript = pass.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(pass.detections.get(), 2);
        assert_eq!(pass.languages_of(Track::System), ["de"]);
        assert_eq!(pass.languages_of(Track::Microphone), ["en"]);
        assert_eq!(
            rows(&transcript),
            [(SYSTEM, "de-words", 100), (MICROPHONE, "en-words", 100)]
        );
        assert_eq!(
            serde_json::to_value(&transcript).unwrap()["trackLanguages"],
            json!({"microphone":{"language":"en","languageDetected":true},
                "system":{"language":"de","languageDetected":true}})
        );
        assert_eq!(in_language(&transcript), (Some("en"), true));

        // While it recorded, each track's stretches decided for themselves;
        // the system track's first stretch was taken for English before.
        let mut system = Stretches::of_track(Track::System, None);
        system.push(
            spoken("nonsense"),
            8_000,
            "en",
            "ggml-small.en.bin",
            Some(guessed("en", 0.5)),
        );
        system.push(
            spoken("zwei"),
            16_000,
            "de",
            "ggml-small.bin",
            Some(guessed("de", 0.97)),
        );
        stretches::save(&folder, &system).unwrap();
        let mut microphone = Stretches::of_track(Track::Microphone, None);
        microphone.push(
            spoken("one"),
            12_000,
            "en",
            "ggml-small.en.bin",
            Some(guessed("en", 0.95)),
        );
        stretches::save(&folder, &microphone).unwrap();
        assert_eq!(
            stretches::language(&folder, SYSTEM),
            Some(("de".into(), true))
        );
        assert_eq!(
            stretches::language(&folder, MICROPHONE),
            Some(("en".into(), true))
        );
        // Stop: nothing is detected again, the system track's first stretch
        // is transcribed again in German, and each track's rest in its own
        // language.
        let stop = FakePass::hearing("ja");
        let transcript = stop.run(root.path(), &folder, 20_000, true).unwrap();
        assert_eq!(stop.detections.get(), 0);
        assert_eq!(stop.languages_of(Track::System), ["de", "de"]);
        assert_eq!(stop.languages_of(Track::Microphone), ["en"]);
        let texts: Vec<_> = transcript
            .segments
            .iter()
            .map(|row| (row.track, row.text.as_str()))
            .collect();
        // By the time each row shows: "one" at its start, 100 ms, the
        // stretch done again at its alignment point, 150 ms.
        assert_eq!(
            texts,
            [
                (MICROPHONE, "one"),
                (SYSTEM, "de-words"),
                (SYSTEM, "zwei"),
                (MICROPHONE, "en-words"),
                (SYSTEM, "de-words"),
            ]
        );
        let languages = transcript.track_languages.clone().unwrap();
        assert_eq!(
            (
                languages.system.unwrap().language,
                languages.microphone.unwrap().language
            ),
            ("de".to_owned(), "en".to_owned())
        );
        // The refining pass keeps each track's decision, whatever Settings
        // say by then.
        settings::save(root.path(), &chosen("fr")).unwrap();
        let refine = FakePass::hearing("ja");
        let transcript = refine.run(root.path(), &folder, 20_000, false).unwrap();
        assert_eq!(refine.detections.get(), 0);
        assert_eq!(refine.languages_of(Track::System), ["de"]);
        assert_eq!(refine.languages_of(Track::Microphone), ["en"]);
        assert_eq!(in_language(&transcript), (Some("en"), true));

        // Retry and `cue transcribe` forget the stretches: a language
        // chosen in Settings holds both tracks, and nothing is detected.
        stretches::forget(&folder);
        let held = call();
        let transcript = held.run(root.path(), &folder, 5000, true).unwrap();
        assert_eq!(held.detections.get(), 0);
        assert_eq!(*held.languages.borrow(), ["fr", "fr"]);
        assert_eq!(
            serde_json::to_value(&transcript).unwrap()["trackLanguages"],
            json!({"microphone":{"language":"fr"},"system":{"language":"fr"}})
        );
        assert_eq!(in_language(&transcript), (Some("fr"), false));
    }

    /// Where a 16 kHz file is loud enough to be speech, in steps of 50 ms:
    /// what the speech detector finds in made-up audio.
    fn loud(speech: &Path) -> Result<Vec<(u64, u64)>, String> {
        let samples = echo::made_up::read(speech);
        let mut regions: Vec<(u64, u64)> = Vec::new();
        for (index, frame) in samples.chunks(800).enumerate() {
            let power = frame.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / frame.len() as f64;
            if power.sqrt() < 40.0 {
                continue;
            }
            let start = index as u64 * 50;
            match regions.last_mut() {
                Some(last) if last.1 == start => last.1 = start + 50,
                _ => regions.push((start, start + 50)),
            }
        }
        Ok(regions)
    }
    /// A whole-take pass over a take whose system track holds `call` and
    /// whose microphone track holds `microphone`: the pass and the echo gate
    /// themselves, with a detector that finds what is loud and a Whisper
    /// that returns one row for each stretch of speech it is given. Returns
    /// each row's track and the second it starts in.
    fn heard_from(call: &[f32], microphone: &[f32]) -> Vec<(Option<Track>, u64)> {
        use echo::made_up::write;
        let (root, folder) = take_folder();
        write(&folder.join("mic.wav"), microphone);
        write(&folder.join("system.wav"), call);
        let duration_ms = microphone.len() as u64 / 16;
        let tools = Tools {
            convert: &|source, target, from_ms, length_ms| {
                let from = from_ms.unwrap_or(0);
                wav_slice(source, target, from, from + length_ms.unwrap())
            },
            regions: &loud,
            detect: &|_, _| Some("en".into()),
            model: &|_| Ok("ggml-small.en.bin".into()),
            whisper: &|speech, _, _| {
                let mut said = empty_transcript();
                for (start_ms, end_ms) in loud(speech)? {
                    said.segments
                        .extend(sample_transcript(&[("words", start_ms, end_ms)]).segments);
                }
                Ok(said)
            },
            echo: &|microphone, system| {
                echo::silence_echo(microphone, system, &loud(microphone)?).map(|_| ())
            },
            stop: &AtomicBool::new(false),
        };
        let transcript =
            transcribe_media_in(root.path(), &folder, duration_ms, true, true, &tools).unwrap();
        // Silencing never changes the take's own audio.
        assert_eq!(
            echo::made_up::read(&folder.join("mic.wav")).len(),
            microphone.len()
        );
        transcript
            .segments
            .iter()
            .map(|row| (row.track, row.start_ms / 1000))
            .collect()
    }
    /// A call over the loudspeakers: it talks from 1 to 4 s and from 9 to
    /// 12 s, and the microphone hears it 130 ms late and 20 dB quieter; the
    /// reviewer answers from 5 to 8 s and says a word at 13 s.
    fn call_on_loudspeakers() -> (Vec<f32>, Vec<f32>) {
        use echo::made_up::{heard, mixed, quiet, voice};
        let call = [
            quiet(1_000),
            voice(1, 3_000, -20.0),
            quiet(5_000),
            voice(4, 3_000, -20.0),
            quiet(3_000),
        ]
        .concat();
        let reviewer = [
            quiet(5_000),
            voice(3, 3_000, -30.0),
            quiet(5_000),
            voice(5, 600, -30.0),
            quiet(1_400),
        ]
        .concat();
        let room = voice(9, 15_000, -70.0);
        let microphone = mixed(&mixed(&heard(&call, 130, 20.0), &reviewer), &room);
        (call, microphone)
    }

    #[test]
    fn microphone_speech_that_matches_the_system_audio_is_left_out() {
        let (call, microphone) = call_on_loudspeakers();
        // The microphone track alone holds four stretches of speech: the
        // call twice, as the loudspeakers played it, and the reviewer twice.
        let folder = tempfile::tempdir().unwrap();
        let alone = folder.path().join("mic.wav");
        echo::made_up::write(&alone, &microphone);
        let starts: Vec<_> = loud(&alone)
            .unwrap()
            .iter()
            .map(|region| region.0 / 1000)
            .collect();
        assert_eq!(starts, [1, 5, 9, 13]);
        // Transcribed from both tracks, the call's words are there once, as
        // system rows, and not again as microphone rows.
        let heard = heard_from(&call, &microphone);
        let on = |track: Option<Track>| -> Vec<u64> {
            heard
                .iter()
                .filter(|row| row.0 == track)
                .map(|row| row.1)
                .collect()
        };
        assert_eq!(on(SYSTEM), [1, 9]);
        assert!(
            !on(MICROPHONE).contains(&1) && !on(MICROPHONE).contains(&9),
            "{heard:?}"
        );
    }

    #[test]
    fn microphone_speech_without_a_match_is_kept() {
        // Over the loudspeakers: what the reviewer says while the call is
        // silent stays, as microphone rows, in the order it was spoken.
        let (call, microphone) = call_on_loudspeakers();
        assert_eq!(
            heard_from(&call, &microphone),
            [(SYSTEM, 1), (MICROPHONE, 5), (SYSTEM, 9), (MICROPHONE, 13)]
        );
        // On headphones the microphone hears nothing of the call, so the
        // reviewer talking over it loses nothing: both are there.
        use echo::made_up::{quiet, voice};
        let call = [quiet(1_000), voice(1, 6_000, -20.0), quiet(1_000)].concat();
        let reviewer = [
            quiet(2_000),
            voice(3, 3_000, -30.0),
            quiet(1_200),
            voice(5, 500, -30.0),
            quiet(1_300),
        ]
        .concat();
        assert_eq!(
            heard_from(&call, &reviewer),
            [(SYSTEM, 1), (MICROPHONE, 2), (MICROPHONE, 6)]
        );
        // And with nothing playing at all.
        assert_eq!(
            heard_from(&quiet(8_000), &reviewer),
            [(MICROPHONE, 2), (MICROPHONE, 6)]
        );
    }

    /// Where the two passes of a take meet: each waits here until both have
    /// arrived, which they only do when they run at the same time.
    #[derive(Default)]
    struct Meeting {
        arrived: std::sync::Mutex<usize>,
        both: std::sync::Condvar,
    }
    impl Meeting {
        const PATIENCE: Duration = Duration::from_secs(10);
        /// Arrives and waits for the other pass; an error when it never
        /// comes, as when one pass runs after the other.
        fn meet(&self) -> Result<(), String> {
            *self.arrived.lock().unwrap() += 1;
            self.both.notify_all();
            self.wait()
        }
        /// Waits until both passes have arrived.
        fn wait(&self) -> Result<(), String> {
            let arrived = self.arrived.lock().unwrap();
            let (_arrived, waited) = self
                .both
                .wait_timeout_while(arrived, Self::PATIENCE, |arrived| *arrived < 2)
                .unwrap();
            match waited.timed_out() {
                true => Err("The other track's pass did not run at the same time.".into()),
                false => Ok(()),
            }
        }
    }
    /// Waits until `stop` is set; an error when it never is.
    fn until_stopped(stop: &AtomicBool) -> Result<(), String> {
        let began = std::time::Instant::now();
        while !stop.load(Ordering::Acquire) {
            if began.elapsed() > Meeting::PATIENCE {
                return Err("The pass was left running.".into());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }
    /// The track a fake Whisper is asked for, from its raw output's name.
    fn track_of(raw: &Path) -> Track {
        match file_name(raw).contains("system") {
            true => Track::System,
            false => Track::Microphone,
        }
    }
    /// One word, as a fake Whisper returns it for the track of `raw`.
    fn one_row(raw: &Path) -> Transcript {
        let mut said = spoken(track_of(raw).name());
        said.segments[0].words[0].seek_ms = Some(150);
        said
    }

    #[test]
    fn the_two_tracks_of_a_take_are_transcribed_at_the_same_time() {
        let (root, folder) = two_track_folder();
        settings::save(root.path(), &chosen("en")).unwrap();
        // Neither track's Whisper returns before the other track's has
        // started, and nor does either conversion before the other: one
        // pass after the other would wait in vain.
        let (converting, transcribing) = (Meeting::default(), Meeting::default());
        let stop = AtomicBool::new(false);
        let tools = Tools {
            convert: &|_, target, _, _| match file_name(target).as_str() {
                // The first conversion of each pass.
                "speech.wav" | "system-speech.wav" => converting.meet(),
                _ => Ok(()),
            },
            regions: &|_| Ok(vec![(0, 1000)]),
            detect: &|_, _| panic!("a language is chosen"),
            model: &|_| Ok("ggml-small.en.bin".into()),
            whisper: &|_, _, raw| {
                transcribing.meet()?;
                Ok(one_row(raw))
            },
            echo: &|_, _| Ok(()),
            stop: &stop,
        };
        let began = std::time::Instant::now();
        let transcript =
            transcribe_media_in(root.path(), &folder, 5000, true, true, &tools).unwrap();
        assert!(began.elapsed() < Meeting::PATIENCE);
        assert_eq!(
            rows(&transcript),
            [(SYSTEM, "system", 100), (MICROPHONE, "microphone", 100)]
        );
        assert!(!stop.load(Ordering::Acquire), "nothing was stopped");
        // A take with one track is one pass: nothing to meet.
        let (root, folder) = take_folder();
        settings::save(root.path(), &chosen("en")).unwrap();
        let alone = Tools {
            convert: &|_, _, _, _| Ok(()),
            whisper: &|_, _, raw| Ok(one_row(raw)),
            ..tools
        };
        let transcript =
            transcribe_media_in(root.path(), &folder, 5000, true, true, &alone).unwrap();
        assert_eq!(rows(&transcript), [(None, "microphone", 100)]);
    }

    /// A take of 15 s with both tracks as made-up audio, a call over
    /// loudspeakers, whose tracks each finished a stretch while it recorded,
    /// the system track's in a language it was not held to in the end.
    fn made_up_take() -> (tempfile::TempDir, std::path::PathBuf) {
        let (root, folder) = take_folder();
        let (call, microphone) = call_on_loudspeakers();
        echo::made_up::write(&folder.join("mic.wav"), &microphone);
        echo::made_up::write(&folder.join("system.wav"), &call);
        let mut system = Stretches::of_track(Track::System, None);
        system.push(
            spoken("nonsense"),
            2_000,
            "en",
            "ggml-small.en.bin",
            Some(guessed("en", 0.5)),
        );
        system.push(
            spoken("anruf"),
            4_500,
            "de",
            "ggml-small.bin",
            Some(guessed("de", 0.97)),
        );
        stretches::save(&folder, &system).unwrap();
        let mut reviewer = Stretches::of_track(Track::Microphone, None);
        reviewer.push(
            spoken("answer"),
            8_500,
            "en",
            "ggml-small.en.bin",
            Some(guessed("en", 0.95)),
        );
        stretches::save(&folder, &reviewer).unwrap();
        (root, folder)
    }

    #[test]
    fn two_tracks_at_once_give_what_one_after_the_other_gives() {
        // The pass itself and the echo gate, on made-up audio; a detector
        // that finds what is loud and a Whisper that returns a row for each
        // stretch of speech, in the language it is held to.
        let stop = AtomicBool::new(false);
        let tools = Tools {
            convert: &|source, target, from_ms, length_ms| {
                let from = from_ms.unwrap_or(0);
                wav_slice(source, target, from, from + length_ms.unwrap())
            },
            regions: &loud,
            detect: &|_, _| Some("en".into()),
            model: &|language| {
                Ok(match language {
                    "en" => "ggml-small.en.bin",
                    _ => "ggml-small.bin",
                }
                .into())
            },
            whisper: &|speech, language, _| {
                let mut said = empty_transcript();
                for (start_ms, end_ms) in loud(speech)? {
                    let mut row = sample_transcript(&[(language, start_ms, end_ms)]);
                    row.segments[0].words[0].seek_ms = Some(start_ms + 40);
                    said.segments.extend(row.segments);
                }
                Ok(said)
            },
            echo: &|microphone, system| {
                echo::silence_echo(microphone, system, &loud(microphone)?).map(|_| ())
            },
            stop: &stop,
        };
        // One track after the other, as a pass was made before.
        let (root, folder) = made_up_take();
        let settings = settings::load(root.path());
        let pass = Pass {
            settings: &settings,
            folder: &folder,
            duration_ms: 15_000,
            reuse: true,
            tools: &tools,
        };
        let system = pass.run(Some(Track::System)).unwrap();
        let microphone = pass.run(Some(Track::Microphone)).unwrap();
        let in_turn = merge_tracks(system, microphone);
        let saved_in_turn = |track: Track| {
            fs::read(folder.join(format!("stretches/{}.json", track.name()))).unwrap()
        };
        // The system track's first stretch done again in German, its rest
        // from 4.5 s; the microphone's rest from 8.5 s, without the echo.
        assert_eq!(
            rows(&in_turn),
            [
                (MICROPHONE, "answer", 100),
                (SYSTEM, "de", 1_000),
                (SYSTEM, "anruf", 2_100),
                (SYSTEM, "de", 9_000),
                (MICROPHONE, "en", 13_000),
            ]
        );
        // Both at once, on a take that is the same: the same rows, in the
        // same order, with the same ids, languages and saved stretches.
        for _ in 0..5 {
            let (root, folder) = made_up_take();
            let at_once =
                transcribe_media_in(root.path(), &folder, 15_000, true, true, &tools).unwrap();
            assert_eq!(
                serde_json::to_value(&at_once).unwrap(),
                serde_json::to_value(&in_turn).unwrap()
            );
            for track in [Track::System, Track::Microphone] {
                let saved =
                    fs::read(folder.join(format!("stretches/{}.json", track.name()))).unwrap();
                assert!(saved == saved_in_turn(track), "{track:?}");
            }
        }
        let ids: Vec<_> = in_turn.segments.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "segment-0",
                "segment-1",
                "segment-2",
                "segment-3",
                "segment-4"
            ]
        );
        assert_eq!(
            serde_json::to_value(&in_turn).unwrap()["trackLanguages"],
            json!({"microphone":{"language":"en","languageDetected":true},
                "system":{"language":"de","languageDetected":true}})
        );
    }

    #[test]
    fn cancelling_a_pass_stops_both_tracks() {
        let (root, folder) = two_track_folder();
        settings::save(root.path(), &chosen("en")).unwrap();
        // A refinement's cancel flag is what stops its tools. Both tracks
        // are transcribing when it is set.
        let cancel = AtomicBool::new(false);
        let transcribing = Meeting::default();
        let stopped = Count::default();
        let later = Count::default();
        let tools = Tools {
            convert: &|_, _, _, _| Ok(()),
            regions: &|_| Ok(vec![(0, 1000)]),
            detect: &|_, _| panic!("a language is chosen"),
            model: &|_| Ok("ggml-small.en.bin".into()),
            // As Whisper under a cancel flag: killed, and reported so.
            whisper: &|_, _, _| {
                transcribing.meet()?;
                until_stopped(&cancel)?;
                stopped.add();
                Err(CANCELLED.into())
            },
            echo: &|_, _| {
                later.add();
                Ok(())
            },
            stop: &cancel,
        };
        let began = std::time::Instant::now();
        let result = std::thread::scope(|scope| {
            let pass = scope
                .spawn(|| transcribe_media_in(root.path(), &folder, 5000, true, false, &tools));
            transcribing.wait().unwrap();
            cancel.store(true, Ordering::Release);
            pass.join().unwrap()
        });
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert_eq!(stopped.get(), 2, "both tracks were stopped");
        assert!(began.elapsed() < Duration::from_secs(5), "and promptly");
        assert_eq!(
            later.get(),
            1,
            "the microphone's one comparison came before"
        );
        // A pass cancelled before it starts does nothing for either track.
        let never = Tools {
            convert: &|_, _, _, _| panic!("converted after the cancel"),
            whisper: &|_, _, _| panic!("transcribed after the cancel"),
            ..tools
        };
        let result = transcribe_media_in(root.path(), &folder, 5000, true, false, &never);
        assert_eq!(result.unwrap_err(), CANCELLED);
    }

    #[test]
    fn a_track_that_fails_stops_the_other_and_fails_the_take() {
        let crashed = |track: Track| format!("The {} track's Whisper crashed.", track.name());
        for failing in [Track::System, Track::Microphone] {
            let (root, folder) = two_track_folder();
            settings::save(root.path(), &chosen("en")).unwrap();
            let stop = AtomicBool::new(false);
            let transcribing = Meeting::default();
            let (stopped, ran) = (Count::default(), Count::default());
            let tools = Tools {
                convert: &|_, _, _, _| Ok(()),
                regions: &|_| Ok(vec![(0, 1000)]),
                detect: &|_, _| panic!("a language is chosen"),
                model: &|_| Ok("ggml-small.en.bin".into()),
                // Both tracks are transcribing when one fails; the other
                // runs until it is stopped, as a Whisper that is killed.
                whisper: &|_, _, raw| {
                    ran.add();
                    transcribing.meet()?;
                    if track_of(raw) == failing {
                        return Err(crashed(failing));
                    }
                    until_stopped(&stop)?;
                    stopped.add();
                    Err(CANCELLED.into())
                },
                echo: &|_, _| Ok(()),
                stop: &stop,
            };
            let began = std::time::Instant::now();
            let result = transcribe_media_in(root.path(), &folder, 5000, true, true, &tools);
            // The take fails with the failing track's error, as it did when
            // one track ran after the other; the other track was stopped,
            // not left to finish, and nothing of it is returned.
            assert_eq!(result.unwrap_err(), crashed(failing), "{failing:?}");
            assert_eq!((ran.get(), stopped.get()), (2, 1), "{failing:?}");
            assert!(stop.load(Ordering::Acquire));
            assert!(began.elapsed() < Duration::from_secs(5));
        }

        // A track that fails before the other has come to Whisper: the
        // other does not start it.
        for failing in [Track::System, Track::Microphone] {
            let (root, folder) = two_track_folder();
            settings::save(root.path(), &chosen("en")).unwrap();
            let stop = AtomicBool::new(false);
            let converting = Meeting::default();
            let own = |target: &Path| match file_name(target).as_str() {
                "system-speech.wav" => Some(Track::System),
                "speech.wav" => Some(Track::Microphone),
                _ => None,
            };
            let tools = Tools {
                convert: &|_, target, _, _| {
                    let Some(track) = own(target) else {
                        return Ok(());
                    };
                    converting.meet()?;
                    if track == failing {
                        return Err("FFmpeg failed.".into());
                    }
                    // As FFmpeg that is stopped.
                    until_stopped(&stop)?;
                    Err(CANCELLED.into())
                },
                regions: &|_| panic!("looked for speech after the failure"),
                detect: &|_, _| panic!("a language is chosen"),
                model: &|_| Ok("ggml-small.en.bin".into()),
                whisper: &|_, _, _| panic!("transcribed after the failure"),
                echo: &|_, _| panic!("compared after the failure"),
                stop: &stop,
            };
            let result = transcribe_media_in(root.path(), &folder, 5000, true, true, &tools);
            assert_eq!(result.unwrap_err(), "FFmpeg failed.", "{failing:?}");
        }

        // Both fail on their own: the system track's error is the take's,
        // as when it ran first and the microphone's pass never started.
        let (root, folder) = two_track_folder();
        settings::save(root.path(), &chosen("en")).unwrap();
        let stop = AtomicBool::new(false);
        let transcribing = Meeting::default();
        let tools = Tools {
            convert: &|_, _, _, _| Ok(()),
            regions: &|_| Ok(vec![(0, 1000)]),
            detect: &|_, _| panic!("a language is chosen"),
            model: &|_| Ok("ggml-small.en.bin".into()),
            whisper: &|_, _, raw| {
                transcribing.meet()?;
                Err(crashed(track_of(raw)))
            },
            echo: &|_, _| Ok(()),
            stop: &stop,
        };
        let result = transcribe_media_in(root.path(), &folder, 5000, true, true, &tools);
        assert_eq!(result.unwrap_err(), crashed(Track::System));
        // A take with one track fails as ever, and sets no flag.
        let (root, folder) = take_folder();
        settings::save(root.path(), &chosen("en")).unwrap();
        let stop = AtomicBool::new(false);
        let alone = Tools {
            whisper: &|_, _, _| Err("Whisper crashed.".into()),
            stop: &stop,
            ..tools
        };
        let result = transcribe_media_in(root.path(), &folder, 5000, true, true, &alone);
        assert_eq!(result.unwrap_err(), "Whisper crashed.");
        assert!(!stop.load(Ordering::Acquire));
    }

    #[test]
    fn the_two_passes_write_no_file_in_common() {
        let (root, folder) = made_up_take();
        // Every file each pass writes, by the thread that writes it: what
        // the pass names for its tools, and what the tools name for
        // themselves from the speech file they are given ([`scratch`]).
        let written = Noted::<Vec<(std::thread::ThreadId, String)>>::default();
        let write = |file: &Path| {
            let name = file
                .strip_prefix(&folder)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let thread = std::thread::current().id();
            written.borrow_mut().push((thread, name));
        };
        let scratched = |speech: &Path, names: &[&str]| {
            for name in names {
                write(&scratch(&folder, speech, name));
            }
        };
        let stop = AtomicBool::new(false);
        let tools = Tools {
            convert: &|source, target, from_ms, length_ms| {
                write(target);
                scratched(target, &["transcode.log"]);
                let from = from_ms.unwrap_or(0);
                wav_slice(source, target, from, from + length_ms.unwrap())
            },
            regions: &|speech| {
                scratched(speech, &["vad.txt", "vad.log"]);
                loud(speech)
            },
            detect: &|speech, _| {
                scratched(speech, &["language.wav"]);
                let window = scratch(&folder, speech, "language.wav");
                scratched(&window, &["language.log"]);
                Some("de".into())
            },
            model: &|language| {
                Ok(match language {
                    "en" => "ggml-small.en.bin",
                    _ => "ggml-small.bin",
                }
                .into())
            },
            whisper: &|speech, _, raw| {
                write(raw);
                scratched(speech, &["transcription.log"]);
                Ok(spoken("words"))
            },
            echo: &|microphone, _| {
                scratched(microphone, &["vad.txt", "vad.log"]);
                write(&folder.join("speech.wav.gated"));
                Ok(())
            },
            stop: &stop,
        };
        // Stop: each track transcribes a stretch again and then its rest,
        // and saves its stretches for itself.
        transcribe_media_in(root.path(), &folder, 15_000, true, true, &tools).unwrap();
        let mut saved: Vec<_> = fs::read_dir(stretches::folder(&folder))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        saved.sort();
        assert_eq!(saved, ["microphone.json", "system.json"]);
        // A whole-take pass: each track detects its language too.
        stretches::forget(&folder);
        transcribe_media_in(root.path(), &folder, 15_000, true, true, &tools).unwrap();
        let written = written.take();
        let files = |thread: std::thread::ThreadId| -> std::collections::BTreeSet<String> {
            let by = written.iter().filter(|(by, _)| *by == thread);
            by.map(|(_, name)| name.clone()).collect()
        };
        // The microphone's pass runs on this thread, the system's on others.
        let here = std::thread::current().id();
        let microphone = files(here);
        let mut system = std::collections::BTreeSet::new();
        for (thread, _) in written.iter().filter(|(thread, _)| *thread != here) {
            system.extend(files(*thread));
        }
        let names = |files: &std::collections::BTreeSet<String>| -> Vec<String> {
            files.iter().cloned().collect()
        };
        assert_eq!(
            names(&system),
            [
                "stretches/system-0.json",
                "system-language.log",
                "system-language.wav",
                "system-speech.wav",
                "system-stretch.wav",
                "system-transcode.log",
                "system-transcription.log",
                "system-vad.log",
                "system-vad.txt",
                "whisper-system.json",
            ]
        );
        assert_eq!(
            names(&microphone),
            [
                "echo-reference.wav",
                "language.log",
                "language.wav",
                "speech.wav",
                "speech.wav.gated",
                "transcode.log",
                "transcription.log",
                "vad.log",
                "vad.txt",
                "whisper.json",
            ]
        );
        assert!(system.is_disjoint(&microphone));
        // A file of a take with one track, or of the live worker, keeps the
        // name it always had.
        for speech in [
            "speech.wav",
            "stretch.wav",
            "language.wav",
            "echo-reference.wav",
        ] {
            assert_eq!(
                scratch(&folder, &folder.join(speech), "vad.txt"),
                folder.join("vad.txt")
            );
        }
    }

    #[test]
    fn a_stretch_done_again_is_compared_whatever_the_two_rates() {
        let (audio, system) = (Path::new("redo.wav"), Path::new("redo-system.wav"));
        // What the capture reports for a copy of a 70 s track at its rate.
        let reported = |track: Track, from_ms: u64| {
            let rate = match track {
                Track::Microphone => 48_000,
                Track::System => 44_100,
            };
            let span = crate::capture::copy_span(rate, rate * 70, Some(from_ms));
            crate::capture::span_ms(rate, span)
        };
        // A stretch of the microphone that starts at 12345 ms: the 48 kHz
        // microphone reports 12345, the 44.1 kHz system track 12344, and
        // the two are compared.
        let copies = std::cell::RefCell::new(Vec::new());
        let mut both = |track: Track, from_ms: u64, target: &Path| {
            copies.borrow_mut().push((
                track,
                from_ms,
                target.to_owned(),
                reported(track, from_ms).0,
            ));
            Ok(reported(track, from_ms))
        };
        for from_ms in [12_345, 12_340, 1, 28_007] {
            let compared = redo_copies(Track::Microphone, from_ms, audio, Some(system), &mut both);
            assert_eq!(compared, Ok(true), "from {from_ms} ms");
        }
        assert_eq!(
            copies.borrow()[..2],
            [
                (Track::Microphone, 12_345, audio.to_owned(), 12_345),
                (Track::System, 12_345, system.to_owned(), 12_344),
            ]
        );
        // A system track that cannot be copied, or ends before the stretch
        // starts: nothing in the stretch counts as echo, and it is done.
        let mut silent = |track: Track, from_ms: u64, _: &Path| match track {
            Track::Microphone => Ok(reported(track, from_ms)),
            Track::System => Err("Waiting for audio samples".to_string()),
        };
        assert_eq!(
            redo_copies(Track::Microphone, 12_345, audio, Some(system), &mut silent),
            Ok(false)
        );
        let mut short = |track: Track, from_ms: u64, _: &Path| match track {
            Track::Microphone => Ok(reported(track, from_ms)),
            Track::System => Ok((9_000, 9_000)),
        };
        assert_eq!(
            redo_copies(Track::Microphone, 12_345, audio, Some(system), &mut short),
            Ok(false)
        );
        // The stretch's own track failing is tried again later.
        let mut busy = |_: Track, _: u64, _: &Path| Err("Audio snapshot is busy".to_string());
        assert_eq!(
            redo_copies(Track::Microphone, 12_345, audio, Some(system), &mut busy),
            Err("Audio snapshot is busy".into())
        );
        // The system track's own stretches, and a take with one track, copy
        // one track and compare nothing.
        copies.borrow_mut().clear();
        for own in [Track::System, Track::Microphone] {
            assert_eq!(redo_copies(own, 12_345, audio, None, &mut both), Ok(false));
        }
        let copied: Vec<_> = copies.borrow().iter().map(|copy| copy.0).collect();
        assert_eq!(copied, [Track::System, Track::Microphone]);
    }

    #[test]
    fn a_track_without_audio_neither_fails_the_take_nor_costs_the_other_its_stretches() {
        use echo::made_up::{quiet, read, voice, write};
        // 35 s in which one track speaks from 1 to 4 s and from 31 to 33 s.
        let speaking = [
            quiet(1_000),
            voice(3, 3_000, -30.0),
            quiet(27_000),
            voice(5, 2_000, -30.0),
            quiet(2_000),
        ]
        .concat();
        // The other track never got a sample: after Stop it is silence of
        // the take's length; a take that was not finished leaves it empty.
        for nothing in [quiet(35_000), Vec::new()] {
            for speaker in [Track::Microphone, Track::System] {
                let silent = match speaker {
                    Track::Microphone => Track::System,
                    Track::System => Track::Microphone,
                };
                let (root, folder) = take_folder();
                write(&folder.join(speaker.file()), &speaking);
                write(&folder.join(silent.file()), &nothing);
                // While it recorded, the speaking track finished a stretch
                // of 30 s; the other one had nothing to cut.
                let mut live = Stretches::of_track(speaker, Some("en"));
                live.push(spoken("live"), 30_000, "en", "ggml-small.en.bin", None);
                stretches::save(&folder, &live).unwrap();
                settings::save(root.path(), &chosen("en")).unwrap();
                let converted = Noted::<Vec<(String, Option<u64>)>>::default();
                // As the detector, which refuses a file without samples.
                let detector = |speech: &Path| {
                    if read(speech).is_empty() {
                        return Err("failed to read audio data".to_string());
                    }
                    loud(speech)
                };
                let tools = Tools {
                    convert: &|source, target, from_ms, length_ms| {
                        converted.borrow_mut().push((file_name(source), from_ms));
                        let from = from_ms.unwrap_or(0);
                        wav_slice(source, target, from, from + length_ms.unwrap())
                    },
                    regions: &detector,
                    detect: &|_, _| panic!("a language is chosen"),
                    model: &|_| Ok("ggml-small.en.bin".into()),
                    whisper: &|speech, _, _| {
                        let mut said = empty_transcript();
                        for (start_ms, end_ms) in loud(speech)? {
                            said.segments
                                .extend(sample_transcript(&[("words", start_ms, end_ms)]).segments);
                        }
                        Ok(said)
                    },
                    echo: &|microphone, system| {
                        echo::silence_echo(microphone, system, &detector(microphone)?).map(|_| ())
                    },
                    stop: &AtomicBool::new(false),
                };
                // Stop: the take is transcribed, the speaking track from its
                // stretch and the 5 s after it, and nothing fails.
                let transcript =
                    transcribe_media_in(root.path(), &folder, 35_000, true, true, &tools)
                        .unwrap_or_else(|error| panic!("{speaker:?} beside {silent:?}: {error}"));
                assert_eq!(
                    rows(&transcript),
                    [
                        (Some(speaker), "live", 100),
                        (Some(speaker), "words", 31_000),
                    ]
                );
                let whole = |track: Track| (track.file().to_owned(), None);
                let rest = |track: Track| (track.file().to_owned(), Some(30_000));
                let mut expected = match speaker {
                    // The system track whole; the microphone's rest,
                    // compared with the system audio of the same span.
                    Track::Microphone => {
                        vec![whole(silent), rest(speaker), rest(silent)]
                    }
                    // A microphone without audio is compared with nothing.
                    Track::System => match nothing.is_empty() {
                        true => vec![rest(speaker), whole(silent)],
                        false => vec![rest(speaker), whole(silent), whole(speaker)],
                    },
                };
                // The two tracks are converted at the same time.
                let mut converted = converted.take();
                converted.sort();
                expected.sort();
                assert_eq!(converted, expected);
                assert!(
                    stretches::language(&folder, Some(speaker)).is_some(),
                    "the stretches were reused, and wait for the refining pass"
                );
                let languages = transcript.track_languages.clone().unwrap();
                let (heard, unheard) = match speaker {
                    Track::Microphone => (languages.microphone, languages.system),
                    Track::System => (languages.system, languages.microphone),
                };
                assert_eq!(heard.unwrap().language, "en");
                assert_eq!(unheard, None, "a track without words has no language");
                // The refining pass, and Retry and `cue transcribe`, read
                // both tracks whole and do not fail either.
                let again =
                    transcribe_media_in(root.path(), &folder, 35_000, true, false, &tools).unwrap();
                let heard: Vec<_> = again
                    .segments
                    .iter()
                    .map(|row| (row.track, row.start_ms / 1000))
                    .collect();
                assert_eq!(heard, [(Some(speaker), 1), (Some(speaker), 31)]);
            }
        }
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
        let (guess, audio) =
            live_guess(&root, &live, &snapshot, heard_ms, None, None, true, &cancel).unwrap();
        let guess = guess.expect("a guess was asked for");
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
            stretches::language(&take, None),
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
            &mut |track, from_ms, target| {
                copies.borrow_mut().push((track, from_ms));
                wav_slice(&mic, target, from_ms, from_ms + 60_000)?;
                Ok((from_ms, length_ms.min(from_ms + 60_000)))
            },
        );
        assert_eq!(outcome, stretches::Redone::Done);
        assert_eq!(*copies.borrow(), [(Track::Microphone, 12_000)]);
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
    /// What the call says in the test below, sentence by sentence, when a
    /// German voice is installed, and a word of each to find it by.
    const GERMAN_CALL: [(&str, &str); 3] = [
        (
            "Ich öffne jetzt die Bibliothek und schaue mir die Übersicht an.",
            "Bibliothek",
        ),
        (
            "Wenn ich hier auf diese Schaltfläche klicke, wird die Detailansicht nicht aktualisiert.",
            "Schaltfläche",
        ),
        (
            "Danach schauen wir uns gemeinsam die Einstellungen an und prüfen die Sprache.",
            "Einstellungen",
        ),
    ];
    /// And what it says when a second English voice reads it instead.
    const ENGLISH_CALL: [(&str, &str); 3] = [
        (
            "The quarterly budget needs another careful revision before Friday.",
            "budget",
        ),
        (
            "Our warehouse in Hamburg received the delayed shipment yesterday.",
            "warehouse",
        ),
        (
            "Please schedule the customer interview for next Wednesday afternoon.",
            "interview",
        ),
    ];
    /// What the reviewer says in the call's pauses.
    const REVIEWER: [(&str, &str); 2] = [
        ("Please move this button into the top toolbar.", "toolbar"),
        (
            "The text in the sidebar is too small and hard to read.",
            "sidebar",
        ),
    ];
    /// `sentences` read into one file each by the installed Windows voice
    /// number `voice` of language `culture`, written without playing them,
    /// and returned as 16 kHz samples in full scale. `None` when there is
    /// no such voice.
    fn read_aloud(
        culture: &str,
        voice: usize,
        sentences: &[&str],
        folder: &Path,
    ) -> Option<Vec<Vec<f32>>> {
        let script = "Add-Type -AssemblyName System.Speech; \
            $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
            $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $env:CUEREVIEW_SPEECH_CULTURE } | Select-Object -Skip ([int]$env:CUEREVIEW_SPEECH_VOICE) -First 1; \
            if (-not $v) { exit 3 }; \
            $s.SelectVoice($v.VoiceInfo.Name); \
            $i = 0; \
            foreach ($text in $env:CUEREVIEW_SPEECH_TEXT -split '\\|') { \
                $s.SetOutputToWaveFile((Join-Path $env:CUEREVIEW_SPEECH_TARGET ([string]$i + '.wav'))); \
                $s.Speak($text); \
                $i++ \
            }; \
            $s.Dispose()";
        let target = folder.join(format!("{culture}-{voice}"));
        fs::create_dir_all(&target).unwrap();
        let spoken = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("CUEREVIEW_SPEECH_CULTURE", culture)
            .env("CUEREVIEW_SPEECH_VOICE", voice.to_string())
            .env("CUEREVIEW_SPEECH_TEXT", sentences.join("|"))
            .env("CUEREVIEW_SPEECH_TARGET", &target)
            .status();
        if !spoken.is_ok_and(|status| status.success()) {
            return None;
        }
        let samples = (0..sentences.len())
            .map(|index| {
                let speech = target.join(format!("{index}-speech.wav"));
                to_speech(
                    &target.join(format!("{index}.wav")),
                    &speech,
                    None,
                    None,
                    &target.join("speech.log"),
                    None,
                )
                .unwrap();
                echo::made_up::read(&speech)
                    .iter()
                    .map(|sample| *sample as f32 / 32768.0)
                    .collect()
            })
            .collect();
        Some(samples)
    }
    #[test]
    #[ignore = "Requires Whisper, FFmpeg, base, small.en, small and the detector in CUEREVIEW_DATA_DIR, and two installed Windows voices: an English one, and a German or a second English one"]
    fn actual_speaker_echo_is_transcribed_once() {
        use echo::made_up::{copy_recorded, heard, mixed, quiet, write_recorded};
        let scratch = tempfile::tempdir().unwrap();
        // A data root without settings.json: Auto.
        let root = scratch.path().join("data");
        let take = root.join("take");
        let live = take.join("live");
        fs::create_dir_all(&live).unwrap();
        // The call is read by a German voice, or by a second English one;
        // the reviewer by the first English one. Nothing is played.
        let sentences = |said: &[(&'static str, &'static str)]| -> Vec<&'static str> {
            said.iter().map(|(sentence, _)| *sentence).collect()
        };
        let (call_said, call_audio, german) =
            match read_aloud("de", 0, &sentences(&GERMAN_CALL), scratch.path()) {
                Some(audio) => (GERMAN_CALL, audio, true),
                None => (
                    ENGLISH_CALL,
                    read_aloud("en", 1, &sentences(&ENGLISH_CALL), scratch.path())
                        .expect("a German or a second English Windows voice for the call"),
                    false,
                ),
            };
        let reviewer_audio = read_aloud("en", 0, &sentences(&REVIEWER), scratch.path())
            .expect("an English Windows voice for the reviewer");

        // The take: the call speaks, and the reviewer answers in its
        // pauses. The system track holds the call; the microphone holds the
        // reviewer and, from the loudspeakers, the call 130 ms late and
        // 20 dB quieter. The reviewer is 8 dB above that echo. The two
        // tracks are recorded at different rates, as two devices mostly are:
        // the microphone at 48 kHz, the loopback at 44.1 kHz.
        let pause = || quiet(800);
        let mut system = quiet(1_000);
        let mut reviewer = quiet(1_000);
        // Where each sentence lies in the take (ms), by who says it.
        let (mut call_spans, mut reviewer_spans) = (Vec::new(), Vec::new());
        let ms = |samples: &Vec<f32>| samples.len() as u64 / 16;
        for (index, sentence) in call_audio.iter().enumerate() {
            call_spans.push((ms(&system), ms(&system) + ms(sentence)));
            system.extend(sentence);
            reviewer.extend(vec![0.0; sentence.len()]);
            for track in [&mut system, &mut reviewer] {
                track.extend(pause());
            }
            if let Some(answer) = reviewer_audio.get(index) {
                reviewer_spans.push((ms(&reviewer), ms(&reviewer) + ms(answer)));
                reviewer.extend(answer.iter().map(|sample| sample * 0.25));
                system.extend(vec![0.0; answer.len()]);
                for track in [&mut system, &mut reviewer] {
                    track.extend(pause());
                }
            }
        }
        let microphone = mixed(&heard(&system, 130, 20.0), &reviewer);
        let length_ms = ms(&system);
        write_recorded(&take.join("mic.wav"), &microphone, 48_000);
        write_recorded(&take.join("system.wav"), &system, 44_100);
        let recorded = fs::read(take.join("mic.wav")).unwrap();
        eprintln!("call {call_spans:?}, reviewer {reviewer_spans:?}, {length_ms} ms");

        let on = |transcript: &Transcript, track: Track| Transcript {
            segments: transcript
                .segments
                .iter()
                .filter(|row| row.track == Some(track))
                .cloned()
                .collect(),
            ..Default::default()
        };
        let times = |transcript: &Transcript, word: &str| {
            crate::agent::find(transcript, word).unwrap().len()
        };

        // Without the system track the microphone gives the call's words
        // too, as the loudspeakers played them: what this change removes.
        let alone = scratch.path().join("alone");
        fs::create_dir_all(&alone).unwrap();
        fs::copy(take.join("mic.wav"), alone.join("mic.wav")).unwrap();
        let doubled = transcribe_media(&root, &alone, length_ms, true).unwrap();
        let echoed = call_said
            .iter()
            .filter(|(_, word)| times(&doubled, word) > 0)
            .count();
        eprintln!(
            "the microphone alone: {} of the call's {} sentences, {:?}",
            echoed,
            call_said.len(),
            doubled
                .segments
                .iter()
                .map(|row| &row.text)
                .collect::<Vec<_>>()
        );
        assert!(doubled.segments.iter().all(|row| row.track.is_none()));
        assert!(
            echoed > 0,
            "the microphone alone does not even hear the call"
        );

        // When each file of the take folder was last written, in ms after
        // `since`: where the two passes, which run at the same time, spent
        // their time.
        let written = |since: std::time::SystemTime| {
            let mut files: Vec<(u128, String)> = fs::read_dir(&take)
                .unwrap()
                .filter_map(|entry| {
                    let entry = entry.unwrap();
                    let after = entry.metadata().ok()?.modified().ok()?;
                    let ms = after.duration_since(since).ok()?.as_millis();
                    Some((ms, entry.file_name().to_string_lossy().into_owned()))
                })
                .collect();
            files.sort();
            files
                .iter()
                .map(|(ms, name)| format!("{name} {ms}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        // Both tracks: Stop without stretches, Retry and `cue transcribe`.
        let (since, began) = (std::time::SystemTime::now(), std::time::Instant::now());
        let transcript = transcribe_media(&root, &take, length_ms, true).unwrap();
        eprintln!(
            "both tracks whole, {length_ms} ms each, in {:?}: {}",
            began.elapsed(),
            written(since)
        );
        // Each pass wrote scratch files of its own.
        for name in [
            "transcode.log",
            "vad.txt",
            "vad.log",
            "language.log",
            "transcription.log",
        ] {
            for file in [name.to_owned(), format!("system-{name}")] {
                assert!(take.join(&file).is_file(), "{file} is missing");
            }
        }
        assert!(take.join("whisper.json").is_file() && take.join("whisper-system.json").is_file());
        for row in &transcript.segments {
            eprintln!(
                "{:>6} {:<10} {}",
                row.start_ms,
                row.track.map_or("", Track::name),
                row.text
            );
        }
        assert!(transcript.segments.iter().all(|row| row.track.is_some()));
        let (heard_system, heard_microphone) = (
            on(&transcript, Track::System),
            on(&transcript, Track::Microphone),
        );
        // The call's words are there once, as system rows, and not again
        // as the microphone heard them.
        for (_, word) in call_said {
            assert_eq!(times(&heard_system, word), 1, "the call says {word} once");
            assert_eq!(times(&heard_microphone, word), 0, "{word} is echo");
        }
        // The reviewer's words are microphone rows.
        for (_, word) in REVIEWER {
            assert_eq!(
                times(&heard_microphone, word),
                1,
                "the reviewer says {word}"
            );
            assert_eq!(times(&heard_system, word), 0);
        }
        // Every microphone row lies where the reviewer spoke: nothing was
        // made up in the silence left of the echo.
        for row in &heard_microphone.segments {
            let at = crate::agent::segment_seek_ms(row);
            assert!(
                reviewer_spans
                    .iter()
                    .any(|&(start, end)| (start.saturating_sub(1_000)..end + 1_000).contains(&at)),
                "a microphone row at {at} ms, outside the reviewer's speech: {}",
                row.text
            );
        }
        // In the order they were spoken: call, reviewer, call, reviewer, call.
        let order: Vec<_> = transcript
            .segments
            .iter()
            .map(|row| row.track.unwrap())
            .collect::<Vec<_>>();
        let mut turns = order.clone();
        turns.dedup();
        assert_eq!(
            turns,
            [
                Track::System,
                Track::Microphone,
                Track::System,
                Track::Microphone,
                Track::System
            ],
            "{order:?}"
        );
        // Each track is detected on its own.
        let languages = transcript.track_languages.clone().expect("two tracks");
        let (system_language, microphone_language) =
            (languages.system.unwrap(), languages.microphone.unwrap());
        eprintln!("system {system_language:?}, microphone {microphone_language:?}");
        assert_eq!(
            (
                system_language.language.as_str(),
                system_language.language_detected
            ),
            (if german { "de" } else { "en" }, true)
        );
        assert_eq!(
            (
                microphone_language.language.as_str(),
                microphone_language.language_detected
            ),
            ("en", true)
        );
        assert_eq!(in_language(&transcript), (Some("en"), true));
        // The take's own audio is as it was recorded.
        assert!(fs::read(take.join("mic.wav")).unwrap() == recorded);

        // Stop after a recording whose stretches end on an odd millisecond,
        // in the pause after the reviewer's first answer: each track's rest
        // is converted from there, from its own rate, and the microphone's
        // is compared with the system's of the same span.
        let until = (reviewer_spans[0].1 + 357) | 1;
        let call_language = if german { "de" } else { "en" };
        let model = |language: &str| file_name(&deps::final_model(language).path);
        let mut system_live = Stretches::of_track(Track::System, None);
        system_live.push(
            spoken("erstens"),
            until,
            call_language,
            &model(call_language),
            Some(guessed(call_language, 0.95)),
        );
        let mut microphone_live = Stretches::of_track(Track::Microphone, None);
        microphone_live.push(
            spoken("firstly"),
            until,
            "en",
            &model("en"),
            Some(guessed("en", 0.95)),
        );
        stretches::save(&take, &system_live).unwrap();
        stretches::save(&take, &microphone_live).unwrap();
        let (since, began) = (std::time::SystemTime::now(), std::time::Instant::now());
        let stopped = transcribe_media(&root, &take, length_ms, true).unwrap();
        eprintln!(
            "Stop from {until} ms, {} ms of each track left, in {:?}: {}",
            length_ms - until,
            began.elapsed(),
            written(since)
        );
        for row in &stopped.segments {
            eprintln!(
                "from {until} ms: {:>6} {:<10} {}",
                row.start_ms,
                row.track.map_or("", Track::name),
                row.text
            );
        }
        assert!(
            stretches::language(&take, SYSTEM).is_some()
                && stretches::language(&take, MICROPHONE).is_some(),
            "Stop reused the stretches of both tracks"
        );
        let (rest_system, rest_microphone) =
            (on(&stopped, Track::System), on(&stopped, Track::Microphone));
        assert_eq!(times(&rest_system, "erstens"), 1);
        assert_eq!(times(&rest_microphone, "firstly"), 1);
        // What was said before the stretches' end is theirs, not the rest's.
        assert_eq!(times(&rest_system, call_said[0].1), 0);
        assert_eq!(times(&rest_microphone, REVIEWER[0].1), 0);
        for (_, word) in &call_said[1..] {
            assert_eq!(times(&rest_system, word), 1, "the call says {word} once");
            assert_eq!(times(&rest_microphone, word), 0, "{word} is echo");
        }
        assert_eq!(times(&rest_microphone, REVIEWER[1].1), 1);
        stretches::forget(&take);

        // While it records: the microphone's copy up to the end of the
        // call's first sentence holds only echo, so nothing is guessed and
        // nothing counts as speech; once the reviewer has answered, the
        // answer is guessed, without the call's words.
        let cancel = AtomicBool::new(false);
        let (snapshot, system_snapshot) = (live.join("snapshot.wav"), live.join("echo.wav"));
        // The copies are made as the capture makes them, from the start and
        // from a millisecond that falls between two samples of the 44.1 kHz
        // track, whose copy then reports the millisecond before.
        let hear = |from_ms: u64, until_ms: u64| {
            let own = copy_recorded(&take.join("mic.wav"), &snapshot, from_ms, until_ms);
            let reference = copy_recorded(
                &take.join("system.wav"),
                &system_snapshot,
                from_ms,
                until_ms,
            );
            assert_eq!(own.0, from_ms);
            assert_eq!(
                reference.0,
                from_ms - u64::from(!from_ms.is_multiple_of(10))
            );
            assert!(stretches::is_reference(own.0, &Ok(reference)));
            let (guess, audio) = live_guess(
                &root,
                &live,
                &snapshot,
                own.1 - own.0,
                None,
                Some(&system_snapshot),
                true,
                &cancel,
            )
            .unwrap();
            let audio = audio.unwrap();
            (
                guess.expect("a guess was asked for"),
                audio.regions.clone(),
                audio.silenced().len(),
            )
        };
        for from_ms in [0, 437] {
            let (guess, regions, silenced) = hear(from_ms, call_spans[0].1 + 400);
            assert!(
                guess.segments.is_empty() && regions.is_empty(),
                "from {from_ms} ms echo was guessed: {:?} {regions:?}",
                guess.segments
            );
            assert!(silenced > 0, "from {from_ms} ms nothing was silenced");
            let (guess, regions, silenced) = hear(from_ms, reviewer_spans[0].1 + 400);
            eprintln!(
                "live guess from {from_ms} ms: {:?}",
                guess
                    .segments
                    .iter()
                    .map(|row| &row.text)
                    .collect::<Vec<_>>()
            );
            assert_eq!(regions.len(), 1, "{regions:?}");
            assert!(from_ms + regions[0].0 + 1_000 > reviewer_spans[0].0);
            assert!(silenced > 0);
            assert_eq!(times(&guess, REVIEWER[0].1), 1);
            assert_eq!(times(&guess, call_said[0].1), 0);
        }
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
            track: None,
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
                    track_languages: None,
                },
                TakeMark {
                    index: 2,
                    start_ms: offset,
                    language: Some("en".into()),
                    language_detected: true,
                    track_languages: None,
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
    #[test]
    #[ignore = "Requires the Vulkan build and jfk.wav in the runtime folder, a graphics card faster than the processor, FFmpeg, and base, small.en, small and the detector in CUEREVIEW_DATA_DIR (large-v3-turbo optional)"]
    fn actual_graphics_card_transcribes_and_keeps_word_timing() {
        use crate::models::{DeviceKind, Settings};
        use std::time::Instant;
        assert!(
            std::env::var_os("CUEREVIEW_DATA_DIR").is_some(),
            "Point CUEREVIEW_DATA_DIR at an isolated data folder: the test writes its settings and speech-device.json"
        );
        let root = crate::store::data_root();
        let build = deps::card_build().expect("no vulkan/whisper-cli.exe beside the runtime");
        let sample = deps::locate("whisper-cli")
            .unwrap()
            .parent()
            .unwrap()
            .join("jfk.wav");
        let english = |more: Settings| {
            settings::save(
                &root,
                &Settings {
                    language: Some("en".into()),
                    ..more
                },
            )
            .unwrap()
        };
        english(Settings::default());

        // The first start: the devices are measured.
        let _ = fs::remove_file(root.join("speech-device.json"));
        let cancel = deps::claim_measuring(false).expect("a measurement is due");
        let began = Instant::now();
        deps::measure_devices(&cancel);
        let measuring = began.elapsed();
        let measured = deps::load_measured(&root).expect("the measurement was saved");
        eprintln!(
            "Measured in {measuring:?} with {} ({}): processor {} ms; {}",
            measured.model,
            build.display(),
            measured.processor_ms,
            measured
                .cards
                .iter()
                .map(|card| format!("{} {} = {:?} ms", card.index, card.name, card.ms))
                .collect::<Vec<_>>()
                .join("; ")
        );
        let card = measured
            .chosen
            .expect("no graphics card measured faster than the processor");
        let device = deps::speech_device_status();
        assert_eq!(device.kind, DeviceKind::GraphicsCard, "{device:?}");
        eprintln!("{device:?}");
        assert!(
            deps::claim_measuring(false).is_none(),
            "measured once, not again"
        );

        // A take of the sample, transcribed whole as after Stop.
        let duration = {
            let wav = hound::WavReader::open(&sample).unwrap();
            wav.duration() as u64 * 1000 / wav.spec().sample_rate as u64
        };
        let take = |name: &str| {
            let folder = tempfile::tempdir().unwrap();
            fs::copy(&sample, folder.path().join("mic.wav")).unwrap();
            let began = Instant::now();
            let transcript = transcribe_media(&root, folder.path(), duration, true).unwrap();
            let took = began.elapsed();
            let log = fs::read_to_string(folder.path().join("transcription.log")).unwrap();
            eprintln!(
                "{name}: {took:?}: {:?}",
                transcript
                    .segments
                    .iter()
                    .map(|s| &s.text)
                    .collect::<Vec<_>>()
            );
            (transcript, log, took)
        };
        let timing = |transcript: &Transcript| -> Vec<(String, u64)> {
            let words: Vec<_> = transcript.segments.iter().flat_map(|s| &s.words).collect();
            assert!(words.len() >= 15, "only {} words", words.len());
            let mut last = 0;
            for word in &words {
                let seek = word.seek_ms.expect("every word keeps its alignment point");
                assert!(word.start_ms <= word.end_ms && word.end_ms <= duration + 500);
                assert!(seek <= duration && seek + 100 >= last, "{words:?}");
                last = seek;
            }
            let phrase = crate::agent::find(transcript, "ask not what your country").unwrap();
            assert!(!phrase.is_empty(), "lost the phrase");
            words
                .iter()
                .map(|word| {
                    let text = word.text.to_lowercase();
                    let text = text.trim_matches(|c: char| !c.is_alphanumeric());
                    (text.to_owned(), word.seek_ms.unwrap())
                })
                .collect()
        };
        let (on_card, log, card_took) = take("small.en on the card");
        assert!(
            log.contains(&format!("using Vulkan{card} backend")),
            "{log}"
        );
        let card_words = timing(&on_card);

        // The switch keeps it on the processor: the same words, aligned
        // within a fifth of a second.
        english(Settings {
            graphics_card: Some(false),
            ..Default::default()
        });
        let (on_processor, log, processor_took) = take("small.en on the processor");
        assert!(!log.contains("using Vulkan"), "{log}");
        let processor_words = timing(&on_processor);
        let same = card_words
            .iter()
            .zip(&processor_words)
            .filter(|(a, b)| a.0 == b.0)
            .inspect(|(a, b)| assert!(a.1.abs_diff(b.1) <= 200, "{a:?} against {b:?}"))
            .count();
        assert!(
            same * 10 >= processor_words.len() * 9
                && card_words.len().abs_diff(processor_words.len()) <= 2,
            "{card_words:?} against {processor_words:?}"
        );
        eprintln!("card {card_took:?}, processor {processor_took:?}, {same} words alike");

        // Where the card is fast enough and the larger model is installed,
        // the measurement timed it on the card too, and, not slower than the
        // processor, it transcribes the take there.
        let large = root.join("models").join(deps::LARGE.file);
        let offered = deps::speech_device_status().large_offered;
        if offered && large.metadata().is_ok_and(|m| m.len() == deps::LARGE.size) {
            english(Settings {
                model: Some("large".into()),
                ..Default::default()
            });
            // Timed twice one after the other, then twice at the same time,
            // as the two tracks of a take run.
            let timed = deps::load_measured(&root).unwrap().large;
            assert!(timed.is_some(), "an installed larger model is timed");
            let device = deps::speech_device_status();
            eprintln!("large-v3-turbo on the card, alone and two at once: {timed:?}, {device:?}");
            assert_eq!(device.large_in_use, !device.large_slow, "{device:?}");
            if device.large_in_use {
                let (with_large, log, took) = take("large-v3-turbo on the card");
                assert!(log.contains(deps::LARGE.file), "{log}");
                assert!(
                    log.contains(&format!("using Vulkan{card} backend")),
                    "{log}"
                );
                timing(&with_large);
                eprintln!("large-v3-turbo took {took:?}");
            }
        } else {
            eprintln!("large-v3-turbo not installed or not offered: left out");
        }
        settings::save(&root, &Settings::default()).unwrap();
    }
}
