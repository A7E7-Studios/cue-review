# Tasks: Record more from any source and keep each take's video

## 1. Session format and takes (backend)

- [ ] 1.1 `Session.formatVersion` and `Session.videos`, refused above 2; test: src-tauri/src/store.rs::tests::a_session_of_a_newer_format_is_refused
- [ ] 1.2 `takes::videos` and `takes::video_at`; test: src-tauri/src/takes.rs::tests::videos_place_each_take_on_the_timeline, src-tauri/src/takes.rs::tests::video_at_picks_the_take_video_by_session_time
- [ ] 1.3 `begin` with a source id, `finish_capture` placing the take's own video, no swap; test: src-tauri/src/takes.rs::tests::stopping_a_take_keeps_its_own_video_on_the_timeline
- [ ] 1.4 Joined sessions and the upgrade of a waiting take in `recover`; test: src-tauri/src/takes.rs::tests::a_session_with_joined_takes_keeps_its_video, src-tauri/src/takes.rs::tests::recovery_upgrades_a_take_waiting_to_be_joined, src-tauri/src/takes.rs::tests::recovery_repairs_each_take_state
- [ ] 1.5 `record_more` takes a source id, no identity check; `run_take` without the swap; test: src-tauri/src/lib.rs::orchestration_tests::record_more_records_the_source_it_is_given
- [ ] 1.6 `discard` refuses every take; the app's `discard_take` goes; test: src-tauri/src/takes.rs::tests::discarding_refuses_every_take

## 2. The CLI (after 1)

- [ ] 2.1 Frames from the take video by time; test: src-tauri/src/agent.rs::tests::actual_frames_come_from_each_take_video
- [ ] 2.2 Clips refused across a boundary; test: src-tauri/src/agent.rs::tests::a_clip_across_a_take_boundary_is_refused
- [ ] 2.3 The cursor against a take's own frame; test: src-tauri/src/cursor.rs::tests::a_take_with_its_own_video_maps_to_its_own_size
- [ ] 2.4 Help and handoff text; test: src-tauri/src/cli.rs::tests::frame_help_names_the_take_video

## 3. The app (after 1)

- [ ] 3.1 `videoAt` and the take video list in `media.ts`; test: src/app/media.test.ts::videoAt picks the take video by session time
- [ ] 3.2 The player switches take videos; test: src/App.test.tsx::take playback plays on from one take's video into the next, src/App.test.tsx::take playback seeks into another take's video from the scrubber and the transcript
- [ ] 3.3 The review bar unlocked, Record more passing its source; Discard take goes; test: src/App.test.tsx::record more records more from the bar under the playback controls, with the source and microphone chosen there
- [ ] 3.4 Looks for the changed recording-dock scenarios; check: Recording more from the bar

## 4. Docs and scripts (after 2 and 3)

- [ ] 4.1 `scripts/verify-takes.cjs` records take 2 from a second window and checks both videos; check: Stopping a take
- [ ] 4.2 Update docs/ARCHITECTURE.md (Takes, Agent CLI), docs/VERIFICATION.md and README.md; test: node tools/gate/gate.mjs --local
