//! Continuous preview transport. Frames are pushed over one loopback MJPEG
//! connection; only the newest frame is retained when the viewer falls behind.
//! A viewer that goes away is reported with its `view` label, and reconnecting
//! to the same URL resumes the stream.
use crate::{capture, deps};
use serde::Serialize;
use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub type FrameSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
pub type ErrorSink = Arc<dyn Fn(String) + Send + Sync>;
/// Called with the `view` label of a viewer connection that ended while the
/// stream goes on.
pub type DropSink = Arc<dyn Fn(String) + Send + Sync>;
pub(crate) fn requires_exclusive_capture(source: &str) -> bool {
    source.starts_with("v4l2:") || source.starts_with("avfoundation:")
}
const MAX_FRAME: usize = 16 * 1024 * 1024;
const MAX_STDERR: usize = 8 * 1024;
const MAX_ERROR_DETAIL: usize = 1024;
/// After stdout ends, give the diagnostic reader a bounded chance to consume
/// the child's final error. A child that closes stdout but hangs must still fail.
const DIAGNOSTIC_WAIT: Duration = Duration::from_millis(100);
#[derive(Default)]
struct DiagnosticTail {
    bytes: Vec<u8>,
    finished: bool,
}
#[derive(Default)]
struct DecoderDiagnostics {
    state: Mutex<DiagnosticTail>,
    available: Condvar,
}
impl DecoderDiagnostics {
    fn append(&self, bytes: &[u8]) {
        if let Ok(mut state) = self.state.lock() {
            if bytes.len() >= MAX_STDERR {
                state.bytes.clear();
                state
                    .bytes
                    .extend_from_slice(&bytes[bytes.len() - MAX_STDERR..]);
            } else {
                let remove = (state.bytes.len() + bytes.len()).saturating_sub(MAX_STDERR);
                state.bytes.drain(..remove);
                state.bytes.extend_from_slice(bytes);
            }
        }
    }
    fn finish(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.finished = true;
            self.available.notify_all();
        }
    }
    fn wait_for_end(&self) {
        if let Ok(state) = self.state.lock() {
            let _ = self
                .available
                .wait_timeout_while(state, DIAGNOSTIC_WAIT, |state| !state.finished);
        }
    }
    fn message(&self, source: &str, failure: &str) -> String {
        let detail = self
            .state
            .lock()
            .ok()
            .map(|state| {
                let text = String::from_utf8_lossy(&state.bytes);
                // Keep an actionable access error even when FFmpeg follows it
                // with generic summaries; cap the inline excerpt, not the tail.
                let useful = text
                    .lines()
                    .rev()
                    .find(|line| {
                        let line = line.to_ascii_lowercase();
                        [
                            "permission",
                            "denied",
                            "not authorized",
                            "unauthorized",
                            "device busy",
                        ]
                        .iter()
                        .any(|term| line.contains(term))
                    })
                    .unwrap_or(text.trim());
                let mut start = useful.len().saturating_sub(MAX_ERROR_DETAIL);
                while !useful.is_char_boundary(start) {
                    start += 1;
                }
                useful[start..].trim().to_owned()
            })
            .unwrap_or_default();
        let guidance = if source.starts_with("avfoundation:") {
            "Check Camera or Screen Recording access in macOS System Settings, close other apps using the source, then retry."
        } else {
            "Check that the source is connected and available, close other apps using it, then retry."
        };
        if detail.is_empty() {
            format!("{failure} {guidance}")
        } else {
            format!("{failure} {guidance}\n{detail}")
        }
    }
}
#[derive(Default)]
struct Frames {
    latest: Mutex<(u64, Arc<Vec<u8>>)>,
    available: Condvar,
    stopped: AtomicBool,
    error: Mutex<Option<String>>,
}
impl Frames {
    fn send(&self, frame: Vec<u8>) {
        if let Ok(mut latest) = self.latest.lock() {
            *latest = (latest.0 + 1, Arc::new(frame));
            self.available.notify_all();
        }
    }
    fn fail(&self, message: String) {
        if !self.stopped.load(Ordering::Relaxed) {
            if let Ok(mut error) = self.error.lock() {
                *error = Some(message);
            }
            self.available.notify_all();
        }
    }
}

