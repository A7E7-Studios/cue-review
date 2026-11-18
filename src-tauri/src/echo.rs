//! The echo gate: microphone speech that is the computer's own audio, heard
//! from the loudspeakers, is recognised from the two tracks and silenced
//! before it is transcribed.
//!
//! Both tracks are 16 kHz mono and share a clock. For a microphone speech
//! region and the system audio of the same span, the gate computes the share
//! of the microphone's 300 to 3400 Hz power that the system audio explains
//! linearly: the magnitude-squared coherence of the two, weighted by the
//! microphone's power in each frequency bin, from Welch segments of 64 ms,
//! after the system audio is shifted by the delay that maximises the two
//! tracks' cross-correlation in that band. Loudspeaker echo is a delayed,
//! filtered and quieter copy of the system audio, so the system audio
//! explains most of it; the reviewer's own voice it explains hardly at all.
//! A region that holds both scores in between and is kept whole.
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::{path::Path, sync::Arc};

/// The sample rate both tracks are compared at.
pub const RATE: u32 = 16_000;
const PER_MS: usize = RATE as usize / 1000;

// The numbers below come from one review of 2 h 31 min held over a call with
// the loudspeakers on, whose 2313 microphone speech regions were labelled as
// echo or as the reviewer's own speech by comparing their words on the two
// tracks.

/// A region is echo when the system audio explains at least this share of
/// its speech-band power. At 0.4, 12 of 1005 echo regions stayed in (1.2 %)
/// and none of the reviewer's 275 regions was lost by ear; with the system
/// audio taken from another moment, as on headphones, 0.6 % of the
/// microphone's regions were dropped. At 0.5: 1.6 % and 0.2 %.
pub const ECHO_SHARE: f64 = 0.4;
/// The system audio counts as playing in a span above this level (dBFS, RMS).
/// Below it nothing can echo, whatever the share says.
pub const ACTIVE_DBFS: f64 = -45.0;
/// The speech band compared, in Hz: what a loudspeaker and a microphone both
/// carry well.
const BAND_HZ: (f64, f64) = (300.0, 3400.0);
/// One Welch segment: 64 ms, in steps of half of it.
const WELCH: usize = 1024;
/// The microphone hears the loudspeakers this much later than the system
/// track has them (ms): 80 to 176 ms on the measured recording. The search
/// leaves room for a slower output device and for a little clock skew the
/// other way.
const LAG_MS: (i64, i64) = (-50, 500);
/// System audio taken before a span, so every delay up to the longest fits.
const BEFORE: usize = LAG_MS.1 as usize * PER_MS;
/// And after it, for the microphone running ahead.
const AFTER: usize = -LAG_MS.0 as usize * PER_MS;
/// A region shorter than this is scored on a wider window around it: of the
/// regions dropped with system audio from another moment, every one was
/// shorter than 1.2 s, and cropped to 0.5 s a region was dropped 4.3 % of the
/// time against 0.0 % at 1.5 s.
const SHORT_MS: u64 = 1000;
const WIDENED_MS: u64 = 1500;
/// A longer region is scored in equal pieces of at most this length, as the
/// measurement did, so echo followed by a long reply is not one verdict.
const PIECE_MS: u64 = 15_000;
/// Coherence from a handful of segments is close to 1 for any two signals,
/// so audio too short for this many is never called echo.
const MIN_SEGMENTS: usize = 8;

/// How one stretch of microphone audio compares to the system audio.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Score {
    /// The share of the microphone's speech-band power that the system audio
    /// explains, 0 to 1.
    pub share: f64,
    /// The level of the system audio in the span, shifted by `lag_ms` (dBFS).
    pub system_dbfs: f64,
    /// How much later the microphone has the system audio (ms).
    pub lag_ms: i64,
}
impl Score {
    /// Whether the stretch is the system audio heard from the loudspeakers.
    pub fn is_echo(&self) -> bool {
        self.system_dbfs > ACTIVE_DBFS && self.share >= ECHO_SHARE
    }
}

/// One microphone speech region, or one piece of a long one, and its verdict.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Piece {
    pub start_ms: u64,
    pub end_ms: u64,
    /// `None` when there was too little audio to compare.
    pub score: Option<Score>,
}
impl Piece {
    pub fn is_echo(&self) -> bool {
        self.score.is_some_and(|score| score.is_echo())
    }
}

