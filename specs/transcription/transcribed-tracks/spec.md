---
title: Transcribed tracks
code:
  - src-tauri/src/transcribe.rs
  - src-tauri/src/stretches.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/capture.rs
  - src-tauri/src/takes.rs
  - src-tauri/src/models.rs
  - src-tauri/src/agent.rs
  - src/backend.ts
  - src/workspace/TranscriptPane.tsx
---
# Transcribed tracks

## Purpose

A take recorded with both the microphone and the computer's audio gets a transcript of both: what
the reviewer said and what the call or the app played, each row marked with where it was heard,
and nothing written twice because the microphone also heard the speakers.

## Requirements

### Requirement: Both tracks of a take are transcribed, each on its own
The app SHALL transcribe the microphone track and the system audio track of a take separately,
while it records and after Stop, and merge their rows by time into one transcript, because the
people on a call are clear only in the system audio and the reviewer only in the microphone, and a
transcript of one track loses the other half of the conversation.

#### Scenario: The reviewer and the call are both in the transcript
- **GIVEN** a take recorded with a microphone and system audio, in which the reviewer speaks and a
  call answers
- **WHEN** the take is transcribed
- **THEN** its transcript holds the reviewer's words from the microphone and the call's words from
  the system audio, in the order they were spoken
- **PROOF** test: src-tauri/src/transcribe.rs::tests::a_take_with_two_tracks_is_transcribed_from_both
- **PROOF** test: src-tauri/src/transcribe.rs::tests::rows_of_two_tracks_are_merged_by_time
- **PROOF** desk: open

#### Scenario: Both tracks are ready seconds after Stop
- **GIVEN** a take of any length recorded with a microphone and system audio
- **WHEN** the person stops recording
- **THEN** the transcript of both tracks is ready within 5 seconds on the reference PC (Ryzen 9
  9950X)
- **PROOF** test: src-tauri/src/stretches.rs::tests::actual_replay_of_two_tracks_finishes_within_seconds_of_stop
- **PROOF** desk: open

#### Scenario: A take with one track is transcribed as before
- **GIVEN** a take recorded with only a microphone, or only system audio
- **WHEN** the take is transcribed
- **THEN** its transcript is made from that track, and its rows carry no track mark
- **PROOF** test: src-tauri/src/transcribe.rs::tests::the_audio_a_take_is_transcribed_from

#### Scenario: The reviewer and the call speak different languages
- **GIVEN** the language is Auto, and a take in which the call speaks German and the reviewer
  English
- **WHEN** the take is transcribed
- **THEN** the system audio is transcribed as German and the microphone as English
- **PROOF** test: src-tauri/src/transcribe.rs::tests::each_track_is_detected_on_its_own
- **PROOF** desk: open

#### Scenario: An earlier recording gains the call on Retry
- **GIVEN** a take recorded with both tracks whose transcript was made from the microphone alone
- **WHEN** the person chooses Retry, or `cue transcribe` runs
- **THEN** its transcript is made again from both tracks
- **PROOF** test: src-tauri/src/agent.rs::tests::transcribing_again_reads_both_tracks
- **PROOF** desk: open

### Requirement: Each row says where it was heard
The app SHALL show each row of a take transcribed from two tracks as heard on the microphone or in
the computer's audio, by the side it sits on and by name on demand, and `cue transcript` SHALL
report the same, because the reviewer's remarks
and what the call or the reviewed app said mean different things to the person reading and to the
agent acting on the review.

#### Scenario: Rows are marked as microphone or computer audio
- **GIVEN** a take transcribed from two tracks
- **WHEN** its transcript is shown
- **THEN** computer-audio rows sit on the left with their time on the left, and microphone rows
  are set in from the left with their time on the right, with no other mark on a row
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::marks each row of a two-track take with its track
- **PROOF** desk: open

#### Scenario: A row names its track on demand
- **GIVEN** a take transcribed from two tracks
- **WHEN** the person hovers a row, or moves keyboard focus into it
- **THEN** a tag above the row names its track, "Microphone" or "Computer audio", and its language
  when the two tracks differ, without moving any text
- **AND** a screen reader hears the track with the row's time
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::names a row's track on hover and focus and to a screen reader
- **PROOF** desk: open

#### Scenario: An agent reads each row's track
- **GIVEN** a take transcribed from two tracks
- **WHEN** an agent runs `cue transcript` for it
- **THEN** each row carries its track, `microphone` or `system`, in the JSON output, and the text
  output names the track at the start of each row
- **PROOF** test: src-tauri/src/agent.rs::tests::the_transcript_reports_each_row_s_track

### Requirement: What the microphone heard from the speakers is left out
The app SHALL leave out microphone speech whose sound matches the system audio of the same moment,
because a call played through loudspeakers is otherwise written twice, once clearly from the system
audio and once badly as the microphone heard it.

#### Scenario: A call played through speakers appears once
- **GIVEN** a take in which the microphone picked up the call from the loudspeakers
- **WHEN** the take is transcribed
- **THEN** the call's words appear once, as computer audio, and not again as microphone rows
- **PROOF** test: src-tauri/src/transcribe.rs::tests::microphone_speech_that_matches_the_system_audio_is_left_out
- **PROOF** test: src-tauri/src/transcribe.rs::tests::actual_speaker_echo_is_transcribed_once
- **PROOF** desk: open

#### Scenario: The reviewer's own words are kept
- **GIVEN** a take in which the microphone picked up the call from the loudspeakers
- **WHEN** the reviewer speaks while the call is silent
- **THEN** the reviewer's words are in the transcript as microphone rows
- **PROOF** test: src-tauri/src/transcribe.rs::tests::microphone_speech_without_a_match_is_kept
- **PROOF** desk: open

#### Scenario: A reviewer on headphones loses nothing
- **GIVEN** a take recorded with headphones, so the microphone hears none of the system audio
- **WHEN** the reviewer and the call speak at the same time
- **THEN** both are in the transcript, each on its own track
- **PROOF** test: src-tauri/src/transcribe.rs::tests::microphone_speech_without_a_match_is_kept
