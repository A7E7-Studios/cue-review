# Verification

This is the acceptance checklist, not a claim that every item has passed. Record actual commands/results and hardware limitations in the delivery report. Fixtures may be used in tests; production commands must access real media and devices.

## v0.2.0: Float v2, takes and agent tooling

### Recorded unattended evidence (28 October 2026)

Measured at `1ca94a0` (the Phase 1 merge on `codex/design-polish`, before the app integration mounts the Float v2 components), with the installed speech runtime in `%LOCALAPPDATA%\Programs\CueReview\tools\whisper-b5454`:

- `npm test`: 15 files, 170 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked`: 111 passed, 25 ignored.
- `node scripts/verify-cli.cjs` against the debug `cue.exe`: all 9 checks passed on the synthetic two-take session and on a copy of the pipeline fixture.
- `scripts/verify-pipeline.ps1`: passed; "click here" found at 4320–5190 ms (`seekMs` 4580), frame and clip exported and decoded.
- `node scripts/verify-failures.cjs` against the release `cue.exe`: all six failure cases passed.
- `node scripts/verify-alignment.cjs`: passed; the first word got `seekMs` 10220 after ten seconds of silence, and its frame is the blue speech scene (RGB 0, 0, 254).

These do not exercise the integrated app, capture, takes recorded through the UI or cursor tracking on real input.

### Unattended tests

`cargo test --lib` and `npm test` need no tools, devices or network. The v0.2.0 additions cover:

| Area | Covered by |
| --- | --- |
| Takes | `takes::tests`: listing and synthesizing take 1, Record more preconditions, the source identity check (same window or display, gone, renamed, resized, another process or a reused process id behind the same image and class, legacy sessions), starting a take and restoring the session when capture fails, stopping into `swapping` or `interrupted`, settling on the first unfinished take, `t{N}-` ids and merging one take, swap states and the verified swap, `complete_swap` with fake FFmpeg tools (the audio rebuilt from every take's lossless audio, the fallback without it, re-encoding when a normalized take's codec setup differs, cleanup after a verified or failed swap), the FFmpeg arguments of a combine, discarding a stuck take (refused once `video.mp4` already contains it), rename retries while `video.mp4` is in use, ffconcat lists, fitting and centering another size, `normalize` in `capture-timing.json`, and the startup recovery of each take state, including a finished `finalizing` take. `orchestration_tests`: Record more refused while busy, without a playable video or when the window or display is gone, discarding a take only while the session is not in use, the take reported by `get_recording_status`, live snapshots placed on the session timeline, Retry transcribing only the unfinished take. `transcribe::tests`: a session with takes transcribed take by take with each outcome recorded, and take dividers saved when a take fails to transcribe. |
| Audio tracks | `capture::tests`: a synthetic device whose clock drifts 1% either way and whose timestamps jitter by 2 ms leaves no zero sample inside the track and a track exactly the take's length, with a burst within 5 ms of its time; a gap kept as silence in the middle, inside the first second and for 60 s after a 1.2 s run, with what follows in place; a muted second silent; a track under a second only padded; the resampler returning its input at ratio 1 and keeping a sine's amplitude with its frequency scaled; the level held at its loudest until the status reads it. |
| Cursor | `cursor::tests`: delta encoding round trips, heartbeats and gap lines, unknown headers and torn tails, pixel centers and even video sizes, nearest-sample lookup with the staleness limit, clicks, stitching takes at their offsets from the folders their indexes name, missing tracks, the ring on exported PNGs without overwriting. |
| Touch | `touch::tests`: `getevent -lt` lines with and without labels or device paths, the emulator's `getevent -lp` listing and touchscreen selection (direct panels first, no touchpads, no protocol A), rotation from the display-0 viewport or `SurfaceOrientation`, scaling the raw range and each rotation onto the canvas, the letterbox after a turn between portrait and landscape, the primary contact and its gesture, positions kept across contacts and unknown axes, palm contacts, `SYN_DROPPED` and `BTN_TOUCH` (a dropped press is released before its gap), the fastest-delivery clock and its 30 s window for a device clock drifting either way, `getevent` failures (a touchscreen it cannot open, an early end) told apart from the stop, heartbeats for a resting finger, two panels, the Pixel 8 listing, and recorded emulator and Pixel 8 streams read back through `cursor::load` as presses at the touched pixels. `capture::tests`: the canvas from scrcpy's first texture line, latched with the delay, `touchDelayMs` in `capture-timing.json`, a cancelled command killed at once, device frame sizes and the letterbox filter. |
| CLI | `cli::tests`: parsing every command, `cli::dispatch` printing help and argument errors before the store is opened and running mutating commands only inside the process lock, unknown flags, missing values and conflicts, `discard-take`, `--segments` seek points and take dividers, clocks after an hour, pointing words and their non-pointing uses. `agent::tests`: handoff quoting, phrase matching, moments without a cursor track, clip bounds, refusing URLs and protocols as outputs, removing a failed batch's frames, refusing to transcribe an active session, transcribing a session with takes again, a concurrent rename never overwritten. |
| Settings | `settings::tests`: vocabulary normalization and rejection, the token estimate against measured counts, reading the real count from the Whisper log, failed token probes cached, a hung probe killed, the prompt carried into every window without decoded history, falling back when the prompt cannot be used, the v0.1 options without a vocabulary, round trips and damaged files. |
| Store and models | `store::tests`: the per-session lock (reentrant, across processes), concurrent updates never lost, startup recovery skipping a damaged session and marking a busy one it could not repair as failed, listing that skips a torn `session.json`. `models::tests`: legacy files re-serialize byte-identical; new fields (`takes`, `sourceIdentity` with its optional `pid` and `processCreatedMs`) are camelCase and omitted when empty. |
| Web | `src/**/*.test.ts(x)`: title bar and window API, the search window and its index, settings dialog, dialog focus, capture controls, media stage, playback bar and scrubber, recording dock, session header, transcript pane (take dividers, live tail, find, Return to playback), media fit, review helpers and the app. |

### Ignored integration tests

Run each with `cargo test --manifest-path src-tauri/Cargo.toml --lib NAME -- --ignored --exact --nocapture`. Put the speech runtime on PATH first (`%LOCALAPPDATA%\Programs\CueReview\tools\whisper-b5454` on this machine). The Whisper tests read fixtures from `test-results/` that `verify-pipeline.ps1` and earlier experiments produce.

| Test | Needs | Attended |
| --- | --- | --- |
| `takes::tests::actual_ffmpeg_takes_concatenate_at_their_offsets` | FFmpeg: boundary frame colors, durations, audio onset | no |
| `takes::tests::actual_ffmpeg_three_takes_encode_each_take_audio_once` | FFmpeg: after take 3, takes 1 and 2 decode to the same samples as after take 2; onsets, tones and boundary frames | no |
| `agent::tests::actual_frames_batch_scaling_and_no_overwrite`, `agent::tests::actual_last_frame_and_video_only_full_clip` | FFmpeg | no |
| `orchestration_tests::recovered_video_becomes_playable_metadata` | FFmpeg | no |
| `transcribe::tests::cancelling_live_job_terminates_its_media_process` | FFmpeg | no |
| `transcribe::tests::actual_whisper_take_two_keeps_session_offsets` | Whisper, model, `speech/reference.wav` | no |
| `settings::tests::actual_vocabulary_prompt_keeps_speech_and_alignment_and_adds_nothing_to_noise` | Whisper, model, speech, quiet-noise and delayed-speech fixtures | no |
| `transcribe::tests::actual_whisper_snapshot_keeps_absolute_offsets_and_cancels`, `actual_quiet_noise_is_empty_and_quiet_speech_is_preserved`, `actual_vad_gate_preserves_words_clock_and_rejects_noise`, `actual_dtw_anchors_keep_delayed_and_quiet_word_context` | Whisper, models and fixtures | no |
| `capture::tests::actual_cursor_sampler_follows_the_pointer_over_an_owned_window` | Moves the real pointer and clicks an owned topmost window; records nothing | yes |
| `capture::tests::actual_windows_capture`, `actual_window_capture`, `actual_loopback_silence_gaps`, `actual_initial_mute`, `actual_live_audio_snapshots`, `actual_desktop_sync_over_static_interval`, `actual_selected_window_occlusion`, `actual_source_close_and_odd_geometry`, `actual_immediate_stop_then_restart` | Records the display, a window, the microphone or loopback; plays quiet tones | yes |
| `capture::tests::actual_final_video_validation_rejects_incomplete_output` | FFmpeg | no |
| `capture::tests::actual_device_finalize_keeps_frames_after_a_turn` | FFmpeg: a synthetic device recording that changes frame size twice keeps each second at its time, to the frame, letterboxed | no |
| `capture::tests::actual_size_optimized_finalization_preserves_timeline`, `actual_quest_metadata_extent_covers_retained_packet_extents` | Existing recordings named by environment variables | no |
| `preview::tests::actual_continuous_preview` | A real display, window, camera or authorized device | yes |

Notes on these tests:

- `actual_size_optimized_finalization_preserves_timeline` reads `CUEREVIEW_SIZE_FIXTURE`, a finalized device recording folder (`native-video.mkv`, `video.mp4`, `audio.wav`, `capture-timing.json`), and finalizes a copy under `test-results/recording-size/`. `outputEndMs` must match the fixture's exactly only when the fixture's `nativeExtentSource` is the one finalization uses now (`containerMetadata` for a finalized Matroska file). A fixture finalized before that fast path has no `nativeExtentSource` (or `packetTimestamps`) and ends at its last packet; the fast path adds one output frame as a guard to the container's extent, which can also include the last AAC packet. Such a fixture may differ by up to one frame plus one AAC packet (33.3 + 21.3 ms at 30 fps and 48 kHz); the 6.6-second Quest fixture differs by 42.3 ms. The test prints the difference and both sources, and its `verification.json` records them. `videoHostStartMs` and the audio must still match exactly, and the folder total allows only for the new `video.mp4`, the removed `native-video.mkv` and the rewritten `capture-timing.json`.
- `actual_cursor_sampler_follows_the_pointer_over_an_owned_window` checks, for each `SetCursorPos`, the sample of the move itself: the first one within 1 px of the target from 50 ms before to 100 ms after the call. `cursor.jsonl` only gets a line when the pointer moves (or a heartbeat), and the sampler stamps the time before it reads the pointer. Its owned window is a `STATIC` with `SS_NOTIFY`, so `WindowFromPoint` finds it from any thread; without it the window answered `HTTRANSPARENT` to its own thread only. Moving the mouse during the run can still fail it.
- `actual_continuous_preview` (with `CUEREVIEW_TEST_SOURCE`, for example `monitor:1` or `window:test`, and `CUEREVIEW_PREVIEW_TEST_DIR`) reads five seconds of frames, then disconnects and reconnects as a second viewer: the first viewer's drop must be reported and the stream must resume.

### Scripts

Every script uses an isolated data folder and never attaches to, changes or closes the normal app or its data. Scripts that launch their own app refuse to start when their CDP port is already taken, and stop their own recordings and close only their own processes on failure. Each prints a JSON summary, writes it under `test-results/`, and exits nonzero on failure. `scripts/test-env.cjs` puts the speech runtime on PATH: `CUEREVIEW_WHISPER_DIR`, else `%LOCALAPPDATA%\CueReview\tools\whisper-b5454`, else the installed `%LOCALAPPDATA%\Programs\CueReview\tools\whisper-b5454`. Controls are found by the accessible names in `src/workspace/types.ts` (`NAMES`) and the class hooks in its `HOOKS`.

| Script | Needs | Records | Checks |
| --- | --- | --- | --- |
| `verify-pipeline.ps1` | Debug `cue.exe`, Whisper, a captured window video (`test-results/native-capture/window/video.mp4` or `CUEREVIEW_PIPELINE_VIDEO`) | no | Known synthesized speech through the real model; phrase, frame and clip retrieval. Its session is the fixture for the scripts below. |
| `verify-cli.cjs [--release]` | `cue.exe` (`cargo build --bin cue`) | no | Help for every command without opening the store or taking the lock, rejected flags, `transcript --segments` with take dividers, `frames` batches and `--max-width`, no overwrites, `rename` beside a held lock, `moments`. |
| `verify-failures.cjs` | Release `cue.exe`, the pipeline fixture | no | Missing tools and failing FFmpeg, VAD and Whisper processes leave media untouched and report actionable errors. |
| `verify-alignment.cjs` | Release `cue.exe`, the pipeline fixture | no | Phrase-to-frame lookup after ten seconds of silence. |
| `verify-sidebar.cjs` | Release app (CDP 9228) | no | Native drag into and out of sections, Move to section, section rename, collapse and order across reload, deletion; sidebar rows follow the theme set in Settings → Appearance; no field in the title bar, and `Ctrl+K` opening the search window with recent recordings, a name match, transcript lines and "No matches". |
| `verify-recovery.cjs` | Release app (CDP 9225), the pipeline fixture, installed models | no | Interrupted processing recovers with playable media, missing-model retry, real retry, word seeking before and after relaunch, legacy `markers.json` still readable with no marker UI, No microphone kept across refresh, unavailable-source guidance. |
| `verify-folder-open.cjs` | Release app (CDP 9227) | no | Open recording folder opens Explorer at the physical folder. |
| `verify-takes.cjs` | Release app and `cue.exe` (CDP 9229), `ffplay` | an owned `ffplay` test-pattern window, no audio | Take 1 and Record more through the UI: one session with two takes and offsets, `video.mp4` lasting the sum (ffprobe), the take 2 dock while recording (its timer named "Take 2 elapsed time", no take label or caption) and the "Take 2 · m:ss" divider after, the review video reloaded at the combined length, `cue transcript --segments` dividers, `cursor.jsonl` in both take folders. |
| `verify-desktop.cjs` | A test app on CDP 9224 | the default source, about 3 s | New session, Record, the recording dock, stop, playback. |
| `verify-native-ux.cjs [--review-only \| --compact-only]` | A test app on CDP 9224 with the pipeline fixture | compact mode only | The custom title bar (44 px, 46×44 window controls, drag regions only on empty areas, maximize and restore), shortcut hints on hover, word seek, no marker UI, clipboard handoff (the clipboard's text is saved and put back), speed, playback, rename persistence, both themes through Settings, compact mode at about 520×320 with Minimize and Close only. |
| `verify-installed.cjs` | The installed app on CDP 9224, `CUEREVIEW_TEST_PID` | the default source, briefly | Close blocked while recording, from the native close message and the Close window button; playback; the light player tokens and the bundled Figtree font; the installed CLI and the agent workflow in the handoff; setup ready. |
| `verify-device-ui.cjs` | An authorized ADB device in `CUEREVIEW_TEST_DEVICE` (CDP 9226) | the device | Fresh start without a project, device menus, continuous preview, recording, playback, optional grouping. |
| `inspect-desktop.cjs` | A test app on CDP 9224 | no | Prints the window chrome, theme and visible text, and saves a screenshot. Read-only. |

A test app with CDP 9224 is the release app started with `CUEREVIEW_DATA_DIR` pointing at a dedicated folder (for the review checks, `.local/pipeline-data`) and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9224`. Normal launches never open the port.

