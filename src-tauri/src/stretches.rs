//! A take's speech transcribed in stretches while it is recorded.
//!
//! The live worker cuts the take's live audio at pauses into stretches of at
//! most 30 s, transcribes each finished stretch once with the language's
//! model and saves the words here, beside the take's audio. After Stop,
//! [`crate::transcribe::transcribe_media`] reuses them and transcribes only
//! the rest, so Stop no longer waits for the whole take. Saved stretches are
//! used only for the audio file, model and language they were made with;
//! Retry and `cue transcribe` forget them first.
use crate::{
    models::{Segment, Transcript},
    store::{atomic_write, read_json, Store},
    takes,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// A pause at least this long ends a stretch.
pub const MIN_PAUSE_MS: u64 = 600;
/// How far into a pause a stretch ends, so its last word keeps its tail.
const PAUSE_LEAD_MS: u64 = 300;
/// A stretch is never longer than one Whisper window.
pub const MAX_STRETCH_MS: u64 = 30_000;
/// Nor shorter than this when it has speech: Whisper needs the context.
pub const MIN_STRETCH_MS: u64 = 10_000;
/// A stretch is cut once this much audio waits, so Stop has at most about
/// 30 s left. Cutting at 20 s gave 8.6 % word errors on a review where a
/// whole-take pass gave 5.8 %; at 28 s, 6.6 %.
const SETTLE_MS: u64 = 28_000;
/// Without a pause, a stretch ends in the longest gap at least this long.
const SHORT_GAP_MS: u64 = 200;
/// What a stretch without speech leaves of its audio: the detector can miss
/// a word just starting at the very end of a copy.
const SILENCE_TAIL_MS: u64 = 1_000;
/// How often the live worker looks at the audio again.
pub const LIVE_CYCLE: std::time::Duration = std::time::Duration::from_millis(1000);

/// Where the next stretch of the pending audio ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cut {
    /// Milliseconds from the start of the pending audio.
    pub at_ms: u64,
    /// Whether the stretch holds speech; one without is skipped untranscribed.
    pub speech: bool,
}

/// The end of the next finished stretch of `pending_ms` of audio whose speech
/// regions (start, end in ms, ordered) are `regions`, or `None` while it
/// waits. Once 28 s wait, a stretch ends 300 ms into the last pause of at
/// least 600 ms between 10 and 30 s; past 30 s without one, in the middle of
/// the longest gap of at least 200 ms, else at 30 s. 28 s without speech
/// are skipped untranscribed, all but their last second.
pub fn cut(regions: &[(u64, u64)], pending_ms: u64) -> Option<Cut> {
    if pending_ms < SETTLE_MS {
        return None;
    }
    if regions.is_empty() {
        return Some(Cut {
            at_ms: pending_ms - SILENCE_TAIL_MS,
            speech: false,
        });
    }
    let paused = regions.iter().enumerate().rev().find_map(|(i, &(_, end))| {
        let next = regions.get(i + 1).map_or(pending_ms, |region| region.0);
        let at_ms = end + PAUSE_LEAD_MS;
        (next.saturating_sub(end) >= MIN_PAUSE_MS
            && (MIN_STRETCH_MS..=MAX_STRETCH_MS).contains(&at_ms))
        .then_some(at_ms)
    });
    if let Some(at_ms) = paused {
        return Some(Cut {
            at_ms,
            speech: true,
        });
    }
    if pending_ms < MAX_STRETCH_MS {
        return None;
    }
    let gap = regions
        .windows(2)
        .map(|pair| (pair[0].1, pair[1].0))
        .filter(|&(end, start)| start <= MAX_STRETCH_MS && start >= end + SHORT_GAP_MS)
        .max_by_key(|&(end, start)| start - end);
    Some(Cut {
        at_ms: gap.map_or(MAX_STRETCH_MS, |(end, start)| (end + start) / 2),
        speech: true,
    })
}

/// The words of a take's finished stretches, take-relative, and what they
/// were made from. Saved as `stretches/stretches.json` in the take folder.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stretches {
    pub version: u32,
    /// The live audio file the stretches were cut from, for example `mic.wav`.
    pub source: String,
    /// The model file that transcribed them, for example `ggml-small.en.bin`.
    pub model: String,
    /// `en` or `de`.
    pub language: String,
    /// Where the last finished stretch ends.
    pub until_ms: u64,
    pub segments: Vec<Segment>,
}

