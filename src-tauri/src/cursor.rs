//! Cursor tracking for Windows display and window captures (plan item C1).
//!
//! # Recording
//!
//! While a Windows display or window source records, [`crate::capture`] runs
//! a sampler thread beside the WGC capture, for the app and `cue record`
//! alike. It starts once the first video frame has arrived and is stopped and
//! joined at the very top of `ActiveCapture::stop`, so every sample lies
//! inside the take. About [`SAMPLE_HZ`] times a second it reads
//! `GetCursorPos` and the left, right and middle buttons (`GetAsyncKeyState`,
//! honoring swapped buttons). The thread is per-monitor-v2 DPI aware, so every
//! coordinate is in physical pixels, like the WGC frames.
//!
//! Positions are relative to the top-left corner of the source, which is also
//! the top-left corner of the canvas (the first frame's size; later frames are
//! cropped or padded from the top-left):
//!
//! - displays: the monitor bounds from `GetMonitorInfoW`, re-read on every
//!   sample. A pointer on another monitor is outside the source;
//! - windows: the DWM extended frame bounds, re-read on every sample because
//!   the window can move. `WindowFromPoint` also records whether the pointer
//!   was over the source (its root window is the source). A minimized or
//!   closed window records a gap.
//!
//! Samples are timed on the capture epoch, which is also t=0 of the take's
//! video, audio and transcript words.
//!
//! # `cursor.jsonl`
//!
//! One file per take, in the take folder: the session folder for take 1 and
//! `takes/N/` for later takes. It is append-only and flushed about once a
//! second, so a crash loses at most the last second. The first line is a
//! [`Header`]; every further line is a JSON array of integers, delta-encoded
//! against the line before it:
//!
//! ```text
//! {"format":"cuereview-cursor","version":1,"source":"window","canvasWidth":1280,"canvasHeight":720,"sampleHz":60}
//! [412,640,360]   412 ms after the epoch, at canvas pixel (640, 360)
//! [17,3,-2]       17 ms later, moved by (+3, -2)
//! [16,0,0,1]      16 ms later, same place, state is now 1 (left button down)
//! [250,0,0]       a heartbeat: nothing changed for 250 ms
//! [40]            a gap: the pointer is unknown from here to the next sample
//! ```
//!
//! - `[dt, dx, dy]` is a sample `dt` ms after the previous line, moved by
//!   `(dx, dy)` canvas pixels. The first sample is relative to t=0 and the
//!   canvas top-left, so it is effectively absolute.
//! - `[dt, dx, dy, state]` is the same, and the state changed to `state`:
//!   bit 0 left, bit 1 right and bit 2 middle button held ([`LEFT`],
//!   [`RIGHT`], [`MIDDLE`]), bit 3 [`OUTSIDE`] the source.
//! - `[dt]` is a gap (secure desktop, minimized or closed window). Gaps keep
//!   the previous position and state for the deltas that follow.
//!
//! A line is written whenever the position or state changes, and at least
//! every [`HEARTBEAT_MS`] otherwise. A press and release between two polls
//! (seen through `GetAsyncKeyState`'s "pressed since the last call" bit) is
//! written as two lines with the same time. Readers stop at the first line
//! they cannot parse, which only happens for a tail cut short by a crash.
//! `capture-timing.json` also gets `canvasWidth`/`canvasHeight`, and
//! `cursorLines` or `cursorError`.
//!
//! # Queries
//!
//! [`load`] stitches the takes of a session onto the combined timeline,
//! adding each take's `offset_ms`, and ends each take with a gap. A take
//! starts with the button state of its first sample, so only later
//! transitions are presses. [`CursorTrack::at`] returns the nearest previous
//! sample, unless it is a gap or older than [`STALE_MS`].
//! [`CursorTrack::clicks`] lists presses.
//!
//! [`CursorPoint::x`]/[`CursorPoint::y`] are fractions of the canvas, measured
//! at the pointer's pixel center. `px`/`py` scale them to the session video,
//! which is take 1's canvas rounded down to even sizes (`finalize` scales by
//! `trunc(iw/2)*2`). Later takes with another canvas are assumed to be scaled
//! to that size without padding when the combined video is rebuilt.
//! `in_video` is false outside the canvas and when the pointer was not over
//! the source: on another monitor, or over a window covering the source
//! window.
//!
//! # Other platforms
//!
//! macOS and Linux have no sampler, and neither do device sources (Android
//! and Quest through scrcpy) and cameras (DirectShow, AVFoundation, V4L2),
//! whose pictures do not contain the host pointer. [`load`] then finds no
//! file and returns `None`. Adding the desktop platforms would need:
//!
//! - **macOS** (`avfoundation` "Capture screen N"): poll
//!   `CGEventGetLocation(CGEventCreate(NULL))`, which is global display space
//!   in points with the origin at the main display's top-left, and
//!   `CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, …)`
//!   for the buttons. Map AVFoundation's screen index to a `CGDirectDisplayID`
//!   (`CGGetActiveDisplayList` order), subtract `CGDisplayBounds(id).origin`,
//!   and multiply by the backing scale (`CGDisplayPixelsWide(id)` divided by
//!   the bounds width) to reach the captured pixels. Polling needs no
//!   Accessibility or Input Monitoring permission; event taps would.
//! - **Linux X11** (`x11grab` of a whole display): poll
//!   `XQueryPointer(display, DefaultRootWindow(display), …)`. `root_x`/`root_y`
//!   are already root-window pixels, which is what `x11grab` captures (minus
//!   any `+x,y` grab offset), and the mask carries `Button1Mask`,
//!   `Button2Mask` and `Button3Mask` (left, middle, right). This needs Xlib
//!   (linked or `dlopen`ed) and a second `XOpenDisplay` connection for the
//!   sampler thread. Wayland offers no global pointer position outside the
//!   screencast portal's cursor metadata, so it stays unsupported.

