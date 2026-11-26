//! Keeps an Android or Quest take recording across USB drops.
//!
//! scrcpy ends when its device drops off USB. A [`DeviceLink`] watches the
//! running scrcpy and, once it has ended, asks ADB about the device until it
//! is back, then starts scrcpy again into the next segment
//! (`native-video.<n>.mkv`, `capture.<n>.log`), until the take stops. Each
//! segment is anchored on the take's clock by its first decoded frame, like
//! the first one. [`join`] lays the segments on that clock, black between
//! them, as one recording that [`crate::capture`] then finalizes unchanged.
use crate::{capture, deps};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Child,
    sync::{atomic::AtomicBool, atomic::Ordering, Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// How often the link looks at scrcpy, and how long it waits between asking
/// ADB whether the device is back.
const WATCH: Duration = Duration::from_millis(200);
const RETRY: Duration = Duration::from_secs(1);

/// One recorded stretch of device video.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Segment {
    pub input: PathBuf,
    /// When its first frame was decoded, in seconds on the take's clock.
    pub delay: f64,
    /// Its first frame's size.
    pub canvas: Option<(u32, u32)>,
}

/// A running scrcpy.
pub(crate) struct Running {
    pub child: Child,
    pub window_title: Option<String>,
}

/// Starts and stops the device's capture; [`ScrcpyLauncher`] in the app.
pub(crate) trait Launcher: Send + 'static {
    /// Whether ADB sees the device, ready for scrcpy.
    fn ready(&mut self) -> bool;
    /// Starts segment `index` and waits for its first frame, giving up when
    /// `cancel` is set.
    fn launch(&mut self, index: usize, cancel: &AtomicBool) -> Result<(Segment, Running), String>;
    /// Stops a running segment so its file is complete.
    fn stop(&mut self, running: Running) -> Result<(), String>;
}

struct State {
    running: Option<Running>,
    segments: Vec<Segment>,
}
struct Shared {
    state: Mutex<State>,
    stop: AtomicBool,
    wake: Condvar,
}

/// What a stopped link recorded.
pub(crate) struct Recorded {
    pub segments: Vec<Segment>,
    /// Whether the device was recording when the take stopped.
    pub connected: bool,
    /// A segment that did not stop cleanly.
    pub failure: Option<String>,
}

pub(crate) struct DeviceLink {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<Box<dyn Launcher>>>,
}

impl DeviceLink {
    /// Watches `running`, the first segment, already started by `launcher`.
    pub fn start(mut launcher: Box<dyn Launcher>, first: Segment, running: Running) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                running: Some(running),
                segments: vec![first],
            }),
            stop: AtomicBool::new(false),
            wake: Condvar::new(),
        });
        let watched = shared.clone();
        let thread = thread::Builder::new()
            .name("device-link".into())
            .spawn(move || {
                watch(&watched, launcher.as_mut());
                launcher
            })
            .ok();
        Self { shared, thread }
    }
    /// The first segment's frame size: the take's canvas.
    pub fn first_canvas(&self) -> Option<(u32, u32)> {
        self.shared
            .state
            .lock()
            .ok()
            .and_then(|state| state.segments.first().and_then(|segment| segment.canvas))
    }
    /// Whether the device is being recorded now.
    pub fn connected(&self) -> bool {
        self.shared
            .state
            .lock()
            .map(|state| state.running.is_some())
            .unwrap_or(false)
    }
    pub fn stop(mut self) -> Recorded {
        self.shared.stop.store(true, Ordering::SeqCst);
        self.shared.wake.notify_all();
        let launcher = self.thread.take().and_then(|thread| thread.join().ok());
        let mut state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let running = state.running.take();
        let connected = running.is_some();
        let failure = match (running, launcher) {
            (Some(running), Some(mut launcher)) => launcher.stop(running).err(),
            (Some(mut running), None) => {
                let _ = running.child.kill();
                let _ = running.child.wait();
                Some(
                    "Device capture did not close cleanly; original tracks retained for recovery"
                        .into(),
                )
            }
            (None, _) => None,
        };
        Recorded {
            segments: std::mem::take(&mut state.segments),
            connected,
            failure,
        }
    }
}
impl Drop for DeviceLink {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let link = DeviceLink {
                shared: self.shared.clone(),
                thread: self.thread.take(),
            };
            let _ = link.stop();
        }
    }
}