const VERSION: u32 = 1;

pub fn folder(take: &Path) -> PathBuf {
    take.join("stretches")
}
fn file(take: &Path) -> PathBuf {
    folder(take).join("stretches.json")
}

impl Stretches {
    pub fn new(source: &str, model: &str, language: &str) -> Self {
        Self {
            version: VERSION,
            source: source.into(),
            model: model.into(),
            language: language.into(),
            ..Default::default()
        }
    }
    /// Adds the words of the stretch from `until_ms` to `end_ms`, timed from
    /// its own start, and moves `until_ms` to `end_ms`.
    pub fn push(&mut self, stretch: Transcript, end_ms: u64) {
        let start = self.until_ms;
        let index = self.segments.len();
        self.segments
            .extend(shift(stretch, start, end_ms - start, "stretch", index));
        self.until_ms = end_ms;
    }
    /// The take's transcript: the stretches, then `rest`, the words after
    /// `until_ms` timed from there, `rest_ms` long.
    pub fn join(&self, rest: Transcript, rest_ms: u64) -> Transcript {
        let language = rest.language.clone();
        let mut segments = self.segments.clone();
        segments.extend(shift(
            rest,
            self.until_ms,
            rest_ms,
            "stretch",
            segments.len(),
        ));
        for (index, segment) in segments.iter_mut().enumerate() {
            segment.id = format!("segment-{index}");
        }
        Transcript {
            segments,
            language: language.or_else(|| Some(self.language.clone())),
            status: Some("complete".into()),
            error: None,
            takes: Vec::new(),
        }
    }
    /// The live transcript: the stretches, then the words still being heard
    /// (`guess`, timed from `until_ms`) as one segment whose id starts with
    /// `live-`, all moved by `offset_ms` onto the session timeline.
    pub fn live(&self, guess: Transcript, guess_ms: u64, offset_ms: u64) -> Transcript {
        let mut segments: Vec<Segment> = self
            .segments
            .iter()
            .cloned()
            .map(|segment| moved(segment, offset_ms))
            .collect();
        let words: Vec<_> = shift(guess, self.until_ms, guess_ms, "live", 0)
            .into_iter()
            .flat_map(|segment| segment.words)
            .collect();
        if let (Some(first), Some(last)) = (words.first(), words.last()) {
            segments.push(moved(
                Segment {
                    id: format!("live-{}", self.until_ms),
                    start_ms: first.start_ms,
                    end_ms: last.end_ms,
                    text: words
                        .iter()
                        .map(|word| word.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    words,
                },
                offset_ms,
            ));
        }
        Transcript {
            segments,
            status: Some("provisional".into()),
            ..Default::default()
        }
    }
}

/// The words of `transcript` that start at or after `from_ms`, timed from
/// there; a word cut in two by `from_ms` is left out.
pub fn after(transcript: Transcript, from_ms: u64) -> Transcript {
    let segments = transcript
        .segments
        .into_iter()
        .filter_map(|mut segment| {
            segment.words.retain(|word| word.start_ms >= from_ms);
            for word in &mut segment.words {
                word.start_ms -= from_ms;
                word.end_ms -= from_ms;
                word.seek_ms = word.seek_ms.and_then(|seek| seek.checked_sub(from_ms));
            }
            let (first, last) = (segment.words.first()?, segment.words.last()?);
            segment.start_ms = first.start_ms;
            segment.end_ms = last.end_ms;
            segment.text = segment
                .words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            Some(segment)
        })
        .collect();
    Transcript {
        segments,
        ..transcript
    }
}
/// `transcript`'s segments moved by `start_ms`, their words kept within
/// `length_ms`, with ids `<prefix>-<start_ms>-<n>`.
fn shift(
    transcript: Transcript,
    start_ms: u64,
    length_ms: u64,
    prefix: &str,
    first: usize,
) -> Vec<Segment> {
    transcript
        .segments
        .into_iter()
        .filter_map(|mut segment| {
            segment.words.retain(|word| word.start_ms < length_ms);
            for word in &mut segment.words {
                word.end_ms = word.end_ms.min(length_ms);
                word.seek_ms = word.seek_ms.filter(|seek| *seek < length_ms);
            }
            let (first_word, last_word) = (segment.words.first()?, segment.words.last()?);
            segment.start_ms = first_word.start_ms;
            segment.end_ms = last_word.end_ms;
            Some(moved(segment, start_ms))
        })
        .enumerate()
        .map(|(index, mut segment)| {
            segment.id = format!("{prefix}-{start_ms}-{}", first + index);
            segment
        })
        .collect()
}
fn moved(mut segment: Segment, by_ms: u64) -> Segment {
    segment.start_ms += by_ms;
    segment.end_ms += by_ms;
    for word in &mut segment.words {
        word.start_ms += by_ms;
        word.end_ms += by_ms;
        word.seek_ms = word.seek_ms.map(|seek| seek + by_ms);
    }
    segment
}

pub fn save(take: &Path, stretches: &Stretches) -> Result<(), String> {
    fs::create_dir_all(folder(take)).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(stretches).map_err(|e| e.to_string())?;
    atomic_write(&file(take), &bytes)
}
/// The take's saved stretches when they were cut from `source` and made by
/// `model` in `language`; `None` otherwise, or when there are none.
pub fn usable(take: &Path, source: &str, model: &str, language: &str) -> Option<Stretches> {
    let saved: Stretches = read_json(&file(take)).ok()?;
    (saved.version == VERSION
        && saved.source == source
        && saved.model == model
        && saved.language == language)
        .then_some(saved)
}
/// Forgets the take's stretches, so its next transcription covers the whole
/// take. Their raw Whisper output stays.
pub fn forget(take: &Path) {
    let _ = fs::remove_file(file(take));
}
/// Forgets the stretches of every take of session `id`, before Retry or
/// `cue transcribe` transcribe it again.
pub fn forget_session(store: &Store, id: &str) -> Result<(), String> {
    let session = store.session(id)?;
    let dir = store.session_dir(id)?;
    forget(&dir);
    for take in &session.takes {
        forget(&takes::take_dir(&dir, take.index));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Word;

    fn spoken(words: &[(&str, u64, u64)]) -> Transcript {
        Transcript {
            segments: vec![Segment {
                id: "segment-0".into(),
                start_ms: words.first().map_or(0, |w| w.1),
                end_ms: words.last().map_or(0, |w| w.2),
                text: words.iter().map(|w| w.0).collect::<Vec<_>>().join(" "),
                words: words
                    .iter()
                    .map(|&(text, start_ms, end_ms)| Word {
                        text: text.into(),
                        start_ms,
                        end_ms,
                        seek_ms: Some(start_ms + 10),
                    })
                    .collect(),
            }],
            status: Some("complete".into()),
            ..Default::default()
        }
    }
    fn texts(transcript: &Transcript) -> Vec<(String, u64)> {
        transcript
            .segments
            .iter()
            .flat_map(|s| &s.words)
            .map(|w| (w.text.clone(), w.start_ms))
            .collect()
    }

    #[test]
    fn cuts_at_pauses_and_never_past_thirty_seconds() {
        let speech = |at_ms| {
            Some(Cut {
                at_ms,
                speech: true,
            })
        };
        // Under 28 s nothing is cut, pause or not.
        assert_eq!(cut(&[(200, 4000)], 4700), None);
        assert_eq!(cut(&[(200, 12_000)], 27_000), None);
        // From 28 s on, the last pause of 600 ms between 10 and 30 s ends it.
        assert_eq!(
            cut(&[(200, 4000), (5000, 12_000), (12_800, 27_500)], 28_000),
            speech(12_300)
        );
        assert_eq!(
            cut(&[(200, 25_000), (25_700, 28_900)], 29_000),
            speech(25_300)
        );
        // A pause before 10 s is too early, and one past 30 s too late.
        assert_eq!(cut(&[(0, 4000), (4800, 29_000)], 29_100), None);
        assert_eq!(cut(&[(0, 29_900)], 31_000), speech(30_000));
        // Past 30 s without a pause: the middle of the longest short gap.
        assert_eq!(
            cut(&[(0, 10_000), (10_300, 20_000), (20_500, 32_000)], 32_100),
            speech(20_250)
        );
        // Gaps after 30 s do not count.
        assert_eq!(
            cut(&[(0, 30_100), (30_400, 33_000)], 33_100),
            speech(30_000)
        );
        // Silence alone is skipped once 28 s wait, all but its last second.
        assert_eq!(cut(&[], 5000), None);
        assert_eq!(
            cut(&[], 29_000),
            Some(Cut {
                at_ms: 28_000,
                speech: false
            })
        );
    }

    #[test]
    fn stretches_join_without_gaps_or_overlaps() {
        let mut stretches = Stretches::new("mic.wav", "ggml-small.en.bin", "en");
        stretches.push(spoken(&[("one", 100, 400), ("two", 500, 800)]), 1100);
        // A word the model placed past the cut is dropped, never doubled.
        stretches.push(spoken(&[("three", 50, 300), ("ghost", 3500, 3600)]), 4100);
        assert_eq!(stretches.until_ms, 4100);
        let joined = stretches.join(spoken(&[("four", 0, 200)]), 900);
        assert_eq!(
            texts(&joined),
            [
                ("one".to_string(), 100),
                ("two".to_string(), 500),
                ("three".to_string(), 1150),
                ("four".to_string(), 4100)
            ]
        );
        let words: Vec<_> = joined.segments.iter().flat_map(|s| &s.words).collect();
        assert!(words.windows(2).all(|w| w[0].end_ms <= w[1].start_ms));
        assert_eq!(words[2].seek_ms, Some(1160));
        assert_eq!(
            joined
                .segments
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            ["segment-0", "segment-1", "segment-2"]
        );
        // Live: the stretches, then the guess as one `live-` segment, on the session clock.
        let live = stretches.live(spoken(&[("fo", 0, 150), ("ur", 160, 300)]), 600, 60_000);
        let ids: Vec<_> = live.segments.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), 3);
        assert!(ids[..2].iter().all(|id| id.starts_with("stretch-")));
        assert_eq!(ids[2], "live-4100");
        assert_eq!(live.segments[2].text, "fo ur");
        assert_eq!(live.segments[2].start_ms, 64_100);
        assert_eq!(live.segments[0].start_ms, 60_100);
        assert_eq!(live.status.as_deref(), Some("provisional"));
        assert_eq!(
            stretches.live(Transcript::default(), 0, 0).segments.len(),
            2,
            "no guess, no live box"
        );
    }

