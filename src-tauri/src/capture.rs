//! Windows Graphics Capture + WASAPI. Original tracks are retained for recovery.
use crate::{
    deps,
    models::{CaptureConfig, CaptureSource, Microphone},
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
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    encoder::{
        AudioSettingsBuilder, ContainerSettingsBuilder, ImageFormat, VideoEncoder,
        VideoSettingsBuilder, VideoSettingsSubType,
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
        if !name.trim().is_empty() && w.width().unwrap_or(0) > 0 && w.height().unwrap_or(0) > 0 {
            result.push(source(
                format!("window:{}", w.as_raw_hwnd() as usize),
                name,
                "window",
                w.process_name().ok(),
            ));
        }
    }
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
        let kind = if model.to_lowercase().contains("quest") {
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

fn dshow_names(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| l.contains("(video)"))
        .filter_map(|l| l.split('"').nth(1).map(str::to_owned))
        .collect()
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

struct NativeFlags {
    path: PathBuf,
    fps: u32,
    epoch: Instant,
    error: SharedError,
    ready: mpsc::SyncSender<Result<(), String>>,
    preview: bool,
}
struct NativeCapture {
    flags: NativeFlags,
    encoder: Option<PacedEncoder>,
    first_frame: Option<f64>,
    ready_sent: bool,
}
impl NativeCapture {
    fn finish(&mut self) -> Result<(), String> {
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        Ok(())
    }
}
struct PacedEncoder {
    latest: Arc<Mutex<Arc<Vec<u8>>>>,
    width: u32,
    height: u32,
    stop: mpsc::Sender<()>,
    join: JoinHandle<Result<(), String>>,
}
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
impl GraphicsCaptureApiHandler for NativeCapture {
    type Flags = NativeFlags;
    type Error = String;
    fn new(ctx: Context<NativeFlags>) -> Result<Self, String> {
        Ok(Self {
            flags: ctx.flags,
            encoder: None,
            first_frame: None,
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
                frame
                    .save_as_image(&self.flags.path, ImageFormat::Png)
                    .map_err(|e| e.to_string())?;
                control.stop();
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
        }
        self.finish()
    }
}
impl Drop for NativeCapture {
    fn drop(&mut self) {
        if let Err(e) = self.finish() {
            fail(&self.flags.error, e);
        }
    }
}

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

pub fn preview(source_id: &str) -> Result<String, String> {
    let bytes = if let Some(serial) = source_id.strip_prefix("android:") {
        let mut cmd = deps::command("adb")?;
        cmd.args(["-s", serial, "exec-out", "screencap", "-p"]);
        let out = output_with_timeout(cmd, Duration::from_secs(8))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        out.stdout
    } else if let Some(name) = source_id.strip_prefix("dshow:") {
        let mut cmd = deps::command("ffmpeg")?;
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "dshow",
            "-i",
            &format!("video={name}"),
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
        let path =
            std::env::temp_dir().join(format!("cuereview-preview-{}.png", uuid::Uuid::new_v4()));
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
    };
    if bytes.is_empty() {
        return Err("Capture source returned an empty preview".into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

type Wav = hound::WavWriter<BufWriter<File>>;
struct AudioWriter {
    wav: Option<Wav>,
    frames: u64,
    rate: u32,
    anchor: Option<(cpal::StreamInstant, f64)>,
}
impl AudioWriter {
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
        let frames = samples.len() / channels;
        let elapsed = epoch.elapsed().as_secs_f64();
        let latency = timestamp
            .callback
            .duration_since(&timestamp.capture)
            .unwrap_or_default()
            .as_secs_f64();
        let anchor = *self
            .anchor
            .get_or_insert((timestamp.capture, (elapsed - latency).max(0.0)));
        let target = anchor.1
            + timestamp
                .capture
                .duration_since(&anchor.0)
                .unwrap_or_default()
                .as_secs_f64();
        let target = (target * self.rate as f64).round() as u64;
        let skip = self.frames.saturating_sub(target).min(frames as u64) as usize;
        self.pad(target)?;
        let mut square = 0.0;
        if let Some(wav) = self.wav.as_mut() {
            for frame in samples.chunks_exact(channels).skip(skip) {
                let sample = if muted {
                    0.0
                } else {
                    frame.iter().copied().sum::<f32>() / channels as f32
                };
                wav.write_sample(sample)?;
                square += sample * sample;
            }
        }
        self.frames += (frames - skip) as u64;
        Ok((square / frames.max(1) as f32).sqrt().min(1.0))
    }
    fn finish(&mut self, duration: Duration) -> Result<(), String> {
        self.pad((duration.as_secs_f64() * self.rate as f64).round() as u64)
            .map_err(|e| e.to_string())?;
        if let Some(wav) = self.wav.take() {
            wav.finalize().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

struct AudioTrack {
    stream: cpal::Stream,
    writer: Arc<Mutex<AudioWriter>>,
    path: PathBuf,
}
fn snapshot_track(
    path: &Path,
    writer: &Arc<Mutex<AudioWriter>>,
    target: &Path,
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
    let start = end.saturating_sub(spec.sample_rate.saturating_mul(30));
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
    let writer = Arc::new(Mutex::new(AudioWriter {
        wav: Some(wav),
        frames: 0,
        rate: config.sample_rate.0,
        anchor: None,
    }));
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
                Ok(rms) => level.store(rms.to_bits(), Ordering::Relaxed),
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
    Native(CaptureControl<NativeCapture, String>),
    Process {
        child: Mutex<Child>,
        input: PathBuf,
        window_title: Option<String>,
        delay: f64,
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
    };
    capture.audio = Some(AudioWorker::start(
        &config,
        folder,
        capture.epoch,
        capture.muted.clone(),
        capture.level.clone(),
        capture.error.clone(),
    )?);
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
        } else if let Some(name) = config.source_id.strip_prefix("dshow:") {
            let input = folder.join("native-video.mkv");
            let log = File::create(folder.join("capture.log")).map_err(|e| e.to_string())?;
            let child = deps::command("ffmpeg")?
                .args([
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-f",
                    "dshow",
                    "-rtbufsize",
                    "256M",
                    "-i",
                    &format!("video={name}"),
                    "-an",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                    "-r",
                    &config.fps.to_string(),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&input)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log))
                .spawn()
                .map_err(|e| e.to_string())?;
            ready_process(child, input, None, capture.epoch)
        } else {
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
    })();
    match result {
        Ok(video) => {
            capture.video = Some(video);
            Ok(capture)
        }
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
        snapshot_track(path, writer, target)
    }
    pub fn elapsed_ms(&self) -> u64 {
        self.stopped
            .unwrap_or_else(|| self.epoch.elapsed())
            .as_millis() as u64
    }
    pub fn audio_level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }
    pub fn error(&self) -> Option<String> {
        if self.stopped.is_none() {
            match self.video.as_ref() {
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
        let input = match self.video.take() {
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
                self.folder.join("native-video.mp4")
            }
            Some(VideoCapture::Process {
                child,
                input,
                window_title,
                delay: process_delay,
            }) => {
                device_capture = window_title.is_some();
                delay = process_delay;
                let mut child = child.into_inner().unwrap_or_else(|e| e.into_inner());
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
                input
            }
            None => self.folder.join("native-video.mp4"),
        };
        if let Err(e) = finalize(
            &self.folder,
            &input,
            duration,
            delay,
            self.fps,
            self.device_audio,
            device_capture,
        ) {
            failures.push(e);
        }
        if let Some(e) = self.error() {
            failures.push(e);
        }
        if failures.is_empty() {
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
    }
}

fn output_with_timeout(
    mut command: std::process::Command,
    timeout: Duration,
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
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
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
    Ok(Output {
        status,
        stdout,
        stderr,
    })
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
fn ready_process(
    mut child: Child,
    input: PathBuf,
    window_title: Option<String>,
    epoch: Instant,
) -> Result<VideoCapture, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut decoded_delay = None;
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
        let ready_delay = if window_title.is_some() {
            let log = fs::read_to_string(input.with_file_name("capture.log")).unwrap_or_default();
            latch_scrcpy_frame(&log, &mut decoded_delay, epoch.elapsed().as_secs_f64())
        } else {
            input
                .metadata()
                .ok()
                .filter(|m| m.len() >= 512)
                .map(|_| epoch.elapsed().as_secs_f64())
        };
        if let Some(delay) = ready_delay {
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
fn latch_scrcpy_frame(log: &str, latched: &mut Option<f64>, now: f64) -> Option<f64> {
    // v4.1 emits this unbuffered line when uploading its first decoded frame.
    // Window creation and Matroska flush timing do not identify that frame.
    if latched.is_none()
        && log.split_inclusive('\n').any(|line| {
            if !line.ends_with('\n') {
                return false;
            }
            let Some(size) = line.trim().strip_prefix("INFO: Texture: ") else {
                return false;
            };
            let Some((width, height)) = size.split_once('x') else {
                return false;
            };
            width.parse::<u32>().is_ok_and(|n| n > 0) && height.parse::<u32>().is_ok_and(|n| n > 0)
        })
    {
        *latched = Some(now);
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
fn finalize(
    folder: &Path,
    input: &Path,
    duration: Duration,
    delay: f64,
    fps: u32,
    device_audio: bool,
    device_capture: bool,
) -> Result<(), String> {
    let mic = folder.join("mic.wav");
    let system = folder.join("system.wav");
    let audio = folder.join("audio.wav");
    let mut timing = serde_json::json!({"videoHostStartMs":delay * 1000.0,"recordingStopMs":duration.as_secs_f64() * 1000.0});
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
    let mut mux = deps::command("ffmpeg")?;
    // Extend the first/last frame to cover startup and a static desktop's final interval.
    let filter = format!("setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration={delay:.6}:stop_mode=clone:stop_duration={},scale=trunc(iw/2)*2:trunc(ih/2)*2", duration.as_secs_f64());
    mux.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
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
            "20",
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
    ffmpeg(mux)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            Some(0.6)
        );
        assert_eq!(
            latch_scrcpy_frame("INFO: Texture: 2208x4128\n", &mut seen, 5.6),
            Some(0.6)
        );
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
    #[test]
    fn audio_gaps_and_tail_are_silent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        let wav = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 1000,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .unwrap();
        let mut writer = AudioWriter {
            wav: Some(wav),
            frames: 0,
            rate: 1000,
            anchor: None,
        };
        writer.pad(25).unwrap();
        writer.wav.as_mut().unwrap().write_sample(0.5f32).unwrap();
        writer.frames += 1;
        writer.finish(Duration::from_millis(50)).unwrap();
        let samples: Vec<f32> = hound::WavReader::open(path)
            .unwrap()
            .samples()
            .map(Result::unwrap)
            .collect();
        assert_eq!(samples.len(), 50);
        assert_eq!(samples[25], 0.5);
        assert!(samples[..25]
            .iter()
            .chain(samples[26..].iter())
            .all(|s| *s == 0.0));
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
        let writer = Arc::new(Mutex::new(AudioWriter {
            wav: Some(wav),
            frames: 40_000,
            rate: 1000,
            anchor: None,
        }));
        assert_eq!(
            snapshot_track(&path, &writer, &target).unwrap(),
            (10_000, 40_000)
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