use crate::{
    models::{Session, TakeStatus},
    store::Store,
};
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, BufWriter, Write},
    path::{Component, Path, PathBuf},
};

/// The file name of a take's cursor track.
pub const FILE_NAME: &str = "cursor.jsonl";
/// [`Header::format`] of every cursor track.
pub const FORMAT: &str = "cuereview-cursor";
/// The [`Header::version`] this module writes and reads.
pub const VERSION: u32 = 1;
/// How often the Windows sampler polls the pointer.
pub const SAMPLE_HZ: u32 = 60;
/// The sampler writes a line at least this often, even when nothing changed.
pub const HEARTBEAT_MS: u64 = 250;
/// [`CursorTrack::at`] ignores samples older than this. Three heartbeats, so a
/// stalled sampler or a missing tail reads as "unknown", not as stale data.
pub const STALE_MS: u64 = 3 * HEARTBEAT_MS;

/// State bit: the left button is held.
pub const LEFT: u8 = 1;
/// State bit: the right button is held.
pub const RIGHT: u8 = 2;
/// State bit: the middle button is held.
pub const MIDDLE: u8 = 4;
/// State bit: the pointer is not over the source: on another monitor, or over
/// a window covering the source window.
pub const OUTSIDE: u8 = 8;
const BUTTONS: u8 = LEFT | RIGHT | MIDDLE;

/// The pointer at one moment. Serialized as
/// `{tMs, x, y, px, py, inVideo}`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPoint {
    /// Milliseconds on the combined session timeline.
    pub t_ms: u64,
    /// Horizontal position as a fraction of the video width: 0 is the left
    /// edge and 1 the right edge. Outside 0..=1 when the pointer is outside.
    pub x: f64,
    /// Vertical position as a fraction of the video height, top to bottom.
    pub y: f64,
    /// Horizontal position in video pixels.
    pub px: i32,
    /// Vertical position in video pixels.
    pub py: i32,
    /// Whether the pointer was over the captured display or window.
    pub in_video: bool,
}

/// The button that was pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// A button press, located where and when the button went down. Serialized as
/// `{button, tMs, x, y, px, py, inVideo}`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Click {
    pub button: MouseButton,
    #[serde(flatten)]
    pub at: CursorPoint,
}

/// The first line of `cursor.jsonl`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    /// Always [`FORMAT`].
    pub format: String,
    /// Always [`VERSION`] for files this module can read.
    pub version: u32,
    /// `"display"` or `"window"`.
    pub source: String,
    /// The canvas (first video frame) in physical pixels; 0 when unknown.
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub sample_hz: u32,
}

impl Header {
    pub fn new(source: &str, canvas: Option<(u32, u32)>) -> Self {
        let (canvas_width, canvas_height) = canvas.unwrap_or_default();
        Self {
            format: FORMAT.into(),
            version: VERSION,
            source: source.into(),
            canvas_width,
            canvas_height,
            sample_hz: SAMPLE_HZ,
        }
    }
}

/// A known pointer position on a take's canvas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Position {
    /// Physical pixels right of the canvas's left edge; negative to its left.
    pub x: i32,
    /// Physical pixels below the canvas's top edge; negative above it.
    pub y: i32,
    /// Whether the pointer was over the source: on the captured monitor, or
    /// on the captured window with no other window covering it.
    pub over_source: bool,
    /// Buttons held: [`LEFT`], [`RIGHT`] and [`MIDDLE`] bits.
    pub buttons: u8,
}

impl Position {
    fn state(self) -> u8 {
        (self.buttons & BUTTONS) | if self.over_source { 0 } else { OUTSIDE }
    }
}

/// One line of a take's track, on the take's own capture clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    /// Milliseconds since the capture epoch.
    pub t_ms: u64,
    /// `None` starts a gap: the pointer is unknown until the next sample.
    pub at: Option<Position>,
}

/// Delta-encodes samples into `cursor.jsonl` lines.
pub struct CursorWriter<W: Write> {
    out: W,
    lines: u64,
    t_ms: u64,
    x: i32,
    y: i32,
    state: u8,
    /// Whether the last line written was a sample, not a gap or the header.
    known: bool,
}

impl<W: Write> CursorWriter<W> {
    /// Writes the header line.
    pub fn new(mut out: W, header: &Header) -> io::Result<Self> {
        serde_json::to_writer(&mut out, header)?;
        out.write_all(b"\n")?;
        Ok(Self {
            out,
            lines: 0,
            t_ms: 0,
            x: 0,
            y: 0,
            state: 0,
            known: false,
        })
    }

