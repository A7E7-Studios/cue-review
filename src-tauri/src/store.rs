use crate::models::*;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}

pub fn data_root() -> PathBuf {
    std::env::var_os("CUEREVIEW_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
                .join("CueReview")
        })
}
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| format!("Read {}: {e}", path.display()))?)
        .map_err(|e| format!("Invalid {}: {e}", path.display()))
}
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err("Use a name between 1 and 120 characters without control characters.".into());
    }
    Ok(name.to_owned())
}
fn valid_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "Invalid project or session ID.".into())
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        for dir in ["projects", "sessions", "tools", "models"] {
            fs::create_dir_all(root.join(dir)).map_err(|e| e.to_string())?;
        }
        Ok(Self { root })
    }
    pub fn session_dir(&self, id: &str) -> Result<PathBuf, String> {
        valid_id(id)?;
        Ok(self.root.join("sessions").join(id))
    }
    pub fn project(&self, id: &str) -> Result<Project, String> {
        valid_id(id)?;
        read_json(&self.root.join("projects").join(format!("{id}.json")))
    }
    pub fn projects(&self) -> Result<Vec<Project>, String> {
        let mut entries = Vec::new();
        for entry in fs::read_dir(self.root.join("projects")).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|ext| ext == "json") {
                entries.push(read_json::<Project>(&path)?);
            }
        }
        entries.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(entries)
    }
    pub fn create_project(&self, name: &str) -> Result<Project, String> {
        let p = Project {
            id: Uuid::new_v4().to_string(),
            name: valid_name(name)?,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        write_json(
            &self.root.join("projects").join(format!("{}.json", p.id)),
            &p,
        )?;
        Ok(p)
    }
    pub fn rename_project(&self, id: &str, name: &str) -> Result<Project, String> {
        let mut p = self.project(id)?;
        p.name = valid_name(name)?;
        write_json(&self.root.join("projects").join(format!("{id}.json")), &p)?;
        Ok(p)
    }
    pub fn session(&self, id: &str) -> Result<Session, String> {
        read_json(&self.session_dir(id)?.join("session.json"))
    }
    pub fn save_session(&self, s: &Session) -> Result<(), String> {
        write_json(&self.session_dir(&s.id)?.join("session.json"), s)
    }
    pub fn sessions(&self, project: Option<&str>) -> Result<Vec<Session>, String> {
        if let Some(id) = project {
            self.project(id)?;
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(self.root.join("sessions")).map_err(|e| e.to_string())? {
            let path = entry
                .map_err(|e| e.to_string())?
                .path()
                .join("session.json");
            if path.is_file() {
                let session: Session = read_json(&path)?;
                if project.is_none_or(|id| session.project_id.as_deref() == Some(id)) {
                    entries.push(session);
                }
            }
        }
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(entries)
    }
    pub fn create_session(
        &self,
        project: Option<&str>,
        name: Option<&str>,
        config: &CaptureConfig,
    ) -> Result<Session, String> {
        if let Some(project) = project {
            self.project(project)?;
        }
        let auto_title = name.is_none();
        let name = valid_name(name.unwrap_or("New recording"))?;
        let id = Uuid::new_v4().to_string();
        let folder = self.session_dir(&id)?;
        fs::create_dir(&folder).map_err(|e| e.to_string())?;
        let s = Session {
            id,
            project_id: project.map(str::to_owned),
            name,
            auto_title,
            created_at: chrono::Utc::now().to_rfc3339(),
            duration_ms: 0,
            status: "recording".into(),
            video_path: None,
            folder_path: folder.to_string_lossy().into(),
            error: None,
            source_id: config.source_id.clone(),
            microphone_id: config.microphone_id.clone(),
            system_audio: config.system_audio,
        };
        self.save_session(&s)?;
        Ok(s)
    }
    pub fn rename_session(&self, id: &str, name: &str) -> Result<Session, String> {
        let mut s = self.session(id)?;
        if matches!(s.status.as_str(), "recording" | "processing") {
            return Err("Finish recording and processing before renaming this recording.".into());
        }
        s.name = valid_name(name)?;
        s.auto_title = false;
        self.save_session(&s)?;
        Ok(s)
    }
    pub fn move_session(&self, id: &str, project: Option<&str>) -> Result<Session, String> {
        let mut session = self.session(id)?;
        if matches!(session.status.as_str(), "recording" | "processing") {
            return Err("Finish recording and processing before moving this recording.".into());
        }
        if let Some(project) = project {
            self.project(project)?;
        }
        session.project_id = project.map(str::to_owned);
        self.save_session(&session)?;
        Ok(session)
    }
    pub fn apply_auto_title(session: &mut Session, transcript: &Transcript) {
        if !session.auto_title {
            return;
        }
        let phrase = transcript
            .segments
            .iter()
            .map(|segment| segment.text.trim())
            .find(|text| !text.is_empty())
            .unwrap_or("");
        let mut title = String::new();
        for word in phrase.split_whitespace() {
            let word: String = word.chars().filter(|c| !c.is_control()).collect();
            if word.is_empty() {
                continue;
            }
            let length =
                title.chars().count() + usize::from(!title.is_empty()) + word.chars().count();
            if length > 60 {
                if title.is_empty() {
                    title.extend(word.chars().take(60));
                }
                break;
            }
            if !title.is_empty() {
                title.push(' ');
            }
            title.push_str(&word);
        }
        session.name = if title.is_empty() {
            "Recording".into()
        } else {
            title
        };
    }
    pub fn transcript(&self, id: &str) -> Result<Transcript, String> {
        self.session(id)?;
        let path = self.session_dir(id)?.join("transcript.json");
        if path.exists() {
            read_json(&path)
        } else {
            Ok(Transcript::default())
        }
    }
    pub fn save_transcript(&self, id: &str, transcript: &Transcript) -> Result<(), String> {
        let folder = self.session_dir(id)?;
        write_json(&folder.join("transcript.json"), transcript)?;
        let text = transcript
            .segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        atomic_write(&folder.join("transcript.txt"), text.as_bytes())
    }
    pub fn markers(&self, id: &str) -> Result<Vec<Marker>, String> {
        self.session(id)?;
        let p = self.session_dir(id)?.join("markers.json");
        if p.exists() {
            read_json(&p)
        } else {
            Ok(vec![])
        }
    }
    pub fn add_marker(&self, id: &str, time_ms: u64, label: &str) -> Result<Marker, String> {
        let s = self.session(id)?;
        if s.status != "recording" && time_ms > s.duration_ms {
            return Err("Marker is outside the recording.".into());
        }
        let mut markers = self.markers(id)?;
        let m = Marker {
            id: Uuid::new_v4().to_string(),
            time_ms,
            label: valid_name(label)?,
        };
        markers.push(m.clone());
        markers.sort_by_key(|m| m.time_ms);
        write_json(&self.session_dir(id)?.join("markers.json"), &markers)?;
        Ok(m)
    }
    pub fn recover_interrupted(&self) -> Result<(), String> {
        for mut s in self.sessions(None)? {
            if matches!(s.status.as_str(), "recording" | "processing") {
                s.status = "error".into();
                s.error = Some("The app closed before this session finished. Original media is retained in the session folder; retry transcription if video is available.".into());
                let video = self.session_dir(&s.id)?.join("video.mp4");
                if video.is_file() {
                    s.video_path = Some(video.to_string_lossy().into());
                }
                self.save_session(&s)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn video_only() -> CaptureConfig {
        CaptureConfig {
            source_id: "monitor:1".into(),
            microphone_id: None,
            system_audio: false,
            fps: 30,
        }
    }
    #[test]
    fn unassigned_recordings_can_be_grouped_without_moving_media() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let mut session = store.create_session(None, None, &video_only()).unwrap();
        assert!(session.project_id.is_none());
        assert!(session.auto_title);
        assert_eq!(session.name, "New recording");
        assert!(store.projects().unwrap().is_empty());
        assert_eq!(store.sessions(None).unwrap().len(), 1);
        let project = store.create_project("Optional group").unwrap();
        assert!(store.move_session(&session.id, Some(&project.id)).is_err());
        assert!(store.rename_session(&session.id, "Custom").is_err());
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        let media = store.session_dir(&session.id).unwrap().join("retained.bin");
        fs::write(&media, b"original recording bytes").unwrap();
        let assigned = store.move_session(&session.id, Some(&project.id)).unwrap();
        assert_eq!(assigned.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(assigned.folder_path, session.folder_path);
        assert_eq!(store.sessions(Some(&project.id)).unwrap().len(), 1);
        assert!(store.move_session(&session.id, Some("missing")).is_err());
        let unassigned = store.move_session(&session.id, None).unwrap();
        assert!(unassigned.project_id.is_none());
        assert!(store.sessions(Some(&project.id)).unwrap().is_empty());
        assert_eq!(fs::read(media).unwrap(), b"original recording bytes");
    }
    #[test]
    fn legacy_project_sessions_keep_names_and_deserialize_without_migration() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("Existing project").unwrap();
        let session = store
            .create_session(Some(&project.id), Some("Review"), &video_only())
            .unwrap();
        let mut legacy = serde_json::to_value(&session).unwrap();
        legacy.as_object_mut().unwrap().remove("autoTitle");
        write_json(
            &store.session_dir(&session.id).unwrap().join("session.json"),
            &legacy,
        )
        .unwrap();
        let reopened = Store::open(dir.path().into()).unwrap();
        let mut loaded = reopened.session(&session.id).unwrap();
        assert_eq!(loaded.project_id.as_deref(), Some(project.id.as_str()));
        assert!(!loaded.auto_title);
        Store::apply_auto_title(&mut loaded, &Transcript::default());
        assert_eq!(loaded.name, "Review");
        assert_eq!(reopened.projects().unwrap()[0].name, "Existing project");
    }
    #[test]
    fn automatic_titles_use_source_words_and_explicit_rename_wins() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let mut session = store.create_session(None, None, &video_only()).unwrap();
        let transcript = Transcript { segments: vec![Segment {
            id:"s".into(), start_ms:0,end_ms:1000,
            text:"  Fix\tthis button \n before opening the very complicated library settings menu please  ".into(),words:vec![],
        }], ..Default::default() };
        Store::apply_auto_title(&mut session, &transcript);
        assert_eq!(
            session.name,
            "Fix this button before opening the very complicated library"
        );
        assert!(session.name.chars().count() <= 60);
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        let mut custom = store.rename_session(&session.id, "Review").unwrap();
        assert!(!custom.auto_title);
        Store::apply_auto_title(&mut custom, &transcript);
        assert_eq!(custom.name, "Review");
        let mut silent = store.create_session(None, None, &video_only()).unwrap();
        Store::apply_auto_title(&mut silent, &Transcript::default());
        assert_eq!(silent.name, "Recording");
    }
    #[test]
    fn persistence_and_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let p = store.create_project(" Project ").unwrap();
        assert_eq!(p.name, "Project");
        let s = store
            .create_session(
                Some(&p.id),
                Some("Review"),
                &CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        store.rename_project(&p.id, "Renamed").unwrap();
        store.recover_interrupted().unwrap();
        let reopened = Store::open(dir.path().into()).unwrap();
        assert_eq!(reopened.project(&p.id).unwrap().name, "Renamed");
        assert_eq!(reopened.session(&s.id).unwrap().status, "error");
        assert!(reopened.session("../../secret").is_err());
        assert!(reopened.create_project("\n").is_err());
    }
    #[test]
    fn markers_reject_out_of_range() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let p = store.create_project("P").unwrap();
        let mut s = store
            .create_session(
                Some(&p.id),
                Some("S"),
                &CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        s.status = "ready".into();
        s.duration_ms = 1000;
        store.save_session(&s).unwrap();
        assert!(store.add_marker(&s.id, 1001, "Too late").is_err());
        assert!(store.add_marker(&s.id, 1000, "End").is_ok());
    }
}