### Unattended set

```powershell
npm test; npm run build; npm run build-storybook
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
npx tauri build --no-bundle   # app with the embedded frontend, and cue.exe, for the scripts
# cargo build --release alone builds an app that loads the dev URL.
# If the build cannot find RC.EXE, set RC to the Windows SDK's rc.exe
# (for example C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\rc.exe).
powershell -File scripts/verify-pipeline.ps1                          # needs the debug cue.exe too
node scripts/verify-cli.cjs --release
node scripts/verify-failures.cjs; node scripts/verify-alignment.cjs
node scripts/verify-sidebar.cjs; node scripts/verify-recovery.cjs; node scripts/verify-folder-open.cjs
```

Then the ignored FFmpeg and Whisper tests from the table above.

### Attended runs

Tell the user before these start: they record the screen, a window or the microphone and play quiet tones. Nothing leaves the machine.

- The `capture::tests` hardware tests, including `actual_cursor_sampler_follows_the_pointer_over_an_owned_window` (it moves the pointer).
- `node scripts/verify-takes.cjs`, `verify-desktop.cjs` and `verify-native-ux.cjs` against the release build.
- By hand on Windows: drag the window by the title bar, double-click it to maximize and again to restore, resize from every edge, snap to the screen edges, and try to close while recording (the window must stay open with the guard message).
- `verify-device-ui.cjs` only when a Quest or Android device is connected and authorized.

