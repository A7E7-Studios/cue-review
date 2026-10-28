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

Previews use a continuous MJPEG response over an ephemeral loopback listener with a random per-stream URL token. There is no screenshot polling or per-frame React state update. Windows capture pushes JPEG frames directly; device previews run the installed matching scrcpy server in video-only raw-stream mode on a unique ADB forward and decode H.264 with FFmpeg. Cameras use a continuous DirectShow/FFmpeg capture. Only the latest frame is retained if the viewer falls behind. Preview resolution is bounded independently of recording resolution. Starting a recording keeps the existing preview stream; switching sources or entering review stops its owned resources. Frontend start/stop operations are ordered, and stale stop IDs cannot terminate a newer stream. Source errors reach the UI through a Tauri channel. Meta/Oculus Quest virtual-camera filters are excluded from enumeration in favor of authorized USB devices.

Final playback encoding uses x264 veryfast CRF23, retaining capture resolution and frame rate. A successful encoder exit is followed by stream and duration validation; only a clean capture with verified output removes its owned native-video.mp4 or native-video.mkv intermediate. Capture/finalization failures retain the native video. Lossless audio and transcription evidence remain available for retry. This policy applies to new captures, without retroactive changes to existing recordings.

## Local transcription

Convert the transcription input to mono, 16 kHz signed 16-bit PCM WAV. Run the local `whisper-cli` with a locally stored model and full JSON output. A multilingual model supports automatic language selection; an English-only model should only be selected for English recordings.

Before inference, the bundled `whisper-vad-speech-segments` executable checks the entire input with a pinned Silero v6.2.0 model. A valid zero-region result produces an empty transcript. Any detected speech passes the original, unchanged PCM to Whisper, preserving its playback clock. Detector errors or malformed output remain failures with diagnostics, never silent success. This whole-input gate suppresses the tested noise-only hallucinations; it does not remove noise from mixed speech/noise recordings. The detector can also miss speech.

Whisper token timestamps are estimates. Retain the original JSON. Construct display words by joining continuation tokens and punctuation, excluding model control tokens. Never manufacture word timings by evenly dividing a sentence. Store all UI/CLI offsets in milliseconds from the playback origin; seek only within the available media duration. Silence between words must clear the active-word highlight.

Leading silence can substantially distort the first word's estimated interval: a ten-second delayed fixture placed its first word near zero while later words retained their original clock. The standard model therefore enables DTW with flash attention disabled. Its token alignment points populate optional word `seekMs` fields, preserving raw `startMs`/`endMs`. Word and sentence clicks and phrase-based frame extraction prefer these points. Highlighting uses a short visual pulse near an alignment point, not a fabricated spoken interval; old transcripts retain interval highlighting. Live updates shift alignment points onto the session clock and bound them to the snapshot. Custom models require an explicit compatible `CUEREVIEW_DTW_MODEL` preset to enable this path.

Alignment increased the measured two-thread inference time from roughly 2.2 to 4.0 seconds. It supplies estimated points, not corrected spoken durations. Direct Whisper VAD transcription altered the tested token clock, so the detector remains a whole-input gate and recognition receives the original PCM unchanged.

Transcription failure must preserve playable recorded media and offer retry. An empty result from silent audio is a valid empty transcript, not a fabricated paragraph.

During recording, a background worker takes an audio snapshot after about eight seconds and repeats after each inference plus another eight seconds. Each snapshot contains at most the latest 30 seconds. Whisper works in the session's `live` scratch directory, outside the capture/state lock. Snapshot-relative words receive the session offset; the overlapping provisional tail is replaced while earlier words remain. Results publish only for the still-active session. Stopping cancels the live subprocess, and a shared inference lock prevents overlap with final full-recording transcription. Updates arrive after local inference completes; their wording and timing can change until the final pass.

Live snapshots use the PC microphone, or Windows loopback when no microphone is selected. Android device audio by itself has no local PCM snapshot track and is transcribed after stopping; selecting a PC microphone enables progressive commentary for device reviews.

## Persistence and process ownership

Each session groups its metadata, final video, transcript, and evidence exports. Persist state transitions so a restart can identify interrupted recording or processing work. Write metadata atomically. Validate identifiers and resolve paths under the configured data directory. The agent interface should report errors on stderr and machine-readable results on stdout.

The sidebar presents optional collapsible sections and ungrouped Recents in one list, without project tabs or a recording-header category picker. Sections reuse the existing project metadata and IDs. New recordings have `projectId: null`; dragging into a section or using Move to section changes only that field, leaving the session directory unchanged. Dropping back into Recents clears it. Section expansion is remembered locally, and unknown section IDs fall back to Recents so recordings remain reachable. WebView native file-drop interception is disabled to support HTML drag-and-drop on Windows. Unnamed recordings carry `autoTitle: true` and receive a short title from the first nonempty transcript phrase. An explicit rename clears that flag. Legacy sessions default to manual titles and retain their existing project IDs, requiring no destructive migration.

Section order is saved atomically in section-order.json. Deleting a section first clears each member recording's projectId, then removes the section metadata. Deleting a recording validates the physical UUID directory under the configured sessions root, rejects linked/reparse paths, and removes its payload before session.json so a locked-file failure remains retryable. UI confirmation identifies the recording and the selected video is unloaded before deleting its files. Runtime ownership guards serialize these operations against capture/transcription start; partial section failures refresh sidebar membership.

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