fn mean(samples: &[f32]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    samples.iter().map(|sample| *sample as f64).sum::<f64>() / samples.len() as f64
}

/// The transforms a run of comparisons shares.
struct Scorer {
    planner: FftPlanner<f64>,
    welch: Arc<dyn Fft<f64>>,
    /// A Hann window over one Welch segment.
    window: Vec<f64>,
}
impl Scorer {
    fn new() -> Self {
        let mut planner = FftPlanner::new();
        let welch = planner.plan_fft_forward(WELCH);
        let window = (0..WELCH)
            .map(|n| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (WELCH - 1) as f64).cos())
            .collect();
        Self {
            planner,
            welch,
            window,
        }
    }
    /// Compares `microphone` with `system`, the system audio from [`BEFORE`]
    /// samples before the microphone's span to [`AFTER`] samples after it,
    /// both in full scale. `None` when the span is too short to compare.
    fn score(&mut self, microphone: &[f32], system: &[f32]) -> Option<Score> {
        let length = microphone.len();
        debug_assert_eq!(system.len(), length + BEFORE + AFTER);
        if length < WELCH || (length - WELCH) / (WELCH / 2) + 1 < MIN_SEGMENTS {
            return None;
        }
        let at = self.aligned_at(microphone, system);
        let aligned = &system[at..at + length];
        let level = aligned
            .iter()
            .map(|sample| (*sample as f64).powi(2))
            .sum::<f64>()
            / length as f64;
        Some(Score {
            share: self.explained(microphone, aligned),
            system_dbfs: 10.0 * level.max(1e-18).log10(),
            lag_ms: (BEFORE as i64 - at as i64) / PER_MS as i64,
        })
    }
    /// Where in `system` the audio starts that correlates most with
    /// `microphone` in the speech band: `BEFORE` samples in for no delay,
    /// earlier by the delay when the microphone is later.
    fn aligned_at(&mut self, microphone: &[f32], system: &[f32]) -> usize {
        let length = microphone.len();
        // Room for every shift without wrapping around.
        let size = system.len().next_power_of_two();
        let forward = self.planner.plan_fft_forward(size);
        let inverse = self.planner.plan_fft_inverse(size);
        // The spectrum of a signal without its mean, the speech band only.
        let band = |samples: &[f32]| {
            let mean = mean(samples);
            let mut bins: Vec<Complex<f64>> = samples
                .iter()
                .map(|sample| Complex::new(*sample as f64 - mean, 0.0))
                .collect();
            bins.resize(size, Complex::default());
            forward.process(&mut bins);
            for (bin, value) in bins.iter_mut().enumerate() {
                let hz = bin.min(size - bin) as f64 * RATE as f64 / size as f64;
                if !(BAND_HZ.0..=BAND_HZ.1).contains(&hz) {
                    *value = Complex::default();
                }
            }
            bins
        };
        let microphone_band = band(microphone);
        let mut system_band = band(system);
        let scale = 1.0 / size as f64;
        let microphone_energy = microphone_band
            .iter()
            .map(|bin| bin.norm_sqr())
            .sum::<f64>()
            * scale;
        // cross[at] is the sum over t of system[t + at] * microphone[t].
        let mut cross: Vec<Complex<f64>> = system_band
            .iter()
            .zip(&microphone_band)
            .map(|(system, microphone)| system * microphone.conj())
            .collect();
        inverse.process(&mut cross);
        inverse.process(&mut system_band);
        // The system audio's energy up to each sample, for the energy under
        // the microphone's span at every shift.
        let mut energy = Vec::with_capacity(system.len() + 1);
        let mut sum = 0.0;
        energy.push(sum);
        for bin in &system_band[..system.len()] {
            sum += (bin.re * scale).powi(2);
            energy.push(sum);
        }
        let mut best = (BEFORE, f64::MIN);
        // From the microphone 50 ms ahead to 500 ms behind; of equals, the
        // first.
        for at in (0..=BEFORE + AFTER).rev() {
            let under = energy[at + length] - energy[at];
            let correlation =
                (cross[at].re * scale).abs() / (microphone_energy * under + 1e-30).sqrt();
            if correlation > best.1 {
                best = (at, correlation);
            }
        }
        best.0
    }
    /// The share of `microphone`'s speech-band power that `system`, already
    /// aligned with it, explains linearly.
    fn explained(&self, microphone: &[f32], system: &[f32]) -> f64 {
        let bins = WELCH / 2 + 1;
        let (microphone_mean, system_mean) = (mean(microphone), mean(system));
        let mut microphone_power = vec![0.0f64; bins];
        let mut system_power = vec![0.0f64; bins];
        let mut cross = vec![Complex::<f64>::default(); bins];
        let mut a = vec![Complex::<f64>::default(); WELCH];
        let mut b = vec![Complex::<f64>::default(); WELCH];
        for start in (0..=microphone.len() - WELCH).step_by(WELCH / 2) {
            for at in 0..WELCH {
                let window = self.window[at];
                a[at] = Complex::new(
                    (microphone[start + at] as f64 - microphone_mean) * window,
                    0.0,
                );
                b[at] = Complex::new((system[start + at] as f64 - system_mean) * window, 0.0);
            }
            self.welch.process(&mut a);
            self.welch.process(&mut b);
            for bin in 0..bins {
                microphone_power[bin] += a[bin].norm_sqr();
                system_power[bin] += b[bin].norm_sqr();
                cross[bin] += a[bin] * b[bin].conj();
            }
        }
        let (mut explained, mut total) = (0.0, 0.0);
        for bin in 0..bins {
            let hz = bin as f64 * RATE as f64 / WELCH as f64;
            if (BAND_HZ.0..=BAND_HZ.1).contains(&hz) {
                explained += cross[bin].norm_sqr() / (system_power[bin] + 1e-30);
                total += microphone_power[bin];
            }
        }
        (explained / (total + 1e-30)).min(1.0)
    }
}