### Still hardware-only or open

- Cursor tracking on real input: pointer mapping across monitors with different DPI, window moves during capture, occlusion, the secure desktop gap and clicks shorter than about 16 ms.
- Android touch tracking with more than one finger (only the first is recorded) and on panels whose IDC file sets `touch.orientation`.
- `px`/`py` for a later take recorded at a different window size are covered by unit tests (`normalize` scale and padding); they have not been measured on hardware.
- Record more on a real display or window with microphone commentary, including a take whose window was resized between takes, and refused after the window closed, changed its title, or the display changed.
- The swap retry while another program holds `video.mp4` open, on a real player.
- Snap Layouts: the custom maximize button does not show the Windows 11 snap flyout on hover.
- macOS and Linux: overlay/native chrome, the toolbar, and every capture path still need real-hardware validation; cursor tracking is not implemented there.

### Android touch tracking (29 October 2026)

- **Pixel 8, Android 17** (`goodix_ts0`, raw range 0–1079 × 0–2399), `cue record` with "Show taps" on, a person tapping. A portrait take with 45 taps: `cursor.jsonl` had a press for each of the 45 touch-downs that a raw `getevent -lt` capture running beside it saw in the take, at the same times. `cue frames --mark-cursor` put the ring on the tap dot in all four corners. Over 18 isolated taps the dot appeared a median 99 ms after the press's `tMs` (77–128 ms). `touchDelayMs` was 4.0 ms at the median. `cue moments` gave the finger's position at a "here" spoken during a touch, and every tap within a second, with pixels (the microphone caught nothing, so three phrases were dubbed in with Windows text-to-speech at known tap times).
- **Fixed from that run:** the Pixel flags some deliberate taps near its corners as `MT_TOOL_PALM` throughout, and Android draws no tap for them. Palm contacts no longer touch, and a palm that turns into a finger touches down then (fixture `pixel8-getevent-lt.txt`). `getevent` on Android 17 prints tool types as labels, which are now parsed.
- **Rotation mapping:** on the Android 15 emulator, 12 held touches across all four rotations; in a screenshot, Android's tap dot was within 4 px of where `touch::place` put each one, and the rotation read from `dumpsys input` matched each time.
- **Rotation video:** before the fix, a take turned to landscape and back lost the landscape frames and showed everything after the turn about 4.5 s early, although scrcpy's native recording had them. With the letterboxing `finalize`, an emulator take (taps, a drag, landscape for 4.8 s, portrait again) kept the landscape stretch letterboxed at its time (`frameSizes` `[[1080,2400],[2400,1080]]`), and `cue frames --mark-cursor` put the ring on the tap dot for every touch: in portrait before the turn, in the landscape letterbox, and in portrait after it. The dot appeared 46–72 ms after `tMs` in portrait. On a just-booted emulator, a first frame decoded 2.1 s into the take anchored the whole video about 350 ms late; the same take on the warm emulator did not. `capture::tests::actual_device_finalize_keeps_frames_after_a_turn` checks the timing to the frame on a synthetic recording.
- **Rotation on the Pixel 8:** a 46 s take, a person tapping: portrait from Settings opening, landscape from 17.6 s (`wm user-rotation lock 1`), portrait again from 31.7 s, with taps near every corner and the center in each phase. `frameSizes` was `[[1080,2400],[2400,1080]]`, and the landscape stretch played letterboxed from about 18 to 31 s, portrait before and after. For every isolated tap whose dot could be measured (7 portrait, 6 landscape, 9 after the turn back), Android's tap dot appeared 0–1 px from the press's mapped pixel; the landscape dots were the letterbox's 0.45 scale (about 380 changed pixels against 1,790), and `cue frames --mark-cursor` put the ring on the dot in portrait before and after the turn. The dot followed the press by 176–229 ms in all three phases alike: this take's first frame arrived 3.8 s in, which anchors the whole video later than the earlier take's 99 ms. `touchDelayMs` was 2.6 ms at the median and 28.8 ms at most, with lines stamped by the pump.
- **Emulator:** in portrait the ring landed on the tap dot; the dot appeared 89–128 ms after `tMs`.
- **Start-up:** with `getevent` started alongside scrcpy, taps 0.2 s after scrcpy's first frame (three runs) and one 0.3 s after `cue record` started, before the first frame, were all recorded at their pixels; before, `getevent` started after the first frame and the probe. A take with no touches stopped with `cursorLines: 0` and no `cursorError`.

