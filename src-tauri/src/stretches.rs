//! A take's speech transcribed in stretches while it is recorded.
//!
//! The live worker cuts the take's live audio at pauses into stretches of at
//! most 30 s, transcribes each finished stretch once with the language's
//! model and saves the words here, beside the take's audio. After Stop,
//! [`crate::transcribe::transcribe_media`] reuses them and transcribes only
//! the rest, so Stop no longer waits for the whole take. Saved stretches are
//! used only for the audio file, the language choice and the models they
//! were made with; Retry and `cue transcribe` forget them first.
//!
//! Under Auto the take's language is decided here. Each stretch's language
//! is detected until one guess is confident ([`CONFIDENT`]); that language
//! then holds for the rest of the take. Stretches before the decision are
//! transcribed in their own guess and kept as provisional; those made in
//! another language than the decided one are transcribed again
//! ([`Stretches::to_redo`], [`Stretches::replace`]): while the take records
//! by [`Redo`], else by Stop. A take that stops undecided takes the likeliest
//! language heard ([`Stretches::settle`]).
//!
//! A take with a microphone and system audio has stretches of each track,
//! saved in a file of their own, with a language of their own. The live
//! worker serves the system track first and then the microphone in every
//! cycle ([`turns`]), and shows both as one live transcript
//! ([`live_of_tracks`]).
use crate::{
    models::{Segment, Track, TrackLanguages, Transcript},
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
    // The silence before the first region counts too.
    let gap = std::iter::once((0, regions[0].0))
        .chain(regions.windows(2).map(|pair| (pair[0].1, pair[1].0)))
        .filter(|&(end, start)| start <= MAX_STRETCH_MS && start >= end + SHORT_GAP_MS)
        .max_by_key(|&(end, start)| start - end);
    Some(match gap {
        // Cut in the silence before the first word: that part holds no speech.
        Some((0, start)) => Cut {
            at_ms: start / 2,
            speech: false,
        },
        Some((end, start)) => Cut {
            at_ms: (end + start) / 2,
            speech: true,
        },
        // Speech only when some region starts before the cut.
        None => Cut {
            at_ms: MAX_STRETCH_MS,
            speech: regions[0].0 < MAX_STRETCH_MS,
        },
    })
}

/// A guess decides a take's language at this probability or above. Measured
/// on every stretch of a German recording as if a take started there: 0 of
/// 436 wrong on the microphone at 0.9, 2.3 % wrong at 0.8.
pub const CONFIDENT: f32 = 0.9;
/// What a take is transcribed in when detection gave no guess at all.
pub const FALLBACK_LANGUAGE: &str = "en";

/// What detection heard in some speech: its top language and how sure it is.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guess {
    /// A code of the speech model, for example `de`.
    pub language: String,
    /// The probability of that language, 0 to 1.
    pub p: f32,
}

/// The language of the first guess that is confident, which decides a take.
pub fn decided(guesses: &[Guess]) -> Option<&str> {
    guesses
        .iter()
        .find(|guess| guess.p >= CONFIDENT)
        .map(|guess| guess.language.as_str())
}
/// The language with the largest summed probability over `guesses`, for a
/// take no guess decided; of equals, the one heard first.
pub fn likeliest(guesses: &[Guess]) -> Option<&str> {
    let mut sums: Vec<(&str, f32)> = Vec::new();
    for guess in guesses {
        match sums
            .iter_mut()
            .find(|(language, _)| *language == guess.language)
        {
            Some((_, sum)) => *sum += guess.p,
            None => sums.push((guess.language.as_str(), guess.p)),
        }
    }
    let mut best: Option<(&str, f32)> = None;
    for (language, sum) in sums {
        if best.is_none_or(|(_, most)| sum > most) {
            best = Some((language, sum));
        }
    }
    best.map(|(language, _)| language)
}

/// One finished stretch with speech: where it lies in the take and what its
/// words were made with.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub start_ms: u64,
    pub end_ms: u64,
    /// The language its words were transcribed in.
    pub language: String,
    /// The model file that transcribed them, for example `ggml-small.bin`.
    pub model: String,
    /// What detection heard in it, under Auto before the take was decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guess: Option<Guess>,
    /// Made before the take's language was decided, in its own guess. Once
    /// the take is decided, only stretches in another language keep this,
    /// until they are transcribed again.
    #[serde(default, skip_serializing_if = "is_false")]
    pub provisional: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}

/// The words of a take's finished stretches, take-relative, and what they
/// were made from. Saved in the take folder as `stretches/stretches.json`,
/// or for a take with two tracks as `stretches/system.json` and
/// `stretches/microphone.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stretches {
    pub version: u32,
    /// The live audio file the stretches were cut from, for example `mic.wav`.
    pub source: String,
    /// Which of the take's two tracks they are of; `None` for a take with
    /// one track.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<Track>,
    /// The language the take is held to: the one chosen in Settings, or the
    /// one detection decided. `None` while Auto has not decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Whether detection decided `language`; false when it was chosen.
    #[serde(default, skip_serializing_if = "is_false")]
    pub language_detected: bool,
    /// Where the last finished stretch ends.
    pub until_ms: u64,
    pub segments: Vec<Segment>,
    /// The finished stretches with speech, in order.
    #[serde(default)]
    pub parts: Vec<Part>,
}

/// Version 1 held a take to one language and one model, named at the top
/// level; it is not reused.
const VERSION: u32 = 2;

pub fn folder(take: &Path) -> PathBuf {
    take.join("stretches")
}
/// Every way the stretches of one take are saved: one track alone, or
/// either of two.
const SAVED_AS: [Option<Track>; 3] = [None, Some(Track::System), Some(Track::Microphone)];
fn file(take: &Path, track: Option<Track>) -> PathBuf {
    folder(take).join(match track {
        Some(track) => format!("{}.json", track.name()),
        None => "stretches.json".into(),
    })
}
/// Where the raw Whisper output of the stretch starting at `start_ms` is
/// kept: `<start>.json`, or `<track>-<start>.json` in a take with two tracks.
pub fn raw(take: &Path, track: Option<Track>, start_ms: u64) -> PathBuf {
    folder(take).join(match track {
        Some(track) => format!("{}-{start_ms}.json", track.name()),
        None => format!("{start_ms}.json"),
    })
}

