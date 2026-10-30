---
title: Live transcription
code:
  - src-tauri/src/lib.rs
  - src-tauri/src/transcribe.rs
  - src-tauri/src/stretches.rs
  - src/workspace/TranscriptPane.tsx
  - src/workspace/transcript.css
---
# Live transcription

## Purpose

Turning speech into words while a take is being recorded, so the person sees what they said within
a couple of seconds and the take's transcript is ready almost as soon as they stop.

## Requirements

### Requirement: Speech is transcribed once, while recording
The app SHALL cut a take's speech into stretches at pauses of at least 0.6 s (at most 30 s each),
transcribe each finished stretch once with the language's model while the recording goes on, and
keep those words as the take's transcript, because the person should not wait after Stop for the
whole take to be transcribed again.

#### Scenario: The transcript is ready seconds after Stop
- **GIVEN** a take recorded with a PC microphone or system audio, of any length
- **WHEN** the person stops recording
- **THEN** the take's transcript is ready within 5 seconds on the reference PC (Ryzen 9 9950X)
- **PROOF** test: src-tauri/src/stretches.rs::tests::actual_replay_finishes_within_seconds_of_stop
- **PROOF** desk: open

#### Scenario: Every spoken word appears once
- **GIVEN** a take whose speech was cut into several stretches
- **WHEN** its transcript is ready
- **THEN** it holds the words of every stretch in order, none skipped and none doubled at a cut
- **PROOF** test: src-tauri/src/stretches.rs::tests::stretches_join_without_gaps_or_overlaps
- **PROOF** test: src-tauri/src/stretches.rs::tests::actual_replay_matches_a_whole_take_pass

#### Scenario: Retry transcribes the whole take again
- **GIVEN** a take whose stretches were transcribed while recording
- **WHEN** the person chooses Retry, or `cue transcribe` runs
- **THEN** the whole take is transcribed again from its audio, ignoring the stretches
- **PROOF** test: src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match

#### Scenario: A take without live audio is transcribed after Stop
- **GIVEN** a take with only device audio, or whose saved stretches are missing, damaged or made
  with another model, language or audio file
- **WHEN** the take stops
- **THEN** the whole take is transcribed after Stop
- **PROOF** test: src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match

### Requirement: The words being spoken appear within about two seconds
The app SHALL re-guess the words after the last finished stretch about every two seconds and show
them, greyed in the live box with the caret, below the finished stretches, which show as ordinary
rows that no longer change, because the person wants to see that they are heard without the words
they already said shifting around.

#### Scenario: Live words follow the speaker
- **GIVEN** a recording with a PC microphone
- **WHEN** the person speaks
- **THEN** their words appear in the live box about two seconds after they are said, on the
  reference PC
- **PROOF** test: src-tauri/src/stretches.rs::tests::actual_replay_shows_words_within_seconds
- **PROOF** desk: open

#### Scenario: Words still being heard are greyed in the live box
- **GIVEN** a take with finished stretches and words still being heard
- **WHEN** the transcript shows them
- **THEN** finished stretches are ordinary rows with their time, and only the words still being
  heard sit in the live box, greyed, with the caret and the note "Grey words are still being heard
  and may change."
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::shows finished stretches as rows and greys only the words still being heard
- **PROOF** desk: open