## v0.1.0 evidence (historical)

Recorded for v0.1.0 on 28 October 2026. Where it mentions markers, the sidebar theme button, the white player controls or native window chrome, it describes the v0.1.0 UI; the scripts now check their v0.2.0 replacements.

### Automated evidence

- Latest `cargo test --lib`: 44 passed, 0 failed, 20 explicitly ignored integration/hardware tests. Those integration cases are run separately as described below. Run with normal Windows permissions; the restricted execution environment denied metadata replacement operations that passed outside that sandbox.
- Frontend: 58 tests passed; TypeScript and Vite production build passed. Rust Clippy passed for all targets with warnings treated as errors. Regressions cover immediate unnamed recording without a project, optional grouping, direct source/microphone menus, automatic transcript following, background completion refreshing Recents, keyboard controls, unavailable sources and microphones, retaining No microphone across refresh, clearing stale previews, aligned word/segment seeking, nearest-point highlighting, silence, and legacy transcripts.
- Persistence tests cover nullable project assignment, grouping without moving media, transcript-derived titles, explicit rename protection, and loading legacy sessions without changing their names.
- `cargo test --lib orchestration_tests::recovered_video_becomes_playable_metadata -- --ignored --exact --nocapture`: passed. This test creates an actual one-second H.264 video with FFmpeg, restores missing playback path/duration using ffprobe, and confirms that corrupt media is rejected.
- `cargo test --lib agent::tests -- --nocapture`: 4 passed. Coverage includes PowerShell path quoting and data-root preservation, rejection of active-session transcription, phrase matching, and clip bounds. The real-video recovery test also verifies that CLI retry restores a silent session to ready with its video path, while corrupt media cannot be marked ready.
- `cargo check --bin cue`: passed after the CLI recovery and handoff changes.
- `cargo test --lib transcribe::tests::actual_whisper_snapshot_keeps_absolute_offsets_and_cancels -- --ignored --exact --nocapture`: passed in 2.55 seconds. Actual installed Whisper/model recognized “click here” from the generated speech fixture, shifted its words by 30,000 ms while retaining the snapshot bounds, and cancelled a subsequent inference pipeline promptly. Evidence: `test-results/live-transcription/absolute-transcript.json` and the adjacent raw output/logs.
- Four progressive-state tests passed: overlap replacement with absolute offsets, silent-tail replacement, snapshot end bounds, and rejection of late success/error results after recording has stopped.
- The library suite includes transcript token grouping, missing timing rejection, empty transcription, phrase matching across segments, invalid clip bounds, project persistence/rename/recovery, marker bounds, processing cleanup after unreadable metadata, audio zero padding, and capture device output parsing.
- The final CLI media-boundary regression passed using an actual red-to-blue video without audio: a frame at the final millisecond is blue, the exact end is rejected, a full-length clip retains duration and decodes, and a range too short to contain a video frame returns an actionable error and removes its failed export. Repeated phrase matches preserve each occurrence's original timestamps. The original speech fixture's frame at 10,732 ms was also successfully exported. Evidence: `test-results/cli-boundary/`.

