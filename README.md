# CueReview

**Show it. Say it. Fix it.** A desktop recorder for local, word-aligned review feedback.

CueReview uses Tauri 2, React, and a small Rust backend. It opens directly into a fresh recording draft. Record a display, application window, or supported Android/Quest source with microphone commentary; no project or name is required. Review the original transcript beside the video, click a word to seek, add markers, and give an agent a local session reference. No account or hosted transcription service is involved.

## Install

Download the Windows installer, Linux Debian package/AppImage, or macOS Apple Silicon/Intel DMG from [GitHub Releases](https://github.com/A7E7-Studios/cue-review/releases). The packages include the agent CLI and speech runtime. Install FFmpeg/ffprobe separately (`winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on macOS, or `sudo apt install ffmpeg` on Ubuntu), then use Settings → Install transcription to download the speech models. Android/Quest capture additionally needs ADB and scrcpy.

Windows is the hardware-verified platform. macOS uses AVFoundation; Linux uses X11/V4L2. Linux Wayland desktop capture, macOS/Linux per-window capture, and macOS/Linux desktop system audio are not supported yet. Native macOS/Linux hardware validation remains outstanding. Initial Windows builds are unsigned; macOS builds are ad-hoc signed without notarization. See each release's installation notes and SHA256SUMS.

## Run from source

Requirements: Windows 10/11, Microsoft C++ Build Tools, Rust stable, Node.js 22.12+ or 24+, WebView2, and FFmpeg/ffprobe on PATH. Android and Quest USB capture additionally require ADB and scrcpy on PATH.

```powershell
npm ci
npm run tauri dev
```

On first use, open **Settings → Install transcription**. This downloads a pinned Windows whisper.cpp CPU runtime, the multilingual `base` model (about 148 MB), and a small speech detection model (885 KB). Downloads are SHA-256 verified. Thereafter transcription runs offline. FFmpeg remains a separate prerequisite; CueReview shows missing-tool errors rather than silently substituting sample data.

```powershell
winget install Gyan.FFmpeg
# For Android/Quest:
winget install Google.PlatformTools
winget install Genymobile.scrcpy
```

Restart the app after changing PATH. Accept the headset's USB debugging prompt, then refresh sources. A Meta Quest virtual camera entry does not establish that a headset is connected: USB devices must appear as `device` in `adb devices -l`. Sources can also fail when a window is minimized, protected content prevents capture, or Windows microphone permissions are disabled.

If another tool manages the device on a nondefault ADB server, launch CueReview and its CLI with that server's `ADB_SERVER_SOCKET`, for example `$env:ADB_SERVER_SOCKET = 'tcp:127.0.0.1:5073'` before starting the executable. Use the existing server rather than resetting unrelated debugging sessions. Quest mirroring currently retains the original stereo view. Registered Meta/Oculus Quest virtual-camera filters are hidden; use the authorized USB headset entry.

All previews stream continuously rather than polling screenshots. Display/window previews use Windows Graphics Capture; Android/Quest previews use the matching installed scrcpy server and FFmpeg; real cameras use FFmpeg. Preview frames fit within 1280×720, with display/window/device streams targeting up to 30 fps. Camera rates depend on the source. Recording resolution is independent of preview resolution. Device previews require the `scrcpy-server` file supplied with scrcpy.

Window recordings keep their initial canvas size. Resizing the source during capture crops or pads to that canvas; choose the desired window size before recording.

## Workflow

1. Open CueReview. A fresh unnamed recording is ready; source and microphone options open directly from the compact bottom controls.
2. Press Record (`Ctrl+R`). Mute/unmute and add timestamped markers during capture. Compact mode keeps the recording controls available in a smaller window.
3. Stop. The video is finalized and transcribed locally. Original media remains available if transcription fails; use Retry after fixing setup.
4. Find the recording in Recents. Its title is derived from the transcript. Drag it into a sidebar section, or right-click and choose **Move to section**. Sections are optional categories in the same list; drag back to Recents to ungroup. Grouping never moves the media files. Drag section headings to reorder them. Deleting a section returns its recordings to Recents; deleting a recording from its menu requires confirmation and removes its files.
5. Play the recording and click transcript words to seek. The transcript follows playback automatically. The standard model uses DTW alignment points for visual lookup, while retaining the original word intervals and Whisper JSON. Both are model estimates, not guaranteed exact alignment.
6. Copy for agent, or open the session folder.

Before transcription, a local detector checks for speech. An explicit successful no-speech result produces an empty transcript; detector failures remain actionable errors. When speech is present, the original audio goes through Whisper without cutting silence or changing its word-to-time mapping. Speech detection and recognition are imperfect, particularly with mixed speech/noise; review the transcript alongside the recording. Raw model output and detector diagnostics are retained when produced.

During recording, local transcription updates in short batches from the latest 30 seconds of microphone audio, or Windows system audio when no microphone is selected (roughly every eight seconds plus inference time). These provisional words may change; stopping recomputes the full authoritative transcript. If local speech setup is missing, the recording remains usable and can be transcribed later. Device audio without a PC microphone is transcribed after stopping. System audio uses WASAPI loopback for Windows sources; supported Android devices use scrcpy's device audio.

## Storage and agent CLI

Default storage is `%LOCALAPPDATA%\CueReview`. Projects and sessions are plain JSON files; each session directory contains `video.mp4`, audio tracks, `session.json`, `transcript.txt`, `transcript.json`, raw `whisper.json` when recognition ran, and markers when present. Speech detector output is retained in `vad.txt` and `vad.log`. New recordings use H.264 CRF23 at their original resolution and frame rate. After successful finalization and stream/duration verification, the duplicate native video is removed. Failed captures retain original tracks for recovery, and lossless audio is retained for transcription retries. Existing recordings are not recompressed or cleaned up automatically. `CUEREVIEW_DATA_DIR` changes this root; `CUEREVIEW_MODEL` and `CUEREVIEW_VAD_MODEL` can select compatible local speech and detection models.

Each word retains its original `startMs`/`endMs` and may include `seekMs`, an estimated alignment point used by word clicks and phrase-based frame retrieval. Existing transcripts without this field still work. Custom speech models use their original intervals unless `CUEREVIEW_DTW_MODEL` explicitly names a compatible alignment preset, such as `base` or `base.en`; the preset is never inferred from a custom filename. The standard installed base model enables alignment automatically.

The packages include `cue.exe` on Windows and `cue` on macOS/Linux in the application resources. Copy for agent uses its absolute path and the appropriate shell syntax, so adding it to PATH is optional. Default storage outside Windows is `~/Library/Application Support/CueReview` on macOS and `$XDG_DATA_HOME/CueReview` (normally `~/.local/share/CueReview`) on Linux. A process lock prevents two app/CLI writers from recovering or modifying the same active recording; read-only CLI commands remain available while the app runs.

```powershell
& 'C:\path\to\cue.exe' sessions
& 'C:\path\to\cue.exe' transcript SESSION_ID --json
& 'C:\path\to\cue.exe' find SESSION_ID --phrase 'click here'
& 'C:\path\to\cue.exe' frame SESSION_ID --phrase 'here' --occurrence 1
& 'C:\path\to\cue.exe' clip SESSION_ID --start-ms 4000 --end-ms 6500
```

All CLI times use milliseconds. Frame/clip commands return JSON with local output paths. Existing export files are never overwritten. The CLI provides the MVP agent interface; an MCP server is not required to access sessions.

## Build and verify

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
powershell -File scripts/package.ps1
```

The portable packaging command is `node scripts/package.mjs`. Release builds first run `node scripts/build-speech-runtime.mjs` (requires CMake and a C++ compiler), then package with `--require-speech-runtime`. Installers are produced under `src-tauri/target/release/bundle`; named release copies go to `.local/release-assets`. Explicit `--target` builds use `target/<triple>/release` and require a matching native host.

Pull requests and main run `.github/workflows/ci.yml` on Windows x64, Linux x64, macOS ARM64 and macOS x64. Each job runs frontend/Rust tests and Clippy, builds the speech runtime, packages, and checks bundled executables. A `v<version>` tag contained in main triggers `.github/workflows/release.yml`; it publishes only after all five installers and their checksums are available. Package, Cargo and Tauri versions must match the tag. Workflow dispatch can retry an existing tag; published releases are never overwritten.

Real capture checks are deliberately opt-in because they record the screen/microphone and play two quiet tones:

```powershell
$env:CUEREVIEW_CAPTURE_TEST_DIR = "$PWD\test-results\native-capture"
cargo test --manifest-path src-tauri/Cargo.toml --lib capture::tests -- --include-ignored --test-threads=1
```

`scripts/verify-pipeline.ps1` synthesizes a known spoken fixture locally, combines it with a real captured window, transcribes it, and verifies phrase-to-frame and clip retrieval. Run the native tests first and build `cue.exe` in debug mode. `scripts/verify-desktop.cjs` exercises the running Tauri WebView through an explicitly enabled local CDP test port (9224); this port is not enabled in normal launches.

Use a dedicated `CUEREVIEW_DATA_DIR` for desktop verification. The review script expects the pipeline fixture in that same directory (launching the test app against `.local/pipeline-data` satisfies this). `scripts/verify-native-ux.cjs` checks review controls and compact mode; `scripts/verify-installed.cjs` additionally requires `CUEREVIEW_TEST_PID` to identify the exact test process for its safe-close check. Test recordings are stopped on script failure.

`scripts/verify-recovery.cjs` launches and closes its own isolated app instance, verifies interrupted-session recovery and missing-model retry, then checks real transcription and marker persistence after relaunch. It uses the pipeline fixture and already installed models, preserving the source media and the normal app's data.

`scripts/verify-failures.cjs` checks actual missing-tool and failed-process paths using copied media and invalid test models. `scripts/verify-alignment.cjs` adds ten seconds of silence before the known speech and verifies that phrase-based frame retrieval selects the spoken scene after a red-to-blue video transition. Both use isolated data directories.

`scripts/verify-device-ui.cjs` requires `CUEREVIEW_TEST_DEVICE` set to an authorized ADB serial. It launches an isolated app, records without creating a project or entering a name, checks direct device menus and playback, and assigns/unassigns an optional group without changing the media. Set `ADB_SERVER_SOCKET` too when the device belongs to a nondefault server.

See [architecture](docs/ARCHITECTURE.md) and the [verification checklist](docs/VERIFICATION.md) for boundaries and remaining hardware validation. Passing display capture does not establish Android/Quest correctness. Device-to-PC-microphone alignment needs hardware measurement, and recordings should be checked before relying on millisecond-level cross-device alignment.
