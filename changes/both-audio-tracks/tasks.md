# Tasks: Transcribe the system audio beside the microphone

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. The echo gate

- [ ] 1.1 `echo.rs`: the share of a microphone region's speech-band power the system audio explains, with the lag search and the widened window for short regions; test: src-tauri/src/echo.rs::tests
- [ ] 1.2 Silence the echo regions of a microphone speech file, keeping its length; test: src-tauri/src/echo.rs::tests
- [ ] 1.3 Add `rustfft` and its licence to the app's licence list in README.md; test: node tools/gate/gate.mjs --local

## 2. Two tracks through the passes (after 1)

- [ ] 2.1 `track` on a segment and `trackLanguages` on the transcript and take marks, read and written; test: src-tauri/src/transcribe.rs::tests::rows_of_two_tracks_are_merged_by_time
- [ ] 2.2 Whole-take passes per track, the system track first, the microphone through the echo gate, merged by time; test: src-tauri/src/transcribe.rs::tests::a_take_with_two_tracks_is_transcribed_from_both
- [ ] 2.3 Each track detected on its own; test: src-tauri/src/transcribe.rs::tests::each_track_is_detected_on_its_own
- [ ] 2.4 Echo left out and own speech kept through a pass; test: src-tauri/src/transcribe.rs::tests::microphone_speech_that_matches_the_system_audio_is_left_out
- [ ] 2.5 The ignored test with two installed voices; test: src-tauri/src/transcribe.rs::tests::actual_speaker_echo_is_transcribed_once
- [ ] 2.6 Retry and `cue transcribe` read both tracks of an earlier recording; test: src-tauri/src/agent.rs::tests::transcribing_again_reads_both_tracks
- [ ] 2.7 `cue transcript` reports each row's track in JSON, text and segments; test: src-tauri/src/agent.rs::tests::the_transcript_reports_each_row_s_track
- [ ] 2.8 Update README.md (`cue transcript`) and docs/ARCHITECTURE.md (Local transcription) to state what the code does; test: node tools/gate/gate.mjs --local

## 3. Two tracks while recording (after 2)

- [ ] 3.1 A copy of either live track from a point; test: src-tauri/src/capture.rs::tests
- [ ] 3.2 One stretch state and stretches file per track, the worker's order and the guess schedule; test: src-tauri/src/stretches.rs::tests
- [ ] 3.3 The live transcript carries both tracks' rows and one guess per side; test: cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
- [ ] 3.4 The ignored replay test of two tracks; test: src-tauri/src/stretches.rs::tests::actual_replay_of_two_tracks_finishes_within_seconds_of_stop
- [ ] 3.5 Update docs/ARCHITECTURE.md and docs/VERIFICATION.md to state what the code does; test: node tools/gate/gate.mjs --local

## 4. The transcript (after 2, to the picked look)

- [ ] 4.1 Microphone rows on the right side with their time gutter, system rows as today, nothing on one-track takes; test: src/workspace/TranscriptPane.test.tsx::marks each row of a two-track take with its track
- [ ] 4.2 The track tag on hover and focus, and the track in each time button's accessible name; test: src/workspace/TranscriptPane.test.tsx::names a row's track on hover and focus and to a screen reader
- [ ] 4.3 One live box per side while recording, and the two languages on the take line; test: src/workspace/TranscriptPane.test.tsx
- [ ] 4.4 Stories and fixtures for the new states, and the spec's looks rendered; check: Rows are marked as microphone or computer audio
- [ ] 4.5 Update docs/DESIGN.md (transcript) to state what the code does; test: npm test