    /// Records one poll. Writes a line only when the pointer changed, a gap
    /// starts or ends, or [`HEARTBEAT_MS`] passed. Times earlier than the
    /// previous line are clamped to it.
    pub fn record(&mut self, sample: Sample) -> io::Result<()> {
        let t_ms = sample.t_ms.max(self.t_ms);
        let dt = t_ms - self.t_ms;
        let Some(at) = sample.at else {
            if self.known {
                writeln!(self.out, "[{dt}]")?;
                self.finish_line(t_ms);
                self.known = false;
            }
            return Ok(());
        };
        let state = at.state();
        let moved = (at.x, at.y) != (self.x, self.y);
        if self.known && !moved && state == self.state && dt < HEARTBEAT_MS {
            return Ok(());
        }
        let dx = i64::from(at.x) - i64::from(self.x);
        let dy = i64::from(at.y) - i64::from(self.y);
        if state == self.state {
            writeln!(self.out, "[{dt},{dx},{dy}]")?;
        } else {
            writeln!(self.out, "[{dt},{dx},{dy},{state}]")?;
        }
        self.finish_line(t_ms);
        (self.x, self.y, self.state, self.known) = (at.x, at.y, state, true);
        Ok(())
    }

    fn finish_line(&mut self, t_ms: u64) {
        self.t_ms = t_ms;
        self.lines += 1;
    }

    pub fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }

    /// Lines written after the header.
    pub fn lines(&self) -> u64 {
        self.lines
    }

    pub fn into_inner(self) -> W {
        self.out
    }
}

/// Decodes a `cursor.jsonl`. `None` when the header is missing or from an
/// unknown format or version. Decoding stops at the first malformed line.
pub fn decode(text: &str) -> Option<(Header, Vec<Sample>)> {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let header: Header = serde_json::from_str(lines.next()?).ok()?;
    if header.format != FORMAT || header.version != VERSION {
        return None;
    }
    let mut samples = Vec::new();
    let (mut t_ms, mut x, mut y, mut state) = (0u64, 0i32, 0i32, 0u8);
    for line in lines {
        let Ok(values) = serde_json::from_str::<Vec<i64>>(line) else {
            break;
        };
        let Some(dt) = values.first().and_then(|dt| u64::try_from(*dt).ok()) else {
            break;
        };
        let Some(next_t) = t_ms.checked_add(dt) else {
            break;
        };
        let at = match values[1..] {
            [] => None,
            [dx, dy] | [dx, dy, _] => {
                let moved = (
                    i32::try_from(i64::from(x) + dx),
                    i32::try_from(i64::from(y) + dy),
                );
                let (Ok(next_x), Ok(next_y)) = moved else {
                    break;
                };
                if let [_, _, next_state] = values[1..] {
                    match u8::try_from(next_state) {
                        Ok(next_state) if next_state <= BUTTONS | OUTSIDE => state = next_state,
                        _ => break,
                    }
                }
                (x, y) = (next_x, next_y);
                Some(Position {
                    x,
                    y,
                    over_source: state & OUTSIDE == 0,
                    buttons: state & BUTTONS,
                })
            }
            _ => break,
        };
        t_ms = next_t;
        samples.push(Sample { t_ms, at });
    }
    Some((header, samples))
}

/// Places a canvas position on the session video. See the module docs.
pub fn video_point(t_ms: u64, at: Position, canvas: (u32, u32), video: (u32, u32)) -> CursorPoint {
    let fraction = |pixel: i32, size: u32| (f64::from(pixel) + 0.5) / f64::from(size.max(1));
    let (x, y) = (fraction(at.x, canvas.0), fraction(at.y, canvas.1));
    let inside = |pixel: i32, size: u32| pixel >= 0 && i64::from(pixel) < i64::from(size);
    let round = |value: f64| (value * 10_000.0).round() / 10_000.0;
    CursorPoint {
        t_ms,
        x: round(x),
        y: round(y),
        px: (x * f64::from(video.0)).floor() as i32,
        py: (y * f64::from(video.1)).floor() as i32,
        in_video: at.over_source && inside(at.x, canvas.0) && inside(at.y, canvas.1),
    }
}