impl Stretches {
    /// The stretches of a take cut from `source`, held to `chosen`, the
    /// language chosen in Settings, or undecided under Auto (`None`).
    pub fn new(source: &str, chosen: Option<&str>) -> Self {
        Self {
            version: VERSION,
            source: source.into(),
            language: chosen.map(str::to_owned),
            ..Default::default()
        }
    }
    /// The stretches of one track of a take with two tracks.
    pub fn of_track(track: Track, chosen: Option<&str>) -> Self {
        Self {
            track: Some(track),
            ..Self::new(track.file(), chosen)
        }
    }
    /// The track whose audio the stretches are cut from.
    pub fn audio(&self) -> Track {
        self.track
            .unwrap_or(if self.source == Track::System.file() {
                Track::System
            } else {
                Track::Microphone
            })
    }
    /// What the ids of this take's stretch and live segments start with, so
    /// the two tracks of a take never share one.
    fn id(&self, kind: &str) -> String {
        match self.track {
            Some(track) => format!("{kind}-{}", track.name()),
            None => kind.into(),
        }
    }
    /// `segments` marked with the track they were heard on.
    fn tracked(&self, mut segments: Vec<Segment>) -> Vec<Segment> {
        for segment in &mut segments {
            segment.track = self.track;
        }
        segments
    }
    /// Whether the next stretch's language still has to be detected: only
    /// under Auto, until a guess has decided the take.
    pub fn detects(&self) -> bool {
        self.language.is_none()
    }
    /// The language to transcribe the next stretch in, given what detection
    /// heard in it: the take's once it is held to one, whatever the stretch
    /// sounds like; before that the stretch's own guess, or without one the
    /// likeliest language heard so far.
    pub fn language_for(&self, guess: Option<&Guess>) -> String {
        match (&self.language, guess) {
            (Some(language), _) => language.clone(),
            (None, Some(guess)) => guess.language.clone(),
            (None, None) => self.likeliest().unwrap_or_else(|| FALLBACK_LANGUAGE.into()),
        }
    }
    fn guesses(&self) -> Vec<Guess> {
        self.parts
            .iter()
            .filter_map(|part| part.guess.clone())
            .collect()
    }
    /// The likeliest language over the guesses of the stretches so far.
    fn likeliest(&self) -> Option<String> {
        likeliest(&self.guesses()).map(str::to_owned)
    }
    /// Adds the stretch without speech from `until_ms` to `end_ms`.
    pub fn skip(&mut self, end_ms: u64) {
        self.until_ms = end_ms;
    }
    /// Adds the words of the stretch from `until_ms` to `end_ms`, timed from
    /// its own start, and moves `until_ms` to `end_ms`. `language` and
    /// `model` made the words; `guess` is what detection heard in the
    /// stretch, and decides the take when it is confident. Returns whether
    /// this stretch decided the take and left earlier stretches in another
    /// language, which are then transcribed again before newer ones.
    pub fn push(
        &mut self,
        stretch: Transcript,
        end_ms: u64,
        language: &str,
        model: &str,
        guess: Option<Guess>,
    ) -> bool {
        let start = self.until_ms;
        let index = self.segments.len();
        let fresh = shift(stretch, start, end_ms - start, &self.id("stretch"), index);
        self.segments.extend(self.tracked(fresh));
        self.until_ms = end_ms;
        let undecided = self.language.is_none();
        let confident = guess
            .as_ref()
            .filter(|guess| undecided && guess.p >= CONFIDENT)
            .map(|guess| guess.language.clone());
        self.parts.push(Part {
            start_ms: start,
            end_ms,
            language: language.into(),
            model: model.into(),
            guess: guess.filter(|_| undecided),
            provisional: undecided,
        });
        match confident {
            Some(language) => {
                self.hold(language);
                !self.to_redo().is_empty()
            }
            None => false,
        }
    }
    /// Holds the take to the detected `language`: stretches already in it
    /// are final, the others wait to be transcribed again.
    fn hold(&mut self, language: String) {
        for part in &mut self.parts {
            part.provisional = part.language != language;
        }
        self.language = Some(language);
        self.language_detected = true;
    }
    /// Settles an undecided take when it stops: it takes the language with
    /// the largest summed probability over its stretches' guesses, or the
    /// language of its first stretch when nothing was guessed. Returns the
    /// take's language; `None` when it has no stretch with speech.
    pub fn settle(&mut self) -> Option<String> {
        if self.language.is_none() {
            let language = self
                .likeliest()
                .or_else(|| self.parts.first().map(|part| part.language.clone()))?;
            self.hold(language);
        }
        self.language.clone()
    }
    /// The stretches to transcribe again: those made before the decision in
    /// another language than the take's. None while the take is undecided.
    pub fn to_redo(&self) -> Vec<Part> {
        match &self.language {
            Some(language) => self
                .parts
                .iter()
                .filter(|part| part.language != *language)
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }
    /// Replaces the words of the stretch starting at `start_ms` with
    /// `stretch`, timed from the stretch's start and made in `language` with
    /// `model`.
    pub fn replace(&mut self, start_ms: u64, stretch: Transcript, language: &str, model: &str) {
        let Some(part) = self.parts.iter_mut().find(|part| part.start_ms == start_ms) else {
            return;
        };
        part.language = language.into();
        part.model = model.into();
        part.provisional = false;
        let (start, end) = (part.start_ms, part.end_ms);
        // A stretch's segments start inside it: `shift` keeps only such words.
        self.segments
            .retain(|segment| !(start..end).contains(&segment.start_ms));
        let at = self
            .segments
            .partition_point(|segment| segment.start_ms < start);
        let fresh = self.tracked(shift(stretch, start, end - start, &self.id("stretch"), 0));
        self.segments.splice(at..at, fresh);
    }
    /// The take's transcript: the stretches, then `rest`, the words after
    /// `until_ms` timed from there, `rest_ms` long.
    pub fn join(&self, rest: Transcript, rest_ms: u64) -> Transcript {
        let language = rest.language.clone();
        let mut segments = self.segments.clone();
        let rest = shift(rest, self.until_ms, rest_ms, "stretch", segments.len());
        segments.extend(self.tracked(rest));
        for (index, segment) in segments.iter_mut().enumerate() {
            segment.id = format!("segment-{index}");
        }
        Transcript {
            segments,
            language: self.language.clone().or(language),
            language_detected: self.language_detected,
            status: Some("complete".into()),
            ..Default::default()
        }
    }
    /// The live transcript: the stretches, then the words still being heard
    /// (`guess`, timed from `until_ms`) as one segment whose id starts with
    /// `live-`, all moved by `offset_ms` onto the session timeline. It names
    /// the take's language once the take is held to one. The stretches of
    /// one track of two give that track's rows, for [`live_of_tracks`].
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
                    id: format!("{}-{}", self.id("live"), self.until_ms),
                    start_ms: first.start_ms,
                    end_ms: last.end_ms,
                    text: words
                        .iter()
                        .map(|word| word.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                    words,
                    track: self.track,
                },
                offset_ms,
            ));
        }
        Transcript {
            segments,
            language: self.language.clone(),
            language_detected: self.language_detected,
            status: Some("provisional".into()),
            ..Default::default()
        }
    }
}