fn watch(shared: &Shared, launcher: &mut dyn Launcher) {
    let mut next_try = Instant::now();
    loop {
        let index = {
            let state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
            let (mut state, _) = shared
                .wake
                .wait_timeout_while(state, WATCH, |_| !shared.stop.load(Ordering::SeqCst))
                .unwrap_or_else(|p| p.into_inner());
            if shared.stop.load(Ordering::SeqCst) {
                return;
            }
            if let Some(running) = state.running.as_mut() {
                if !matches!(running.child.try_wait(), Ok(None)) {
                    // scrcpy ended: the device dropped, or scrcpy failed.
                    state.running = None;
                    next_try = Instant::now();
                }
            }
            if state.running.is_some() || Instant::now() < next_try {
                continue;
            }
            state.segments.len()
        };
        next_try = Instant::now() + RETRY;
        if !launcher.ready() {
            continue;
        }
        let Ok((segment, mut running)) = launcher.launch(index, &shared.stop) else {
            continue;
        };
        let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
        if shared.stop.load(Ordering::SeqCst) {
            // Stop came while it started: it belongs to no take.
            drop(state);
            let _ = running.child.kill();
            let _ = running.child.wait();
            let _ = fs::remove_file(&segment.input);
            return;
        }
        state.segments.push(segment);
        state.running = Some(running);
    }
}

/// The real launcher: scrcpy on `serial`, through ADB.
pub(crate) struct ScrcpyLauncher {
    pub serial: String,
    pub folder: PathBuf,
    pub fps: u32,
    pub system_audio: bool,
    pub epoch: Instant,
}
impl ScrcpyLauncher {
    pub fn files(folder: &Path, index: usize) -> (PathBuf, PathBuf) {
        if index == 0 {
            (folder.join("native-video.mkv"), folder.join("capture.log"))
        } else {
            (
                folder.join(format!("native-video.{index}.mkv")),
                folder.join(format!("capture.{index}.log")),
            )
        }
    }
}
impl Launcher for ScrcpyLauncher {
    fn ready(&mut self) -> bool {
        let Ok(mut adb) = deps::command("adb") else {
            return false;
        };
        adb.args(["-s", &self.serial, "get-state"]);
        capture::output_with_timeout(adb, Duration::from_secs(3)).is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "device"
        })
    }
    fn launch(&mut self, index: usize, cancel: &AtomicBool) -> Result<(Segment, Running), String> {
        let (input, log) = Self::files(&self.folder, index);
        capture::start_scrcpy(
            &self.serial,
            self.fps,
            self.system_audio,
            &input,
            &log,
            self.epoch,
            cancel,
        )
    }
    fn stop(&mut self, running: Running) -> Result<(), String> {
        capture::stop_process(running.child, running.window_title, true)
    }
}

/// A stretch without device video, in seconds on the take's clock.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Gap {
    pub start: f64,
    pub end: f64,
}

/// What [`join`] made.
pub(crate) struct Joined {
    /// One recording of every segment on the take's clock, starting at the
    /// first segment's first frame.
    pub input: PathBuf,
    pub gaps: Vec<Gap>,
}

/// The joined recording's name; its parts are removed as it is made.
pub(crate) const JOINED: &str = "native-video.joined.mkv";

/// Where each segment's video ends on the take's clock.
fn segment_ends(segments: &[Segment], fps: u32) -> Result<Vec<f64>, String> {
    segments
        .iter()
        .map(|segment| capture::device_end(&segment.input, segment.delay, fps))
        .collect()
}

/// The gaps: from each segment's end to the next segment's first frame,
/// and from the last one's end to `duration` when the device was not back.
pub(crate) fn gaps(segments: &[Segment], ends: &[f64], connected: bool, duration: f64) -> Vec<Gap> {
    let mut gaps = Vec::new();
    for (index, end) in ends.iter().enumerate() {
        let next = match segments.get(index + 1) {
            Some(next) => next.delay,
            None if connected => continue,
            None => duration,
        };
        if next > *end {
            gaps.push(Gap {
                start: *end,
                end: next,
            });
        }
    }
    gaps
}