    #[test]
    fn the_guess_after_a_finished_stretch_keeps_only_later_words() {
        let guess = spoken(&[("one", 100, 400), ("two", 900, 1300), ("three", 1600, 1900)]);
        let rest = after(guess, 1000);
        assert_eq!(texts(&rest), [("three".to_string(), 600)]);
        assert_eq!(rest.segments[0].text, "three");
        assert!(after(spoken(&[("one", 100, 400)]), 1000)
            .segments
            .is_empty());
    }

    #[test]
    fn saved_stretches_are_used_only_when_they_match() {
        let take = tempfile::tempdir().unwrap();
        assert!(usable(take.path(), "mic.wav", "ggml-small.en.bin", "en").is_none());
        let mut stretches = Stretches::new("mic.wav", "ggml-small.en.bin", "en");
        stretches.push(spoken(&[("one", 100, 400)]), 1000);
        save(take.path(), &stretches).unwrap();
        assert_eq!(
            usable(take.path(), "mic.wav", "ggml-small.en.bin", "en")
                .map(|saved| (saved.until_ms, saved.segments.len())),
            Some((1000, 1))
        );
        for (source, model, language) in [
            ("audio.wav", "ggml-small.en.bin", "en"),
            ("mic.wav", "ggml-base.bin", "en"),
            ("mic.wav", "ggml-small.en.bin", "de"),
        ] {
            assert!(usable(take.path(), source, model, language).is_none());
        }
        // Retry forgets them; the raw output in the folder stays.
        fs::write(folder(take.path()).join("0.json"), b"{}").unwrap();
        forget(take.path());
        assert!(usable(take.path(), "mic.wav", "ggml-small.en.bin", "en").is_none());
        assert!(folder(take.path()).join("0.json").is_file());
        // A damaged file is not used.
        fs::write(file(take.path()), b"{broken").unwrap();
        assert!(usable(take.path(), "mic.wav", "ggml-small.en.bin", "en").is_none());
    }

