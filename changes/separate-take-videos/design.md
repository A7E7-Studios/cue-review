# Design: Record more from any source and keep each take's video

## Context

`src-tauri/src/takes.rs` records take N into `sessions/<id>/takes/<N>/` and, at Stop, appends its
`video.mp4` to the session's combined `video.mp4` (the "swap": ffconcat, normalising other sizes,
one AAC encode of every take's lossless audio, a verified temporary file renamed over `video.mp4`
with retries, `swap.json` for a rename that kept failing, and `discard_take` for a take that never
got in). Record more is locked to the session's source by a source identity check
(`check_source`, `SOURCE_GONE`). The player (`src/App.tsx`, `src/app/media.ts`) plays one file,
`videoPath`, with a cache-buster per appended take; `cue frame`, `frames`, `moments --frames` and
`clip` (`src-tauri/src/agent.rs`) read `video.mp4`; the cursor track (`cursor.rs`) maps every take
into take 1's frame size, normalised. Each take already keeps its own audio, cursor track and
transcript placement by offset.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Where a take's video lives | `takes/<N>/video.mp4`, written by the same capture as a first recording; take 1 is the root `video.mp4`. Paths are derived from the take index only | A `path` per take in `session.json`: a damaged file could redirect reads (the rule takes already follow) | `docs/ARCHITECTURE.md`, Takes |
| How the timeline is stored | `Session.videos: [{take, startMs, durationMs}]`, written with `formatVersion: 2` once a take has a video of its own; `durationMs` is the timeline's end | Per-take flag "joined": every reader then rebuilds the spans; storing the spans gives readers the answer | — |
| Reading format 1 | No `videos`: one video, `video.mp4`, from 0 for `durationMs` (true of every session with one take and of every joined session), so no rewrite is needed and single-take sessions stay byte-identical | Rewriting every session at startup: touches every file for nothing | serde: unknown fields are ignored by default, <https://serde.rs/container-attrs.html#deny_unknown_fields> |
| Upgrading a joined session | The first take with its own video writes take 1's entry `{1, 0, offset}` before its own, so `video.mp4` keeps playing takes 1..K | Cutting `video.mp4` into takes: the owner keeps videos as recorded; cutting at keyframes is inexact | — |
| A format-1 `swapping` take | `takes::recover` at startup, and `takes::upgrade` inside a Retry or `cue transcribe` job (the same upgrade, without settling the session), probe `video.mp4`: already joined → `error` inside take 1's span; else its own video probes → its own entry, `error`; else `interrupted`. Swap leftovers are deleted. While `video.mp4` cannot be read the take keeps waiting, since only that file tells a joined take from a lost one | Finishing the swap: keeps all the swap code alive for one transition | — |
| Newer formats | `formatVersion` > 2 is refused when the session is read | Reading on: would misplace takes silently | — |
| The take lookup | `takes::video_at(session, ms)`: the last entry starting at or before `ms`, its local time clamped into the entry; one function in Rust (CLI, cursor) and one in `media.ts` (player) | A lookup per command: they would drift | — |
| Player switching | One `<video>`; the loaded entry is state; `time = start + currentTime`; a seek or the end of an entry loads the target entry and applies a pending local seek (and play) on `loadedmetadata` | Two stacked `<video>` elements preloading the next take: gapless but doubles decoders and focus handling, for a boundary the reviewer crosses rarely | HTML media: `loadedmetadata`, `ended`, <https://html.spec.whatwg.org/multipage/media.html#event-media-loadedmetadata> |
| Duration shown | The session's `durationMs` once there are several entries; the media's own duration for one, as today | Media duration: only the loaded take's | — |
| Clips across takes | Refused, naming the boundary | Encoding pieces into one clip: takes differ in size | — |
| Record more's source | `record_more(id, sourceId, microphoneId, systemAudio, muted)`; the take stores `sourceId`; no identity check | Keeping the check for the session's own source: the reviewer now sees what the bar lists | — |
| The review bar | The draft's bar unchanged: the same global source, system audio and microphone; `sourceLocked`, `SOURCE_LOCKED` and the "Original source" naming go | Defaulting to the session's last source: a call for the owner | `changes/always-on-recording-bar/design.md` (the hand-off) |
| Discarding | The app's Discard take (dialog, `discard_take`, `NAMES.discardTake*`) goes; `cue discard-take` refuses every take | Removing the command: scripts get "unknown command" | — |
| The cursor | A take with its own entry maps to its own canvas, unpadded; a joined take keeps take 1's canvas and its `normalize` | — | `cursor.rs` module docs |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `src-tauri/src/takes.rs` (the swap code goes), `models.rs`, `store.rs`, `lib.rs` (`record_more`, `start_take`, `run_take`, `attach_finished_video`), `agent.rs`, `cli.rs`, `cursor.rs`, `bin/cue.rs`; `src/backend.ts`, `src/app/media.ts`, `src/App.tsx`, `src/workspace/CaptureControls.tsx`, `TranscriptPane.tsx`, `types.ts`, `src/app/dialogs.tsx`, stories; `scripts/verify-takes.cjs`; `docs/ARCHITECTURE.md` (Takes, Agent CLI), `docs/VERIFICATION.md`, README.md's Record more step |
| Formats and contracts | `session.json` format 2: `formatVersion`, `videos`; `Take.sourceId` set on new takes. Readers: a session without `formatVersion` (format 1) has one video, `video.mp4`, for the whole timeline; format 2 lists `videos`, path `video.mp4` for take 1 and `takes/<N>/video.mp4` after, a take on the timeline without an entry plays inside the entry before it; above 2, refuse. `cue info`/`sessions` print the same JSON (fields added only). `record_more` gains `sourceId`; `discard_take` is removed from the app's commands |
| Storage | No file is rewritten at upgrade except a format-1 session with a waiting take (at startup, or in a Retry or `cue transcribe` job). A take no longer needs twice the session's size during Stop |

