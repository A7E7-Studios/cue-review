---
title: Record more from any source and keep each take's video
capabilities:
  - capture/record-more
  - workspace/take-playback
  - workspace/recording-dock
  - agent-cli/take-frames
review: unreviewed
---
# Record more from any source and keep each take's video

## Why

Record more could only record the session's own window or display, and every take was appended to
one combined `video.mp4`: a take of another size was re-encoded to fit, and the swap needed a
second copy of the whole video, retries while the player held the file, and a "Discard take" way
out when it kept failing. A reviewer whose window had closed met "The original window/display for
this recording is no longer available" and had to start a new session. The owner wants any source
for a take and each take's video kept apart: "The AI can analyze multiple videos if needed (or
generally our tool provides screenshots from the right video based on the timing when calling the
command). I would keep the videos themself separate."

## What changes

- The recording bar's source picker is unlocked in review: Record more records the display, window
  or device chosen there, with the system or device audio chosen beside it
  (`workspace/recording-dock`, "Recording more from the bar").
- Each take keeps its own `video.mp4` in its own folder; nothing is joined, normalised or swapped.
  The session timeline still runs continuously over the takes (`capture/record-more`, "Recording
  more from another source", "Stopping a take").
- `session.json` format 2 lists the take videos and their place on the timeline. Sessions saved
  before keep their joined `video.mp4`, and a take that was still waiting to be joined plays from
  its own video after the upgrade (`capture/record-more`, "A session whose takes were joined",
  "A take that was waiting to be joined").
- The player switches to the take video the time falls in, while playing on, seeking from the
  scrubber or the transcript (`workspace/take-playback`).
- `cue frame`, `frames` and `moments --frames` take each frame from the take video its time falls
  in; `cue clip` refuses a range that crosses a take boundary; the pointer ring follows the take's
  own frame size (`agent-cli/take-frames`).
- The `SOURCE_GONE` refusal, the source identity check, "Discard take" in the app and its
  `discard_take` command go. `cue discard-take` stays and says that no take waits to be added.

## Settled questions

- **Q1 Record more's source** (the owner, in `dock-microphone-feedback`, Q5): any source, each
  take's video kept separate, frames from the right video by time. Rejected: normalising another
  source into the combined video.

## Calls for the owner

The owner was away; each call below took the recommended option.

- **Which source the review bar starts on.** The bar's source and system audio are the app's
  current choices, shared with a new recording, like its microphone already is; opening a session
  does not change them. Alternative: default to the session's last take's source. Reversing it is
  a small change in `App.tsx`.
- **A clip across a take boundary** is refused, naming the boundary, rather than joined for the
  export. Alternative: encode the pieces into one clip (scaling takes of different sizes).
  Reversing it touches only `agent::clip`.
- **No new look.** The unlocked bar in review is the draft's bar, which has its look; the lock,
  its reason line and "Original source" naming go. No directions were drawn.
- **The upgrade.** A format-1 session (no `formatVersion`) is read as one video, `video.mp4`, for
  the whole timeline, so readers need no migration to read it; the app writes format 2 (adding
  `formatVersion` and `videos`) once a take gets a video of its own. Sessions with one take keep
  writing format 1 byte for byte. A reader finding a `formatVersion` above 2 refuses the session.
  Alternative: rewrite every session at startup, which would touch every file for no reader's
  benefit.
- **A waiting take is kept, not dropped.** At startup (or `cue transcribe`), a format-1 take still
  `swapping` becomes a take on the timeline playing from its own video, its transcript to Retry;
  its swap leftovers are deleted. Alternative: finish the old swap, which needs the code this
  change removes.
- **`cue discard-take` stays** with a refusal ("Takes keep their own videos now, so no take waits
  to be added"), so scripts get an answer rather than an unknown command. The app's Discard take
  dialog goes, since no take can wait any more. Alternative: remove the command.
- **No source identity for takes.** Each take stores its `sourceId`; the window/display identity
  check that guarded reusing the session's source is gone, since the reviewer now sees and picks
  the source in the bar. `sourceIdentity` stays on the session for the first capture.
- **Playback while a take records.** The review video no longer unloads before Record more (no file
  is replaced); it pauses, so its sound is not recorded with system audio.

## Out of scope

- Batch transcription (one pass over every take): `batch-transcription`.
- The player controls' look, fullscreen, the top bar: `playback-controls`.
- A take source's name in the transcript divider ("Take 2 · Display 1"): not asked for.
- Joining or exporting a whole multi-take session as one video file.