    /// What a real-time replay of a recorded take through the live worker
    /// measured: when each word first showed live, how long Stop took, and
    /// the words of the one-pass and of a whole-take transcript.
    struct Replay {
        /// Seconds from a word's end in the audio to its first live showing.
        delays: Vec<f64>,
        stop: std::time::Duration,
        one_pass: Vec<String>,
        whole: Vec<String>,
        /// The words actually said, from `reference.txt` beside the take.
        reference: Vec<String>,
    }

    fn normalized(transcript: &Transcript) -> Vec<String> {
        transcript
            .segments
            .iter()
            .flat_map(|s| &s.words)
            .map(|w| {
                w.text
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '\'')
                    .collect::<String>()
            })
            .filter(|w| !w.is_empty())
            .collect()
    }

    fn word_errors(reference: &[String], hypothesis: &[String]) -> f64 {
        let mut row: Vec<usize> = (0..=hypothesis.len()).collect();
        for (i, r) in reference.iter().enumerate() {
            let mut previous = row[0];
            row[0] = i + 1;
            for (j, h) in hypothesis.iter().enumerate() {
                let next = (row[j + 1] + 1)
                    .min(row[j] + 1)
                    .min(previous + usize::from(r != h));
                previous = row[j + 1];
                row[j + 1] = next;
            }
        }
        row[hypothesis.len()] as f64 / reference.len().max(1) as f64
    }

    /// Feeds `test-results/replay/mic.wav` (a recorded take) through
    /// [`crate::transcribe::live_cycle`] at real speed, as the live worker
    /// does, then transcribes the take as Stop does, and once more whole.
    fn replay() -> &'static Replay {
        static REPLAY: std::sync::OnceLock<Replay> = std::sync::OnceLock::new();
        REPLAY.get_or_init(|| {
            use std::time::{Duration, Instant};
            let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-results/replay");
            let mic = fixtures.join("mic.wav");
            let mut reader = hound::WavReader::open(&mic).expect("test-results/replay/mic.wav");
            let spec = reader.spec();
            let samples: Vec<f32> = reader.samples::<f32>().map(Result::unwrap).collect();
            let rate = spec.sample_rate as u64;
            let length_ms = samples.len() as u64 * 1000 / rate;
            let root = tempfile::tempdir().unwrap();
            let take = root.path().join("take");
            let live = take.join("live");
            fs::create_dir_all(&live).unwrap();
            let model = crate::deps::final_model("en");
            let model_file = model.path.file_name().unwrap().to_string_lossy().into_owned();
            let mut stretches = Stretches::new("mic.wav", &model_file, "en");
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let snapshot = live.join("snapshot.wav");
            // When the shown words first reached each point of the audio.
            let covered: std::cell::RefCell<Vec<(u64, f64)>> = Default::default();
            let seen = |shown: &Transcript, at: f64| {
                let end = shown
                    .segments
                    .iter()
                    .flat_map(|s| &s.words)
                    .map(|w| w.end_ms)
                    .max()
                    .unwrap_or(0);
                covered.borrow_mut().push((end, at));
            };
            let started = Instant::now();
            loop {
                let now_ms = (started.elapsed().as_millis() as u64).min(length_ms);
                let from = stretches.until_ms;
                let mut writer = hound::WavWriter::create(&snapshot, spec).unwrap();
                let (a, b) = ((from * rate / 1000) as usize, (now_ms * rate / 1000) as usize);
                for sample in &samples[a.min(b)..b] {
                    writer.write_sample(*sample).unwrap();
                }
                writer.finalize().unwrap();
                let length = now_ms - from;
                let (guess, audio) =
                    crate::transcribe::live_guess(root.path(), &live, &snapshot, length, &cancel)
                        .unwrap();
                seen(&stretches.live(guess.clone(), length, 0), started.elapsed().as_secs_f64());
                let before = stretches.until_ms;
                let (guess, guess_ms) = match audio {
                    Some(audio) => crate::transcribe::live_commit(
                        root.path(),
                        &take,
                        &live,
                        &model,
                        &mut stretches,
                        &audio,
                        guess,
                        &cancel,
                    )
                    .unwrap(),
                    None => (guess, length),
                };
                if stretches.until_ms != before {
                    eprintln!("cut {before} {}", stretches.until_ms);
                }
                seen(&stretches.live(guess, guess_ms, 0), started.elapsed().as_secs_f64());
                if now_ms >= length_ms {
                    break;
                }
                let next = LIVE_CYCLE;
                let spent = started.elapsed() - Duration::from_millis(now_ms);
                if spent < next {
                    std::thread::sleep(next - spent.min(next));
                }
            }
            for segment in &stretches.segments {
                eprintln!("stretch {:>6} {}", segment.start_ms, segment.text);
            }
            fs::copy(&mic, take.join("mic.wav")).unwrap();
            let stopped = Instant::now();
            let one_pass =
                crate::transcribe::transcribe_media(root.path(), &take, length_ms, true).unwrap();
            let stop = stopped.elapsed();
            forget(&take);
            let whole =
                crate::transcribe::transcribe_media(root.path(), &take, length_ms, true).unwrap();
            // For each word of the transcript, from its end to the first update
            // whose words reached it.
            let covered = covered.into_inner();
            let mut delays: Vec<f64> = one_pass
                .segments
                .iter()
                .flat_map(|s| &s.words)
                .filter_map(|word| {
                    covered
                        .iter()
                        .find(|(end, _)| *end >= word.end_ms)
                        .map(|(_, at)| at - word.end_ms as f64 / 1000.)
                })
                .collect();
            delays.sort_by(f64::total_cmp);
            let reference = fs::read_to_string(fixtures.join("reference.txt"))
                .expect("test-results/replay/reference.txt")
                .split_whitespace()
                .map(|w| {
                    w.to_lowercase()
                        .chars()
                        .filter(|c| c.is_alphanumeric() || *c == '\'')
                        .collect::<String>()
                })
                .filter(|w| !w.is_empty())
                .collect();
            let replay = Replay {
                delays,
                stop,
                one_pass: normalized(&one_pass),
                whole: normalized(&whole),
                reference,
            };
            eprintln!(
                "replay of {} s: {} stretches; live delay median {:.1} s, 90th {:.1} s; Stop {:?}; word errors one-pass {:.1} %, whole {:.1} %",
                length_ms / 1000,
                stretches.segments.len(),
                replay.delays[replay.delays.len() / 2],
                replay.delays[replay.delays.len() * 9 / 10],
                replay.stop,
                100. * word_errors(&replay.reference, &replay.one_pass),
                100. * word_errors(&replay.reference, &replay.whole)
            );
            eprintln!("one-pass: {}", replay.one_pass.join(" "));
            eprintln!("whole:    {}", replay.whole.join(" "));
            replay
        })
    }

    #[test]
    #[ignore = "Requires Whisper, small.en, base, the speech detector, test-results/replay/mic.wav and its reference.txt; runs in real time"]
    fn actual_replay_shows_words_within_seconds() {
        let replay = replay();
        let median = replay.delays[replay.delays.len() / 2];
        assert!(
            median <= 3.0,
            "live words showed {median:.1} s after they were said"
        );
    }

    #[test]
    #[ignore = "Requires Whisper, small.en, base, the speech detector, test-results/replay/mic.wav and its reference.txt; runs in real time"]
    fn actual_replay_finishes_within_seconds_of_stop() {
        let stop = replay().stop;
        assert!(stop.as_secs_f64() < 5.0, "Stop took {stop:?}");
    }

    #[test]
    #[ignore = "Requires Whisper, small.en, base, the speech detector, test-results/replay/mic.wav and its reference.txt; runs in real time"]
    fn actual_replay_matches_a_whole_take_pass() {
        let replay = replay();
        let one_pass = word_errors(&replay.reference, &replay.one_pass);
        let whole = word_errors(&replay.reference, &replay.whole);
        assert!(
            one_pass <= whole + 0.02,
            "one-pass misses {:.1} % of words, a whole-take pass {:.1} %",
            100. * one_pass,
            100. * whole
        );
        // No stretch boundary doubles words: no run of four words repeats back to back.
        let doubled = replay.one_pass.windows(8).any(|w| w[..4] == w[4..]);
        assert!(!doubled, "a run of words is doubled");
    }
}
