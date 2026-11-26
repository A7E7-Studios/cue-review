use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub auto_title: bool,
    pub created_at: String,
    pub duration_ms: u64,
    pub status: String,
    pub video_path: Option<String>,
    pub folder_path: String,
    pub error: Option<String>,
    pub source_id: String,
    pub microphone_id: Option<String>,
    pub system_audio: bool,
    /// Every take of this session, in recording order. Empty for sessions
    /// recorded before takes existed: their root files are take 1.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub takes: Vec<Take>,
    /// `session.json`'s format: 1 (written as no field) when one video,
    /// `video.mp4`, holds the whole timeline; 2 once `videos` lists the take
    /// videos. A reader refuses a format it does not know.
    #[serde(
        default = "format_one",
        rename = "formatVersion",
        skip_serializing_if = "is_format_one"
    )]
    pub format_version: u32,
    /// The take videos on the timeline, in order (format 2). Empty in format
    /// 1, where `video.mp4` plays from 0 for `duration_ms`. A take on the
    /// timeline without an entry of its own plays inside the entry before it:
    /// the takes joined into `video.mp4` before takes kept their own videos.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub videos: Vec<TakeVideo>,
    /// What `source_id` named when the session was first recorded, since a
    /// window handle or display number can name something else later. `None`
    /// for sessions recorded before this existed and for sources other than
    /// Windows windows and displays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_identity: Option<SourceIdentity>,
    /// Where an Android or Quest device was gone while it was recorded, on
    /// the session timeline: the video is black there.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub device_gaps: Vec<DeviceGap>,
}

/// A stretch of the session timeline without device video.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceGap {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// The newest `session.json` format this build reads and writes.
pub const FORMAT_VERSION: u32 = 2;
fn format_one() -> u32 {
    1
}
fn is_format_one(version: &u32) -> bool {
    *version == 1
}

/// One take's video on the session timeline. Its file is derived from
/// `take`, never stored: `video.mp4` in the session folder for take 1,
/// `takes/<N>/video.mp4` after.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeVideo {
    pub take: u32,
    /// Where the video starts on the session timeline.
    pub start_ms: u64,
    pub duration_ms: u64,
}

/// A Windows window or display as it was at first capture, serialized with a
/// `kind` of `"window"` or `"display"`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SourceIdentity {
    Window {
        title: String,
        /// Image name of the owning process, for example `"Code.exe"`.
        process: String,
        /// Window class name.
        class: String,
        /// Id of the owning process. `None` in sessions recorded before it
        /// was stored.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
        /// When the owning process was created, in ms since the Unix epoch
        /// (`GetProcessTimes`). With `pid` it tells the process apart from a
        /// later one that reuses its id, as after a restart. `None` in older
        /// sessions and when the process could not be opened.
        #[serde(
            default,
            rename = "processCreatedMs",
            skip_serializing_if = "Option::is_none"
        )]
        process_created_ms: Option<u64>,
    },
    Display {
        /// GDI device name, for example `"\\\\.\\DISPLAY1"`.
        device: String,
        /// Monitor bounds in physical pixels.
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    },
}

/// Lifecycle of one take. Serialized in lowercase, for example `"swapping"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TakeStatus {
    /// Capture is running.
    Recording,
    /// Capture stopped; the take's own media is being finalized.
    Finalizing,
    /// Waiting to be joined into `video.mp4`: only in sessions saved before
    /// takes kept their own videos, until [`crate::takes::recover`] (at
    /// startup) or [`crate::takes::upgrade`] (in Retry or `cue transcribe`)
    /// upgrades it.
    Swapping,
    /// The take's audio is being transcribed.
    Transcribing,
    Ready,
    Error,
    /// The app closed while this take was recording.
    Interrupted,
}

/// One continuous capture inside a session. Take N is recorded into
/// `sessions/<id>/takes/<N>/`; the legacy root files are take 1.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    /// 1-based take number, shown as "Take N".
    pub index: u32,
    /// Where this take starts on the session timeline.
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub status: TakeStatus,
    /// Folder relative to the session folder, for example `"takes/2"`.
    /// Take 1 of a legacy session uses `"."`.
    pub folder: String,
    /// Source of this take. `None` means the session's `source_id`: take 1,
    /// and takes recorded before Record more could choose another source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Microphone this take recorded, `None` for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_id: Option<String>,
    /// Whether this take recorded system or device audio.
    #[serde(default)]
    pub system_audio: bool,
}