/// The size `finalize` gives a canvas: `scale=trunc(iw/2)*2:trunc(ih/2)*2`.
pub fn video_size(canvas: (u32, u32)) -> (u32, u32) {
    let even = |size: u32| (size / 2 * 2).max(2);
    (even(canvas.0), even(canvas.1))
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Entry {
    t_ms: u64,
    /// `None` starts a gap.
    point: Option<CursorPoint>,
}

/// All cursor samples of one session, on the combined session timeline.
#[derive(Clone, Debug, Default)]
pub struct CursorTrack {
    entries: Vec<Entry>,
    presses: Vec<Click>,
}

/// One take's samples, placed on the session timeline.
struct TakeCursor {
    offset_ms: u64,
    /// Where the take ends on the session timeline, when known.
    end_ms: Option<u64>,
    canvas: (u32, u32),
    video: (u32, u32),
    samples: Vec<Sample>,
}

impl CursorTrack {
    /// The pointer at `ms`, or `None` when no sample is close enough to it.
    /// This is the nearest sample at or before `ms`, with that sample's
    /// `t_ms`; a gap or a sample older than [`STALE_MS`] gives `None`.
    pub fn at(&self, ms: u64) -> Option<CursorPoint> {
        let index = self.entries.partition_point(|entry| entry.t_ms <= ms);
        let entry = self.entries.get(index.checked_sub(1)?)?;
        entry.point.filter(|_| ms - entry.t_ms <= STALE_MS)
    }

    /// Clicks with `a_ms <= tMs <= b_ms`, in time order.
    pub fn clicks(&self, a_ms: u64, b_ms: u64) -> Vec<Click> {
        let start = self.presses.partition_point(|click| click.at.t_ms < a_ms);
        let end = self.presses.partition_point(|click| click.at.t_ms <= b_ms);
        self.presses
            .get(start..end.max(start))
            .unwrap_or_default()
            .to_vec()
    }

    /// Takes must be in timeline order.
    fn from_takes(takes: Vec<TakeCursor>) -> Self {
        let mut track = Self::default();
        for take in takes {
            let mut held: Option<u8> = None;
            for sample in take.samples {
                let t_ms = take.offset_ms.saturating_add(sample.t_ms);
                if take.end_ms.is_some_and(|end| t_ms >= end) {
                    break;
                }
                if track.entries.last().is_some_and(|last| last.t_ms > t_ms) {
                    continue;
                }
                let point = sample
                    .at
                    .map(|at| video_point(t_ms, at, take.canvas, take.video));
                if let (Some(at), Some(point)) = (sample.at, point) {
                    if let Some(before) = held {
                        for (bit, button) in [
                            (LEFT, MouseButton::Left),
                            (RIGHT, MouseButton::Right),
                            (MIDDLE, MouseButton::Middle),
                        ] {
                            if at.buttons & bit != 0 && before & bit == 0 {
                                track.presses.push(Click { button, at: point });
                            }
                        }
                    }
                    held = Some(at.buttons);
                }
                track.entries.push(Entry { t_ms, point });
            }
            if let Some(end) = take.end_ms {
                if track
                    .entries
                    .last()
                    .is_some_and(|last| last.point.is_some())
                {
                    track.entries.push(Entry {
                        t_ms: end.max(track.entries.last().map_or(0, |last| last.t_ms)),
                        point: None,
                    });
                }
            }
        }
        track
    }
}

/// `folder` joined with a take's relative folder, refusing anything that
/// could leave the session folder.
fn take_dir(folder: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    relative
        .components()
        .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
        .then(|| folder.join(relative))
}

fn is_root(relative: &str) -> bool {
    Path::new(relative)
        .components()
        .all(|part| part == Component::CurDir)
}

/// The canvas recorded for a take: `capture-timing.json`, else the header.
fn take_canvas(dir: &Path, header: Option<&Header>) -> Option<(u32, u32)> {
    let timing = fs::read(dir.join("capture-timing.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|timing| {
            let size = |key: &str| u32::try_from(timing[key].as_u64()?).ok();
            Some((size("canvasWidth")?, size("canvasHeight")?))
        });
    let header = || {
        let header = match header {
            Some(header) => header.clone(),
            None => decode(&fs::read_to_string(dir.join(FILE_NAME)).ok()?)?.0,
        };
        Some((header.canvas_width, header.canvas_height))
    };
    timing
        .or_else(header)
        .filter(|(width, height)| *width > 0 && *height > 0)
}

/// Builds the track from a session folder and its `session.json`.
fn stitch(folder: &Path, session: &Session) -> Option<CursorTrack> {
    // (offset, duration, folder). Interrupted takes are not part of the video.
    let mut takes: Vec<(u64, u64, &str)> = session
        .takes
        .iter()
        .filter(|take| take.status != TakeStatus::Interrupted)
        .map(|take| (take.offset_ms, take.duration_ms, take.folder.as_str()))
        .collect();
    if !session.takes.iter().any(|take| is_root(&take.folder)) {
        // Legacy sessions, or a takes list without take 1: the root is take 1.
        let end = session.takes.iter().map(|take| take.offset_ms).min();
        takes.push((0, end.unwrap_or(session.duration_ms), "."));
    }
    takes.sort_by_key(|take| take.0);
    let base = takes
        .first()
        .and_then(|take| take_canvas(&take_dir(folder, take.2)?, None));
    let mut found = false;
    let mut placed = Vec::new();
    for (index, &(offset_ms, duration_ms, relative)) in takes.iter().enumerate() {
        let Some(dir) = take_dir(folder, relative) else {
            continue;
        };
        let Some((header, samples)) = fs::read_to_string(dir.join(FILE_NAME))
            .ok()
            .and_then(|text| decode(&text))
        else {
            continue;
        };
        let Some(canvas) = take_canvas(&dir, Some(&header)) else {
            continue;
        };
        found = true;
        let own_end = (duration_ms > 0).then(|| offset_ms.saturating_add(duration_ms));
        let next = takes.get(index + 1).map(|take| take.0);
        placed.push(TakeCursor {
            offset_ms,
            end_ms: own_end.into_iter().chain(next).min(),
            canvas,
            video: video_size(base.unwrap_or(canvas)),
            samples,
        });
    }
    found.then(|| CursorTrack::from_takes(placed))
}

/// The session's cursor track, or `None` when it has none: not recorded yet,
/// recorded on macOS or Linux, from a device source, or unreadable.
pub fn load(store: &Store, session_id: &str) -> Option<CursorTrack> {
    let folder = store.session_dir(session_id).ok()?;
    let session = store.session(session_id).ok()?;
    stitch(&folder, &session)
}

/// Whether [`mark_png`] draws `point`: inside the video and over the source.
fn marks(point: &CursorPoint) -> bool {
    point.in_video && (0.0..=1.0).contains(&point.x) && (0.0..=1.0).contains(&point.y)
}

fn read_image(path: &Path) -> Result<DynamicImage, String> {
    image::ImageReader::open(path)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|e| format!("Read {}: {e}", path.display()))?
        .decode()
        .map_err(|e| format!("Decode {}: {e}", path.display()))
}

