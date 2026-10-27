# Verification

This is the acceptance checklist, not a claim that every item has passed. Record actual commands/results and hardware limitations in the delivery report. Fixtures may be used in tests; production commands must access real media and devices.

## Recorded automated evidence (28 October 2026)

- Latest `cargo test --lib`: 36 passed, 0 failed, 18 explicitly ignored integration/hardware tests. Those integration cases are run separately as described below. Run with normal Windows permissions; the restricted execution environment denied metadata replacement operations that passed outside that sandbox.
- Frontend: 42 tests passed; TypeScript and Vite production build passed. Rust Clippy passed for all targets with warnings treated as errors. Regressions cover immediate unnamed recording without a project, optional grouping, direct source/microphone menus, automatic transcript following, background completion refreshing Recents, keyboard controls, unavailable sources and microphones, retaining No microphone across refresh, clearing stale previews, aligned word/segment seeking, nearest-point highlighting, silence, and legacy transcripts.
- Persistence tests cover nullable project assignment, grouping without moving media, transcript-derived titles, explicit rename protection, and loading legacy sessions without changing their names.
- `cargo test --lib orchestration_tests::recovered_video_becomes_playable_metadata -- --ignored --exact --nocapture`: passed. This test creates an actual one-second H.264 video with FFmpeg, restores missing playback path/duration using ffprobe, and confirms that corrupt media is rejected.
- `cargo test --lib agent::tests -- --nocapture`: 4 passed. Coverage includes PowerShell path quoting and data-root preservation, rejection of active-session transcription, phrase matching, and clip bounds. The real-video recovery test also verifies that CLI retry restores a silent session to ready with its video path, while corrupt media cannot be marked ready.
- `cargo check --bin cue`: passed after the CLI recovery and handoff changes.
- `cargo test --lib transcribe::tests::actual_whisper_snapshot_keeps_absolute_offsets_and_cancels -- --ignored --exact --nocapture`: passed in 2.55 seconds. Actual installed Whisper/model recognized “click here” from the generated speech fixture, shifted its words by 30,000 ms while retaining the snapshot bounds, and cancelled a subsequent inference pipeline promptly. Evidence: `test-results/live-transcription/absolute-transcript.json` and the adjacent raw output/logs.
- Four progressive-state tests passed: overlap replacement with absolute offsets, silent-tail replacement, snapshot end bounds, and rejection of late success/error results after recording has stopped.
- The library suite includes transcript token grouping, missing timing rejection, empty transcription, phrase matching across segments, invalid clip bounds, project persistence/rename/recovery, marker bounds, processing cleanup after unreadable metadata, audio zero padding, and capture device output parsing.
- The final CLI media-boundary regression passed using an actual red-to-blue video without audio: a frame at the final millisecond is blue, the exact end is rejected, a full-length clip retains duration and decodes, and a range too short to contain a video frame returns an actionable error and removes its failed export. Repeated phrase matches preserve each occurrence's original timestamps. The original speech fixture's frame at 10,732 ms was also successfully exported. Evidence: `test-results/cli-boundary/`.

These tests do not establish physical microphone content, audiovisual synchronization, live device capture, or packaged-app behavior.

## Desktop and speech pipeline evidence

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
- The final rebuilt 4.16 MiB installer also installed/uninstalled successfully in a fresh temporary directory. Its CLI matched the release hash; its GUI binary matched all bytes after accounting for Tauri's expected `UNK`→`NSS` bundle marker. Installed setup reported the speech runtime, both models, and media tools ready. Test executables were removed by their uninstaller. Evidence: `test-results/package-verification.json` (installer SHA-256 `303BFCEDD9B09C5631804F86340A51F398AAD0340C967B289FA4F2C817F32BE2`).

Screenshots and captured media are deliberately ignored by Git because desktop captures may contain private content.

## Recorded Windows capture evidence

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

## Automated checks

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

## Desktop acceptance

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
- [x] Markers retain their timestamp after reopening the app.
- [x] Retry a failed transcription without losing the original recording.
- [x] Open the session folder and copy/use the agent handoff instructions.
- [x] Restart after an interrupted recording/processing job; show an actionable persisted state.
- [x] Launch the packaged application outside the repository and verify dependency discovery and playback.

## Device acceptance

- [ ] An authorized Android device appears by serial/model; unauthorized/offline states have useful recovery guidance.
- [ ] Record Android video with PC microphone commentary; verify startup alignment and late-session drift.
- [ ] Record device audio when supported, including behavior when audio capture fails.
- [x] Stop device capture gracefully and validate the media container.
- [ ] Disconnect USB during capture; preserve diagnostics and recover without a stuck recording state.
- [ ] Repeat the device tests on an actual Quest headset and inspect the captured view/orientation.

Actual Quest capture and audio paths have now been exercised as described above. Unchecked compound items still require their remaining conditions, such as spoken commentary, long-session drift, capture-failure behavior, or physical disconnection.

## Evidence to retain

For capture tests, retain a short media file, ffprobe stream/duration output, raw Whisper JSON, parsed transcript, and exported frame/clip. Document selected devices, enabled audio sources, and observed synchronization error. Test each distinct recording path; one successful display capture does not validate window, Android, or Quest capture.

