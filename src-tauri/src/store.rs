use crate::models::*;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Condvar, Mutex},
    thread::{self, ThreadId},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Store {
    pub root: PathBuf,
}

// Sessions whose write lock is held in this process: owner thread and depth.
// The guard is reentrant on its owner thread, so a locked read-modify-write can
// call the public write helpers without deadlocking.
static HELD_SESSIONS: Mutex<BTreeMap<PathBuf, (ThreadId, usize)>> = Mutex::new(BTreeMap::new());
static RELEASED_SESSION: Condvar = Condvar::new();
const SESSION_LOCK_TIMEOUT: Duration = Duration::from_secs(10);

/// Exclusive write access to one session: an in-process mutex keyed by the
/// session plus an advisory file lock that other processes (the `cue` CLI)
/// honour. Dropping it releases both.
#[derive(Debug)]
pub struct SessionLock {
    key: PathBuf,
    file: Option<fs::File>,
}
impl Drop for SessionLock {
    fn drop(&mut self) {
        // Unlock the file before another thread here can take the session.
        drop(self.file.take());
        let mut held = HELD_SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((_, depth)) = held.get_mut(&self.key) {
            *depth -= 1;
            if *depth == 0 {
                held.remove(&self.key);
            }
        }
        RELEASED_SESSION.notify_all();
    }
}
fn lock_file(path: &Path, timeout: Duration) -> Result<fs::File, String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("Could not open the recording lock {}: {e}", path.display()))?;
    let deadline = Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25))
            }
            Err(fs::TryLockError::WouldBlock) => {
                return Err("Another CueReview process is still updating this recording. Try again in a moment.".into())
            }
            Err(fs::TryLockError::Error(error)) => {
                return Err(format!("Could not lock this recording for writing: {error}"))
            }
        }
    }
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
/// `session` as read from its folder `folder`. `session.json` stores absolute
/// paths, so after the data folder is copied or moved (`CUEREVIEW_DATA_DIR`
/// pointing at the copy) they still name the old place, which is outside the
/// asset scope the app grants. A `folderPath` that points elsewhere becomes
/// `folder`, and a `videoPath` that points elsewhere becomes the same file in
/// `folder` when that file exists. Nothing is written; the next save keeps it.
fn located(mut session: Session, folder: &Path) -> Session {
    let stored = PathBuf::from(&session.folder_path);
    if let Some(video) = session.video_path.as_deref().map(Path::new) {
        if !video.starts_with(folder) {
            let relative = video
                .strip_prefix(&stored)
                .ok()
                .filter(|relative| !relative.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .or_else(|| video.file_name().map(PathBuf::from));
            if let Some(moved) = relative.map(|relative| folder.join(relative)) {
                if moved.is_file() {
                    session.video_path = Some(moved.to_string_lossy().into());
                }
            }
        }
    }
    if stored != folder {
        session.folder_path = folder.to_string_lossy().into();
    }
    session
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
        for dir in ["projects", "sessions", "tools", "models", "locks"] {
            fs::create_dir_all(root.join(dir)).map_err(|e| e.to_string())?;
        }
        Ok(Self { root })
    }
    pub fn session_dir(&self, id: &str) -> Result<PathBuf, String> {
        valid_id(id)?;
        Ok(self.root.join("sessions").join(id))
    }
    /// Takes the per-session write lock. Every store write to a session holds
    /// it, so the app and the CLI never lose each other's updates. Reentrant
    /// on the calling thread; waits up to 10 s for another process.
    pub fn lock_session(&self, id: &str) -> Result<SessionLock, String> {
        self.lock_session_within(id, SESSION_LOCK_TIMEOUT)
    }
    fn lock_session_within(&self, id: &str, timeout: Duration) -> Result<SessionLock, String> {
        valid_id(id)?;
        // Lock files live outside the session folder so deleting a recording
        // never races its own lock.
        let locks = self.root.join("locks");
        fs::create_dir_all(&locks).map_err(|e| e.to_string())?;
        let key = locks.join(format!("{id}.lock"));
        let me = thread::current().id();
        let mut held = HELD_SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            match held.get_mut(&key) {
                Some((owner, depth)) if *owner == me => {
                    *depth += 1;
                    return Ok(SessionLock { key, file: None });
                }
                Some(_) => {
                    held = RELEASED_SESSION
                        .wait(held)
                        .unwrap_or_else(|e| e.into_inner())
                }
                None => break,
            }
        }
        held.insert(key.clone(), (me, 1));
        drop(held);
        let mut guard = SessionLock { key, file: None };
        guard.file = Some(lock_file(&guard.key, timeout)?);
        Ok(guard)
    }
    /// Re-reads `session.json` under the session's write lock, applies `change`
    /// and writes the result. Nothing is written when `change` fails.
    pub fn update_session(
        &self,
        id: &str,
        change: impl FnOnce(&mut Session) -> Result<(), String>,
    ) -> Result<Session, String> {
        let _lock = self.lock_session(id)?;
        let mut session = self.session(id)?;
        change(&mut session)?;
        self.save_session(&session)?;
        Ok(session)
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
            // Re-read each member so a concurrent rename is kept.
            self.update_session(&session.id, |current| {
                current.project_id = None;
                Ok(())
            })
            .map_err(|e| format!(
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
        let lock = self.lock_session(id)?;
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
        let key = lock.key.clone();
        drop(lock);
        // Best effort: a lock file left behind is harmless.
        let _ = fs::remove_file(key);
        Ok(())
    }
    pub fn session(&self, id: &str) -> Result<Session, String> {
        let folder = self.session_dir(id)?;
        read_json(&folder.join("session.json")).map(|session| located(session, &folder))
    }
    /// Writes `s` as the session's metadata under its write lock. Prefer
    /// [`Store::update_session`] when the change is based on a fresh read.
    pub fn save_session(&self, s: &Session) -> Result<(), String> {
        let _lock = self.lock_session(&s.id)?;
        write_json(&self.session_dir(&s.id)?.join("session.json"), s)
    }
    /// Every readable session, newest first, optionally only one section's.
    /// A folder or `session.json` that cannot be read (torn by a crash, or
    /// edited by hand) is logged and left out, so one damaged recording never
    /// hides the rest of the library.
    pub fn sessions(&self, project: Option<&str>) -> Result<Vec<Session>, String> {
        if let Some(id) = project {
            self.project(id)?;
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(self.root.join("sessions")).map_err(|e| e.to_string())? {
            let folder = match entry {
                Ok(entry) => entry.path(),
                Err(error) => {
                    eprintln!("A recording folder could not be listed: {error}");
                    continue;
                }
            };
            let path = folder.join("session.json");
            if path.is_file() {
                let session: Session = match read_json(&path) {
                    Ok(session) => located(session, &folder),
                    Err(error) => {
                        eprintln!("Skipped {}: {error}", path.display());
                        continue;
                    }
                };
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
            takes: Vec::new(),
            source_identity: None,
        };
        self.save_session(&s)?;
        Ok(s)
    }
    /// Renames under the session's write lock; the `cue rename` CLI calls this
    /// while the app may be writing the same session.
    pub fn rename_session(&self, id: &str, name: &str) -> Result<Session, String> {
        let name = valid_name(name)?;
        self.update_session(id, |s| {
            if matches!(s.status.as_str(), "recording" | "processing") {
                return Err(
                    "Finish recording and processing before renaming this recording.".into(),
                );
            }
            s.name = name;
            s.auto_title = false;
            Ok(())
        })
    }
    pub fn move_session(&self, id: &str, project: Option<&str>) -> Result<Session, String> {
        if let Some(project) = project {
            self.project(project)?;
        }
        self.update_session(id, |session| {
            if matches!(session.status.as_str(), "recording" | "processing") {
                return Err("Finish recording and processing before moving this recording.".into());
            }
            session.project_id = project.map(str::to_owned);
            Ok(())
        })
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
        let _lock = self.lock_session(id)?;
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
        let _lock = self.lock_session(id)?;
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
    /// Startup repair after a crash or forced close. Sessions recorded before
    /// takes existed keep the v0.1 behavior; sessions with takes go through
    /// [`crate::takes::recover`], which repairs each take on its own.
    ///
    /// A session that cannot be read or repaired is skipped, so one damaged
    /// recording never keeps the app from starting. A skipped session that
    /// was still recording or processing is marked `error` with a message
    /// the app shows, so it can be retried or deleted rather than looking
    /// busy forever. Returns one message per skipped session; only an
    /// unreadable sessions folder is an error.
    pub fn recover_interrupted(&self) -> Result<Vec<String>, String> {
        self.recover_interrupted_with(Self::recover_one)
    }
    fn recover_interrupted_with(
        &self,
        recover: impl Fn(&Self, &Session) -> Result<(), String>,
    ) -> Result<Vec<String>, String> {
        let mut skipped = Vec::new();
        for entry in fs::read_dir(self.root.join("sessions")).map_err(|e| e.to_string())? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    skipped.push(format!("A recording folder could not be listed: {error}"));
                    continue;
                }
            };
            let file = entry.path().join("session.json");
            if !file.is_file() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().into_owned();
            let listed: Session = match read_json(&file) {
                Ok(listed) => listed,
                Err(error) => {
                    skipped.push(format!("Recording {folder} was not recovered: {error}"));
                    continue;
                }
            };
            let Err(error) = recover(self, &listed) else {
                continue;
            };
            let mut problem = format!("Recording {folder} was not recovered: {error}");
            if matches!(listed.status.as_str(), "recording" | "processing") {
                if let Err(marking) = self.mark_unrecovered(&listed.id, &error) {
                    problem.push_str(&format!(" It could not be marked as failed: {marking}"));
                }
            }
            skipped.push(problem);
        }
        Ok(skipped)
    }
    /// Settles a session that startup recovery could not repair, so the app
    /// offers Retry and Delete for it. Its files stay as they are.
    fn mark_unrecovered(&self, id: &str, cause: &str) -> Result<Session, String> {
        self.update_session(id, |session| {
            session.status = "error".into();
            session.error = Some(format!(
                "The app closed before this recording finished, and CueReview could not repair it when it started again: {}. Its files are kept in the session folder; retry, or delete the recording.",
                cause.trim_end_matches('.')
            ));
            Ok(())
        })
    }
    fn recover_one(&self, listed: &Session) -> Result<(), String> {
        if !listed.takes.is_empty() {
            return crate::takes::recover(self, &listed.id);
        }
        if matches!(listed.status.as_str(), "recording" | "processing") {
            let video = self.session_dir(&listed.id)?.join("video.mp4");
            self.update_session(&listed.id, |s| {
                s.status = "error".into();
                s.error = Some("The app closed before this session finished. Original media is retained in the session folder; retry transcription if video is available.".into());
                if video.is_file() {
                    s.video_path = Some(video.to_string_lossy().into());
                }
                Ok(())
            })?;
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
    fn a_copied_data_folder_uses_its_own_session_files() {
        fn copy_tree(from: &Path, to: &Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    copy_tree(&entry.path(), &to.join(entry.file_name()));
                } else {
                    fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let original = Store::open(dir.path().join("original")).unwrap();
        let mut played = ready_session(&original, None);
        let mut missing = ready_session(&original, None);
        for session in [&mut played, &mut missing] {
            let video = original.session_dir(&session.id).unwrap().join("video.mp4");
            fs::write(&video, b"recording").unwrap();
            session.video_path = Some(video.to_string_lossy().into());
            original.save_session(session).unwrap();
        }
        let copy_root = dir.path().join("copied");
        copy_tree(&original.root, &copy_root);
        let copy = Store::open(copy_root).unwrap();
        // The copy lacks this one's video, so its stored path is kept.
        fs::remove_file(copy.session_dir(&missing.id).unwrap().join("video.mp4")).unwrap();

        let folder = copy.session_dir(&played.id).unwrap();
        let loaded = copy.session(&played.id).unwrap();
        assert_eq!(Path::new(&loaded.folder_path), folder);
        assert_eq!(
            loaded.video_path.as_deref().map(Path::new),
            Some(folder.join("video.mp4").as_path())
        );
        let listed = copy.sessions(None).unwrap();
        let listed_played = listed.iter().find(|s| s.id == played.id).unwrap();
        assert_eq!(listed_played.folder_path, loaded.folder_path);
        assert_eq!(listed_played.video_path, loaded.video_path);
        let listed_missing = listed.iter().find(|s| s.id == missing.id).unwrap();
        assert_eq!(
            Path::new(&listed_missing.folder_path),
            copy.session_dir(&missing.id).unwrap()
        );
        assert_eq!(listed_missing.video_path, missing.video_path);

        // Loading writes nothing; the next save keeps the derived paths.
        let raw: Session = read_json(&folder.join("session.json")).unwrap();
        assert_eq!(raw.video_path, played.video_path);
        copy.rename_session(&played.id, "Moved").unwrap();
        let raw: Session = read_json(&folder.join("session.json")).unwrap();
        assert_eq!(raw.folder_path, loaded.folder_path);
        assert_eq!(raw.video_path, loaded.video_path);

        // The original data folder still names its own files, unchanged.
        let unchanged = original.session(&played.id).unwrap();
        assert_eq!(unchanged.folder_path, played.folder_path);
        assert_eq!(unchanged.video_path, played.video_path);
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
    fn recovery_skips_a_damaged_session_and_repairs_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let interrupted = store.create_session(None, None, &video_only()).unwrap();
        let damaged = Uuid::new_v4().to_string();
        let folder = store.session_dir(&damaged).unwrap();
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("session.json"), b"{\"id\": \"torn").unwrap();
        // A folder without metadata is not a session at all.
        fs::create_dir(store.root.join("sessions").join("not-a-session")).unwrap();
        let skipped = store.recover_interrupted().unwrap();
        assert_eq!(skipped.len(), 1, "{skipped:?}");
        assert!(skipped[0].contains(&damaged), "{}", skipped[0]);
        assert_eq!(store.session(&interrupted.id).unwrap().status, "error");
        assert_eq!(
            fs::read(folder.join("session.json")).unwrap(),
            b"{\"id\": \"torn"
        );
    }
    #[test]
    fn recovery_that_fails_marks_a_busy_session_failed_so_it_can_be_retried_or_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let recording = store.create_session(None, None, &video_only()).unwrap();
        let mut processing = store.create_session(None, None, &video_only()).unwrap();
        processing.status = "processing".into();
        store.save_session(&processing).unwrap();
        let ready = ready_session(&store, None);
        let ready_file = store.session_dir(&ready.id).unwrap().join("session.json");
        let ready_before = fs::read(&ready_file).unwrap();
        let repaired = store.create_session(None, None, &video_only()).unwrap();
        let failing = [&recording.id, &processing.id, &ready.id];
        let skipped = store
            .recover_interrupted_with(|store, listed| {
                if failing.contains(&&listed.id) {
                    Err("The session lock is held by another program.".into())
                } else {
                    Store::recover_one(store, listed)
                }
            })
            .unwrap();
        assert_eq!(skipped.len(), 3, "{skipped:?}");
        for id in failing {
            assert!(
                skipped.iter().any(|problem| problem.contains(id.as_str())
                    && problem.contains("held by another program")),
                "{id}: {skipped:?}"
            );
        }
        for busy in [&recording.id, &processing.id] {
            let session = store.session(busy).unwrap();
            assert_eq!(session.status, "error");
            assert_eq!(
                session.error.as_deref(),
                Some("The app closed before this recording finished, and CueReview could not repair it when it started again: The session lock is held by another program. Its files are kept in the session folder; retry, or delete the recording.")
            );
        }
        // A settled session keeps its state; the others recover as usual.
        assert_eq!(fs::read(&ready_file).unwrap(), ready_before);
        let repaired = store.session(&repaired.id).unwrap();
        assert_eq!(repaired.status, "error");
        assert!(repaired.error.unwrap().contains("retry transcription"));
        // Marked sessions can be deleted now.
        store.delete_session(&recording.id).unwrap();
    }
    #[test]
    fn listing_skips_a_torn_session_and_lists_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let project = store.create_project("Section").unwrap();
        let kept = ready_session(&store, Some(&project.id));
        let other = ready_session(&store, None);
        for (name, bytes) in [
            ("torn", &b"{\"id\": \"torn"[..]),
            ("empty", &b""[..]),
            ("not-a-session", &b"[1, 2, 3]"[..]),
        ] {
            let folder = store.root.join("sessions").join(name);
            fs::create_dir(&folder).unwrap();
            fs::write(folder.join("session.json"), bytes).unwrap();
        }
        let mut listed: Vec<_> = store
            .sessions(None)
            .unwrap()
            .into_iter()
            .map(|session| session.id)
            .collect();
        listed.sort();
        let mut expected = vec![kept.id.clone(), other.id];
        expected.sort();
        assert_eq!(listed, expected);
        let section = store.sessions(Some(&project.id)).unwrap();
        assert_eq!(section.len(), 1);
        assert_eq!(section[0].id, kept.id);
        assert_eq!(
            fs::read(store.root.join("sessions/torn/session.json")).unwrap(),
            b"{\"id\": \"torn"
        );
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
    #[test]
    fn concurrent_session_updates_are_never_lost() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let session = ready_session(&store, None);
        std::thread::scope(|scope| {
            for worker in 0..8 {
                let (store, id) = (&store, session.id.as_str());
                scope.spawn(move || {
                    for step in 0..10 {
                        if worker % 2 == 0 {
                            // The app: a read-modify-write of another field.
                            store
                                .update_session(id, |s| {
                                    s.duration_ms += 1;
                                    Ok(())
                                })
                                .unwrap();
                        } else {
                            // The CLI: rename while the app writes.
                            store
                                .rename_session(id, &format!("Rename {worker}-{step}"))
                                .unwrap();
                        }
                    }
                });
            }
        });
        let saved = store.session(&session.id).unwrap();
        assert_eq!(saved.duration_ms, 40);
        assert!(saved.name.starts_with("Rename ") && !saved.auto_title);
    }
    #[test]
    fn session_lock_is_reentrant_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let session = ready_session(&store, None);
        let outer = store.lock_session(&session.id).unwrap();
        // Nested writes on the same thread do not deadlock.
        store.rename_session(&session.id, "Nested").unwrap();
        let other = ready_session(&store, None);
        // Timed from before the spawn: however late the thread starts, its
        // rename can only finish after `outer` is dropped, 150 ms from now.
        let started = Instant::now();
        let waiter = {
            let store = store.clone();
            let id = session.id.clone();
            std::thread::spawn(move || {
                store.rename_session(&id, "After release").unwrap();
                started.elapsed()
            })
        };
        // Another session is not blocked by this one.
        store.rename_session(&other.id, "Independent").unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(store.session(&session.id).unwrap().name, "Nested");
        drop(outer);
        assert!(waiter.join().unwrap() >= Duration::from_millis(150));
        assert_eq!(store.session(&session.id).unwrap().name, "After release");
        assert!(store.lock_session("../outside").is_err());
        // A failed change writes nothing and releases the lock.
        let before =
            fs::read(store.session_dir(&session.id).unwrap().join("session.json")).unwrap();
        assert!(store
            .update_session(&session.id, |s| {
                s.name = "Discarded".into();
                Err("refused".into())
            })
            .is_err());
        assert_eq!(
            fs::read(store.session_dir(&session.id).unwrap().join("session.json")).unwrap(),
            before
        );
        drop(store.lock_session(&session.id).unwrap());
        // Deleting a session also removes its lock file.
        let lock = dir.path().join("locks").join(format!("{}.lock", other.id));
        assert!(lock.is_file());
        store.delete_session(&other.id).unwrap();
        assert!(!lock.exists());
    }
    #[test]
    fn session_lock_blocks_another_process() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().into()).unwrap();
        let session = ready_session(&store, None);
        let child = |expect: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "store::tests::session_lock_child_probe",
                    "--nocapture",
                ])
                .env("CUEREVIEW_SESSION_LOCK_ROOT", dir.path())
                .env("CUEREVIEW_SESSION_LOCK_ID", &session.id)
                .env("CUEREVIEW_SESSION_LOCK_EXPECT", expect)
                .status()
                .unwrap()
        };
        let held = store.lock_session(&session.id).unwrap();
        assert!(child("blocked").success());
        assert_eq!(store.session(&session.id).unwrap().name, "Review");
        drop(held);
        assert!(child("free").success());
        assert_eq!(store.session(&session.id).unwrap().name, "From the CLI");
    }
    #[test]
    fn session_lock_child_probe() {
        let (Some(root), Some(id), Some(expect)) = (
            std::env::var_os("CUEREVIEW_SESSION_LOCK_ROOT"),
            std::env::var("CUEREVIEW_SESSION_LOCK_ID").ok(),
            std::env::var("CUEREVIEW_SESSION_LOCK_EXPECT").ok(),
        ) else {
            return;
        };
        let store = Store::open(root.into()).unwrap();
        let lock = store.lock_session_within(&id, Duration::from_millis(200));
        if expect == "blocked" {
            assert!(lock.unwrap_err().contains("Another CueReview process"));
        } else {
            drop(lock.unwrap());
            store.rename_session(&id, "From the CLI").unwrap();
        }
    }
}
