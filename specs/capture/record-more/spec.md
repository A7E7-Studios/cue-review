---
title: Record more
code:
  - src-tauri/src/takes.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/models.rs
  - src-tauri/src/store.rs
  - src/app/media.ts
  - scripts/verify-takes.cjs
---
# Record more

## Purpose

Record more continues a finished session as a new take, from any display, window or device. Each
take keeps its own video, and the session plays, transcribes and hands its takes to an agent as one
continuous timeline.

## Requirements

### Requirement: Record more records the source chosen for it
The app SHALL record a new take from the source chosen for it, whatever the session's earlier takes
recorded, because a reviewer continues a review in another window, on another display or on a
device, and the window first recorded may have closed.

#### Scenario: Recording more from another source
- **GIVEN** a ready session recorded from Display 1
- **WHEN** the reviewer chooses a window and selects Record more
- **THEN** take 2 records that window into its own folder, starting on the session timeline where
  take 1 ends
- **AND** take 2 stores the window's source id
- **PROOF** test: src-tauri/src/lib.rs::orchestration_tests::record_more_records_the_source_it_is_given
- **PROOF** test: src-tauri/src/takes.rs::tests::record_more_starts_a_take_and_restores_the_session_on_failure
- **PROOF** test: scripts/verify-takes.cjs
- **PROOF** desk: open

### Requirement: Each take keeps its own video
The app SHALL keep each take's video as its take recorded it, in the take's own folder, and place
it on the session timeline after the takes before it, without joining, re-encoding or replacing
any video, because takes of different sources differ in size, and joining them cost a second copy
of the recording and failed while a player held the file.

#### Scenario: Stopping a take
- **GIVEN** take 2 recording after a take 1 of 1:12
- **WHEN** the reviewer selects Stop
- **THEN** take 2's video stays in its folder, take 1's video is unchanged, and the session lists
  both videos, take 2's starting at 1:12
- **AND** the session lasts both takes together and only take 2 is transcribed, its words placed
  from 1:12
- **PROOF** test: src-tauri/src/takes.rs::tests::stopping_a_take_keeps_its_own_video_on_the_timeline
- **PROOF** test: src-tauri/src/takes.rs::tests::videos_place_each_take_on_the_timeline
- **PROOF** test: scripts/verify-takes.cjs
- **PROOF** desk: open

#### Scenario: The app closes while a take finishes
- **GIVEN** take 2 finishing its video when the app closes
- **WHEN** the app starts again
- **THEN** a take whose video was finished is on the timeline, its transcript left to Retry
- **AND** a take without a usable video is interrupted, its files kept, and the earlier takes play
  as before
- **PROOF** test: src-tauri/src/takes.rs::tests::recovery_repairs_each_take_state

### Requirement: Sessions saved with joined takes keep playing
The app SHALL read a session saved before takes kept their own videos as one video, `video.mp4`,
for its whole timeline, and give a take recorded later a video of its own after it, because those
sessions' takes are already joined in `video.mp4` and their own copies are gone.

#### Scenario: A session whose takes were joined
- **GIVEN** a session saved with takes 1 to 3 joined into its `video.mp4`
- **WHEN** the app or the `cue` CLI reads it
- **THEN** `video.mp4` plays takes 1 to 3
- **AND** a take recorded now gets its own video, starting where `video.mp4` ends
- **PROOF** test: src-tauri/src/takes.rs::tests::a_session_with_joined_takes_keeps_its_video

#### Scenario: A take that was waiting to be joined
- **GIVEN** a session saved while take 2 still waited to be joined into `video.mp4`
- **WHEN** the app starts, or an agent runs `cue transcribe` on it
- **THEN** take 2 plays from its own video, or from `video.mp4` when it was already joined, and
  Retry transcribes it
- **AND** the files left from joining it are deleted
- **PROOF** test: src-tauri/src/takes.rs::tests::recovery_upgrades_a_take_waiting_to_be_joined

#### Scenario: A session saved by a newer CueReview
- **GIVEN** a session whose `formatVersion` is above 2
- **WHEN** the app or the `cue` CLI reads it
- **THEN** it is refused with a message to update CueReview, and its files are left as they are
- **PROOF** test: src-tauri/src/store.rs::tests::a_session_of_a_newer_format_is_refused
