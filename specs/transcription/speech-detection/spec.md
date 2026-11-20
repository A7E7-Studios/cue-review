---
title: Speech detection
code:
  - src-tauri/src/transcribe.rs
---
# Speech detection

## Purpose

A local detector finds where a take's audio holds speech, so that the transcript keeps what was
said and leaves out the text the speech model makes up over silence and noise.

## Requirements

### Requirement: Rows made up over silence are left out
The app SHALL leave out of a take's transcript every row of which less than a tenth lies within one
second of the speech the detector found in the same audio, for every speech model and both tracks,
whenever a whole take is transcribed: after Stop, in the pass that refines it, on Retry and by
`cue transcribe`, because the speech model writes text over silence and noise, the larger model
most of all, and such rows read as things someone said.

#### Scenario: Text made up over silence is left out
- **GIVEN** a take in which the microphone is silent for half a minute, and the speech model writes
  "Vielen Dank." over that silence
- **WHEN** the take is transcribed again, on Retry or by `cue transcribe`
- **THEN** the transcript has no row in that half minute, and the rows of the speech around it are
  kept
- **PROOF** test: src-tauri/src/transcribe.rs::tests::a_row_is_kept_by_its_share_of_detected_speech
- **PROOF** test: src-tauri/src/transcribe.rs::tests::rows_over_silence_are_left_out_of_a_take
- **PROOF** desk: open

#### Scenario: Both tracks are cleaned alike
- **GIVEN** a take recorded with a microphone and system audio, and the speech model writes text
  over a silent stretch of each track
- **WHEN** the take is transcribed
- **THEN** neither track has a row in its silent stretch
- **PROOF** test: src-tauri/src/transcribe.rs::tests::rows_over_silence_are_left_out_of_both_tracks

#### Scenario: A short reply beside speech is kept
- **GIVEN** a take in which the reviewer answers "Ja." within a second of speech the detector found
- **WHEN** the take is transcribed
- **THEN** "Ja." is in the transcript
- **PROOF** test: src-tauri/src/transcribe.rs::tests::a_row_is_kept_by_its_share_of_detected_speech

#### Scenario: The speech model's own output keeps every row
- **GIVEN** a take whose transcript left out a row made up over silence
- **WHEN** a person or an agent opens the take's raw speech-model output, `whisper.json` or
  `whisper-system.json`
- **THEN** the row left out is still there
- **PROOF** test: src-tauri/src/transcribe.rs::tests::the_raw_output_keeps_the_rows_left_out