#[derive(Serialize)]
pub struct StreamInfo {
    pub id: String,
    pub url: String,
}
#[derive(Default)]
pub struct Preview {
    active: Option<Stream>,
}
struct Stream {
    id: String,
    frames: Arc<Frames>,
    worker: Option<JoinHandle<()>>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.frames.stopped.store(true, Ordering::Relaxed);
        self.frames.available.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Preview {
    /// Dropping the stream joins its worker, whose drop waits for the decoder to exit.
    /// An exclusive source is fully released before the recording process opens it.
    pub fn stop_for_recording(&mut self, source: &str) {
        if requires_exclusive_capture(source) {
            self.active = None;
        }
    }
    pub fn start(
        &mut self,
        id: String,
        source: &str,
        on_error: ErrorSink,
        on_drop: DropSink,
    ) -> Result<StreamInfo, String> {
        self.active = None;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let token = uuid::Uuid::new_v4().to_string();
        let url = format!(
            "http://127.0.0.1:{}/{token}",
            listener.local_addr().map_err(|e| e.to_string())?.port()
        );
        let frames = Arc::new(Frames::default());
        let publish = frames.clone();
        let sink: FrameSink = Arc::new(move |bytes| publish.send(bytes));
        let capture = Source::start(source, sink, frames.clone())?;
        let timeout = Instant::now();
        while frames.latest.lock().map_err(|e| e.to_string())?.0 == 0 {
            if let Some(error) = capture
                .error()
                .or_else(|| frames.error.lock().ok()?.clone())
            {
                return Err(error);
            }
            if timeout.elapsed() > Duration::from_secs(10) {
                return Err(capture.startup_timeout(source));
            }
            thread::sleep(Duration::from_millis(20));
        }
        let stream_frames = frames.clone();
        let worker = thread::spawn(move || {
            let failure = || {
                capture
                    .error()
                    .or_else(|| stream_frames.error.lock().ok()?.clone())
            };
            serve(
                listener,
                &token,
                &stream_frames,
                failure,
                &on_error,
                &on_drop,
            );
            stream_frames.stopped.store(true, Ordering::Relaxed);
            drop(capture);
        });
        self.active = Some(Stream {
            id: id.clone(),
            frames,
            worker: Some(worker),
        });
        Ok(StreamInfo { id, url })
    }
    pub fn stop(&mut self, id: &str) {
        if self.active.as_ref().is_some_and(|stream| stream.id == id) {
            self.active = None;
        }
    }
}
/// How long a viewer may take to send its request head.
const REQUEST_WAIT: Duration = Duration::from_secs(2);
/// The largest request head a viewer may send.
const REQUEST_LIMIT: usize = 8192;
/// A viewer that accepts no data for this long is dropped (and reported, so it
/// reconnects).
const VIEWER_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
/// The longest `view` label a request may carry.
const VIEW_LABEL_LIMIT: usize = 32;
const STREAM_HEAD: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=cuereview\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";

/// Makes an accepted viewer connection blocking, with a write timeout. The
/// listener is non-blocking so its accept loop notices a stop, and on Windows
/// an accepted socket inherits that: a full send buffer then fails at once
/// with `WouldBlock` (os error 10035), which looked like a disconnect and froze
/// the preview, and the read and write timeouts did nothing.
fn prepare_viewer(socket: &TcpStream) -> std::io::Result<()> {
    socket.set_nonblocking(false)?;
    socket.set_write_timeout(Some(VIEWER_WRITE_TIMEOUT))?;
    socket.set_nodelay(true)
}

/// Reads a request head through its blank line within `wait`, however the
/// viewer splits it. `None` when it ends early, is too large or too slow, or
/// the stream stops meanwhile.
fn read_request(socket: &mut TcpStream, wait: Duration, stopped: &AtomicBool) -> Option<Vec<u8>> {
    let deadline = Instant::now() + wait;
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|end| end == b"\r\n\r\n") {
        if request.len() > REQUEST_LIMIT || stopped.load(Ordering::Relaxed) {
            return None;
        }
        // Short slices keep a stop prompt while a viewer is slow.
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())?;
        socket
            .set_read_timeout(Some(left.min(Duration::from_millis(100))))
            .ok()?;
        match socket.read(&mut chunk) {
            Ok(0) => return None,
            Ok(length) => request.extend_from_slice(&chunk[..length]),
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::Interrupted | ErrorKind::WouldBlock | ErrorKind::TimedOut
                ) => {}
            Err(_) => return None,
        }
    }
    Some(request)
}

/// The `view` label of a `GET /{token}` request (empty when it has none), or
/// `None` when the request is not for this stream. The frontend numbers its
/// connections with `?view=N` so it can tell which one dropped.
fn authorized_view(request: &[u8], token: &str) -> Option<String> {
    let line = request.split(|&byte| byte == b'\n').next()?;
    let line = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next()?, parts.next()?, parts.next()?);
    if method != "GET" || !version.starts_with("HTTP/1.") || parts.next().is_some() {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path.strip_prefix('/')? != token {
        return None;
    }
    let view = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("view="))
        .filter(|view| {
            view.len() <= VIEW_LABEL_LIMIT
                && view
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        })
        .unwrap_or_default();
    Some(view.to_owned())
}

/// How streaming to one viewer ended.
#[derive(Debug, PartialEq)]
enum Streamed {
    /// The stream was stopped.
    Stopped,
    /// The source failed.
    Failed(String),
    /// The viewer closed the connection or stopped reading.
    ViewerGone,
}

/// Sends the newest frame whenever there is one, skipping the frames a slow
/// viewer missed.
fn stream_frames(
    socket: &mut impl Write,
    frames: &Frames,
    failure: &impl Fn() -> Option<String>,
) -> Streamed {
    if socket.write_all(STREAM_HEAD).is_err() {
        return Streamed::ViewerGone;
    }
    let mut sequence = 0;
    loop {
        if frames.stopped.load(Ordering::Relaxed) {
            return Streamed::Stopped;
        }
        if let Some(message) = failure() {
            return Streamed::Failed(message);
        }
        let Ok(latest) = frames.latest.lock() else {
            return Streamed::Stopped;
        };
        let Ok((latest, _)) =
            frames
                .available
                .wait_timeout_while(latest, Duration::from_millis(100), |latest| {
                    latest.0 == sequence && !frames.stopped.load(Ordering::Relaxed)
                })
        else {
            return Streamed::Stopped;
        };
        if latest.0 == sequence {
            continue;
        }
        let (next, image) = (latest.0, latest.1.clone());
        drop(latest);
        let header = format!(
            "--cuereview\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
            image.len()
        );
        if socket
            .write_all(header.as_bytes())
            .and_then(|_| socket.write_all(&image))
            .and_then(|_| socket.write_all(b"\r\n"))
            .is_err()
        {
            return Streamed::ViewerGone;
        }
        sequence = next;
    }
}

/// Serves one viewer at a time until the stream stops or `failure` reports a
/// problem. A viewer that goes away while the stream goes on is reported
/// through `dropped` with its `view` label; its next connection resumes.
fn serve(
    listener: TcpListener,
    token: &str,
    frames: &Frames,
    failure: impl Fn() -> Option<String>,
    error: &ErrorSink,
    dropped: &DropSink,
) {
    serve_with_timeout(
        listener,
        token,
        frames,
        failure,
        error,
        dropped,
        Duration::from_secs(15),
    );
}