/// Writes `image` as a PNG to a file that must not exist yet.
fn write_new_png(path: &Path, image: &DynamicImage) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("Create {}: {e}", path.display()))?;
    let result = (|| {
        let mut out = BufWriter::new(file);
        image
            .write_to(&mut out, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        out.into_inner()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(format!("Write {}: {error}", path.display()));
    }
    Ok(())
}

/// Draws the ring: a white outer band and a dark inner band, so it shows on
/// light and dark pictures, sized from the image's shorter side.
fn draw_ring(image: &mut RgbaImage, x: f64, y: f64) {
    let (width, height) = image.dimensions();
    let (cx, cy) = (x * f64::from(width), y * f64::from(height));
    let outer = (f64::from(width.min(height)) * 0.03).clamp(7.0, 72.0);
    let white = (outer * 0.22).max(2.0);
    let dark = (outer * 0.16).max(1.5);
    let bands = [
        (outer - white, outer, [255.0, 255.0, 255.0]),
        (outer - white - dark, outer - white, [24.0, 24.0, 27.0]),
    ];
    let reach = outer + 1.0;
    let span = |center: f64, size: u32| {
        let start = (center - reach).floor().clamp(0.0, f64::from(size)) as u32;
        let end = (center + reach).ceil().clamp(0.0, f64::from(size)) as u32;
        start..end
    };
    for py in span(cy, height) {
        for px in span(cx, width) {
            let distance = (f64::from(px) + 0.5 - cx).hypot(f64::from(py) + 0.5 - cy);
            let pixel = image.get_pixel_mut(px, py);
            for (inner, outer, color) in bands {
                // Antialiased coverage of this pixel by the band.
                let coverage = ((distance - inner).min(outer - distance) + 0.5).clamp(0.0, 1.0);
                if coverage <= 0.0 {
                    continue;
                }
                for (channel, target) in pixel.0.iter_mut().zip(color) {
                    *channel =
                        (f64::from(*channel) * (1.0 - coverage) + target * coverage).round() as u8;
                }
                pixel.0[3] = (f64::from(pixel.0[3]) + (255.0 - f64::from(pixel.0[3])) * coverage)
                    .round() as u8;
            }
        }
    }
}

/// `image` with the ring drawn at `point`, keeping an alpha channel only when
/// the image had one.
fn ringed(image: DynamicImage, point: &CursorPoint) -> DynamicImage {
    if !marks(point) {
        return image;
    }
    let alpha = image.color().has_alpha();
    let mut rgba = image.into_rgba8();
    draw_ring(&mut rgba, point.x, point.y);
    if alpha {
        DynamicImage::ImageRgba8(rgba)
    } else {
        DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).into_rgb8())
    }
}

/// Draws a ring at `point` on an exported frame, in place. The ring is placed
/// from the point's fractional `x`/`y`, so it also lands correctly on frames
/// scaled down to `max_width` (the `--max-width` the frame was exported with).
/// A point outside the video leaves the frame unchanged.
///
/// The marked frame is written to a new sibling file, which then replaces
/// `path` in one rename, so the export is never left half-written. Position
/// and ring size come from the image's own dimensions, which already reflect
/// any `max_width` scaling. Use [`mark_png_to`] to keep the original.
pub fn mark_png(path: &Path, point: &CursorPoint, _max_width: Option<u32>) -> Result<(), String> {
    if !marks(point) {
        return Ok(());
    }
    let marked = ringed(read_image(path)?, point);
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} is not a file", path.display()))?;
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    write_new_png(&temp, &marked)?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Replace {}: {e}", path.display())
    })
}