These tests do not establish physical microphone content, audiovisual synchronization, live device capture, or packaged-app behavior.

### Desktop and speech pipeline evidence

- The expanded release sidebar audit passed native section dragging and persisted the new order across reload. Deleting a populated section returned both recordings to Recents with all media hashes and current playback unchanged. Cancelling session deletion preserved files; confirming deletion of the selected recording removed its actual directory, returned to a fresh draft, preserved all other recordings, and stayed deleted after reload. No WebView errors occurred. Rust regressions cover active/runtime processing ownership, malformed reorder sets, unrelated paths, actual Windows junctions, and retry after a locked file. Evidence: `test-results/sidebar-verification.json`.
- Recording-size optimization was measured using isolated copies of a 31.267-second Quest recording at 4128×2208. Final video shrank from 67,864,846 to 46,402,819 bytes (31.62%). Recursive folder size, including live snapshots and unchanged ancillary files, fell from 118,294,930 to 65,944,853 bytes (112.8 to 62.9 MiB; 44.25%) after actual native-intermediate removal. The new result fully decoded, retained identical timing anchors/duration and byte-identical canonical audio, and finalized in 8.26 seconds. Sampled SSIM against the previous output was 0.996525. Quest frames and native-resolution UI text were visually compared; the separate static UI sample was 14.5% smaller. These are fixture-specific lossy-compression measurements, not universal savings or lossless-quality claims. The source recording was unchanged. Actual video-only successful-stop cleanup, source-close failure retention, and corrupt/incomplete output rejection passed. Evidence: `test-results/recording-size-verification.json` and `test-results/recording-size/text-quality/`.

- `scripts/verify-sidebar.cjs` passed in the actual release WebView2 app using isolated generated video fixtures. Trusted mouse drag/drop moved an inactive recording into a collapsed section and back to Recents, expanded the destination, and preserved the selected video element and its two-second playback position. Right-click Move to section created a new section and moved only its target; renaming and collapsed state persisted across reload. All five media hashes were unchanged and no page errors occurred. Light/dark screenshots were inspected. Frontend regressions also cover failed moves, external drops, keyboard menus, processing locks, orphaned section IDs, and recording immediately after section creation. Evidence: `test-results/sidebar-verification.json`.

- The release passed `scripts/verify-folder-open.cjs` by clicking the actual Open recording folder button and verifying a new Explorer window at the physical session directory. The isolated data root included spaces and was redirected by the packaged launcher from logical LocalAppData into its package LocalCache. Resolving the physical path before crossing into Explorer fixed the unavailable-location error; existing recordings were not moved. The test closed only its owned app and Explorer window. Evidence: `test-results/folder-open-verification.json`.