/// Start of a take on the session timeline, used for the
/// "Take N · m:ss" divider. A transcript lists one mark per take, in order,
/// with take 1 at 0.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeMark {
    pub index: u32,
    pub start_ms: u64,
    /// The language the take was transcribed in: its microphone track's
    /// when it has two tracks, or its system track's when the microphone has
    /// no words. `None` for a take without words and in transcripts saved
    /// before takes kept their language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Whether Auto found `language`; false when it was chosen in Settings.
    #[serde(default, skip_serializing_if = "is_false")]
    pub language_detected: bool,
    /// Each track's language, for a take transcribed from two tracks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_languages: Option<TrackLanguages>,
}

/// One of the two audio tracks a take can be transcribed from. Serialized
/// as `"microphone"` or `"system"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    /// What the microphone heard: `mic.wav`.
    Microphone,
    /// What the computer played: `system.wav`.
    System,
}
impl Track {
    /// The take's audio file of this track.
    pub fn file(self) -> &'static str {
        match self {
            Track::Microphone => "mic.wav",
            Track::System => "system.wav",
        }
    }
    /// `"microphone"` or `"system"`, as it is serialized.
    pub fn name(self) -> &'static str {
        match self {
            Track::Microphone => "microphone",
            Track::System => "system",
        }
    }
}

/// The language one track of a take was transcribed in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLanguage {
    pub language: String,
    /// Whether Auto found `language`; false when it was chosen in Settings.
    #[serde(default, skip_serializing_if = "is_false")]
    pub language_detected: bool,
}
/// The languages of a take transcribed from two tracks. A track without
/// words, or not decided yet while it records, has none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackLanguages {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<TrackLanguage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<TrackLanguage>,
}
impl TrackLanguages {
    /// The two tracks' languages, each with whether Auto found it; `None`
    /// when neither track has one.
    pub fn of(microphone: Option<(String, bool)>, system: Option<(String, bool)>) -> Option<Self> {
        let language = |found: Option<(String, bool)>| {
            found.map(|(language, language_detected)| TrackLanguage {
                language,
                language_detected,
            })
        };
        let languages = Self {
            microphone: language(microphone),
            system: language(system),
        };
        (languages != Self::default()).then_some(languages)
    }
    /// The language a reader that knows one per take is given: the
    /// microphone's, or the system's when the microphone has none.
    pub fn first(&self) -> Option<&TrackLanguage> {
        self.microphone.as_ref().or(self.system.as_ref())
    }
}
fn is_false(value: &bool) -> bool {
    !*value
}

/// A language the speech model knows, for the list in Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Language {
    /// Whisper's code, for example `"de"`.
    pub code: String,
    /// Its English name, for example `"German"`.
    pub name: String,
}