/// How long segment `index` lasts in the joined recording: up to the next
/// segment's first frame, black after its own end; the last one to
/// `duration` when the device was not back, and as long as it is otherwise.
pub(crate) fn clip_length(
    segments: &[Segment],
    index: usize,
    connected: bool,
    duration: f64,
) -> Option<f64> {
    let start = segments[index].delay;
    match segments.get(index + 1) {
        Some(next) => Some(next.delay - start),
        None if connected => None,
        None => Some(duration - start),
    }
}

/// Joins a take's segments, as the docs of this module say.
pub(crate) fn join(
    folder: &Path,
    segments: &[Segment],
    connected: bool,
    duration: f64,
    fps: u32,
    device_audio: bool,
) -> Result<Joined, String> {
    let first = segments.first().ok_or("The device recorded no video")?;
    let ends = segment_ends(segments, fps)?;
    let gaps = gaps(segments, &ends, connected, duration);
    // Every frame goes onto the first segment's first frame size.
    let canvas = match first.canvas {
        Some(canvas) => canvas,
        None => *capture::device_frame_sizes(&first.input)?
            .first()
            .ok_or("The device recording has no frames")?,
    };
    let canvas = (canvas.0 / 2 * 2, canvas.1 / 2 * 2);
    let mut parts = Vec::new();
    let result = (|| {
        for (index, segment) in segments.iter().enumerate() {
            let part = folder.join(format!("native-video.part{index}.mkv"));
            parts.push(part.clone());
            clip(
                segment,
                &part,
                canvas,
                fps,
                clip_length(segments, index, connected, duration),
                folder,
                index,
            )?;
        }
        let list = folder.join("native-video.parts.txt");
        parts.push(list.clone());
        let mut text = String::new();
        for part in &parts[..segments.len()] {
            let name = part
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Invalid part name")?;
            text.push_str(&format!("file '{name}'\n"));
        }
        fs::write(&list, text).map_err(|e| e.to_string())?;
        let video = folder.join("native-video.joined-video.mkv");
        parts.push(video.clone());
        let mut concat = deps::command("ffmpeg")?;
        concat
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
            ])
            .arg(&list)
            .args(["-c", "copy"])
            .arg(&video);
        capture::ffmpeg(concat)?;
        let joined = folder.join(JOINED);
        if device_audio {
            let audio = folder.join("native-video.joined-audio.wav");
            parts.push(audio.clone());
            join_audio(folder, segments, &audio, duration, &mut parts)?;
            let mut mux = deps::command("ffmpeg")?;
            mux.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
                .arg(&video)
                .arg("-i")
                .arg(&audio)
                .args([
                    "-map",
                    "0:v:0",
                    "-map",
                    "1:a:0",
                    "-c:v",
                    "copy",
                    "-c:a",
                    "pcm_f32le",
                ])
                .arg(&joined);
            capture::ffmpeg(mux)?;
        } else {
            fs::rename(&video, &joined).map_err(|e| e.to_string())?;
        }
        Ok(Joined {
            input: joined,
            gaps: gaps.clone(),
        })
    })();
    for part in parts {
        let _ = fs::remove_file(part);
    }
    result
}

