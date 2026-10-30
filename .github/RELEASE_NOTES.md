CueReview records visual feedback, transcribes it locally, and makes recordings available to coding agents.

## What's new in 0.3.0

- **Clean audio.** Microphone recordings no longer crackle: the audio track is written without the tiny gaps that some microphones, such as webcams, produced every fraction of a second, so transcripts miss fewer words.
- **A legible microphone.** While recording, the dock shows the microphone's name, a level meter from −60 to 0 dBFS that shows quiet speech, and a mute that stays visible as muted rather than hiding the meter. Every take starts unmuted unless Mute is ticked before it starts.
- **One recording bar.** The same bar sits under the video before every take, with the source and microphone pickers and a red Record. In review it holds Record more, so a new take can use another microphone.
- **Record more from any source.** A new take can record any display, window or device, and each take keeps its own video. Playback moves from take to take on its own, and seeking, the transcript and search land in the right take. Sessions recorded before 0.3.0 play as they did.
- **Faster, better transcripts.** Words appear about 3 s after they are said while recording, and the transcript is ready about 3 s after Stop, whatever the take's length; the whole take is then transcribed again in the background for accuracy. Transcripts come from the small model of the language chosen in Settings → Transcription (English or German), which mishears far less than before; it downloads by itself in the background. On processors with AVX2 the speech runtime runs several times faster.
- **Search recordings and transcripts.** **Search** under New session, or `Ctrl+K` (`⌘K`), finds recordings by name and by what was said, and opens a line's recording at that moment. `Ctrl+F` (`⌘F`) finds words in the open transcript.
- **Playback.** Playback speed is chosen from a list (0.5× to 2×) and stays for every recording. **Focus video** hides the sidebar and the transcript; press it again or Escape to bring them back.
- **The sidebar.** A plain **New session** row starts a recording; right-click empty space in the sidebar for New session and New section. **Move to section** opens as a submenu. The sidebar slides when it is hidden or shown.
- **Looks.** The title bar has more room and larger icons. Scrollbars, the Appearance dropdown and dialogs match the app, the dark-mode dialog backdrop is darker, and text renders sharper. The dock no longer shows a take label or a caption.
- **Capture sources.** The source list orders displays, windows, Android/Quest devices, then cameras, starts on the first available one, and keeps your choice across refreshes. A camera preview that fails says so and offers Retry.
- **Agent CLI.** `cue frame`, `cue frames` and `cue moments --frames` read each frame from the take its time falls in. `cue setup --install` also fetches the chosen language's model.
- **Fixes.** Right-clicking no longer shows the webview's page menu (Refresh, Save as, Print). Return to playback appears only when there is playback to return to.

## Changed

- The title bar has no search field; search moved to the sidebar. The sidebar no longer filters recordings by name.
- Record more no longer joins takes into one video, so it no longer needs extra disk space or a Retry when another program holds the recording open.

## Known limits

- `cue clip` refuses a range that crosses from one take into the next.
- Pointer tracking works only for Windows display and window recordings, and touch tracking only for Android devices: not for macOS or Linux desktops, cameras or Meta Quest. Very short clicks (under about 16 ms) can be missed.
- Touch tracking records the first finger of a gesture, not the others. A touch within about a second of turning the phone can be placed as if it had not turned yet.
- When an Android recording turns between portrait and landscape, the turned part keeps the first part's frame size, with black bars, so it plays smaller.
- On Windows, hovering the custom maximize button does not show the Snap Layouts menu.
- The vocabulary takes at most 20 terms (200 characters) of plain ASCII. It makes those spellings more likely, not certain, and only affects transcriptions made after you save it.
- Builds are unsigned on Windows and ad-hoc signed, without notarization, on macOS. Windows SmartScreen or macOS Gatekeeper may ask for approval; on macOS, use System Settings → Privacy & Security → Open Anyway. macOS/Linux per-window recording, desktop system audio and Linux Wayland capture are not supported yet, and macOS/Linux hardware capture still needs real-device validation.

## Install

- Windows x64: run the `_setup.exe` installer (per-user installation). Close CueReview first; recordings in `%LOCALAPPDATA%\CueReview` are kept.
- Linux x64: install the `.deb` on Ubuntu 24.04 or newer, or mark the `.AppImage` executable and run it. The AppImage requires a compatible WebKitGTK/Linux desktop.
- macOS 12+: open the DMG matching Apple Silicon (`arm64`) or Intel (`x64`) and drag CueReview into Applications. Grant screen, microphone or camera permissions when asked.

The `cue` command and local speech runtime are included. On first use, install transcription through Settings: the runtime and the base model (about 148 MB), then the chosen language's model in the background (about 488 MB). FFmpeg and ffprobe must be installed separately and available on PATH:
- Windows (PowerShell): `winget install --id Gyan.FFmpeg --exact`
- macOS (Homebrew): `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt update && sudo apt install ffmpeg`

Android/Quest USB capture also requires ADB and scrcpy. `SHA256SUMS` contains checksums for every installer. Existing recordings are retained when upgrading.