/// App-wide preferences stored in `<root>/settings.json`, shared by the app
/// and the `cue` CLI. Every field is optional so older files stay readable.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Terms passed to Whisper as a prompt. `None` keeps the prompt off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocabulary: Option<String>,
    /// The language every take is held to, one of the speech model's codes
    /// (`"en"`, `"de"`, ...). `None` means Auto: each take's language is
    /// detected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// `"large"` when the larger model (large-v3-turbo) is chosen; `None` is
    /// Standard, the small models. Any other value reads as Standard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `false` when the switch "Use the graphics card" is off, which keeps
    /// transcription on the processor; `None` is on. `true` is never stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graphics_card: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    /// Model alignment point for visual lookup, not an invented word boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seek_ms: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub words: Vec<Word>,
    /// The track it was heard on, in a take transcribed from two tracks.
    /// `None` in a take with one track and in transcripts made earlier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<Track>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub segments: Vec<Segment>,
    /// The language the words were transcribed in. In a session with takes
    /// it is the first take's, and each take's own is on its [`TakeMark`].
    pub language: Option<String>,
    /// Whether Auto found `language`; false when it was chosen in Settings.
    #[serde(default, skip_serializing_if = "is_false")]
    pub language_detected: bool,
    /// Each track's language when the take was transcribed from two tracks;
    /// `language` is then the microphone's, or the system's when the
    /// microphone has no words. In a session with takes it is the first
    /// take's, as `language` is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_languages: Option<TrackLanguages>,
    pub status: Option<String>,
    pub error: Option<String>,
    /// Where each take starts on the session timeline. Empty for sessions
    /// with a single take.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub takes: Vec<TakeMark>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub time_ms: u64,
    pub label: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub available: bool,
    pub detail: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Microphone {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    pub source_id: String,
    pub microphone_id: Option<String>,
    pub system_audio: bool,
    pub fps: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub state: String,
    pub session_id: Option<String>,
    pub elapsed_ms: u64,
    pub audio_level: f32,
    pub error: Option<String>,
    pub live_transcript: Option<Transcript>,
    /// The take being recorded or processed, when the session has takes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_index: Option<u32>,
    /// Where that take starts on the session timeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_offset_ms: Option<u64>,
    /// Counts the transcripts refined after Stop; the app reloads the open
    /// recording's transcript when it changes.
    #[serde(default)]
    pub transcript_revision: u64,
    /// While a device take records: `"connected"` or `"reconnecting"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub detail: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub ready: bool,
    pub issues: Vec<String>,
    pub dependencies: Vec<Dependency>,
    pub model_ready: bool,
    pub model_path: Option<String>,
    /// The models the chosen language needs, in download order: both small
    /// models for Auto. Empty when `CUEREVIEW_MODEL` replaces them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub language_models: Vec<LanguageModel>,
    /// Where transcription runs.
    pub speech_device: SpeechDevice,
}

/// Where transcription runs, for Settings and `cue setup`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDevice {
    pub state: DeviceState,
    /// Where final transcription runs now.
    pub kind: DeviceKind,
    /// The graphics card's name when `kind` is `graphicsCard`, as Vulkan
    /// names it ("NVIDIA GeForce RTX 5090").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The card that measured fastest, faster than the processor, in the last
    /// measurement, even while the switch is off or the card is stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<SpeechCard>,
    /// The card ran the sample in two thirds of the processor's time or
    /// less, so the larger model is offered.
    pub large_offered: bool,
    /// The larger model is installed and was timed on the card slower than
    /// the processor with the small model: the small models transcribe.
    pub large_slow: bool,
    /// The larger model transcribes final runs now: chosen, installed,
    /// timed on the card no slower than the processor with the small model,
    /// and the runs go to the card.
    pub large_in_use: bool,
    /// The speech runtime here has its graphics-card build, so the devices
    /// are measured and can be tested again; false on macOS, Linux and a
    /// runtime without the Vulkan build.
    pub measurable: bool,
}
/// Whether the devices are being measured.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceState {
    /// Being timed in the background; transcription runs on the processor
    /// meanwhile.
    Measuring,
    Ready,
}
/// The kind of device final transcription runs on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    GraphicsCard,
    Processor,
}
/// The graphics card of the last measurement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCard {
    pub name: String,
    /// A run on it failed or turned out to use the processor; the processor
    /// transcribes until the devices are measured again.
    pub stopped: bool,
}
impl SpeechDevice {
    /// The processor, with nothing measured: no saved measurement, or no
    /// graphics build of the runtime.
    pub fn processor() -> Self {
        Self {
            state: DeviceState::Ready,
            kind: DeviceKind::Processor,
            name: None,
            card: None,
            large_offered: false,
            large_slow: false,
            large_in_use: false,
            measurable: false,
        }
    }
}

