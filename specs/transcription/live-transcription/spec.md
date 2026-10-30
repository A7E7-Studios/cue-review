---
title: Live transcription
code:
  - src-tauri/src/lib.rs
  - src-tauri/src/transcribe.rs
  - src-tauri/src/stretches.rs
  - src-tauri/src/capture.rs
  - src-tauri/src/agent.rs
  - src/App.tsx
  - src/review.ts
  - src/workspace/TranscriptPane.tsx
---
# Live transcription

## Purpose

Turning speech into words while a take is being recorded, so the person sees what they said within
a few seconds, the take's transcript is there as soon as they stop, and its final words are as
accurate as transcribing the whole take.

## Requirements

### Requirement: Speech is transcribed while recording, so Stop leaves little to do
The app SHALL cut a take's speech into stretches while the recording goes on, transcribe each
finished stretch once with the language's model, and make the take's transcript from them at Stop,
because the person should not wait after Stop for the whole take to be transcribed. A stretch is
cut once 28 s of audio wait: at the last pause of at least 0.6 s between 10 and 30 s in; without
one, past 30 s, in the middle of the longest gap of at least 0.2 s, the silence before the first
word included; else at 30 s. Audio without speech is skipped, all but its last second.

#### Scenario: The transcript is ready seconds after Stop
- **GIVEN** a take recorded with a PC microphone or system audio, of any length
- **WHEN** the person stops recording
- **THEN** the take's transcript is ready within 5 seconds on the reference PC (Ryzen 9 9950X)
- **PROOF** test: src-tauri/src/stretches.rs::tests::actual_replay_finishes_within_seconds_of_stop
- **PROOF** desk: open

#### Scenario: Every spoken word appears once
- **GIVEN** a take whose speech was cut into several stretches
- **WHEN** its transcript is made from them
- **THEN** it holds the words of every stretch in order, none doubled at a cut
- **PROOF** test: src-tauri/src/stretches.rs::tests::stretches_join_without_gaps_or_overlaps
- **PROOF** test: src-tauri/src/stretches.rs::tests::cuts_at_pauses_and_never_past_thirty_seconds
- **PROOF** test: src-tauri/src/stretches.rs::tests::actual_replay_matches_a_whole_take_pass

#### Scenario: Retry transcribes the whole take again
- **GIVEN** a take whose stretches were transcribed while recording
- **WHEN** the person chooses Retry, or `cue transcribe` runs
- **THEN** the whole take is transcribed again from its audio, ignoring the stretches
- **PROOF** test: src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match
- **PROOF** test: src-tauri/src/lib.rs::orchestration_tests::retry_forgets_stretches_and_refinements_stop_only_for_their_recording
- **PROOF** test: src-tauri/src/agent.rs::tests::transcribing_a_session_with_takes_again_settles_every_take

#### Scenario: A take without live audio is transcribed after Stop
- **GIVEN** a take with only device audio, or whose saved stretches are missing, damaged or made
  with another model, language or audio file
- **WHEN** the take stops
- **THEN** the whole take is transcribed after Stop
- **PROOF** test: src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match
- **PROOF** test: src-tauri/src/transcribe.rs::tests::the_audio_a_take_is_transcribed_from

### Requirement: A transcript made from stretches is refined after Stop
The app SHALL transcribe each take whose transcript came from stretches once more as a whole, in
the background after Stop, and replace its words, and SHALL give that up when any recording starts,
or Retry runs or a delete starts for that recording, because stretches made about 4 points more word errors than
a whole-take pass on a five-minute review.

#### Scenario: The words improve shortly after Stop
- **GIVEN** a take whose transcript was made from stretches at Stop
- **WHEN** nothing is recorded for the next while
- **THEN** the take is transcribed as a whole in the background and the shown transcript is replaced
  by its words
- **PROOF** test: src-tauri/src/transcribe.rs::tests::stop_s_stretches_are_refined_by_a_whole_take_pass
- **PROOF** test: src/App.test.tsx::reads the open transcript again once it is refined after Stop
- **PROOF** test: src-tauri/src/lib.rs::orchestration_tests::retry_forgets_stretches_and_refinements_stop_only_for_their_recording
- **PROOF** desk: open

### Requirement: The words being spoken appear within a few seconds
The app SHALL guess the words after the last finished stretch about every second and show them,
greyed in the live box with the caret, below the finished stretches, which show as ordinary rows
that no longer change while recording, because the person wants to see that they are heard without
the words they already said shifting around.

#### Scenario: Live words follow the speaker
- **GIVEN** a recording with a PC microphone
- **WHEN** the person speaks
- **THEN** their words appear in the live box about three seconds after they are said, or sooner,
  on the reference PC
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
