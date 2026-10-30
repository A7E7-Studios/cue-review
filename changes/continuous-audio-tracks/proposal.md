---
title: Record audio tracks without holes
capabilities:
  - capture/audio-tracks
review: unreviewed
---
# Record audio tracks without holes

## Why

The owner's microphone crackles in every CueReview recording and is clean in Ableton on the same
microphone. The app placed each audio packet by its capture timestamp at the nominal sample rate,
so a device whose clock runs slow left a short run of zeros between packets, and one that ran
ahead had samples dropped. With the owner's webcam microphone that cut a hole of about 38 samples
(about 0.8 ms) every 120 ms: 134 holes in 16 s, about 0.67% of the track, heard as crackle.

- Evidence: `evidence/cuereview-mic-spectrum-clicks.png`, the spectrum of the CueReview
  `mic.wav` (session `3eb5275d-93e9-4a44-97e7-730953652ce3`), each hole a full-height line;
  `evidence/ableton-mic-spectrum-clean.png`, the same microphone in Ableton, with none. The owner:
  "Ableton one is much better than the crackling one".

## What changes

- Each track is written back to back, as the device delivers it: "A microphone whose clock drifts
  and jitters is recorded".
- When the take stops, each track is resampled once to the take's length by the wall clock, so the
  audio stays in step with the video and a device's clock error becomes an inaudible pitch change:
  "A drifting microphone track is stretched to the take's length".
- A gap of more than 50 ms between packets stays silence of the gap's length: "System audio is
  silent for a while".
- Muting still writes silence of the same length: "The microphone is muted for part of a take".

## Settled questions

- **Direction (agreed before the rounds)**: write the samples back to back; at stop, resample the
  whole track once to the take's wall-clock duration so A/V sync holds and the drift becomes an
  inaudible pitch change; zero-pad only real gaps (over about 50 ms, a device glitch); keep mute
  writing silence; test with synthetic drifting and jittering timestamps (no short zero runs, the
  right length). Rejected: keeping timestamp placement and smoothing the holes; padding by a
  running drift estimate.
- **Q4 Attended run**: the agent re-measures with a 20 s attended recording (`cue record` from a
  build of this branch, an isolated data folder), counting holes with the A/B script. Rejected: the
  owner records it; synthetic tests only.
- **Q8 Summary**: confirmed as above. Existing recordings stay as they are.

## Calls for the owner

- The stretch ratio is measured from the packets' own timestamps over the runs of audio between
  gaps, and each run is placed at its own start by the wall clock, with silence between runs and
  after the last one up to the take's length. The alternative, stretching all written samples to
  the take's length, would also stretch a device that died near the end over the whole track, and
  a gap sized by the drift measured so far would shift everything after it. Reversing it means
  rewriting `AudioWriter::finish`.
- A ratio more than 5% from 1 is treated as broken timestamps: the track is then padded or trimmed
  to the take's length without resampling. No real audio clock is that far off.
- The resampler is a windowed-sinc filter written in `capture.rs` (32 taps, a precomputed table),
  not a new crate: the ratio is always within a few percent of 1 and the code stays testable without
  a device. Stopping a one-hour take spends a few more seconds resampling.

## Out of scope

- Repairing recordings made before this change: their holes are lost samples.
- The live transcript's snapshots, which read the track while it records and are replaced by the
  final transcript.