## Test plan

| Scenario or logic | Test |
|---|---|
| Recording more from another source | `src-tauri/src/lib.rs::orchestration_tests::record_more_records_the_source_it_is_given`, new; `takes::tests::record_more_starts_a_take_and_restores_the_session_on_failure`, changed |
| Stopping a take | `takes::tests::stopping_a_take_keeps_its_own_video_on_the_timeline`, new |
| The take video list | `takes::tests::videos_place_each_take_on_the_timeline`, unit test |
| The lookup by time | `takes::tests::video_at_picks_the_take_video_by_session_time`, unit test; `src/app/media.test.ts::videoAt picks the take video by session time`, unit test |
| The app closes while a take finishes | `takes::tests::recovery_repairs_each_take_state`, changed |
| A session whose takes were joined | `takes::tests::a_session_with_joined_takes_keeps_its_video`, new |
| A take that was waiting to be joined | `takes::tests::recovery_upgrades_a_take_waiting_to_be_joined`, new |
| A session saved by a newer CueReview | `store::tests::a_session_of_a_newer_format_is_refused`, new |
| Playing across a take boundary, Seeking into another take | `src/App.test.tsx::take playback …`, new |
| Recording more from the bar, Record more is refused | `src/App.test.tsx::record more …`, changed; `CaptureControls.test.tsx`, changed |
| A frame from a later take | `agent::tests::actual_frames_come_from_each_take_video` (ignored, FFmpeg), new; `cli::tests::frame_help_names_the_take_video`, new |
| A clip across a take boundary | `agent::tests::a_clip_across_a_take_boundary_is_refused`, new |
| Ringing the pointer on a later take | `cursor::tests::a_take_with_its_own_video_maps_to_its_own_size`, new |
| Discarding a take | `takes::tests::discarding_refuses_every_take`, new |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| Recording more from another source, Stopping a take | desk | record a take from Display 1, Record more from a window of another size; both videos exist in their folders, the session plays through both |
| Playing across a take boundary, Seeking into another take | desk | play over the boundary, click a take-2 word, drag the scrubber back into take 1 |
| Recording more from the bar, Record more is refused | desk | the bar in review opens its source picker; a closed window's refusal reads under the bar |
| A frame from a later take | desk | `cue frame` at a time in take 2 shows take 2's window at its own size |

## Risks

- A short pause at a take boundary while the next video loads; measured by the desk check. Two
  elements could preload it later.
- An older CueReview reading a format-2 session plays only take 1 and would place a new take
  wrongly; downgrading is not supported, and the format number says so.
- Removing the swap code removes its ignored FFmpeg tests; the new ignored test covers frames from
  two take videos, and `verify-takes.cjs` the end-to-end path (attended, not run here).

Approved by the lead on the owner's delegation (the owner is away and asked for the recommended
options); the owner reviews it with the change.