/// Segment `index` as a part of the joined recording: on the canvas, at
/// `fps`, from its first frame, padded with black to `length` seconds.
fn clip(
    segment: &Segment,
    part: &Path,
    canvas: (u32, u32),
    fps: u32,
    length: Option<f64>,
    folder: &Path,
    index: usize,
) -> Result<(), String> {
    // FFmpeg rebuilds its filters at a frame size change, which would restart
    // `STARTPTS` and the padding, so a segment that turned is first
    // letterboxed with stateless filters.
    let sizes = capture::device_frame_sizes(&segment.input)?;
    let letterboxed = folder.join(format!("native-video.part{index}.letterboxed.mkv"));
    let input = if sizes.len() > 1 || sizes.first().is_some_and(|size| *size != canvas) {
        capture::letterbox_device(&segment.input, &letterboxed, canvas)?;
        letterboxed.as_path()
    } else {
        segment.input.as_path()
    };
    let mut filter = format!("setpts=PTS-STARTPTS,fps={fps}");
    if let Some(length) = length {
        filter.push_str(&format!(
            ",tpad=stop_mode=add:stop_duration={:.6}:color=black",
            length.max(0.0)
        ));
    }
    let mut command = deps::command("ffmpeg")?;
    command
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .args(["-map", "0:v:0", "-an", "-vf", &filter]);
    if let Some(length) = length {
        command.args(["-t", &format!("{:.6}", length.max(1.0 / fps as f64))]);
    }
    command
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-pix_fmt", "yuv420p", "-r",
        ])
        .arg(fps.to_string())
        .arg(part);
    let result = capture::ffmpeg(command);
    let _ = fs::remove_file(&letterboxed);
    result
}