- The final release passed `scripts/verify-device-ui.cjs` with an actual authorized Quest 3: fresh startup required neither a project nor a naming dialog, source/microphone choices appeared directly, preview streamed at 1280×684 while the recording remained 4128×2208, and a projectless video-only recording finished as “Recording.” Playback advanced through the 3.3-second video. Assigning and removing an optional project preserved its media hash and Recents entry. No WebView errors occurred; the owned application exited cleanly. Timing evidence confirms the finalized container metadata path was used. Evidence: `test-results/device-ui-verification.json` and its UUID directory.
- The updated actual-speech alignment test also passed with no project and no supplied title. It saved “When I open the library, the transition feels slow.” from the transcript, created no implicit project, and retained the correct 10.22-second blue-scene phrase frame. The latest native recovery rerun passed seeking, explicit-title preservation, retry, marker persistence and direct device menus. Evidence: `test-results/alignment-verification.json` and `test-results/recovery/verification.json`.
- The actual Tauri/WebView2 application completed display recording, stop, local transcription, and playback with no browser errors. The final video reached ready state 4 and playback time advanced. Evidence: `test-results/ui/verification.json`.
- Native UI checks passed for compact mode (520×320, Stop remains visible), restoration to 1280×820, word seeking to 4.7 seconds, a marker saved at 4700 ms, native clipboard handoff, playback at 1.5×, project/session renaming across WebView reload, and both themes. Evidence: `test-results/ui/native-ux-verification-{compact,review}.json` and adjacent screenshots.
- The rebuilt release passed `scripts/verify-recovery.cjs`: an interrupted processing session reopened with a playable 10.733-second video; retry with a missing model produced an actionable saved-recording error; restoring the model yielded 26 words through real VAD and Whisper. Early/late word clicks sought to 0.11/9.73 seconds, and a 9730 ms marker survived relaunch. Video and microphone SHA-256 hashes stayed unchanged throughout. Native checks also retained No microphone after refresh and showed the enumerated offline source's recovery guidance while blocking both Record and Ctrl+R. Owned app processes exited cleanly, the copied model was removed, and normal user data was untouched. Evidence: `test-results/recovery/verification.json`.
- The final build repeated this recovery audit with the delayed-speech fixture and DTW enabled. The first word retained its original 0–1230 ms interval but received `seekMs: 10220`; both CLI phrase extraction and the native word click selected 10.22 seconds. The extracted image was the blue speech scene (RGB 0,0,254), not the red silence scene. The last word sought to 19.88 seconds, its marker survived relaunch, original media hashes remained unchanged, and no WebView errors occurred. Evidence: `test-results/alignment-verification.json` and the latest `test-results/recovery/verification.json` (the earlier run remains in its UUID directory).
- `scripts/verify-pipeline.ps1` generated known speech with Windows System.Speech, combined it with an actual captured window, ran the real local model, found “click here,” exported its frame and a clip, and decoded the result. This proves the media/transcript/CLI pipeline with explicitly synthesized speech; it is not a claim that the user spoke those words. Evidence: `test-results/pipeline-verification.json`.
- Progressive transcript results were observed in the running desktop UI with absolute session times. Actual Whisper snapshot offsets and cancellation were also tested separately.
- The transcription suite passed all 11 tests, including actual local inference. Conservative Whisper decoding (`-mc 0 -nf -nth 0.3`) suppressed a problematic 30-second quiet microphone snapshot while retaining speech attenuated by about 46 dB. The new whole-input speech detector suppressed all six invented segments previously produced from a 199-second noise fixture. It retained normal/quiet speech and subsecond “No”/“Stop” fixtures. Detector failures, malformed region counts, cancellation, empty-result persistence, and absolute live offsets were exercised. Evidence: `test-results/vad-experiment/` and `test-results/silence-check/`.
- Speech-positive inputs reach Whisper unchanged. The original model interval placed the first word near zero despite ten seconds of leading silence. DTW now supplies an optional `seekMs` point for visual lookup while preserving original intervals. The actual transcription suite passed all 15 tests, followed by a successful focused DTW rerun after a live-boundary review fix: delayed first-word alignment fell between 10,000 and 10,500 ms, live offsets shifted by exactly 30,000 ms, and quiet speech plus subsecond “No”/“Stop” survived. Alignment raised the measured two-thread inference time from about 2.2 to 4.0 seconds. Word points and intervals remain estimates; mixed speech/noise may still produce repetitions, and the detector can miss speech. Evidence: `test-results/dtw-experiment/` and the actual regression in `transcribe.rs`.
- `scripts/verify-failures.cjs` passed against the release CLI with isolated data. Empty PATH correctly reported dependencies missing; frame/transcription requests failed with actionable tool names. Invalid audio, detection-model, and speech-model fixtures forced real FFmpeg, VAD, and Whisper nonzero exits. No case emitted a success transcript or left a processing job, and the copied original video hashes remained unchanged. Evidence: `test-results/failure-verification.json`.
- Independent review identified possible stale JSON reuse when an incompatible external runtime exits successfully without writing output. Live and final jobs now use unique output prefixes and accept only newly produced, valid JSON before atomically replacing canonical raw output. A successful no-output subprocess and malformed/untimed output regressions confirm prior raw output is preserved and failure is reported. After this fix, all 16 transcription tests, including actual inference, passed in 34.18 seconds.
- The 4.10 MiB NSIS package installed and upgraded in an isolated temporary directory outside the repository with its sibling `cue.exe`. The installed CLI discovered dependencies and retrieved the test transcript/frame. The installed GUI passed recording/playback, blocking close during capture, and the review checks above. Light video and controls resolved to `rgb(243, 244, 246)` and white, using Segoe UI. Evidence: `test-results/ui/installed-verification.json`. The local test CDP port is enabled only by the verification launch environment, not by the application.
- The final rebuilt 4.18 MiB installer also installed/uninstalled successfully in a fresh temporary directory. Its CLI matched the release hash; its GUI binary matched all bytes after accounting for Tauri's expected `UNK`→`NSS` bundle marker. Installed setup reported the speech runtime, both models, and media tools ready. Test executables were removed by their uninstaller. Evidence: `test-results/package-verification.json` (installer SHA-256 `ED2754FB5B944640AB600B94C16CB17E389A83D390610121BFE9BF3C6C3A977E`).

Screenshots and captured media are deliberately ignored by Git because desktop captures may contain private content.

### Windows capture evidence

Continuous-preview tests passed over the production MJPEG transport on the actual display, an owned animated window, the authorized Quest 3, and the HD Pro Webcam C920. Each measured five seconds of frame delivery, verified the first JPEG, rejected an invalid URL token, ignored a stale stop ID, and confirmed the listener closed on teardown. Display/window tests deliberately animate their source; unchanged Windows content need not emit duplicate frames.

| Preview source | Measured delivery | Startup to first frame | Preview dimensions |
| --- | --- | --- | --- |
| Display | 28.5 fps | 0.225 s | 1280×720 |
| Window | 28.6 fps | 0.198 s | 466×213 |
| Quest 3 | 30.3 fps | 0.707 s | 1280×684 |
| C920 camera | 15.3 fps | 0.965 s | 960×720 |

