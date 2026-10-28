CueReview records visual feedback, transcribes it locally, and makes recordings available to coding agents.

Downloads:
- Windows x64: run the `_setup.exe` installer (per-user installation).
- Linux x64: install the `.deb` on Ubuntu 24.04 or newer, or mark the `.AppImage` executable and run it. The AppImage requires a compatible WebKitGTK/Linux desktop; Wayland screen capture is not yet supported.
- macOS 12+: open the DMG matching Apple Silicon (`arm64`) or Intel (`x64`) and drag CueReview into Applications.

The `cue` command and local speech runtime are included. On first use, install the speech models through CueReview (about 149 MB). FFmpeg and ffprobe must be installed separately and available on PATH. Android/Quest USB capture also requires ADB and scrcpy.

Install FFmpeg, then restart CueReview:
- Windows (PowerShell): `winget install --id Gyan.FFmpeg --exact`
- macOS (Homebrew): `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt update && sudo apt install ffmpeg`

Confirm both `ffmpeg -version` and `ffprobe -version` work in a new terminal. The app also checks the standard Homebrew binary directories on macOS.

Windows display/window recording, microphone, desktop audio and USB device capture are supported. macOS screen/camera capture uses AVFoundation; Linux desktop/camera capture uses X11/V4L2. macOS/Linux per-window recording and desktop system audio are not yet supported. macOS/Linux hardware capture still needs real-device validation.

These initial builds are unsigned on Windows and ad-hoc signed, without notarization, on macOS. Windows SmartScreen or macOS Gatekeeper may ask for approval. On macOS, use System Settings → Privacy & Security → Open Anyway after attempting to open the app. Grant screen, microphone or camera permissions when requested.

`SHA256SUMS` contains checksums for every installer. Existing recordings are retained when upgrading.