/// The pieces the speech `regions` (start and end in ms) are judged in,
/// within `length_ms` of audio: each region, a long one in equal parts.
fn pieces(regions: &[(u64, u64)], length_ms: u64) -> Vec<(u64, u64)> {
    let mut pieces = Vec::new();
    for &(start, end) in regions {
        let end = end.min(length_ms);
        if start >= end {
            continue;
        }
        let count = (end - start).div_ceil(PIECE_MS);
        for index in 0..count {
            pieces.push((
                start + (end - start) * index / count,
                start + (end - start) * (index + 1) / count,
            ));
        }
    }
    pieces
}
/// The audio a piece is scored on: its own, or for a short piece 1.5 s
/// centred on it, moved to lie within the audio.
fn scored_span((start, end): (u64, u64), length_ms: u64) -> (u64, u64) {
    if end - start >= SHORT_MS {
        return (start, end);
    }
    let width = WIDENED_MS.min(length_ms);
    let from = ((start + end) / 2)
        .saturating_sub(width / 2)
        .min(length_ms - width);
    (from, from + width)
}
/// The audio to score a span of samples on: the microphone's, and the
/// system's from [`BEFORE`] samples before it to [`AFTER`] after it, silent
/// beyond the track's ends.
type Spans = (Vec<f32>, Vec<f32>);
/// Judges each piece of `regions`, on the audio `read` gives for a span.
fn judge_with(
    regions: &[(u64, u64)],
    length_ms: u64,
    read: &mut dyn FnMut(usize, usize) -> Result<Spans, String>,
) -> Result<Vec<Piece>, String> {
    let mut scorer = Scorer::new();
    pieces(regions, length_ms)
        .into_iter()
        .map(|(start_ms, end_ms)| {
            let (from, to) = scored_span((start_ms, end_ms), length_ms);
            let (microphone, system) = read(from as usize * PER_MS, to as usize * PER_MS)?;
            Ok(Piece {
                start_ms,
                end_ms,
                score: scorer.score(&microphone, &system),
            })
        })
        .collect()
}