fn serve_with_timeout(
    listener: TcpListener,
    token: &str,
    frames: &Frames,
    failure: impl Fn() -> Option<String>,
    error: &ErrorSink,
    dropped: &DropSink,
    viewer_wait: Duration,
) {
    let mut connected = false;
    let began = Instant::now();
    while !frames.stopped.load(Ordering::Relaxed) {
        if let Some(message) = failure() {
            error(message);
            return;
        }
        if !connected && began.elapsed() >= viewer_wait {
            error(
                "Preview could not connect to its viewer. Select Retry to reconnect the preview."
                    .into(),
            );
            return;
        }
        match listener.accept() {
            Ok((mut socket, _)) => {
                if prepare_viewer(&socket).is_err() {
                    continue;
                }
                let Some(request) = read_request(&mut socket, REQUEST_WAIT, &frames.stopped) else {
                    let _ = socket.write_all(
                        b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                };
                let Some(view) = authorized_view(&request, token) else {
                    let _ = socket.write_all(
                        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                };
                connected = true;
                match stream_frames(&mut socket, frames, &failure) {
                    Streamed::Stopped => return,
                    Streamed::Failed(message) => {
                        error(message);
                        return;
                    }
                    Streamed::ViewerGone => {
                        if !view.is_empty() && !frames.stopped.load(Ordering::Relaxed) {
                            dropped(view);
                        }
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => {
                error(format!("Preview transport failed: {e}"));
                return;
            }
        }
    }
}

enum Source {
    #[cfg(windows)]
    Native(capture::NativePreview),
    Process(Box<ProcessSource>),
}
impl Source {
    fn start(id: &str, sink: FrameSink, frames: Arc<Frames>) -> Result<Self, String> {
        #[cfg(windows)]
        if id.starts_with("monitor:") || id.starts_with("window:") {
            return capture::stream_preview(id, sink).map(Self::Native);
        }
        ProcessSource::start(id, sink, frames).map(|source| Self::Process(Box::new(source)))
    }
    fn error(&self) -> Option<String> {
        match self {
            #[cfg(windows)]
            Self::Native(source) => source.error.lock().ok()?.clone(),
            Self::Process(source) => source.frames.error.lock().ok()?.clone(),
        }
    }
    fn startup_timeout(&self, id: &str) -> String {
        match self {
            #[cfg(windows)]
            Self::Native(_) => {
                "Preview stream timed out. Reconnect the source and try again.".into()
            }
            Self::Process(source) => source.diagnostics.message(id, "Preview stream timed out."),
        }
    }
}
struct ProcessSource {
    decoder: Option<Child>,
    reader: Option<JoinHandle<()>>,
    diagnostic_reader: Option<JoinHandle<()>>,
    frames: Arc<Frames>,
    diagnostics: Arc<DecoderDiagnostics>,
    device: Option<DeviceServer>,
}
impl ProcessSource {
    fn start(id: &str, sink: FrameSink, frames: Arc<Frames>) -> Result<Self, String> {
        let mut device = None;
        let mut command = deps::command("ffmpeg")?;
        command.args(["-hide_banner", "-loglevel", "error", "-threads", "2"]);
        if let Some(serial) = id.strip_prefix("android:") {
            device = Some(DeviceServer::start(serial)?);
            command.args([
                "-probesize",
                "32",
                "-analyzeduration",
                "0",
                "-flags",
                "low_delay",
                "-f",
                "h264",
                "-i",
                &format!("tcp://127.0.0.1:{}", device.as_ref().unwrap().port),
            ]);
        } else {
            capture::configure_video_input(&mut command, id, 30, "32M")?;
        }
        command.args([
            "-an",
            "-vf",
            "scale=1280:720:force_original_aspect_ratio=decrease",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "mjpeg",
            "-q:v",
            "5",
            "-threads",
            "2",
            "-f",
            "image2pipe",
            "pipe:1",
        ]);
        Self::spawn_decoder(command, device, sink, frames, id)
    }
    fn spawn_decoder(
        mut command: std::process::Command,
        device: Option<DeviceServer>,
        sink: FrameSink,
        frames: Arc<Frames>,
        id: &str,
    ) -> Result<Self, String> {
        let decoder = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start the preview decoder: {error}"))?;
        let diagnostics = Arc::new(DecoderDiagnostics::default());
        let mut source = Self {
            decoder: Some(decoder),
            reader: None,
            diagnostic_reader: None,
            frames: frames.clone(),
            diagnostics: diagnostics.clone(),
            device,
        };
        let decoder = source.decoder.as_mut().unwrap();
        let mut output = decoder
            .stdout
            .take()
            .ok_or("Preview decoder has no output")?;
        let mut stderr = decoder
            .stderr
            .take()
            .ok_or("Preview decoder has no diagnostics")?;
        let errors = diagnostics.clone();
        source.diagnostic_reader = Some(thread::spawn(move || {
            let mut chunk = [0; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(length) => errors.append(&chunk[..length]),
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) => {
                        errors.append(
                            format!("\nCould not read preview diagnostics: {error}").as_bytes(),
                        );
                        break;
                    }
                }
            }
            errors.finish();
        }));
        let id = id.to_owned();
        source.reader = Some(thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 65536];
            let result = (|| -> Result<(), String> {
                loop {
                    let length = match output.read(&mut chunk) {
                        Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                        result => result.map_err(|error| error.to_string())?,
                    };
                    if length == 0 {
                        return Err("Preview stream ended.".into());
                    }
                    buffer.extend_from_slice(&chunk[..length]);
                    drain_jpegs(&mut buffer, &sink)?;
                }
            })();
            if let Err(error) = result {
                diagnostics.wait_for_end();
                frames.fail(diagnostics.message(&id, &error));
            }
        }));
        Ok(source)
    }
}
impl Drop for ProcessSource {
    fn drop(&mut self) {
        // Stop suppresses the expected pipe EOF; kill/reap before joining either
        // reader so neither can wait forever for a pipe held by this child.
        self.frames.stopped.store(true, Ordering::Relaxed);
        self.frames.available.notify_all();
        if let Some(mut decoder) = self.decoder.take() {
            let _ = decoder.kill();
            let _ = decoder.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.diagnostic_reader.take() {
            let _ = reader.join();
        }
        self.device = None;
    }
}
fn drain_jpegs(buffer: &mut Vec<u8>, sink: &FrameSink) -> Result<(), String> {
    while let Some(end) = buffer.windows(2).position(|bytes| bytes == [0xff, 0xd9]) {
        if !buffer.starts_with(&[0xff, 0xd8]) {
            return Err("Preview decoder returned an invalid frame".into());
        }
        let remainder = buffer.split_off(end + 2);
        sink(std::mem::replace(buffer, remainder));
    }
    if buffer.len() > MAX_FRAME {
        return Err("Preview frame exceeds the size limit".into());
    }
    Ok(())
}
struct DeviceServer {
    serial: String,
    port: u16,
    remote: String,
    process: Option<Child>,
}
fn adb(serial: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = deps::command("adb")?;
    command.args(["-s", serial]).args(args);
    let output = capture::output_with_timeout(command, Duration::from_secs(8))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into());
    }
    Ok(output.stdout)
}
impl DeviceServer {
    fn start(serial: &str) -> Result<Self, String> {
        let executable = deps::tool("scrcpy")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let jar = scrcpy_server_path(
            &executable,
            std::env::var_os("SCRCPY_SERVER_PATH").map(PathBuf::from),
        )?;
        let mut version_command = deps::command("scrcpy")?;
        version_command.arg("--version");
        let version_output = capture::output_with_timeout(version_command, Duration::from_secs(5))?;
        let version = String::from_utf8_lossy(&version_output.stdout)
            .lines()
            .find_map(|line| {
                line.strip_prefix("scrcpy ")
                    .and_then(|rest| rest.split_whitespace().next())
            })
            .ok_or("Could not determine scrcpy server version")?
            .to_owned();
        if !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        {
            return Err("Invalid scrcpy version".into());
        }
        let scid = (uuid::Uuid::new_v4().as_u128() & 0x7fff_ffff) as u32;
        let remote = format!("/data/local/tmp/cuereview-preview-{scid:08x}.jar");
        let mut server = Self {
            serial: serial.into(),
            port: 0,
            remote,
            process: None,
        };
        adb(
            serial,
            &[
                "push",
                jar.to_str().ok_or("Invalid scrcpy server path")?,
                &server.remote,
            ],
        )?;
        let port = adb(
            serial,
            &[
                "forward",
                "tcp:0",
                &format!("localabstract:scrcpy_{scid:08x}"),
            ],
        )?;
        server.port = String::from_utf8_lossy(&port)
            .trim()
            .parse()
            .map_err(|_| "ADB did not allocate a preview port")?;
        server.process = Some(
            deps::command("adb")?
                .args([
                    "-s",
                    serial,
                    "shell",
                    &format!("CLASSPATH={}", server.remote),
                    "app_process",
                    "/",
                    "com.genymobile.scrcpy.Server",
                    &version,
                    &format!("scid={scid:08x}"),
                    "log_level=error",
                    "audio=false",
                    "control=false",
                    "cleanup=false",
                    "power_on=false",
                    "tunnel_forward=true",
                    "raw_stream=true",
                    "max_size=1280",
                    "max_fps=30",
                    "video_bit_rate=3000000",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?,
        );
        // ADB accepts TCP connections before the remote abstract socket exists.
        // Wait for the uniquely owned remote listening socket without consuming
        // its one video connection before FFmpeg connects.
        let began = Instant::now();
        loop {
            if server
                .process
                .as_mut()
                .unwrap()
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("The device preview server could not start. Check scrcpy compatibility and USB authorization.".into());
            }
            let sockets = adb(serial, &["shell", "cat", "/proc/net/unix"])?;
            if String::from_utf8_lossy(&sockets).contains(&format!("@scrcpy_{scid:08x}")) {
                break;
            }
            if began.elapsed() > Duration::from_secs(5) {
                return Err("Device preview server did not become ready".into());
            }
            thread::sleep(Duration::from_millis(50));
        }
        Ok(server)
    }
}
fn scrcpy_server_path(executable: &Path, configured: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = configured {
        return path.is_file().then_some(path).ok_or_else(|| "SCRCPY_SERVER_PATH does not point to a file. Set it to the server matching your installed scrcpy version.".into());
    }
    let bin = executable.parent().ok_or("scrcpy folder is unavailable")?;
    let mut candidates = vec![bin.join("scrcpy-server")];
    if let Some(prefix) = bin.parent() {
        // Linux packages and Homebrew install the server beneath their prefix's share directory.
        candidates.push(prefix.join("share/scrcpy/scrcpy-server"));
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| "Reinstall scrcpy with its matching scrcpy-server file, or set SCRCPY_SERVER_PATH, to enable live device preview.".into())
}
impl Drop for DeviceServer {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let began = Instant::now();
            while process.try_wait().ok().flatten().is_none()
                && began.elapsed() < Duration::from_millis(500)
            {
                thread::sleep(Duration::from_millis(25));
            }
            let _ = process.kill();
            let _ = process.wait();
        }
        if self.port != 0 {
            let _ = adb(
                &self.serial,
                &["forward", "--remove", &format!("tcp:{}", self.port)],
            );
        }
        let _ = adb(&self.serial, &["shell", "rm", "-f", &self.remote]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_diagnostics_retain_a_bounded_utf8_safe_tail() {
        let diagnostics = DecoderDiagnostics::default();
        diagnostics.append(&vec![b'a'; MAX_STDERR + 17]);
        diagnostics.append("\nPermission denied: camera access\n".as_bytes());
        let state = diagnostics.state.lock().unwrap();
        assert_eq!(state.bytes.len(), MAX_STDERR);
        assert!(
            String::from_utf8_lossy(&state.bytes).ends_with("Permission denied: camera access\n")
        );
        drop(state);
        diagnostics.append(&vec![0xff; MAX_STDERR + 1]);
        assert!(diagnostics
            .message("avfoundation:0", "Preview stream ended.")
            .contains("System Settings"));
    }

    #[test]
    fn decoder_error_excerpt_is_small_and_keeps_the_access_error() {
        let diagnostics = DecoderDiagnostics::default();
        diagnostics.append(b"Camera authorization failed: Permission denied\n");
        diagnostics.append("Generic decoder summary\n".repeat(100).as_bytes());
        let message = diagnostics.message("avfoundation:0", "Preview stream ended.");
        assert!(message.contains("Permission denied"), "{message}");
        assert!(message.len() < MAX_ERROR_DETAIL + 512);
        diagnostics.append(&vec![0xff; MAX_STDERR]);
        let message = diagnostics.message("avfoundation:0", "Preview stream ended.");
        assert!(message.len() < MAX_ERROR_DETAIL + 512);
        assert_eq!(diagnostics.state.lock().unwrap().bytes.len(), MAX_STDERR);
    }

    fn decoder_fixture(mode: &str) -> std::process::Command {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "preview::tests::preview_decoder_subprocess_fixture",
            "--ignored",
            "--nocapture",
        ]);
        command.env("CUEREVIEW_PREVIEW_FIXTURE", mode);
        command
    }

    #[test]
    #[ignore = "Private subprocess fixture; invoked only by the preview process unit tests"]
    fn preview_decoder_subprocess_fixture() {
        match std::env::var("CUEREVIEW_PREVIEW_FIXTURE").as_deref() {
            Ok("failure") => eprintln!("Camera authorization failed: Permission denied"),
            Ok("flood") => {
                let mut error = std::io::stderr().lock();
                for _ in 0..128 {
                    error.write_all(&[b'x'; 8192]).unwrap();
                }
                error
                    .write_all(b"\nSynthetic decoder final diagnostic\n")
                    .unwrap();
            }
            Ok("wait") => thread::sleep(Duration::from_secs(30)),
            Err(std::env::VarError::NotPresent) => {}
            _ => panic!("The preview subprocess fixture needs a recognized explicit mode"),
        }
    }

    fn wait_for_decoder_failure(frames: &Frames) -> String {
        let began = Instant::now();
        loop {
            if let Some(error) = frames.error.lock().unwrap().clone() {
                return error;
            }
            assert!(
                began.elapsed() < Duration::from_secs(5),
                "decoder did not report its failure"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn decoder_failure_reports_stderr_and_macos_access_guidance() {
        let frames = Arc::new(Frames::default());
        let source = ProcessSource::spawn_decoder(
            decoder_fixture("failure"),
            None,
            Arc::new(|_| {}),
            frames.clone(),
            "avfoundation:0",
        )
        .unwrap();
        let error = wait_for_decoder_failure(&frames);
        assert!(error.contains("Permission denied"), "{error}");
        assert!(error.contains("System Settings"), "{error}");
        drop(source);
    }

    #[test]
    fn verbose_decoder_stderr_does_not_block_preview_failure_or_teardown() {
        let frames = Arc::new(Frames::default());
        let source = ProcessSource::spawn_decoder(
            decoder_fixture("flood"),
            None,
            Arc::new(|_| {}),
            frames.clone(),
            "avfoundation:0",
        )
        .unwrap();
        let error = wait_for_decoder_failure(&frames);
        assert!(
            error.contains("Synthetic decoder final diagnostic"),
            "missing final diagnostic"
        );
        assert!(error.len() < MAX_ERROR_DETAIL + 512);
        assert!(
            !error.contains("Camera access is blocked"),
            "a decoder error is not proof of denied permission"
        );
        drop(source);
    }

    #[test]
    fn stopping_a_decoder_reaps_it_and_joins_both_pipe_readers() {
        let frames = Arc::new(Frames::default());
        let source = ProcessSource::spawn_decoder(
            decoder_fixture("wait"),
            None,
            Arc::new(|_| {}),
            frames.clone(),
            "avfoundation:0",
        )
        .unwrap();
        let began = Instant::now();
        drop(source);
        assert!(began.elapsed() < Duration::from_secs(3));
        assert!(
            frames.error.lock().unwrap().is_none(),
            "intentional stop is not a capture error"
        );
    }

    #[test]
    fn a_preview_without_a_viewer_reports_a_recoverable_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let frames = Frames::default();
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let failed = errors.clone();
        serve_with_timeout(
            listener,
            "token",
            &frames,
            || None,
            &(Arc::new(move |message| failed.lock().unwrap().push(message)) as ErrorSink),
            &(Arc::new(|_| {}) as DropSink),
            Duration::from_millis(20),
        );
        let errors = errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("Retry"), "{}", errors[0]);
        assert!(TcpStream::connect(address).is_err());
    }

    #[test]
    fn synthetic_preview_frames_reach_the_viewer() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let frames = Arc::new(Frames::default());
        let publish = frames.clone();
        let sink: FrameSink = Arc::new(move |frame| publish.send(frame));
        let pixels = image::RgbImage::from_pixel(2, 2, image::Rgb([20, 100, 200]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&pixels)
            .unwrap();
        let cut = jpeg.len() / 2;
        let mut incoming = jpeg[..cut].to_vec();
        drain_jpegs(&mut incoming, &sink).unwrap();
        incoming.extend_from_slice(&jpeg[cut..]);
        drain_jpegs(&mut incoming, &sink).unwrap();
        let served = frames.clone();
        let server = thread::spawn(move || {
            serve(
                listener,
                "token",
                &served,
                || None,
                &(Arc::new(|message| panic!("{message}")) as ErrorSink),
                &(Arc::new(|_| {}) as DropSink),
            )
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client
            .write_all(b"GET /token?view=1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let mut reader = BufReader::new(client);
        let mut length = 0;
        let mut line = String::new();
        loop {
            line.clear();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if let Some(value) = line.strip_prefix("Content-Length: ") {
                length = value.trim().parse::<usize>().unwrap();
            }
            if line == "\r\n" && length > 0 {
                break;
            }
        }
        let mut delivered = vec![0; length];
        reader.read_exact(&mut delivered).unwrap();
        assert_eq!(delivered, jpeg);
        assert_eq!(image::load_from_memory(&delivered).unwrap().width(), 2);
        frames.stopped.store(true, Ordering::Relaxed);
        frames.available.notify_all();
        server.join().unwrap();
        assert!(TcpStream::connect(address).is_err());
    }

    #[test]
    fn exclusive_source_start_waits_for_preview_worker_to_release_source() {
        for exclusive in ["v4l2:/dev/video0", "avfoundation:0", "avfoundation:1"] {
            let frames = Arc::new(Frames::default());
            let released = Arc::new(AtomicBool::new(false));
            let worker_frames = frames.clone();
            let worker_released = released.clone();
            let mut preview = Preview {
                active: Some(Stream {
                    id: "owned-preview".into(),
                    frames,
                    worker: Some(thread::spawn(move || {
                        let guard = worker_frames.latest.lock().unwrap();
                        let _guard = worker_frames
                            .available
                            .wait_while(guard, |_| !worker_frames.stopped.load(Ordering::Relaxed))
                            .unwrap();
                        worker_released.store(true, Ordering::Release);
                    })),
                }),
            };
            for source in [
                "monitor:1",
                "window:123",
                "x11::0",
                "android:quest",
                "dshow:Camera",
            ] {
                preview.stop_for_recording(source);
                assert!(preview.active.is_some(), "{source}");
            }
            preview.stop_for_recording(exclusive);
            assert!(preview.active.is_none(), "{exclusive}");
            assert!(released.load(Ordering::Acquire), "{exclusive}");
        }
    }
    #[test]
    fn device_preview_finds_packaged_and_explicit_servers() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        let share = root.path().join("share/scrcpy");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&share).unwrap();
        let executable = bin.join("scrcpy");
        let server = share.join("scrcpy-server");
        std::fs::write(&server, b"server").unwrap();
        assert_eq!(scrcpy_server_path(&executable, None).unwrap(), server);
        let adjacent = bin.join("scrcpy-server");
        std::fs::write(&adjacent, b"server").unwrap();
        assert_eq!(scrcpy_server_path(&executable, None).unwrap(), adjacent);
        assert_eq!(
            scrcpy_server_path(&executable, Some(server.clone())).unwrap(),
            server
        );
        assert!(scrcpy_server_path(&executable, Some(root.path().join("missing"))).is_err());
    }
    use std::io::{BufRead, BufReader};
    #[cfg(windows)]
    struct AnimatedWindow {
        handle: usize,
        stop: std::sync::mpsc::Sender<()>,
        worker: Option<JoinHandle<()>>,
    }
    #[cfg(windows)]
    impl AnimatedWindow {
        fn new() -> Self {
            let (stop, stopped) = std::sync::mpsc::channel();
            let (ready, handle) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                use std::ffi::c_void;
                #[repr(C)]
                struct Message {
                    hwnd: *mut c_void,
                    message: u32,
                    wparam: usize,
                    lparam: isize,
                    time: u32,
                    x: i32,
                    y: i32,
                }
                #[link(name = "user32")]
                extern "system" {
                    fn CreateWindowExW(
                        ex: u32,
                        class: *const u16,
                        title: *const u16,
                        style: u32,
                        x: i32,
                        y: i32,
                        width: i32,
                        height: i32,
                        parent: *mut c_void,
                        menu: *mut c_void,
                        instance: *mut c_void,
                        param: *mut c_void,
                    ) -> *mut c_void;
                    fn SetWindowTextW(window: *mut c_void, text: *const u16) -> i32;
                    fn UpdateWindow(window: *mut c_void) -> i32;
                    fn DestroyWindow(window: *mut c_void) -> i32;
                    fn PeekMessageW(
                        message: *mut Message,
                        window: *mut c_void,
                        min: u32,
                        max: u32,
                        remove: u32,
                    ) -> i32;
                    fn TranslateMessage(message: *const Message) -> i32;
                    fn DispatchMessageW(message: *const Message) -> isize;
                }
                let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
                let title: Vec<u16> = "CueReview preview motion test\0".encode_utf16().collect();
                let window = unsafe {
                    CreateWindowExW(
                        0x08000008,
                        class.as_ptr(),
                        title.as_ptr(),
                        0x90c00000,
                        50,
                        50,
                        480,
                        220,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                let _ = ready.send(window as usize);
                let mut count = 0;
                while matches!(
                    stopped.recv_timeout(Duration::from_millis(16)),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                ) {
                    count += 1;
                    let text: Vec<u16> = format!("CueReview preview motion test — frame {count}\0")
                        .encode_utf16()
                        .collect();
                    unsafe {
                        SetWindowTextW(window, text.as_ptr());
                        UpdateWindow(window);
                    }
                    let mut message: Message = unsafe { std::mem::zeroed() };
                    unsafe {
                        while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) != 0 {
                            TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                }
                unsafe {
                    DestroyWindow(window);
                }
            });
            let handle = handle.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_ne!(handle, 0);
            Self {
                handle,
                stop,
                worker: Some(worker),
            }
        }
    }
    #[cfg(windows)]
    impl Drop for AnimatedWindow {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    #[test]
    #[ignore = "Streams an actual display/window/camera/authorized device through the production MJPEG transport"]
    #[cfg(windows)]
    fn actual_continuous_preview() {
        let mut source = std::env::var("CUEREVIEW_TEST_SOURCE").expect("Set CUEREVIEW_TEST_SOURCE");
        let animation =
            (source.starts_with("monitor:") || source == "window:test").then(AnimatedWindow::new);
        if source == "window:test" {
            source = format!("window:{}", animation.as_ref().unwrap().handle);
        }
        let directory = PathBuf::from(
            std::env::var_os("CUEREVIEW_PREVIEW_TEST_DIR").expect("Set CUEREVIEW_PREVIEW_TEST_DIR"),
        );
        std::fs::create_dir_all(&directory).unwrap();
        let errors = Arc::new(Mutex::new(Vec::new()));
        let reported = errors.clone();
        let drops = Arc::new(Mutex::new(Vec::<String>::new()));
        let dropped = drops.clone();
        let mut preview = Preview::default();
        let began = Instant::now();
        let info = preview
            .start(
                "owned-preview-test".into(),
                &source,
                Arc::new(move |error| reported.lock().unwrap().push(error)),
                Arc::new(move |view| dropped.lock().unwrap().push(view)),
            )
            .unwrap();
        let startup = began.elapsed().as_secs_f64();
        let (address, token) = info
            .url
            .strip_prefix("http://")
            .unwrap()
            .split_once('/')
            .unwrap();
        let mut forbidden = TcpStream::connect(address).unwrap();
        forbidden
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        forbidden
            .write_all(b"GET /wrong-token HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut denial = String::new();
        forbidden.read_to_string(&mut denial).unwrap();
        assert!(denial.contains("403 Forbidden"));
        // Connects as viewer `view` and reads the response head.
        let view = |view: u32| {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            write!(
                socket,
                "GET /{token}?view={view} HTTP/1.1\r\nHost: localhost\r\n\r\n"
            )
            .unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            reader
        };
        // Reads the next frame of a viewer.
        let frame = |reader: &mut BufReader<TcpStream>| {
            let mut line = String::new();
            let mut length = 0;
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if let Some(value) = line.strip_prefix("Content-Length: ") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                if line == "\r\n" && length > 0 {
                    break;
                }
            }
            let mut image = vec![0; length];
            reader.read_exact(&mut image).unwrap();
            image
        };
        let mut reader = view(1);
        let started = Instant::now();
        let mut count = 0;
        let mut dimensions = (0, 0);
        let mut bytes = 0;
        while started.elapsed() < Duration::from_secs(5) {
            let image = frame(&mut reader);
            let length = image.len();
            if count == 0 {
                let decoded = image::load_from_memory(&image).unwrap();
                dimensions = (decoded.width(), decoded.height());
                std::fs::write(directory.join("first-frame.jpg"), &image).unwrap();
            }
            count += 1;
            bytes += length;
        }
        let seconds = started.elapsed().as_secs_f64();
        assert!(
            count >= 20,
            "Preview was not continuous: {count} frames in {seconds}s"
        );
        assert!(
            drops.lock().unwrap().is_empty(),
            "A reading viewer was dropped: {:?}",
            drops.lock().unwrap()
        );
        preview.stop("stale-id");
        assert!(
            preview.active.is_some(),
            "Stale teardown stopped the current stream"
        );
        // A viewer that goes away is reported, and the next one resumes the stream.
        drop(reader);
        let mut reader = view(2);
        frame(&mut reader);
        assert_eq!(*drops.lock().unwrap(), ["1"]);
        drop(reader);
        preview.stop(&info.id);
        assert!(preview.active.is_none());
        assert!(TcpStream::connect(address).is_err());
        assert!(
            errors.lock().unwrap().is_empty(),
            "{:?}",
            errors.lock().unwrap()
        );
        std::fs::write(directory.join("verification.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "passed":true,"source":source,"startupSeconds":startup,"frames":count,"seconds":seconds,"fps":count as f64 / seconds,
            "dimensions":dimensions,"bytes":bytes,"invalidTokenRejected":true,"staleStopIgnored":true,"droppedViewerReported":true,"viewerReconnected":true,"streamClosed":true
        })).unwrap()).unwrap();
    }
    /// A loopback listener set up like `Preview::start`'s, and a viewer connected to it.
    fn viewer_pair() -> (TcpListener, TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let began = Instant::now();
        let server = loop {
            match listener.accept() {
                Ok((server, _)) => break server,
                Err(e) if e.kind() == ErrorKind::WouldBlock => {
                    assert!(began.elapsed() < Duration::from_secs(5));
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("{e}"),
            }
        };
        (listener, client, server)
    }
    #[test]
    fn a_viewer_that_reads_late_still_receives_every_frame_sent_meanwhile() {
        let (_listener, mut client, mut server) = viewer_pair();
        prepare_viewer(&server).unwrap();
        let frame = vec![7u8; 1024 * 1024];
        let count = 16;
        let reader = thread::spawn(move || {
            // The send buffer fills while the viewer is busy.
            thread::sleep(Duration::from_millis(300));
            let mut received = Vec::new();
            client.read_to_end(&mut received).unwrap();
            received.len()
        });
        for _ in 0..count {
            server
                .write_all(&frame)
                .expect("a full send buffer is not a disconnect");
        }
        drop(server);
        assert_eq!(reader.join().unwrap(), count * frame.len());
    }
    #[test]
    fn requests_split_across_packets_are_read_whole_and_checked() {
        let (_listener, mut client, mut server) = viewer_pair();
        prepare_viewer(&server).unwrap();
        let stopped = AtomicBool::new(false);
        let writer = thread::spawn(move || {
            client.write_all(b"GET /tok").unwrap();
            thread::sleep(Duration::from_millis(250));
            client
                .write_all(b"en?x=1&view=3 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .unwrap();
            client
        });
        let request = read_request(&mut server, REQUEST_WAIT, &stopped).unwrap();
        assert_eq!(authorized_view(&request, "token"), Some("3".into()));
        drop(writer.join().unwrap());
        // A viewer that sends nothing, or stops early, is not waited on forever.
        let (_listener, _silent, mut server) = viewer_pair();
        prepare_viewer(&server).unwrap();
        let began = Instant::now();
        assert!(read_request(&mut server, Duration::from_millis(300), &stopped).is_none());
        assert!(began.elapsed() < Duration::from_secs(2));
        let (_listener, mut early, mut server) = viewer_pair();
        prepare_viewer(&server).unwrap();
        early.write_all(b"GET /token HTTP/1.1\r\n").unwrap();
        drop(early);
        assert!(read_request(&mut server, REQUEST_WAIT, &stopped).is_none());
        for (request, view) in [
            ("GET /token HTTP/1.1\r\n\r\n", Some("")),
            ("GET /token?view=12 HTTP/1.0\r\n\r\n", Some("12")),
            ("GET /token?view=bad%20label HTTP/1.1\r\n\r\n", Some("")),
            ("GET /wrong-token HTTP/1.1\r\n\r\n", None),
            ("GET /token/extra HTTP/1.1\r\n\r\n", None),
            ("GET /tokenx HTTP/1.1\r\n\r\n", None),
            ("POST /token HTTP/1.1\r\n\r\n", None),
            ("GET /token\r\n\r\n", None),
        ] {
            assert_eq!(
                authorized_view(request.as_bytes(), "token").as_deref(),
                view,
                "{request}"
            );
        }
        assert_eq!(
            authorized_view(b"\xff\xfe /token HTTP/1.1\r\n\r\n", "token"),
            None
        );
    }
    #[test]
    fn serve_resumes_for_a_reconnecting_viewer_and_reports_the_one_that_left() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let frames = Arc::new(Frames::default());
        let drops = Arc::new(Mutex::new(Vec::<String>::new()));
        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let (served, dropped, failed) = (frames.clone(), drops.clone(), errors.clone());
        let server = thread::spawn(move || {
            serve(
                listener,
                "token",
                &served,
                || None,
                &(Arc::new(move |error| failed.lock().unwrap().push(error)) as ErrorSink),
                &(Arc::new(move |view| dropped.lock().unwrap().push(view)) as DropSink),
            )
        });
        // Large frames, so a viewer that reads slowly fills the send buffer.
        let producing = Arc::new(AtomicBool::new(true));
        let producer = {
            let (frames, producing) = (frames.clone(), producing.clone());
            thread::spawn(move || {
                let mut n = 0u8;
                while producing.load(Ordering::Relaxed) {
                    n = n.wrapping_add(1);
                    let mut frame = vec![n; 2 * 1024 * 1024];
                    frame[..2].copy_from_slice(&[0xff, 0xd8]);
                    frames.send(frame);
                    thread::sleep(Duration::from_millis(10));
                }
            })
        };
        let connect = |request: &str| {
            let mut socket = TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket.write_all(request.as_bytes()).unwrap();
            socket
        };
        let mut denied = String::new();
        connect("GET /wrong HTTP/1.1\r\n\r\n")
            .read_to_string(&mut denied)
            .unwrap();
        assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
        // Reads the head and `count` frames, pausing between them like a busy viewer.
        let watch = |socket: TcpStream, count: usize, pause: Duration| {
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("HTTP/1.1 200"), "{line}");
            for _ in 0..count {
                let mut length = 0;
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0, "stream ended");
                    if let Some(value) = line.strip_prefix("Content-Length: ") {
                        length = value.trim().parse().unwrap();
                    }
                    if line == "\r\n" && length > 0 {
                        break;
                    }
                }
                let mut image = vec![0; length];
                reader.read_exact(&mut image).unwrap();
                assert_eq!(&image[..2], [0xff, 0xd8]);
                thread::sleep(pause);
            }
            reader
        };
        let first = watch(
            connect("GET /token?view=1 HTTP/1.1\r\n\r\n"),
            4,
            Duration::from_millis(150),
        );
        assert!(drops.lock().unwrap().is_empty());
        drop(first);
        let second = watch(
            connect("GET /token?view=2 HTTP/1.1\r\n\r\n"),
            2,
            Duration::ZERO,
        );
        assert_eq!(*drops.lock().unwrap(), ["1"]);
        frames.stopped.store(true, Ordering::Relaxed);
        frames.available.notify_all();
        server.join().unwrap();
        producing.store(false, Ordering::Relaxed);
        producer.join().unwrap();
        drop(second);
        assert_eq!(*drops.lock().unwrap(), ["1"], "a stop is not a drop");
        assert!(errors.lock().unwrap().is_empty());
    }
    #[test]
    fn split_jpeg_frames_are_delivered_without_backlog() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let saved = output.clone();
        let sink: FrameSink = Arc::new(move |bytes| saved.lock().unwrap().push(bytes));
        let mut buffer = vec![0xff];
        drain_jpegs(&mut buffer, &sink).unwrap();
        buffer.extend_from_slice(&[0xd8, 1, 0xff]);
        drain_jpegs(&mut buffer, &sink).unwrap();
        buffer.extend_from_slice(&[0xd9, 0xff, 0xd8, 2, 0xff, 0xd9]);
        drain_jpegs(&mut buffer, &sink).unwrap();
        assert!(buffer.is_empty());
        assert_eq!(output.lock().unwrap().len(), 2);
        assert!(drain_jpegs(&mut vec![0, 0xff, 0xd9], &sink).is_err());
        assert!(drain_jpegs(&mut vec![0; MAX_FRAME + 1], &sink).is_err());
    }
}
