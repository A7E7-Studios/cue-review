---
title: Audio tracks
code:
  - src-tauri/src/capture.rs
---
# Audio tracks

## Purpose

While a take records, the app writes the microphone and the system audio each to a track of its
own, so the review sounds as it was spoken and stays in step with the video.

## Requirements

### Requirement: A track is continuous
The app SHALL write the samples a device delivers back to back, inserting no silence between
packets and dropping none, because a short hole every few packets is heard as crackle.

#### Scenario: A microphone whose clock drifts and jitters is recorded
- **GIVEN** a microphone whose packets carry timestamps that drift up to 1% from its nominal rate
  and jitter by a few milliseconds
- **WHEN** a take records it
- **THEN** its track holds no run of silence that the microphone did not deliver
- **AND** a recording of speech on the owner's microphone sounds as clean as the same microphone in
  Ableton
- **PROOF** test: src-tauri/src/capture.rs::tests::drifting_jittering_audio_has_no_holes
- **PROOF** desk: open

### Requirement: A track lasts as long as its take
The app SHALL resample each track once when its take stops, so that it is exactly as long as the
take by the wall clock and starts where it started, because a device's clock error would otherwise
move the audio out of step with the video.

#### Scenario: A drifting microphone track is stretched to the take's length
- **GIVEN** a 20 s take whose microphone delivered 1% fewer samples than its nominal rate
- **WHEN** the take stops
- **THEN** the microphone track is 20 s long to the sample
- **AND** a sound made 15 s into the take is within 5 ms of 15 s in the track
- **PROOF** test: src-tauri/src/capture.rs::tests::drifting_audio_is_resampled_to_the_take_length

### Requirement: A real gap stays a gap
The app SHALL fill a gap of more than 50 ms between two packets with silence of the gap's length,
because a device that stops delivering, after a glitch or as system audio does while nothing plays,
would otherwise pull everything after it early.

#### Scenario: System audio is silent for a while
- **GIVEN** system audio that delivers no packets for 2 s in the middle of a take
- **WHEN** the take stops
- **THEN** its track is silent for those 2 s
- **AND** the sound after them is where it was played
- **PROOF** test: src-tauri/src/capture.rs::tests::a_gap_over_50_ms_stays_silence

### Requirement: Muting writes silence
The app SHALL write silence in place of the microphone's samples while it is muted, because the
track keeps its length and its place in the take.

#### Scenario: The microphone is muted for part of a take
- **WHEN** the person mutes the microphone for 1 s during a take
- **THEN** the microphone track is silent for that second
- **AND** the track keeps the take's length
- **PROOF** test: src-tauri/src/capture.rs::tests::muted_audio_is_silent_and_keeps_its_length
