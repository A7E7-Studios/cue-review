//! Native Windows capture and portable FFmpeg/device capture. Failed captures retain their original tracks for recovery.
#[cfg(any(windows, test))]
use crate::cursor;
use crate::{
    deps,
    models::{CaptureConfig, CaptureSource, Microphone},
    touch,
};
use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Output, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
#[cfg(windows)]
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, ImageEncoder, ImageEncoderPixelFormat,
        ImageFormat, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType,
    },
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
};

type SharedError = Arc<Mutex<Option<String>>>;
fn fail(error: &SharedError, message: impl ToString) {
    if let Ok(mut e) = error.lock() {
        if e.is_none() {
            *e = Some(message.to_string());
        }
    }
}
fn source(id: String, name: String, kind: &str, detail: Option<String>) -> CaptureSource {
    CaptureSource {
        id,
        name,
        kind: kind.into(),
        available: true,
        detail,
    }
}

pub fn sources() -> Result<Vec<CaptureSource>, String> {
    let mut result = Vec::new();
    #[cfg(windows)]
    {
        for m in Monitor::enumerate().map_err(|e| e.to_string())? {
            let index = m.index().map_err(|e| e.to_string())?;
            result.push(source(
                format!("monitor:{index}"),
                format!("Display {index} — {}", m.name().unwrap_or_default()),
                "display",
                Some(format!(
                    "{} × {}",
                    m.width().unwrap_or(0),
                    m.height().unwrap_or(0)
                )),
            ));
        }
        for w in Window::enumerate().map_err(|e| e.to_string())? {
            let name = w.title().unwrap_or_default();
            if !name.trim().is_empty() && w.width().unwrap_or(0) > 0 && w.height().unwrap_or(0) > 0
            {
                result.push(source(
                    format!("window:{}", w.as_raw_hwnd() as usize),
                    name,
                    "window",
                    w.process_name().ok(),
                ));
            }
        }
    }
    #[cfg(not(windows))]
    result.extend(platform_sources());
    let mut devices = None;
    if let Ok(mut cmd) = deps::command("adb") {
        cmd.args(["devices", "-l"]);
        if let Ok(out) = output_with_timeout(cmd, Duration::from_secs(5)) {
            if out.status.success() {
                devices = Some(adb_sources(&String::from_utf8_lossy(&out.stdout)));
            }
        }
    }
    result.extend(devices.unwrap_or_else(|| adb_sources("")));
    #[cfg(windows)]
    if let Ok(mut cmd) = deps::command("ffmpeg") {
        cmd.args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ]);
        if let Ok(out) = output_with_timeout(cmd, Duration::from_secs(5)) {
            for name in dshow_names(&String::from_utf8_lossy(&out.stderr)) {
                result.push(source(
                    format!("dshow:{name}"),
                    name,
                    "camera",
                    Some("DirectShow video source. Preview to verify availability.".into()),
                ));
            }
        }
    }
    Ok(result)
}

/// What a `window:HWND` or `monitor:N` source is right now: the window's
/// title, process image name and class, or the display's device name and
/// bounds, resolved as capture resolves the id. `None` when the source is
/// gone, for every other kind of source, and on macOS and Linux.
#[cfg(windows)]
pub fn source_identity(id: &str) -> Option<crate::models::SourceIdentity> {
    identity::read(id)
}
/// Sources on macOS and Linux have no identity to check.
#[cfg(not(windows))]
pub fn source_identity(_id: &str) -> Option<crate::models::SourceIdentity> {
    None
}

fn unavailable_source() -> String {
    "This capture source is not available on this platform. Refresh sources and select an available display, camera, or authorized USB device.".into()
}

fn is_process_source(id: &str) -> bool {
    ["dshow:", "avfoundation:", "x11:", "v4l2:"]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

/// Shared input selection keeps recording and continuous preview on the same backend.
pub(crate) fn configure_video_input(
    command: &mut std::process::Command,
    id: &str,
    _fps: u32,
    _buffer: &str,
) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(name) = id.strip_prefix("dshow:") {
        command.args([
            "-f",
            "dshow",
            "-rtbufsize",
            _buffer,
            "-i",
            &format!("video={name}"),
        ]);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if let Some(index) = id
        .strip_prefix("avfoundation:")
        .and_then(|s| s.parse::<u32>().ok())
    {
        command.args([
            "-f",
            "avfoundation",
            "-framerate",
            &_fps.to_string(),
            "-capture_cursor",
            "1",
            "-i",
            &format!("{index}:none"),
        ]);
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(display) = id.strip_prefix("x11:").filter(|s| !s.is_empty()) {
            command.args([
                "-f",
                "x11grab",
                "-framerate",
                &_fps.to_string(),
                "-i",
                display,
            ]);
            return Ok(());
        }
        if let Some(device) = id
            .strip_prefix("v4l2:")
            .filter(|s| video_device_name(s).is_some())
        {
            command.args(["-f", "v4l2", "-framerate", &_fps.to_string(), "-i", device]);
            return Ok(());
        }
    }
    Err(unavailable_source())
}

#[cfg(not(windows))]
fn unavailable_display(detail: &str) -> CaptureSource {
    let mut display = source(
        "desktop:unavailable".into(),
        "Display unavailable".into(),
        "display",
        Some(detail.into()),
    );
    display.available = false;
    display
}

#[cfg(target_os = "macos")]
fn platform_sources() -> Vec<CaptureSource> {
    let found = (|| {
        let mut command = deps::command("ffmpeg").ok()?;
        command.args([
            "-hide_banner",
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
        ]);
        let output = output_with_timeout(command, Duration::from_secs(5)).ok()?;
        Some(avfoundation_sources(&String::from_utf8_lossy(
            &output.stderr,
        )))
    })()
    .unwrap_or_default();
    if found.is_empty() {
        vec![unavailable_display("Install FFmpeg with AVFoundation support, allow Screen Recording and Camera access in macOS System Settings, then refresh sources.")]
    } else {
        found
    }
}

#[cfg(any(target_os = "macos", test))]
fn avfoundation_sources(text: &str) -> Vec<CaptureSource> {
    let mut video = false;
    let mut sources = Vec::new();
    for line in text.lines() {
        if line.contains("AVFoundation video devices:") {
            video = true;
            continue;
        }
        if line.contains("AVFoundation audio devices:") {
            video = false;
        }
        if !video {
            continue;
        }
        let Some((_, entry)) = line.rsplit_once('[') else {
            continue;
        };
        let Some((index, name)) = entry.split_once(']') else {
            continue;
        };
        let Ok(index) = index.parse::<u32>() else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        sources.push(source(format!("avfoundation:{index}"), name.into(),
            if name.starts_with("Capture screen") { "display" } else { "camera" },
            Some("Allow Screen Recording or Camera access in macOS System Settings if capture is blocked.".into())));
    }
    sources
}

#[cfg(any(target_os = "linux", test))]
fn video_device_name(path: &str) -> Option<&str> {
    let index = path.strip_prefix("/dev/video")?;
    (!index.is_empty() && index.bytes().all(|b| b.is_ascii_digit())).then_some(index)
}

#[cfg(target_os = "linux")]
fn platform_sources() -> Vec<CaptureSource> {
    let mut sources = Vec::new();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s == "wayland");
    if wayland {
        sources.push(unavailable_display("Wayland screen capture is not supported yet. Sign into an X11 desktop session, or select a camera or USB device."));
    } else if let Some(display) = std::env::var("DISPLAY").ok().filter(|s| !s.is_empty()) {
        sources.push(source(
            format!("x11:{display}"),
            "Desktop".into(),
            "display",
            Some("X11 full desktop capture; requires FFmpeg with x11grab support.".into()),
        ));
    } else {
        sources.push(unavailable_display("No X11 desktop is available. Start CueReview in an X11 desktop session, or select a camera or USB device."));
    }
    if let Ok(entries) = fs::read_dir("/dev") {
        let mut devices: Vec<_> = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path().to_string_lossy().into_owned();
                video_device_name(&path).map(|_| path.clone())
            })
            .collect();
        devices.sort();
        for path in devices {
            sources.push(source(
                format!("v4l2:{path}"),
                format!("Camera — {path}"),
                "camera",
                Some("V4L2 device. Preview to verify video support and camera permissions.".into()),
            ));
        }
    }
    sources
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn platform_sources() -> Vec<CaptureSource> {
    vec![unavailable_display(
        "Desktop capture is not supported on this operating system.",
    )]
}

fn adb_sources(text: &str) -> Vec<CaptureSource> {
    let mut devices = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 2 || !matches!(fields[1], "device" | "unauthorized" | "offline") {
            continue;
        }
        let model = fields
            .iter()
            .find_map(|s| s.strip_prefix("model:"))
            .unwrap_or(fields[0])
            .replace('_', " ");
        let kind = if touch::is_quest(&model) {
            "quest"
        } else {
            "android"
        };
        let (available, detail) = match fields[1] {
            "device" => (true, "USB device authorized for scrcpy capture."),
            "unauthorized" => (false, "Wake the device and accept its USB debugging authorization prompt, then refresh sources."),
            _ => (false, "Wake the device, reconnect its USB cable, and refresh sources. Check USB debugging is enabled."),
        };
        let mut device = source(
            format!("android:{}", fields[0]),
            if available {
                model
            } else {
                format!("{model} — {}", fields[1])
            },
            kind,
            Some(detail.into()),
        );
        device.available = available;
        devices.push(device);
    }
    if devices.is_empty() {
        let mut waiting = source("android:waiting".into(), "Android / Quest — waiting for device".into(), "android", Some("Connect a USB device, enable USB debugging, accept its authorization prompt, and refresh sources. Android platform-tools and scrcpy must be installed.".into()));
        waiting.available = false;
        devices.push(waiting);
    }
    devices
}

#[cfg(any(windows, test))]
fn dshow_names(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.contains("(video)"))
        .filter_map(|l| l.split('"').nth(1).map(str::to_owned))
        .filter(|name| !is_quest_virtual_camera(name))
        .collect()
}
#[cfg(any(windows, test))]
fn is_quest_virtual_camera(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("meta quest") || name.starts_with("oculus quest")
}

pub fn microphones() -> Result<Vec<Microphone>, String> {
    let host = cpal::default_host();
    let mut result = Vec::new();
    if let Some(d) = host.default_input_device() {
        result.push(Microphone {
            id: "default".into(),
            name: format!("Default — {}", d.name().unwrap_or_default()),
        });
    }
    for device in host.input_devices().map_err(|e| e.to_string())? {
        if let Ok(name) = device.name() {
            result.push(Microphone {
                id: name.clone(),
                name,
            });
        }
    }
    Ok(result)
}

#[cfg(windows)]
struct NativeFlags {
    path: PathBuf,
    fps: u32,
    epoch: Instant,
    error: SharedError,
    ready: mpsc::SyncSender<Result<(), String>>,
    preview: bool,
    preview_sink: Option<crate::preview::FrameSink>,
}
#[cfg(windows)]
struct NativeCapture {
    flags: NativeFlags,
    encoder: Option<PacedEncoder>,
    first_frame: Option<f64>,
    /// The first frame's size, which every later frame is cropped or padded to.
    canvas: Option<(u32, u32)>,
    ready_sent: bool,
}
#[cfg(windows)]
impl NativeCapture {
    fn finish(&mut self) -> Result<(), String> {
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        Ok(())
    }
}
#[cfg(windows)]
struct PacedEncoder {
    latest: Arc<Mutex<Arc<Vec<u8>>>>,
    width: u32,
    height: u32,
    stop: mpsc::Sender<()>,
    join: JoinHandle<Result<(), String>>,
}
#[cfg(windows)]
impl PacedEncoder {
    fn new(
        mut encoder: VideoEncoder,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
        fps: u32,
        error: SharedError,
        started: Instant,
    ) -> Self {
        let latest = Arc::new(Mutex::new(Arc::new(pixels)));
        let frames = latest.clone();
        let (stop, receiver) = mpsc::channel();
        let join = thread::spawn(move || {
            let mut index = 0u64;
            let result = (|| {
                let mut previous = frames.lock().map_err(|e| e.to_string())?.clone();
                let interval = Duration::from_secs_f64(1.0 / fps as f64);
                loop {
                    // The encoder copies these owned bytes. WGC surfaces are mutable pool slots.
                    let slot = started + Duration::from_secs_f64(index as f64 / fps as f64);
                    // Fill overdue slots with the previously sent image, never a future update.
                    if Instant::now().saturating_duration_since(slot) < interval {
                        previous = frames.lock().map_err(|e| e.to_string())?.clone();
                    }
                    encoder
                        .send_frame_buffer(&previous, (index * 10_000_000 / fps as u64) as i64)
                        .map_err(|e| e.to_string())?;
                    index += 1;
                    let next = started + Duration::from_secs_f64(index as f64 / fps as f64);
                    if Instant::now().saturating_duration_since(next) > Duration::from_secs(2) {
                        return Err(
                            "Native video encoding could not keep up with the recording clock"
                                .into(),
                        );
                    }
                    match receiver.recv_timeout(next.saturating_duration_since(Instant::now())) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => (),
                    }
                }
                encoder.finish().map_err(|e| e.to_string())
            })();
            if let Err(ref message) = result {
                fail(&error, message);
            }
            result
        });
        Self {
            latest,
            width,
            height,
            stop,
            join,
        }
    }
    fn finish(self) -> Result<(), String> {
        let _ = self.stop.send(());
        self.join
            .join()
            .map_err(|_| "Native encoder worker panicked".to_string())?
    }
}
#[cfg(windows)]
fn owned_bgra(frame: &mut Frame, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let frame_width = frame.width();
    let frame_height = frame.height();
    let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
    let stride = buffer.row_pitch() as usize;
    let raw = buffer.as_raw_buffer();
    let row_bytes = width.min(frame_width) as usize * 4;
    let mut pixels = vec![0; width as usize * height as usize * 4];
    for y in 0..height.min(frame_height) as usize {
        let target = (height as usize - 1 - y) * width as usize * 4;
        pixels[target..target + row_bytes]
            .copy_from_slice(&raw[y * stride..y * stride + row_bytes]);
    }
    Ok(pixels)
}
#[cfg(windows)]
impl GraphicsCaptureApiHandler for NativeCapture {
    type Flags = NativeFlags;
    type Error = String;
    fn new(ctx: Context<NativeFlags>) -> Result<Self, String> {
        Ok(Self {
            flags: ctx.flags,
            encoder: None,
            first_frame: None,
            canvas: None,
            ready_sent: false,
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), String> {
        let result = (|| {
            if self.flags.preview {
                if let Some(sink) = &self.flags.preview_sink {
                    let (width, height) = (frame.width(), frame.height());
                    let scale = (1280.0 / width as f64).min(720.0 / height as f64).min(1.0);
                    let target_width = (width as f64 * scale).round().max(1.0) as u32;
                    let target_height = (height as f64 * scale).round().max(1.0) as u32;
                    let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
                    let stride = buffer.row_pitch() as usize;
                    let raw = buffer.as_raw_buffer();
                    let mut packed = vec![0u8; target_width as usize * target_height as usize * 4];
                    for y in 0..target_height as usize {
                        let row = y * height as usize / target_height as usize * stride;
                        for x in 0..target_width as usize {
                            let from = row + x * width as usize / target_width as usize * 4;
                            let to = (y * target_width as usize + x) * 4;
                            packed[to..to + 4].copy_from_slice(&raw[from..from + 4]);
                        }
                    }
                    let bytes =
                        ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Bgra8)
                            .map_err(|e| e.to_string())?
                            .encode(&packed, target_width, target_height)
                            .map_err(|e| e.to_string())?;
                    sink(bytes);
                } else {
                    frame
                        .save_as_image(&self.flags.path, ImageFormat::Png)
                        .map_err(|e| e.to_string())?;
                    control.stop();
                }
            } else {
                if self.encoder.is_none() {
                    let width = frame.width();
                    let height = frame.height();
                    let pixels = owned_bgra(frame, width, height)?;
                    let encoder = VideoEncoder::new(
                        VideoSettingsBuilder::new(frame.width(), frame.height())
                            .sub_type(VideoSettingsSubType::H264)
                            .frame_rate(self.flags.fps),
                        AudioSettingsBuilder::default().disabled(true),
                        ContainerSettingsBuilder::default(),
                        &self.flags.path,
                    )
                    .map_err(|e| e.to_string())?;
                    let encoder_origin = Instant::now();
                    self.canvas = Some((width, height));
                    self.first_frame = Some(
                        encoder_origin
                            .duration_since(self.flags.epoch)
                            .as_secs_f64(),
                    );
                    self.encoder = Some(PacedEncoder::new(
                        encoder,
                        pixels,
                        width,
                        height,
                        self.flags.fps,
                        self.flags.error.clone(),
                        encoder_origin,
                    ));
                } else if let Some(encoder) = self.encoder.as_ref() {
                    let pixels = owned_bgra(frame, encoder.width, encoder.height)?;
                    *encoder.latest.lock().map_err(|e| e.to_string())? = Arc::new(pixels);
                }
            }
            Ok(())
        })();
        if !self.ready_sent {
            let _ = self.flags.ready.send(result.clone());
            self.ready_sent = true;
        }
        if let Err(ref e) = result {
            fail(&self.flags.error, e);
        }
        result
    }
    fn on_closed(&mut self) -> Result<(), String> {
        if !self.flags.preview {
            fail(&self.flags.error, "Capture source closed during recording");
        } else if self.flags.preview_sink.is_some() {
            fail(
                &self.flags.error,
                "Preview source closed. Choose another source.",
            );
        }
        self.finish()
    }
}
#[cfg(windows)]
impl Drop for NativeCapture {
    fn drop(&mut self) {
        if let Err(e) = self.finish() {
            fail(&self.flags.error, e);
        }
    }
}

#[cfg(windows)]
fn native_start(
    id: &str,
    flags: NativeFlags,
) -> Result<CaptureControl<NativeCapture, String>, String> {
    fn launch<T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Send + 'static>(
        item: T,
        flags: NativeFlags,
    ) -> Result<CaptureControl<NativeCapture, String>, String> {
        let fps = flags.fps;
        NativeCapture::start_free_threaded(Settings::new(
            item,
            CursorCaptureSettings::Default,
            DrawBorderSettings::Default,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(Duration::from_secs_f64(1.0 / fps as f64)),
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags,
        ))
        .map_err(|e| e.to_string())
    }
    if let Some(index) = id.strip_prefix("monitor:") {
        return launch(
            Monitor::from_index(index.parse().map_err(|_| "Invalid display ID")?)
                .map_err(|e| e.to_string())?,
            flags,
        );
    }
    if let Some(handle) = id.strip_prefix("window:") {
        let handle: usize = handle.parse().map_err(|_| "Invalid window ID")?;
        let window = Window::from_raw_hwnd(handle as *mut std::ffi::c_void);
        if !window.is_valid() {
            return Err("This window is no longer available".into());
        }
        return launch(window, flags);
    }
    Err("Unknown native capture source".into())
}

#[cfg(windows)]
pub struct NativePreview {
    control: Option<CaptureControl<NativeCapture, String>>,
    pub error: SharedError,
}
#[cfg(windows)]
impl Drop for NativePreview {
    fn drop(&mut self) {
        if let Some(control) = self.control.take() {
            let _ = control.stop();
        }
    }
}
#[cfg(windows)]
pub fn stream_preview(
    source: &str,
    sink: crate::preview::FrameSink,
) -> Result<NativePreview, String> {
    let error: SharedError = Arc::default();
    let (ready, first) = mpsc::sync_channel(1);
    let control = native_start(
        source,
        NativeFlags {
            path: PathBuf::new(),
            fps: 30,
            epoch: Instant::now(),
            error: error.clone(),
            ready,
            preview: true,
            preview_sink: Some(sink),
        },
    )?;
    let preview = NativePreview {
        control: Some(control),
        error,
    };
    first.recv_timeout(Duration::from_secs(8)).map_err(|_| {
        "Preview timed out. Restore the selected window and try again.".to_string()
    })??;
    Ok(preview)
}

/// A rectangle in physical screen pixels, laid out like Win32 `RECT`.
#[cfg(any(windows, test))]
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[cfg(any(windows, test))]
impl ScreenRect {
    fn contains(self, (x, y): (i32, i32)) -> bool {
        (self.left..self.right).contains(&x) && (self.top..self.bottom).contains(&y)
    }
}

/// What the cursor sampler read about its source in one poll, in physical pixels.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug)]
enum SourceReading {
    /// The monitor bounds from `GetMonitorInfoW`; `None` once the monitor is gone.
    Display(Option<ScreenRect>),
    /// The DWM extended frame bounds, `None` for a closed or minimized window,
    /// and whether the root window under the pointer is the source.
    Window {
        bounds: Option<ScreenRect>,
        over_source: bool,
    },
}

/// The pointer on the source canvas, whose top-left corner is the source's:
/// `(x, y, over_source)`, or `None` for a gap. WGC frames and these readings
/// are all physical pixels, so this is a plain offset at any DPI scale.
#[cfg(any(windows, test))]
fn locate(cursor: Option<(i32, i32)>, reading: SourceReading) -> Option<(i32, i32, bool)> {
    let cursor = cursor?;
    let (origin, over_source) = match reading {
        SourceReading::Display(bounds) => {
            let bounds = bounds?;
            (bounds, bounds.contains(cursor))
        }
        SourceReading::Window {
            bounds,
            over_source,
        } => (bounds?, over_source),
    };
    Some((cursor.0 - origin.left, cursor.1 - origin.top, over_source))
}