/// Every segment's device audio, each at its place on the joined clock.
fn join_audio(
    folder: &Path,
    segments: &[Segment],
    output: &Path,
    duration: f64,
    parts: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let origin = segments[0].delay;
    let mut mix = deps::command("ffmpeg")?;
    mix.args(["-y", "-hide_banner", "-loglevel", "error"]);
    let mut inputs = 0;
    for (index, segment) in segments.iter().enumerate() {
        let (video_pts, audio_pts) = match capture::device_stream_starts(&segment.input) {
            Ok(starts) => starts,
            // A segment without audio adds none.
            Err(_) => continue,
        };
        let (_, filter) =
            capture::device_audio_filter(segment.delay - origin, video_pts, audio_pts);
        let track = folder.join(format!("native-video.part{index}.wav"));
        parts.push(track.clone());
        let mut extract = deps::command("ffmpeg")?;
        extract
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(&segment.input)
            .args(["-vn", "-map", "0:a:0", "-af"])
            // The extracted track ends where the take does.
            .arg(&filter)
            .args(["-t", &format!("{:.6}", (duration - origin).max(0.001))])
            .args(["-ar", "48000", "-ac", "1", "-c:a", "pcm_f32le"])
            .arg(&track);
        capture::ffmpeg(extract)?;
        mix.arg("-i").arg(&track);
        inputs += 1;
    }
    if inputs == 0 {
        return Err("The device recorded no audio".into());
    }
    mix.args([
        "-filter_complex",
        &format!("amix=inputs={inputs}:duration=longest:normalize=0"),
        "-ar",
        "48000",
        "-ac",
        "1",
        "-c:a",
        "pcm_f32le",
    ])
    .arg(output);
    capture::ffmpeg(mix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        sync::atomic::AtomicUsize,
    };

    /// A process that runs until it is killed, or one that ends at once.
    fn process(lasting: bool) -> Child {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args([
                "/C",
                if lasting {
                    "ping -n 60 127.0.0.1"
                } else {
                    "exit 0"
                },
            ]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", if lasting { "sleep 60" } else { "exit 0" }]);
            command
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
    fn running(lasting: bool) -> Running {
        Running {
            child: process(lasting),
            window_title: None,
        }
    }
    fn segment(index: usize, delay: f64) -> Segment {
        Segment {
            input: PathBuf::from(format!("native-video.{index}.mkv")),
            delay,
            canvas: Some((64, 128)),
        }
    }

    /// A device that is back once ADB has been asked `away` times.
    struct Device {
        away: usize,
        asked: Arc<AtomicUsize>,
        launched: Arc<Mutex<Vec<usize>>>,
    }
    impl Launcher for Device {
        fn ready(&mut self) -> bool {
            self.asked.fetch_add(1, Ordering::SeqCst) >= self.away
        }
        fn launch(&mut self, index: usize, _: &AtomicBool) -> Result<(Segment, Running), String> {
            self.launched.lock().unwrap().push(index);
            Ok((segment(index, index as f64 * 10.0), running(true)))
        }
        fn stop(&mut self, mut running: Running) -> Result<(), String> {
            running.child.kill().map_err(|e| e.to_string())?;
            running.child.wait().map_err(|e| e.to_string())?;
            Ok(())
        }
    }

    /// Polls `link` until `connected` is `want`, up to `seconds`.
    fn wait_for(link: &DeviceLink, want: bool, seconds: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < deadline {
            if link.connected() == want {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn device_recorder_records_again_after_the_device_returns() {
        let asked = Arc::new(AtomicUsize::new(0));
        let launched = Arc::new(Mutex::new(Vec::new()));
        let device = Device {
            away: 2,
            asked: asked.clone(),
            launched: launched.clone(),
        };
        // The first scrcpy ends at once, as it does when the device drops.
        let link = DeviceLink::start(Box::new(device), segment(0, 0.5), running(false));
        assert!(wait_for(&link, false, 5), "the drop was not noticed");
        assert!(
            wait_for(&link, true, 10),
            "the device was not recorded again"
        );
        // ADB was asked until the device was back.
        assert!(asked.load(Ordering::SeqCst) >= 3);
        assert_eq!(*launched.lock().unwrap(), [1]);
        let recorded = link.stop();
        assert!(recorded.connected);
        assert!(recorded.failure.is_none(), "{:?}", recorded.failure);
        assert_eq!(recorded.segments, [segment(0, 0.5), segment(1, 10.0)]);
    }

    #[test]
    fn a_device_that_does_not_return_leaves_its_first_segment() {
        let device = Device {
            away: usize::MAX,
            asked: Arc::default(),
            launched: Arc::default(),
        };
        let link = DeviceLink::start(Box::new(device), segment(0, 0.5), running(false));
        assert!(wait_for(&link, false, 5));
        let began = Instant::now();
        let recorded = link.stop();
        assert!(began.elapsed() < Duration::from_secs(2), "stop waited");
        assert!(!recorded.connected);
        assert_eq!(recorded.segments, [segment(0, 0.5)]);
    }

    #[test]
    fn a_running_device_is_stopped_with_the_take() {
        let launched = Arc::new(Mutex::new(Vec::new()));
        let device = Device {
            away: 0,
            asked: Arc::default(),
            launched: launched.clone(),
        };
        let link = DeviceLink::start(Box::new(device), segment(0, 0.5), running(true));
        thread::sleep(Duration::from_millis(500));
        assert!(link.connected());
        let recorded = link.stop();
        assert!(recorded.connected && recorded.failure.is_none());
        assert_eq!(recorded.segments.len(), 1);
        assert!(launched.lock().unwrap().is_empty());
    }

    #[test]
    fn gaps_run_from_each_end_to_the_next_first_frame() {
        let segments = [segment(0, 0.5), segment(1, 3.0)];
        let gap = |start, end| Gap { start, end };
        assert_eq!(gaps(&segments, &[1.5, 4.0], true, 5.0), [gap(1.5, 3.0)]);
        // Not back at Stop: the tail is a gap too.
        assert_eq!(
            gaps(&segments, &[1.5, 4.0], false, 5.0),
            [gap(1.5, 3.0), gap(4.0, 5.0)]
        );
        assert_eq!(clip_length(&segments, 0, true, 5.0), Some(2.5));
        assert_eq!(clip_length(&segments, 1, true, 5.0), None);
        assert_eq!(clip_length(&segments, 1, false, 5.0), Some(2.0));
    }

    /// A one-second device recording: `color` frames at 30 fps, and a tone.
    fn recording(folder: &Path, name: &str, color: &str) -> PathBuf {
        let path = folder.join(name);
        let mut command = deps::command("ffmpeg").unwrap();
        command
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("color=c={color}:s=64x128:r=30:d=1"))
            .args(["-f", "lavfi", "-i", "sine=f=440:r=48000:d=1"])
            .args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ])
            .arg(&path);
        capture::ffmpeg(command).unwrap();
        path
    }
    /// The average colour of `video`'s frame at `seconds`.
    fn rgb(video: &Path, seconds: f64) -> [u8; 3] {
        let mut command = deps::command("ffmpeg").unwrap();
        command
            .args(["-v", "error", "-ss", &format!("{seconds:.3}"), "-i"])
            .arg(video)
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=1:1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "-",
            ]);
        let output = capture::output_with_timeout(command, Duration::from_secs(30)).unwrap();
        assert!(output.status.success());
        [output.stdout[0], output.stdout[1], output.stdout[2]]
    }
    /// The loudest sample of `track` between `from` and `to` seconds.
    fn peak(track: &Path, from: f64, to: f64) -> f32 {
        let mut reader = hound::WavReader::open(track).unwrap();
        let rate = reader.spec().sample_rate as f64;
        reader
            .samples::<f32>()
            .map(Result::unwrap)
            .enumerate()
            .filter(|(at, _)| (from * rate..to * rate).contains(&(*at as f64)))
            .fold(0.0, |peak, (_, sample)| peak.max(sample.abs()))
    }

    #[test]
    #[ignore = "Requires FFmpeg; joins synthetic device recordings around a drop"]
    fn actual_device_segments_black_out_the_gaps() {
        let red = |[r, g, b]: [u8; 3]| r > 180 && g < 80 && b < 80;
        let green = |[r, g, b]: [u8; 3]| g > 90 && r < 80 && b < 80;
        let black = |[r, g, b]: [u8; 3]| r < 30 && g < 30 && b < 30;
        let folder = tempfile::tempdir().unwrap();
        let folder = folder.path();
        // Red from 0.5 s to 1.5 s, the device gone, green from 3 s to 4 s.
        let segments = [
            Segment {
                input: recording(folder, "native-video.mkv", "red"),
                delay: 0.5,
                canvas: Some((64, 128)),
            },
            Segment {
                input: recording(folder, "native-video.1.mkv", "green"),
                delay: 3.0,
                canvas: Some((64, 128)),
            },
        ];
        let joined = join(folder, &segments, true, 5.0, 30, true).unwrap();
        assert_eq!(joined.gaps.len(), 1, "{:?}", joined.gaps);
        let gap = joined.gaps[0];
        assert!(
            (gap.start - 1.5).abs() < 0.1 && (gap.end - 3.0).abs() < 1e-9,
            "{gap:?}"
        );
        capture::finalize(
            folder,
            &joined.input,
            Duration::from_secs(5),
            0.5,
            30,
            true,
            true,
            serde_json::Map::new(),
        )
        .unwrap();
        let video = folder.join("video.mp4");
        assert!(red(rgb(&video, 1.0)), "{:?}", rgb(&video, 1.0));
        assert!(black(rgb(&video, 2.2)), "{:?}", rgb(&video, 2.2));
        assert!(green(rgb(&video, 3.5)), "{:?}", rgb(&video, 3.5));
        // After its last frame the take ends on it, as every take does.
        assert!(green(rgb(&video, 4.7)), "{:?}", rgb(&video, 4.7));
        // The device's tone plays with each of its stretches, not in the gap.
        let system = folder.join("system.wav");
        assert!(peak(&system, 0.7, 1.3) > 0.1);
        assert!(peak(&system, 1.8, 2.8) < 0.01);
        assert!(peak(&system, 3.2, 3.8) > 0.1);
        let leftovers: Vec<_> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".part"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        // Not back before Stop: black from the drop to the end.
        let tail = tempfile::tempdir().unwrap();
        let tail = tail.path();
        let only = [Segment {
            input: recording(tail, "native-video.mkv", "red"),
            delay: 0.5,
            canvas: Some((64, 128)),
        }];
        let joined = join(tail, &only, false, 3.0, 30, false).unwrap();
        assert_eq!(joined.gaps.len(), 1);
        assert!((joined.gaps[0].end - 3.0).abs() < 1e-9);
        capture::finalize(
            tail,
            &joined.input,
            Duration::from_secs(3),
            0.5,
            30,
            false,
            true,
            serde_json::Map::new(),
        )
        .unwrap();
        let video = tail.join("video.mp4");
        assert!(red(rgb(&video, 1.0)));
        assert!(black(rgb(&video, 2.5)), "{:?}", rgb(&video, 2.5));
    }
}
