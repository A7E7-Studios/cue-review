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
    /// What `source_id` named when the session was first recorded. Record
    /// more checks it again, because a window handle or display number can
    /// name something else later. `None` for sessions recorded before this
    /// existed and for sources other than Windows windows and displays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_identity: Option<SourceIdentity>,
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
    /// The combined `video.mp4` is being rebuilt to include this take.
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
    /// Where this take starts on the combined session timeline.
    pub offset_ms: u64,
    pub duration_ms: u64,
    pub status: TakeStatus,
    /// Folder relative to the session folder, for example `"takes/2"`.
    /// Take 1 of a legacy session uses `"."`.
    pub folder: String,
    /// Source of this take. `None` means the session's `source_id`, which
    /// Record more always reuses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Microphone this take recorded, `None` for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone_id: Option<String>,
    /// Whether this take recorded system or device audio.
    #[serde(default)]
    pub system_audio: bool,
}

/// Start of a take on the combined transcript timeline, used for the
/// "Take N · m:ss" divider. A transcript lists one mark per take, in order,
/// with take 1 at 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeMark {
    pub index: u32,
    pub start_ms: u64,
}

/// App-wide preferences stored in `<root>/settings.json`, shared by the app
/// and the `cue` CLI. Every field is optional so older files stay readable.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Terms passed to Whisper as a prompt. `None` keeps the prompt off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vocabulary: Option<String>,
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
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub segments: Vec<Segment>,
    pub language: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
    /// Where each take starts on the combined timeline. Empty for sessions
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
    /// Where that take starts on the combined session timeline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub take_offset_ms: Option<u64>,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use serde_json::json;

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

        let transcript = Transcript {
            takes: vec![TakeMark {
                index: 2,
                start_ms: 134000,
            }],
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&transcript).unwrap()["takes"],
            json!([{"index":2,"startMs":134000}])
        );

        let mut status = RecordingStatus {
            state: "idle".into(),
            session_id: None,
            elapsed_ms: 0,
            audio_level: 0.,
            error: None,
            live_transcript: None,
            take_index: None,
            take_offset_ms: None,
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
    }
}