/// The successive states of the left, right and middle buttons
/// ([`cursor::LEFT`], [`cursor::RIGHT`], [`cursor::MIDDLE`]) since the poll
/// that saw `previous`, from their `GetAsyncKeyState` values: bit 15 is "held
/// now" and bit 0 "pressed since the last call". A press and release between
/// two polls becomes two states. The last state is the current one.
#[cfg(any(windows, test))]
fn button_steps(previous: u8, readings: [i16; 3]) -> Vec<u8> {
    let bits = [cursor::LEFT, cursor::RIGHT, cursor::MIDDLE];
    let sequences: Vec<&[bool]> = bits
        .iter()
        .zip(readings)
        .map(
            |(bit, reading)| match (previous & bit != 0, reading < 0, reading & 1 != 0) {
                (false, false, true) => &[true, false][..],
                (true, true, true) => &[false, true][..],
                (true, false, true) => &[false, true, false][..],
                (_, true, _) => &[true][..],
                (_, false, _) => &[false][..],
            },
        )
        .collect();
    let steps = sequences
        .iter()
        .map(|states| states.len())
        .max()
        .unwrap_or(1);
    let mut result: Vec<u8> = Vec::new();
    for step in 0..steps {
        let state = bits
            .iter()
            .zip(&sequences)
            .filter(|(_, states)| states[step.min(states.len() - 1)])
            .fold(0, |state, (bit, _)| state | bit);
        if result.last() != Some(&state) {
            result.push(state);
        }
    }
    result
}

/// Reads what a window or display source is, for [`source_identity`].
#[cfg(windows)]
mod identity {
    use super::pointer::monitor_bounds;
    use crate::models::SourceIdentity;
    use std::ffi::c_void;
    use windows_capture::{monitor::Monitor, window::Window};

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetClassNameW(window: *mut c_void, name: *mut u16, length: i32) -> i32;
        fn SetThreadDpiAwarenessContext(context: *mut c_void) -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, process_id: *mut u32) -> u32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    /// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`.
    const PER_MONITOR_AWARE_V2: isize = -4;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    /// 1970-01-01 as a `FILETIME`: 100 ns intervals since 1601-01-01.
    const UNIX_EPOCH_FILETIME: u64 = 116_444_736_000_000_000;

    /// Runs `read` with physical-pixel coordinates on this thread, then
    /// restores the thread's DPI awareness, so the app and `cue.exe` (which
    /// declares none) read the same bounds.
    fn in_physical_pixels<T>(read: impl FnOnce() -> T) -> T {
        let previous = unsafe { SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2 as *mut c_void) };
        let value = read();
        if !previous.is_null() {
            unsafe { SetThreadDpiAwarenessContext(previous) };
        }
        value
    }

    fn class_name(window: *mut c_void) -> String {
        let mut name = [0u16; 256];
        let length = unsafe { GetClassNameW(window, name.as_mut_ptr(), name.len() as i32) };
        String::from_utf16_lossy(&name[..length.clamp(0, name.len() as i32) as usize])
    }

    /// The process that owns `window`: its id, and when it was created in ms
    /// since the Unix epoch (`None` when the process cannot be opened).
    fn owner(window: *mut c_void) -> (Option<u32>, Option<u64>) {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, &mut pid) };
        if pid == 0 {
            return (None, None);
        }
        (Some(pid), process_created_ms(pid))
    }
    fn process_created_ms(pid: u32) -> Option<u64> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let [mut creation, mut exit, mut kernel, mut user] = [FileTime::default(); 4];
        let read =
            unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
        unsafe { CloseHandle(process) };
        if read == 0 {
            return None;
        }
        let FileTime { low, high } = creation;
        let ticks = (u64::from(high) << 32) | u64::from(low);
        Some(ticks.checked_sub(UNIX_EPOCH_FILETIME)? / 10_000)
    }

    pub(super) fn read(id: &str) -> Option<SourceIdentity> {
        if let Some(index) = id.strip_prefix("monitor:") {
            // The display `native_start` would capture for this id.
            let monitor = Monitor::from_index(index.parse().ok()?).ok()?;
            let device = monitor.device_name().ok()?;
            let bounds = in_physical_pixels(|| monitor_bounds(monitor.as_raw_hmonitor() as usize))?;
            return Some(SourceIdentity::Display {
                device,
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
            });
        }
        let handle: usize = id.strip_prefix("window:")?.parse().ok()?;
        // Only a window capture would accept: visible, top-level, not a tool window.
        let window = Window::enumerate()
            .ok()?
            .into_iter()
            .find(|window| window.as_raw_hwnd() as usize == handle)?;
        let (pid, process_created_ms) = owner(window.as_raw_hwnd());
        Some(SourceIdentity::Window {
            title: window.title().unwrap_or_default(),
            process: window.process_name().unwrap_or_default(),
            class: class_name(window.as_raw_hwnd()),
            pid,
            process_created_ms,
        })
    }
}

/// The Windows cursor sampler. [`crate::cursor`] documents what it records.
#[cfg(windows)]
mod pointer {
    use super::{button_steps, locate, ScreenRect, SourceReading};
    use crate::cursor::{self, CursorWriter, Header, Position, Sample};
    use std::{
        ffi::c_void,
        fs::File,
        io::BufWriter,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use windows_capture::monitor::Monitor;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    struct MonitorInfo {
        size: u32,
        monitor: ScreenRect,
        work: ScreenRect,
        flags: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetSystemMetrics(index: i32) -> i32;
        fn SetThreadDpiAwarenessContext(context: *mut c_void) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> i32;
        fn WindowFromPoint(point: Point) -> *mut c_void;
        fn GetAncestor(window: *mut c_void, flags: u32) -> *mut c_void;
        fn IsWindow(window: *mut c_void) -> i32;
        fn IsIconic(window: *mut c_void) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(
            window: *mut c_void,
            attribute: u32,
            value: *mut c_void,
            size: u32,
        ) -> i32;
    }
    /// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`.
    const PER_MONITOR_AWARE_V2: isize = -4;
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const GA_ROOT: u32 = 2;
    const SM_SWAPBUTTON: i32 = 23;
    const VK_LBUTTON: i32 = 0x01;
    const VK_RBUTTON: i32 = 0x02;
    const VK_MBUTTON: i32 = 0x04;

    /// Makes the calling thread per-monitor-v2 DPI aware, so window, monitor
    /// and pointer coordinates are physical pixels like the WGC frames,
    /// whatever the process's own awareness (`cue.exe` declares none).
    pub(super) fn physical_pixels() -> bool {
        !unsafe { SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2 as *mut c_void) }.is_null()
    }

    pub(super) fn monitor_bounds(monitor: usize) -> Option<ScreenRect> {
        let mut info = MonitorInfo {
            size: size_of::<MonitorInfo>() as u32,
            monitor: ScreenRect::default(),
            work: ScreenRect::default(),
            flags: 0,
        };
        (unsafe { GetMonitorInfoW(monitor as *mut c_void, &mut info) } != 0).then_some(info.monitor)
    }

    /// The visible bounds WGC captures, without the invisible resize borders
    /// of `GetWindowRect`. `None` for a closed or minimized window.
    fn window_bounds(window: *mut c_void) -> Option<ScreenRect> {
        let mut bounds = ScreenRect::default();
        let found = unsafe {
            IsWindow(window) != 0
                && IsIconic(window) == 0
                && DwmGetWindowAttribute(
                    window,
                    DWMWA_EXTENDED_FRAME_BOUNDS,
                    (&mut bounds as *mut ScreenRect).cast(),
                    size_of::<ScreenRect>() as u32,
                ) >= 0
        };
        found.then_some(bounds)
    }

    /// The logical left, right and middle buttons. `GetAsyncKeyState` reports
    /// physical buttons, so swapped buttons are swapped back.
    fn read_buttons() -> [i16; 3] {
        unsafe {
            let (left, right) = if GetSystemMetrics(SM_SWAPBUTTON) != 0 {
                (VK_RBUTTON, VK_LBUTTON)
            } else {
                (VK_LBUTTON, VK_RBUTTON)
            };
            [
                GetAsyncKeyState(left),
                GetAsyncKeyState(right),
                GetAsyncKeyState(VK_MBUTTON),
            ]
        }
    }

    /// A native capture source, as raw `HMONITOR` or `HWND` values.
    #[derive(Clone, Copy, Debug)]
    pub(super) enum Source {
        Display(usize),
        Window(usize),
    }
    impl Source {
        /// The source behind a `monitor:N` or `window:HWND` id, resolved
        /// exactly like `native_start`.
        fn from_id(id: &str) -> Option<Self> {
            if let Some(index) = id.strip_prefix("monitor:") {
                let monitor = Monitor::from_index(index.parse().ok()?).ok()?;
                return Some(Self::Display(monitor.as_raw_hmonitor() as usize));
            }
            id.strip_prefix("window:")?.parse().ok().map(Self::Window)
        }
        fn kind(self) -> &'static str {
            match self {
                Self::Display(_) => "display",
                Self::Window(_) => "window",
            }
        }
        fn read(self) -> Option<(i32, i32, bool)> {
            let mut point = Point::default();
            let cursor = (unsafe { GetCursorPos(&mut point) } != 0).then_some(point);
            let reading = match self {
                Self::Display(monitor) => SourceReading::Display(monitor_bounds(monitor)),
                Self::Window(window) => {
                    let window = window as *mut c_void;
                    let over_source = cursor.is_some_and(|point| unsafe {
                        let hit = WindowFromPoint(point);
                        !hit.is_null() && GetAncestor(hit, GA_ROOT) == window
                    });
                    SourceReading::Window {
                        bounds: window_bounds(window),
                        over_source,
                    }
                }
            };
            locate(cursor.map(|point| (point.x, point.y)), reading)
        }
    }

    /// The sampler thread of one take.
    pub(super) struct Sampler {
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<Result<u64, String>>>,
        error: Option<String>,
    }
    impl Sampler {
        /// Samples a native source into `folder`'s `cursor.jsonl`. `canvas` is
        /// the first frame's size.
        pub(super) fn start(
            source_id: &str,
            folder: &Path,
            epoch: Instant,
            canvas: Option<(u32, u32)>,
        ) -> Self {
            match Source::from_id(source_id) {
                Some(source) => Self::spawn(source, folder.join(cursor::FILE_NAME), epoch, canvas),
                None => Self {
                    stop: Arc::default(),
                    join: None,
                    error: Some(format!("Cursor tracking found no source for {source_id}")),
                },
            }
        }
        pub(super) fn spawn(
            source: Source,
            path: PathBuf,
            epoch: Instant,
            canvas: Option<(u32, u32)>,
        ) -> Self {
            let stop = Arc::new(AtomicBool::new(false));
            let flag = stop.clone();
            let spawned = thread::Builder::new()
                .name("cursor-sampler".into())
                .spawn(move || run(source, &path, epoch, canvas, &flag));
            let (join, error) = match spawned {
                Ok(join) => (Some(join), None),
                Err(e) => (None, Some(format!("Cursor tracking could not start: {e}"))),
            };
            Self { stop, join, error }
        }
        /// Stops and joins the thread, returning the lines it wrote.
        pub(super) fn stop(mut self) -> Result<u64, String> {
            self.stop.store(true, Ordering::Release);
            match self.join.take() {
                Some(join) => join
                    .join()
                    .map_err(|_| "Cursor sampler panicked".to_string())?,
                None => Err(self.error.take().unwrap_or_default()),
            }
        }
    }
    impl Drop for Sampler {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
        }
    }

    fn run(
        source: Source,
        path: &Path,
        epoch: Instant,
        canvas: Option<(u32, u32)>,
        stop: &AtomicBool,
    ) -> Result<u64, String> {
        if !physical_pixels() {
            return Err("Cursor tracking could not use per-monitor DPI awareness".into());
        }
        let failed = |e: std::io::Error| format!("Write {}: {e}", path.display());
        let file = File::create(path).map_err(failed)?;
        let mut writer =
            CursorWriter::new(BufWriter::new(file), &Header::new(source.kind(), canvas))
                .map_err(failed)?;
        // Buttons already held are the starting state, not presses. Reading
        // them also clears "pressed since the last call".
        let mut held = button_steps(0, read_buttons().map(|reading| reading & !1))
            .last()
            .copied()
            .unwrap_or(0);
        let interval = Duration::from_secs(1) / cursor::SAMPLE_HZ;
        let started = Instant::now();
        let mut flushed = started;
        let mut tick = 0u32;
        while !stop.load(Ordering::Acquire) {
            let t_ms = epoch.elapsed().as_millis() as u64;
            // Buttons are polled during gaps too, so a press there is not
            // reported once the pointer is back.
            let steps = button_steps(held, read_buttons());
            held = steps.last().copied().unwrap_or(held);
            match source.read() {
                Some((x, y, over_source)) => {
                    for buttons in steps {
                        let at = Position {
                            x,
                            y,
                            over_source,
                            buttons,
                        };
                        writer
                            .record(Sample { t_ms, at: Some(at) })
                            .map_err(failed)?;
                    }
                }
                None => writer.record(Sample { t_ms, at: None }).map_err(failed)?,
            }
            if flushed.elapsed() >= Duration::from_secs(1) {
                writer.flush().map_err(failed)?;
                flushed = Instant::now();
            }
            // A fixed schedule. Ticks missed while descheduled are skipped.
            tick += 1;
            let now = Instant::now();
            if started + interval * tick <= now {
                tick = (now.duration_since(started).as_nanos() / interval.as_nanos()) as u32 + 1;
            }
            thread::sleep((started + interval * tick).saturating_duration_since(now));
        }
        writer.flush().map_err(failed)?;
        Ok(writer.lines())
    }
}

/// Keys `finalize` adds to `capture-timing.json` for cursor tracking.
fn timing_extra(
    canvas: Option<(u32, u32)>,
    cursor: Option<Result<u64, String>>,
    touch_delay: Option<touch::Delay>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut extra = serde_json::Map::new();
    if let Some((width, height)) = canvas {
        extra.insert("canvasWidth".into(), width.into());
        extra.insert("canvasHeight".into(), height.into());
    }
    match cursor {
        Some(Ok(lines)) => {
            extra.insert("cursorLines".into(), lines.into());
        }
        Some(Err(error)) => {
            extra.insert("cursorError".into(), error.into());
        }
        None => (),
    }
    if let Some(delay) = touch_delay.and_then(|delay| serde_json::to_value(delay).ok()) {
        extra.insert("touchDelayMs".into(), delay);
    }
    extra
}

fn preview_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub fn preview(source_id: &str) -> Result<String, String> {
    let bytes = if let Some(serial) = source_id.strip_prefix("android:") {
        let out = adb(
            serial,
            &["exec-out", "screencap", "-p"],
            Duration::from_secs(8),
            &|| false,
        )?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        out.stdout
    } else if is_process_source(source_id) {
        let mut cmd = deps::command("ffmpeg")?;
        cmd.args(["-hide_banner", "-loglevel", "error"]);
        configure_video_input(&mut cmd, source_id, 30, "32M")?;
        cmd.args([
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ]);
        let out = output_with_timeout(cmd, Duration::from_secs(8))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        out.stdout
    } else {
        #[cfg(not(windows))]
        {
            return Err(unavailable_source());
        }
        #[cfg(windows)]
        {
            let path = std::env::temp_dir()
                .join(format!("cuereview-preview-{}.png", uuid::Uuid::new_v4()));
            let (tx, rx) = mpsc::sync_channel(1);
            let control = native_start(
                source_id,
                NativeFlags {
                    path: path.clone(),
                    fps: 15,
                    epoch: Instant::now(),
                    error: Arc::default(),
                    ready: tx,
                    preview: true,
                    preview_sink: None,
                },
            )?;
            let captured = rx
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| {
                    "Preview timed out. Restore the selected window and try again.".to_string()
                })
                .and_then(|r| r);
            let stopped = control.stop().map_err(|e| e.to_string());
            let bytes = captured
                .and(stopped)
                .and_then(|_| fs::read(&path).map_err(|e| e.to_string()));
            let _ = fs::remove_file(path);
            bytes?
        }
    };
    if bytes.is_empty() {
        return Err("Capture source returned an empty preview".into());
    }
    Ok(preview_url(&bytes))
}

type Wav = hound::WavWriter<BufWriter<File>>;
/// A pause between two packets longer than this is a real gap (a device glitch, or system audio
/// while nothing plays) and becomes silence; anything shorter is clock jitter or drift.
const AUDIO_GAP: f64 = 0.05;
/// A clock further than this from the wall clock means broken timestamps, not drift.
const AUDIO_MAX_DRIFT: f64 = 0.05;
/// Half the taps of the resampler's windowed-sinc filter.
const SINC_HALF: usize = 16;
/// Fractional positions per sample in the resampler's filter table.
const SINC_PHASES: usize = 1024;

/// Packets delivered without a real gap between them.
#[derive(Clone, Copy, Debug)]
struct AudioRun {
    /// Index in the file of the run's first sample.
    from: u64,
    /// Samples the device delivered in the run.
    len: u64,
    /// Take seconds, by the timestamps, at which the run starts and ends.
    start: f64,
    end: f64,
}

