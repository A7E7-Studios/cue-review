---
title: Take frames
code:
  - src-tauri/src/agent.rs
  - src-tauri/src/cli.rs
  - src-tauri/src/cursor.rs
  - src-tauri/src/takes.rs
---
# Take frames

## Purpose

The `cue` commands that read video, for frames, clips and moments, take what they export from the
video of the take the requested time falls in, so an agent asks by session time and never needs to
know which take or file holds it.

## Requirements

### Requirement: Frames come from the take their time falls in
The `cue` CLI SHALL export each frame of `cue frame`, `cue frames` and `cue moments --frames` from
the video of the take its session time falls in, at that take's own size, because each take keeps
its own video and the agent asks by the times the transcript gives it.

#### Scenario: A frame from a later take
- **GIVEN** a session whose take 2 recorded another window from 1:12
- **WHEN** an agent runs `cue frame ID --at-ms 80000`
- **THEN** the PNG is take 2's frame 8 s into take 2, at take 2's size
- **AND** `cue frames` and `cue moments --frames` pick each frame's take the same way, and
  `cue help frame` says so
- **PROOF** test: src-tauri/src/takes.rs::tests::video_at_picks_the_take_video_by_session_time
- **PROOF** test: src-tauri/src/agent.rs::tests::actual_frames_come_from_each_take_video
- **PROOF** test: src-tauri/src/cli.rs::tests::frame_help_names_the_take_video
- **PROOF** desk: open

### Requirement: A clip stays inside one take
The `cue` CLI SHALL refuse a clip whose range crosses from one take into the next, naming where the
take starts, and write nothing, because the takes' videos differ in size and source and the agent
can ask for one clip on each side.

#### Scenario: A clip across a take boundary
- **GIVEN** a session whose take 2 starts at 72000 ms
- **WHEN** an agent runs `cue clip ID --start-ms 70000 --end-ms 75000`
- **THEN** the clip is refused with a message naming take 2's start at 72000 ms, and no file is
  written
- **PROOF** test: src-tauri/src/agent.rs::tests::a_clip_across_a_take_boundary_is_refused

### Requirement: The pointer ring fits the take's own frame
The `cue` CLI SHALL place the pointer of a take with its own video against that take's frame,
because the take was not scaled into another take's size.

#### Scenario: Ringing the pointer on a later take
- **GIVEN** a take 2 recorded at 1280×720 after a take 1 at 1920×1080
- **WHEN** an agent exports a frame of take 2 with `--mark-cursor`
- **THEN** the pointer is placed against take 2's 1280×720 frame
- **PROOF** test: src-tauri/src/cursor.rs::tests::a_take_with_its_own_video_maps_to_its_own_size

### Requirement: No take waits to be discarded
The `cue discard-take` command SHALL refuse every take, saying that takes keep their own videos and
none waits to be added, and change nothing, because no take is joined any more and scripts that
call it get an answer rather than an unknown command.

#### Scenario: Discarding a take
- **WHEN** an agent runs `cue discard-take ID 2`
- **THEN** it fails with "Takes keep their own videos now, so no take waits to be added." and the
  session is unchanged
- **PROOF** test: src-tauri/src/takes.rs::tests::discarding_refuses_every_take
