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
                if project.is_none_or(|id| session.project_id == id) {
                    entries.push(session);
                }
            }
        }
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(entries)
    }
    pub fn create_session(
        &self,
        project: &str,
        name: &str,
        config: &CaptureConfig,
    ) -> Result<Session, String> {
        self.project(project)?;
        let name = valid_name(name)?;
        let id = Uuid::new_v4().to_string();
        let folder = self.session_dir(&id)?;
        fs::create_dir(&folder).map_err(|e| e.to_string())?;
        let s = Session {
            id,
            project_id: project.into(),
            name,
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
        s.name = valid_name(name)?;
        self.save_session(&s)?;
        Ok(s)
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
    #[test]
    fn persistence_and_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let p = store.create_project(" Project ").unwrap();
        assert_eq!(p.name, "Project");
        let s = store
            .create_session(
                &p.id,
                "Review",
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
                &p.id,
                "S",
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
