CueReview records visual feedback, transcribes it locally, and makes recordings available to coding agents.

## What's new in 0.2.0

- **A new workspace (Float v2).** Recordings on the left, the video with its controls under it in the center, and the transcript in a full-height column on the right. Windows gets a custom title bar with search and Settings; macOS uses the native traffic lights inside the sidebar. The interface uses the bundled Figtree font.
- **Record more.** Continue a finished recording as a new take from the same source. Takes play back as one video, with a tick on the scrubber and a "Take 2 · 0:42" divider in the transcript. Only the new take is transcribed.
- **Keyboard shortcuts.** `Ctrl+R` (`⌘R` on macOS) records, records more or stops; `Ctrl+N` starts a new recording; `Ctrl+K` searches recordings by name. Hints appear when you hover over a control.
- **Vocabulary.** In Settings, list names and terms the transcriber should expect. It is off by default.
- **Pointer tracking (Windows).** Display and window recordings remember where the pointer was and when you clicked, so agents can see what "this" and "here" referred to.
- **Agent CLI.** `cue transcript ID --segments` prints a compact, timestamped transcript; `cue frames` exports many frames in one call, one per segment if you like, scaled with `--max-width` and with the pointer ringed by `--mark-cursor`; `cue moments` lists spoken pointing moments with the pointer and nearby clicks; `cue rename` renames a session while the app is open; every command has `--help`. Copy for agent now suggests this workflow.
- The transcript follows playback until you scroll away, then offers Return to playback, and you can search inside it. The theme setting moved to Settings → Appearance.

## Removed

- **Markers:** the Add marker button, the M shortcut and the marker dialog. Existing markers stay in their session folders and remain readable in this release. Say "look at this" instead; `cue moments` finds it.
- The theme button in the sidebar (now in Settings → Appearance).

## Known limits

- Pointer tracking works only for Windows display and window recordings, not for macOS, Linux, cameras or Android/Quest devices. Very short clicks (under about 16 ms) can be missed. For a take recorded after its window was resized, pointer positions can be slightly off.
- On Windows, hovering the custom maximize button does not show the Snap Layouts menu.
- The vocabulary takes at most 20 terms (200 characters) of plain ASCII. It makes those spellings more likely, not certain, and only affects transcriptions made after you save it.
- Adding a take briefly needs about twice the recording's size in free disk space. If another program has the recording open, CueReview finishes adding the take after you close it and choose Retry, or the next time it starts.
- Builds are unsigned on Windows and ad-hoc signed, without notarization, on macOS. Windows SmartScreen or macOS Gatekeeper may ask for approval; on macOS, use System Settings → Privacy & Security → Open Anyway. macOS/Linux per-window recording, desktop system audio and Linux Wayland capture are not supported yet, and macOS/Linux hardware capture still needs real-device validation.

## Install

- Windows x64: run the `_setup.exe` installer (per-user installation). Close CueReview first; recordings in `%LOCALAPPDATA%\CueReview` are kept.
- Linux x64: install the `.deb` on Ubuntu 24.04 or newer, or mark the `.AppImage` executable and run it. The AppImage requires a compatible WebKitGTK/Linux desktop.
- macOS 12+: open the DMG matching Apple Silicon (`arm64`) or Intel (`x64`) and drag CueReview into Applications. Grant screen, microphone or camera permissions when asked.

The `cue` command and local speech runtime are included. On first use, install the speech models through Settings (about 149 MB). FFmpeg and ffprobe must be installed separately and available on PATH:
- Windows (PowerShell): `winget install --id Gyan.FFmpeg --exact`
- macOS (Homebrew): `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt update && sudo apt install ffmpeg`

Android/Quest USB capture also requires ADB and scrcpy. `SHA256SUMS` contains checksums for every installer. Existing recordings are retained when upgrading.
