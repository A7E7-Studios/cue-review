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
    store::{atomic_write, read_json},
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
/// Without a pause, a stretch ends in the longest gap at least this long.
const SHORT_GAP_MS: u64 = 200;
/// Pending audio without any speech is skipped once it is this long.
const SILENCE_MS: u64 = 2_000;

/// Where the next stretch of the pending audio ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cut {
    /// Milliseconds from the start of the pending audio.
    pub at_ms: u64,
    /// Whether the stretch holds speech; one without is skipped untranscribed.
    pub speech: bool,
}

/// The end of the next finished stretch of `pending_ms` of audio whose speech
/// regions (start, end in ms, ordered) are `regions`, or `None` while the
/// speech goes on. A stretch ends 300 ms into the last pause of at least
/// 600 ms within its first 30 s; past 30 s without one, in the middle of the
/// longest gap of at least 200 ms, else at 30 s.
pub fn cut(regions: &[(u64, u64)], pending_ms: u64) -> Option<Cut> {
    if regions.is_empty() {
        return (pending_ms >= SILENCE_MS).then_some(Cut {
            at_ms: pending_ms - PAUSE_LEAD_MS,
            speech: false,
        });
    }
    let paused = regions
        .iter()
        .enumerate()
        .filter_map(|(i, &(_, end))| {
            let next = regions.get(i + 1).map_or(pending_ms, |region| region.0);
            let at_ms = end + PAUSE_LEAD_MS;
            (next.saturating_sub(end) >= MIN_PAUSE_MS && at_ms <= MAX_STRETCH_MS).then_some(at_ms)
        })
        .last();
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
        // Still talking: no pause of 600 ms yet.
        assert_eq!(cut(&[(200, 4000)], 4400), None);
        assert_eq!(cut(&[(200, 4000), (4300, 6000)], 6300), None);
        // The last pause of 600 ms ends the stretch 300 ms into it.
        assert_eq!(cut(&[(200, 4000)], 4700), speech(4300));
        assert_eq!(
            cut(&[(200, 4000), (5000, 9000), (9800, 12000)], 12200),
            speech(9300)
        );
        // A pause that would make the stretch longer than 30 s is not taken.
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
        // Silence alone is skipped once it is 2 s long, untranscribed.
        assert_eq!(cut(&[], 1500), None);
        assert_eq!(
            cut(&[], 2500),
            Some(Cut {
                at_ms: 2200,
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
}