These are short stream-delivery measurements, not exact display latency or long-session throughput guarantees. Evidence: `test-results/stream-preview/{display,window,quest,camera}/verification.json`. The final native UI check confirmed a single stable stream URL across recording startup, filtered out Quest virtual-camera entries, recorded/replayed the actual headset at full resolution, and reported no WebView errors. No owned ADB forwarding ports or scrcpy servers remained after test teardown. Frontend regressions cover preserving the stream when recording starts, stopping on review, reconnecting the same source, and ignoring old source responses/errors.

The native capture suite passed 12 tests (7 actual hardware/window tests and 5 unit tests) in 47.66 seconds through the full application library. A subsequent dedicated 31-second synchronization check at the production 30 fps rate passed in 35.07 seconds. The tests remain in `src-tauri/src/capture.rs` and can be run from the repository root with:

```powershell
$env:CUEREVIEW_CAPTURE_TEST_DIR = "$PWD\test-results\native-capture"
cargo test --manifest-path src-tauri/Cargo.toml --lib capture::tests -- --include-ignored --test-threads=1
```

Evidence is retained in `test-results/native-capture/test-run.txt`, `long-sync-30fps-test-run.txt`, and `verification.json` alongside the media files. The original eight final videos have H.264 video, AAC audio, and a clean full FFmpeg decode. A subsequent selected-window occlusion test also passed, giving nine decoded outputs.

| Actual test | Evidence |
| --- | --- |
| Display plus microphone, mute/unmute | 2560×1440 video, 3.533 seconds; nonzero microphone samples and a silent muted interval |
| Window capture and preview | 1282×852 final video, 1.667 seconds |
| Selected window completely occluded | The desktop cover had center luminance 105 while the selected-window preview and all 56 recorded frames remained 255. The 320×180, 1.867-second video decoded fully; owned windows were closed. |
| System loopback | Two real 440 Hz tones detected in raw capture with the intervening silence retained; 2.600-second final video |
| Odd-sized window resized and closed during capture | Window grew to 801×601 and shrank to 401×301; frames remained cropped/padded to the initial canvas, normalized to 640×426 in the final video. Source-close error reported while a 1.400-second video remained playable. |
| Microphone muted before startup | All microphone samples zero; 0.867-second final video |
| Live audio snapshots | Muted snapshot ended at 831 ms; subsequent snapshot ended at 1341 ms after unmuting; bounded snapshot work took 7 ms. A separate 40-second fixture produced exactly the latest 30 seconds. |
| Desktop and system audio at production 30 fps | Final duration 31.033 seconds versus 31.001 seconds on the recording clock; finalization took 2.700 seconds. AAC tone/video pulse onsets were 1020/1033.3 ms and 29021/29066.7 ms. Their offset changed by 32.3 ms, within one frame; no premature pulse appeared during the 27.6-second static marker interval. |

The loopback endpoint substantially attenuated the test tones. The 440 Hz signal survives both the float-PCM mix and final AAC track (approximately 2.8×10⁻⁷ and 2.7×10⁻⁷ RMS respectively); no gain or Windows volume setting was changed. Evidence: `test-results/native-capture/loopback/export-audio-analysis.json`.

The synchronization check measures visual marker frames and audio in the final MP4. Native capture copies immutable BGRA pixels, respects stride and orientation, and paces frames on the shared recording clock. The earlier 15 fps check also passed, with an early/late offset change of 66.7 ms, within one frame. Detailed measurements are in `long-sync/sync-verification.json` and `long-sync-30fps/sync-verification.json`. These checks establish the measured behavior on this host over 31 seconds; hour-long drift and sustained inference load were not tested.

An immediate-stop test passed in 2.20 seconds under a separate 20-second watchdog. Stopping before the first frame completed in 109 ms with an explicit missing-video error and retained diagnostics. Immediate stop after public startup returned a playable recording (566 ms startup, 175 ms stop); a subsequent recording also succeeded (249 ms stop). Both finished videos fully decoded. Only owned test windows were used. Evidence: `test-results/native-capture/immediate-stop/immediate-stop-verification.json` and `immediate-stop-watchdog.json`.

The initial DirectShow diagnostic returned malformed NV12 frames and then a uniformly green placeholder, not a headset view. The default ADB server listed only an offline emulator. These historical results are retained in `quest-dshow-diagnostic.json`, `quest-dshow-stderr.log`, and `test-results/device-audit/audit-result.json`.

After USB authorization, the actual Quest 3 was found on an existing ADB server at port 5073. A per-process `ADB_SERVER_SOCKET` override exposed its model/serial without resetting any servers or other devices. Preview showed the real room and Quest launcher at 4128×2208, with both eyes retained. Release CLI recordings passed for video only (4-second hold), PC microphone (4-second hold), and device audio plus PC microphone (6-second hold). Each stopped gracefully and its native/final video fully decoded. Final durations were 4.767, 4.800, and 6.833 seconds respectively, including startup padding and retained media tails. Evidence: `test-results/quest/20261027-224102-final-8b2ce766/`.

These recordings exposed and fixed a startup timing bug: a buffered Matroska file could remain empty for seconds despite decoded frames. Readiness now latches scrcpy's first decoded texture message, measured around 620–650 ms on this headset. Native audio's first timestamp is retained relative to video (87 ms in the combined-audio run), and finalization preserves the mapped native tail beyond the host Stop time. Finalized container metadata supplies the normal duration path; packet scanning is a fallback. A separate actual-fixture comparison confirmed that the metadata path covers all three packet extents. Raw mic/device tracks, timing JSON and probes remain beside the evidence.