/// What became of one attempt to transcribe again, while the take records,
/// the stretches made in another language before the take was decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Redone {
    /// No stretch waits to be transcribed again.
    Done,
    /// The take's audio could not be copied just now, for example because
    /// its writer was busy: the next update tries again.
    Later(String),
    /// A stretch could not be transcribed: what is left waits for Stop.
    LeftToStop(String),
}
/// Transcribing provisional stretches again across the updates of one take.
#[derive(Debug, Default)]
pub struct Redo {
    /// Set once a transcription failed: Stop does the rest.
    left_to_stop: bool,
}
impl Redo {
    /// Whether stretches of `stretches` wait to be transcribed again while
    /// the take records.
    pub fn pending(&self, stretches: &Stretches) -> bool {
        !self.left_to_stop && !stretches.to_redo().is_empty()
    }
    /// Transcribes again each waiting stretch, oldest first: `copy` copies
    /// the take's audio from that stretch's start, then `again` transcribes
    /// the copy in the take's language and replaces the stretch's words
    /// ([`Stretches::replace`]). A copy that fails ends this attempt and the
    /// next one starts at the same stretch; a transcription that fails
    /// leaves that stretch and those after it to Stop for the rest of the
    /// take.
    pub fn run(
        &mut self,
        stretches: &mut Stretches,
        copy: &mut dyn FnMut(&Part) -> Result<(), String>,
        again: &mut dyn FnMut(&Part, &str, &mut Stretches) -> Result<(), String>,
    ) -> Redone {
        if !self.pending(stretches) {
            return Redone::Done;
        }
        let Some(language) = stretches.language.clone() else {
            return Redone::Done;
        };
        for part in stretches.to_redo() {
            if let Err(error) = copy(&part) {
                return Redone::Later(error);
            }
            if let Err(error) = again(&part, &language, stretches) {
                self.left_to_stop = true;
                return Redone::LeftToStop(error);
            }
        }
        Redone::Done
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

/// One track's turn in a cycle of the live worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Turn {
    pub track: Track,
    /// Whether the words still being heard on the track are guessed in this
    /// turn; its finished stretches are transcribed in every turn.
    pub guess: bool,
}
/// The turns of the live worker's `cycle` (counted from 0) for a take
/// recording `tracks`. With two tracks the system track comes first, and
/// its words still being heard are guessed only every second cycle, so the
/// microphone's, guessed every cycle, show within the time one track takes.
pub fn turns(tracks: &[Track], cycle: u64) -> Vec<Turn> {
    let has = |track| tracks.contains(&track);
    if has(Track::System) && has(Track::Microphone) {
        return vec![
            Turn {
                track: Track::System,
                guess: cycle.is_multiple_of(2),
            },
            Turn {
                track: Track::Microphone,
                guess: true,
            },
        ];
    }
    tracks
        .first()
        .map(|&track| Turn { track, guess: true })
        .into_iter()
        .collect()
}
/// The rows of two tracks in the order they were spoken: by the time the
/// app shows for a row, its first word's alignment point when it has one
/// and its start otherwise, the system row first where two share it.
/// Whisper starts a segment where the one before it ended, which after a
/// silence, or the silenced echo of the other track, is long before its
/// words; the alignment point is where they are.
pub fn by_time(system: Vec<Segment>, microphone: Vec<Segment>) -> Vec<Segment> {
    let mut rows = system;
    rows.extend(microphone);
    // Stable, so each track keeps its own order and the system rows lead.
    rows.sort_by_key(crate::agent::segment_seek_ms);
    rows
}
/// The live transcript of a take with two tracks, from each track's own
/// ([`Stretches::live`]): the finished rows of both in the order they were
/// spoken, then at most one segment of words still being heard per track.
/// `trackLanguages` holds what is decided so far, and `language` is the
/// microphone's, or the system's while the microphone has none.
pub fn live_of_tracks(system: Transcript, microphone: Transcript) -> Transcript {
    let language = |live: &Transcript| Some((live.language.clone()?, live.language_detected));
    let track_languages = TrackLanguages::of(language(&microphone), language(&system));
    let first = track_languages
        .as_ref()
        .and_then(|languages| languages.first());
    let heard = |segment: &Segment| segment.id.starts_with("live-");
    let (system_heard, system_rows): (Vec<_>, Vec<_>) =
        system.segments.into_iter().partition(heard);
    let (microphone_heard, microphone_rows): (Vec<_>, Vec<_>) =
        microphone.segments.into_iter().partition(heard);
    let mut segments = by_time(system_rows, microphone_rows);
    segments.extend(by_time(system_heard, microphone_heard));
    Transcript {
        segments,
        language: first.map(|first| first.language.clone()),
        language_detected: first.is_some_and(|first| first.language_detected),
        track_languages,
        status: Some("provisional".into()),
        ..Default::default()
    }
}

/// Saves the stretches in the file of their track.
pub fn save(take: &Path, stretches: &Stretches) -> Result<(), String> {
    fs::create_dir_all(folder(take)).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(stretches).map_err(|e| e.to_string())?;
    atomic_write(&file(take, stretches.track), &bytes)
}
/// The take's saved stretches for Stop, settled on the take's language,
/// when they can be reused: those of `track` (`None` for a take with one
/// track), cut from `source`, made under the language choice that holds now
/// (`chosen`, `None` for Auto), and every stretch in the take's language
/// made by the model that language uses now (`model_of` gives its file
/// name). `None` otherwise, or when there are none. Stretches in another
/// language are still to be transcribed again ([`Stretches::to_redo`]).
pub fn usable(
    take: &Path,
    track: Option<Track>,
    source: &str,
    chosen: Option<&str>,
    model_of: &dyn Fn(&str) -> String,
) -> Option<Stretches> {
    let mut saved: Stretches = read_json(&file(take, track)).ok()?;
    if saved.version != VERSION || saved.source != source || saved.track != track {
        return None;
    }
    let same_choice = match chosen {
        Some(language) => saved.language.as_deref() == Some(language) && !saved.language_detected,
        None => saved.language.is_none() || saved.language_detected,
    };
    if !same_choice {
        return None;
    }
    if let Some(language) = saved.settle() {
        let model = model_of(&language);
        let stale = |part: &Part| part.language == language && part.model != model;
        if saved.parts.iter().any(stale) {
            return None;
        }
    }
    Some(saved)
}
/// The language the take's saved stretches of `track` (`None` for a take
/// with one track) hold it to, and whether detection decided it, for the
/// pass that refines them.
pub fn language(take: &Path, track: Option<Track>) -> Option<(String, bool)> {
    let saved: Stretches = read_json(&file(take, track)).ok()?;
    if saved.version != VERSION {
        return None;
    }
    saved
        .language
        .map(|language| (language, saved.language_detected))
}
/// Whether the take has stretches saved, of either track or of its one.
pub fn any_saved(take: &Path) -> bool {
    SAVED_AS.iter().any(|&track| file(take, track).is_file())
}
/// Forgets the take's stretches of `track`.
pub fn forget_track(take: &Path, track: Option<Track>) {
    let _ = fs::remove_file(file(take, track));
}
/// Forgets the take's stretches, of every track, so its next transcription
/// covers the whole take. Their raw Whisper output stays.
pub fn forget(take: &Path) {
    for track in SAVED_AS {
        forget_track(take, track);
    }
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
                track: None,
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
        // Silence before continuous speech: cut in that silence, not mid-word.
        assert_eq!(
            cut(&[(20_000, 33_000)], 33_100),
            Some(Cut {
                at_ms: 10_000,
                speech: false
            })
        );
        // Silence all the way past 30 s is skipped, not sent to Whisper.
        assert_eq!(
            cut(&[(31_000, 59_000)], 60_000),
            Some(Cut {
                at_ms: 30_000,
                speech: false
            })
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

    const SMALL_EN: &str = "ggml-small.en.bin";
    const SMALL: &str = "ggml-small.bin";
    fn guess(language: &str, p: f32) -> Guess {
        Guess {
            language: language.into(),
            p,
        }
    }
    /// The model file of a language, as `deps::final_model` names it once
    /// both small models are installed.
    fn model_of(language: &str) -> String {
        if language == "en" { SMALL_EN } else { SMALL }.into()
    }
    /// A take under Auto whose stretches of 10 s each were heard as
    /// `guesses`, each transcribed as the live worker does: in the language
    /// [`Stretches::language_for`] gives, its one word naming that language.
    fn heard(guesses: &[Option<(&str, f32)>]) -> Stretches {
        let mut stretches = Stretches::new("mic.wav", None);
        for heard in guesses {
            hear(
                &mut stretches,
                heard.map(|(language, p)| guess(language, p)),
            );
        }
        stretches
    }
    fn hear(stretches: &mut Stretches, heard: Option<Guess>) {
        let heard = heard.filter(|_| stretches.detects());
        let language = stretches.language_for(heard.as_ref());
        let end = stretches.until_ms + 10_000;
        stretches.push(
            spoken(&[(&format!("{language}-words"), 100, 400)]),
            end,
            &language,
            &model_of(&language),
            heard,
        );
    }
    /// The language each stretch's words are in, from the words themselves.
    fn word_languages(stretches: &Stretches) -> Vec<String> {
        stretches
            .segments
            .iter()
            .map(|segment| segment.text.trim_end_matches("-words").to_owned())
            .collect()
    }
    /// Transcribes again what the take marked for it, as the live worker
    /// and Stop do.
    fn redo(stretches: &mut Stretches) -> Vec<u64> {
        let language = stretches.language.clone().unwrap();
        let again = stretches.to_redo();
        for part in &again {
            stretches.replace(
                part.start_ms,
                spoken(&[(&format!("{language}-words"), 100, 400)]),
                &language,
                &model_of(&language),
            );
        }
        again.iter().map(|part| part.start_ms).collect()
    }

    #[test]
    fn the_first_confident_guess_decides_and_the_sum_settles_the_rest() {
        let guesses = |heard: &[(&str, f32)]| -> Vec<Guess> {
            heard
                .iter()
                .map(|&(language, p)| guess(language, p))
                .collect()
        };
        // Nothing heard, nothing decided.
        assert_eq!(decided(&[]), None);
        assert_eq!(likeliest(&[]), None);
        // 0.9 decides; just under it does not, however often it is heard.
        assert_eq!(decided(&guesses(&[("de", 0.9)])), Some("de"));
        assert_eq!(decided(&guesses(&[("de", 0.89), ("de", 0.89)])), None);
        // The first confident guess wins, not the surest one.
        assert_eq!(
            decided(&guesses(&[("en", 0.5), ("de", 0.93), ("en", 0.99)])),
            Some("de")
        );
        // Undecided: the largest sum, which several weak guesses can reach.
        assert_eq!(
            likeliest(&guesses(&[("en", 0.6), ("de", 0.5), ("de", 0.45)])),
            Some("de")
        );
        assert_eq!(
            likeliest(&guesses(&[("en", 0.8), ("de", 0.4), ("fr", 0.3)])),
            Some("en")
        );
        // Of equals, the one heard first.
        assert_eq!(likeliest(&guesses(&[("de", 0.5), ("en", 0.5)])), Some("de"));
    }

    #[test]
    fn an_unconfident_guess_waits_for_more_speech() {
        // Noise, then a few unclear words: no guess is confident.
        let mut take = heard(&[Some(("en", 0.55)), Some(("nl", 0.4))]);
        assert_eq!(take.language, None);
        assert!(take.detects(), "the next stretch is detected too");
        assert!(
            take.to_redo().is_empty(),
            "nothing to redo before a decision"
        );
        assert_eq!(word_languages(&take), ["en", "nl"]);
        assert!(take.parts.iter().all(|part| part.provisional));
        assert_eq!(take.parts[0].guess, Some(guess("en", 0.55)));
        // While undecided the live transcript names no language.
        let live = take.live(Transcript::default(), 0, 0);
        assert_eq!((live.language, live.language_detected), (None, false));

        // Clear German follows: its stretch decides the take.
        hear(&mut take, Some(guess("de", 0.97)));
        assert_eq!(
            (take.language.as_deref(), take.language_detected),
            (Some("de"), true)
        );
        assert!(!take.detects());
        let live = take.live(Transcript::default(), 0, 0);
        assert_eq!(
            (live.language.as_deref(), live.language_detected),
            (Some("de"), true)
        );
        // The stretches before it, made in other languages, are done again:
        // the whole take is German, the words before the clear speech included.
        assert_eq!(redo(&mut take), [0, 10_000]);
        assert_eq!(word_languages(&take), ["de", "de", "de"]);
        assert!(take.to_redo().is_empty());
        assert!(take
            .parts
            .iter()
            .all(|part| !part.provisional && part.language == "de" && part.model == SMALL));
        // The words stay in their stretches, in order, with ids of their own.
        let starts: Vec<_> = take.segments.iter().map(|s| s.start_ms).collect();
        assert_eq!(starts, [100, 10_100, 20_100]);
        let ids: std::collections::HashSet<_> = take.segments.iter().map(|s| &s.id).collect();
        assert_eq!(ids.len(), 3);
        let joined = take.join(Transcript::default(), 0);
        assert_eq!(
            (joined.language.as_deref(), joined.language_detected),
            (Some("de"), true)
        );
    }

    #[test]
    fn a_take_without_a_confident_guess_uses_the_likeliest_language() {
        // The take ends before any guess is confident.
        let mut take = heard(&[
            Some(("en", 0.6)),
            Some(("de", 0.5)),
            None,
            Some(("de", 0.45)),
        ]);
        assert_eq!(take.language, None);
        // A stretch without a guess is transcribed in the likeliest so far:
        // English led with 0.6 against 0.5 when it came.
        assert_eq!(word_languages(&take), ["en", "de", "en", "de"]);
        // Stop settles it on the largest sum: German, 0.95 against 0.6.
        assert_eq!(take.settle().as_deref(), Some("de"));
        assert_eq!(
            (take.language.as_deref(), take.language_detected),
            (Some("de"), true)
        );
        assert_eq!(redo(&mut take), [0, 20_000]);
        assert_eq!(word_languages(&take), ["de", "de", "de", "de"]);
        // Settling again changes nothing.
        assert_eq!(take.settle().as_deref(), Some("de"));
        assert!(take.to_redo().is_empty());

        // Nothing was ever guessed: the take stays in what it was made in.
        let mut unheard = heard(&[None, None]);
        assert_eq!(unheard.settle().as_deref(), Some("en"));
        assert!(unheard.to_redo().is_empty());
        // A take without speech has no language to settle on.
        let mut silent = Stretches::new("mic.wav", None);
        silent.skip(28_000);
        assert_eq!(silent.settle(), None);
        assert_eq!(silent.until_ms, 28_000);
    }

    #[test]
    fn a_detected_language_is_kept_for_the_rest_of_the_take() {
        let mut take = heard(&[Some(("de", 0.99))]);
        assert_eq!(take.language.as_deref(), Some("de"));
        // The deciding stretch is already in German: nothing to redo.
        assert!(take.to_redo().is_empty());
        assert!(!take.parts[0].provisional);
        // Later speech is short, noisy or in another language: nothing is
        // detected any more, and whatever a guess would say, it is German.
        assert!(!take.detects());
        assert_eq!(take.language_for(None), "de");
        assert_eq!(take.language_for(Some(&guess("en", 0.99))), "de");
        take.push(
            spoken(&[("ja", 100, 400)]),
            20_000,
            "de",
            SMALL,
            Some(guess("en", 0.99)),
        );
        hear(&mut take, Some(guess("en", 0.99)));
        assert_eq!(take.language.as_deref(), Some("de"));
        assert!(take.parts.iter().all(|part| part.language == "de"));
        assert!(take.to_redo().is_empty());
        // Guesses after the decision are not kept.
        assert_eq!(take.guesses(), [guess("de", 0.99)]);

        // A language chosen in Settings holds from the start, undetected.
        let mut fixed = Stretches::new("mic.wav", Some("fr"));
        assert!(!fixed.detects());
        assert_eq!(fixed.language_for(Some(&guess("en", 0.99))), "fr");
        fixed.push(spoken(&[("oui", 100, 400)]), 10_000, "fr", SMALL, None);
        assert_eq!(
            (fixed.language.as_deref(), fixed.language_detected),
            (Some("fr"), false)
        );
        assert!(!fixed.parts[0].provisional && fixed.to_redo().is_empty());
        let live = fixed.live(Transcript::default(), 0, 0);
        assert_eq!(
            (live.language.as_deref(), live.language_detected),
            (Some("fr"), false)
        );
    }

    #[test]
    fn provisional_stretches_are_redone_in_order_and_a_busy_copy_is_tried_again() {
        // Three stretches before the decision, two of them in other languages.
        let decided = || {
            let mut take = heard(&[Some(("en", 0.6)), Some(("de", 0.7)), Some(("nl", 0.5))]);
            hear(&mut take, Some(guess("de", 0.95)));
            take
        };
        let mut take = decided();
        let waiting =
            |take: &Stretches| -> Vec<u64> { take.to_redo().iter().map(|p| p.start_ms).collect() };
        assert_eq!(waiting(&take), [0, 20_000]);
        let german = |part: &Part, language: &str, take: &mut Stretches| {
            take.replace(
                part.start_ms,
                spoken(&[(&format!("{language}-words"), 100, 400)]),
                language,
                &model_of(language),
            );
            Ok(())
        };
        // What was asked for, in order: a copy from a stretch's start, then
        // that stretch's transcription in the take's language.
        let steps = std::cell::RefCell::new(Vec::new());
        let copied = |part: &Part| {
            steps.borrow_mut().push(format!("copy {}", part.start_ms));
            Ok(())
        };
        let transcribed = |part: &Part, language: &str, take: &mut Stretches| {
            steps
                .borrow_mut()
                .push(format!("{language} {}", part.start_ms));
            german(part, language, take)
        };
        let mut redo = Redo::default();
        assert!(redo.pending(&take));

        // The live track's writer is busy at the second stretch: the first is
        // done, the attempt ends, nothing is given up.
        let busy = "Audio snapshot is busy; retry next update";
        let outcome = redo.run(
            &mut take,
            &mut |part| {
                if part.start_ms == 20_000 {
                    return Err(busy.to_string());
                }
                copied(part)
            },
            &mut |part, language, take| transcribed(part, language, take),
        );
        assert_eq!(outcome, Redone::Later(busy.into()));
        assert_eq!(*steps.borrow(), ["copy 0", "de 0"]);
        assert_eq!(waiting(&take), [20_000]);
        assert!(redo.pending(&take), "the next update tries again");
        // The next update starts at the stretch that was left, and finishes.
        steps.borrow_mut().clear();
        let outcome = redo.run(
            &mut take,
            &mut |part| copied(part),
            &mut |part, language, take| transcribed(part, language, take),
        );
        assert_eq!(outcome, Redone::Done);
        assert_eq!(*steps.borrow(), ["copy 20000", "de 20000"]);
        assert_eq!(word_languages(&take), ["de", "de", "de", "de"]);
        assert!(!redo.pending(&take) && take.to_redo().is_empty());
        let never_copy = &mut |_: &Part| -> Result<(), String> { panic!("nothing waits") };
        let never = &mut |_: &Part, _: &str, _: &mut Stretches| -> Result<(), String> {
            panic!("nothing waits")
        };
        assert_eq!(redo.run(&mut take, never_copy, never), Redone::Done);

        // A transcription that fails is not tried again while recording:
        // that stretch and the one after it wait for Stop.
        let mut take = decided();
        let mut redo = Redo::default();
        steps.borrow_mut().clear();
        let outcome = redo.run(&mut take, &mut |part| copied(part), &mut |_, _, _| {
            Err("Local speech processing failed.".to_string())
        });
        assert_eq!(
            outcome,
            Redone::LeftToStop("Local speech processing failed.".into())
        );
        assert_eq!(*steps.borrow(), ["copy 0"]);
        assert!(!redo.pending(&take));
        assert_eq!(waiting(&take), [0, 20_000], "still marked for Stop");
        assert_eq!(redo.run(&mut take, never_copy, never), Redone::Done);

        // Only the stretch that decides the take reports stretches to redo,
        // so later stretches are finished as usual while some still wait.
        let mut take = heard(&[Some(("en", 0.6))]);
        let german_words = || spoken(&[("de-words", 100, 400)]);
        let decides = take.push(german_words(), 20_000, "de", SMALL, Some(guess("de", 0.95)));
        assert!(decides);
        assert!(!take.push(german_words(), 30_000, "de", SMALL, None));
        assert_eq!(waiting(&take), [0]);
        // A deciding stretch with nothing before it in another language, and
        // an undecided one, report nothing.
        let mut clear = Stretches::new("mic.wav", None);
        assert!(!clear.push(german_words(), 10_000, "de", SMALL, Some(guess("de", 0.5))));
        assert!(!clear.push(german_words(), 20_000, "de", SMALL, Some(guess("de", 0.99))));
        // Nothing is redone before the take is decided.
        let mut undecided = heard(&[Some(("en", 0.6)), Some(("de", 0.7))]);
        assert!(!Redo::default().pending(&undecided));
        assert_eq!(
            Redo::default().run(&mut undecided, never_copy, never),
            Redone::Done
        );
    }

    #[test]
    fn stretches_join_without_gaps_or_overlaps() {
        let mut stretches = Stretches::new("mic.wav", Some("en"));
        let english = |stretches: &mut Stretches, words: Transcript, end_ms| {
            stretches.push(words, end_ms, "en", SMALL_EN, None)
        };
        english(
            &mut stretches,
            spoken(&[("one", 100, 400), ("two", 500, 800)]),
            1100,
        );
        // A word the model placed past the cut is dropped, never doubled.
        english(
            &mut stretches,
            spoken(&[("three", 50, 300), ("ghost", 3500, 3600)]),
            4100,
        );
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
        let english = Some("en");
        assert!(usable(take.path(), None, "mic.wav", english, &model_of).is_none());
        let mut stretches = Stretches::new("mic.wav", english);
        stretches.push(spoken(&[("one", 100, 400)]), 1000, "en", SMALL_EN, None);
        save(take.path(), &stretches).unwrap();
        assert_eq!(
            usable(take.path(), None, "mic.wav", english, &model_of)
                .map(|saved| (saved.until_ms, saved.segments.len())),
            Some((1000, 1))
        );
        assert_eq!(language(take.path(), None), Some(("en".into(), false)));
        // Another audio file, another language choice (German, or Auto,
        // which never chose English), or a model that arrived meanwhile.
        let base = |_: &str| "ggml-base.bin".to_owned();
        assert!(usable(take.path(), None, "audio.wav", english, &model_of).is_none());
        assert!(usable(take.path(), None, "mic.wav", Some("de"), &model_of).is_none());
        assert!(usable(take.path(), None, "mic.wav", None, &model_of).is_none());
        assert!(usable(take.path(), None, "mic.wav", english, &base).is_none());
        // Retry forgets them; the raw output in the folder stays.
        fs::write(folder(take.path()).join("0.json"), b"{}").unwrap();
        forget(take.path());
        assert!(usable(take.path(), None, "mic.wav", english, &model_of).is_none());
        assert_eq!(language(take.path(), None), None);
        assert!(folder(take.path()).join("0.json").is_file());
        // A damaged file is not used.
        fs::write(file(take.path(), None), b"{broken").unwrap();
        assert!(usable(take.path(), None, "mic.wav", english, &model_of).is_none());
        // Nor is a file of version 1, which knew one language per take.
        fs::write(
            file(take.path(), None),
            br#"{"version":1,"source":"mic.wav","model":"ggml-small.en.bin","language":"en","untilMs":1000,"segments":[]}"#,
        )
        .unwrap();
        assert!(usable(take.path(), None, "mic.wav", english, &model_of).is_none());
        assert_eq!(language(take.path(), None), None);
    }

    #[test]
    fn stretches_made_under_auto_are_settled_and_reused_under_auto() {
        let take = tempfile::tempdir().unwrap();
        // Stopped undecided: Stop settles it on the likeliest language and
        // finds the stretch to transcribe again.
        let undecided = heard(&[Some(("en", 0.6)), Some(("de", 0.8))]);
        save(take.path(), &undecided).unwrap();
        assert_eq!(
            language(take.path(), None),
            None,
            "nothing decided while it recorded"
        );
        let settled = usable(take.path(), None, "mic.wav", None, &model_of).unwrap();
        assert_eq!(
            (settled.language.as_deref(), settled.language_detected),
            (Some("de"), true)
        );
        let again: Vec<_> = settled.to_redo().iter().map(|part| part.start_ms).collect();
        assert_eq!(again, [0]);
        // A language chosen before Stop is used instead: the whole take again.
        assert!(usable(take.path(), None, "mic.wav", Some("de"), &model_of).is_none());
        // The German model arrived during the take: its stretches were made
        // with base, so the whole take is transcribed again.
        let mut early = Stretches::new("mic.wav", None);
        early.push(
            spoken(&[("eins", 100, 400)]),
            10_000,
            "de",
            "ggml-base.bin",
            Some(guess("de", 0.95)),
        );
        save(take.path(), &early).unwrap();
        assert_eq!(language(take.path(), None), Some(("de".into(), true)));
        assert!(usable(take.path(), None, "mic.wav", None, &model_of).is_none());
        let base = |_: &str| "ggml-base.bin".to_owned();
        assert!(usable(take.path(), None, "mic.wav", None, &base).is_some());
        // Only silence so far: reused, with the language still to detect.
        let mut silent = Stretches::new("mic.wav", None);
        silent.skip(28_000);
        save(take.path(), &silent).unwrap();
        let reused = usable(take.path(), None, "mic.wav", None, &model_of).unwrap();
        assert_eq!((reused.language, reused.until_ms), (None, 28_000));
        // What is saved: the decision and each stretch's guess.
        let saved: serde_json::Value = serde_json::to_value(&settled).unwrap();
        assert_eq!(saved["version"], 2);
        assert_eq!(
            (&saved["language"], &saved["languageDetected"]),
            (&serde_json::json!("de"), &serde_json::json!(true))
        );
        assert_eq!(
            saved["parts"][0],
            serde_json::json!({"startMs":0,"endMs":10_000,"language":"en","model":SMALL_EN,
                "guess":{"language":"en","p":0.6f32},"provisional":true})
        );
        assert!(saved["parts"][1].get("provisional").is_none());
    }

    #[test]
    fn the_system_track_is_served_first_and_guessed_every_second_cycle() {
        let turn = |track, guess| Turn { track, guess };
        let both = [Track::Microphone, Track::System];
        // Every cycle: the system track, then the microphone. The
        // microphone's words still being heard are guessed in each, the
        // system's in every second one, from the first on.
        let served: Vec<_> = (0..4).map(|cycle| turns(&both, cycle)).collect();
        let guessed = [turn(Track::System, true), turn(Track::Microphone, true)];
        let committed = [turn(Track::System, false), turn(Track::Microphone, true)];
        assert_eq!(served, [guessed, committed, guessed, committed]);
        // The order the capture names its tracks in changes nothing.
        assert_eq!(turns(&[Track::System, Track::Microphone], 1), committed);
        // One track is guessed in every cycle, as before.
        for track in [Track::Microphone, Track::System] {
            for cycle in 0..3 {
                assert_eq!(turns(&[track], cycle), [turn(track, true)]);
            }
        }
        assert!(turns(&[], 0).is_empty());
    }

    #[test]
    fn each_track_has_stretches_of_its_own() {
        let take = tempfile::tempdir().unwrap();
        let english = Some("en");
        // The two tracks of a take, each cut into stretches of its own.
        let mut system = Stretches::of_track(Track::System, None);
        system.push(
            spoken(&[("anruf", 100, 400)]),
            10_000,
            "de",
            SMALL,
            Some(guess("de", 0.95)),
        );
        let mut microphone = Stretches::of_track(Track::Microphone, english);
        microphone.push(
            spoken(&[("review", 200, 500)]),
            12_000,
            "en",
            SMALL_EN,
            None,
        );
        assert_eq!(
            (system.source.as_str(), microphone.source.as_str()),
            ("system.wav", "mic.wav")
        );
        assert_eq!(
            (system.audio(), microphone.audio()),
            (Track::System, Track::Microphone)
        );
        // Their rows carry the track, and no id is shared between them.
        assert!(system
            .segments
            .iter()
            .all(|row| row.track == Some(Track::System)));
        assert_eq!(system.segments[0].id, "stretch-system-0-0");
        assert_eq!(microphone.segments[0].id, "stretch-microphone-0-0");
        system.replace(0, spoken(&[("anruf", 100, 400)]), "de", SMALL);
        assert_eq!(system.segments[0].track, Some(Track::System));
        let joined = microphone.join(spoken(&[("more", 0, 200)]), 900);
        assert!(joined
            .segments
            .iter()
            .all(|row| row.track == Some(Track::Microphone)));
        // Each is saved in its own file, beside its raw output.
        save(take.path(), &system).unwrap();
        save(take.path(), &microphone).unwrap();
        let files = |take: &Path| -> Vec<String> {
            let mut names: Vec<_> = fs::read_dir(folder(take))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            names
        };
        assert_eq!(files(take.path()), ["microphone.json", "system.json"]);
        assert_eq!(
            raw(take.path(), Some(Track::System), 28_000),
            folder(take.path()).join("system-28000.json")
        );
        assert_eq!(
            raw(take.path(), None, 28_000),
            folder(take.path()).join("28000.json")
        );
        // And used, and held to its language, on its own.
        let reused = |track: Track, chosen: Option<&str>| {
            usable(take.path(), Some(track), track.file(), chosen, &model_of)
        };
        assert_eq!(
            reused(Track::System, None).map(|saved| (saved.until_ms, saved.track)),
            Some((10_000, Some(Track::System)))
        );
        assert!(
            reused(Track::Microphone, None).is_none(),
            "made under English"
        );
        assert_eq!(
            reused(Track::Microphone, english).map(|saved| saved.until_ms),
            Some(12_000)
        );
        assert!(reused(Track::System, english).is_none(), "made under Auto");
        assert_eq!(
            language(take.path(), Some(Track::System)),
            Some(("de".into(), true))
        );
        assert_eq!(
            language(take.path(), Some(Track::Microphone)),
            Some(("en".into(), false))
        );
        // They are not the stretches of a take with one track.
        assert!(usable(take.path(), None, "mic.wav", english, &model_of).is_none());
        assert_eq!(language(take.path(), None), None);
        assert!(any_saved(take.path()));
        // One track's can be forgotten alone; Retry forgets them all.
        forget_track(take.path(), Some(Track::System));
        assert_eq!(files(take.path()), ["microphone.json"]);
        assert!(any_saved(take.path()));
        forget(take.path());
        assert!(!any_saved(take.path()));

        // A take with one track keeps the one file it always had, written
        // without a track, whether cut from the microphone or from the
        // system audio; a file saved before tracks existed reads the same.
        let mut alone = Stretches::new("system.wav", english);
        alone.push(spoken(&[("one", 100, 400)]), 1000, "en", SMALL_EN, None);
        assert_eq!((alone.track, alone.audio()), (None, Track::System));
        assert_eq!(alone.segments[0].id, "stretch-0-0");
        assert_eq!(alone.segments[0].track, None);
        save(take.path(), &alone).unwrap();
        assert_eq!(files(take.path()), ["stretches.json"]);
        let saved: serde_json::Value = read_json(&file(take.path(), None)).unwrap();
        assert!(saved.get("track").is_none());
        assert!(saved["segments"][0].get("track").is_none());
        assert!(usable(take.path(), None, "system.wav", english, &model_of).is_some());
        assert!(
            usable(
                take.path(),
                Some(Track::System),
                "system.wav",
                english,
                &model_of
            )
            .is_none(),
            "not the system track of a take with two"
        );
        assert!(any_saved(take.path()));
        assert_eq!(Stretches::new("mic.wav", None).audio(), Track::Microphone);
    }

    #[test]
    fn the_live_transcript_holds_both_tracks_and_one_guess_for_each() {
        // A call in German on the system track, decided; the reviewer on
        // the microphone, not decided yet.
        let mut system = Stretches::of_track(Track::System, None);
        system.push(
            spoken(&[("frage", 1_000, 1_800)]),
            10_000,
            "de",
            SMALL,
            Some(guess("de", 0.95)),
        );
        system.push(
            spoken(&[("danke", 2_000, 2_500)]),
            20_000,
            "de",
            SMALL,
            None,
        );
        let mut microphone = Stretches::of_track(Track::Microphone, None);
        microphone.push(
            spoken(&[("answer", 4_000, 5_000)]),
            12_000,
            "en",
            SMALL_EN,
            Some(guess("en", 0.6)),
        );
        // Take 2 starts at 60 s on the session timeline.
        let offset = 60_000;
        let live = live_of_tracks(
            system.live(spoken(&[("noch", 500, 900)]), 3_000, offset),
            microphone.live(
                spoken(&[("and", 300, 600), ("then", 700, 900)]),
                9_000,
                offset,
            ),
        );
        let rows: Vec<_> = live
            .segments
            .iter()
            .map(|row| (row.id.as_str(), row.track, row.text.as_str(), row.start_ms))
            .collect();
        let (system_track, microphone_track) = (Some(Track::System), Some(Track::Microphone));
        assert_eq!(
            rows,
            [
                // The finished rows of both tracks, by time.
                ("stretch-system-0-0", system_track, "frage", 61_000),
                ("stretch-microphone-0-0", microphone_track, "answer", 64_000),
                ("stretch-system-10000-1", system_track, "danke", 72_000),
                // Then the words still being heard, one segment per track.
                (
                    "live-microphone-12000",
                    microphone_track,
                    "and then",
                    72_300
                ),
                ("live-system-20000", system_track, "noch", 80_500),
            ]
        );
        assert_eq!(live.status.as_deref(), Some("provisional"));
        // What is decided so far: the system track is German.
        let shown = serde_json::to_value(&live).unwrap();
        assert_eq!(
            shown["trackLanguages"],
            serde_json::json!({"system":{"language":"de","languageDetected":true}})
        );
        assert_eq!(shown["language"], serde_json::json!("de"));
        assert_eq!(
            shown["segments"][3]["track"],
            serde_json::json!("microphone")
        );
        // Once the microphone is decided too, the transcript's own language
        // is the microphone's.
        microphone.push(
            spoken(&[("clear", 100, 400)]),
            22_000,
            "en",
            SMALL_EN,
            Some(guess("en", 0.97)),
        );
        // No words being heard on a track: no live segment for it; rows
        // that start together show the system's first.
        let mut tied = Stretches::of_track(Track::Microphone, Some("en"));
        tied.push(
            spoken(&[("same", 1_000, 1_300)]),
            5_000,
            "en",
            SMALL_EN,
            None,
        );
        let live = live_of_tracks(
            system.live(Transcript::default(), 0, 0),
            microphone.live(spoken(&[("now", 0, 200)]), 500, 0),
        );
        assert_eq!(
            (live.language.as_deref(), live.language_detected),
            (Some("en"), true)
        );
        let heard: Vec<_> = live
            .segments
            .iter()
            .filter(|row| row.id.starts_with("live-"))
            .map(|row| (row.track, row.text.as_str()))
            .collect();
        assert_eq!(heard, [(microphone_track, "now")]);
        assert!(live.segments.last().unwrap().id.starts_with("live-"));
        let live = live_of_tracks(
            system.live(Transcript::default(), 0, 0),
            tied.live(Transcript::default(), 0, 0),
        );
        let first: Vec<_> = live.segments.iter().take(2).map(|row| row.track).collect();
        assert_eq!(first, [system_track, microphone_track]);
        assert_eq!(
            (live.segments[0].start_ms, live.segments[1].start_ms),
            (1_000, 1_000)
        );
        // Nothing heard on either track yet.
        let empty = live_of_tracks(
            Stretches::of_track(Track::System, None).live(Transcript::default(), 0, 0),
            Stretches::of_track(Track::Microphone, None).live(Transcript::default(), 0, 0),
        );
        assert!(empty.segments.is_empty() && empty.track_languages.is_none());
        assert_eq!(empty.language, None);
    }

    /// What a real-time replay of a recorded take through the live worker
    /// measured: when each word first showed live, how long Stop took, and
    /// the words of the one-pass and of a whole-take transcript.
    struct Replay {
        /// Seconds from a word's end in the audio to its first live showing.
        delays: Vec<f64>,
        stop: std::time::Duration,
        one_pass: Vec<String>,
        /// Whole-take passes over the take started 0, 100, 250 and 500 ms
        /// later: Whisper's words shift with where its windows fall.
        whole: Vec<Vec<String>>,
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
    /// [`crate::transcribe::live_guess`] and [`crate::transcribe::live_commit`] at real speed, as the live worker
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
            // The recorded take is English and its numbers were measured
            // held to English, so this replay is too.
            let english = crate::models::Settings {
                language: Some("en".into()),
                ..Default::default()
            };
            crate::settings::save(root.path(), &english).unwrap();
            let models = crate::deps::TakeModels::now();
            let mut stretches = Stretches::new("mic.wav", Some("en"));
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
                let (guess, audio) = crate::transcribe::live_guess(
                    root.path(),
                    &live,
                    &snapshot,
                    length,
                    stretches.language.as_deref(),
                    None,
                    true,
                    &cancel,
                )
                .unwrap();
                let guess = guess.expect("a guess was asked for");
                seen(&stretches.live(guess.clone(), length, 0), started.elapsed().as_secs_f64());
                let before = stretches.until_ms;
                let (guess, guess_ms) = match audio {
                    Some(audio) => crate::transcribe::live_commit(
                        root.path(),
                        &take,
                        &live,
                        &models,
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
            let whole: Vec<Transcript> = [0u64, 100, 250, 500]
                .iter()
                .map(|&shift| {
                    let folder = root.path().join(format!("whole-{shift}"));
                    fs::create_dir_all(&folder).unwrap();
                    let mut ffmpeg = crate::deps::command("ffmpeg").unwrap();
                    let status = ffmpeg
                        .args(["-v", "error", "-y", "-ss", &format!("{:.3}", shift as f64 / 1000.), "-i"])
                        .arg(&mic)
                        .arg(folder.join("mic.wav"))
                        .status()
                        .unwrap();
                    assert!(status.success());
                    crate::transcribe::transcribe_media(root.path(), &folder, length_ms - shift, true)
                        .unwrap()
                })
                .collect();
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
                whole: whole.iter().map(normalized).collect(),
                reference,
            };
            eprintln!(
                "replay of {} s: {} stretches; live delay median {:.1} s, 90th {:.1} s; Stop {:?}; word errors one-pass {:.1} %, whole-take passes {}",
                length_ms / 1000,
                stretches.segments.len(),
                replay.delays[replay.delays.len() / 2],
                replay.delays[replay.delays.len() * 9 / 10],
                replay.stop,
                100. * word_errors(&replay.reference, &replay.one_pass),
                replay
                    .whole
                    .iter()
                    .map(|whole| format!("{:.1} %", 100. * word_errors(&replay.reference, whole)))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            eprintln!("one-pass: {}", replay.one_pass.join(" "));
            eprintln!("whole:    {}", replay.whole[0].join(" "));
            replay
        })
    }

    #[test]
    #[ignore = "Requires Whisper, small.en, base, the speech detector, test-results/replay/mic.wav and its reference.txt; runs in real time"]
    fn actual_replay_shows_words_within_seconds() {
        let replay = replay();
        let median = replay.delays[replay.delays.len() / 2];
        assert!(
            median <= 3.5,
            "live words showed {median:.1} s after they were said"
        );
    }

    #[test]
    #[ignore = "Requires Whisper, small.en, base, the speech detector, test-results/replay/mic.wav and its reference.txt; runs in real time"]
    fn actual_replay_finishes_within_seconds_of_stop() {
        let stop = replay().stop;
        assert!(stop.as_secs_f64() < 5.0, "Stop took {stop:?}");
    }

    /// A track of the two-track fixture: its samples and their rate.
    fn fixture_track(path: &Path) -> (Vec<f32>, hound::WavSpec) {
        let mut reader = hound::WavReader::open(path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let spec = reader.spec();
        let samples = match spec.sample_format {
            hound::SampleFormat::Float => reader.samples::<f32>().map(Result::unwrap).collect(),
            hound::SampleFormat::Int => {
                let full = (1i64 << (spec.bits_per_sample - 1)) as f32;
                reader
                    .samples::<i32>()
                    .map(|sample| sample.unwrap() as f32 / full)
                    .collect()
            }
        };
        assert_eq!(spec.channels, 1, "{} is mono", path.display());
        (samples, spec)
    }

    #[test]
    #[ignore = "Requires Whisper, both small models, base, the speech detector and a recorded take with both tracks: test-results/replay/two-tracks/mic.wav and system.wav; runs in real time"]
    fn actual_replay_of_two_tracks_finishes_within_seconds_of_stop() {
        use std::time::{Duration, Instant};
        let fixtures =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-results/replay/two-tracks");
        let audio = |track: Track| fixture_track(&fixtures.join(track.file()));
        let (microphone, system) = (audio(Track::Microphone), audio(Track::System));
        let length_of = |(samples, spec): &(Vec<f32>, hound::WavSpec)| {
            samples.len() as u64 * 1000 / spec.sample_rate as u64
        };
        let length_ms = length_of(&microphone).min(length_of(&system));
        let root = tempfile::tempdir().unwrap();
        let take = root.path().join("take");
        let live = take.join("live");
        fs::create_dir_all(&live).unwrap();
        // No settings: Auto, each track detected on its own.
        let models = crate::deps::TakeModels::now();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        // A copy of a track from a point, as the capture makes it: at most
        // 60 s, up to what is recorded by `now_ms`.
        let copy = |track: Track, from_ms: u64, now_ms: u64, target: &Path| -> u64 {
            let (samples, spec) = match track {
                Track::Microphone => &microphone,
                Track::System => &system,
            };
            let rate = spec.sample_rate as u64;
            let to_ms = now_ms.min(from_ms + 60_000);
            let (a, b) = (
                (from_ms * rate / 1000) as usize,
                (to_ms * rate / 1000) as usize,
            );
            let spec = hound::WavSpec {
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
                ..*spec
            };
            let mut writer = hound::WavWriter::create(target, spec).unwrap();
            for sample in &samples[a.min(b)..b] {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
            to_ms.saturating_sub(from_ms)
        };
        let both = [Track::Microphone, Track::System];
        let mut tracks: Vec<(Stretches, Transcript)> = turns(&both, 0)
            .iter()
            .map(|turn| (Stretches::of_track(turn.track, None), Transcript::default()))
            .collect();
        let snapshot = live.join("snapshot.wav");
        let system_snapshot = live.join("system-snapshot.wav");
        let started = Instant::now();
        let mut cycle = 0;
        // The longest a cycle took: how far the live transcript can lag.
        let mut slowest = Duration::ZERO;
        loop {
            let began = Instant::now();
            let now_ms = (started.elapsed().as_millis() as u64).min(length_ms);
            for (at, turn) in turns(&both, cycle).into_iter().enumerate() {
                let (stretches, shown) = &mut tracks[at];
                let from = stretches.until_ms;
                let length = copy(turn.track, from, now_ms, &snapshot);
                let echo = turn.track == Track::Microphone;
                if echo {
                    copy(Track::System, from, now_ms, &system_snapshot);
                }
                let (guess, audio) = crate::transcribe::live_guess(
                    root.path(),
                    &live,
                    &snapshot,
                    length,
                    stretches.language.as_deref(),
                    echo.then_some(system_snapshot.as_path()),
                    turn.guess,
                    &cancel,
                )
                .unwrap();
                let guess = guess.unwrap_or_else(|| shown.clone());
                let before = stretches.until_ms;
                *shown = match audio {
                    Some(audio) => {
                        crate::transcribe::live_commit(
                            root.path(),
                            &take,
                            &live,
                            &models,
                            stretches,
                            &audio,
                            guess,
                            &cancel,
                        )
                        .unwrap()
                        .0
                    }
                    None => guess,
                };
                if stretches.until_ms != before {
                    eprintln!("{} cut {before} {}", turn.track.name(), stretches.until_ms);
                }
            }
            slowest = slowest.max(began.elapsed());
            if now_ms >= length_ms {
                break;
            }
            cycle += 1;
            let spent = began.elapsed();
            if spent < LIVE_CYCLE {
                std::thread::sleep(LIVE_CYCLE - spent);
            }
        }
        // Stop: the finished tracks, as the capture leaves them.
        for track in both {
            fs::copy(fixtures.join(track.file()), take.join(track.file())).unwrap();
        }
        let stopped = Instant::now();
        let transcript =
            crate::transcribe::transcribe_media(root.path(), &take, length_ms, true).unwrap();
        let stop = stopped.elapsed();
        let rows = |track: Track| {
            transcript
                .segments
                .iter()
                .filter(|row| row.track == Some(track))
                .count()
        };
        eprintln!(
            "replay of {} s on two tracks: {} system and {} microphone rows ({:?}); the slowest cycle took {slowest:?}; Stop {stop:?}",
            length_ms / 1000,
            rows(Track::System),
            rows(Track::Microphone),
            transcript.track_languages,
        );
        for row in &transcript.segments {
            eprintln!(
                "{:>7} {:<10} {}",
                row.start_ms,
                row.track.map_or("", Track::name),
                row.text
            );
        }
        assert!(
            transcript.segments.iter().all(|row| row.track.is_some()),
            "every row of a two-track take names its track"
        );
        assert!(rows(Track::System) > 0, "the call is in the transcript");
        assert!(stop.as_secs_f64() < 5.0, "Stop took {stop:?}");
    }

    #[test]
    #[ignore = "Requires Whisper, small.en, base, the speech detector, test-results/replay/mic.wav and its reference.txt; runs in real time"]
    fn actual_replay_matches_a_whole_take_pass() {
        let replay = replay();
        let one_pass = word_errors(&replay.reference, &replay.one_pass);
        let worst = replay
            .whole
            .iter()
            .map(|whole| word_errors(&replay.reference, whole))
            .fold(0.0, f64::max);
        // Stop's transcript from stretches stays near Whisper's own spread
        // (its words are then refined by a whole-take pass): no more than 6
        // points above the worst of the shifted whole-take passes.
        assert!(
            one_pass <= worst + 0.06,
            "one-pass misses {:.1} % of words, the worst whole-take pass {:.1} %",
            100. * one_pass,
            100. * worst
        );
        // No stretch boundary doubles words: no run of four words repeats back to back.
        let doubled = replay.one_pass.windows(8).any(|w| w[..4] == w[4..]);
        assert!(!doubled, "a run of words is doubled");
    }
}
