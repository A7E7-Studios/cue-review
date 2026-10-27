# Architecture

CueReview is a Windows desktop application for recording a review, replaying its video alongside a local transcript, and handing selected evidence to an agent. Tauri owns native operations; React owns presentation and playback. Recording data stays in local project/session folders. No account or hosted inference service is required.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| React/WebView2 | Project/session navigation, source selection, playback, word seeking, transcript and markers |
| Tauri/Rust | Validate command arguments, own capture processes and devices, persist metadata, run local media/transcription jobs |
| Windows Graphics Capture | Capture a selected display or window through `windows-capture` |
| CPAL/WASAPI | Capture the selected microphone and optional system output loopback |
| scrcpy/ADB | Capture authorized Android devices, including compatible Quest devices |
| FFmpeg/ffprobe | Normalize and combine media, inspect duration, extract frames and clips |
| whisper.cpp | Transcribe local audio and produce timestamped token JSON |
| Local agent CLI | Discover sessions and retrieve transcript, frame, and clip evidence |

The implementation uses one active recording at a time. Long operations must run outside the UI thread. Native errors must reach the interface with recovery details; dependency or hardware failures must never return demonstration data.

## Capture and synchronization

Windows Graphics Capture is the native display/window path. FFmpeg `gdigrab` is not a substitute for universally supported system audio: DirectShow only exposes configured capture devices. WASAPI loopback reads the rendering endpoint without requiring Stereo Mix or a virtual audio driver.

Microphone and system audio have independent clocks. Retain capture offsets against one session origin, preserve silence and discontinuities, and align streams when producing the playback file. A recording must remain in sync when the output device is silent for several seconds. Muting a microphone must write silence without collapsing the timeline.

Windows Graphics Capture may emit frames only when the image changes. Stopping must be independent of receiving another frame. Encoder finalization is required after normal stop, source closure, and capture errors. A final static interval must remain represented in the finished video's duration.

scrcpy records encoded device streams with device timestamps. Those timestamps preserve device audio/video alignment; they do not automatically synchronize a separately captured PC microphone. The implementation must account for device startup latency and document any remaining alignment limit. ADB authorization and a connected device are required. Quest compatibility must be checked on the actual headset rather than inferred from Android support.

## Local transcription

Convert the transcription input to mono, 16 kHz signed 16-bit PCM WAV. Run the local `whisper-cli` with a locally stored model and full JSON output. A multilingual model supports automatic language selection; an English-only model should only be selected for English recordings.

Whisper token timestamps are estimates. Retain the original JSON. Construct display words by joining continuation tokens and punctuation, excluding model control tokens. Never manufacture word timings by evenly dividing a sentence. Store all UI/CLI offsets in milliseconds from the playback origin; seek only within the available media duration. Silence between words must clear the active-word highlight.

Transcription failure must preserve playable recorded media and offer retry. An empty result from silent audio is a valid empty transcript, not a fabricated paragraph.

During recording, a background worker takes an audio snapshot after about eight seconds and repeats after each inference plus another eight seconds. Each snapshot contains at most the latest 30 seconds. Whisper works in the session's `live` scratch directory, outside the capture/state lock. Snapshot-relative words receive the session offset; the overlapping provisional tail is replaced while earlier words remain. Results publish only for the still-active session. Stopping cancels the live subprocess, and a shared inference lock prevents overlap with final full-recording transcription. Updates arrive after local inference completes; their wording and timing can change until the final pass.

Live snapshots use the PC microphone, or Windows loopback when no microphone is selected. Android device audio by itself has no local PCM snapshot track and is transcribed after stopping; selecting a PC microphone enables progressive commentary for device reviews.

## Persistence and process ownership

Each session groups its metadata, final video, transcript, and evidence exports. Persist state transitions so a restart can identify interrupted recording or processing work. Write metadata atomically. Validate identifiers and resolve paths under the configured data directory. The agent interface should report errors on stderr and machine-readable results on stdout.

Launch dependencies with argument arrays rather than shell-generated command strings. Retain process handles, capture diagnostic output, stop recorders gracefully, and check exit status and output validity before declaring success. Killing an encoder may leave an unfinished container; intermediate recordings and logs should be retained for recovery.

## Dependency setup

Development requires Node.js, the Rust MSVC toolchain, Visual Studio C++ build tools, a Windows SDK, and WebView2. Runtime media work needs FFmpeg/ffprobe and whisper.cpp plus a model. Device capture additionally needs scrcpy and ADB. Pin dependency versions and document their source and license when bundling. Install or download tools into an application-controlled directory; a developer's PATH must not be the only working configuration in a packaged build.

Setup checks should distinguish missing executables, missing models, unavailable microphone/output endpoints, and unauthorized/disconnected devices. Only capabilities affected by a missing optional device dependency should be unavailable.

## Primary references

- [Windows WASAPI loopback](https://learn.microsoft.com/windows/win32/coreaudio/loopback-recording)
- [windows-capture](https://github.com/NiiightmareXD/windows-capture)
- [Encoder timestamp behavior](https://docs.rs/windows-capture/latest/windows_capture/encoder/struct.VideoEncoder.html)
- [CPAL](https://github.com/RustAudio/cpal)
- [scrcpy recording](https://github.com/Genymobile/scrcpy/blob/master/doc/recording.md)
- [scrcpy audio requirements](https://github.com/Genymobile/scrcpy/blob/master/doc/audio.md)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [Whisper CLI implementation](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp)
- [FFmpeg capture devices](https://ffmpeg.org/ffmpeg-devices.html)