The decoded host-frame arrival is an approximation of the device/PC clock relationship. PC microphone samples were nonzero, but the device audio track contained silence; audible headset content is not established by its valid AAC stream. These short tests do not establish spoken commentary alignment, exact PC/device audio synchronization, long-session drift, or recovery from physical USB/audio disconnection.

## Acceptance checklists

### Automated checks

- [x] TypeScript builds and production UI assets compile.
- [x] Rust builds for Windows and its tests pass.
- [x] Word/segment selection handles shared boundaries and silence.
- [x] Seeking clamps invalid, negative, and beyond-duration values.
- [x] Whisper JSON parsing joins subword tokens and punctuation, removes control tokens, preserves timestamps, and handles empty/malformed results.
- [x] Project/session metadata survives reload, rename, and interrupted processing.
- [x] Invalid IDs, path traversal, missing files, and invalid clip intervals return clear errors.
- [x] CLI output remains valid machine-readable JSON without log contamination.
- [x] Transcript JSON retrieval preserves the original millisecond timestamps.
- [x] Frame extraction at a known timestamp yields a decodable image from the expected scene.
- [x] Phrase lookup can identify an occurrence, retrieve its frame, and export a playable surrounding clip.
- [x] Clip extraction handles start/end boundaries, repeated phrases, no matches, and missing audio streams.
- [x] Missing dependencies and nonzero process exits produce actionable errors rather than success metadata.
- [x] `cue --help` and `cue COMMAND --help` exit 0 without opening the store; unknown flags fail; `transcript --segments` prints take dividers; `frames` batches respect `--max-width` and never overwrite; `rename` works while the lock is held; `moments` finds pointing words (`verify-cli.cjs`, 28 October 2026).
- [x] Takes: lifecycle, offsets, swap verification and the startup recovery matrix (`takes::tests`); the ignored FFmpeg concat test checks real boundary frames and audio onset.

### Desktop acceptance

- [x] Create and rename a project; create and rename a recording session.
- [ ] Enumerate displays, windows, microphones, and authorized Android devices.
- [ ] Preview the selected source and handle sources that disappear.
- [ ] Record a display with spoken microphone commentary; stop and replay video plus audio.
- [ ] Record a window; move/resize/occlude it, then close it while recording.
- [x] Stop while the captured image is static; verify no hang and a finalized playable file.
- [ ] Speak near the end of a long static interval; video duration and word seeking still cover the speech.
- [x] Enable system audio; play tone/speech, leave several seconds of silence, and resume. Confirm the resumed sound retains its original timestamp.
- [ ] Record microphone and system audio together; confirm both are present without progressive drift.
- [x] Mute and unmute the microphone during capture; the silent interval preserves its duration.
- [ ] Disconnect the active microphone/output device; surface the failure and preserve usable recording material.
- [x] Stop a short recording immediately after starting; recover cleanly even if no frame arrives.
- [x] Automatic transcription completes locally; click early and late words and confirm their stored playback positions (synthesized speech fixture; linguistic alignment remains approximate).
- [x] Playback, pause, scrub, playback speed, and transcript following work together.
- [x] (v0.1.0) Markers retain their timestamp after reopening the app.
- [ ] (v0.2.0) A legacy `markers.json` stays readable after upgrading, and the app shows no marker UI (`verify-recovery.cjs`).
- [x] Retry a failed transcription without losing the original recording.
- [x] Open the session folder and copy/use the agent handoff instructions.
- [x] Restart after an interrupted recording/processing job; show an actionable persisted state.
- [x] Launch the packaged application outside the repository and verify dependency discovery and playback.
- [ ] (v0.2.0) Record more appends take 2 to the same session: the dock shows no take label or caption, the transcript shows its divider, the scrubber its tick, and `video.mp4` plays across the boundary (`verify-takes.cjs`).
- [ ] (v0.2.0) Close the app during take 2 recording, finalizing, swapping and transcribing; each restart shows the state the recovery matrix in ARCHITECTURE.md describes.
- [ ] (v0.2.0) Display and window recordings write `cursor.jsonl`; `cue frame --mark-cursor` rings the pointer where it was, across monitors and after the window moves.
- [ ] (v0.2.0) The Windows title bar: drag, double-click to maximize and restore, edge resize, snapping, Minimize/Maximize/Close, and close blocked while recording.
- [ ] (v0.2.0) `Ctrl+R`, `Ctrl+N` and `Ctrl+K` (⌘ on macOS) behave as documented, with hints only on hover or focus.
- [ ] (v0.2.0) A vocabulary saved in Settings improves a listed term in a later transcription and adds nothing on noise.
- [ ] (v0.2.0) Both themes (Settings → Appearance) at 1280×820, 900×650 and compact 520×320 match the Float v2 mocks.

### Device acceptance

- [ ] An authorized Android device appears by serial/model; unauthorized/offline states have useful recovery guidance.
- [ ] Record Android video with PC microphone commentary; verify startup alignment and late-session drift.
- [ ] Record device audio when supported, including behavior when audio capture fails.
- [x] Stop device capture gracefully and validate the media container.
- [ ] Disconnect USB during capture; preserve diagnostics and recover without a stuck recording state.
- [ ] Repeat the device tests on an actual Quest headset and inspect the captured view/orientation.

Actual Quest capture and audio paths have now been exercised as described above. Unchecked compound items still require their remaining conditions, such as spoken commentary, long-session drift, capture-failure behavior, or physical disconnection.

### Evidence to retain

For capture tests, retain a short media file, ffprobe stream/duration output, raw Whisper JSON, parsed transcript, and exported frame/clip. Document selected devices, enabled audio sources, and observed synchronization error. Test each distinct recording path; one successful display capture does not validate window, Android, or Quest capture.