/// Like [`mark_png`], but writes the marked frame to `target`, which must not
/// exist: nothing is ever overwritten. A point outside the video writes an
/// unmarked copy.
pub fn mark_png_to(
    source: &Path,
    target: &Path,
    point: &CursorPoint,
    _max_width: Option<u32>,
) -> Result<(), String> {
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    write_new_png(target, &ringed(read_image(source)?, point))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CaptureConfig, Take};
    use serde_json::json;

    fn position(x: i32, y: i32, buttons: u8) -> Option<Position> {
        Some(Position {
            x,
            y,
            over_source: true,
            buttons,
        })
    }

    fn sample(t_ms: u64, at: Option<Position>) -> Sample {
        Sample { t_ms, at }
    }

    fn encode(header: &Header, samples: &[Sample]) -> String {
        let mut writer = CursorWriter::new(Vec::new(), header).unwrap();
        for sample in samples {
            writer.record(*sample).unwrap();
        }
        String::from_utf8(writer.into_inner()).unwrap()
    }

    fn take(
        index: u32,
        offset_ms: u64,
        duration_ms: u64,
        folder: &str,
        status: TakeStatus,
    ) -> Take {
        Take {
            index,
            offset_ms,
            duration_ms,
            status,
            folder: folder.into(),
            source_id: None,
            microphone_id: None,
            system_audio: false,
        }
    }

    /// A store with one session whose takes have the given cursor files.
    fn session_with(
        takes: Vec<Take>,
        duration_ms: u64,
        files: &[(&str, Header, Vec<Sample>)],
    ) -> (tempfile::TempDir, Store, String) {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let mut session = store
            .create_session(
                None,
                None,
                &CaptureConfig {
                    source_id: "monitor:1".into(),
                    microphone_id: None,
                    system_audio: false,
                    fps: 30,
                },
            )
            .unwrap();
        session.takes = takes;
        session.duration_ms = duration_ms;
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        let folder = store.session_dir(&session.id).unwrap();
        for (relative, header, samples) in files {
            let dir = folder.join(relative);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(FILE_NAME), encode(header, samples)).unwrap();
        }
        (root, store, session.id)
    }

    #[test]
    fn writer_delta_encodes_and_decode_round_trips() {
        let header = Header::new("window", Some((1280, 720)));
        let samples = [
            sample(412, position(640, 360, 0)),
            sample(429, position(643, 358, 0)),
            sample(445, position(643, 358, LEFT)),
            sample(445, position(643, 358, 0)),
            sample(
                462,
                Some(Position {
                    x: -20,
                    y: 900,
                    over_source: false,
                    buttons: RIGHT | MIDDLE,
                }),
            ),
            sample(500, None),
            sample(900, position(10, 10, 0)),
        ];
        let text = encode(&header, &samples);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(lines[0]).unwrap(),
            json!({"format":"cuereview-cursor","version":1,"source":"window",
                "canvasWidth":1280,"canvasHeight":720,"sampleHz":60})
        );
        assert_eq!(
            &lines[1..],
            [
                "[412,640,360]",
                "[17,3,-2]",
                "[16,0,0,1]",
                "[0,0,0,0]",
                "[17,-663,542,14]",
                "[38]",
                "[400,30,-890,0]"
            ]
        );
        let (decoded_header, decoded) = decode(&text).unwrap();
        assert_eq!(decoded_header, header);
        assert_eq!(decoded, samples);
    }

    #[test]
    fn writer_skips_unchanged_polls_but_keeps_a_heartbeat_and_one_gap_line() {
        let mut samples = Vec::new();
        for t in (0..=600).step_by(16) {
            samples.push(sample(t, position(5, 5, 0)));
        }
        samples.extend([sample(610, None), sample(626, None), sample(5000, None)]);
        samples.push(sample(5016, position(5, 5, 0)));
        let (_, decoded) = decode(&encode(&Header::new("display", None), &samples)).unwrap();
        let times: Vec<u64> = decoded.iter().map(|s| s.t_ms).collect();
        assert_eq!(times, [0, 256, 512, 610, 5016]);
        assert!(decoded[3].at.is_none());
        // A gap before the first sample adds nothing; earlier times are clamped.
        let text = encode(
            &Header::new("display", None),
            &[
                sample(50, None),
                sample(90, position(1, 2, 0)),
                sample(80, position(2, 2, 0)),
            ],
        );
        assert_eq!(
            text.lines().skip(1).collect::<Vec<_>>(),
            ["[90,1,2]", "[0,1,0]"]
        );
    }

    #[test]
    fn decode_rejects_unknown_headers_and_stops_at_a_torn_tail() {
        assert!(decode("").is_none());
        assert!(decode("[1,2,3]\n").is_none());
        assert!(decode(r#"{"format":"other","version":1,"source":"display","canvasWidth":1,"canvasHeight":1,"sampleHz":60}"#).is_none());
        let header = serde_json::to_string(&Header::new("display", Some((100, 50)))).unwrap();
        assert!(decode(&header.replace("\"version\":1", "\"version\":2")).is_none());
        for tail in [
            "[16,1",
            "[-1,0,0]",
            "[1,0,0,99]",
            "[1,0]",
            "[1,0,0,0,0]",
            "[1,0,99999999999]",
        ] {
            let (_, samples) =
                decode(&format!("{header}\n[10,5,5]\r\n\n{tail}\n[16,1,1]\n")).unwrap();
            assert_eq!(samples, [sample(10, position(5, 5, 0))], "{tail}");
        }
    }

    #[test]
    fn video_points_use_pixel_centers_and_even_video_sizes() {
        // A window whose canvas is odd: finalize scales 641x427 to 640x426.
        let canvas = (641, 427);
        let video = video_size(canvas);
        assert_eq!(video, (640, 426));
        let at = |x, y| Position {
            x,
            y,
            over_source: true,
            buttons: 0,
        };
        let corner = video_point(5, at(640, 426), canvas, video);
        assert_eq!((corner.px, corner.py, corner.in_video), (639, 425, true));
        assert!(corner.x < 1.0 && corner.y < 1.0);
        let origin = video_point(5, at(0, 0), canvas, video);
        assert_eq!((origin.px, origin.py, origin.in_video), (0, 0, true));
        let center = video_point(5, at(320, 213), canvas, video);
        assert_eq!(
            (center.x, center.y, center.px, center.py),
            (0.5, 0.5, 320, 213)
        );
        for (x, y) in [(-1, 10), (641, 10), (10, -1), (10, 427)] {
            assert!(!video_point(5, at(x, y), canvas, video).in_video, "{x},{y}");
        }
        let left = video_point(5, at(-641, 0), canvas, video);
        assert!(left.x < 0.0 && left.px < 0);
        let occluded = Position {
            over_source: false,
            ..at(10, 10)
        };
        assert!(!video_point(5, occluded, canvas, video).in_video);
    }

    #[test]
    fn at_uses_the_nearest_previous_sample_with_a_staleness_limit() {
        let header = Header::new("display", Some((1920, 1080)));
        let samples = vec![
            sample(100, position(960, 540, 0)),
            sample(116, position(970, 540, 0)),
            sample(2000, position(100, 100, 0)),
            sample(2100, None),
            sample(2400, position(200, 200, 0)),
        ];
        let (_root, store, id) = session_with(Vec::new(), 0, &[(".", header, samples)]);
        let track = load(&store, &id).unwrap();
        assert_eq!(track.at(99), None);
        assert_eq!(track.at(100).unwrap().px, 960);
        assert_eq!(track.at(115).unwrap().t_ms, 100);
        let held = track.at(116 + STALE_MS).unwrap();
        assert_eq!((held.t_ms, held.px, held.x), (116, 970, 0.5055));
        assert_eq!(track.at(117 + STALE_MS), None);
        assert_eq!(track.at(2099).unwrap().px, 100);
        assert_eq!(track.at(2100), None);
        assert_eq!(track.at(2399), None);
        assert_eq!(track.at(2400).unwrap().py, 200);
        assert_eq!(track.at(u64::MAX), None);
    }

    #[test]
    fn clicks_are_presses_after_the_first_sample_within_inclusive_bounds() {
        let header = Header::new("window", Some((800, 600)));
        let outside = Some(Position {
            x: 900,
            y: 10,
            over_source: false,
            buttons: RIGHT,
        });
        let samples = vec![
            // Held when sampling started: the initial state, not a press.
            sample(100, position(10, 10, LEFT)),
            sample(200, position(10, 10, 0)),
            sample(300, position(20, 30, LEFT)),
            sample(300, position(20, 30, 0)),
            sample(400, outside),
            sample(500, None),
            sample(600, position(40, 40, RIGHT | MIDDLE)),
            sample(700, position(40, 40, LEFT | RIGHT | MIDDLE)),
        ];
        let (_root, store, id) = session_with(Vec::new(), 1000, &[(".", header, samples)]);
        let track = load(&store, &id).unwrap();
        let all = track.clicks(0, u64::MAX);
        let summary: Vec<(MouseButton, u64, bool)> = all
            .iter()
            .map(|click| (click.button, click.at.t_ms, click.at.in_video))
            .collect();
        assert_eq!(
            summary,
            [
                (MouseButton::Left, 300, true),
                (MouseButton::Right, 400, false),
                (MouseButton::Middle, 600, true),
                (MouseButton::Left, 700, true)
            ]
        );
        assert_eq!((all[0].at.px, all[0].at.py), (20, 30));
        assert_eq!(track.clicks(300, 400).len(), 2);
        assert_eq!(track.clicks(301, 599).len(), 1);
        assert_eq!(track.clicks(700, 700)[0].button, MouseButton::Left);
        assert!(track.clicks(701, u64::MAX).is_empty());
        assert!(track.clicks(400, 300).is_empty());
        assert_eq!(
            serde_json::to_value(all[0]).unwrap(),
            json!({"button":"left","tMs":300,"x":0.0256,"y":0.0508,"px":20,"py":30,"inVideo":true})
        );
    }

    #[test]
    fn takes_are_stitched_by_offset_with_a_gap_at_each_take_end() {
        let full_hd = Header::new("display", Some((1920, 1080)));
        let files = [
            (
                ".",
                full_hd.clone(),
                vec![
                    sample(500, position(100, 100, 0)),
                    sample(9_900, position(110, 100, 0)),
                ],
            ),
            (
                "takes/2",
                // Another canvas: fractions stay, pixels follow take 1's video.
                Header::new("display", Some((1280, 720))),
                vec![
                    sample(300, position(640, 360, 0)),
                    sample(400, position(640, 360, LEFT)),
                ],
            ),
            (
                "takes/3",
                full_hd.clone(),
                vec![sample(200, position(1, 1, 0))],
            ),
        ];
        let takes = vec![
            take(2, 10_000, 5_000, "takes/2", TakeStatus::Ready),
            take(1, 0, 10_000, ".", TakeStatus::Ready),
            take(3, 15_000, 4_000, "takes/3", TakeStatus::Interrupted),
        ];
        let (root, store, id) = session_with(takes, 15_000, &files);
        // capture-timing.json wins over the header.
        fs::write(
            store.session_dir(&id).unwrap().join("capture-timing.json"),
            r#"{"canvasWidth":1920,"canvasHeight":1080}"#,
        )
        .unwrap();
        let track = load(&store, &id).unwrap();
        assert_eq!(track.at(9_950).unwrap().px, 110);
        // Take 1 ends at 10 s; take 2 has no sample before 10.3 s.
        assert_eq!(track.at(10_000), None);
        assert_eq!(track.at(10_299), None);
        let point = track.at(10_350).unwrap();
        assert_eq!((point.t_ms, point.x, point.y), (10_300, 0.5004, 0.5007));
        assert_eq!((point.px, point.py), (960, 540));
        let clicks = track.clicks(0, u64::MAX);
        assert_eq!(clicks.len(), 1);
        assert_eq!((clicks[0].at.t_ms, clicks[0].at.px), (10_400, 960));
        // The interrupted take 3 is not on the timeline, and take 2 ends at 15 s.
        assert_eq!(track.at(15_000), None);
        assert_eq!(track.at(15_200), None);
        drop(root);
    }

    #[test]
    fn load_handles_missing_and_unsafe_tracks() {
        let header = Header::new("display", Some((100, 100)));
        let (_root, store, id) = session_with(Vec::new(), 0, &[]);
        assert!(load(&store, &id).is_none());
        assert!(load(&store, "not-a-session").is_none());
        assert!(load(&store, "0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10").is_none());
        // A takes list without the root: the root is take 1 up to the first offset.
        let takes = vec![
            take(2, 4_000, 1_000, "takes/2", TakeStatus::Ready),
            take(3, 5_000, 1_000, "../escape", TakeStatus::Ready),
        ];
        let files = [
            (".", header.clone(), vec![sample(3_990, position(1, 1, 0))]),
            (
                "takes/2",
                header.clone(),
                vec![sample(10, position(2, 2, 0))],
            ),
        ];
        let (_root, store, id) = session_with(takes, 6_000, &files);
        let track = load(&store, &id).unwrap();
        assert_eq!(track.at(3_995).unwrap().px, 1);
        assert_eq!(track.at(4_010).unwrap().px, 2);
        assert_eq!(take_dir(Path::new("/s"), "../escape"), None);
        assert_eq!(take_dir(Path::new("/s"), "/abs"), None);
        assert!(is_root(".") && is_root("") && !is_root("takes/1"));
        // An unknown canvas cannot be mapped.
        let files = [(
            ".",
            Header::new("display", None),
            vec![sample(1, position(1, 1, 0))],
        )];
        let (_root, store, id) = session_with(Vec::new(), 0, &files);
        assert!(load(&store, &id).is_none());
    }

    fn gray_png(dir: &Path, width: u32, height: u32) -> PathBuf {
        let path = dir.join("frame.png");
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            width,
            height,
            image::Rgb([128, 128, 128]),
        ))
        .save(&path)
        .unwrap();
        path
    }

    fn point(x: f64, y: f64, in_video: bool) -> CursorPoint {
        CursorPoint {
            t_ms: 0,
            x,
            y,
            px: 0,
            py: 0,
            in_video,
        }
    }

    #[test]
    fn mark_png_draws_a_white_and_dark_ring_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = gray_png(dir.path(), 1280, 720);
        mark_png(&path, &point(0.5, 0.5, true), Some(1280)).unwrap();
        let marked = read_image(&path).unwrap();
        assert!(!marked.color().has_alpha());
        let marked = marked.into_rgb8();
        // 720 * 0.03 = 21.6: white band 16.85..21.6, dark band 13.39..16.85.
        let at = |dx: i32| marked.get_pixel((640 + dx) as u32, 360).0;
        assert_eq!(at(0), [128, 128, 128]);
        assert_eq!(at(-30), [128, 128, 128]);
        assert_eq!(at(10), [128, 128, 128]);
        assert!(at(18).iter().all(|c| *c > 240), "{:?}", at(18));
        assert!(at(-19).iter().all(|c| *c > 240), "{:?}", at(-19));
        assert!(at(14).iter().all(|c| *c < 40), "{:?}", at(14));
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no temporary file is left"
        );

        // Outside the video, or not over the source: the frame is unchanged.
        let before = fs::read(&path).unwrap();
        for outside in [
            point(1.2, 0.5, false),
            point(0.5, 0.5, false),
            point(-0.1, 0.5, true),
        ] {
            mark_png(&path, &outside, None).unwrap();
        }
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(mark_png(
            &dir.path().join("missing.png"),
            &point(0.5, 0.5, true),
            None
        )
        .is_err());
    }

    #[test]
    fn mark_png_to_never_overwrites_and_scales_the_ring() {
        let dir = tempfile::tempdir().unwrap();
        let source = gray_png(dir.path(), 320, 180);
        let target = dir.path().join("marked.png");
        mark_png_to(&source, &target, &point(0.25, 0.75, true), Some(320)).unwrap();
        // 180 * 0.03 is below the 7 px minimum: white band 5..7 px out.
        let marked = read_image(&target).unwrap().into_rgb8();
        assert!(marked.get_pixel(80 + 6, 135).0.iter().all(|c| *c > 200));
        assert_eq!(marked.get_pixel(80, 135).0, [128, 128, 128]);
        assert_eq!(
            read_image(&source)
                .unwrap()
                .into_rgb8()
                .get_pixel(86, 135)
                .0,
            [128, 128, 128]
        );
        let kept = fs::read(&target).unwrap();
        assert!(mark_png_to(&source, &target, &point(0.5, 0.5, true), None).is_err());
        assert_eq!(fs::read(&target).unwrap(), kept);
        // A ring at the very edge is clipped, not a panic.
        let edge = dir.path().join("edge.png");
        mark_png_to(&source, &edge, &point(1.0, 0.0, true), None).unwrap();
    }

    #[test]
    fn stub_reports_no_cursor_and_keeps_the_wire_format() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        assert!(load(&store, "0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10").is_none());
        let track = CursorTrack::default();
        assert_eq!(track.at(1000), None);
        assert!(track.clicks(0, u64::MAX).is_empty());
        let at = CursorPoint {
            t_ms: 1200,
            x: 0.5,
            y: 0.25,
            px: 960,
            py: 270,
            in_video: true,
        };
        assert_eq!(
            serde_json::to_value(Click {
                button: MouseButton::Left,
                at
            })
            .unwrap(),
            json!({"button":"left","tMs":1200,"x":0.5,"y":0.25,"px":960,"py":270,"inVideo":true})
        );
    }
}
