# CueReview

**Show it. Say it. Fix it.** A desktop recorder for local, word-aligned review feedback.

CueReview uses Tauri 2, React, and a small Rust backend. It opens directly into a fresh recording draft. Record a display, application window, or supported Android/Quest source with microphone commentary; no project or name is required. Review the transcript beside the video, click a word to seek, record more takes into the same session, and give an agent a local session reference. No account or hosted transcription service is involved.

## Install

Download the Windows installer, Linux Debian package/AppImage, or macOS Apple Silicon/Intel DMG from [GitHub Releases](https://github.com/A7E7-Studios/cue-review/releases). The packages include the agent CLI and speech runtime. Install FFmpeg/ffprobe separately (`winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on macOS, or `sudo apt install ffmpeg` on Ubuntu), then use Settings → Install transcription to download the speech models. Android/Quest capture additionally needs ADB and scrcpy.

The Windows installer installs per user into `%LOCALAPPDATA%\Programs\CueReview` (`cuereview.exe`, `cue.exe` and `tools\whisper-b5454`). Recordings stay in `%LOCALAPPDATA%\CueReview`, so upgrading keeps them. Close CueReview before upgrading, and never upgrade during a recording.

Windows is the hardware-verified platform. macOS uses AVFoundation; Linux uses X11/V4L2. Linux Wayland desktop capture, macOS/Linux per-window capture, macOS/Linux desktop system audio and macOS/Linux cursor tracking are not supported yet. Native macOS/Linux hardware validation remains outstanding. Windows builds are unsigned; macOS builds are ad-hoc signed without notarization. See each release's installation notes and SHA256SUMS.

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

1. Open CueReview. A fresh unnamed recording is ready. The source and microphone pickers sit directly under the preview.
2. Press Record (`Ctrl+R`, `⌘R` on macOS). While recording, the controls under the preview become the recording dock: timer, take number, microphone level, the locked source, mute, compact mode and Stop. Compact mode keeps the dock available in a small window.
3. Stop. The video is finalized and transcribed locally. Original media remains available if transcription fails; use Retry after fixing setup.
4. Find the recording in the sidebar. Its title comes from the transcript; click the title to rename it. Search (`Ctrl+K`) filters recordings by name. Drag a recording into a section, or right-click and choose **Move to section**. Sections are optional categories in the same list; drag back to Recents to ungroup. Grouping never moves the media files. Drag section headings to reorder them. Deleting a section returns its recordings to Recents; deleting a recording from its menu requires confirmation and removes its files.
5. Play the recording and click transcript words to seek. The transcript follows playback until you scroll away; **Return to playback** resumes following. **Find in transcript** searches the text, and **Focus video** hides the transcript. The standard model uses DTW alignment points for visual lookup while retaining the original word intervals and Whisper JSON. Both are model estimates, not guaranteed exact alignment.
6. **Record more** continues the same session as a new take, from the same source. The scrubber shows a tick where each take starts, and the transcript shows a "Take 2 · 0:42" divider. Only the new take is transcribed.
7. **Copy for agent**, or open the session folder.

| Action | Windows and Linux | macOS |
| --- | --- | --- |
| Record in a new draft, Record more in review, Stop while recording | `Ctrl+R` | `⌘R` |
| New recording (the only way to start a new session) | `Ctrl+N` | `⌘N` |
| Search recordings | `Ctrl+K` | `⌘K` |
| Play or pause | `Space` | `Space` |
| Seek back or forward 5 seconds | `←` / `→` | `←` / `→` |

Shortcut hints appear when you hover over or focus a control. Settings lists the same shortcuts.

**Settings** (the sliders button at the right of the title bar, or of the toolbar on macOS and Linux) holds Appearance (light or dark), the status of the recording tools with Install transcription and technical details, the vocabulary, and the shortcut list. The **vocabulary** is a short list of names and terms the transcriber should expect, separated by commas: at most 20 terms and 200 characters of plain ASCII. It is off by default; when set, it becomes a Whisper prompt for every later transcription, live and final, in the app and in `cue`. It makes the listed spellings more likely but does not guarantee them, and it does not change transcripts that already exist (retry or `cue transcribe` to apply it).

**Markers are gone** from the app in v0.2.0: no Add marker button, no M shortcut and no marker dialog. A session's existing `markers.json` stays in its folder and stays readable for this release. Point at a moment by saying it instead; `cue moments` finds those spoken moments.

Before transcription, a local detector checks for speech. An explicit successful no-speech result produces an empty transcript; detector failures remain actionable errors. When speech is present, the original audio goes through Whisper without cutting silence or changing its word-to-time mapping. Speech detection and recognition are imperfect, particularly with mixed speech/noise; review the transcript alongside the recording. Raw model output and detector diagnostics are retained when produced.

During recording, local transcription updates in short batches from the latest 30 seconds of microphone audio, or Windows system audio when no microphone is selected (roughly every eight seconds plus inference time). These provisional words may change; stopping recomputes the take's authoritative transcript. If local speech setup is missing, the recording remains usable and can be transcribed later. Device audio without a PC microphone is transcribed after stopping. System audio uses WASAPI loopback for Windows sources; supported Android devices use scrcpy's device audio.

On Windows, display and window recordings also record where the pointer was and when buttons were pressed (`cursor.jsonl`). Android device recordings record where the screen was touched, on every platform: the first finger of each touch, as a left-button press. The agent CLI reports it with frames and moments, and can draw a ring at the pointer on exported frames. Nothing is recorded for Quest, cameras, or macOS and Linux desktops.

## Storage

Default storage is `%LOCALAPPDATA%\CueReview` on Windows, `~/Library/Application Support/CueReview` on macOS and `$XDG_DATA_HOME/CueReview` (normally `~/.local/share/CueReview`) on Linux. `CUEREVIEW_DATA_DIR` changes this root; `CUEREVIEW_MODEL` and `CUEREVIEW_VAD_MODEL` can select compatible local speech and detection models. Everything is plain files:

```text
CueReview\
  settings.json            app-wide preferences (the vocabulary), shared by the app and cue
  section-order.json       sidebar section order
  projects\<id>.json       sections
  locks\<id>.lock          per-session write locks, outside the session folders
  .instance.lock           held by the app, cue record, cue transcribe and cue setup --install
  models\  tools\          speech models and the downloaded runtime
  sessions\<id>\           one recording
    session.json           name, status, durationMs and takes[]
    video.mp4              the combined recording: every take, back to back
    mic.wav  system.wav    take 1's lossless audio tracks, as recorded
    transcript.json  transcript.txt
    whisper.json  vad.txt  vad.log
    cursor.jsonl           take 1's pointer track (Windows display and window sources, Android touches)
    capture-timing.json    take 1's capture clock and canvas
    markers.json           v0.1 markers, kept readable for one release
    exports\               frames and clips written by cue
    takes\2\               take 2: its audio tracks, cursor.jsonl, capture-timing.json and Whisper output
```

Take 1 uses the session folder itself, so sessions recorded before v0.2.0 are single-take sessions with no migration. A later take records into `takes\<N>\`; once its video has been appended to `video.mp4` and verified, the take's own video copy is removed and its lossless audio stays for transcription retries. While a take is added, the folder briefly needs about twice the size of `video.mp4`.

New recordings use H.264 CRF23 at their original resolution and frame rate. After successful finalization and stream/duration verification, the duplicate native video is removed. Failed captures retain original tracks for recovery, and lossless audio is retained for transcription retries. Existing recordings are not recompressed or cleaned up automatically.

Each word retains its original `startMs`/`endMs` and may include `seekMs`, an estimated alignment point used by word clicks and phrase-based frame retrieval. Existing transcripts without this field still work. Custom speech models use their original intervals unless `CUEREVIEW_DTW_MODEL` explicitly names a compatible alignment preset, such as `base` or `base.en`; the preset is never inferred from a custom filename. The standard installed base model enables alignment automatically. Segment ids of take 2 onward start with `t2-`, `t3-`, and so on, and `transcript.json` lists where each take starts (`takes: [{index, startMs}]`).

## Agent CLI

The packages include `cue.exe` on Windows and `cue` on macOS/Linux next to the app. **Copy for agent** gives an agent the full path, the shell syntax and the data folder, so adding `cue` to PATH is optional. All times are milliseconds on the session timeline. Output is JSON on stdout (except `transcript` without `--json`); errors go to stderr with a nonzero exit. Exports are written to new files and never overwrite one. The only network access is `cue setup --install`.

| Command | What it does |
| --- | --- |
| `cue projects` | List sections (projects) as JSON. |
| `cue sessions [PROJECT_ID]` | List sessions, newest first. |
| `cue info ID` | One session: name, status, `durationMs`, `takes` and folder paths. |
| `cue transcript ID [--segments \| --json]` | Each segment's text per line; `--segments` prints `[mm:ss \| seekMs] text` lines (h:mm:ss after an hour) with a `── Take N · m:ss ──` divider where each take starts; `--json` prints the full transcript with word times. |
| `cue find ID --phrase TEXT` | Find a spoken phrase, ignoring case and punctuation: `[{occurrence, startMs, endMs, seekMs, text, cursor?}]`. |
| `cue frame ID (--at-ms MS \| --phrase TEXT [--occurrence N]) [--max-width N] [--mark-cursor] [--output PATH]` | Export one PNG: `{path, timeMs, width, height, cursor}`. |
| `cue frames ID (--at-ms MS,MS,... \| --per-segment) [--max-width N] [--mark-cursor] [--output-dir DIR]` | Export several PNGs in one call; `--per-segment` takes one at each segment's seek point and adds `segmentId`. |
| `cue clip ID --start-ms MS --end-ms MS [--output PATH]` | Export an MP4 clip: `{path}`. |
| `cue moments ID [--frames [--max-width N] [--mark-cursor]]` | Spoken pointing moments ("here", "there", "this", "these", "that", "those", "see", "look at", …) with the cursor and the clicks within 1 s: `[{segmentId, term, phrase, seekMs, startMs, endMs, text, cursor, clicks}]`, plus `frame` with `--frames`. |
| `cue rename ID NAME` | Rename a session. Works while the app is open. |
| `cue transcribe ID` | Transcribe a finished session again, locally. |
| `cue setup [--install]` | Show the transcription setup; `--install` downloads the runtime and model. |
| `cue sources`, `cue microphones` | List capture sources and microphones. |
| `cue record --source ID --seconds N [--project ID] [--mic ID] [--system-audio] [--name TEXT]` | Record and transcribe a new session. |

`cue --help` lists every command, and `cue COMMAND --help` (or `cue help COMMAND`) prints one command's options and exits 0 without opening the data folder. Unknown options are rejected. `--max-width` scales frames down to at most N pixels wide and never up. Quote `--at-ms` lists in PowerShell (`--at-ms '1000,2500'`).

`cursor` is where the pointer was at that time, `{tMs, x, y, px, py, inVideo}`: `x`/`y` are fractions of the video width and height (outside 0–1 when the pointer was off the source), `px`/`py` are video pixels, and `inVideo` is false when the pointer was on another monitor or over a window covering the source. A click is the same plus `button` (`left`, `right` or `middle`). On an Android recording, `cursor` is the finger while it touches the screen and a touch-down is a `left` click; between touches there is no position. `cursor` is `null` (or absent in `find` and `transcript --json`) when the session has no pointer track or the pointer was unknown; `--mark-cursor` then draws nothing.

The recommended agent workflow, which Copy for agent spells out with full paths:

```powershell
& 'C:\path\to\cue.exe' transcript SESSION_ID --segments
& 'C:\path\to\cue.exe' frames SESSION_ID --per-segment --max-width 1600 --mark-cursor
& 'C:\path\to\cue.exe' moments SESSION_ID
& 'C:\path\to\cue.exe' frame SESSION_ID --at-ms SEEK_MS --max-width 1600 --mark-cursor
& 'C:\path\to\cue.exe' clip SESSION_ID --start-ms START_MS --end-ms END_MS
```

Read the compact transcript first, look at one frame per segment, list the spoken pointing moments, then inspect what you need with a targeted frame or clip. Prefer `seekMs` for visual lookup; `startMs`/`endMs` keep the model's original intervals. All timestamps are estimates, so inspect neighboring frames when it matters.

Read-only commands and `rename` run while the app is open. `record`, `transcribe` and `setup --install` take the data folder's process lock and refuse to run beside the app. Every write to a session takes that session's lock in `locks\`, so the app and `cue` never lose each other's updates; the app refreshes the sidebar when its window regains focus. The CLI is the agent interface; no MCP server is needed.

## Build and verify

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
powershell -File scripts/package.ps1
```

The portable packaging command is `node scripts/package.mjs`. Release builds first run `node scripts/build-speech-runtime.mjs` (requires CMake and a C++ compiler), then package with `--require-speech-runtime`; on Windows and Linux x64 the speech runtime folder also holds a faster build for AVX2 processors in `avx2/`. Installers are produced under `src-tauri/target/release/bundle`; named release copies go to `.local/release-assets`. Explicit `--target` builds use `target/<triple>/release` and require a matching native host.

Pull requests run `.github/workflows/ci.yml` on Windows x64, Linux x64 and macOS ARM64: frontend tests and build, `cargo fmt`, Rust library tests and Clippy. Pull requests that change only Markdown, `docs/`, `specs/` or `changes/` run no CI. Pushes to main, a manual run, and a pull request labeled `build-installers` run `.github/workflows/installers.yml`, which builds on Windows x64, Linux x64, macOS ARM64 and macOS x64: the same checks, then the speech runtime, packaging, a check of the bundled executables, and the installers as run artifacts. A `v<version>` tag contained in main triggers `.github/workflows/release.yml`; it publishes only after all five installers and their checksums are available, with `.github/RELEASE_NOTES.md` as the release text. Package, Cargo and Tauri versions must match the tag. Workflow dispatch can retry an existing tag; published releases are never overwritten.

Integration tests that need FFmpeg, Whisper or hardware are `#[ignore]`d and run explicitly. Real capture checks record the screen and microphone and play two quiet tones, so run them attended:

```powershell
$env:CUEREVIEW_CAPTURE_TEST_DIR = "$PWD\test-results\native-capture"
cargo test --manifest-path src-tauri/Cargo.toml --lib capture::tests -- --include-ignored --test-threads=1
```

The `scripts/` folder holds end-to-end checks. Each uses an isolated `CUEREVIEW_DATA_DIR` and never touches normal app data:

- No app and no recording: `verify-pipeline.ps1` (known synthesized speech over a captured window, through the real model and CLI), `verify-cli.cjs` (every `cue` command, help and argument errors), `verify-failures.cjs` (missing tools and failing processes) and `verify-alignment.cjs` (phrase-to-frame lookup after ten seconds of silence).
- An owned app without recording: `verify-sidebar.cjs`, `verify-recovery.cjs` and `verify-folder-open.cjs` launch and close their own release app on a local CDP test port.
- Recording, attended: `verify-takes.cjs` (Record more on an owned test-pattern window), `verify-desktop.cjs`, `verify-native-ux.cjs` and `verify-installed.cjs` (a test app with CDP port 9224), and `verify-device-ui.cjs` (an authorized ADB device in `CUEREVIEW_TEST_DEVICE`).

The scripts put the speech runtime on PATH from `CUEREVIEW_WHISPER_DIR`, else `%LOCALAPPDATA%\CueReview\tools\whisper-b5454`, else the installed `%LOCALAPPDATA%\Programs\CueReview\tools\whisper-b5454` (`scripts/test-env.cjs`). The local CDP port is enabled only by a test launch environment, never in normal launches. See [architecture](docs/ARCHITECTURE.md) and the [verification checklist](docs/VERIFICATION.md) for boundaries, commands and remaining hardware validation. Passing display capture does not establish Android/Quest correctness. Device-to-PC-microphone alignment needs hardware measurement, and recordings should be checked before relying on millisecond-level cross-device alignment.

## UI workshop

The [design system](docs/DESIGN.md) records the Float v2 layout, tokens, window chrome, typography and motion rules. The mocks it follows are in `docs/design/float-v2/`.

Run `npm run storybook` and open `http://127.0.0.1:6006`. `npm run build-storybook` produces the standalone workshop in `storybook-static/`.

The workshop uses the application's real components (title bar, sidebar, media stage, playback bar, recording dock, transcript, dialogs and the workspace), with the same tokens and styles. Theme, motion and viewport toolbar controls make it possible to inspect light/dark appearance, reduced motion, a small window and the compact recorder. Stories cover empty, long-name, long-list, two-take, busy and error states.

Workspace stories replace the backend through Storybook-only Vite aliases. Their sample state stays in memory: they cannot capture a screen, open a microphone, download tools or read/delete recording files. The illustrative preview is generated sample artwork. These aliases and fixture assets are excluded from the production application bundle.

The accessibility panel is an inspection aid; its findings are not currently a CI acceptance gate or a claim that every story passes an accessibility audit. Existing application tests remain the behavioral gate. Native capture, playback and window-management checks still require the desktop application.

Figtree is bundled under the SIL Open Font License 1.1 through `@fontsource-variable/figtree`; no font is loaded from the network.
