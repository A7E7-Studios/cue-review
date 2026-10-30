# Tasks: Transcribe a take while it is recorded and refine it after Stop

## 1. Stretches

- [x] 1.1 Read the detector's speech regions in milliseconds; test: src-tauri/src/transcribe.rs::tests::detector_regions_are_read_in_milliseconds
- [x] 1.2 Cut at pauses, never past 30 s; test: src-tauri/src/stretches.rs::tests::cuts_at_pauses_and_never_past_thirty_seconds
- [x] 1.3 Save, load and join stretches; test: src-tauri/src/stretches.rs::tests::stretches_join_without_gaps_or_overlaps
- [x] 1.4 Use saved stretches only when source, model and language match; Retry and `cue transcribe` forget them; test: src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match
- [x] 1.5 Update README.md (Retry, the take folder) ; test: node tools/gate/gate.mjs --local

## 2. The live worker (after 1)

- [x] 2.1 Audio from the end of the last stretch (`snapshot_audio_from`); test: cargo test --lib capture::
- [x] 2.2 Transcribe stretches with the language's model and guess the rest with base every cycle; test: src-tauri/src/stretches.rs::tests::actual_replay_shows_words_within_seconds
- [x] 2.3 Stop reuses them; test: src-tauri/src/stretches.rs::tests::actual_replay_finishes_within_seconds_of_stop
- [x] 2.4 Same words as a whole-take pass; test: src-tauri/src/stretches.rs::tests::actual_replay_matches_a_whole_take_pass
- [x] 2.5 Refine a take made from stretches after Stop, cancelled by a recording, Retry or a delete; test: src-tauri/src/transcribe.rs::tests::stop_s_stretches_are_refined_by_a_whole_take_pass
- [x] 2.6 The app reads a refined transcript again; test: src/App.test.tsx::reads the open transcript again once it is refined after Stop
- [x] 2.7 Live words, Stop and the refinement in the app; check: The transcript is ready seconds after Stop
- [x] 2.8 Update docs/ARCHITECTURE.md (live transcription) and README.md; test: node tools/gate/gate.mjs --local

## 3. The transcript column (independent of 1 and 2)

- [x] 3.1 Finished rows plain, `live-` words greyed in the live box with the new note; test: src/workspace/TranscriptPane.test.tsx::shows finished stretches as rows and greys only the words still being heard
- [x] 3.2 Stories for the live box with finished stretches; test: npm run build-storybook
- [x] 3.3 The look in the app; check: Words still being heard are greyed in the live box
- [x] 3.4 Update docs/DESIGN.md (transcript, live tail); test: node tools/gate/gate.mjs --local