/// The state of one speech model the chosen language needs, for Settings and
/// `cue setup`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModel {
    /// The model's name: `"small.en"`, `"small"` or `"large-v3-turbo"`.
    pub model: String,
    /// `"ready"`, `"downloading"`, `"failed"` or `"missing"`.
    pub state: String,
    pub received_bytes: u64,
    pub total_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;
    #[test]
    fn the_language_models_are_reported_in_camel_case() {
        let model = |model: &str, state: &str, received_bytes, total_bytes| LanguageModel {
            model: model.into(),
            state: state.into(),
            received_bytes,
            total_bytes,
            error: None,
        };
        let mut status = SetupStatus {
            ready: true,
            issues: Vec::new(),
            dependencies: Vec::new(),
            model_ready: true,
            model_path: None,
            language_models: vec![
                model("small.en", "ready", 487_614_201, 487_614_201),
                model("small", "downloading", 5, 487_601_967),
            ],
            speech_device: SpeechDevice::processor(),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap()["languageModels"],
            json!([
                {"model":"small.en","state":"ready","receivedBytes":487_614_201u64,"totalBytes":487_614_201u64},
                {"model":"small","state":"downloading","receivedBytes":5,"totalBytes":487_601_967u64}
            ])
        );
        status.language_models[1].state = "failed".into();
        status.language_models[1].error = Some("The download was cut off.".into());
        let failed = serde_json::to_value(&status).unwrap();
        assert_eq!(
            failed["languageModels"][1]["error"],
            json!("The download was cut off.")
        );
        // A custom model replaces them: the list is left out.
        status.language_models.clear();
        let custom = serde_json::to_value(&status).unwrap();
        assert!(custom.get("languageModels").is_none() && custom.get("languageModel").is_none());
    }

    #[test]
    fn the_transcription_device_is_reported_in_camel_case() {
        let card = |stopped| SpeechCard {
            name: "NVIDIA GeForce RTX 5090".into(),
            stopped,
        };
        let mut status = SetupStatus {
            ready: true,
            issues: Vec::new(),
            dependencies: Vec::new(),
            model_ready: true,
            model_path: None,
            language_models: Vec::new(),
            speech_device: SpeechDevice {
                state: DeviceState::Ready,
                kind: DeviceKind::GraphicsCard,
                name: Some("NVIDIA GeForce RTX 5090".into()),
                card: Some(card(false)),
                large_offered: true,
                large_slow: false,
                large_in_use: true,
                measurable: true,
            },
        };
        // A fast card transcribes: an agent reads its name and its kind.
        assert_eq!(
            serde_json::to_value(&status).unwrap()["speechDevice"],
            json!({
                "state": "ready",
                "kind": "graphicsCard",
                "name": "NVIDIA GeForce RTX 5090",
                "card": {"name": "NVIDIA GeForce RTX 5090", "stopped": false},
                "largeOffered": true,
                "largeSlow": false,
                "largeInUse": true,
                "measurable": true
            })
        );
        // The card stopped: the processor transcribes with the small models,
        // and the card says so.
        status.speech_device = SpeechDevice {
            kind: DeviceKind::Processor,
            name: None,
            card: Some(card(true)),
            large_in_use: false,
            ..status.speech_device
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap()["speechDevice"],
            json!({
                "state": "ready",
                "kind": "processor",
                "card": {"name": "NVIDIA GeForce RTX 5090", "stopped": true},
                "largeOffered": true,
                "largeSlow": false,
                "largeInUse": false,
                "measurable": true
            })
        );
        // Measuring, and a computer without a usable card: no name, no card.
        let measuring = SpeechDevice {
            state: DeviceState::Measuring,
            measurable: true,
            ..SpeechDevice::processor()
        };
        assert_eq!(
            serde_json::to_value(&measuring).unwrap(),
            json!({"state":"measuring","kind":"processor","largeOffered":false,"largeSlow":false,"largeInUse":false,"measurable":true})
        );
        // Without the graphics-card build there is nothing to measure.
        assert_eq!(
            serde_json::to_value(SpeechDevice::processor()).unwrap(),
            json!({"state":"ready","kind":"processor","largeOffered":false,"largeSlow":false,"largeInUse":false,"measurable":false})
        );
        // What `cue setup` prints reads back as the same device.
        let printed = serde_json::to_string_pretty(&status).unwrap();
        let read: SetupStatus = serde_json::from_str(&printed).unwrap();
        assert_eq!(read.speech_device, status.speech_device);
    }

    // Byte-for-byte what v0.1.0 writes through `store::write_json`
    // (`serde_json::to_vec_pretty`, no trailing newline).
    const SESSION_ID: &str = "0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10";
    const LEGACY_SESSION: &str = r#"{
  "id": "0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10",
  "projectId": "5d9a7b0c-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  "name": "Library selection and details",
  "autoTitle": true,
  "createdAt": "2026-10-27T10:42:00.123456+00:00",
  "durationMs": 134000,
  "status": "ready",
  "videoPath": "C:\\Users\\me\\AppData\\Local\\CueReview\\sessions\\0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10\\video.mp4",
  "folderPath": "C:\\Users\\me\\AppData\\Local\\CueReview\\sessions\\0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10",
  "error": null,
  "sourceId": "monitor:1",
  "microphoneId": "mic:Studio microphone",
  "systemAudio": false
}"#;
    const LEGACY_TRANSCRIPT: &str = r#"{
  "segments": [
    {
      "id": "segment-0",
      "startMs": 1000,
      "endMs": 3500,
      "text": "Look here.",
      "words": [
        {
          "text": "Look",
          "startMs": 1000,
          "endMs": 1800,
          "seekMs": 1220
        },
        {
          "text": "here.",
          "startMs": 2500,
          "endMs": 3500
        }
      ]
    }
  ],
  "language": "en",
  "status": "complete",
  "error": null
}"#;

    #[test]
    fn legacy_files_reserialize_byte_identical() {
        let session: Session = serde_json::from_str(LEGACY_SESSION).unwrap();
        assert!(session.takes.is_empty());
        assert_eq!(
            serde_json::to_vec_pretty(&session).unwrap(),
            LEGACY_SESSION.as_bytes()
        );
        let transcript: Transcript = serde_json::from_str(LEGACY_TRANSCRIPT).unwrap();
        assert!(transcript.takes.is_empty());
        assert_eq!(
            serde_json::to_vec_pretty(&transcript).unwrap(),
            LEGACY_TRANSCRIPT.as_bytes()
        );

        // The same holds through the store's own read and atomic write path,
        // for the file in its own data folder. (A session read from a copied
        // or moved data folder takes its paths from where it is now; see
        // `store::tests::a_copied_data_folder_uses_its_own_session_files`.)
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let folder = store.session_dir(SESSION_ID).unwrap();
        // Each stored path is swapped whole, so it uses this platform's
        // separators and names the folder exactly as the store reads it.
        let quoted =
            |path: &std::path::Path| serde_json::to_string(&path.to_string_lossy()).unwrap();
        let legacy_folder =
            format!(r"C:\\Users\\me\\AppData\\Local\\CueReview\\sessions\\{SESSION_ID}");
        let in_place = LEGACY_SESSION
            .replace(
                &format!(r#""{legacy_folder}\\video.mp4""#),
                &quoted(&folder.join("video.mp4")),
            )
            .replace(&format!(r#""{legacy_folder}""#), &quoted(&folder));
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("session.json"), &in_place).unwrap();
        std::fs::write(folder.join("transcript.json"), LEGACY_TRANSCRIPT).unwrap();
        let session = store.session(SESSION_ID).unwrap();
        store.save_session(&session).unwrap();
        let transcript = store.transcript(SESSION_ID).unwrap();
        store.save_transcript(SESSION_ID, &transcript).unwrap();
        assert_eq!(
            std::fs::read(folder.join("session.json")).unwrap(),
            in_place.as_bytes()
        );
        assert_eq!(
            std::fs::read(folder.join("transcript.json")).unwrap(),
            LEGACY_TRANSCRIPT.as_bytes()
        );
    }

    #[test]
    fn new_fields_use_camel_case_and_are_omitted_when_empty() {
        let mut session: Session = serde_json::from_str(LEGACY_SESSION).unwrap();
        session.takes = vec![Take {
            index: 2,
            offset_ms: 134000,
            duration_ms: 8000,
            status: TakeStatus::Swapping,
            folder: "takes/2".into(),
            source_id: None,
            microphone_id: Some("mic:Headset".into()),
            system_audio: true,
        }];
        let value = serde_json::to_value(&session).unwrap();
        assert_eq!(
            value["takes"],
            json!([{"index":2,"offsetMs":134000,"durationMs":8000,"status":"swapping",
                "folder":"takes/2","microphoneId":"mic:Headset","systemAudio":true}])
        );
        let restored: Session = serde_json::from_value(value).unwrap();
        assert_eq!(restored.takes, session.takes);
        // Format 1 writes no formatVersion and no videos; format 2 both.
        let value = serde_json::to_value(&session).unwrap();
        assert!(value.get("formatVersion").is_none() && value.get("videos").is_none());
        assert_eq!(session.format_version, 1);
        session.format_version = FORMAT_VERSION;
        session.videos = vec![TakeVideo {
            take: 2,
            start_ms: 134000,
            duration_ms: 8000,
        }];
        let value = serde_json::to_value(&session).unwrap();
        assert_eq!(value["formatVersion"], json!(2));
        assert_eq!(
            value["videos"],
            json!([{"take":2,"startMs":134000,"durationMs":8000}])
        );
        let restored: Session = serde_json::from_value(value).unwrap();
        assert_eq!(
            (restored.format_version, restored.videos),
            (2, session.videos.clone())
        );
        session.format_version = 1;
        session.videos.clear();
        assert!(serde_json::to_value(&session)
            .unwrap()
            .get("sourceIdentity")
            .is_none());
        for (identity, expected) in [
            (
                SourceIdentity::Window {
                    title: "Review — Notes".into(),
                    process: "notes.exe".into(),
                    class: "NotesWindow".into(),
                    pid: None,
                    process_created_ms: None,
                },
                json!({"kind":"window","title":"Review — Notes","process":"notes.exe","class":"NotesWindow"}),
            ),
            (
                SourceIdentity::Window {
                    title: "Review — Notes".into(),
                    process: "notes.exe".into(),
                    class: "NotesWindow".into(),
                    pid: Some(4242),
                    process_created_ms: Some(1_793_000_000_123),
                },
                json!({"kind":"window","title":"Review — Notes","process":"notes.exe","class":"NotesWindow",
                    "pid":4242,"processCreatedMs":1_793_000_000_123_u64}),
            ),
            (
                SourceIdentity::Display {
                    device: r"\\.\DISPLAY1".into(),
                    left: -1920,
                    top: 0,
                    right: 0,
                    bottom: 1080,
                },
                json!({"kind":"display","device":r"\\.\DISPLAY1","left":-1920,"top":0,"right":0,"bottom":1080}),
            ),
        ] {
            session.source_identity = Some(identity.clone());
            let value = serde_json::to_value(&session).unwrap();
            assert_eq!(value["sourceIdentity"], expected);
            let restored: Session = serde_json::from_value(value).unwrap();
            assert_eq!(restored.source_identity, Some(identity));
        }
        for (status, name) in [
            (TakeStatus::Recording, "recording"),
            (TakeStatus::Finalizing, "finalizing"),
            (TakeStatus::Swapping, "swapping"),
            (TakeStatus::Transcribing, "transcribing"),
            (TakeStatus::Ready, "ready"),
            (TakeStatus::Error, "error"),
            (TakeStatus::Interrupted, "interrupted"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
        }

        let mut transcript = Transcript {
            takes: vec![TakeMark {
                index: 2,
                start_ms: 134000,
                ..Default::default()
            }],
            ..Default::default()
        };
        let value = serde_json::to_value(&transcript).unwrap();
        assert_eq!(value["takes"], json!([{"index":2,"startMs":134000}]));
        assert!(value.get("languageDetected").is_none());
        // A take's language, and whether Auto found it.
        transcript.language = Some("de".into());
        transcript.language_detected = true;
        transcript.takes[0].language = Some("en".into());
        transcript.takes.push(TakeMark {
            index: 3,
            start_ms: 150000,
            language: Some("de".into()),
            language_detected: true,
            track_languages: None,
        });
        let value = serde_json::to_value(&transcript).unwrap();
        assert_eq!(
            (&value["language"], &value["languageDetected"]),
            (&json!("de"), &json!(true))
        );
        assert_eq!(
            value["takes"],
            json!([{"index":2,"startMs":134000,"language":"en"},
                {"index":3,"startMs":150000,"language":"de","languageDetected":true}])
        );
        let restored: Transcript = serde_json::from_value(value).unwrap();
        assert_eq!(restored.takes, transcript.takes);
        assert!(restored.language_detected);
        // A take transcribed from two tracks: each row's track, and each
        // track's language on the take and on the transcript.
        let row = |track| Segment {
            id: "segment-0".into(),
            start_ms: 0,
            end_ms: 10,
            text: "Hi".into(),
            words: Vec::new(),
            track,
        };
        for (track, name) in [(Track::System, "system"), (Track::Microphone, "microphone")] {
            assert_eq!(
                serde_json::to_value(row(Some(track))).unwrap()["track"],
                json!(name)
            );
            assert_eq!(track.name(), name);
        }
        assert!(serde_json::to_value(row(None))
            .unwrap()
            .get("track")
            .is_none());
        let read: Segment = serde_json::from_value(
            json!({"id":"s","startMs":0,"endMs":1,"text":"","words":[],"track":"microphone"}),
        )
        .unwrap();
        assert_eq!(read.track, Some(Track::Microphone));
        assert_eq!(
            (Track::Microphone.file(), Track::System.file()),
            ("mic.wav", "system.wav")
        );
        let languages = TrackLanguages::of(Some(("de".into(), true)), Some(("en".into(), false)));
        transcript.track_languages = languages.clone();
        transcript.takes[1].track_languages = languages.clone();
        let value = serde_json::to_value(&transcript).unwrap();
        let expected = json!({"microphone":{"language":"de","languageDetected":true},
            "system":{"language":"en"}});
        assert_eq!(value["trackLanguages"], expected);
        assert_eq!(value["takes"][1]["trackLanguages"], expected);
        assert!(value["takes"][0].get("trackLanguages").is_none());
        let restored: Transcript = serde_json::from_value(value).unwrap();
        assert_eq!(restored.track_languages, languages);
        assert_eq!(restored.takes, transcript.takes);
        // A track without words has no language, and without either there
        // is nothing to write; the first is the microphone's when it has one.
        assert_eq!(TrackLanguages::of(None, None), None);
        let system_only = TrackLanguages::of(None, Some(("en".into(), true))).unwrap();
        assert_eq!(
            serde_json::to_value(&system_only).unwrap(),
            json!({"system":{"language":"en","languageDetected":true}})
        );
        assert_eq!(system_only.first().unwrap().language, "en");
        assert_eq!(languages.unwrap().first().unwrap().language, "de");

        let mut status = RecordingStatus {
            state: "idle".into(),
            session_id: None,
            elapsed_ms: 0,
            audio_level: 0.,
            error: None,
            live_transcript: None,
            take_index: None,
            take_offset_ms: None,
            transcript_revision: 0,
            device: None,
        };
        let idle = serde_json::to_value(&status).unwrap();
        assert!(idle.get("takeIndex").is_none() && idle.get("takeOffsetMs").is_none());
        status.take_index = Some(2);
        status.take_offset_ms = Some(134000);
        let recording = serde_json::to_value(&status).unwrap();
        assert_eq!(
            (&recording["takeIndex"], &recording["takeOffsetMs"]),
            (&json!(2), &json!(134000))
        );

        assert_eq!(serde_json::to_string(&Settings::default()).unwrap(), "{}");
        let settings: Settings =
            serde_json::from_str(r#"{"vocabulary":"CueReview, Tauri","later":1}"#).unwrap();
        assert_eq!(settings.vocabulary.as_deref(), Some("CueReview, Tauri"));
        assert_eq!(
            serde_json::from_str::<Settings>("{}").unwrap(),
            Settings::default()
        );
        assert_eq!(
            serde_json::to_value(Language {
                code: "de".into(),
                name: "German".into()
            })
            .unwrap(),
            json!({"code":"de","name":"German"})
        );
    }
}
