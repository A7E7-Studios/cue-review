# Tasks: Transcribe a take once, while it is recorded

## 1. Stretches

- [ ] 1.1 Read the detector's speech regions in milliseconds; test: src-tauri/src/transcribe.rs::tests::detector_regions_are_read_in_milliseconds
- [ ] 1.2 Cut at pauses, never past 30 s; test: src-tauri/src/stretches.rs::tests::cuts_at_pauses_and_never_past_thirty_seconds
- [ ] 1.3 Save, load and join stretches; test: src-tauri/src/stretches.rs::tests::stretches_join_without_gaps_or_overlaps
- [ ] 1.4 Use saved stretches only when source, model and language match; Retry and `cue transcribe` forget them; test: src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match
- [ ] 1.5 Update README.md (Retry, the take folder) ; test: node tools/gate/gate.mjs --local

## 2. The live worker (after 1)

- [ ] 2.1 Audio from the end of the last stretch (`snapshot_audio_from`); test: cargo test --lib capture::
- [ ] 2.2 Transcribe stretches with the language's model and guess the rest with base every cycle; test: src-tauri/src/stretches.rs::tests::actual_replay_shows_words_within_seconds
- [ ] 2.3 Stop reuses them; test: src-tauri/src/stretches.rs::tests::actual_replay_finishes_within_seconds_of_stop
- [ ] 2.4 Same words as a whole-take pass; test: src-tauri/src/stretches.rs::tests::actual_replay_matches_a_whole_take_pass
- [ ] 2.5 Live words and Stop in the app; check: The transcript is ready seconds after Stop
- [ ] 2.6 Update docs/ARCHITECTURE.md (live transcription) and README.md; test: node tools/gate/gate.mjs --local

## 3. The transcript column (independent of 1 and 2)

- [ ] 3.1 Finished rows plain, `live-` words greyed in the live box with the new note; test: src/workspace/TranscriptPane.test.tsx::shows finished stretches as rows and greys only the words still being heard
- [ ] 3.2 Stories for the live box with finished stretches; test: npm run build-storybook
- [ ] 3.3 The look in the app; check: Words still being heard are greyed in the live box
- [ ] 3.4 Update docs/DESIGN.md (transcript, live tail); test: node tools/gate/gate.mjs --local