/// Writes one track. Samples go to the file back to back as the device delivers them: the
/// packets' capture timestamps only place each run of packets in the take, find real gaps and
/// measure the device's clock against the wall clock, which `finish` corrects in one resample.
/// Placing each packet by its timestamp would leave a short hole wherever the device runs slow,
/// heard as crackle.
struct AudioWriter {
    wav: Option<Wav>,
    path: PathBuf,
    rate: u32,
    /// Samples written, silence included.
    frames: u64,
    /// The first packet's capture time.
    origin: Option<cpal::StreamInstant>,
    /// Take seconds minus capture seconds since `origin`.
    offset: f64,
    /// The previous packet's capture seconds since `origin`, and its samples.
    last: Option<(f64, u64)>,
    runs: Vec<AudioRun>,
}
impl AudioWriter {
    fn new(wav: Wav, path: &Path, rate: u32) -> Self {
        Self {
            wav: Some(wav),
            path: path.to_owned(),
            rate,
            frames: 0,
            origin: None,
            offset: 0.0,
            last: None,
            runs: Vec::new(),
        }
    }
    fn pad(&mut self, target: u64) -> Result<(), hound::Error> {
        if let Some(wav) = self.wav.as_mut() {
            for _ in self.frames..target {
                wav.write_sample(0.0f32)?;
            }
        }
        self.frames = self.frames.max(target);
        Ok(())
    }
    fn block(
        &mut self,
        samples: &[f32],
        channels: usize,
        timestamp: cpal::InputStreamTimestamp,
        epoch: Instant,
        muted: bool,
    ) -> Result<f32, hound::Error> {
        let origin = *self.origin.get_or_insert(timestamp.capture);
        let at = timestamp
            .capture
            .duration_since(&origin)
            .unwrap_or_default()
            .as_secs_f64();
        let latency = timestamp
            .callback
            .duration_since(&timestamp.capture)
            .unwrap_or_default()
            .as_secs_f64();
        let start = (epoch.elapsed().as_secs_f64() - latency).max(0.0);
        self.packet(samples, channels, at, start, muted)
    }
    /// Writes one packet captured `at` seconds after the first; `start` is the first packet's
    /// time in the take. Returns the packet's RMS level.
    fn packet(
        &mut self,
        samples: &[f32],
        channels: usize,
        at: f64,
        start: f64,
        muted: bool,
    ) -> Result<f32, hound::Error> {
        let rate = self.rate as f64;
        let frames = samples.len() / channels;
        let gap = match self.last {
            None => {
                self.offset = start - at;
                true
            }
            Some((previous, length)) => at - previous - length as f64 / rate > AUDIO_GAP,
        };
        let begins = at + self.offset;
        if gap {
            // Silence up to the run's place by the wall clock, so live snapshots read the track
            // roughly in place; `finish` places every run exactly.
            self.pad((begins * rate).round().max(0.0) as u64)?;
            self.runs.push(AudioRun {
                from: self.frames,
                len: 0,
                start: begins,
                end: begins,
            });
        }
        let mut square = 0.0;
        if let Some(wav) = self.wav.as_mut() {
            for frame in samples.chunks_exact(channels) {
                let sample = if muted {
                    0.0
                } else {
                    frame.iter().copied().sum::<f32>() / channels as f32
                };
                wav.write_sample(sample)?;
                square += sample * sample;
            }
        }
        self.frames += frames as u64;
        self.last = Some((at, frames as u64));
        if let Some(run) = self.runs.last_mut() {
            run.len += frames as u64;
            run.end = begins + frames as f64 / rate;
        }
        Ok((square / frames.max(1) as f32).sqrt().min(1.0))
    }
    /// Wall-clock samples per delivered sample over the runs, by their timestamps. `None` with
    /// less than a second of audio, and for timestamps no real clock could produce.
    fn ratio(&self) -> Option<f64> {
        let delivered: u64 = self.runs.iter().map(|run| run.len).sum();
        if delivered < self.rate as u64 {
            return None;
        }
        let span: f64 = self.runs.iter().map(|run| run.end - run.start).sum();
        let ratio = span * self.rate as f64 / delivered as f64;
        ((ratio - 1.0).abs() <= AUDIO_MAX_DRIFT).then_some(ratio)
    }
    /// Ends the track exactly `duration` long: each run resampled by the device's measured clock
    /// error and placed at its start by the wall clock, silence between the runs and after the
    /// last one.
    fn finish(&mut self, duration: Duration) -> Result<(), String> {
        let rate = self.rate as f64;
        let total = (duration.as_secs_f64() * rate).round() as u64;
        let ratio = self.ratio();
        if ratio.is_none() && self.runs.len() <= 1 && self.frames <= total {
            self.pad(total).map_err(|e| e.to_string())?;
            if let Some(wav) = self.wav.take() {
                wav.finalize().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        let ratio = ratio.unwrap_or(1.0);
        let Some(wav) = self.wav.take() else {
            return Ok(());
        };
        let spec = wav.spec();
        wav.finalize().map_err(|e| e.to_string())?;
        let part = self.path.with_extension("wav.part");
        // A failed rewrite (a full disk, say) leaves the track as recorded and no part file.
        if let Err(e) = self
            .rewrite(&part, spec, total, ratio)
            .and_then(|()| fs::rename(&part, &self.path).map_err(|e| e.to_string()))
        {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
        self.frames = total;
        Ok(())
    }
    /// Writes the finished track to `part`: each run resampled by `ratio` and placed at its start,
    /// silence around them, `total` samples in all.
    fn rewrite(
        &self,
        part: &Path,
        spec: hound::WavSpec,
        total: u64,
        ratio: f64,
    ) -> Result<(), String> {
        let rate = self.rate as f64;
        let table = sinc_table(ratio.min(1.0));
        {
            let mut reader = hound::WavReader::open(&self.path).map_err(|e| e.to_string())?;
            let mut input = reader
                .samples::<f32>()
                .map(|sample| sample.map_err(|e| e.to_string()));
            let mut output = hound::WavWriter::create(part, spec).map_err(|e| e.to_string())?;
            let mut write = |sample: f32| output.write_sample(sample).map_err(|e| e.to_string());
            let places: Vec<u64> = self
                .runs
                .iter()
                .map(|run| ((run.start * rate).round().max(0.0) as u64).min(total))
                .collect();
            let (mut written, mut read) = (0u64, 0u64);
            for (index, run) in self.runs.iter().enumerate() {
                let place = places[index].max(written);
                while written < place {
                    write(0.0)?;
                    written += 1;
                }
                while read < run.from {
                    input.next().transpose()?;
                    read += 1;
                }
                let until = places.get(index + 1).copied().unwrap_or(total).max(written);
                let count = ((run.len as f64 * ratio).round() as u64).min(until - written);
                let mut samples = (&mut input).take(run.len as usize);
                resample(&mut samples, run.len, ratio, &table, count, &mut write)?;
                for sample in samples {
                    sample?;
                }
                read += run.len;
                written += count;
            }
            while written < total {
                write(0.0)?;
                written += 1;
            }
            output.finalize().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// The windowed-sinc filter table: for each fractional position, the weights of the
/// `2 * SINC_HALF` nearest input samples, low-passed at `cutoff` of the input's Nyquist frequency,
/// Blackman-windowed and each row normalised to unit gain.
fn sinc_table(cutoff: f64) -> Vec<f32> {
    use std::f64::consts::PI;
    let taps = 2 * SINC_HALF;
    let mut table = vec![0f32; (SINC_PHASES + 1) * taps];
    for (phase, row) in table.chunks_exact_mut(taps).enumerate() {
        let fraction = phase as f64 / SINC_PHASES as f64;
        let weights: Vec<f64> = (0..taps)
            .map(|tap| {
                let t = fraction + (SINC_HALF - 1) as f64 - tap as f64;
                let sinc = if t == 0.0 {
                    cutoff
                } else {
                    (PI * cutoff * t).sin() / (PI * t)
                };
                let u = PI * t / SINC_HALF as f64;
                sinc * (0.42 + 0.5 * u.cos() + 0.08 * (2.0 * u).cos())
            })
            .collect();
        let sum: f64 = weights.iter().sum();
        for (slot, weight) in row.iter_mut().zip(weights) {
            *slot = (weight / sum) as f32;
        }
    }
    table
}

/// Writes `count` samples of `input` (`len` samples long) resampled by `ratio` output samples
/// per input sample through `table` (`sinc_table(ratio.min(1.0))`), holding only the filter's
/// window of input in memory.
fn resample(
    input: &mut impl Iterator<Item = Result<f32, String>>,
    len: u64,
    ratio: f64,
    table: &[f32],
    count: u64,
    write: &mut impl FnMut(f32) -> Result<(), String>,
) -> Result<(), String> {
    let taps = 2 * SINC_HALF;
    let mut window = std::collections::VecDeque::with_capacity(taps + 1);
    let (mut base, mut read) = (0i64, 0u64);
    for index in 0..count {
        let position = index as f64 / ratio;
        let whole = position.floor();
        let phase = ((position - whole) * SINC_PHASES as f64).round() as usize;
        let first = whole as i64 - SINC_HALF as i64 + 1;
        while base + (window.len() as i64) < first + taps as i64 && read < len {
            window.push_back(input.next().transpose()?.unwrap_or(0.0));
            read += 1;
        }
        while base < first && !window.is_empty() {
            window.pop_front();
            base += 1;
        }
        let row = &table[phase * taps..(phase + 1) * taps];
        let mut sample = 0.0f32;
        for (tap, weight) in row.iter().enumerate() {
            let at = first + tap as i64;
            if at >= base && ((at - base) as usize) < window.len() {
                sample += window[(at - base) as usize] * weight;
            }
        }
        write(sample)?;
    }
    Ok(())
}

/// Keeps the loudest packet level until the status reads it, so a word between two reads still
/// shows. A non-negative `f32`'s bits order as the number does.
fn hold_level(level: &AtomicU32, rms: f32) {
    level.fetch_max(rms.max(0.0).to_bits(), Ordering::Relaxed);
}
/// The loudest level since the last read, and a fresh start for the next.
fn take_level(level: &AtomicU32) -> f32 {
    f32::from_bits(level.swap(0, Ordering::Relaxed))
}

struct AudioTrack {
    stream: cpal::Stream,
    writer: Arc<Mutex<AudioWriter>>,
    path: PathBuf,
}
/// Copies the live track into `target`: from `from_ms` (at most 60 s of it),
/// or the latest 30 s when `from_ms` is `None`. Returns the copy's bounds in
/// ms from the track's start.
fn snapshot_track(
    path: &Path,
    writer: &Arc<Mutex<AudioWriter>>,
    target: &Path,
    from_ms: Option<u64>,
) -> Result<(u64, u64), String> {
    if path == target {
        return Err("Audio snapshots must use a separate file".into());
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut reader = loop {
        match writer.try_lock() {
            Ok(mut state) => {
                state
                    .wav
                    .as_mut()
                    .ok_or("Audio recording has stopped")?
                    .flush()
                    .map_err(|e| e.to_string())?;
                break hound::WavReader::open(path).map_err(|e| e.to_string())?;
            }
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(2))
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err("Audio snapshot is busy; retry next update".into())
            }
            Err(_) => return Err("Audio writer failed".into()),
        }
    };
    let spec = reader.spec();
    let end = reader.duration();
    if end == 0 {
        return Err("Waiting for audio samples".into());
    }
    let rate = spec.sample_rate as u64;
    let (start, end) = match from_ms {
        Some(from_ms) => {
            let start = (from_ms * rate / 1000).min(end as u64) as u32;
            (
                start,
                end.min(start.saturating_add(spec.sample_rate.saturating_mul(60))),
            )
        }
        None => (end.saturating_sub(spec.sample_rate.saturating_mul(30)), end),
    };
    // Existing samples are append-only. Hound has already captured a finite header length.
    reader.seek(start).map_err(|e| e.to_string())?;
    let mut output = hound::WavWriter::create(target, spec).map_err(|e| e.to_string())?;
    for sample in reader.samples::<f32>().take((end - start) as usize) {
        output
            .write_sample(sample.map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    output.finalize().map_err(|e| e.to_string())?;
    Ok((
        start as u64 * 1000 / spec.sample_rate as u64,
        end as u64 * 1000 / spec.sample_rate as u64,
    ))
}
fn audio_track(
    device: cpal::Device,
    path: &Path,
    loopback: bool,
    epoch: Instant,
    muted: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    error: SharedError,
) -> Result<AudioTrack, String> {
    let supported = if loopback {
        device.default_output_config()
    } else {
        device.default_input_config()
    }
    .map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    let wav = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: config.sample_rate.0,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .map_err(|e| e.to_string())?;
    let writer = Arc::new(Mutex::new(AudioWriter::new(
        wav,
        path,
        config.sample_rate.0,
    )));
    let writer2 = writer.clone();
    let error2 = error.clone();
    let input = move |data: &[f32], info: &cpal::InputCallbackInfo| {
        if let Ok(mut w) = writer2.lock() {
            match w.block(
                data,
                channels,
                info.timestamp(),
                epoch,
                !loopback && muted.load(Ordering::Relaxed),
            ) {
                Ok(rms) => hold_level(&level, rms),
                Err(e) => fail(&error, format!("Audio write failed: {e}")),
            }
        }
    };
    let on_error = move |e| fail(&error2, format!("Audio device failed: {e}"));
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(&config, input, on_error, None),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], info| {
                let samples: Vec<f32> = data.iter().map(|s| *s as f32 / 32768.0).collect();
                input(&samples, info);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], info| {
                let samples: Vec<f32> = data
                    .iter()
                    .map(|s| (*s as f32 - 32768.0) / 32768.0)
                    .collect();
                input(&samples, info);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::U8 => device.build_input_stream(
            &config,
            move |data: &[u8], info| {
                let samples: Vec<f32> = data.iter().map(|s| (*s as f32 - 128.0) / 128.0).collect();
                input(&samples, info);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            &config,
            move |data: &[i32], info| {
                let samples: Vec<f32> = data.iter().map(|s| *s as f32 / 2147483648.0).collect();
                input(&samples, info);
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I64 => device.build_input_stream(
            &config,
            move |data: &[i64], info| {
                let samples: Vec<f32> = data
                    .iter()
                    .map(|s| (*s as f64 / 9223372036854775808.0) as f32)
                    .collect();
                input(&samples, info);
            },
            on_error,
            None,
        ),
        _ => return Err(format!("Unsupported audio sample format: {format:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(AudioTrack {
        stream,
        writer,
        path: path.to_owned(),
    })
}

struct AudioWorker {
    stop: mpsc::Sender<Duration>,
    join: Option<JoinHandle<Result<(), String>>>,
    snapshot_source: Option<(PathBuf, Arc<Mutex<AudioWriter>>)>,
}
impl AudioWorker {
    fn start(
        config: &CaptureConfig,
        folder: &Path,
        epoch: Instant,
        muted: Arc<AtomicBool>,
        level: Arc<AtomicU32>,
        error: SharedError,
    ) -> Result<Self, String> {
        let config = config.clone();
        let folder = folder.to_owned();
        let (stop, rx) = mpsc::channel();
        let (ready, ready_rx) = mpsc::sync_channel(1);
        let join = thread::spawn(move || {
            let initialize = || -> Result<Vec<AudioTrack>, String> {
                let host = cpal::default_host();
                let mut tracks = Vec::new();
                if let Some(id) = config.microphone_id.as_deref() {
                    let device = if id == "default" {
                        host.default_input_device()
                    } else {
                        host.input_devices()
                            .map_err(|e| e.to_string())?
                            .find(|d| d.name().ok().as_deref() == Some(id))
                    }
                    .ok_or("Selected microphone is unavailable")?;
                    tracks.push(audio_track(
                        device,
                        &folder.join("mic.wav"),
                        false,
                        epoch,
                        muted.clone(),
                        level.clone(),
                        error.clone(),
                    )?);
                }
                if config.system_audio && !config.source_id.starts_with("android:") {
                    let device = host
                        .default_output_device()
                        .ok_or("No default playback device for system audio")?;
                    // WASAPI transparently enables loopback for an output device used as input.
                    tracks.push(audio_track(
                        device,
                        &folder.join("system.wav"),
                        true,
                        epoch,
                        muted.clone(),
                        if config.microphone_id.is_none() {
                            level.clone()
                        } else {
                            Arc::new(AtomicU32::new(0))
                        },
                        error.clone(),
                    )?);
                }
                Ok(tracks)
            };
            let tracks = match initialize() {
                Ok(t) => {
                    let _ = ready.send(Ok(t
                        .first()
                        .map(|track| (track.path.clone(), track.writer.clone()))));
                    t
                }
                Err(e) => {
                    let _ = ready.send(Err(e.clone()));
                    return Err(e);
                }
            };
            let duration = rx.recv().unwrap_or_else(|_| epoch.elapsed());
            let mut failures = Vec::new();
            for track in tracks {
                drop(track.stream);
                if let Ok(mut writer) = track.writer.lock() {
                    if let Err(e) = writer.finish(duration) {
                        failures.push(e);
                    }
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        });
        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(snapshot_source)) => Ok(Self {
                stop,
                join: Some(join),
                snapshot_source,
            }),
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(_) => {
                drop(stop);
                Err("Audio initialization timed out".into())
            }
        }
    }
    fn stop(&mut self, duration: Duration) -> Result<(), String> {
        let _ = self.stop.send(duration);
        self.join
            .take()
            .map(|j| {
                j.join()
                    .map_err(|_| "Audio worker panicked".to_string())
                    .and_then(|r| r)
            })
            .unwrap_or(Ok(()))
    }
}

enum VideoCapture {
    #[cfg(windows)]
    Native(CaptureControl<NativeCapture, String>),
    Process {
        child: Mutex<Child>,
        input: PathBuf,
        window_title: Option<String>,
        delay: f64,
        /// scrcpy's first decoded frame size; `None` for FFmpeg captures.
        canvas: Option<(u32, u32)>,
    },
}
pub struct ActiveCapture {
    epoch: Instant,
    stopped: Option<Duration>,
    folder: PathBuf,
    video: Option<VideoCapture>,
    audio: Option<AudioWorker>,
    muted: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    error: SharedError,
    fps: u32,
    device_audio: bool,
    /// The cursor sampler of a native display or window capture.
    #[cfg(windows)]
    cursor: Option<pointer::Sampler>,
    /// The touch reader of an Android device capture.
    touch: Option<touch::Reader>,
}
pub fn start(config: CaptureConfig, folder: &Path) -> Result<ActiveCapture, String> {
    start_muted(config, folder, false)
}
pub fn start_muted(
    config: CaptureConfig,
    folder: &Path,
    initial_muted: bool,
) -> Result<ActiveCapture, String> {
    if config.fps == 0 || config.fps > 60 {
        return Err("Frame rate must be between 1 and 60".into());
    }
    #[cfg(not(windows))]
    if config.system_audio && !config.source_id.starts_with("android:") {
        return Err("Desktop system audio is not supported on this platform yet. Turn off system audio and select a microphone. Android/Quest device audio remains available.".into());
    }
    deps::tool("ffmpeg")?;
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let mut capture = ActiveCapture {
        epoch: Instant::now(),
        stopped: None,
        folder: folder.to_owned(),
        video: None,
        audio: None,
        muted: Arc::new(AtomicBool::new(initial_muted)),
        level: Arc::new(AtomicU32::new(0)),
        error: Arc::default(),
        fps: config.fps,
        device_audio: config.system_audio && config.source_id.starts_with("android:"),
        #[cfg(windows)]
        cursor: None,
        touch: None,
    };
    capture.audio = Some(AudioWorker::start(
        &config,
        folder,
        capture.epoch,
        capture.muted.clone(),
        capture.level.clone(),
        capture.error.clone(),
    )?);
    // Touches are read from the start, beside scrcpy, so getevent already
    // runs when the first frame arrives; the reader learns the canvas then.
    let reader = config
        .source_id
        .strip_prefix("android:")
        .map(|serial| touch::Reader::start(serial, folder, capture.epoch));
    let result = (|| {
        if let Some(serial) = config.source_id.strip_prefix("android:") {
            let input = folder.join("native-video.mkv");
            // Matroska remains recoverable if a device disconnects or scrcpy must be terminated.
            let log = File::create(folder.join("capture.log")).map_err(|e| e.to_string())?;
            let window_title = format!("CueReview capture {}", uuid::Uuid::new_v4());
            let mut cmd = deps::command("scrcpy")?;
            cmd.args([
                "--serial",
                serial,
                "--no-audio-playback",
                "--no-control",
                "--window-borderless",
                "--window-x=-10000",
                "--window-y=-10000",
                "--window-width=64",
                "--window-height=64",
                "--window-title",
                &window_title,
                "--max-fps",
                &config.fps.to_string(),
            ]);
            if config.system_audio {
                cmd.args(["--audio-codec=aac", "--require-audio"]);
            } else {
                cmd.arg("--no-audio");
            }
            let child = cmd
                .arg("--record")
                .arg(&input)
                .stdin(Stdio::null())
                .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
                .stderr(Stdio::from(log))
                .spawn()
                .map_err(|e| e.to_string())?;
            ready_process(child, input, Some(window_title), capture.epoch)
        } else if is_process_source(&config.source_id) {
            let input = folder.join("native-video.mkv");
            let log = File::create(folder.join("capture.log")).map_err(|e| e.to_string())?;
            let mut command = deps::command("ffmpeg")?;
            command.args(["-y", "-hide_banner", "-loglevel", "warning"]);
            configure_video_input(&mut command, &config.source_id, config.fps, "256M")?;
            configure_recording_output(&mut command, config.fps);
            let child = command
                .arg(&input)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log))
                .spawn()
                .map_err(|e| e.to_string())?;
            ready_process(child, input, None, capture.epoch)
                .map_err(|error| recording_startup_error(&config.source_id, error))
        } else {
            #[cfg(not(windows))]
            {
                Err(unavailable_source())
            }
            #[cfg(windows)]
            {
                let (ready, rx) = mpsc::sync_channel(1);
                let control = native_start(
                    &config.source_id,
                    NativeFlags {
                        path: folder.join("native-video.mp4"),
                        fps: config.fps,
                        epoch: capture.epoch,
                        error: capture.error.clone(),
                        ready,
                        preview: false,
                        preview_sink: None,
                    },
                )?;
                let initialized = rx
                    .recv_timeout(Duration::from_secs(8))
                    .map_err(|_| {
                        "No video frames arrived. Restore the selected window and try again."
                            .to_string()
                    })
                    .and_then(|r| r);
                if let Err(e) = initialized {
                    let _ = control.stop();
                    return Err(e);
                }
                Ok(VideoCapture::Native(control))
            }
        }
    })();
    match result {
        Ok(video) => {
            // The pointer is sampled once video is ready, on the same epoch.
            #[cfg(windows)]
            if let VideoCapture::Native(control) = &video {
                let canvas = control.callback().lock().canvas;
                capture.cursor = Some(pointer::Sampler::start(
                    &config.source_id,
                    folder,
                    capture.epoch,
                    canvas,
                ));
            }
            if let (Some(reader), VideoCapture::Process { canvas, .. }) = (reader, &video) {
                reader.set_canvas(*canvas);
                capture.touch = Some(reader);
            }
            capture.video = Some(video);
            Ok(capture)
        }
        // A reader dropped here stops before it writes anything.
        Err(e) => {
            if let Some(mut audio) = capture.audio.take() {
                let _ = audio.stop(capture.epoch.elapsed());
            }
            Err(e)
        }
    }
}

impl ActiveCapture {
    /// A consistent, at-most-30-second mono float WAV, preferring microphone audio.
    /// Returns the included sample range on the session clock as (start_ms, end_ms).
    /// Only flush + header parsing hold the callback mutex; sample copying does not.
    pub fn snapshot_audio(&self, target: &Path) -> Result<(u64, u64), String> {
        let (path, writer) = self
            .audio
            .as_ref()
            .and_then(|a| a.snapshot_source.as_ref())
            .ok_or("No live microphone or desktop audio track is available")?;
        snapshot_track(path, writer, target, None)
    }
    /// Copies the live track from `from_ms` (at most 60 s) into `target`, for
    /// the stretches of [`crate::stretches`]. Returns the bounds and the
    /// track's file name, for example `mic.wav`.
    pub fn snapshot_audio_from(
        &self,
        from_ms: u64,
        target: &Path,
    ) -> Result<(u64, u64, String), String> {
        let (path, writer) = self
            .audio
            .as_ref()
            .and_then(|a| a.snapshot_source.as_ref())
            .ok_or("No live microphone or desktop audio track is available")?;
        let (start, end) = snapshot_track(path, writer, target, Some(from_ms))?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok((start, end, name))
    }
    pub fn elapsed_ms(&self) -> u64 {
        self.stopped
            .unwrap_or_else(|| self.epoch.elapsed())
            .as_millis() as u64
    }
    /// The loudest microphone level since the last call, which starts the next hold: the status
    /// poll is its only caller.
    pub fn take_audio_level(&self) -> f32 {
        take_level(&self.level)
    }
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
    pub fn error(&self) -> Option<String> {
        if self.stopped.is_none() {
            match self.video.as_ref() {
                #[cfg(windows)]
                Some(VideoCapture::Native(control)) if control.is_finished() => {
                    fail(&self.error, "Native capture stopped unexpectedly")
                }
                Some(VideoCapture::Process { child, .. }) => {
                    if let Ok(mut child) = child.lock() {
                        if let Ok(Some(status)) = child.try_wait() {
                            fail(
                                &self.error,
                                format!("Video capture exited: {status}; see capture.log"),
                            );
                        }
                    }
                }
                _ => (),
            }
        }
        self.error.lock().ok().and_then(|e| e.clone())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        if self.stopped.is_some() {
            return self.error().map_or(Ok(()), Err);
        }
        // Stop the pointer first, so every sample precedes the recorded duration.
        #[cfg(windows)]
        let cursor = self.cursor.take().map(pointer::Sampler::stop);
        #[cfg(not(windows))]
        let cursor = None;
        let (cursor, touch_delay) = match self.touch.take().and_then(touch::Reader::stop) {
            Some(Ok(outcome)) => (Some(Ok(outcome.lines)), outcome.delay),
            Some(Err(error)) => (Some(Err(error)), None),
            None => (cursor, None),
        };
        let duration = self.epoch.elapsed();
        self.stopped = Some(duration);
        let mut failures = Vec::new();
        let mut delay = 0.0;
        let mut device_capture = false;
        if let Some(mut audio) = self.audio.take() {
            if let Err(e) = audio.stop(duration) {
                failures.push(e);
            }
        }
        let (input, canvas) = match self.video.take() {
            #[cfg(windows)]
            Some(VideoCapture::Native(control)) => {
                let handler = control.callback();
                if let Err(e) = control.stop() {
                    failures.push(e.to_string());
                }
                let mut handler = handler.lock();
                delay = handler.first_frame.unwrap_or(0.0);
                if let Err(e) = handler.finish() {
                    failures.push(e);
                }
                (self.folder.join("native-video.mp4"), handler.canvas)
            }
            Some(VideoCapture::Process {
                child,
                input,
                window_title,
                delay: process_delay,
                canvas,
            }) => {
                device_capture = window_title.is_some();
                delay = process_delay;
                let mut child = child.into_inner().unwrap_or_else(|e| e.into_inner());
                #[cfg(windows)]
                if let Some(title) = window_title {
                    if let Ok(window) = Window::from_name(&title) {
                        #[link(name = "user32")]
                        extern "system" {
                            fn PostMessageW(
                                hwnd: *mut std::ffi::c_void,
                                message: u32,
                                wparam: usize,
                                lparam: isize,
                            ) -> i32;
                        }
                        // SDL handles WM_CLOSE as a normal quit, flushing its recording.
                        unsafe {
                            PostMessageW(window.as_raw_hwnd(), 0x0010, 0, 0);
                        }
                    }
                } else {
                    if let Some(mut stdin) = child.stdin.take() {
                        let _ = stdin.write_all(b"q\n");
                    }
                }
                #[cfg(unix)]
                if device_capture {
                    // scrcpy flushes its recorder on SIGINT; kill() would discard the trailer.
                    match std::process::Command::new("/bin/kill")
                        .args(["-INT", &child.id().to_string()]).status() {
                        Ok(status) if status.success() => (),
                        _ => failures.push("Could not request a clean device stop; original tracks will be retained".into()),
                    }
                } else if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(b"q\n");
                }
                let deadline = Instant::now() + Duration::from_secs(8);
                loop {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            if !status.success() {
                                failures.push(format!(
                                    "Video capture exited: {status}; see capture.log"
                                ));
                            }
                            break;
                        }
                        Ok(None) if Instant::now() < deadline => {
                            thread::sleep(Duration::from_millis(25))
                        }
                        _ => {
                            let _ = child.kill();
                            let _ = child.wait();
                            failures.push("Video capture did not close cleanly; original tracks retained for recovery".into());
                            break;
                        }
                    }
                }
                (input, canvas)
            }
            None => (self.folder.join("native-video.mp4"), None),
        };
        if let Err(e) = finalize(
            &self.folder,
            &input,
            duration,
            delay,
            self.fps,
            self.device_audio,
            device_capture,
            timing_extra(canvas, cursor, touch_delay),
        ) {
            failures.push(e);
        }
        if let Some(e) = self.error() {
            failures.push(e);
        }
        if failures.is_empty() {
            // Finalization has verified the output streams and timeline. The native video
            // is now redundant; keep the lossless audio tracks for transcription/retry.
            // Cleanup failure must not turn a usable recording into a failed recording.
            if let Err(error) = remove_native_intermediate(&self.folder, &input) {
                let _ = fs::write(self.folder.join("cleanup.log"), error);
            }
            Ok(())
        } else {
            let message = failures.join("; ");
            fail(&self.error, &message);
            Err(message)
        }
    }
}
impl Drop for ActiveCapture {
    fn drop(&mut self) {
        if self.stopped.is_none() {
            if self.video.is_some() {
                let _ = self.stop();
            } else if let Some(mut audio) = self.audio.take() {
                let _ = audio.stop(self.epoch.elapsed());
            }
        }
        #[cfg(windows)]
        if let Some(cursor) = self.cursor.take() {
            let _ = cursor.stop();
        }
        if let Some(touch) = self.touch.take() {
            let _ = touch.stop();
        }
    }
}

pub(crate) fn output_with_timeout(
    command: std::process::Command,
    timeout: Duration,
) -> Result<Output, String> {
    output_until(command, timeout, &|| false)
}

/// [`output_with_timeout`], killing the command as soon as `cancelled`
/// returns true (checked every 20 ms).
pub(crate) fn output_until(
    mut command: std::process::Command,
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |mut pipe: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut data = Vec::new();
            pipe.read_to_end(&mut data).map(|_| data)
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let mut stopped = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancelled() => {
                stopped = true;
                let _ = child.kill();
                break child.wait().map_err(|e| e.to_string())?;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().map_err(|e| e.to_string())?;
            }
        }
    };
    let stdout = out
        .join()
        .map_err(|_| "Failed reading capture output")?
        .map_err(|e| e.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "Failed reading capture errors")?
        .map_err(|e| e.to_string())?;
    if timed_out {
        return Err(format!(
            "Capture command timed out after {} seconds",
            timeout.as_secs()
        ));
    }
    if stopped {
        return Err("Capture command was stopped".into());
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// `adb -s <serial> <args>`, killed after `timeout` or once `cancelled`
/// returns true.
pub(crate) fn adb(
    serial: &str,
    args: &[&str],
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
) -> Result<Output, String> {
    let mut command = deps::command("adb")?;
    command.args(["-s", serial]).args(args);
    output_until(command, timeout, cancelled)
}
fn ffmpeg(command: std::process::Command) -> Result<(), String> {
    let out = output_with_timeout(command, Duration::from_secs(3600))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "FFmpeg failed: {}",
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .rev()
                .take(2400)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ))
    }
}
/// Keep the original capture failure and add recovery for the selected macOS
/// input without assuming that permission denial caused it.
fn recording_startup_error(source: &str, error: String) -> String {
    if source.starts_with("avfoundation:") {
        format!("{error}\nCheck Camera or Screen Recording access in macOS System Settings, close other apps using the source, then retry.")
    } else {
        error
    }
}

/// Flush encoded packets so Matroska/AVIO buffering cannot hide healthy output
/// from `ready_process`. Shared with synthetic startup checks.
fn configure_recording_output(command: &mut std::process::Command, fps: u32) {
    command.args([
        "-an",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-r",
        &fps.to_string(),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-flush_packets",
        "1",
    ]);
}

fn ready_process(
    mut child: Child,
    input: PathBuf,
    window_title: Option<String>,
    epoch: Instant,
) -> Result<VideoCapture, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut decoded = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "Capture could not start ({status}); see capture.log"
                ))
            }
            Ok(None) => (),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
        // The delay and the canvas, latched together: a later unreadable log
        // must not lose the canvas while the window is awaited below.
        let ready = if window_title.is_some() {
            let log = fs::read_to_string(input.with_file_name("capture.log")).unwrap_or_default();
            latch_scrcpy_frame(&log, &mut decoded, epoch.elapsed().as_secs_f64())
                .map(|(delay, canvas)| (delay, Some(canvas)))
        } else {
            input
                .metadata()
                .ok()
                .filter(|m| m.len() >= 512)
                .map(|_| (epoch.elapsed().as_secs_f64(), None))
        };
        if let Some((delay, canvas)) = ready {
            #[cfg(windows)]
            if let Some(title) = window_title.as_ref() {
                if let Ok(window) = Window::from_name(title) {
                    #[link(name = "user32")]
                    extern "system" {
                        fn ShowWindow(hwnd: *mut std::ffi::c_void, command: i32) -> i32;
                    }
                    unsafe {
                        ShowWindow(window.as_raw_hwnd(), 0);
                    }
                } else {
                    if Instant::now() < deadline {
                        thread::sleep(Duration::from_millis(30));
                        continue;
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "The device capture window did not initialize; see capture.log".into(),
                    );
                }
            }
            return Ok(VideoCapture::Process {
                child: Mutex::new(child),
                input,
                window_title,
                delay,
                canvas,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Capture produced no frames; see capture.log".into());
        }
        thread::sleep(Duration::from_millis(30));
    }
}
/// The size of scrcpy's first decoded frame: its first complete
/// `INFO: Texture: WxH` line. That is the recorded frame size, the canvas.
fn scrcpy_texture(log: &str) -> Option<(u32, u32)> {
    log.split_inclusive('\n')
        .filter(|line| line.ends_with('\n'))
        .find_map(|line| {
            let size = line.trim().strip_prefix("INFO: Texture: ")?;
            let (width, height) = size.split_once('x')?;
            let positive = |n: &str| n.parse::<u32>().ok().filter(|n| *n > 0);
            Some((positive(width)?, positive(height)?))
        })
}
/// When scrcpy's first frame was decoded, and its size: `(now, canvas)` from
/// the first call whose `log` has the texture line, unchanged after that.
fn latch_scrcpy_frame(
    log: &str,
    latched: &mut Option<(f64, (u32, u32))>,
    now: f64,
) -> Option<(f64, (u32, u32))> {
    // v4.1 emits this unbuffered line when uploading its first decoded frame.
    // Window creation and Matroska flush timing do not identify that frame.
    if latched.is_none() {
        *latched = scrcpy_texture(log).map(|canvas| (now, canvas));
    }
    *latched
}
fn stream_starts(info: &serde_json::Value) -> Result<(f64, f64), String> {
    let streams = info["streams"]
        .as_array()
        .ok_or("Device recording has no stream metadata")?;
    let start = |kind| {
        streams
            .iter()
            .find(|stream| stream["codec_type"].as_str() == Some(kind))
            .and_then(|stream| stream["start_time"].as_str())
            .and_then(|time| time.parse::<f64>().ok())
            .filter(|time| time.is_finite())
            .ok_or_else(|| format!("Device recording has no valid first {kind} timestamp"))
    };
    Ok((start("video")?, start("audio")?))
}
fn device_audio_filter(video_host_start: f64, video_pts: f64, audio_pts: f64) -> (f64, String) {
    let audio_host_start = video_host_start + audio_pts - video_pts;
    let filter = if audio_host_start >= 0.0 {
        format!(
            "asetpts=PTS-STARTPTS,adelay={:.6}:all=1,apad",
            audio_host_start * 1000.0
        )
    } else {
        format!(
            "atrim=start={:.6},asetpts=PTS-STARTPTS,apad",
            -audio_host_start
        )
    };
    (audio_host_start, filter)
}
fn mapped_device_end(
    info: &serde_json::Value,
    video_host_start: f64,
    fps: u32,
) -> Result<f64, String> {
    let streams = info["streams"]
        .as_array()
        .ok_or("Device recording has no streams")?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or("Device recording has no video stream")?;
    let video_index = video["index"]
        .as_u64()
        .ok_or("Device video has no stream index")?;
    let video_start = video["start_time"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .ok_or("Device video has no valid first timestamp")?;
    let mut end = video_host_start;
    let mut video_packet = false;
    for packet in info["packets"]
        .as_array()
        .ok_or("Device recording has no packet timestamps")?
    {
        let Some(index) = packet["stream_index"].as_u64() else {
            continue;
        };
        let Some(stream) = streams
            .iter()
            .find(|stream| stream["index"].as_u64() == Some(index))
        else {
            continue;
        };
        if !matches!(stream["codec_type"].as_str(), Some("video" | "audio")) {
            continue;
        }
        let Some(pts) = packet["pts_time"]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
        else {
            continue;
        };
        let duration = packet["duration_time"]
            .as_str()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .unwrap_or(0.0);
        let minimum = if index == video_index {
            video_packet = true;
            1.0 / fps as f64
        } else {
            0.0
        };
        end = end.max(video_host_start + pts - video_start + duration.max(minimum));
    }
    if !video_packet {
        return Err("Device recording has no usable video packet timestamps".into());
    }
    Ok(end)
}
fn metadata_device_end(info: &serde_json::Value, video_host_start: f64, fps: u32) -> Option<f64> {
    let number = |value: &serde_json::Value| {
        value
            .as_str()?
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
    };
    let start = number(&info["format"]["start_time"])?;
    let duration = number(&info["format"]["duration"])?;
    let video = info["streams"]
        .as_array()?
        .iter()
        .find(|stream| stream["codec_type"] == "video")?;
    let video_start = number(&video["start_time"])?;
    if duration <= 0.0 || start + duration <= video_start {
        return None;
    }
    // A finalized scrcpy Matroska trailer includes its last packet extent.
    // Keep one output frame as a conservative presentation guard, without altering the anchor.
    let end = video_host_start + start + duration - video_start + 1.0 / fps as f64;
    end.is_finite().then_some(end)
}
/// Where a frame of another size sits on the canvas: scaled to fit without
/// changing its shape and centered, on black. `(x, y, width, height)` in
/// canvas pixels, even as yuv420p needs. [`fit_filter`] has FFmpeg place
/// frames the same way, with the same arithmetic.
pub(crate) fn letterbox(frame: (u32, u32), canvas: (u32, u32)) -> (u32, u32, u32, u32) {
    let (fw, fh) = (f64::from(frame.0.max(1)), f64::from(frame.1.max(1)));
    let (cw, ch) = (f64::from(canvas.0), f64::from(canvas.1));
    let even = |size: f64| 2 * (size / 2.0).trunc() as u32;
    let (w, h) = if cw / fw <= ch / fh {
        (canvas.0, even(fh * cw / fw))
    } else {
        (even(fw * ch / fh), canvas.1)
    };
    let offset = |canvas: u32, size: u32| canvas.saturating_sub(size) / 4 * 2;
    (offset(canvas.0, w), offset(canvas.1, h), w, h)
}

/// The FFmpeg filter that puts every frame on a `canvas` (even sizes) as
/// [`letterbox`] does. It keeps no state, so FFmpeg rebuilding the filter
/// graph when the frame size changes loses nothing.
fn fit_filter((width, height): (u32, u32)) -> String {
    format!(
        "scale=w='if(lte({width}/iw\\,{height}/ih)\\,{width}\\,2*trunc(iw*{height}/ih/2))'\
         :h='if(lte({width}/iw\\,{height}/ih)\\,2*trunc(ih*{width}/iw/2)\\,{height})',\
         pad={width}:{height}:x='2*trunc((ow-iw)/4)':y='2*trunc((oh-ih)/4)',setsar=1"
    )
}

/// The distinct frame sizes in `ffprobe … -show_entries frame=width,height
/// -of csv=p=0` output, in the order they first appear.
fn parse_frame_sizes(text: &str) -> Vec<(u32, u32)> {
    let mut sizes = Vec::new();
    for line in text.lines() {
        let mut fields = line.split(',').map(str::trim);
        let size = fields
            .next()
            .and_then(|w| w.parse().ok())
            .zip(fields.next().and_then(|h| h.parse().ok()));
        if let Some(size) = size.filter(|&(w, h): &(u32, u32)| w > 0 && h > 0) {
            if !sizes.contains(&size) {
                sizes.push(size);
            }
        }
    }
    sizes
}

/// The frame sizes of a device recording. scrcpy restarts its encoder at a
/// new size when the display turns between portrait and landscape, and every
/// restart begins with a key frame, so only key frames are decoded.
fn device_frame_sizes(input: &Path) -> Result<Vec<(u32, u32)>, String> {
    let mut probe = deps::command("ffprobe")?;
    probe
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-skip_frame",
            "nokey",
            "-show_entries",
            "frame=width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(input);
    let output = output_with_timeout(probe, Duration::from_secs(120))?;
    if !output.status.success() {
        return Err(format!(
            "Device frame sizes could not be read: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(parse_frame_sizes(&String::from_utf8_lossy(&output.stdout)))
}

/// `timing_extra` holds additional `capture-timing.json` keys.
#[allow(clippy::too_many_arguments)]
fn finalize(
    folder: &Path,
    input: &Path,
    duration: Duration,
    delay: f64,
    fps: u32,
    device_audio: bool,
    device_capture: bool,
    timing_extra: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let mic = folder.join("mic.wav");
    let system = folder.join("system.wav");
    let audio = folder.join("audio.wav");
    let mut timing = serde_json::json!({"videoHostStartMs":delay * 1000.0,"recordingStopMs":duration.as_secs_f64() * 1000.0});
    if let Some(timing) = timing.as_object_mut() {
        timing.extend(timing_extra);
    }
    let mut output_end = duration.as_secs_f64();
    let native_timing = if device_capture {
        let mut probe = deps::command("ffprobe")?;
        probe
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=index,codec_type,start_time:format=start_time,duration",
                "-of",
                "json",
            ])
            .arg(input);
        let output = output_with_timeout(probe, Duration::from_secs(10))?;
        if !output.status.success() {
            return Err(format!(
                "Device timestamps could not be read: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let mut info: serde_json::Value =
            serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
        let end = if let Some(end) = metadata_device_end(&info, delay, fps) {
            timing["nativeExtentSource"] = serde_json::json!("containerMetadata");
            end
        } else {
            let mut probe = deps::command("ffprobe")?;
            probe
                .args([
                    "-v",
                    "error",
                    "-show_packets",
                    "-show_entries",
                    "stream=index,codec_type,start_time:packet=stream_index,pts_time,duration_time",
                    "-of",
                    "json",
                ])
                .arg(input);
            let output = output_with_timeout(probe, Duration::from_secs(10))?;
            if !output.status.success() {
                return Err(format!(
                    "Device packet timestamps could not be read: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            info = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
            timing["nativeExtentSource"] = serde_json::json!("packetTimestamps");
            mapped_device_end(&info, delay, fps)?
        };
        timing["mappedNativeEndMs"] = serde_json::json!(end * 1000.0);
        output_end = output_end.max(end);
        Some(info)
    } else {
        None
    };
    timing["outputEndMs"] = serde_json::json!(output_end * 1000.0);
    // A device that turned between portrait and landscape recorded frames of
    // more than one size. FFmpeg rebuilds the mux's filters at a size change,
    // which restarts `STARTPTS` and `tpad` and loses or misplaces the frames
    // after it, so they are first letterboxed onto the first frame's size.
    let frame_sizes = match device_capture.then(|| device_frame_sizes(input)) {
        Some(Ok(sizes)) => sizes,
        Some(Err(error)) => {
            timing["frameSizesError"] = serde_json::json!(error);
            Vec::new()
        }
        None => Vec::new(),
    };
    if frame_sizes.len() > 1 {
        timing["frameSizes"] = serde_json::json!(frame_sizes
            .iter()
            .map(|&(width, height)| [width, height])
            .collect::<Vec<_>>());
    }
    let seconds = format!("{:.6}", output_end.max(0.001));
    if device_audio {
        let info = native_timing
            .as_ref()
            .ok_or("Device audio has no native timing information")?;
        let (video_pts, audio_pts) = stream_starts(info)?;
        let (audio_host_start, filter) = device_audio_filter(delay, video_pts, audio_pts);
        timing["nativeVideoStartSeconds"] = serde_json::json!(video_pts);
        timing["nativeAudioStartSeconds"] = serde_json::json!(audio_pts);
        timing["deviceAudioHostStartMs"] = serde_json::json!(audio_host_start * 1000.0);
        let mut extract = deps::command("ffmpeg")?;
        extract
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(input)
            .args([
                "-vn",
                "-map",
                "0:a:0",
                "-af",
                &filter,
                "-t",
                &seconds,
                "-ar",
                "48000",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
            ])
            .arg(&system);
        ffmpeg(extract)?;
    }
    fs::write(
        folder.join("capture-timing.json"),
        serde_json::to_vec_pretty(&timing).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut mix = deps::command("ffmpeg")?;
    mix.args(["-y", "-hide_banner", "-loglevel", "error"]);
    match (mic.exists(), system.exists()) {
        (true, true) => {
            mix.arg("-i").arg(&mic).arg("-i").arg(&system).args(["-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95:latency=1[a]", "-map", "[a]"]);
        }
        (true, false) => {
            mix.arg("-i").arg(&mic);
        }
        (false, true) => {
            mix.arg("-i").arg(&system);
        }
        (false, false) => {
            mix.args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono"]);
        }
    }
    if device_capture && mic.exists() && !system.exists() {
        mix.args(["-af", "apad"]);
    }
    mix.args([
        "-t",
        &seconds,
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
    ])
    .arg(&audio);
    ffmpeg(mix)?;
    // Timestamps pass through unchanged, so the mux below and the native
    // timing above still describe the letterboxed video.
    let letterboxed = folder.join("native-video.letterboxed.mkv");
    let video_input = if let [(width, height), _, ..] = frame_sizes.as_slice() {
        let mut fit = deps::command("ffmpeg")?;
        fit.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(input)
            .args([
                "-map",
                "0:v:0",
                "-an",
                "-vf",
                &fit_filter((width / 2 * 2, height / 2 * 2)),
                "-fps_mode",
                "passthrough",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "15",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&letterboxed);
        if let Err(error) = ffmpeg(fit) {
            let _ = fs::remove_file(&letterboxed);
            return Err(error);
        }
        letterboxed.as_path()
    } else {
        input
    };
    let mut mux = deps::command("ffmpeg")?;
    // Extend the first/last frame to cover startup and a static desktop's final interval.
    let filter = format!("setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration={delay:.6}:stop_mode=clone:stop_duration={},scale=trunc(iw/2)*2:trunc(ih/2)*2", duration.as_secs_f64());
    mux.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(video_input)
        .arg("-i")
        .arg(&audio)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            &filter,
            "-r",
            &fps.to_string(),
            "-t",
            &seconds,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ac",
            "1",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
        ])
        .arg(folder.join("video.mp4"));
    let muxed = ffmpeg(mux);
    if video_input != input {
        let _ = fs::remove_file(&letterboxed);
    }
    muxed?;
    validate_final_video(&folder.join("video.mp4"), output_end, fps)
}

fn validate_final_video(path: &Path, expected_seconds: f64, fps: u32) -> Result<(), String> {
    let mut probe = deps::command("ffprobe")?;
    probe
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,duration:format=duration",
            "-of",
            "json",
        ])
        .arg(path);
    let output = output_with_timeout(probe, Duration::from_secs(10))?;
    if !output.status.success() {
        return Err(
            "The finished recording could not be verified; original tracks were retained.".into(),
        );
    }
    let info: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = info["streams"]
        .as_array()
        .ok_or("The finished recording has no streams; original tracks were retained.")?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or("The finished recording has no video; original tracks were retained.")?;
    let audio = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
        .ok_or("The finished recording has no audio; original tracks were retained.")?;
    let seconds = |value: &serde_json::Value| {
        value
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    let tolerance = 1.0 / fps as f64 + 0.05;
    if video["width"].as_u64().unwrap_or(0) == 0
        || video["height"].as_u64().unwrap_or(0) == 0
        || [video, audio, &info["format"]].iter().any(|stream| {
            seconds(&stream["duration"]).is_none_or(|duration| {
                duration <= 0.0 || (duration - expected_seconds).abs() > tolerance
            })
        })
    {
        return Err("The finished recording is incomplete; original tracks were retained.".into());
    }
    Ok(())
}

fn remove_native_intermediate(folder: &Path, input: &Path) -> Result<(), String> {
    // Never use metadata-provided media paths for cleanup, or traverse a directory.
    if input.parent() != Some(folder)
        || !matches!(
            input.file_name().and_then(|name| name.to_str()),
            Some("native-video.mp4" | "native-video.mkv")
        )
    {
        return Err("Skipped cleanup of an unexpected native video path.".into());
    }
    fs::remove_file(input).map_err(|e| {
        format!("The recording is saved, but its temporary native video could not be removed: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bounded version of the same clean FFmpeg quit used by `ActiveCapture::stop`.
    /// Always reap the process, including when an assertion about its output will fail.
    fn stop_synthetic_recording(mut child: Child) -> Result<(), String> {
        let quit = child
            .stdin
            .take()
            .ok_or_else(|| "Recording stdin was not piped".to_string())
            .and_then(|mut stdin| stdin.write_all(b"q\n").map_err(|error| error.to_string()));
        let deadline = Instant::now() + Duration::from_secs(5);
        if quit.is_ok() {
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => return Err(format!("FFmpeg quit with {status}")),
                    Ok(None) if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    _ => break,
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Err(quit.err().unwrap_or_else(|| "FFmpeg did not quit".into()))
    }

    #[test]
    #[ignore = "Requires FFmpeg/ffprobe; generates video only, with no hardware capture"]
    fn actual_ffmpeg_recording_startup_flushes_static_and_moving_video() {
        let root = tempfile::Builder::new()
            .prefix("record-start-")
            .tempdir()
            .unwrap();
        let mut failures = Vec::new();
        for (name, source) in [
            ("static", "color=c=red:size=640x360:rate=10"),
            ("moving", "testsrc=size=640x360:rate=10"),
        ] {
            let folder = root.path().join(name);
            fs::create_dir(&folder).unwrap();
            let input = folder.join("native-video.mkv");
            let log = folder.join("capture.log");
            let mut command = deps::command("ffmpeg").unwrap();
            command.args(["-y", "-hide_banner", "-loglevel", "warning"]);
            command.args(["-re", "-f", "lavfi", "-i", source]);
            // No fixture-only output options: a regression in the production
            // encoder or its flushing must also break these real FFmpeg runs.
            configure_recording_output(&mut command, 10);
            let epoch = Instant::now();
            let child = command
                .arg(&input)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::from(File::create(&log).unwrap()))
                .spawn()
                .unwrap();
            let video = match ready_process(child, input.clone(), None, epoch) {
                Ok(video) => video,
                Err(error) => {
                    failures.push(format!(
                        "{name}: {error}; bytes={:?}; log={}",
                        input.metadata().map(|m| m.len()),
                        fs::read_to_string(&log).unwrap_or_default()
                    ));
                    continue;
                }
            };
            let startup = epoch.elapsed();
            let child = match video {
                VideoCapture::Process { child, .. } => child.into_inner().unwrap(),
                #[cfg(windows)]
                VideoCapture::Native(_) => panic!("Expected an FFmpeg recording"),
            };
            // Clean up before asserting the bound, so a timing regression
            // cannot leave an encoder running after the test fails.
            let stopped = stop_synthetic_recording(child);
            eprintln!("{name}: ready in {startup:?}, clean stop={stopped:?}");
            assert!(stopped.is_ok(), "{name}: {stopped:?}");
            assert!(
                startup < Duration::from_secs(2),
                "{name}: recording readiness took {startup:?}"
            );

            let mut probe = deps::command("ffprobe").unwrap();
            probe
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-count_frames",
                    "-show_entries",
                    "stream=nb_read_frames",
                    "-of",
                    "json",
                ])
                .arg(&input);
            let output = output_with_timeout(probe, Duration::from_secs(5)).unwrap();
            assert!(output.status.success(), "{name}: {:?}", output.stderr);
            let streams: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            let frames = streams["streams"][0]["nb_read_frames"]
                .as_str()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            assert!(frames > 0, "{name}: {streams}");
            let mut decode = deps::command("ffmpeg").unwrap();
            decode
                .args(["-v", "error", "-xerror", "-i"])
                .arg(&input)
                .args(["-map", "0:v:0", "-f", "null", "-"]);
            let output = output_with_timeout(decode, Duration::from_secs(5)).unwrap();
            assert!(
                output.status.success(),
                "{name}: full decode failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    #[ignore = "Requires FFmpeg; checks synthetic stalled/failed startup cleanup without hardware"]
    fn actual_ffmpeg_recording_failed_start_reaps_processes() {
        let root = tempfile::Builder::new()
            .prefix("record-start-")
            .tempdir()
            .unwrap();
        for (name, arguments, expected) in [
            (
                "no-input",
                vec![
                    "-f",
                    "rawvideo",
                    "-pixel_format",
                    "rgb24",
                    "-video_size",
                    "64x64",
                    "-framerate",
                    "10",
                    "-i",
                    "pipe:0",
                ],
                "Capture produced no frames",
            ),
            (
                "early-exit",
                vec!["-f", "lavfi", "-i", "cuereview_no_such_filter"],
                "Capture could not start",
            ),
        ] {
            let folder = root.path().join(name);
            fs::create_dir(&folder).unwrap();
            let input = folder.join("native-video.mkv");
            let log = folder.join("capture.log");
            let mut command = deps::command("ffmpeg").unwrap();
            command.args(["-y", "-hide_banner", "-loglevel", "warning"]);
            command.args(arguments);
            configure_recording_output(&mut command, 10);
            let mut child = command
                .arg(&input)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::from(File::create(&log).unwrap()))
                .spawn()
                .unwrap();
            // Keep the input open without supplying a frame. Returning an
            // error must close the child's reader, not leave it waiting here.
            let mut stdin = child.stdin.take().unwrap();
            let epoch = Instant::now();
            let result = ready_process(child, input, None, epoch);
            let elapsed = epoch.elapsed();
            let error = match result {
                Err(error) => error,
                Ok(VideoCapture::Process { child, .. }) => {
                    drop(stdin);
                    let _ = stop_synthetic_recording(child.into_inner().unwrap());
                    panic!("{name}: empty capture became ready");
                }
                #[cfg(windows)]
                Ok(VideoCapture::Native(_)) => panic!("Expected an FFmpeg recording"),
            };
            assert!(
                stdin.write_all(&[0]).is_err(),
                "{name}: child still reads stdin"
            );
            assert!(error.starts_with(expected), "{name}: {error}");
            assert!(error.contains("capture.log"), "{name}: {error}");
            assert!(elapsed < Duration::from_secs(12), "{name}: {elapsed:?}");
            if name == "early-exit" {
                assert!(elapsed < Duration::from_secs(2), "{name}: {elapsed:?}");
                assert!(fs::read_to_string(log)
                    .unwrap()
                    .contains("cuereview_no_such_filter"));
            }
            eprintln!("{name}: {error}; returned in {elapsed:?}, child pipe closed");
        }
    }

    #[test]
    fn avfoundation_startup_failures_keep_the_cause_and_offer_recovery() {
        for cause in [
            "Capture could not start (exit status: 1); see capture.log",
            "Capture produced no frames; see capture.log",
        ] {
            let message = recording_startup_error("avfoundation:0", cause.into());
            assert!(message.starts_with(cause), "{message}");
            assert!(
                message.contains("Camera or Screen Recording access"),
                "{message}"
            );
            assert!(message.contains("macOS System Settings"), "{message}");
            assert!(message.contains("close other apps"), "{message}");
            assert!(message.ends_with("then retry."), "{message}");
            assert!(
                !message.contains("access is blocked"),
                "a startup failure does not establish permission denial"
            );
        }
    }

    #[test]
    fn other_recording_sources_keep_their_startup_errors_unchanged() {
        let cause = "Capture produced no frames; see capture.log";
        for source in [
            "v4l2:/dev/video0",
            "dshow:Camera",
            "x11::0",
            "android:serial",
            "monitor:1",
        ] {
            assert_eq!(recording_startup_error(source, cause.into()), cause);
        }
    }

    #[test]
    fn source_identity_names_only_windows_and_displays_that_exist() {
        for id in [
            "window:1",
            "window:x",
            "monitor:0",
            "monitor:99",
            "dshow:Camera",
            "android:R3CN90",
        ] {
            assert_eq!(source_identity(id), None, "{id}");
        }
        #[cfg(windows)]
        {
            use crate::models::SourceIdentity;
            // Whatever this machine has attached; nothing is recorded.
            if let Ok(monitor) = Monitor::from_index(1) {
                let Some(SourceIdentity::Display {
                    device,
                    left,
                    top,
                    right,
                    bottom,
                }) = source_identity("monitor:1")
                else {
                    panic!("display 1 has no identity");
                };
                assert_eq!(device, monitor.device_name().unwrap());
                assert!(right > left && bottom > top);
                assert_eq!(source_identity("monitor:1"), source_identity("monitor:1"));
            }
            if let Some(window) = Window::enumerate().unwrap().first() {
                let id = format!("window:{}", window.as_raw_hwnd() as usize);
                if let Some(SourceIdentity::Window {
                    process,
                    class,
                    pid,
                    process_created_ms,
                    ..
                }) = source_identity(&id)
                {
                    assert!(!class.is_empty());
                    assert_eq!(process, window.process_name().unwrap_or_default());
                    assert_eq!(pid, window.process_id().ok());
                    // Read again, the same process has the same creation time,
                    // which lies between 2020 and now.
                    if let Some(SourceIdentity::Window {
                        process_created_ms: again,
                        ..
                    }) = source_identity(&id)
                    {
                        assert_eq!(again, process_created_ms);
                    }
                    if let Some(created) = process_created_ms {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;
                        assert!((1_577_836_800_000..=now).contains(&created), "{created}");
                    }
                }
            }
        }
    }
    #[test]
    fn avfoundation_listing_keeps_video_indices_and_excludes_audio() {
        let sources = avfoundation_sources("[AVFoundation indev @ 123] AVFoundation video devices:\n[AVFoundation indev @ 123] [0] FaceTime HD Camera\n[AVFoundation indev @ 123] [1] Capture screen 0\n[AVFoundation indev @ 123] AVFoundation audio devices:\n[AVFoundation indev @ 123] [0] MacBook Microphone\n");
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].id, "avfoundation:0");
        assert_eq!(sources[0].kind, "camera");
        assert_eq!(sources[1].id, "avfoundation:1");
        assert_eq!(sources[1].kind, "display");
        assert!(avfoundation_sources("permission denied").is_empty());
    }

    #[test]
    fn v4l2_names_reject_non_device_paths() {
        assert_eq!(video_device_name("/dev/video12"), Some("12"));
        for path in [
            "/dev/video",
            "/dev/video0/other",
            "/dev/video0:audio",
            "/tmp/video0",
        ] {
            assert_eq!(video_device_name(path), None);
        }
    }

    #[test]
    fn unavailable_input_is_rejected_before_spawning() {
        let mut command = std::process::Command::new("ffmpeg");
        assert!(configure_video_input(&mut command, "desktop:unavailable", 30, "32M").is_err());
        assert_eq!(command.get_args().count(), 0);
    }
    #[test]
    fn cursor_origins_are_physical_offsets_for_displays_and_windows() {
        // A 3840x2160 monitor at 150% left of and above the primary display.
        // In a per-monitor-v2 thread GetMonitorInfoW and GetCursorPos both
        // report physical pixels, like the WGC frame of that monitor.
        let monitor = ScreenRect {
            left: -3840,
            top: -200,
            right: 0,
            bottom: 1960,
        };
        let display = SourceReading::Display(Some(monitor));
        assert_eq!(
            locate(Some((-1920, 880)), display),
            Some((1920, 1080, true))
        );
        assert_eq!(locate(Some((-3840, -200)), display), Some((0, 0, true)));
        // On the primary display: outside this source.
        assert_eq!(locate(Some((100, 100)), display), Some((3940, 300, false)));
        assert_eq!(locate(Some((0, 0)), SourceReading::Display(None)), None);
        assert_eq!(locate(None, display), None);

        // A window on that monitor whose GetWindowRect starts at x = -3000:
        // its canvas starts 7 px further right, at the DWM extended frame
        // bounds, without the invisible resize border.
        let bounds = ScreenRect {
            left: -2993,
            top: 100,
            right: -2993 + 1281,
            bottom: 100 + 721,
        };
        let window = |over_source| SourceReading::Window {
            bounds: Some(bounds),
            over_source,
        };
        let (x, y, over_source) = locate(Some((-2993 + 640, 460)), window(true)).unwrap();
        assert_eq!((x, y, over_source), (640, 360, true));
        // Pixel centers land on the same pixel of the even-sized video.
        let canvas = (1281, 721);
        let point = cursor::video_point(
            0,
            cursor::Position {
                x,
                y,
                over_source,
                buttons: 0,
            },
            canvas,
            cursor::video_size(canvas),
        );
        assert_eq!((point.x, point.y, point.px, point.py), (0.5, 0.5, 640, 360));
        // Covered by another window, or above the window's top edge.
        assert_eq!(
            locate(Some((-2993, 100)), window(false)),
            Some((0, 0, false))
        );
        assert_eq!(
            locate(Some((-2900, 90)), window(false)),
            Some((93, -10, false))
        );
        // A minimized or closed window has no bounds: a gap.
        let gone = SourceReading::Window {
            bounds: None,
            over_source: false,
        };
        assert_eq!(locate(Some((0, 0)), gone), None);
    }

    #[test]
    fn button_polls_keep_presses_shorter_than_a_poll() {
        use cursor::{LEFT, MIDDLE, RIGHT};
        const HELD: i16 = i16::MIN;
        const PRESSED: i16 = 1;
        assert_eq!(button_steps(0, [0, 0, 0]), [0]);
        assert_eq!(button_steps(0, [HELD | PRESSED, 0, 0]), [LEFT]);
        assert_eq!(button_steps(LEFT, [HELD, 0, 0]), [LEFT]);
        assert_eq!(button_steps(LEFT, [0, 0, 0]), [0]);
        assert_eq!(button_steps(0, [0, HELD, 0]), [RIGHT]);
        // Pressed and released between two polls.
        assert_eq!(button_steps(0, [PRESSED, 0, 0]), [LEFT, 0]);
        // Released and pressed again.
        assert_eq!(button_steps(LEFT, [HELD | PRESSED, 0, 0]), [0, LEFT]);
        // Released, pressed and released.
        assert_eq!(button_steps(LEFT, [PRESSED, 0, 0]), [0, LEFT, 0]);
        // Buttons combine step by step.
        assert_eq!(
            button_steps(MIDDLE, [PRESSED, HELD | PRESSED, HELD]),
            [LEFT | RIGHT | MIDDLE, RIGHT | MIDDLE]
        );
    }

    #[test]
    fn capture_timing_gains_canvas_and_cursor_keys() {
        assert_eq!(
            serde_json::Value::Object(timing_extra(Some((1281, 721)), Some(Ok(42)), None)),
            serde_json::json!({"canvasWidth":1281,"canvasHeight":721,"cursorLines":42})
        );
        assert_eq!(
            serde_json::Value::Object(timing_extra(None, Some(Err("denied".into())), None)),
            serde_json::json!({"cursorError":"denied"})
        );
        assert!(timing_extra(None, None, None).is_empty());
        let delay = touch::Delay {
            frames: 120,
            p50: 1.5,
            p95: 4.0,
            max: 31.2,
        };
        assert_eq!(
            serde_json::Value::Object(timing_extra(Some((1080, 2400)), Some(Ok(7)), Some(delay))),
            serde_json::json!({"canvasWidth":1080,"canvasHeight":2400,"cursorLines":7,
                "touchDelayMs":{"frames":120,"p50":1.5,"p95":4.0,"max":31.2}})
        );
    }

    #[test]
    #[ignore = "Moves the real pointer and clicks an owned topmost window; attended runs only, records nothing"]
    #[cfg(windows)]
    fn actual_cursor_sampler_follows_the_pointer_over_an_owned_window() {
        use crate::{cursor::MouseButton, store::Store};
        use std::ffi::c_void;
        #[repr(C)]
        #[derive(Clone, Copy, Default)]
        struct Point {
            x: i32,
            y: i32,
        }
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
            fn DestroyWindow(window: *mut c_void) -> i32;
            fn SetCursorPos(x: i32, y: i32) -> i32;
            fn GetCursorPos(point: *mut Point) -> i32;
            fn WindowFromPoint(point: Point) -> *mut c_void;
            fn GetAncestor(window: *mut c_void, flags: u32) -> *mut c_void;
            fn MonitorFromWindow(window: *mut c_void, flags: u32) -> *mut c_void;
            fn mouse_event(flags: u32, dx: i32, dy: i32, data: u32, extra: usize);
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
        #[link(name = "dwmapi")]
        extern "system" {
            fn DwmGetWindowAttribute(
                window: *mut c_void,
                attribute: u32,
                value: *mut c_void,
                size: u32,
            ) -> i32;
        }
        struct Owned(*mut c_void);
        impl Drop for Owned {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        struct Restore(Point);
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe {
                    SetCursorPos(self.0.x, self.0.y);
                }
            }
        }
        let pump = |duration: Duration| {
            let until = Instant::now() + duration;
            let mut message: Message = unsafe { std::mem::zeroed() };
            while Instant::now() < until {
                unsafe {
                    while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) != 0 {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                thread::sleep(Duration::from_millis(5));
            }
        };
        let root_at = |x: i32, y: i32| unsafe { GetAncestor(WindowFromPoint(Point { x, y }), 2) };

        // Physical pixels for the window, SetCursorPos and the expectations.
        assert!(pointer::physical_pixels());
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "CueReview cursor verification\0".encode_utf16().collect();
        // WS_EX_TOPMOST | WS_EX_TOOLWINDOW; WS_POPUP | WS_VISIBLE | SS_NOTIFY |
        // SS_BLACKRECT. Without SS_NOTIFY a static answers WM_NCHITTEST with
        // HTTRANSPARENT, which only its own thread asks: `root_at` here saw
        // through the window while the sampler's thread saw it.
        let window = Owned(unsafe {
            CreateWindowExW(
                0x88,
                class.as_ptr(),
                title.as_ptr(),
                0x90000104,
                240,
                180,
                480,
                320,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        });
        assert!(!window.0.is_null());
        pump(Duration::from_millis(300));
        let mut original = Point::default();
        assert_ne!(unsafe { GetCursorPos(&mut original) }, 0);
        let _restore = Restore(original);
        let mut bounds = ScreenRect::default();
        assert!(
            unsafe {
                DwmGetWindowAttribute(
                    window.0,
                    9,
                    (&mut bounds as *mut ScreenRect).cast(),
                    size_of::<ScreenRect>() as u32,
                )
            } >= 0
        );
        let canvas = (
            (bounds.right - bounds.left) as u32,
            (bounds.bottom - bounds.top) as u32,
        );
        let monitor = unsafe { MonitorFromWindow(window.0, 2) } as usize;
        let screen = pointer::monitor_bounds(monitor).unwrap();
        let screen_canvas = (
            (screen.right - screen.left) as u32,
            (screen.bottom - screen.top) as u32,
        );

        let data = tempfile::tempdir().unwrap();
        let store = Store::open(data.path().into()).unwrap();
        let session = |source_id: String| {
            store
                .create_session(
                    None,
                    None,
                    &CaptureConfig {
                        source_id,
                        microphone_id: None,
                        system_audio: false,
                        fps: 30,
                    },
                )
                .unwrap()
                .id
        };
        let window_id = session(format!("window:{}", window.0 as usize));
        let display_id = session("monitor:1".into());
        let file = |id: &str| store.session_dir(id).unwrap().join(cursor::FILE_NAME);
        let epoch = Instant::now();
        let window_sampler = pointer::Sampler::spawn(
            pointer::Source::Window(window.0 as usize),
            file(&window_id),
            epoch,
            Some(canvas),
        );
        let display_sampler = pointer::Sampler::spawn(
            pointer::Source::Display(monitor),
            file(&display_id),
            epoch,
            Some(screen_canvas),
        );
        pump(Duration::from_millis(200));
        let mut expected = Vec::new();
        for (x, y) in [
            (bounds.left + 40, bounds.top + 30),
            (bounds.left + 300, bounds.top + 200),
            (bounds.right - 2, bounds.bottom - 2),
            (bounds.left - 60, bounds.top + 20),
        ] {
            let before = epoch.elapsed().as_millis() as u64;
            assert_ne!(unsafe { SetCursorPos(x, y) }, 0);
            let moved = epoch.elapsed().as_millis() as u64;
            pump(Duration::from_millis(150));
            let over = root_at(x, y) == window.0;
            expected.push(((before, moved), x, y, over));
            pump(Duration::from_millis(100));
        }
        // Click the owned window, but only when it is the window under the pointer.
        let (x, y) = (bounds.left + 100, bounds.top + 100);
        assert_ne!(unsafe { SetCursorPos(x, y) }, 0);
        pump(Duration::from_millis(150));
        let clickable = root_at(x, y) == window.0;
        let click_from = epoch.elapsed().as_millis() as u64;
        if clickable {
            unsafe { mouse_event(0x0002, 0, 0, 0, 0) };
            pump(Duration::from_millis(80));
            unsafe { mouse_event(0x0004, 0, 0, 0, 0) };
        }
        pump(Duration::from_millis(150));
        let click_to = epoch.elapsed().as_millis() as u64;
        assert!(window_sampler.stop().unwrap() >= 5);
        assert!(display_sampler.stop().unwrap() >= 5);
        drop(window);

        let window_track = cursor::load(&store, &window_id).expect("window track");
        let display_track = cursor::load(&store, &display_id).expect("display track");
        let pixel = |offset: i32, canvas: u32| {
            let video = cursor::video_size((canvas, canvas)).0;
            ((f64::from(offset) + 0.5) / f64::from(canvas) * f64::from(video)).floor() as i32
        };
        // Within 1 px, for jitter and rounding.
        let near = |point: &cursor::CursorPoint, (px, py): (i32, i32)| {
            (point.px - px).abs() <= 1 && (point.py - py).abs() <= 1
        };
        // The sample of the move itself: the first one near the new position
        // in a short window around `SetCursorPos`, before a hand resting on the
        // mouse has had time to nudge it. Lines are only written when the
        // pointer moves (and as heartbeats), and the sampler stamps the time
        // before it reads the pointer, so the move can be stamped a little
        // before `SetCursorPos` returned. `Err` lists the samples seen.
        let sample_of_move =
            |track: &cursor::CursorTrack, (before, moved): (u64, u64), want: (i32, i32)| {
                let from = before.saturating_sub(50);
                let mut seen: Vec<cursor::CursorPoint> = Vec::new();
                for t in from..=moved + 100 {
                    if let Some(point) = track.at(t).filter(|point| point.t_ms >= from) {
                        if seen.last().is_none_or(|last| last.t_ms != point.t_ms) {
                            seen.push(point);
                        }
                    }
                }
                seen.iter()
                    .copied()
                    .find(|point| near(point, want))
                    .ok_or(seen)
            };
        for (move_ms, x, y, over) in expected {
            let want = (
                pixel(x - bounds.left, canvas.0),
                pixel(y - bounds.top, canvas.1),
            );
            let point = sample_of_move(&window_track, move_ms, want).unwrap_or_else(|seen| {
                panic!("window at {x},{y}: no sample within 1 px of {want:?} around the move at {move_ms:?} ms: {seen:?}")
            });
            assert_eq!(point.in_video, over, "window at {x},{y}: {point:?}");
            let want = (
                pixel(x - screen.left, screen_canvas.0),
                pixel(y - screen.top, screen_canvas.1),
            );
            let point = sample_of_move(&display_track, move_ms, want).unwrap_or_else(|seen| {
                panic!("display at {x},{y}: no sample within 1 px of {want:?} around the move at {move_ms:?} ms: {seen:?}")
            });
            assert!(point.in_video, "display at {x},{y}: {point:?}");
        }
        if clickable {
            let clicks = window_track.clicks(click_from, click_to);
            assert_eq!(clicks.len(), 1, "{clicks:?}");
            assert_eq!(clicks[0].button, MouseButton::Left);
            assert!(clicks[0].at.in_video);
            assert!(
                near(&clicks[0].at, (pixel(100, canvas.0), pixel(100, canvas.1))),
                "{clicks:?}"
            );
        } else {
            eprintln!("Skipped the click: the owned window was not under the pointer");
        }
    }

    #[test]
    fn native_cleanup_is_limited_to_the_owned_intermediate() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join("session");
        fs::create_dir(&folder).unwrap();
        let outside = root.path().join("native-video.mp4");
        fs::write(&outside, "outside").unwrap();
        let final_video = folder.join("video.mp4");
        fs::write(&final_video, "final").unwrap();
        assert!(remove_native_intermediate(&folder, &outside).is_err());
        assert!(remove_native_intermediate(&folder, &final_video).is_err());
        assert!(outside.exists() && final_video.exists());
        let native = folder.join("native-video.mkv");
        fs::write(&native, "temporary").unwrap();
        remove_native_intermediate(&folder, &native).unwrap();
        assert!(!native.exists());
        assert!(outside.exists() && final_video.exists());
    }

    #[test]
    fn device_frame_sizes_and_the_fit_filter() {
        assert_eq!(
            parse_frame_sizes("64,128\n128,64\n64,128,\n\n0,0\nwidth,height\n128,64\r\n"),
            [(64, 128), (128, 64)]
        );
        assert!(parse_frame_sizes("").is_empty());
        let filter = fit_filter((1080, 2400));
        assert!(
            filter
                .starts_with("scale=w='if(lte(1080/iw\\,2400/ih)\\,1080\\,2*trunc(iw*2400/ih/2))'"),
            "{filter}"
        );
        assert!(filter
            .contains(",pad=1080:2400:x='2*trunc((ow-iw)/4)':y='2*trunc((oh-ih)/4)',setsar=1"));
    }

    /// The RGB pixels of `video`'s frame at `seconds`.
    fn frame_rgb(video: &Path, seconds: f64) -> Vec<u8> {
        let mut command = deps::command("ffmpeg").unwrap();
        command
            .args(["-v", "error", "-ss", &format!("{seconds:.3}"), "-i"])
            .arg(video)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        let output = output_with_timeout(command, Duration::from_secs(30)).unwrap();
        assert!(output.status.success());
        output.stdout
    }

    #[test]
    #[ignore = "Requires FFmpeg; finalizes a synthetic device recording whose frame size changes twice"]
    fn actual_device_finalize_keeps_frames_after_a_turn() {
        let folder = tempfile::tempdir().unwrap();
        // Like scrcpy after two rotations: one H.264 stream, red 64x128, then
        // blue 128x64, then green 64x128, one second each, with in-band
        // parameter sets at each size change.
        let mut stream = Vec::new();
        for (color, size) in [("red", "64x128"), ("blue", "128x64"), ("green", "64x128")] {
            let part = folder.path().join(format!("{color}.h264"));
            let mut command = deps::command("ffmpeg").unwrap();
            command
                .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("color=c={color}:s={size}:r=30:d=1"))
                .args([
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .args(["-bf", "0", "-f", "h264"])
                .arg(&part);
            ffmpeg(command).unwrap();
            stream.extend(fs::read(&part).unwrap());
        }
        let raw = folder.path().join("turned.h264");
        fs::write(&raw, stream).unwrap();
        let input = folder.path().join("native-video.mkv");
        let mut command = deps::command("ffmpeg").unwrap();
        command
            .args(["-y", "-v", "error", "-framerate", "30", "-i"])
            .arg(&raw)
            .args(["-c", "copy"])
            .arg(&input);
        ffmpeg(command).unwrap();
        assert_eq!(device_frame_sizes(&input).unwrap(), [(64, 128), (128, 64)]);

        // The first frame arrives 0.5 s after the epoch.
        finalize(
            folder.path(),
            &input,
            Duration::from_secs_f64(3.5),
            0.5,
            30,
            false,
            true,
            serde_json::Map::new(),
        )
        .unwrap();
        let timing: serde_json::Value =
            serde_json::from_slice(&fs::read(folder.path().join("capture-timing.json")).unwrap())
                .unwrap();
        assert_eq!(
            timing["frameSizes"],
            serde_json::json!([[64, 128], [128, 64]])
        );
        assert!(!folder.path().join("native-video.letterboxed.mkv").exists());
        let video = folder.path().join("video.mp4");
        let pixel = |frame: &[u8], x: usize, y: usize| {
            let at = (y * 64 + x) * 3;
            [frame[at], frame[at + 1], frame[at + 2]]
        };
        let is = |[r, g, b]: [u8; 3], want: &str| match want {
            "red" => r > 200 && g < 60 && b < 60,
            "green" => g > 90 && r < 60 && b < 60,
            "blue" => b > 200 && r < 60 && g < 60,
            _ => r < 30 && g < 30 && b < 30,
        };
        // The landscape second keeps its time, 1.5 to 2.5 s after the 0.5 s
        // start, to the frame, and is letterboxed into rows 48..80
        // (`letterbox((128, 64), (64, 128))`), with black above and below.
        // Before, it was lost and green followed red.
        assert_eq!(letterbox((128, 64), (64, 128)), (0, 48, 64, 32));
        for (seconds, center) in [
            (0.2, "red"),
            (1.45, "red"),
            (1.55, "blue"),
            (2.45, "blue"),
            (2.55, "green"),
            (3.4, "green"),
        ] {
            let frame = frame_rgb(&video, seconds);
            assert_eq!(frame.len(), 64 * 128 * 3, "{seconds}");
            assert!(
                is(pixel(&frame, 32, 64), center),
                "{seconds}: {:?}",
                pixel(&frame, 32, 64)
            );
            let edges = [pixel(&frame, 32, 40), pixel(&frame, 32, 88)];
            if center == "blue" {
                assert!(
                    edges.iter().all(|&edge| is(edge, "black")),
                    "{seconds}: {edges:?}"
                );
            } else {
                assert!(
                    edges.iter().all(|&edge| is(edge, center)),
                    "{seconds}: {edges:?}"
                );
            }
        }
    }

    #[test]
    #[ignore = "Requires FFmpeg; validates successful output, missing audio, truncated timeline, and corrupt media"]
    fn actual_final_video_validation_rejects_incomplete_output() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("video.mp4");
        let mut command = deps::command("ffmpeg").unwrap();
        command
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=mono",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
            ])
            .arg(&path);
        ffmpeg(command).unwrap();
        validate_final_video(&path, 1.0, 30).unwrap();
        assert!(validate_final_video(&path, 2.0, 30).is_err());
        let silent = folder.path().join("no-audio.mp4");
        let mut command = deps::command("ffmpeg").unwrap();
        command
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(&path)
            .args(["-an", "-c:v", "copy"])
            .arg(&silent);
        ffmpeg(command).unwrap();
        assert!(validate_final_video(&silent, 1.0, 30).is_err());
        fs::write(&path, "corrupt").unwrap();
        assert!(validate_final_video(&path, 1.0, 30).is_err());
    }

    #[test]
    #[ignore = "Requires CUEREVIEW_SIZE_FIXTURE pointing to an existing recording; reads it only, finalizes isolated copies and measures storage/timing"]
    fn actual_size_optimized_finalization_preserves_timeline() {
        let source = PathBuf::from(
            std::env::var_os("CUEREVIEW_SIZE_FIXTURE").expect("Set a read-only size fixture"),
        );
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let folder = workspace
            .join("test-results/recording-size")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&folder).unwrap();
        let input = folder.join("native-video.mkv");
        let original = source.join("native-video.mkv");
        let original_bytes = fs::read(&original).unwrap();
        fs::write(&input, &original_bytes).unwrap();
        // Copy ancillary files so the measured total includes the same transcript,
        // speech input, diagnostics and lossless audio as the source session.
        fn copy_ancillary(source: &Path, target: &Path, top: bool) {
            for entry in fs::read_dir(source).unwrap() {
                let entry = entry.unwrap();
                let kind = entry.file_type().unwrap();
                let destination = target.join(entry.file_name());
                if kind.is_dir() {
                    fs::create_dir_all(&destination).unwrap();
                    copy_ancillary(&entry.path(), &destination, false);
                } else if kind.is_file()
                    && !(top
                        && matches!(
                            entry.file_name().to_str(),
                            Some("native-video.mkv" | "video.mp4")
                        ))
                {
                    fs::copy(entry.path(), destination).unwrap();
                }
            }
        }
        copy_ancillary(&source, &folder, true);
        let timing: serde_json::Value =
            serde_json::from_slice(&fs::read(source.join("capture-timing.json")).unwrap()).unwrap();
        let duration =
            Duration::from_secs_f64(timing["recordingStopMs"].as_f64().unwrap() / 1000.0);
        let delay = timing["videoHostStartMs"].as_f64().unwrap() / 1000.0;
        let started = Instant::now();
        finalize(
            &folder,
            &input,
            duration,
            delay,
            30,
            false,
            true,
            serde_json::Map::new(),
        )
        .unwrap();
        let encode_seconds = started.elapsed().as_secs_f64();
        let final_video = folder.join("video.mp4");
        let mut decode = deps::command("ffmpeg").unwrap();
        decode
            .args(["-hide_banner", "-loglevel", "error", "-xerror", "-i"])
            .arg(&final_video)
            .args(["-f", "null", "-"]);
        ffmpeg(decode).unwrap();
        let new_timing: serde_json::Value =
            serde_json::from_slice(&fs::read(folder.join("capture-timing.json")).unwrap()).unwrap();
        // The output end is reproduced exactly when it comes from the same
        // native extent. A fixture finalized before the container-metadata
        // fast path (no `nativeExtentSource`, or `packetTimestamps`) ends where
        // its last packet does, while the fast path adds one output frame as a
        // guard to the container's extent, which can also count the last AAC
        // packet the packet scan left out: a difference of about 42 ms at 30 fps.
        let (old_end, new_end) = (
            timing["outputEndMs"].as_f64().unwrap(),
            new_timing["outputEndMs"].as_f64().unwrap(),
        );
        let (old_source, new_source) = (
            &timing["nativeExtentSource"],
            &new_timing["nativeExtentSource"],
        );
        let output_end_tolerance_ms = if old_source == new_source {
            assert_eq!(new_timing["outputEndMs"], timing["outputEndMs"]);
            0.0
        } else {
            let frame_ms = 1000.0 / 30.0;
            let aac_packet_ms = 1024.0 * 1000.0 / 48_000.0;
            let tolerance = frame_ms + aac_packet_ms;
            assert!(
                (new_end - old_end).abs() <= tolerance,
                "The fixture's output end ({old_end} ms, native extent {old_source}) and the new one ({new_end} ms, native extent {new_source}) differ by more than one frame and one AAC packet ({tolerance:.3} ms)"
            );
            println!(
                "The fixture's native extent is {old_source} and the new one {new_source}: output end {old_end} ms vs {new_end} ms ({:+.3} ms, within {tolerance:.3} ms)",
                new_end - old_end
            );
            tolerance
        };
        assert_eq!(new_timing["videoHostStartMs"], timing["videoHostStartMs"]);
        let source_mix = hound::WavReader::open(source.join("audio.wav")).unwrap();
        let new_mix = hound::WavReader::open(folder.join("audio.wav")).unwrap();
        assert_eq!(source_mix.duration(), new_mix.duration());
        assert_eq!(
            fs::read(source.join("audio.wav")).unwrap(),
            fs::read(folder.join("audio.wav")).unwrap()
        );
        // Compare reconstructed output against the old output on the same presentation timeline.
        let mut compare = deps::command("ffmpeg").unwrap();
        compare
            .arg("-i")
            .arg(source.join("video.mp4"))
            .arg("-i")
            .arg(&final_video)
            .args([
                "-lavfi",
                "[0:v]fps=1[ref];[1:v]fps=1[enc];[ref][enc]ssim",
                "-an",
                "-f",
                "null",
                "-",
            ]);
        let comparison = output_with_timeout(compare, Duration::from_secs(120)).unwrap();
        assert!(comparison.status.success());
        let quality_log = String::from_utf8_lossy(&comparison.stderr);
        let ssim = quality_log
            .rsplit("All:")
            .next()
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse::<f64>()
            .unwrap();
        assert!(ssim > 0.98, "Unexpected quality regression: {ssim}");
        remove_native_intermediate(&folder, &input).unwrap();
        assert!(!input.exists());
        assert_eq!(
            fs::read(&original).unwrap(),
            original_bytes,
            "Source recording changed"
        );
        fn sum_files(path: &Path) -> u64 {
            fs::read_dir(path)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    let kind = entry.file_type().unwrap();
                    if kind.is_dir() {
                        sum_files(&entry.path())
                    } else if kind.is_file() {
                        entry.metadata().unwrap().len()
                    } else {
                        0
                    }
                })
                .sum()
        }
        let source_total = sum_files(&source);
        let old_video = source.join("video.mp4").metadata().unwrap().len();
        let new_video = final_video.metadata().unwrap().len();
        let actual_total = sum_files(&folder);
        // Finalizing rewrites capture-timing.json, which for an older fixture
        // gains `nativeExtentSource`; every other file is the same size.
        let old_timing = source.join("capture-timing.json").metadata().unwrap().len();
        let new_timing_bytes = folder.join("capture-timing.json").metadata().unwrap().len();
        assert_eq!(
            actual_total,
            source_total - old_video - original_bytes.len() as u64 + new_video - old_timing
                + new_timing_bytes
        );
        let report = serde_json::json!({"output":folder,"sourceTotalBytes":source_total,"oldVideoBytes":old_video,"nativeVideoBytes":original_bytes.len(),"newVideoBytes":new_video,"actualTotalBytesAfterCleanup":actual_total,"videoReductionPercent":100.0 * (1.0 - new_video as f64 / old_video as f64),"folderReductionPercent":100.0 * (1.0 - actual_total as f64 / source_total as f64),"finalizeSeconds":encode_seconds,"sampledSsimAgainstPreviousOutput":ssim,"timelineUnchanged":true,"fixtureNativeExtentSource":old_source,"nativeExtentSource":new_source,"fixtureOutputEndMs":old_end,"outputEndMs":new_end,"outputEndToleranceMs":output_end_tolerance_ms,"fullDecodePassed":true,"audioBytesUnchanged":true,"originalUntouched":true});
        fs::write(
            folder.join("verification.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        fs::write(
            workspace.join("test-results/recording-size-verification.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
        println!("{report}");
    }

    #[test]
    fn quest_virtual_filters_are_not_offered_as_cameras() {
        let text = "[dshow] \"Meta Quest 3\" (video)\n[dshow] \"Meta Quest Pro\" (video)\n[dshow] \"Oculus Quest 2\" (video)\n[dshow] \"HD Pro Webcam C920\" (video)";
        assert_eq!(dshow_names(text), vec!["HD Pro Webcam C920"]);
        assert_eq!(
            adb_sources("serial device model:Quest_3")[0].name,
            "Quest 3"
        );
    }
    #[test]
    fn a_cancelled_command_is_killed_at_once() {
        // Five seconds, unless killed.
        #[cfg(windows)]
        let command = {
            let mut command = std::process::Command::new("ping");
            command.args(["-n", "6", "127.0.0.1"]);
            command
        };
        #[cfg(not(windows))]
        let command = {
            let mut command = std::process::Command::new("sleep");
            command.arg("5");
            command
        };
        let started = Instant::now();
        let cancelled = || started.elapsed() > Duration::from_millis(100);
        let result = output_until(command, Duration::from_secs(30), &cancelled);
        assert_eq!(result.err().as_deref(), Some("Capture command was stopped"));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn scrcpy_readiness_uses_first_complete_decoded_texture_line() {
        let mut seen = None;
        for log in [
            "INFO: Renderer: direct3d11\n",
            "INFO: Recording started\n",
            "[server] INFO: Texture: 4128x2208\n",
            "VERBOSE: Creating new texture: size=4128x2208\n",
            "INFO: Texture: 0x2208\n",
            "INFO: Texture: 4128x2208",
        ] {
            assert_eq!(latch_scrcpy_frame(log, &mut seen, 0.5), None);
        }
        assert_eq!(
            latch_scrcpy_frame("INFO: Texture: 4128x2208\r\n", &mut seen, 0.6),
            Some((0.6, (4128, 2208)))
        );
        // Latched with the delay: a later rotation's size, or a log that
        // could not be read while the window is awaited, changes neither.
        for log in ["INFO: Texture: 2208x4128\n", ""] {
            assert_eq!(
                latch_scrcpy_frame(log, &mut seen, 5.6),
                Some((0.6, (4128, 2208)))
            );
        }
        // The canvas is the first complete line's size, not a later rotation's.
        assert_eq!(
            scrcpy_texture(
                "INFO: Texture: 0x2208\nINFO: Texture: 1080x2400\r\nINFO: Texture: 2400x1080\n"
            ),
            Some((1080, 2400))
        );
        assert_eq!(scrcpy_texture("INFO: Texture: 1080x2400"), None);
    }
    #[test]
    fn device_audio_preserves_native_offset_before_host_zero_trimming() {
        let (offset, filter) = device_audio_filter(0.6, 0.0, 0.097);
        assert!((offset - 0.697).abs() < 1e-9);
        assert!(filter.contains("adelay=697.000000"));
        let (offset, filter) = device_audio_filter(0.6, 0.1, 0.0);
        assert!((offset - 0.5).abs() < 1e-9);
        assert!(filter.contains("adelay=500.000000"));
        assert!(!filter.contains("atrim"));
        let (offset, filter) = device_audio_filter(0.05, 0.1, 0.0);
        assert!((offset + 0.05).abs() < 1e-9);
        assert!(filter.starts_with("atrim=start=0.050000,asetpts="));
        assert_eq!(stream_starts(&serde_json::json!({"streams":[{"codec_type":"video","start_time":"0.0"},{"codec_type":"audio","start_time":"0.097"}]})).unwrap(), (0.0, 0.097));
        assert!(stream_starts(&serde_json::json!({"streams":[{"codec_type":"video","start_time":"NaN"},{"codec_type":"audio","start_time":"0"}]})).is_err());
    }
    #[test]
    fn device_tail_uses_packet_extent_without_changing_start_anchor() {
        let info = serde_json::json!({"streams":[{"index":0,"codec_type":"video","start_time":"0.000"}],"packets":[{"stream_index":0,"pts_time":"0.000","duration_time":"0.001"},{"stream_index":0,"pts_time":"4.098","duration_time":"0.001"}]});
        let end = mapped_device_end(&info, 0.645, 30).unwrap();
        assert!((end - (0.645 + 4.098 + 1.0 / 30.0)).abs() < 1e-9);
        let mut info = info;
        info["streams"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"index":1,"codec_type":"audio","start_time":"0.097"}));
        info["packets"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"stream_index":1,"pts_time":"4.200","duration_time":"0.021"}));
        assert!((mapped_device_end(&info, 0.645, 30).unwrap() - 4.866).abs() < 1e-9);
        assert!(
            mapped_device_end(&serde_json::json!({"streams":[],"packets":[]}), 0.6, 30).is_err()
        );
    }
    #[test]
    fn device_metadata_extent_requires_valid_trailer_times() {
        let mut info = serde_json::json!({"streams":[{"index":0,"codec_type":"video","start_time":"0.0"}],"format":{"start_time":"0.0","duration":"4.198"}});
        assert!(
            (metadata_device_end(&info, 0.645, 30).unwrap() - (0.645 + 4.198 + 1.0 / 30.0)).abs()
                < 1e-9
        );
        for invalid in ["N/A", "NaN", "0", "-1"] {
            info["format"]["duration"] = serde_json::json!(invalid);
            assert!(metadata_device_end(&info, 0.645, 30).is_none());
        }
        assert!(metadata_device_end(&serde_json::json!({}), 0.645, 30).is_none());
    }
    #[test]
    #[ignore = "Compares metadata fastpath against retained native packet evidence from the three real Quest CLI recordings"]
    fn actual_quest_metadata_extent_covers_retained_packet_extents() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("test-results/quest/latest-run.json")).unwrap(),
        )
        .unwrap();
        let evidence = PathBuf::from(manifest["evidenceDir"].as_str().unwrap());
        let mut comparisons = Vec::new();
        for phase in [
            "video-only-4s",
            "pc-microphone-4s",
            "device-audio-microphone-6s",
        ] {
            let read = |suffix| {
                serde_json::from_slice::<serde_json::Value>(
                    &fs::read(evidence.join(format!("{phase}.{suffix}"))).unwrap(),
                )
                .unwrap()
            };
            let metadata = read("native-video.mkv.probe.json");
            let packets = read("native-packets.json");
            let result = read("result.json");
            let delay = result["captureTiming"]["videoHostStartMs"]
                .as_f64()
                .unwrap()
                / 1000.0;
            let fast = metadata_device_end(&metadata, delay, 30).unwrap();
            let precise = mapped_device_end(&packets, delay, 30).unwrap();
            assert!(
                fast >= precise && fast - precise < 0.2,
                "Metadata failed to conservatively cover real packets: {phase}"
            );
            comparisons.push(serde_json::json!({"phase":phase,"metadataMappedEndMs":fast*1000.0,"packetMappedEndMs":precise*1000.0,"conservativePaddingMs":(fast-precise)*1000.0}));
        }
        fs::write(
            evidence.join("metadata-fastpath-comparison.json"),
            serde_json::to_vec_pretty(&comparisons).unwrap(),
        )
        .unwrap();
    }
    #[test]
    fn parses_only_video_devices() {
        assert_eq!(dshow_names("[dshow] \"Quest Link\" (video)\n[dshow] Alternative name \"@device\"\n[dshow] \"Mic\" (audio)"), vec!["Quest Link"]);
    }
    #[test]
    fn adb_sources_keep_unauthorized_and_offline_devices_visible() {
        let devices = adb_sources("List of devices attached\nQUEST123 unauthorized usb:2-1\nPHONE123 offline transport_id:2\nREADY123 device product:hollywood model:Quest_3 device:hollywood transport_id:3\n");
        assert_eq!(devices.len(), 3);
        assert_eq!(devices[0].id, "android:QUEST123");
        assert!(!devices[0].available);
        assert!(devices[0].detail.as_deref().unwrap().contains("accept"));
        assert!(!devices[1].available);
        assert!(devices[1].detail.as_deref().unwrap().contains("reconnect"));
        assert!(devices[2].available);
        assert_eq!(devices[2].kind, "quest");
        assert_eq!(devices[2].name, "Quest 3");
    }
    #[test]
    fn adb_sources_show_an_explicit_disabled_waiting_state() {
        let devices = adb_sources("List of devices attached\n\n");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "android:waiting");
        assert!(!devices[0].available);
        assert!(devices[0].name.contains("waiting for device"));
    }
    /// A synthetic audio device for `AudioWriter`: 10 ms packets from `start` to `until` take
    /// seconds, its clock running `speed` times the wall clock, its timestamps jittering by up to
    /// `jitter` seconds, delivering nothing in `gaps` and muted in `muted`. It plays a quiet tone
    /// with a loud 1 kHz burst 10 ms long at `marker`.
    struct Device {
        start: f64,
        until: f64,
        speed: f64,
        jitter: f64,
        gaps: Vec<(f64, f64)>,
        muted: Option<(f64, f64)>,
        marker: f64,
    }
    const TRACK_RATE: u32 = 8000;
    impl Device {
        fn steady(until: f64) -> Self {
            Self {
                start: 0.0,
                until,
                speed: 1.0,
                jitter: 0.0,
                gaps: Vec::new(),
                muted: None,
                marker: f64::MAX,
            }
        }
        fn signal(&self, t: f64) -> f32 {
            use std::f64::consts::TAU;
            if (self.marker..self.marker + 0.01).contains(&t) {
                (TAU * 1000.0 * t).sin() as f32
            } else {
                (0.2 * (TAU * 220.0 * t + 0.3).sin()) as f32
            }
        }
        /// Records a take of `duration` seconds and returns its finished track.
        fn record(&self, duration: f64) -> Vec<f32> {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("mic.wav");
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: TRACK_RATE,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            };
            let mut writer = AudioWriter::new(
                hound::WavWriter::create(&path, spec).unwrap(),
                &path,
                TRACK_RATE,
            );
            let rate = TRACK_RATE as f64 * self.speed;
            let (mut sample, mut seed) = (0u64, 7u64);
            loop {
                let t = self.start + sample as f64 / rate;
                if t >= self.until {
                    break;
                }
                let packet: Vec<f32> = (0..80)
                    .map(|i| self.signal(self.start + (sample + i) as f64 / rate))
                    .collect();
                sample += 80;
                if self.gaps.iter().any(|(from, to)| (*from..*to).contains(&t)) {
                    continue;
                }
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let jitter = ((seed >> 33) as f64 / (1u64 << 31) as f64 - 0.5) * 2.0 * self.jitter;
                let muted = self.muted.is_some_and(|(from, to)| (from..to).contains(&t));
                writer
                    .packet(&packet, 1, t - self.start + jitter, self.start, muted)
                    .unwrap();
            }
            writer.finish(Duration::from_secs_f64(duration)).unwrap();
            hound::WavReader::open(&path)
                .unwrap()
                .samples()
                .map(Result::unwrap)
                .collect()
        }
    }
    /// The take second at which the burst starts in `track`, searching from `after`.
    fn burst(track: &[f32], after: f64) -> f64 {
        let from = (after * TRACK_RATE as f64) as usize;
        let at = from + track[from..].iter().position(|s| s.abs() > 0.6).unwrap();
        at as f64 / TRACK_RATE as f64
    }
    fn seconds(track: &[f32], from: f64, to: f64) -> &[f32] {
        &track[(from * TRACK_RATE as f64) as usize..(to * TRACK_RATE as f64) as usize]
    }
    #[test]
    fn drifting_jittering_audio_has_no_holes() {
        for speed in [0.99, 0.9933, 1.01] {
            let device = Device {
                start: 0.25,
                speed,
                jitter: 0.002,
                ..Device::steady(16.0)
            };
            let track = device.record(16.0);
            assert_eq!(track.len(), 16 * TRACK_RATE as usize, "speed {speed}");
            // Placing packets by their timestamps left a zero wherever the device ran slow.
            let holes = seconds(&track, 0.26, 15.99)
                .iter()
                .filter(|s| **s == 0.0)
                .count();
            assert_eq!(holes, 0, "speed {speed}");
            assert!(seconds(&track, 0.0, 0.24).iter().all(|s| *s == 0.0));
        }
    }
    #[test]
    fn drifting_audio_is_resampled_to_the_take_length() {
        // A slow device had holes and a fast one had samples dropped: both keep every sample.
        for speed in [0.99, 1.01] {
            let device = Device {
                start: 0.1,
                speed,
                jitter: 0.002,
                marker: 15.0,
                ..Device::steady(20.0)
            };
            let track = device.record(20.0);
            assert_eq!(track.len(), 20 * TRACK_RATE as usize, "speed {speed}");
            let at = burst(&track, 14.5);
            assert!((at - 15.0).abs() < 0.005, "speed {speed}: burst at {at}");
        }
    }
    #[test]
    fn a_gap_over_50_ms_stays_silence() {
        let device = Device {
            speed: 0.995,
            gaps: vec![(5.0, 7.0)],
            marker: 8.0,
            ..Device::steady(10.0)
        };
        let track = device.record(10.0);
        assert_eq!(track.len(), 10 * TRACK_RATE as usize);
        assert!(seconds(&track, 5.01, 6.99).iter().all(|s| s.abs() < 1e-3));
        let at = burst(&track, 7.5);
        assert!((at - 8.0).abs() < 0.005, "burst at {at}");
    }
    #[test]
    fn a_gap_in_the_first_second_keeps_a_drifting_track_in_place() {
        let device = Device {
            speed: 0.99,
            jitter: 0.002,
            gaps: vec![(0.5, 2.5)],
            marker: 10.0,
            ..Device::steady(12.0)
        };
        let track = device.record(12.0);
        assert_eq!(track.len(), 12 * TRACK_RATE as usize);
        assert!(seconds(&track, 0.51, 2.49).iter().all(|s| s.abs() < 1e-3));
        let at = burst(&track, 9.5);
        assert!((at - 10.0).abs() < 0.005, "burst at {at}");
    }
    #[test]
    fn a_long_gap_after_a_short_run_keeps_what_follows_in_place() {
        let device = Device {
            jitter: 0.002,
            gaps: vec![(1.2, 61.2)],
            marker: 62.0,
            ..Device::steady(64.0)
        };
        let track = device.record(64.0);
        assert_eq!(track.len(), 64 * TRACK_RATE as usize);
        assert!(seconds(&track, 1.21, 61.19).iter().all(|s| s.abs() < 1e-3));
        let at = burst(&track, 61.5);
        assert!((at - 62.0).abs() < 0.005, "burst at {at}");
    }
    /// Resamples `input` by `ratio` into `count` samples.
    fn resampled(input: &[f32], ratio: f64, count: u64) -> Vec<f32> {
        let mut output = Vec::new();
        resample(
            &mut input.iter().map(|s| Ok(*s)),
            input.len() as u64,
            ratio,
            &sinc_table(ratio.min(1.0)),
            count,
            &mut |s| {
                output.push(s);
                Ok(())
            },
        )
        .unwrap();
        output
    }
    #[test]
    fn resampling_by_one_returns_the_input() {
        let input: Vec<f32> = (0..1000)
            .map(|i| ((i * 37 % 101) as f32 - 50.0) / 50.0)
            .collect();
        let output = resampled(&input, 1.0, 1000);
        assert!(input.iter().zip(&output).all(|(a, b)| (a - b).abs() < 1e-6));
    }
    #[test]
    fn resampling_a_sine_keeps_its_amplitude_and_scales_its_frequency() {
        use std::f64::consts::TAU;
        let input: Vec<f32> = (0..4000)
            .map(|i| (TAU * 0.05 * i as f64).sin() as f32)
            .collect();
        for ratio in [0.98, 1.0067, 1.02] {
            let count = (4000.0 * ratio) as u64;
            let output = resampled(&input, ratio, count);
            assert_eq!(output.len() as u64, count);
            for (j, sample) in output.iter().enumerate().take(count as usize - 40).skip(40) {
                let expected = (TAU * 0.05 * j as f64 / ratio).sin() as f32;
                assert!(
                    (sample - expected).abs() < 2e-3,
                    "ratio {ratio}, sample {j}"
                );
            }
        }
    }
    #[test]
    fn muted_audio_is_silent_and_keeps_its_length() {
        let device = Device {
            muted: Some((2.0, 3.0)),
            ..Device::steady(4.0)
        };
        let track = device.record(4.0);
        assert_eq!(track.len(), 4 * TRACK_RATE as usize);
        assert!(seconds(&track, 2.01, 2.99).iter().all(|s| *s == 0.0));
        assert!(seconds(&track, 0.5, 1.5).iter().all(|s| *s != 0.0));
        assert!(seconds(&track, 3.01, 3.99).iter().all(|s| *s != 0.0));
    }
    #[test]
    fn a_track_with_too_little_audio_to_measure_is_padded() {
        let track = Device::steady(0.5).record(0.75);
        assert_eq!(track.len(), 6000);
        assert!(seconds(&track, 0.5, 0.75).iter().all(|s| *s == 0.0));
    }
    #[test]
    fn the_level_is_the_loudest_since_it_was_read() {
        let level = AtomicU32::new(0);
        for rms in [0.01, 0.2, 0.05] {
            hold_level(&level, rms);
        }
        assert_eq!(take_level(&level), 0.2);
        assert_eq!(take_level(&level), 0.0);
        hold_level(&level, 0.03);
        assert_eq!(take_level(&level), 0.03);
    }
    #[test]
    fn snapshot_has_a_finite_latest_30_second_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mic.wav");
        let target = dir.path().join("snapshot.wav");
        let mut wav = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 1000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        for sample in 0..40_000 {
            wav.write_sample(sample as f32 / 40_000.0).unwrap();
        }
        let mut state = AudioWriter::new(wav, &path, 1000);
        state.frames = 40_000;
        let writer = Arc::new(Mutex::new(state));
        assert_eq!(
            snapshot_track(&path, &writer, &target, None).unwrap(),
            (10_000, 40_000)
        );
        // From a point: up to 60 s of it, and nothing past the end.
        let from = dir.path().join("from.wav");
        assert_eq!(
            snapshot_track(&path, &writer, &from, Some(39_500)).unwrap(),
            (39_500, 40_000)
        );
        assert_eq!(hound::WavReader::open(&from).unwrap().duration(), 500);
        assert_eq!(
            snapshot_track(&path, &writer, &from, Some(50_000)).unwrap(),
            (40_000, 40_000)
        );
        let mut snapshot = hound::WavReader::open(&target).unwrap();
        assert_eq!(snapshot.duration(), 30_000);
        let data: Vec<f32> = snapshot.samples().map(Result::unwrap).collect();
        assert_eq!(data[0], 0.25);
        assert_eq!(data[29_999], 39_999.0 / 40_000.0);
        let mut state = writer.lock().unwrap();
        for _ in 0..1000 {
            state.wav.as_mut().unwrap().write_sample(0.75f32).unwrap();
        }
        state.frames += 1000;
        state.finish(Duration::from_secs(41)).unwrap();
        assert_eq!(hound::WavReader::open(target).unwrap().duration(), 30_000);
        assert_eq!(hound::WavReader::open(path).unwrap().duration(), 41_000);
    }
    #[test]
    #[ignore = "Records the actual Windows display, microphone and system audio for 3 seconds"]
    #[cfg(windows)]
    fn actual_windows_capture() {
        let folder = PathBuf::from(
            std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR")
                .expect("Set CUEREVIEW_CAPTURE_TEST_DIR to retain test evidence"),
        );
        fs::create_dir_all(&folder).unwrap();
        let monitor = sources()
            .unwrap()
            .into_iter()
            .find(|s| s.kind == "display")
            .unwrap();
        assert!(preview(&monitor.id)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let mut capture = start(
            CaptureConfig {
                source_id: monitor.id,
                microphone_id: Some("default".into()),
                system_audio: true,
                fps: 15,
            },
            &folder,
        )
        .unwrap();
        thread::sleep(Duration::from_secs(1));
        capture.set_muted(true);
        thread::sleep(Duration::from_millis(500));
        capture.set_muted(false);
        thread::sleep(Duration::from_millis(1500));
        capture.stop().unwrap();
        assert!(folder.join("video.mp4").metadata().unwrap().len() > 1024);
        for name in ["mic.wav", "system.wav", "audio.wav"] {
            assert!(
                hound::WavReader::open(folder.join(name))
                    .unwrap()
                    .duration()
                    > 48000
            );
        }
    }
    #[test]
    #[ignore = "Plays two quiet test tones and records actual WASAPI loopback"]
    #[cfg(windows)]
    fn actual_loopback_silence_gaps() {
        let folder =
            PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap()).join("loopback");
        let mut capture = start(
            CaptureConfig {
                source_id: format!("monitor:{}", Monitor::primary().unwrap().index().unwrap()),
                microphone_id: None,
                system_audio: true,
                fps: 15,
            },
            &folder,
        )
        .unwrap();
        let tone = || {
            let device = cpal::default_host().default_output_device().unwrap();
            let supported = device.default_output_config().unwrap();
            assert_eq!(supported.sample_format(), cpal::SampleFormat::F32);
            let config: cpal::StreamConfig = supported.into();
            let channels = config.channels as usize;
            let rate = config.sample_rate.0 as f32;
            let mut phase = 0.0f32;
            let stream = device
                .build_output_stream(
                    &config,
                    move |out: &mut [f32], _| {
                        for frame in out.chunks_mut(channels) {
                            let value = phase.sin() * 0.025;
                            frame.fill(value);
                            phase = (phase + std::f32::consts::TAU * 440.0 / rate)
                                % std::f32::consts::TAU;
                        }
                    },
                    |e| eprintln!("Test tone error: {e}"),
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            stream
        };
        thread::sleep(Duration::from_millis(350));
        let first = capture.elapsed_ms();
        let stream = tone();
        thread::sleep(Duration::from_millis(400));
        drop(stream);
        thread::sleep(Duration::from_millis(550));
        let second = capture.elapsed_ms();
        let stream = tone();
        thread::sleep(Duration::from_millis(400));
        drop(stream);
        thread::sleep(Duration::from_millis(350));
        capture.stop().unwrap();
        let mut wav = hound::WavReader::open(folder.join("system.wav")).unwrap();
        let rate = wav.spec().sample_rate as f64;
        let samples: Vec<f32> = wav.samples().map(Result::unwrap).collect();
        let rms = |start_ms: u64, end_ms: u64| {
            let a = (start_ms as f64 * rate / 1000.0) as usize;
            let b = (end_ms as f64 * rate / 1000.0) as usize;
            (samples[a..b].iter().map(|x| x * x).sum::<f32>() / (b - a) as f32).sqrt()
        };
        let first_rms = rms(first + 150, first + 300);
        let second_rms = rms(second + 150, second + 300);
        let gap_rms = rms(first + 650, second - 100);
        fs::write(folder.join("tone-timing.json"), format!("{{\"firstToneMs\":{first},\"secondToneMs\":{second},\"firstRms\":{first_rms},\"secondRms\":{second_rms},\"gapRms\":{gap_rms},\"durationMs\":{}}}", capture.elapsed_ms())).unwrap();
        // WASAPI reflects the endpoint/session volume, which may be very low on a test host.
        assert!(first_rms > 1e-9, "First loopback tone absent");
        assert!(second_rms > 1e-9, "Second loopback tone absent");
        assert!(
            gap_rms < first_rms.min(second_rms) * 0.01,
            "Silent gap collapsed or shifted"
        );
        for start in [first + 150, second + 150] {
            let a = (start as f64 * rate / 1000.0) as usize;
            let count = (rate * 0.15) as usize;
            let (mut sine, mut cosine) = (0.0f64, 0.0f64);
            for (i, sample) in samples[a..a + count].iter().enumerate() {
                let phase = std::f64::consts::TAU * 440.0 * i as f64 / rate;
                sine += *sample as f64 * phase.sin();
                cosine += *sample as f64 * phase.cos();
            }
            let amplitude = 2.0 * sine.hypot(cosine) / count as f64;
            assert!(
                amplitude / (rms(start, start + 150) as f64 * std::f64::consts::SQRT_2) > 0.8,
                "Loopback did not retain the generated 440 Hz tone"
            );
        }
        let mut export_results = Vec::new();
        for name in ["audio.wav", "video.mp4"] {
            let mut cmd = deps::command("ffmpeg").unwrap();
            cmd.args(["-v", "error", "-i"])
                .arg(folder.join(name))
                .args(["-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"]);
            let output = output_with_timeout(cmd, Duration::from_secs(15)).unwrap();
            assert!(output.status.success());
            let decoded: Vec<f32> = output
                .stdout
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect();
            for start in [first + 150, second + 150] {
                let a = (start as f64 * rate / 1000.0) as usize;
                let count = (rate * 0.15) as usize;
                let values = &decoded[a..a + count];
                let rms = (values.iter().map(|x| x * x).sum::<f32>() / count as f32).sqrt();
                let (mut sine, mut cosine) = (0.0f64, 0.0f64);
                for (i, sample) in values.iter().enumerate() {
                    let phase = std::f64::consts::TAU * 440.0 * i as f64 / rate;
                    sine += *sample as f64 * phase.sin();
                    cosine += *sample as f64 * phase.cos();
                }
                let amplitude = 2.0 * sine.hypot(cosine) / count as f64;
                assert!(
                    rms > first_rms * 0.5 && rms < first_rms * 2.0,
                    "{name} lost the quiet system signal or changed its gain"
                );
                assert!(
                    amplitude / (rms as f64 * std::f64::consts::SQRT_2) > 0.8,
                    "{name} lost the440Hz system waveform"
                );
                export_results.push(format!(
                    "{{\"file\":\"{name}\",\"startMs\":{start},\"rms\":{rms}}}"
                ));
            }
        }
        fs::write(
            folder.join("export-audio-analysis.json"),
            format!("[{}]", export_results.join(",")),
        )
        .unwrap();
    }
    #[test]
    #[ignore = "Records the actual foreground Windows window"]
    #[cfg(windows)]
    fn actual_window_capture() {
        let folder =
            PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap()).join("window");
        let window = Window::foreground().unwrap();
        let source_id = format!("window:{}", window.as_raw_hwnd() as usize);
        assert!(preview(&source_id)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let mut capture = start(
            CaptureConfig {
                source_id,
                microphone_id: None,
                system_audio: false,
                fps: 15,
            },
            &folder,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(1200));
        capture.stop().unwrap();
        assert!(folder.join("video.mp4").metadata().unwrap().len() > 1024);
    }
    #[test]
    #[ignore = "Creates a temporary odd-sized Windows window, captures it, then closes the source"]
    #[cfg(windows)]
    fn actual_source_close_and_odd_geometry() {
        use std::ffi::c_void;
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
            fn DestroyWindow(window: *mut c_void) -> i32;
            fn UpdateWindow(window: *mut c_void) -> i32;
            fn SetWindowPos(
                window: *mut c_void,
                after: *mut c_void,
                x: i32,
                y: i32,
                width: i32,
                height: i32,
                flags: u32,
            ) -> i32;
        }
        struct TestWindow(*mut c_void);
        impl Drop for TestWindow {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe {
                        DestroyWindow(self.0);
                    }
                }
            }
        }
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "CueReview capture verification\0".encode_utf16().collect();
        let mut window = TestWindow(unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                0x10cf0000,
                50,
                50,
                655,
                433,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        });
        assert!(!window.0.is_null());
        unsafe {
            UpdateWindow(window.0);
        }
        let folder = PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap())
            .join("source-close");
        let mut capture = start(
            CaptureConfig {
                source_id: format!("window:{}", window.0 as usize),
                microphone_id: None,
                system_audio: false,
                fps: 15,
            },
            &folder,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(250));
        unsafe {
            assert_ne!(
                SetWindowPos(window.0, std::ptr::null_mut(), 0, 0, 801, 601, 0x16),
                0
            );
        }
        thread::sleep(Duration::from_millis(250));
        unsafe {
            assert_ne!(
                SetWindowPos(window.0, std::ptr::null_mut(), 0, 0, 401, 301, 0x16),
                0
            );
        }
        thread::sleep(Duration::from_millis(250));
        unsafe {
            DestroyWindow(window.0);
        }
        window.0 = std::ptr::null_mut();
        thread::sleep(Duration::from_millis(150));
        let error = capture
            .stop()
            .expect_err("A closed source must be reported");
        assert!(
            error.contains("closed") || error.contains("stopped"),
            "{error}"
        );
        assert!(
            folder.join("video.mp4").metadata().unwrap().len() > 1024,
            "Partial recording must be finalized"
        );
        assert!(
            folder.join("native-video.mp4").exists(),
            "Failed captures must retain their original video"
        );
        let probe = deps::command("ffprobe")
            .unwrap()
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
            ])
            .arg(folder.join("video.mp4"))
            .output()
            .unwrap();
        let dimensions: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
        assert_eq!(dimensions["streams"][0]["width"], 640);
        assert_eq!(dimensions["streams"][0]["height"], 426);
    }
    #[test]
    #[ignore = "Records the microphone with mute enabled before capture initialization"]
    #[cfg(windows)]
    fn actual_initial_mute() {
        let folder = PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap())
            .join("initial-mute");
        let mut capture = start_muted(
            CaptureConfig {
                source_id: format!("monitor:{}", Monitor::primary().unwrap().index().unwrap()),
                microphone_id: Some("default".into()),
                system_audio: false,
                fps: 15,
            },
            &folder,
            true,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(300));
        capture.stop().unwrap();
        let mut wav = hound::WavReader::open(folder.join("mic.wav")).unwrap();
        assert!(wav.duration() > wav.spec().sample_rate / 3);
        assert!(
            wav.samples::<f32>().all(|s| s.unwrap() == 0.0),
            "Initial mute leaked microphone samples during setup"
        );
    }
    #[test]
    #[ignore = "Takes consistent microphone snapshots while actual Windows recording continues"]
    #[cfg(windows)]
    fn actual_live_audio_snapshots() {
        let folder = PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap())
            .join("snapshots");
        let mut capture = start_muted(
            CaptureConfig {
                source_id: format!("monitor:{}", Monitor::primary().unwrap().index().unwrap()),
                microphone_id: Some("default".into()),
                system_audio: false,
                fps: 15,
            },
            &folder,
            true,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(300));
        let before = Instant::now();
        let (start, first_end) = capture.snapshot_audio(&folder.join("first.wav")).unwrap();
        let snapshot_ms = before.elapsed().as_millis();
        assert_eq!(start, 0);
        assert!(first_end >= 300);
        assert!(snapshot_ms < 2000);
        assert!(hound::WavReader::open(folder.join("first.wav"))
            .unwrap()
            .samples::<f32>()
            .all(|s| s.unwrap() == 0.0));
        capture.set_muted(false);
        thread::sleep(Duration::from_millis(500));
        let (_, second_end) = capture.snapshot_audio(&folder.join("second.wav")).unwrap();
        assert!(second_end > first_end + 300);
        assert!(capture.error().is_none());
        capture.stop().unwrap();
        let mut final_audio = hound::WavReader::open(folder.join("mic.wav")).unwrap();
        let rate = final_audio.spec().sample_rate;
        assert!(final_audio.duration() as u64 * 1000 / rate as u64 >= second_end);
        let samples: Vec<f32> = final_audio.samples().map(Result::unwrap).collect();
        assert!(
            samples[(first_end as usize * rate as usize / 1000 + rate as usize / 10)..]
                .iter()
                .any(|s| *s != 0.0),
            "Capture did not resume after snapshot and unmute"
        );
        assert!(capture.snapshot_audio(&folder.join("stopped.wav")).is_err());
        fs::write(folder.join("snapshot-timing.json"), format!("{{\"firstEndMs\":{first_end},\"secondEndMs\":{second_end},\"snapshotWorkMs\":{snapshot_ms}}}")).unwrap();
    }
    #[test]
    #[ignore = "Records 31 seconds of actual desktop/system audio with early and late audiovisual pulses"]
    #[cfg(windows)]
    fn actual_desktop_sync_over_static_interval() {
        const SYNC_FPS: u32 = 30;
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
            fn DestroyWindow(window: *mut c_void) -> i32;
            fn UpdateWindow(window: *mut c_void) -> i32;
            fn SetWindowLongPtrW(window: *mut c_void, index: i32, value: isize) -> isize;
            fn InvalidateRect(window: *mut c_void, rect: *const c_void, erase: i32) -> i32;
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
        let pump = || {
            let mut message: Message = unsafe { std::mem::zeroed() };
            unsafe {
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        };
        struct Tile(*mut c_void);
        impl Drop for Tile {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "CueReview AV sync verification\0".encode_utf16().collect();
        let tile = |style| {
            Tile(unsafe {
                CreateWindowExW(
                    0x08000008,
                    class.as_ptr(),
                    title.as_ptr(),
                    style,
                    100,
                    100,
                    320,
                    180,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            })
        };
        let black = tile(0x90000004);
        assert!(!black.0.is_null());
        let paint = |white: bool| unsafe {
            SetWindowLongPtrW(black.0, -16, if white { 0x90000006 } else { 0x90000004 });
            InvalidateRect(black.0, std::ptr::null(), 1);
            UpdateWindow(black.0);
        };
        paint(true);
        pump();
        let source_id = format!("monitor:{}", Monitor::primary().unwrap().index().unwrap());
        let preview_bytes = base64::engine::general_purpose::STANDARD
            .decode(preview(&source_id).unwrap().split(',').nth(1).unwrap())
            .unwrap();
        let preview_image = image::load_from_memory(&preview_bytes).unwrap().to_luma8();
        assert!(
            preview_image.get_pixel(200, 150)[0] > 180,
            "The visual sync marker did not repaint"
        );
        paint(false);
        pump();
        let folder = PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap())
            .join(format!("long-sync-{SYNC_FPS}fps"));
        let mut capture = start(
            CaptureConfig {
                source_id,
                microphone_id: None,
                system_audio: true,
                fps: SYNC_FPS,
            },
            &folder,
        )
        .unwrap();
        let tone = || {
            let device = cpal::default_host().default_output_device().unwrap();
            let supported = device.default_output_config().unwrap();
            assert_eq!(supported.sample_format(), cpal::SampleFormat::F32);
            let config: cpal::StreamConfig = supported.into();
            let channels = config.channels as usize;
            let rate = config.sample_rate.0 as f32;
            let mut phase = 0.0f32;
            let stream = device
                .build_output_stream(
                    &config,
                    move |out: &mut [f32], _| {
                        for frame in out.chunks_mut(channels) {
                            frame.fill(phase.sin() * 0.025);
                            phase = (phase + std::f32::consts::TAU * 440.0 / rate)
                                % std::f32::consts::TAU;
                        }
                    },
                    |e| eprintln!("Sync test output failed: {e}"),
                    None,
                )
                .unwrap();
            stream.play().unwrap();
            stream
        };
        let wait_until = |capture: &ActiveCapture, ms: u64| {
            while capture.elapsed_ms() < ms {
                pump();
                thread::sleep(Duration::from_millis(2));
            }
        };
        let mut scheduled = Vec::new();
        let late_ms = std::env::var("CUEREVIEW_SYNC_TEST_LATE_MS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(29_000)
            .max(3_000);
        for at in [1_000u64, late_ms] {
            wait_until(&capture, at);
            scheduled.push(capture.elapsed_ms());
            paint(true);
            let stream = tone();
            wait_until(&capture, capture.elapsed_ms() + 400);
            drop(stream);
            paint(false);
        }
        wait_until(&capture, late_ms + 2_000);
        let stopped_ms = capture.elapsed_ms();
        let finalization_started = Instant::now();
        capture.stop().unwrap();
        let finish_latency_ms = finalization_started.elapsed().as_millis();
        drop(black);
        let mut decode = deps::command("ffmpeg").unwrap();
        decode
            .args(["-v", "error", "-i"])
            .arg(folder.join("video.mp4"))
            .args(["-vn", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"]);
        let output = output_with_timeout(decode, Duration::from_secs(30)).unwrap();
        assert!(output.status.success());
        let audio: Vec<f32> = output
            .stdout
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        let mut decode = deps::command("ffmpeg").unwrap();
        decode
            .args(["-v", "error", "-i"])
            .arg(folder.join("video.mp4"))
            .args([
                "-an",
                "-vf",
                "crop=320:180:100:100,scale=1:1:flags=area,format=gray",
                "-f",
                "rawvideo",
                "pipe:1",
            ]);
        let output = output_with_timeout(decode, Duration::from_secs(30)).unwrap();
        assert!(output.status.success());
        let pixels = output.stdout;
        let mut measurements = Vec::new();
        let mut offsets = Vec::new();
        for &expected in &scheduled {
            let center = expected as usize * 48;
            let peak = audio[center + 4800..center + 14400]
                .iter()
                .copied()
                .map(f32::abs)
                .fold(0.0f32, f32::max);
            assert!(peak > 1e-9, "The generated tone did not reach final AAC");
            let begin = center.saturating_sub(19_200);
            let end = center + 19_200;
            let sound = (begin..end)
                .step_by(240)
                .find(|&a| {
                    let rms = (audio[a..a + 240].iter().map(|x| x * x).sum::<f32>() / 240.0).sqrt();
                    rms > peak * 0.2
                })
                .expect("No audio pulse onset") as f64
                / 48.0;
            let visual = pixels
                .iter()
                .enumerate()
                .find(|(i, value)| {
                    **value > 180
                        && (*i as f64 * 1000.0 / SYNC_FPS as f64 - expected as f64).abs() < 400.0
                })
                .expect("No white video pulse")
                .0 as f64
                * 1000.0
                / SYNC_FPS as f64;
            let offset = sound - visual;
            offsets.push(offset);
            measurements.push(serde_json::json!({"scheduledMs":expected,"audioOnsetMs":sound,"videoOnsetMs":visual,"audioMinusVideoMs":offset,"peak":peak}));
        }
        let duration_ms = pixels.len() as f64 * 1000.0 / SYNC_FPS as f64;
        let drift_ms = offsets[1] - offsets[0];
        let static_start = ((scheduled[0] + 800) as f64 * SYNC_FPS as f64 / 1000.0).ceil() as usize;
        let static_end = ((scheduled[1] - 400) as f64 * SYNC_FPS as f64 / 1000.0).floor() as usize;
        let static_ok = pixels[static_start..static_end]
            .iter()
            .all(|value| *value < 180);
        fs::write(folder.join("sync-verification.json"), serde_json::to_vec_pretty(&serde_json::json!({"recordingStopMs":stopped_ms,"videoDurationMs":duration_ms,"finishLatencyMs":finish_latency_ms,"sampleRate":48000,"videoFps":SYNC_FPS,"staticMarkerIntervalSeconds":(late_ms as f64-1400.0)/1000.0,"staticMarkerHasNoEarlyPulse":static_ok,"earlyLateOffsetChangeMs":drift_ms,"pulses":measurements})).unwrap()).unwrap();
        assert!(
            static_ok,
            "A future visual pulse appeared inside the static interval"
        );
        assert!(
            offsets.iter().all(|offset| offset.abs() < 150.0),
            "Audio/video pulse offset exceeds150ms: {offsets:?}"
        );
        assert!(
            drift_ms.abs() < 100.0,
            "Early-to-late audio/video offset changed by{drift_ms}ms"
        );
        assert!(
            (duration_ms - stopped_ms as f64).abs() < 100.0,
            "Static interval changed video duration"
        );
    }
    #[test]
    #[ignore = "Verifies selected-window preview and recording through an actual opaque occluding window"]
    #[cfg(windows)]
    fn actual_selected_window_occlusion() {
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
            fn DestroyWindow(window: *mut c_void) -> i32;
            fn UpdateWindow(window: *mut c_void) -> i32;
            fn ShowWindow(window: *mut c_void, command: i32) -> i32;
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
        struct OwnedWindow(*mut c_void);
        impl Drop for OwnedWindow {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let pump = || {
            let mut message: Message = unsafe { std::mem::zeroed() };
            unsafe {
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        };
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "CueReview occlusion verification\0"
            .encode_utf16()
            .collect();
        let make_window = |ex, style| {
            OwnedWindow(unsafe {
                CreateWindowExW(
                    ex,
                    class.as_ptr(),
                    title.as_ptr(),
                    style,
                    200,
                    200,
                    320,
                    180,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            })
        };
        let source_window = make_window(0x08000000, 0x90000006);
        assert!(!source_window.0.is_null());
        unsafe {
            UpdateWindow(source_window.0);
        }
        pump();
        let source_id = format!("window:{}", source_window.0 as usize);
        let folder = PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap())
            .join("occlusion");
        let mut capture = start(
            CaptureConfig {
                source_id: source_id.clone(),
                microphone_id: None,
                system_audio: false,
                fps: 30,
            },
            &folder,
        )
        .unwrap();
        let covering_window = make_window(0x08000008, 0x90000004);
        assert!(!covering_window.0.is_null());
        unsafe {
            ShowWindow(covering_window.0, 4);
            UpdateWindow(covering_window.0);
        }
        pump();
        let wait_until = Instant::now() + Duration::from_millis(250);
        while Instant::now() < wait_until {
            pump();
            thread::sleep(Duration::from_millis(2));
        }
        let png = |id: &str| {
            let data = preview(id).unwrap();
            base64::engine::general_purpose::STANDARD
                .decode(data.split(',').nth(1).unwrap())
                .unwrap()
        };
        let selected_png = png(&source_id);
        fs::write(folder.join("selected-preview.png"), &selected_png).unwrap();
        let selected = image::load_from_memory(&selected_png).unwrap().to_luma8();
        let source_center = selected.get_pixel(selected.width() / 2, selected.height() / 2)[0];
        let display = image::load_from_memory(&png(&format!(
            "monitor:{}",
            Monitor::primary().unwrap().index().unwrap()
        )))
        .unwrap()
        .to_luma8();
        let desktop_center = display.get_pixel(360, 290)[0];
        image::imageops::crop_imm(&display, 200, 200, 320, 180)
            .to_image()
            .save(folder.join("desktop-covered-region.png"))
            .unwrap();
        assert!(
            desktop_center < 180,
            "The opaque test window did not cover the source on the desktop: {desktop_center}"
        );
        assert!(
            source_center > 220,
            "Selected-window preview captured the occluder instead of the source: {source_center}"
        );
        let wait_until = Instant::now() + Duration::from_millis(400);
        while Instant::now() < wait_until {
            pump();
            thread::sleep(Duration::from_millis(2));
        }
        capture.stop().unwrap();
        drop(covering_window);
        drop(source_window);
        let mut decode = deps::command("ffmpeg").unwrap();
        decode
            .args(["-v", "error", "-i"])
            .arg(folder.join("video.mp4"))
            .args([
                "-an",
                "-vf",
                "crop=100:100:(iw-100)/2:(ih-100)/2,scale=1:1:flags=area,format=gray",
                "-f",
                "rawvideo",
                "pipe:1",
            ]);
        let output = output_with_timeout(decode, Duration::from_secs(10)).unwrap();
        assert!(output.status.success() && !output.stdout.is_empty());
        let minimum = *output.stdout.iter().min().unwrap();
        let maximum = *output.stdout.iter().max().unwrap();
        fs::write(folder.join("occlusion-verification.json"), serde_json::to_vec_pretty(&serde_json::json!({"desktopCoveredCenterLuma":desktop_center,"selectedPreviewCenterLuma":source_center,"recordedFrameCenterMinimumLuma":minimum,"recordedFrameCenterMaximumLuma":maximum,"recordedFrames":output.stdout.len(),"durationMs":capture.elapsed_ms(),"videoFps":30})).unwrap()).unwrap();
        assert!(
            minimum > 220,
            "Selected-window recording contained the covering window: minimum luma {minimum}"
        );
    }
    #[test]
    #[ignore = "Stops an owned native source before readiness and immediately after start, then verifies a fresh capture"]
    #[cfg(windows)]
    fn actual_immediate_stop_then_restart() {
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
            fn DestroyWindow(window: *mut c_void) -> i32;
            fn UpdateWindow(window: *mut c_void) -> i32;
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
        struct OwnedWindow(*mut c_void);
        impl Drop for OwnedWindow {
            fn drop(&mut self) {
                unsafe {
                    DestroyWindow(self.0);
                }
            }
        }
        let pump = || {
            let mut message: Message = unsafe { std::mem::zeroed() };
            unsafe {
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 1) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        };
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "CueReview immediate-stop verification\0"
            .encode_utf16()
            .collect();
        let window = OwnedWindow(unsafe {
            CreateWindowExW(
                0x08000000,
                class.as_ptr(),
                title.as_ptr(),
                0x90000006,
                220,
                220,
                320,
                180,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        });
        assert!(!window.0.is_null());
        unsafe {
            UpdateWindow(window.0);
        }
        pump();
        let source_id = format!("window:{}", window.0 as usize);
        let folder = PathBuf::from(std::env::var_os("CUEREVIEW_CAPTURE_TEST_DIR").unwrap())
            .join("immediate-stop");
        fs::create_dir_all(&folder).unwrap();
        let usable_video = |path: &Path| {
            let mut command = deps::command("ffprobe").unwrap();
            command
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=codec_type:format=duration",
                    "-of",
                    "json",
                ])
                .arg(path);
            let output = output_with_timeout(command, Duration::from_secs(5)).unwrap();
            if !output.status.success() {
                return false;
            }
            let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            value["streams"][0]["codec_type"] == "video"
                && value["format"]["duration"]
                    .as_str()
                    .and_then(|value| value.parse::<f64>().ok())
                    .is_some_and(|duration| duration > 0.0)
        };
        let mut phases = Vec::new();
        let before = folder.join(format!("before-readiness-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&before).unwrap();
        let epoch = Instant::now();
        let error: SharedError = Arc::default();
        let (ready, _receiver) = mpsc::sync_channel(1);
        let control = native_start(
            &source_id,
            NativeFlags {
                path: before.join("native-video.mp4"),
                fps: 30,
                epoch,
                error: error.clone(),
                ready,
                preview: false,
                preview_sink: None,
            },
        )
        .unwrap();
        // Halt before inspecting the callback so a future frame cannot race the observation.
        control.halt_handle().store(true, Ordering::Relaxed);
        let had_frame = control.callback().lock().first_frame.is_some();
        let mut early = ActiveCapture {
            epoch,
            stopped: None,
            folder: before.clone(),
            video: Some(VideoCapture::Native(control)),
            audio: None,
            muted: Arc::default(),
            level: Arc::new(AtomicU32::new(0)),
            error,
            fps: 30,
            device_audio: false,
            cursor: None,
            touch: None,
        };
        let began = Instant::now();
        let stopped = early.stop();
        let stop_ms = began.elapsed().as_millis();
        let usable = usable_video(&before.join("video.mp4"));
        phases.push(serde_json::json!({"phase":"before-readiness","folder":before,"hadFrameAtStop":had_frame,"stopMs":stop_ms,"usableVideo":usable,"error":stopped.as_ref().err()}));
        fs::write(
            folder.join("immediate-stop-verification.json"),
            serde_json::to_vec_pretty(&phases).unwrap(),
        )
        .unwrap();
        assert!(stop_ms < 5000, "Stopping before readiness hung");
        assert!(
            usable || stopped.is_err(),
            "An unusable recording was reported as successful"
        );
        if !had_frame {
            assert!(
                stopped.is_err(),
                "A capture without frames needs an explicit error"
            );
        }
        let immediate = folder.join("after-readiness");
        let began = Instant::now();
        let mut active = start(
            CaptureConfig {
                source_id: source_id.clone(),
                microphone_id: None,
                system_audio: false,
                fps: 30,
            },
            &immediate,
        )
        .unwrap();
        let start_ms = began.elapsed().as_millis();
        let began = Instant::now();
        let stopped = active.stop();
        let stop_ms = began.elapsed().as_millis();
        let usable = usable_video(&immediate.join("video.mp4"));
        phases.push(serde_json::json!({"phase":"after-readiness","startMs":start_ms,"stopMs":stop_ms,"usableVideo":usable,"error":stopped.as_ref().err()}));
        fs::write(
            folder.join("immediate-stop-verification.json"),
            serde_json::to_vec_pretty(&phases).unwrap(),
        )
        .unwrap();
        assert!(
            start_ms < 10000 && stop_ms < 5000,
            "Immediate start/stop exceeded its bound"
        );
        assert!(
            usable || stopped.is_err(),
            "An unusable immediate recording was reported as successful"
        );
        let next = folder.join("subsequent-capture");
        let mut active = start(
            CaptureConfig {
                source_id,
                microphone_id: None,
                system_audio: false,
                fps: 30,
            },
            &next,
        )
        .unwrap();
        let until = Instant::now() + Duration::from_millis(300);
        while Instant::now() < until {
            pump();
            thread::sleep(Duration::from_millis(2));
        }
        let began = Instant::now();
        active.stop().unwrap();
        let stop_ms = began.elapsed().as_millis();
        assert!(
            !next.join("native-video.mp4").exists(),
            "Successful video-only capture retained its duplicate native video"
        );
        let usable = usable_video(&next.join("video.mp4"));
        phases.push(serde_json::json!({"phase":"subsequent-capture","stopMs":stop_ms,"usableVideo":usable,"error":serde_json::Value::Null}));
        fs::write(
            folder.join("immediate-stop-verification.json"),
            serde_json::to_vec_pretty(&phases).unwrap(),
        )
        .unwrap();
        assert!(
            stop_ms < 5000 && usable,
            "Immediate stop prevented a subsequent successful capture"
        );
        assert!(
            before.join("audio.wav").exists(),
            "Early failure diagnostics were removed"
        );
    }
}
