use crate::models::*;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::{HashMap, HashSet},
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
            dirs::data_local_dir()
                .expect("CueReview needs a writable user data directory")
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

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points are not necessarily reported as symlinks.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn check_deletion_tree(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Inspect {}: {e}", path.display()))?;
    if is_link(&metadata) {
        return Err(format!(
            "The recording contains a linked path ({}). Remove the link before deleting the recording.",
            path.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            check_deletion_tree(&entry.map_err(|e| e.to_string())?.path())?;
        }
    }
    Ok(())
}

// Keep session.json until every payload has been deleted. A locked media file can
// make deletion partial on Windows; the remaining recording must stay reachable.
fn delete_session_payloads(folder: &Path) -> Result<(), String> {
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name() == "session.json" {
            continue;
        }
        let path = entry.path();
        check_deletion_tree(&path)?;
        let result = if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        result.map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
    }
    Ok(())
}

impl Store {
    /// Hold this handle for the lifetime of every process that can mutate recordings.
    /// Readers (the agent CLI) remain usable while the desktop app is running.
    pub fn acquire_ownership(&self) -> Result<fs::File, String> {
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(".instance.lock"))
            .map_err(|e| e.to_string())?;
        file.try_lock().map_err(|e| match e {
            fs::TryLockError::WouldBlock => "CueReview is already using this data folder. Close the other app or recording command before continuing.".to_owned(),
            fs::TryLockError::Error(error) => format!("Could not lock the recording data folder: {error}"),
        })?;
        Ok(file)
    }
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
        let order_path = self.root.join("section-order.json");
        let order: Vec<String> = if order_path.exists() {
            read_json(&order_path)?
        } else {
            Vec::new()
        };
        let positions: HashMap<_, _> = order.iter().enumerate().map(|(i, id)| (id, i)).collect();
        entries.sort_by(|a, b| {
            positions
                .get(&a.id)
                .unwrap_or(&usize::MAX)
                .cmp(positions.get(&b.id).unwrap_or(&usize::MAX))
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(entries)
    }
    pub fn reorder_projects(&self, ids: &[String]) -> Result<(), String> {
        let projects = self.projects()?;
        let supplied: HashSet<_> = ids.iter().collect();
        let current: HashSet<_> = projects.iter().map(|project| &project.id).collect();
        if ids.len() != supplied.len() || supplied != current {
            return Err("The sections changed. Refresh and try reordering them again.".into());
        }
        write_json(&self.root.join("section-order.json"), &ids)
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
    pub fn delete_project(&self, id: &str) -> Result<(), String> {
        let project = self.project(id)?;
        if project.id != id {
            return Err("The section metadata does not match its file.".into());
        }
        let project_file = self.root.join("projects").join(format!("{id}.json"));
        let root = dunce::canonicalize(&self.root).map_err(|e| e.to_string())?;
        if dunce::canonicalize(&project_file).map_err(|e| e.to_string())?
            != root.join("projects").join(format!("{id}.json"))
        {
            return Err("The section file points outside its expected storage location.".into());
        }
        let mut sessions = self.sessions(Some(id))?;
        // Check every member before changing any assignment.
        if sessions
            .iter()
            .any(|session| matches!(session.status.as_str(), "recording" | "processing"))
        {
            return Err("Finish recording and processing before deleting this section.".into());
        }
        for session in &sessions {
            self.checked_session_dir(&session.id)?;
        }
        for session in &mut sessions {
            session.project_id = None;
            self.save_session(session).map_err(|e| format!(
                "The section was not deleted. Some recordings may already be in Recents; try again. {e}"
            ))?;
        }
        // Stale IDs in section-order.json are harmless and ignored when listing.
        // Remove the section only after all of its recordings are in Recents.
        fs::remove_file(project_file).map_err(|e| {
            format!("Recordings are in Recents, but the section could not be removed: {e}")
        })
    }
    fn checked_session_dir(&self, id: &str) -> Result<PathBuf, String> {
        let folder = self.session_dir(id)?;
        let root = dunce::canonicalize(&self.root).map_err(|e| e.to_string())?;
        let sessions =
            dunce::canonicalize(self.root.join("sessions")).map_err(|e| e.to_string())?;
        let physical = dunce::canonicalize(&folder).map_err(|e| e.to_string())?;
        if sessions != root.join("sessions") || physical != sessions.join(id) {
            return Err(
                "The recording directory points outside its expected storage location.".into(),
            );
        }
        if is_link(&fs::symlink_metadata(&folder).map_err(|e| e.to_string())?) {
            return Err("Linked recording directories cannot be deleted or reassigned.".into());
        }
        Ok(physical)
    }
    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let folder = self.checked_session_dir(id)?;
        let session = self.session(id)?;
        if session.id != id {
            return Err("The recording metadata does not match its directory.".into());
        }
        if matches!(session.status.as_str(), "recording" | "processing") {
            return Err("Finish recording and processing before deleting this recording.".into());
        }
        // Never use folderPath or videoPath from JSON as deletion targets.
        check_deletion_tree(&folder)?;
        delete_session_payloads(&folder).map_err(|e| format!(
            "The recording could not be fully deleted. Close programs using its files and try again. {e}"
        ))?;
        fs::remove_file(folder.join("session.json")).map_err(|e| e.to_string())?;
        if let Err(error) = fs::remove_dir(&folder) {
            // Restore the record if the directory became nonempty or locked at
            // the last step, so retry does not leave an invisible orphan folder.
            let mut remaining = session;
            remaining.video_path = None;
            remaining.status = "error".into();
            remaining.error =
                Some("Deletion was interrupted. Retry deleting this recording.".into());
            let restore = write_json(&folder.join("session.json"), &remaining);
            return Err(format!(
                "The recording files were deleted, but its folder could not be removed: {error}.{}",
                if restore.is_err() {
                    " Its metadata could not be restored; inspect the recording folder."
                } else {
                    " Try deleting it again."
                }
            ));
        }
        Ok(())
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
    #[test]
    fn ownership_blocks_a_second_process_without_recovering_live_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let ownership = store.acquire_ownership().unwrap();
        let session = store.create_session(None, None, &video_only()).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::tests::ownership_child_probe",
                "--nocapture",
            ])
            .env("CUEREVIEW_LOCK_TEST_ROOT", dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(store.session(&session.id).unwrap().status, "recording");
        drop(ownership);
        assert!(store.acquire_ownership().is_ok());
    }
    #[test]
    fn ownership_child_probe() {
        let Some(path) = std::env::var_os("CUEREVIEW_LOCK_TEST_ROOT") else {
            return;
        };
        let store = Store::open(path.into()).unwrap();
        assert!(store
            .acquire_ownership()
            .unwrap_err()
            .contains("already using"));
    }
    fn video_only() -> CaptureConfig {
        CaptureConfig {
            source_id: "monitor:1".into(),
            microphone_id: None,
            system_audio: false,
            fps: 30,
        }
    }
    fn ready_session(store: &Store, project: Option<&str>) -> Session {
        let mut session = store
            .create_session(project, Some("Review"), &video_only())
            .unwrap();
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        session
    }
    #[test]
    fn section_order_persists_and_rejects_incomplete_duplicate_or_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let a = store.create_project("A").unwrap();
        let b = store.create_project("B").unwrap();
        let order = vec![b.id.clone(), a.id.clone()];
        store.reorder_projects(&order).unwrap();
        let reopened = Store::open(dir.path().into()).unwrap();
        assert_eq!(
            reopened
                .projects()
                .unwrap()
                .iter()
                .map(|p| p.id.clone())
                .collect::<Vec<_>>(),
            order
        );
        for invalid in [
            vec![a.id.clone()],
            vec![a.id.clone(), a.id.clone()],
            vec![a.id.clone(), Uuid::new_v4().to_string()],
        ] {
            assert!(store.reorder_projects(&invalid).is_err());
        }
        let c = store.create_project("C").unwrap();
        assert_eq!(
            store
                .projects()
                .unwrap()
                .iter()
                .map(|p| p.id.clone())
                .collect::<Vec<_>>(),
            vec![b.id.clone(), a.id.clone(), c.id]
        );
        store.delete_project(&b.id).unwrap();
        assert_eq!(store.projects().unwrap()[0].id, a.id);
    }
    #[test]
    fn deleting_a_section_unassigns_all_members_and_preserves_every_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("Category").unwrap();
        let other = store.create_project("Other").unwrap();
        let first = ready_session(&store, Some(&project.id));
        let second = ready_session(&store, Some(&project.id));
        let untouched = ready_session(&store, Some(&other.id));
        for session in [&first, &second] {
            let folder = store.session_dir(&session.id).unwrap();
            fs::write(folder.join("video.mp4"), b"original video bytes").unwrap();
            fs::write(folder.join("transcript.json"), b"original transcript bytes").unwrap();
        }
        store.delete_project(&project.id).unwrap();
        assert!(store.project(&project.id).is_err());
        for original in [&first, &second] {
            let updated = store.session(&original.id).unwrap();
            assert!(updated.project_id.is_none());
            assert_eq!(updated.folder_path, original.folder_path);
            assert_eq!(
                fs::read(store.session_dir(&original.id).unwrap().join("video.mp4")).unwrap(),
                b"original video bytes"
            );
            assert_eq!(
                fs::read(
                    store
                        .session_dir(&original.id)
                        .unwrap()
                        .join("transcript.json")
                )
                .unwrap(),
                b"original transcript bytes"
            );
        }
        assert_eq!(
            store.session(&untouched.id).unwrap().project_id.as_deref(),
            Some(other.id.as_str())
        );
        assert_eq!(store.sessions(None).unwrap().len(), 3);
    }
    #[test]
    fn active_members_block_section_and_session_deletion_before_any_changes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("Category").unwrap();
        let ready = ready_session(&store, Some(&project.id));
        let mut active = store
            .create_session(Some(&project.id), None, &video_only())
            .unwrap();
        for status in ["recording", "processing"] {
            active.status = status.into();
            store.save_session(&active).unwrap();
            assert!(store.delete_project(&project.id).is_err());
            assert!(store.delete_session(&active.id).is_err());
            assert_eq!(
                store.session(&ready.id).unwrap().project_id.as_deref(),
                Some(project.id.as_str())
            );
            assert!(store.project(&project.id).is_ok());
            assert!(store.session_dir(&active.id).unwrap().exists());
        }
    }
    #[test]
    fn deleting_a_session_removes_all_owned_files_and_ignores_metadata_paths() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("store")).unwrap();
        let mut session = ready_session(&store, None);
        let other = ready_session(&store, None);
        let outside = dir.path().join("outside.mp4");
        fs::write(&outside, b"do not delete").unwrap();
        session.folder_path = dir.path().to_string_lossy().into();
        session.video_path = Some(outside.to_string_lossy().into());
        store.save_session(&session).unwrap();
        let folder = store.session_dir(&session.id).unwrap();
        fs::create_dir(folder.join("exports")).unwrap();
        fs::write(folder.join("video.mp4"), b"recording").unwrap();
        fs::write(folder.join("exports").join("clip.mp4"), b"clip").unwrap();
        assert!(store.delete_session("../outside").is_err());
        assert!(store.delete_session(&Uuid::new_v4().to_string()).is_err());
        store.delete_session(&session.id).unwrap();
        assert!(!folder.exists());
        assert_eq!(store.sessions(None).unwrap().len(), 1);
        assert!(store.session(&other.id).is_ok());
        assert_eq!(fs::read(outside).unwrap(), b"do not delete");
    }
    #[cfg(windows)]
    #[test]
    fn locked_media_keeps_session_metadata_for_retrying_deletion() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let session = ready_session(&store, None);
        let folder = store.session_dir(&session.id).unwrap();
        let media = folder.join("video.mp4");
        fs::write(&media, b"locked recording").unwrap();
        let handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&media)
            .unwrap();
        assert!(store.delete_session(&session.id).is_err());
        assert!(store.session(&session.id).is_ok());
        drop(handle);
        assert_eq!(fs::read(&media).unwrap(), b"locked recording");
        store.delete_session(&session.id).unwrap();
        assert!(!folder.exists());
    }
    #[cfg(windows)]
    #[test]
    fn deletion_rejects_session_and_nested_junctions_without_touching_targets() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("store")).unwrap();
        let session = ready_session(&store, None);
        let folder = store.session_dir(&session.id).unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"external content").unwrap();
        let link = folder.join("linked");
        let create_junction = |link: &Path, target: &Path| {
            use std::os::windows::process::CommandExt;
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        create_junction(&link, &outside);
        assert!(store.delete_session(&session.id).is_err());
        assert!(store.session(&session.id).is_ok());
        assert_eq!(
            fs::read(outside.join("keep.txt")).unwrap(),
            b"external content"
        );
        fs::remove_dir(&link).unwrap(); // Remove the junction itself, never its target.
        let displaced = dir.path().join("displaced-session");
        fs::rename(&folder, &displaced).unwrap();
        create_junction(&folder, &displaced);
        assert!(store.delete_session(&session.id).is_err());
        assert!(displaced.join("session.json").is_file());
        fs::remove_dir(&folder).unwrap();
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
