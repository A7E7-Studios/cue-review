//! Continuous preview transport. Frames are pushed over one loopback MJPEG
//! connection; only the newest frame is retained when the viewer falls behind.
use crate::{capture, deps};
use serde::Serialize;
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
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
const MAX_FRAME: usize = 16 * 1024 * 1024;
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
    pub fn start(
        &mut self,
        id: String,
        source: &str,
        on_error: ErrorSink,
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
                return Err("Preview stream timed out. Reconnect the source and try again.".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
        let stream_frames = frames.clone();
        let worker = thread::spawn(move || {
            serve(listener, &token, &stream_frames, &capture, &on_error);
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
fn serve(listener: TcpListener, token: &str, frames: &Frames, source: &Source, error: &ErrorSink) {
    let mut connected = false;
    let began = Instant::now();
    while !frames.stopped.load(Ordering::Relaxed) {
        if let Some(message) = source.error().or_else(|| frames.error.lock().ok()?.clone()) {
            error(message);
            return;
        }
        match listener.accept() {
            Ok((mut socket, _)) => {
                let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
                let _ = socket.set_write_timeout(Some(Duration::from_secs(1)));
                let _ = socket.set_nodelay(true);
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while request.len() < 4096 && !request.ends_with(b"\r\n\r\n") {
                    if socket.read_exact(&mut byte).is_err() {
                        break;
                    }
                    request.push(byte[0]);
                }
                if !request.starts_with(format!("GET /{token} HTTP/1.").as_bytes()) {
                    let _ = socket.write_all(
                        b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    continue;
                }
                connected = true;
                if socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=cuereview\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n").is_err() { continue; }
                let mut sequence = 0;
                while !frames.stopped.load(Ordering::Relaxed) {
                    if let Some(message) =
                        source.error().or_else(|| frames.error.lock().ok()?.clone())
                    {
                        error(message);
                        return;
                    }
                    let latest = frames.latest.lock().unwrap();
                    let (latest, _) = frames
                        .available
                        .wait_timeout_while(latest, Duration::from_millis(100), |latest| {
                            latest.0 == sequence && !frames.stopped.load(Ordering::Relaxed)
                        })
                        .unwrap();
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
                        break;
                    }
                    sequence = next;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !connected && began.elapsed() > Duration::from_secs(15) {
                    return;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                error(format!("Preview transport failed: {e}"));
                return;
            }
        }
    }
}

enum Source {
    Native(capture::NativePreview),
    Process(Box<ProcessSource>),
}
impl Source {
    fn start(id: &str, sink: FrameSink, frames: Arc<Frames>) -> Result<Self, String> {
        if id.starts_with("monitor:") || id.starts_with("window:") {
            return capture::stream_preview(id, sink).map(Self::Native);
        }
        ProcessSource::start(id, sink, frames).map(|source| Self::Process(Box::new(source)))
    }
    fn error(&self) -> Option<String> {
        match self {
            Self::Native(source) => source.error.lock().ok()?.clone(),
            Self::Process(source) => source
                .reader
                .as_ref()
                .filter(|reader| reader.is_finished())
                .map(|_| "Preview stream ended. Reconnect the source and select it again.".into()),
        }
    }
}
struct ProcessSource {
    decoder: Option<Child>,
    reader: Option<JoinHandle<()>>,
    device: Option<DeviceServer>,
}
impl ProcessSource {
    fn start(id: &str, sink: FrameSink, frames: Arc<Frames>) -> Result<Self, String> {
        let mut source = Self {
            decoder: None,
            reader: None,
            device: None,
        };
        let mut command = deps::command("ffmpeg")?;
        command.args(["-hide_banner", "-loglevel", "error", "-threads", "2"]);
        if let Some(serial) = id.strip_prefix("android:") {
            source.device = Some(DeviceServer::start(serial)?);
            let device = source.device.as_ref().unwrap();
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
                &format!("tcp://127.0.0.1:{}", device.port),
            ]);
        } else if let Some(name) = id.strip_prefix("dshow:") {
            command.args([
                "-f",
                "dshow",
                "-rtbufsize",
                "32M",
                "-i",
                &format!("video={name}"),
            ]);
        } else {
            return Err("Unknown preview source".into());
        }
        let mut decoder = command
            .args([
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
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut output = decoder
            .stdout
            .take()
            .ok_or("Preview decoder has no output")?;
        source.decoder = Some(decoder);
        source.reader = Some(thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 65536];
            let result = (|| -> Result<(), String> {
                loop {
                    let length = output.read(&mut chunk).map_err(|e| e.to_string())?;
                    if length == 0 {
                        return Err(
                            "Preview stream ended. Reconnect the source and select it again."
                                .into(),
                        );
                    }
                    buffer.extend_from_slice(&chunk[..length]);
                    drain_jpegs(&mut buffer, &sink)?;
                }
            })();
            if let Err(error) = result {
                frames.fail(error);
            }
        }));
        Ok(source)
    }
}
impl Drop for ProcessSource {
    fn drop(&mut self) {
        if let Some(mut decoder) = self.decoder.take() {
            let _ = decoder.kill();
            let _ = decoder.wait();
        }
        if let Some(reader) = self.reader.take() {
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
        let jar: PathBuf = executable
            .parent()
            .ok_or("scrcpy folder is unavailable")?
            .join("scrcpy-server");
        if !jar.is_file() {
            return Err("Reinstall scrcpy with its matching scrcpy-server file to enable live device preview.".into());
        }
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
    use std::io::{BufRead, BufReader};
    use std::net::TcpStream;
    struct AnimatedWindow {
        handle: usize,
        stop: std::sync::mpsc::Sender<()>,
        worker: Option<JoinHandle<()>>,
    }
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
        let mut preview = Preview::default();
        let began = Instant::now();
        let info = preview
            .start(
                "owned-preview-test".into(),
                &source,
                Arc::new(move |error| reported.lock().unwrap().push(error)),
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
        let mut socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(socket, "GET /{token} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        loop {
            line.clear();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        let started = Instant::now();
        let mut count = 0;
        let mut dimensions = (0, 0);
        let mut bytes = 0;
        while started.elapsed() < Duration::from_secs(5) {
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
        preview.stop("stale-id");
        assert!(
            preview.active.is_some(),
            "Stale teardown stopped the current stream"
        );
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
            "dimensions":dimensions,"bytes":bytes,"invalidTokenRejected":true,"staleStopIgnored":true,"streamClosed":true
        })).unwrap()).unwrap();
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