/// A 16 kHz mono 16-bit file, read span by span.
struct SpeechFile {
    reader: hound::WavReader<std::io::BufReader<std::fs::File>>,
    length: usize,
}
impl SpeechFile {
    fn open(path: &Path) -> Result<Self, String> {
        let reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        if spec.channels != 1
            || spec.sample_rate != RATE
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err(format!(
                "{} is not 16 kHz mono 16-bit audio.",
                path.display()
            ));
        }
        let length = reader.duration() as usize;
        Ok(Self { reader, length })
    }
    /// Samples `from..to` in full scale, silent outside the file.
    fn span(&mut self, from: i64, to: i64) -> Result<Vec<f32>, String> {
        let mut samples = vec![0.0f32; (to - from).max(0) as usize];
        let first = from.clamp(0, self.length as i64);
        let last = to.clamp(first, self.length as i64);
        if first < last {
            self.reader.seek(first as u32).map_err(|e| e.to_string())?;
            let target = &mut samples[(first - from) as usize..(last - from) as usize];
            for (slot, sample) in target.iter_mut().zip(self.reader.samples::<i16>()) {
                *slot = sample.map_err(|e| e.to_string())? as f32 / 32768.0;
            }
        }
        Ok(samples)
    }
}

/// Judges the speech `regions` (start and end in ms) of the file
/// `microphone` against the file `system`, which holds the system audio of
/// the same span; both are 16 kHz mono 16-bit.
pub fn judge(
    microphone: &Path,
    system: &Path,
    regions: &[(u64, u64)],
) -> Result<Vec<Piece>, String> {
    let mut microphone = SpeechFile::open(microphone)?;
    let mut system = SpeechFile::open(system)?;
    let length_ms = (microphone.length / PER_MS) as u64;
    judge_with(regions, length_ms, &mut |from, to| {
        Ok((
            microphone.span(from as i64, to as i64)?,
            system.span(from as i64 - BEFORE as i64, (to + AFTER) as i64)?,
        ))
    })
}
/// The pieces that are still speech, neighbours joined again.
fn kept(pieces: &[Piece]) -> Vec<(u64, u64)> {
    let mut regions: Vec<(u64, u64)> = Vec::new();
    for piece in pieces.iter().filter(|piece| !piece.is_echo()) {
        match regions.last_mut() {
            Some(last) if last.1 == piece.start_ms => last.1 = piece.end_ms,
            _ => regions.push((piece.start_ms, piece.end_ms)),
        }
    }
    regions
}
/// Writes `microphone` again with the echo `pieces` silent and every other
/// sample as it was.
fn silence(microphone: &Path, pieces: &[Piece]) -> Result<(), String> {
    let mut reader = hound::WavReader::open(microphone).map_err(|e| e.to_string())?;
    let mut gated = microphone.as_os_str().to_owned();
    gated.push(".gated");
    let gated = std::path::PathBuf::from(gated);
    let mut writer = hound::WavWriter::create(&gated, reader.spec()).map_err(|e| e.to_string())?;
    let mut echo = pieces
        .iter()
        .filter(|piece| piece.is_echo())
        .map(|piece| {
            (
                piece.start_ms as usize * PER_MS,
                piece.end_ms as usize * PER_MS,
            )
        })
        .peekable();
    for (at, sample) in reader.samples::<i16>().enumerate() {
        let sample = sample.map_err(|e| e.to_string())?;
        while echo.next_if(|&(_, end)| end <= at).is_some() {}
        let silent = echo.peek().is_some_and(|&(start, _)| start <= at);
        writer
            .write_sample(if silent { 0 } else { sample })
            .map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    drop(reader);
    std::fs::rename(&gated, microphone).map_err(|e| e.to_string())
}
/// Silences in the file `microphone` every speech region of `regions`
/// (start and end in ms) that is echo of the file `system`, the system audio
/// of the same span; both are 16 kHz mono 16-bit. The file keeps its length,
/// and every sample outside those regions stays as it was. Returns the
/// regions that are still speech.
pub fn silence_echo(
    microphone: &Path,
    system: &Path,
    regions: &[(u64, u64)],
) -> Result<Vec<(u64, u64)>, String> {
    let pieces = judge(microphone, system, regions)?;
    if pieces.iter().any(Piece::is_echo) {
        silence(microphone, &pieces)?;
    }
    Ok(kept(&pieces))
}

/// Made-up audio for tests here and of the passes that use the gate.
#[cfg(test)]
pub(crate) mod made_up {
    use super::{PER_MS, RATE};
    use std::path::Path;

    /// `ms` of something like a voice: noise under a syllable rhythm, at
    /// about `dbfs`. Each `seed` is another voice saying something else.
    pub fn voice(seed: u64, ms: u64, dbfs: f32) -> Vec<f32> {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut noise = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 40) as f32 / (1u64 << 23) as f32 - 1.0
        };
        let level = 10f32.powf(dbfs / 20.0) * 6.3;
        let rhythm = 3.0 + (seed % 5) as f32 * 0.4;
        let mut previous = 0.0;
        (0..ms as usize * PER_MS)
            .map(|at| {
                let t = at as f32 / RATE as f32;
                let syllable = (std::f32::consts::TAU * rhythm * t + seed as f32)
                    .sin()
                    .max(0.0);
                // A little low-pass, as a voice has more below than above.
                previous = 0.6 * previous + 0.4 * noise();
                level * (0.15 + 0.85 * syllable) * previous
            })
            .collect()
    }
    /// What a microphone hears of `system` from the loudspeakers: `delay_ms`
    /// late (early when negative), `db` quieter and coloured by the room.
    pub fn heard(system: &[f32], delay_ms: i64, db: f32) -> Vec<f32> {
        let gain = 10f32.powf(-db / 20.0);
        let delay = delay_ms * PER_MS as i64;
        let room = [(0i64, 0.8f32), (5, 0.35), (11, -0.25), (40, 0.15)];
        (0..system.len() as i64)
            .map(|at| {
                room.iter()
                    .map(|&(tap, weight)| {
                        usize::try_from(at - delay - tap)
                            .ok()
                            .and_then(|from| system.get(from))
                            .map_or(0.0, |sample| weight * sample)
                    })
                    .sum::<f32>()
                    * gain
            })
            .collect()
    }
    pub fn quiet(ms: u64) -> Vec<f32> {
        vec![0.0; ms as usize * PER_MS]
    }
    pub fn mixed(a: &[f32], b: &[f32]) -> Vec<f32> {
        a.iter().zip(b).map(|(a, b)| a + b).collect()
    }
    /// Writes `samples` as the 16 kHz mono 16-bit file FFmpeg makes of a track.
    pub fn write(path: &Path, samples: &[f32]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer
                .write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)
                .unwrap();
        }
        writer.finalize().unwrap();
    }
    pub fn read(path: &Path) -> Vec<i16> {
        hound::WavReader::open(path)
            .unwrap()
            .samples()
            .map(Result::unwrap)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::made_up::*;
    use super::*;

    /// The verdict on each piece of `regions`, from audio in memory.
    fn judged(microphone: &[f32], system: &[f32], regions: &[(u64, u64)]) -> Vec<Piece> {
        let system_span = |from: i64, to: i64| -> Vec<f32> {
            (from..to)
                .map(|at| {
                    usize::try_from(at)
                        .ok()
                        .and_then(|at| system.get(at))
                        .copied()
                        .unwrap_or(0.0)
                })
                .collect()
        };
        let length_ms = (microphone.len() / PER_MS) as u64;
        judge_with(regions, length_ms, &mut |from, to| {
            Ok((
                microphone[from..to].to_vec(),
                system_span(from as i64 - BEFORE as i64, (to + AFTER) as i64),
            ))
        })
        .unwrap()
    }
    fn one(microphone: &[f32], system: &[f32], region: (u64, u64)) -> Piece {
        let pieces = judged(microphone, system, &[region]);
        assert_eq!(pieces.len(), 1);
        pieces[0]
    }
    fn score(piece: Piece) -> Score {
        piece.score.expect("enough audio to compare")
    }

    #[test]
    fn a_late_quiet_filtered_copy_of_the_system_audio_is_echo() {
        // A call at -20 dBFS; the microphone hears it 130 ms late, 20 dB
        // quieter and coloured by the room, over a little noise of its own.
        let call = voice(1, 6_000, -20.0);
        let microphone = mixed(&heard(&call, 130, 20.0), &voice(2, 6_000, -62.0));
        let piece = one(&microphone, &call, (1_000, 4_000));
        let found = score(piece);
        assert!(found.share >= 0.8, "{found:?}");
        assert_eq!(found.lag_ms, 130);
        assert!((-23.0..-17.0).contains(&found.system_dbfs), "{found:?}");
        assert!(piece.is_echo());
        // The delay the measured recording had at either end.
        for delay in [80, 176] {
            let microphone = heard(&call, delay, 20.0);
            let found = score(one(&microphone, &call, (1_000, 4_000)));
            assert!(found.is_echo() && found.lag_ms == delay, "{found:?}");
        }
    }

    #[test]
    fn unrelated_audio_is_kept() {
        // The reviewer speaks over a call heard on headphones: the
        // microphone holds nothing of the system audio.
        let call = voice(1, 6_000, -20.0);
        let reviewer = voice(3, 6_000, -30.0);
        let piece = one(&reviewer, &call, (1_000, 4_000));
        let found = score(piece);
        assert!(found.share < 0.15, "{found:?}");
        assert!(found.system_dbfs > ACTIVE_DBFS);
        assert!(!piece.is_echo());
    }

    #[test]
    fn the_reviewer_over_echo_is_kept() {
        // The echo arrives 20 dB below the call; the reviewer's own voice
        // is 7 dB above the echo, as measured.
        let call = voice(1, 6_000, -20.0);
        let echo = heard(&call, 130, 20.0);
        let microphone = mixed(&echo, &voice(3, 6_000, -33.0));
        let piece = one(&microphone, &call, (1_000, 4_000));
        let found = score(piece);
        assert!(
            found.share > 0.05 && found.share < ECHO_SHARE,
            "the echo is part of it, not most of it: {found:?}"
        );
        assert!(!piece.is_echo());
    }

    #[test]
    fn a_region_under_a_second_is_scored_on_a_wider_window() {
        assert_eq!(scored_span((2_000, 3_000), 10_000), (2_000, 3_000));
        assert_eq!(scored_span((2_000, 2_400), 10_000), (1_450, 2_950));
        // Moved to lie within the audio at either end, and never longer
        // than it.
        assert_eq!(scored_span((0, 300), 10_000), (0, 1_500));
        assert_eq!(scored_span((9_800, 10_000), 10_000), (8_500, 10_000));
        assert_eq!(scored_span((200, 600), 1_000), (0, 1_000));

        // 400 ms of a longer echo: echo, scored on the audio around it.
        let call = voice(1, 6_000, -20.0);
        let echo = heard(&call, 130, 20.0);
        assert!(one(&echo, &call, (2_000, 2_400)).is_echo());
        assert!(one(&echo, &call, (0, 300)).is_echo());
        // A short word of the reviewer's while the call talks is kept.
        let reviewer = voice(3, 6_000, -30.0);
        let short = one(&reviewer, &call, (2_000, 2_400));
        assert!(score(short).share < 0.2 && !short.is_echo(), "{short:?}");
        // With a few Welch segments any two signals look alike, so audio
        // too short to compare is never called echo.
        let piece = one(&echo[..200 * PER_MS], &call[..200 * PER_MS], (0, 200));
        assert_eq!(piece.score, None);
        assert!(!piece.is_echo());
    }

    #[test]
    fn a_silent_system_track_makes_nothing_echo() {
        let reviewer = voice(3, 6_000, -30.0);
        let piece = one(&reviewer, &quiet(6_000), (1_000, 4_000));
        assert!(score(piece).system_dbfs < -100.0 && !piece.is_echo());
        // System audio below -45 dBFS is not playing, even when the
        // microphone holds a copy of it.
        let faint = voice(1, 6_000, -55.0);
        let copy = heard(&faint, 130, -20.0);
        let piece = one(&copy, &faint, (1_000, 4_000));
        let found = score(piece);
        assert!(
            found.share >= ECHO_SHARE && found.system_dbfs < ACTIVE_DBFS,
            "{found:?}"
        );
        assert!(!piece.is_echo());
        // Silence on the microphone is not echo either.
        let call = voice(1, 6_000, -20.0);
        assert!(!one(&quiet(6_000), &call, (1_000, 4_000)).is_echo());
    }

    #[test]
    fn the_delay_is_searched_from_50_ms_ahead_to_500_ms_behind() {
        let call = voice(1, 8_000, -20.0);
        for delay in [-50, 0, 500] {
            let found = score(one(&heard(&call, delay, 20.0), &call, (2_000, 5_000)));
            assert!(found.is_echo(), "{delay} ms: {found:?}");
            assert_eq!(found.lag_ms, delay);
        }
        // Outside the search nothing lines up.
        for delay in [-300, 900] {
            let found = score(one(&heard(&call, delay, 20.0), &call, (2_000, 5_000)));
            assert!(!found.is_echo(), "{delay} ms: {found:?}");
        }
    }

    #[test]
    fn a_long_region_is_judged_in_pieces() {
        assert_eq!(pieces(&[(1_000, 16_000)], 60_000), [(1_000, 16_000)]);
        assert_eq!(
            pieces(&[(0, 500), (1_000, 31_000)], 60_000),
            [(0, 500), (1_000, 16_000), (16_000, 31_000)]
        );
        assert_eq!(
            pieces(&[(0, 40_000)], 60_000),
            [(0, 13_333), (13_333, 26_666), (26_666, 40_000)]
        );
        // A region running past the audio ends with it.
        assert_eq!(
            pieces(&[(4_000, 9_000), (9_500, 9_900)], 6_000),
            [(4_000, 6_000)]
        );

        // 20 s without a pause: the call's echo, then the reviewer's reply.
        let call = [voice(1, 10_000, -20.0), quiet(10_000)].concat();
        let microphone = [
            heard(&call[..10_000 * PER_MS], 130, 20.0),
            voice(3, 10_000, -30.0),
        ]
        .concat();
        let verdicts: Vec<_> = judged(&microphone, &call, &[(0, 20_000)])
            .iter()
            .map(|piece| (piece.start_ms, piece.end_ms, piece.is_echo()))
            .collect();
        assert_eq!(verdicts, [(0, 10_000, true), (10_000, 20_000, false)]);
    }

    #[test]
    fn silencing_keeps_the_length_and_the_other_samples() {
        let folder = tempfile::tempdir().unwrap();
        let (microphone_file, system_file) = (
            folder.path().join("speech.wav"),
            folder.path().join("system.wav"),
        );
        // The call talks from 1 to 4 s and from 9 to 12 s; the reviewer
        // answers from 5 to 8 s and says a word at 13 s.
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
        let room = voice(9, 15_000, -66.0);
        let microphone = mixed(&mixed(&heard(&call, 130, 20.0), &reviewer), &room);
        write(&microphone_file, &microphone);
        write(&system_file, &call);
        let before = read(&microphone_file);
        let regions = [
            (1_100, 4_150),
            (5_000, 8_000),
            (9_100, 12_150),
            (13_000, 13_600),
        ];
        let verdicts: Vec<_> = judge(&microphone_file, &system_file, &regions)
            .unwrap()
            .iter()
            .map(Piece::is_echo)
            .collect();
        assert_eq!(verdicts, [true, false, true, false]);
        let speech = silence_echo(&microphone_file, &system_file, &regions).unwrap();
        assert_eq!(speech, [(5_000, 8_000), (13_000, 13_600)]);

        let after = read(&microphone_file);
        assert_eq!(after.len(), before.len());
        let echo = |at: usize| {
            [(1_100, 4_150), (9_100, 12_150)]
                .iter()
                .any(|&(start, end)| (start * PER_MS..end * PER_MS).contains(&at))
        };
        for (at, (was, is)) in before.iter().zip(&after).enumerate() {
            assert_eq!(*is, if echo(at) { 0 } else { *was }, "sample {at}");
        }
        assert!(before[2_000 * PER_MS..3_000 * PER_MS]
            .iter()
            .any(|sample| *sample != 0));

        // Nothing to silence: the file is left alone.
        let own = folder.path().join("own.wav");
        write(&own, &reviewer);
        let untouched = std::fs::read(&own).unwrap();
        let speech = silence_echo(&own, &system_file, &[(5_000, 8_000)]).unwrap();
        assert_eq!(speech, [(5_000, 8_000)]);
        assert_eq!(std::fs::read(&own).unwrap(), untouched);
        // Neighbouring pieces of one region that both stay are one region.
        write(&own, &voice(3, 20_000, -30.0));
        write(&system_file, &quiet(20_000));
        assert_eq!(
            silence_echo(&own, &system_file, &[(0, 20_000)]).unwrap(),
            [(0, 20_000)]
        );
        // Only 16 kHz mono 16-bit audio is compared.
        let other = folder.path().join("other.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&other, spec).unwrap();
        writer.write_sample(0.5f32).unwrap();
        writer.finalize().unwrap();
        assert!(judge(&other, &system_file, &[(0, 10)])
            .unwrap_err()
            .contains("16 kHz"));
    }
}
