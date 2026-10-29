//! Touch tracking for Android device recordings.
//!
//! # Recording
//!
//! An `android:<serial>` source records through scrcpy with `--no-control`,
//! so the host pointer never reaches the device and the Windows sampler has
//! nothing to read. Instead, once scrcpy has decoded its first frame,
//! [`crate::capture`] starts a [`Reader`] beside it, for the app and
//! `cue record` alike. The reader's thread runs one probe,
//! `adb -s <serial> shell` with [`PROBE`]: the product model,
//! `getevent -lp` and the display rotation. It then streams
//! `adb -s <serial> shell getevent -lt` (no root needed) into the take's
//! `cursor.jsonl`. `ActiveCapture::stop` stops it first: it kills the adb
//! client, which also ends `getevent` on the device, reads what is left and
//! joins the thread.
//!
//! Meta Quest is skipped ([`is_quest`]): its controllers and hand tracking
//! are not Android input devices, so `getevent` has nothing to report.
//!
//! # Touchscreens
//!
//! [`touchscreens`] keeps the `getevent -lp` devices with
//! `ABS_MT_POSITION_X`/`Y` and `ABS_MT_SLOT` (multitouch protocol B; protocol
//! A predates the Android versions scrcpy supports), except touchpads
//! (`INPUT_PROP_POINTER`). When any of them has `INPUT_PROP_DIRECT`, only
//! those remain. The emulator's `virtio_input_multi_touch_N` panels have
//! neither property (IDC files make them touchscreens) and one per display;
//! foldables have one per panel. A single touchscreen is passed to `getevent`
//! by path; several are all read, and the first to start a contact owns the
//! track until it lifts.
//!
//! # Contacts
//!
//! [`Contacts`] follows the slots and tracking ids and evaluates each
//! `SYN_REPORT` frame. Only the primary contact is written: a contact that
//! starts while no earlier contact is still down (the lowest slot wins when
//! several start in one frame). Fingers added to it are ignored, and so is
//! the rest of a gesture once its primary contact lifts. Extra fingers are
//! out of scope rather than a `cursor.jsonl` version 2: every reader of
//! version 1, including `cue` 0.2.0, keeps working on device takes, and a
//! single pointer is what `at`, `clicks` and `--mark-cursor` model.
//!
//! evdev only sends values that changed, and `getevent -lp` reports 0 for
//! every multitouch axis, so a slot's position is unknown until both axes
//! have been reported once in this take. A contact is written from the first
//! frame where both are known; a tap that lands exactly on the previous
//! contact's raw x or y in a slot not yet seen is not written. The current
//! slot does come from `getevent -lp` (`ABS_MT_SLOT`'s value).
//! `SYN_DROPPED` starts a gap and forgets every contact, so a finger already
//! down is not followed until it touches again; `BTN_TOUCH` up ends every
//! contact. A contact whose tool type is `MT_TOOL_PALM` does not touch, as
//! InputReader cancels palm pointers, and one that turns into a finger
//! touches down then. The Pixel 8 flags some deliberate taps near its corners
//! as palms from start to finish; Android does not deliver those either.
//!
//! The primary contact becomes `cursor.jsonl` samples (see [`crate::cursor`]):
//! touch-down is a sample with no buttons and one with [`cursor::LEFT`] at the
//! same time and place, so every touch, the take's first one included, is a
//! press; a move is a `LEFT` sample; lifting is a sample with no buttons at
//! the last place followed by a gap, since touch has no hover position.
//! While a finger rests, heartbeats are filled in up to the next frame (or
//! the stop), so [`cursor::CursorTrack::at`] does not report a resting finger
//! as stale. `over_source` is always true: nothing covers a device screen.
//! The header's `source` is `"device"`.
//!
//! # Mapping
//!
//! [`place`] takes a raw position to canvas pixels:
//!
//! 1. The pixel center of the raw step as a fraction of the axis range
//!    (`max - min + 1` steps), as InputReader scales a panel onto its
//!    display. The panel's natural orientation is assumed to be the
//!    display's, which holds unless an IDC file sets `touch.orientation`.
//! 2. The rotation of display 0, as InputReader applies it: the
//!    `orientation=` of its display-0 viewport in `dumpsys input` (Android
//!    9+), else `SurfaceOrientation:` (older versions); see
//!    [`parse_rotation`]. It is read at the start and again at a touch-down
//!    at least [`ROTATION_REFRESH`] after the last read, so a touch shortly
//!    after a rotation can still use the previous one.
//! 3. That fraction of the canvas: the first decoded scrcpy texture
//!    (`INFO: Texture: WxH`), which is the recorded frame size. scrcpy scales
//!    the whole display into its video size (rounded to multiples of 8), so
//!    fractions carry over exactly.
//!
//! The mapping assumes scrcpy captures display 0 uncropped and unrotated,
//! which is how [`crate::capture`] runs it. A rotation that keeps the
//! canvas's shape (portrait to upside-down portrait) maps exactly. One
//! between portrait and landscape makes scrcpy restart at the new size, and
//! `finalize` currently loses those frames and shifts the rest of the take
//! (the native recording still has them). Touches after such a rotation are
//! still written as fractions of the rotated display over the canvas, which
//! is right for a video that stretches those frames to the canvas, but the
//! current video does not show them in place.
//!
//! # Clock
//!
//! `getevent -t` stamps each event with the device's own clock. [`Clock`]
//! maps those stamps onto the capture epoch with the smallest
//! `received - stamped` difference seen so far, the frame that crossed adb
//! fastest. Times therefore keep the device's spacing whatever adb's
//! buffering does, and lie that fastest delivery after the touch on the
//! epoch. Each frame's delay beyond the fastest one, as the reader saw it, is
//! recorded as `touchDelayMs` (`frames`, `p50`, `p95`, `max`) in
//! `capture-timing.json`. A touch-down's rotation read (50 to 160 ms) delays
//! the frames queued behind it, but not their times.
//!
//! The video itself runs behind the device: scrcpy's first decoded frame
//! anchors the video at `videoHostStartMs`, after the device captured,
//! encoded and sent it. A frame exported at a touch's time therefore shows
//! the screen just before the finger landed. Android's "Show taps" dot
//! appeared in the 30 fps video a median 99 ms (77 to 128 ms) after the
//! touch's time on a Pixel 8, and 89 to 128 ms on the Android 15 emulator
//! (that includes drawing the dot); `touchDelayMs` was 4.0 and 0.4 ms at the
//! median.

use crate::{
    capture::output_with_timeout,
    cursor::{self, CursorWriter, Header, Position, Sample},
    deps,
};
use serde::Serialize;
use std::{
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::Path,
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const EV_SYN: u16 = 0x00;
const EV_KEY: u16 = 0x01;
const EV_ABS: u16 = 0x03;
const SYN_REPORT: u16 = 0x00;
const SYN_DROPPED: u16 = 0x03;
const BTN_TOUCH: u16 = 0x14a;
const ABS_MT_SLOT: u16 = 0x2f;
const ABS_MT_POSITION_X: u16 = 0x35;
const ABS_MT_POSITION_Y: u16 = 0x36;
const ABS_MT_TOOL_TYPE: u16 = 0x37;
const ABS_MT_TRACKING_ID: u16 = 0x39;
const MT_TOOL_PALM: i32 = 0x02;
/// Slots beyond this are ignored; panels have about ten.
const MAX_SLOTS: usize = 64;

/// Separates the sections of [`PROBE`]'s output.
const MARKER: &str = "@@cuereview@@";
/// The device probe: model, input devices, display rotation.
const PROBE: &str = "getprop ro.product.model; echo @@cuereview@@; getevent -lp; echo @@cuereview@@; dumpsys input | grep -e Viewport -e SurfaceOrientation";
/// Reads the display rotation again.
const ROTATION: &str = "dumpsys input | grep -e Viewport -e SurfaceOrientation";
/// A touch-down reads the rotation again when the last read is this old.
pub const ROTATION_REFRESH: Duration = Duration::from_secs(1);
/// Frame delays kept for `touchDelayMs`, about 14 minutes of dragging at 240 Hz.
const MAX_DELAYS: usize = 200_000;

/// Whether a product model is a Meta Quest, as `adb devices -l` names it.
pub fn is_quest(model: &str) -> bool {
    model.to_lowercase().contains("quest")
}

/// One `getevent -lt` event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event<'a> {
    /// The device's event time in microseconds.
    pub time_us: u64,
    /// The device path, printed when `getevent` reads several devices.
    pub device: Option<&'a str>,
    pub kind: u16,
    pub code: u16,
    pub value: i32,
}

/// A type or code: one of the labels this module uses, or four hex digits.
fn event_code(token: &str) -> Option<u16> {
    Some(match token {
        "EV_SYN" => EV_SYN,
        "EV_KEY" => EV_KEY,
        "EV_ABS" => EV_ABS,
        "SYN_REPORT" => SYN_REPORT,
        "SYN_DROPPED" => SYN_DROPPED,
        "BTN_TOUCH" => BTN_TOUCH,
        "ABS_MT_SLOT" => ABS_MT_SLOT,
        "ABS_MT_POSITION_X" => ABS_MT_POSITION_X,
        "ABS_MT_POSITION_Y" => ABS_MT_POSITION_Y,
        "ABS_MT_TOOL_TYPE" => ABS_MT_TOOL_TYPE,
        "ABS_MT_TRACKING_ID" => ABS_MT_TRACKING_ID,
        _ if token.len() == 4 => u16::from_str_radix(token, 16).ok()?,
        _ => return None,
    })
}

/// A value: a key state or tool type label, or eight hex digits as two's
/// complement.
fn event_value(token: &str) -> Option<i32> {
    Some(match token {
        "UP" | "MT_TOOL_FINGER" => 0,
        "DOWN" | "MT_TOOL_PEN" => 1,
        "REPEAT" => 2,
        "MT_TOOL_PALM" => MT_TOOL_PALM,
        "MT_TOOL_DIAL" => 0x0a,
        _ if token.len() == 8 => u32::from_str_radix(token, 16).ok()? as i32,
        _ => return None,
    })
}

/// `getevent -t`'s `seconds.micros` stamp.
fn event_time(text: &str) -> Option<u64> {
    let (seconds, micros) = text.split_once('.')?;
    if micros.len() != 6 || !micros.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let seconds: u64 = seconds.parse().ok()?;
    seconds
        .checked_mul(1_000_000)?
        .checked_add(micros.parse().ok()?)
}

/// Parses one `getevent -lt` line, such as
/// `[  654.732322] /dev/input/event2: EV_ABS ABS_MT_POSITION_X 00002000`.
/// `None` for device listings, unlabeled codes this module ignores
/// (`ABS_MT_PRESSURE`), and anything malformed.
pub fn parse_event(line: &str) -> Option<Event<'_>> {
    let rest = line.trim_start().strip_prefix('[')?;
    let (time, rest) = rest.split_once(']')?;
    let time_us = event_time(time.trim())?;
    let rest = rest.trim_start();
    let (device, rest) = if rest.starts_with('/') {
        let (path, rest) = rest.split_once(": ")?;
        (Some(path), rest)
    } else {
        (None, rest)
    };
    let mut tokens = rest.split_whitespace();
    let event = Event {
        time_us,
        device,
        kind: event_code(tokens.next()?)?,
        code: event_code(tokens.next()?)?,
        value: event_value(tokens.next()?)?,
    };
    tokens.next().is_none().then_some(event)
}

/// A raw axis range from `getevent -lp`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Axis {
    pub min: i32,
    pub max: i32,
}

/// A touchscreen from `getevent -lp`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Touchscreen {
    pub path: String,
    pub name: String,
    pub x: Axis,
    pub y: Axis,
    /// The slot selected when the listing was read.
    pub slot: usize,
}

/// One device of a `getevent -lp` listing, while it is read.
#[derive(Default)]
struct Listed {
    path: String,
    name: String,
    x: Option<Axis>,
    y: Option<Axis>,
    slot: Option<usize>,
    direct: bool,
    pointer: bool,
}

impl Listed {
    fn touchscreen(self) -> Option<(Touchscreen, bool)> {
        let (x, y) = (self.x?, self.y?);
        if self.pointer || x.max <= x.min || y.max <= y.min {
            return None;
        }
        let screen = Touchscreen {
            path: self.path,
            name: self.name,
            x,
            y,
            slot: self.slot?,
        };
        Some((screen, self.direct))
    }
}

/// `V, min A, max B, …` after an axis code's `: value `: `(V, A, B)`.
fn axis_values(text: &str) -> Option<(i32, i32, i32)> {
    let mut parts = text.split(',');
    let value = parts.next()?.trim().parse().ok()?;
    let (mut min, mut max) = (None, None);
    for part in parts {
        match part.split_whitespace().collect::<Vec<_>>()[..] {
            ["min", number] => min = number.parse().ok(),
            ["max", number] => max = number.parse().ok(),
            _ => (),
        }
    }
    Some((value, min?, max?))
}

/// The touchscreens of a `getevent -lp` listing; see the module docs.
pub fn touchscreens(listing: &str) -> Vec<Touchscreen> {
    let mut listed = Vec::new();
    let mut current: Option<Listed> = None;
    let mut props = false;
    for line in listing.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("add device ") {
            listed.extend(current.take());
            current = rest.split_once(": ").map(|(_, path)| Listed {
                path: path.trim().into(),
                ..Listed::default()
            });
            props = false;
            continue;
        }
        let Some(device) = current.as_mut() else {
            continue;
        };
        if let Some(name) = line.strip_prefix("name:") {
            device.name = name.trim().trim_matches('"').into();
        } else if line == "input props:" {
            props = true;
        } else if props {
            device.direct |= line == "INPUT_PROP_DIRECT";
            device.pointer |= line == "INPUT_PROP_POINTER";
        } else if let Some((code, values)) = line.split_once(": value ") {
            let code = code.split_whitespace().last().and_then(event_code);
            let Some((value, min, max)) = axis_values(values) else {
                continue;
            };
            match code {
                Some(ABS_MT_POSITION_X) => device.x = Some(Axis { min, max }),
                Some(ABS_MT_POSITION_Y) => device.y = Some(Axis { min, max }),
                Some(ABS_MT_SLOT) => device.slot = usize::try_from(value).ok(),
                _ => (),
            }
        }
    }
    listed.extend(current);
    let found: Vec<(Touchscreen, bool)> =
        listed.into_iter().filter_map(Listed::touchscreen).collect();
    let direct = found.iter().any(|(_, direct)| *direct);
    found
        .into_iter()
        .filter(|(_, is_direct)| *is_direct || !direct)
        .map(|(screen, _)| screen)
        .collect()
}

/// The rotation of display 0, as `Surface.ROTATION_0` to `ROTATION_270`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Rotation {
    #[default]
    Deg0,
    Deg90,
    Deg180,
    Deg270,
}

impl Rotation {
    /// `1`, `90`, `ROTATION_90` or `Rotation90`, and so on.
    fn parse(text: &str) -> Option<Self> {
        let text = text
            .trim()
            .trim_start_matches("ROTATION_")
            .trim_start_matches("Rotation");
        let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
        Some(match digits.as_str() {
            "0" => Self::Deg0,
            "1" | "90" => Self::Deg90,
            "2" | "180" => Self::Deg180,
            "3" | "270" => Self::Deg270,
            _ => return None,
        })
    }
}

/// The rotation of display 0 in `dumpsys input` output: the `orientation=`
/// of a viewport with `displayId=0` (Android 9 and later print
/// `Viewport INTERNAL: displayId=0, …, orientation=1, …`), else the first
/// `SurfaceOrientation:` (Android 12 and older).
pub fn parse_rotation(dumpsys: &str) -> Option<Rotation> {
    let viewport = dumpsys
        .lines()
        .filter(|line| line.contains("Viewport") && line.contains("displayId=0,"))
        .find_map(|line| Rotation::parse(line.split_once("orientation=")?.1));
    viewport.or_else(|| {
        dumpsys
            .lines()
            .find_map(|line| Rotation::parse(line.trim().strip_prefix("SurfaceOrientation:")?))
    })
}

/// A raw panel position in canvas pixels; see the module docs. Raw values
/// outside the axis range land outside the canvas.
pub fn place(
    screen: &Touchscreen,
    rotation: Rotation,
    canvas: (u32, u32),
    (x, y): (i32, i32),
) -> (i32, i32) {
    let fraction = |raw: i32, axis: Axis| {
        (f64::from(raw) - f64::from(axis.min) + 0.5)
            / (f64::from(axis.max) - f64::from(axis.min) + 1.0)
    };
    let (u, v) = (fraction(x, screen.x), fraction(y, screen.y));
    let (x, y) = match rotation {
        Rotation::Deg0 => (u, v),
        Rotation::Deg90 => (v, 1.0 - u),
        Rotation::Deg180 => (1.0 - u, 1.0 - v),
        Rotation::Deg270 => (1.0 - v, u),
    };
    (
        (x * f64::from(canvas.0)).floor() as i32,
        (y * f64::from(canvas.1)).floor() as i32,
    )
}

/// What a frame did to the primary contact, in raw panel units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Touch {
    /// It touched down, or its position became known.
    Down(i32, i32),
    /// It is still down; reported for every frame.
    Move(i32, i32),
    /// It lifted.
    Up,
    /// Events were dropped: nothing is known about it any more.
    Lost,
}

#[derive(Clone, Copy, Debug, Default)]
struct Slot {
    /// [`Slot::touching`] at the last `SYN_REPORT`.
    reported: Option<i32>,
    /// The tracking id now; `None` when no contact uses the slot.
    id: Option<i32>,
    /// The tool type is `MT_TOOL_PALM`. Like positions, it is only sent when
    /// it changes, so it carries over to the slot's next contact.
    palm: bool,
    x: Option<i32>,
    y: Option<i32>,
}

impl Slot {
    /// The tracking id of a contact that touches: a palm does not, as
    /// InputReader cancels palm pointers.
    fn touching(&self) -> Option<i32> {
        self.id.filter(|_| !self.palm)
    }
    /// A contact that was already touching at the last frame.
    fn continuing(&self) -> bool {
        self.touching().is_some() && self.touching() == self.reported
    }
    /// A contact that started touching since the last frame.
    fn started(&self) -> bool {
        self.touching().is_some() && self.touching() != self.reported
    }
    fn position(&self) -> Option<(i32, i32)> {
        Some((self.x?, self.y?))
    }
}

/// The multitouch protocol B state of one touchscreen; see the module docs.
#[derive(Clone, Debug)]
pub struct Contacts {
    slots: Vec<Slot>,
    /// The slot events apply to; `None` for a slot beyond [`MAX_SLOTS`].
    slot: Option<usize>,
    primary: Option<usize>,
    /// Whether the primary contact's `Down` was reported.
    placed: bool,
    /// After `SYN_DROPPED`, events are ignored up to the next `SYN_REPORT`.
    dropped: bool,
    /// `BTN_TOUCH` went up in this frame.
    released: bool,
}

impl Contacts {
    pub fn new(slot: usize) -> Self {
        Self {
            slots: Vec::new(),
            slot: (slot < MAX_SLOTS).then_some(slot),
            primary: None,
            placed: false,
            dropped: false,
            released: false,
        }
    }

    fn current(&mut self) -> Option<&mut Slot> {
        let index = self.slot?;
        if self.slots.len() <= index {
            self.slots.resize(index + 1, Slot::default());
        }
        self.slots.get_mut(index)
    }

    /// Applies one event. A `SYN_REPORT` or `SYN_DROPPED` returns what it did
    /// to the primary contact; at most an `Up` and a `Down`, in that order.
    pub fn apply(&mut self, kind: u16, code: u16, value: i32) -> Vec<Touch> {
        if self.dropped {
            if (kind, code) == (EV_SYN, SYN_REPORT) {
                self.dropped = false;
            }
            return Vec::new();
        }
        match (kind, code) {
            (EV_SYN, SYN_REPORT) => return self.report(),
            (EV_SYN, SYN_DROPPED) => return self.drop_all(),
            (EV_KEY, BTN_TOUCH) => self.released |= value == 0,
            (EV_ABS, ABS_MT_SLOT) => {
                self.slot = usize::try_from(value).ok().filter(|slot| *slot < MAX_SLOTS)
            }
            (EV_ABS, ABS_MT_TRACKING_ID) => {
                if let Some(slot) = self.current() {
                    slot.id = (value >= 0).then_some(value);
                }
            }
            (EV_ABS, ABS_MT_TOOL_TYPE) => {
                if let Some(slot) = self.current() {
                    slot.palm = value == MT_TOOL_PALM;
                }
            }
            (EV_ABS, ABS_MT_POSITION_X) => {
                if let Some(slot) = self.current() {
                    slot.x = Some(value);
                }
            }
            (EV_ABS, ABS_MT_POSITION_Y) => {
                if let Some(slot) = self.current() {
                    slot.y = Some(value);
                }
            }
            _ => (),
        }
        Vec::new()
    }

    fn report(&mut self) -> Vec<Touch> {
        let mut touches = Vec::new();
        if std::mem::take(&mut self.released) {
            for slot in &mut self.slots {
                slot.id = None;
            }
        }
        if let Some(index) = self.primary {
            let slot = self.slots[index];
            if !slot.continuing() {
                if self.placed {
                    touches.push(Touch::Up);
                }
                self.primary = None;
            } else if let Some((x, y)) = slot.position() {
                touches.push(if self.placed {
                    Touch::Move(x, y)
                } else {
                    Touch::Down(x, y)
                });
                self.placed = true;
            }
        }
        if self.primary.is_none() && !self.slots.iter().any(Slot::continuing) {
            if let Some(index) = self.slots.iter().position(Slot::started) {
                self.primary = Some(index);
                self.placed = false;
                if let Some((x, y)) = self.slots[index].position() {
                    touches.push(Touch::Down(x, y));
                    self.placed = true;
                }
            }
        }
        for slot in &mut self.slots {
            slot.reported = slot.touching();
        }
        touches
    }

    /// Forgets every contact and position after `SYN_DROPPED`.
    fn drop_all(&mut self) -> Vec<Touch> {
        let lost = self.primary.take().is_some() && self.placed;
        self.slots.clear();
        self.dropped = true;
        self.released = false;
        if lost {
            vec![Touch::Lost]
        } else {
            Vec::new()
        }
    }
}

/// Puts device event times on the capture epoch; see the module docs.
#[derive(Clone, Copy, Debug, Default)]
struct Clock {
    /// The smallest `received - stamped` seen, in microseconds.
    offset_us: Option<i64>,
}

impl Clock {
    fn observe(&mut self, device_us: u64, host_us: i64) {
        let offset = host_us.saturating_sub(device_us as i64);
        self.offset_us = Some(self.offset_us.map_or(offset, |known| known.min(offset)));
    }
    /// The event's time on the capture epoch, in microseconds.
    fn epoch_us(&self, device_us: u64) -> i64 {
        (device_us as i64).saturating_add(self.offset_us.unwrap_or(0))
    }
    fn ms(&self, device_us: u64) -> u64 {
        (self.epoch_us(device_us).max(0) / 1000) as u64
    }
}

/// How much later than the fastest frame each frame crossed adb, written to
/// `capture-timing.json` as `touchDelayMs`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Delay {
    pub frames: u64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

impl Delay {
    fn from_micros(mut delays: Vec<u32>, frames: u64) -> Option<Self> {
        delays.sort_unstable();
        let max = *delays.last()?;
        let ms = |us: u32| (f64::from(us) / 100.0).round() / 10.0;
        let at = |share: usize| delays[(delays.len() * share / 100).min(delays.len() - 1)];
        Some(Self {
            frames,
            p50: ms(at(50)),
            p95: ms(at(95)),
            max: ms(max),
        })
    }
}

/// The primary contact as `cursor.jsonl` samples; see the module docs.
struct Track<W: Write> {
    writer: CursorWriter<W>,
    /// The contact while it is down.
    held: Option<Position>,
    last_ms: u64,
}

impl<W: Write> Track<W> {
    fn record(&mut self, t_ms: u64, at: Option<Position>) -> io::Result<()> {
        self.writer.record(Sample { t_ms, at })?;
        self.last_ms = self.last_ms.max(t_ms);
        Ok(())
    }

    /// Heartbeats for a resting finger, up to `t_ms`.
    fn rest(&mut self, t_ms: u64) -> io::Result<()> {
        if let Some(held) = self.held {
            let mut beat = self.last_ms + cursor::HEARTBEAT_MS;
            while beat < t_ms {
                self.record(beat, Some(held))?;
                beat += cursor::HEARTBEAT_MS;
            }
        }
        Ok(())
    }

    /// Writes a touch, placed at `at` canvas pixels for `Down` and `Move`.
    fn apply(&mut self, t_ms: u64, touch: Touch, at: Option<(i32, i32)>) -> io::Result<()> {
        self.rest(t_ms)?;
        let position = |(x, y): (i32, i32), buttons| Position {
            x,
            y,
            over_source: true,
            buttons,
        };
        match (touch, at) {
            (Touch::Down(..), Some(at)) => {
                self.record(t_ms, Some(position(at, 0)))?;
                self.held = Some(position(at, cursor::LEFT));
            }
            (Touch::Move(..), Some(at)) => self.held = Some(position(at, cursor::LEFT)),
            (Touch::Up, _) => {
                if let Some(held) = self.held.take() {
                    self.record(t_ms, Some(Position { buttons: 0, ..held }))?;
                }
            }
            _ => self.held = None,
        }
        self.record(t_ms, self.held)
    }
}

/// Turns `getevent -lt` lines into `cursor.jsonl` lines.
struct Recorder<W: Write> {
    screens: Vec<(Touchscreen, Contacts)>,
    /// The touchscreen whose primary contact is down.
    active: Option<usize>,
    clock: Clock,
    track: Track<W>,
    canvas: (u32, u32),
    rotation: Rotation,
    delays: Vec<u32>,
    frames: u64,
}

impl<W: Write> Recorder<W> {
    fn new(
        out: W,
        screens: Vec<Touchscreen>,
        canvas: (u32, u32),
        rotation: Rotation,
    ) -> io::Result<Self> {
        let writer = CursorWriter::new(out, &Header::new("device", Some(canvas)))?;
        Ok(Self {
            screens: screens
                .into_iter()
                .map(|screen| {
                    let contacts = Contacts::new(screen.slot);
                    (screen, contacts)
                })
                .collect(),
            active: None,
            clock: Clock::default(),
            track: Track {
                writer,
                held: None,
                last_ms: 0,
            },
            canvas,
            rotation,
            delays: Vec::new(),
            frames: 0,
        })
    }

    /// The touchscreen an event belongs to.
    fn screen(&self, device: Option<&str>) -> Option<usize> {
        match device {
            Some(path) => self
                .screens
                .iter()
                .position(|(screen, _)| screen.path == path),
            None => (self.screens.len() == 1).then_some(0),
        }
    }

    /// One line, received `host_us` after the capture epoch. `rotation`
    /// reads the display rotation again, or gives `None` to keep the last.
    fn line(
        &mut self,
        line: &str,
        host_us: i64,
        rotation: &mut dyn FnMut() -> Option<Rotation>,
    ) -> io::Result<()> {
        let Some(event) = parse_event(line) else {
            return Ok(());
        };
        let Some(index) = self.screen(event.device) else {
            return Ok(());
        };
        self.clock.observe(event.time_us, host_us);
        if (event.kind, event.code) == (EV_SYN, SYN_REPORT) {
            self.frames += 1;
            if self.delays.len() < MAX_DELAYS {
                let late = host_us.saturating_sub(self.clock.epoch_us(event.time_us));
                self.delays.push(u32::try_from(late).unwrap_or(u32::MAX));
            }
        }
        let touches = self.screens[index]
            .1
            .apply(event.kind, event.code, event.value);
        let t_ms = self.clock.ms(event.time_us);
        for touch in touches {
            if matches!(touch, Touch::Down(..)) && self.active.is_none() {
                self.active = Some(index);
                if let Some(read) = rotation() {
                    self.rotation = read;
                }
            }
            if self.active != Some(index) {
                continue;
            }
            let at = match touch {
                Touch::Down(x, y) | Touch::Move(x, y) => Some(place(
                    &self.screens[index].0,
                    self.rotation,
                    self.canvas,
                    (x, y),
                )),
                Touch::Up | Touch::Lost => {
                    self.active = None;
                    None
                }
            };
            self.track.apply(t_ms, touch, at)?;
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.track.writer.flush()
    }

    /// Fills heartbeats up to `now_ms` and flushes.
    fn finish(mut self, now_ms: u64) -> io::Result<(Outcome, W)> {
        self.track.rest(now_ms)?;
        self.flush()?;
        let outcome = Outcome {
            lines: self.track.writer.lines(),
            delay: Delay::from_micros(self.delays, self.frames),
        };
        Ok((outcome, self.track.writer.into_inner()))
    }
}

/// What a finished [`Reader`] wrote.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Outcome {
    /// `cursor.jsonl` lines after the header.
    pub lines: u64,
    /// `None` when no frame arrived.
    pub delay: Option<Delay>,
}

/// `adb -s <serial> shell <script>`'s standard output.
fn adb_shell(serial: &str, script: &str, timeout: Duration) -> Result<String, String> {
    let mut command = deps::command("adb")?;
    command.args(["-s", serial, "shell", script]);
    let out = output_with_timeout(command, timeout)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The touch reader of one device take.
pub struct Reader {
    stop: Arc<AtomicBool>,
    /// The `getevent` adb client, once it runs.
    child: Arc<Mutex<Option<Child>>>,
    join: Option<JoinHandle<Result<Option<Outcome>, String>>>,
    error: Option<String>,
}

impl Reader {
    /// Reads the touches of `serial` into `folder`'s `cursor.jsonl`. `canvas`
    /// is the first decoded frame's size.
    pub fn start(serial: &str, folder: &Path, epoch: Instant, canvas: Option<(u32, u32)>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let (flag, running) = (stop.clone(), child.clone());
        let (serial, path) = (serial.to_owned(), folder.join(cursor::FILE_NAME));
        let spawned = thread::Builder::new()
            .name("touch-reader".into())
            .spawn(move || run(&serial, &path, epoch, canvas, &flag, &running));
        let (join, error) = match spawned {
            Ok(join) => (Some(join), None),
            Err(e) => (None, Some(format!("Touch tracking could not start: {e}"))),
        };
        Self {
            stop,
            child,
            join,
            error,
        }
    }

    fn kill(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }

    /// Stops and joins the thread. `None` when the device is not tracked
    /// (Quest).
    pub fn stop(mut self) -> Option<Result<Outcome, String>> {
        self.kill();
        match self.join.take() {
            Some(join) => join
                .join()
                .map_err(|_| "Touch reader panicked".to_string())
                .and_then(|result| result)
                .transpose(),
            None => Some(Err(self.error.take().unwrap_or_default())),
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.kill();
    }
}

fn run(
    serial: &str,
    path: &Path,
    epoch: Instant,
    canvas: Option<(u32, u32)>,
    stop: &AtomicBool,
    child: &Mutex<Option<Child>>,
) -> Result<Option<Outcome>, String> {
    let probe = adb_shell(serial, PROBE, Duration::from_secs(5))
        .map_err(|e| format!("Touch tracking could not probe the device: {e}"))?;
    let mut sections = probe.split(MARKER);
    let (model, listing, rotation) = (
        sections.next().unwrap_or_default(),
        sections.next().unwrap_or_default(),
        sections.next().unwrap_or_default(),
    );
    if is_quest(model.trim()) {
        return Ok(None);
    }
    let canvas = canvas.ok_or("Touch tracking found no frame size in capture.log")?;
    let screens = touchscreens(listing);
    if screens.is_empty() {
        return Err("Touch tracking found no multitouch touchscreen on the device".into());
    }
    let failed = |e: io::Error| format!("Write {}: {e}", path.display());
    let file = File::create(path).map_err(failed)?;
    let mut command = deps::command("adb")?;
    command.args(["-s", serial, "shell", "getevent", "-lt"]);
    if let [screen] = screens.as_slice() {
        command.arg(&screen.path);
    }
    let mut recorder = Recorder::new(
        BufWriter::new(file),
        screens,
        canvas,
        parse_rotation(rotation).unwrap_or_default(),
    )
    .map_err(failed)?;
    let stdout = {
        let mut running = child.lock().map_err(|_| "Touch reader lock poisoned")?;
        if stop.load(Ordering::Acquire) {
            return recorder
                .finish(epoch.elapsed().as_millis() as u64)
                .map(|(outcome, _)| Some(outcome))
                .map_err(failed);
        }
        let mut spawned = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Touch tracking could not run getevent: {e}"))?;
        let stdout = spawned.stdout.take();
        *running = Some(spawned);
        stdout.ok_or("Touch tracking has no getevent output")?
    };
    let mut probed = Instant::now();
    let mut read_rotation = || {
        if probed.elapsed() < ROTATION_REFRESH {
            return None;
        }
        probed = Instant::now();
        adb_shell(serial, ROTATION, Duration::from_secs(2))
            .ok()
            .and_then(|text| parse_rotation(&text))
    };
    let mut lines = BufReader::new(stdout);
    let mut line = Vec::new();
    // A read error is the pipe closing under a killed client: end of input.
    while lines
        .read_until(b'\n', &mut line)
        .is_ok_and(|read| read > 0)
    {
        let host_us = epoch.elapsed().as_micros() as i64;
        if let Ok(text) = std::str::from_utf8(&line) {
            recorder
                .line(text, host_us, &mut read_rotation)
                .map_err(failed)?;
        }
        line.clear();
        if lines.buffer().is_empty() {
            recorder.flush().map_err(failed)?;
        }
    }
    let (outcome, _) = recorder
        .finish(epoch.elapsed().as_millis() as u64)
        .map_err(failed)?;
    if let Ok(mut running) = child.lock() {
        if let Some(mut finished) = running.take() {
            let _ = finished.kill();
            let _ = finished.wait();
        }
    }
    Ok(Some(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cursor::MouseButton, models::CaptureConfig, store::Store};
    use std::fs;

    /// `getevent -lp` on the Android 15 emulator, cut to its keyboard, the
    /// power button and two of its eleven multitouch panels.
    const EMULATOR_LISTING: &str = include_str!("../fixtures/touch/emulator-getevent-lp.txt");
    /// `getevent -lt` on the emulator while taps, a drag and a two-finger
    /// gesture were injected through its console (`adb emu event send`).
    const EMULATOR_STREAM: &str = include_str!("../fixtures/touch/emulator-getevent-lt.txt");
    /// `dumpsys input | grep -e Viewport -e SurfaceOrientation` on the
    /// emulator in portrait, then after `wm user-rotation lock 1`.
    const EMULATOR_PORTRAIT: &str = include_str!("../fixtures/touch/emulator-rotation-0.txt");
    const EMULATOR_LANDSCAPE: &str = include_str!("../fixtures/touch/emulator-rotation-1.txt");
    /// `getevent -lp` on a Pixel 8 with Android 17.
    const PIXEL_LISTING: &str = include_str!("../fixtures/touch/pixel8-getevent-lp.txt");
    /// `getevent -lt /dev/input/event3` on that Pixel 8 while it was tapped
    /// near its bottom-left corner: a finger, a contact the panel flagged as
    /// a palm throughout (Android showed no tap for it), a finger, and a
    /// contact that started as a palm and turned into a finger.
    const PIXEL_STREAM: &str = include_str!("../fixtures/touch/pixel8-getevent-lt.txt");

    fn screen(max_x: i32, max_y: i32) -> Touchscreen {
        Touchscreen {
            path: "/dev/input/event2".into(),
            name: "panel".into(),
            x: Axis { min: 0, max: max_x },
            y: Axis { min: 0, max: max_y },
            slot: 0,
        }
    }

    /// Applies `(kind, code, value)` events and collects their touches.
    fn feed(contacts: &mut Contacts, events: &[(u16, u16, i32)]) -> Vec<Touch> {
        events
            .iter()
            .flat_map(|&(kind, code, value)| contacts.apply(kind, code, value))
            .collect()
    }

    const SYN: (u16, u16, i32) = (EV_SYN, SYN_REPORT, 0);
    fn slot(n: i32) -> (u16, u16, i32) {
        (EV_ABS, ABS_MT_SLOT, n)
    }
    fn id(n: i32) -> (u16, u16, i32) {
        (EV_ABS, ABS_MT_TRACKING_ID, n)
    }
    fn x(n: i32) -> (u16, u16, i32) {
        (EV_ABS, ABS_MT_POSITION_X, n)
    }
    fn y(n: i32) -> (u16, u16, i32) {
        (EV_ABS, ABS_MT_POSITION_Y, n)
    }

    #[test]
    fn events_parse_with_and_without_labels_or_device_paths() {
        assert_eq!(
            parse_event("[     654.732322] /dev/input/event2: EV_ABS       ABS_MT_TRACKING_ID   ffffffff            \n"),
            Some(Event {
                time_us: 654_732_322,
                device: Some("/dev/input/event2"),
                kind: EV_ABS,
                code: ABS_MT_TRACKING_ID,
                value: -1
            })
        );
        assert_eq!(
            parse_event(
                "[   12.000100] EV_KEY       BTN_TOUCH            DOWN                \r\n"
            ),
            Some(Event {
                time_us: 12_000_100,
                device: None,
                kind: EV_KEY,
                code: BTN_TOUCH,
                value: 1
            })
        );
        // `getevent -t` without `-l`.
        assert_eq!(
            parse_event("[ 1.000002] /dev/input/event5: 0003 0035 0000021c"),
            Some(Event {
                time_us: 1_000_002,
                device: Some("/dev/input/event5"),
                kind: EV_ABS,
                code: ABS_MT_POSITION_X,
                value: 540
            })
        );
        assert_eq!(
            parse_event("[ 1.000002] EV_SYN SYN_REPORT 00000000").map(|e| (e.kind, e.code)),
            Some((EV_SYN, SYN_REPORT))
        );
        // Android 17 labels tool types.
        assert_eq!(
            parse_event("[  155120.479000] EV_ABS       ABS_MT_TOOL_TYPE     MT_TOOL_PALM        ")
                .map(|e| (e.code, e.value)),
            Some((ABS_MT_TOOL_TYPE, MT_TOOL_PALM))
        );
        assert_eq!(
            parse_event("[ 1.0] EV_ABS ABS_MT_TOOL_TYPE MT_TOOL_FINGER"),
            None,
            "a short stamp"
        );
        assert_eq!(
            parse_event("[ 1.000000] EV_ABS ABS_MT_TOOL_TYPE MT_TOOL_FINGER").map(|e| e.value),
            Some(0)
        );
        for line in [
            "add device 3: /dev/input/event2",
            "  name:     \"virtio_input_multi_touch_1\"",
            "[ 1.000002] /dev/input/event2: EV_ABS ABS_MT_PRESSURE 00000010",
            "[ 1.000002] /dev/input/event2: EV_ABS ABS_MT_POSITION_X",
            "[ 1.000002] /dev/input/event2: EV_ABS ABS_MT_POSITION_X 00000010 extra",
            "[ 1.000002] /dev/input/event2: EV_ABS ABS_MT_POSITION_X 0010",
            "[ 1.02] /dev/input/event2: EV_SYN SYN_REPORT 00000000",
            "[ x.000002] EV_SYN SYN_REPORT 00000000",
            "[ 1.000002 EV_SYN SYN_REPORT 00000000",
            "could not get driver version for /dev/input/mouse0, Not a typewriter",
            "",
        ] {
            assert_eq!(parse_event(line), None, "{line}");
        }
    }

    #[test]
    fn emulator_listing_keeps_its_multitouch_panels() {
        let screens = touchscreens(EMULATOR_LISTING);
        assert_eq!(
            screens,
            [
                Touchscreen {
                    path: "/dev/input/event2".into(),
                    name: "virtio_input_multi_touch_1".into(),
                    x: Axis { min: 0, max: 32767 },
                    y: Axis { min: 0, max: 32767 },
                    slot: 0,
                },
                Touchscreen {
                    path: "/dev/input/event3".into(),
                    name: "virtio_input_multi_touch_2".into(),
                    x: Axis { min: 0, max: 32767 },
                    y: Axis { min: 0, max: 32767 },
                    slot: 0,
                },
            ]
        );
    }

    #[test]
    fn pixel_listing_keeps_only_its_touchscreen() {
        // Haptics, the fingerprint sensor, proximity and keys are not panels.
        assert_eq!(
            touchscreens(PIXEL_LISTING),
            [Touchscreen {
                path: "/dev/input/event3".into(),
                name: "goodix_ts0".into(),
                x: Axis { min: 0, max: 1079 },
                y: Axis { min: 0, max: 2399 },
                slot: 0,
            }]
        );
    }

    #[test]
    fn direct_touchscreens_win_and_touchpads_and_protocol_a_are_skipped() {
        let listing = "\
add device 1: /dev/input/event4
  name:     \"sec_touchscreen\"
  events:
    KEY (0001): BTN_TOUCH             BTN_TOOL_FINGER
    ABS (0003): ABS_MT_SLOT           : value 2, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
                ABS_MT_TRACKING_ID    : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
add device 2: /dev/input/event5
  name:     \"touchpad\"
  events:
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 4, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 1920, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 1080, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_POINTER
    INPUT_PROP_BUTTONPAD
add device 3: /dev/input/event6
  name:     \"virtual panel\"
  events:
    ABS (0003): 002f  : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                0035  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                0036  : value 0, min 0, max 2399, fuzz 0, flat 0, resolution 0
  input props:
    <none>
add device 4: /dev/input/event7
  name:     \"protocol a panel\"
  events:
    ABS (0003): ABS_MT_POSITION_X     : value 0, min 0, max 719, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 1279, fuzz 0, flat 0, resolution 0
  input props:
    INPUT_PROP_DIRECT
";
        let screens = touchscreens(listing);
        assert_eq!(screens.len(), 1);
        assert_eq!(
            (screens[0].path.as_str(), screens[0].x.max, screens[0].slot),
            ("/dev/input/event4", 4095, 2)
        );
        // Without the direct panel, the unlabeled one remains; the touchpad never does.
        let rest = &listing[listing.find("add device 2").unwrap()..];
        let screens = touchscreens(rest);
        assert_eq!(screens.len(), 1);
        assert_eq!(
            (screens[0].name.as_str(), screens[0].y.max),
            ("virtual panel", 2399)
        );
        assert!(touchscreens("").is_empty());
        assert!(touchscreens(&rest[rest.find("add device 4").unwrap()..]).is_empty());
    }

    #[test]
    fn rotation_comes_from_the_display_0_viewport_or_surface_orientation() {
        assert_eq!(parse_rotation(EMULATOR_PORTRAIT), Some(Rotation::Deg0));
        assert_eq!(parse_rotation(EMULATOR_LANDSCAPE), Some(Rotation::Deg90));
        // A viewport for another display does not count.
        assert_eq!(
            parse_rotation(
                "Viewport INTERNAL: displayId=-1, uniqueId=, port=<none>, orientation=0, logicalFrame=[0, 0, 0, 0]\n\
                 Viewport INTERNAL: displayId=0, uniqueId=local:1, port=0, orientation=3, logicalFrame=[0, 0, 2400, 1080]\n"
            ),
            Some(Rotation::Deg270)
        );
        // Android 17 on a Pixel 8 adds density fields.
        assert_eq!(
            parse_rotation("      Viewport INTERNAL: displayId=0, uniqueId=local:4619826886480892416, port=0, orientation=0, densityDpi=420 xDpi=428.625000, yDpi=426.292999, logicalFrame=[0, 0, 1080, 2400], physicalFrame=[0, 0, 1080, 2400], deviceSize=[1080, 2400], isActive=[1]"),
            Some(Rotation::Deg0)
        );
        // Android 8: no viewport type.
        assert_eq!(
            parse_rotation(
                "    Viewport: displayId=0, orientation=2, logicalFrame=[0, 0, 1080, 1920]"
            ),
            Some(Rotation::Deg180)
        );
        // Android 12 and older print the touch mapper's surface orientation.
        assert_eq!(
            parse_rotation("      SurfaceWidth: 2400px\n      SurfaceOrientation: 1\n"),
            Some(Rotation::Deg90)
        );
        assert_eq!(
            parse_rotation("      SurfaceOrientation: ROTATION_270\n"),
            Some(Rotation::Deg270)
        );
        assert_eq!(
            parse_rotation("      SurfaceOrientation: Rotation180"),
            Some(Rotation::Deg180)
        );
        assert_eq!(parse_rotation(""), None);
        assert_eq!(parse_rotation("      SurfaceOrientation: 5"), None);
    }

    #[test]
    fn placement_scales_the_raw_range_then_applies_the_rotation() {
        // The emulator panel: 0..=32767 on both axes, over a 1080x2400 display.
        let panel = screen(32767, 32767);
        let portrait = (1080, 2400);
        let landscape = (2400, 1080);
        let corners = [(0, 0), (32767, 0), (32767, 32767), (0, 32767)];
        let place_all = |rotation, canvas| {
            corners
                .iter()
                .map(|&at| place(&panel, rotation, canvas, at))
                .collect::<Vec<_>>()
        };
        // Natural top-left, top-right, bottom-right and bottom-left corners.
        assert_eq!(
            place_all(Rotation::Deg0, portrait),
            [(0, 0), (1079, 0), (1079, 2399), (0, 2399)]
        );
        // ROTATION_90: the device turned counterclockwise, so the natural
        // top-right corner is the landscape top-left.
        assert_eq!(
            place_all(Rotation::Deg90, landscape),
            [(0, 1079), (0, 0), (2399, 0), (2399, 1079)]
        );
        assert_eq!(
            place_all(Rotation::Deg180, portrait),
            [(1079, 2399), (0, 2399), (0, 0), (1079, 0)]
        );
        assert_eq!(
            place_all(Rotation::Deg270, landscape),
            [(2399, 0), (2399, 1079), (0, 1079), (0, 0)]
        );
        // The center, and a quarter of the way along each axis.
        assert_eq!(
            place(&panel, Rotation::Deg0, portrait, (16384, 16384)),
            (540, 1200)
        );
        assert_eq!(
            place(&panel, Rotation::Deg0, portrait, (8192, 24576)),
            (270, 1800)
        );
        assert_eq!(
            place(&panel, Rotation::Deg90, landscape, (8192, 24576)),
            (1800, 809)
        );
        // A panel in display pixels maps 1:1, and onto a scrcpy video
        // rounded to multiples of 8 (1080x2340 is recorded as 1080x2336).
        let pixels = screen(1079, 2339);
        assert_eq!(
            place(&pixels, Rotation::Deg0, (1080, 2340), (517, 2339)),
            (517, 2339)
        );
        assert_eq!(
            place(&pixels, Rotation::Deg0, (1080, 2336), (517, 2339)),
            (517, 2335)
        );
        assert_eq!(
            place(&pixels, Rotation::Deg0, (1080, 2336), (517, 1170)),
            (517, 1168)
        );
        // A nonzero minimum, and raw values outside the range leave the canvas.
        let offset = Touchscreen {
            x: Axis {
                min: 100,
                max: 1179,
            },
            ..pixels
        };
        assert_eq!(
            place(&offset, Rotation::Deg0, (1080, 2340), (100, 0)),
            (0, 0)
        );
        assert_eq!(
            place(&offset, Rotation::Deg0, (1080, 2340), (99, -1)),
            (-1, -1)
        );
        assert_eq!(
            place(&offset, Rotation::Deg0, (1080, 2340), (1180, 2340)),
            (1080, 2340)
        );
    }

    #[test]
    fn the_primary_contact_starts_alone_and_ends_its_gesture() {
        let mut contacts = Contacts::new(0);
        // A tap.
        assert_eq!(
            feed(&mut contacts, &[id(1), x(10), y(20), SYN]),
            [Touch::Down(10, 20)]
        );
        assert_eq!(feed(&mut contacts, &[x(11), SYN]), [Touch::Move(11, 20)]);
        // Another finger's frame still reports the primary contact.
        assert_eq!(
            feed(&mut contacts, &[slot(1), id(2), x(500), y(500), SYN]),
            [Touch::Move(11, 20)]
        );
        assert_eq!(feed(&mut contacts, &[slot(0), id(-1), SYN]), [Touch::Up]);
        // The second finger is not promoted when the first lifts.
        assert!(feed(&mut contacts, &[slot(1), x(510), SYN]).is_empty());
        assert!(feed(&mut contacts, &[id(-1), SYN]).is_empty());
        // Two fingers in one frame: the lowest slot.
        assert_eq!(
            feed(
                &mut contacts,
                &[
                    slot(3),
                    id(4),
                    x(30),
                    y(30),
                    slot(2),
                    id(3),
                    x(40),
                    y(40),
                    SYN
                ]
            ),
            [Touch::Down(40, 40)]
        );
        assert_eq!(
            feed(&mut contacts, &[id(-1), slot(3), id(-1), SYN]),
            [Touch::Up]
        );
        // A lift and a new contact in the same slot within one frame.
        assert_eq!(
            feed(&mut contacts, &[slot(0), id(5), SYN]),
            [Touch::Down(11, 20)]
        );
        assert_eq!(
            feed(&mut contacts, &[id(-1), id(6), x(12), SYN]),
            [Touch::Up, Touch::Down(12, 20)]
        );
        // The emulator re-asserts a tracking id within a frame: same contact.
        assert_eq!(
            feed(&mut contacts, &[id(-1), id(6), SYN]),
            [Touch::Move(12, 20)]
        );
        // BTN_TOUCH up ends every contact.
        assert_eq!(
            feed(&mut contacts, &[(EV_KEY, BTN_TOUCH, 0), SYN]),
            [Touch::Up]
        );
        assert!(feed(&mut contacts, &[x(13), SYN]).is_empty());
    }

    #[test]
    fn positions_persist_and_unknown_axes_hold_a_contact_back() {
        // A slot never reported yet: the contact waits for both axes.
        let mut contacts = Contacts::new(0);
        assert!(feed(&mut contacts, &[id(1), x(10), SYN]).is_empty());
        assert_eq!(feed(&mut contacts, &[y(20), SYN]), [Touch::Down(10, 20)]);
        assert_eq!(feed(&mut contacts, &[id(-1), SYN]), [Touch::Up]);
        // evdev does not repeat unchanged values: the slot keeps its position.
        assert_eq!(feed(&mut contacts, &[id(2), SYN]), [Touch::Down(10, 20)]);
        assert_eq!(feed(&mut contacts, &[id(-1), SYN]), [Touch::Up]);
        // A contact that lifts before it was placed reports nothing.
        assert!(feed(&mut contacts, &[slot(1), id(3), x(5), SYN, id(-1), SYN]).is_empty());
        // The listing's slot is where events start.
        let mut contacts = Contacts::new(1);
        assert_eq!(
            feed(&mut contacts, &[id(7), x(1), y(2), SYN]),
            [Touch::Down(1, 2)]
        );
        assert_eq!(
            feed(&mut contacts, &[slot(1), x(3), SYN]),
            [Touch::Move(3, 2)]
        );
        // Slots beyond the limit are ignored.
        assert_eq!(
            feed(&mut contacts, &[slot(64), id(8), x(9), y(9), SYN]),
            [Touch::Move(3, 2)]
        );
        assert_eq!(feed(&mut contacts, &[slot(1), id(-1), SYN]), [Touch::Up]);
    }

    #[test]
    fn palm_contacts_do_not_touch() {
        let palm = (EV_ABS, ABS_MT_TOOL_TYPE, MT_TOOL_PALM);
        let finger = (EV_ABS, ABS_MT_TOOL_TYPE, 0);
        let mut contacts = Contacts::new(0);
        // A palm from start to finish.
        assert!(feed(
            &mut contacts,
            &[id(1), palm, x(10), y(20), SYN, x(11), SYN, id(-1), SYN]
        )
        .is_empty());
        // The tool type carries over: the next contact is a palm until it
        // turns into a finger, and touches down then.
        assert!(feed(&mut contacts, &[id(2), SYN]).is_empty());
        assert_eq!(
            feed(&mut contacts, &[finger, x(12), SYN]),
            [Touch::Down(12, 20)]
        );
        // A finger that becomes a palm is canceled.
        assert_eq!(feed(&mut contacts, &[palm, SYN]), [Touch::Up]);
        assert!(feed(&mut contacts, &[id(-1), SYN]).is_empty());
        // A resting palm does not hold back a finger in another slot.
        assert_eq!(
            feed(
                &mut contacts,
                &[id(3), slot(1), id(4), finger, x(30), y(40), SYN]
            ),
            [Touch::Down(30, 40)]
        );
    }

    #[test]
    fn dropped_events_lose_the_contact_until_it_touches_again() {
        let mut contacts = Contacts::new(0);
        assert_eq!(
            feed(&mut contacts, &[id(1), x(10), y(20), SYN]),
            [Touch::Down(10, 20)]
        );
        assert_eq!(
            feed(&mut contacts, &[x(15), (EV_SYN, SYN_DROPPED, 0)]),
            [Touch::Lost]
        );
        // Events up to the next SYN_REPORT are discarded, and so is the
        // finger that stays down.
        assert!(feed(&mut contacts, &[id(-1), id(2), x(30), y(30), SYN]).is_empty());
        assert!(feed(&mut contacts, &[x(31), SYN]).is_empty());
        assert!(feed(&mut contacts, &[id(-1), SYN]).is_empty());
        // Positions were forgotten too.
        assert!(feed(&mut contacts, &[id(3), x(40), SYN]).is_empty());
        assert_eq!(feed(&mut contacts, &[y(41), SYN]), [Touch::Down(40, 41)]);
    }

    #[test]
    fn the_clock_uses_the_fastest_delivery() {
        let mut clock = Clock::default();
        // Device time 100 s; received 2.5 s, then 1 ms faster, then late.
        clock.observe(100_000_000, 2_500_000);
        assert_eq!(clock.ms(100_000_000), 2_500);
        clock.observe(100_010_000, 2_509_000);
        assert_eq!(clock.ms(100_000_000), 2_499);
        clock.observe(100_020_000, 2_600_000);
        assert_eq!(clock.ms(100_020_000), 2_519);
        // Before the epoch clamps to 0.
        assert_eq!(clock.ms(90_000_000), 0);
        assert_eq!(
            Delay::from_micros(vec![80_000, 0, 1_000, 2_000], 4),
            Some(Delay {
                frames: 4,
                p50: 2.0,
                p95: 80.0,
                max: 80.0
            })
        );
        assert_eq!(Delay::from_micros(Vec::new(), 0), None);
    }

    /// Feeds `stream` to a recorder as if line `index` arrived
    /// `delay_us(index)` after its event, with the first event 1 s after the
    /// capture epoch. `rotation` answers each touch-down's rotation read.
    /// Returns the `cursor.jsonl` text.
    fn record(
        stream: &str,
        screens: Vec<Touchscreen>,
        canvas: (u32, u32),
        delay_us: impl Fn(usize) -> i64,
        rotation: &mut dyn FnMut() -> Option<Rotation>,
        stop_ms: u64,
    ) -> (String, Outcome) {
        let mut recorder = Recorder::new(Vec::new(), screens, canvas, Rotation::Deg0).unwrap();
        let first = stream.lines().find_map(parse_event).unwrap().time_us as i64;
        for (index, line) in stream.lines().enumerate() {
            let host_us = parse_event(line).map_or(0, |event| {
                event.time_us as i64 - first + 1_000_000 + delay_us(index)
            });
            recorder.line(line, host_us, rotation).unwrap();
        }
        let (outcome, out) = recorder.finish(stop_ms).unwrap();
        (String::from_utf8(out).unwrap(), outcome)
    }

    fn lines(text: &str) -> Vec<&str> {
        text.lines().skip(1).collect()
    }

    /// A store with one ready session whose take 1 has `text` as its
    /// `cursor.jsonl` and `canvas` in its `capture-timing.json`.
    fn session_with(text: &str, canvas: (u32, u32)) -> (tempfile::TempDir, Store, String) {
        let root = tempfile::tempdir().unwrap();
        let store = Store::open(root.path().into()).unwrap();
        let config = CaptureConfig {
            source_id: "android:emulator-5580".into(),
            microphone_id: None,
            system_audio: false,
            fps: 30,
        };
        let mut session = store.create_session(None, None, &config).unwrap();
        session.duration_ms = 3_000;
        session.status = "ready".into();
        store.save_session(&session).unwrap();
        let folder = store.session_dir(&session.id).unwrap();
        fs::write(folder.join(cursor::FILE_NAME), text).unwrap();
        let timing = serde_json::json!({"canvasWidth": canvas.0, "canvasHeight": canvas.1});
        fs::write(folder.join("capture-timing.json"), timing.to_string()).unwrap();
        (root, store, session.id)
    }

    #[test]
    fn the_emulator_stream_becomes_presses_at_the_touched_pixels() {
        // Lines arrive 2 ms after their event at best and 23 ms at worst.
        let delay = |index: usize| 2_000 + 7_000 * (index % 4) as i64;
        let screens = touchscreens(EMULATOR_LISTING);
        let (text, outcome) = record(
            EMULATOR_STREAM,
            screens,
            (1080, 2400),
            delay,
            &mut || None,
            2_000,
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(text.lines().next().unwrap()).unwrap(),
            serde_json::json!({"format":"cuereview-cursor","version":1,"source":"device",
                "canvasWidth":1080,"canvasHeight":2400,"sampleHz":60})
        );
        // The first tap is missing: its y equaled the slot's previous value,
        // so evdev never sent it. The drag runs down the middle, the
        // two-finger gesture follows its first finger only, and the last tap
        // is in the top-right corner. Times are the device's spacing on the
        // fastest delivery: the drag starts 59.642 ms after the first event.
        assert_eq!(
            lines(&text),
            [
                "[1061,540,479]",
                "[0,0,0,1]",
                "[32,0,241]",
                "[31,0,240]",
                "[30,0,240]",
                "[31,0,0,0]",
                "[0]",
                "[31,-405,-900]",
                "[0,0,0,1]",
                "[61,0,0,0]",
                "[0]",
                "[91,944,-300]",
                "[0,0,0,1]",
                "[28,0,0,0]",
                "[0]"
            ]
        );
        assert_eq!(outcome.lines, 15);
        let delay = outcome.delay.unwrap();
        assert_eq!((delay.frames, delay.max), (14, 21.0));
        assert!(delay.p50 <= delay.p95, "{delay:?}");

        // The existing reader turns it into presses and positions.
        let (_root, store, id) = session_with(&text, (1080, 2400));
        let track = cursor::load(&store, &id).unwrap();
        let clicks: Vec<(MouseButton, u64, i32, i32)> = track
            .clicks(0, u64::MAX)
            .iter()
            .map(|click| (click.button, click.at.t_ms, click.at.px, click.at.py))
            .collect();
        assert_eq!(
            clicks,
            [
                (MouseButton::Left, 1061, 540, 479),
                (MouseButton::Left, 1216, 135, 300),
                (MouseButton::Left, 1368, 1079, 0)
            ]
        );
        let at = |ms| {
            track
                .at(ms)
                .map(|point| (point.px, point.py, point.in_video))
        };
        assert_eq!(at(1060), None);
        assert_eq!(at(1150), Some((540, 960, true)));
        assert_eq!(at(1184), Some((540, 1200, true)));
        // Lifting leaves no hover position.
        assert_eq!(at(1185), None);
        assert_eq!(at(1215), None);
        assert_eq!(at(1300), None);
        assert_eq!(track.at(1368).unwrap().x, 0.9995);
    }

    #[test]
    fn the_pixel_stream_skips_its_palm_and_places_its_taps() {
        let screens = touchscreens(PIXEL_LISTING);
        let (text, outcome) = record(
            PIXEL_STREAM,
            screens,
            (1080, 2400),
            |_| 2_000,
            &mut || None,
            3_000,
        );
        assert_eq!(outcome.delay.unwrap().frames, 48);
        let (_root, store, id) = session_with(&text, (1080, 2400));
        let track = cursor::load(&store, &id).unwrap();
        let clicks: Vec<(u64, i32, i32)> = track
            .clicks(0, u64::MAX)
            .iter()
            .map(|click| (click.at.t_ms, click.at.px, click.at.py))
            .collect();
        // The panel is in display pixels, so canvas pixels are raw values.
        // The palm-only contact (+387 ms) is not a press, and the last
        // contact touches down at its first finger frame (+1033.677 ms), not
        // at the palm frame before it.
        assert_eq!(
            clicks,
            [(1002, 50, 2326), (1672, 58, 2339), (2035, 73, 2332)]
        );
        assert_eq!(track.at(1_420), None);
    }

    #[test]
    fn the_first_panel_to_touch_owns_the_track_until_it_lifts() {
        let stream = "\
[ 10.000000] /dev/input/event2: EV_ABS ABS_MT_TRACKING_ID 00000001
[ 10.000000] /dev/input/event2: EV_ABS ABS_MT_POSITION_X 00004000
[ 10.000000] /dev/input/event2: EV_ABS ABS_MT_POSITION_Y 00004000
[ 10.000000] /dev/input/event2: EV_SYN SYN_REPORT 00000000
[ 10.010000] /dev/input/event3: EV_ABS ABS_MT_TRACKING_ID 00000001
[ 10.010000] /dev/input/event3: EV_ABS ABS_MT_POSITION_X 00000000
[ 10.010000] /dev/input/event3: EV_ABS ABS_MT_POSITION_Y 00000000
[ 10.010000] /dev/input/event3: EV_SYN SYN_REPORT 00000000
[ 10.020000] /dev/input/event2: EV_ABS ABS_MT_TRACKING_ID ffffffff
[ 10.020000] /dev/input/event2: EV_SYN SYN_REPORT 00000000
[ 10.030000] /dev/input/event3: EV_ABS ABS_MT_POSITION_X 00000100
[ 10.030000] /dev/input/event3: EV_SYN SYN_REPORT 00000000
[ 10.040000] /dev/input/event3: EV_ABS ABS_MT_TRACKING_ID ffffffff
[ 10.040000] /dev/input/event3: EV_SYN SYN_REPORT 00000000
[ 10.050000] /dev/input/event3: EV_ABS ABS_MT_TRACKING_ID 00000002
[ 10.050000] /dev/input/event3: EV_SYN SYN_REPORT 00000000
[ 10.060000] /dev/input/event9: EV_ABS ABS_MT_TRACKING_ID 00000001
[ 10.060000] /dev/input/event9: EV_SYN SYN_REPORT 00000000
";
        let screens = touchscreens(EMULATOR_LISTING);
        let (text, _) = record(
            stream,
            screens,
            (1080, 2400),
            |_| 1_000,
            &mut || None,
            1_100,
        );
        // The second panel's first contact started while the first owned the
        // track; only its next one counts. event9 is not a touchscreen.
        assert_eq!(
            lines(&text),
            [
                "[1001,540,1200]",
                "[0,0,0,1]",
                "[20,0,0,0]",
                "[0]",
                "[30,-532,-1200]",
                "[0,0,0,1]"
            ]
        );
    }

    #[test]
    fn a_resting_finger_gets_heartbeats_and_touch_down_reads_the_rotation() {
        let stream = "\
[  100.000000] EV_ABS       ABS_MT_TRACKING_ID   00000001
[  100.000000] EV_ABS       ABS_MT_POSITION_X    00000064
[  100.000000] EV_ABS       ABS_MT_POSITION_Y    000000c8
[  100.000000] EV_SYN       SYN_REPORT           00000000
[  101.000000] EV_ABS       ABS_MT_POSITION_X    00000065
[  101.000000] EV_SYN       SYN_REPORT           00000000
[  101.100000] EV_ABS       ABS_MT_TRACKING_ID   ffffffff
[  101.100000] EV_SYN       SYN_REPORT           00000000
[  101.200000] EV_ABS       ABS_MT_TRACKING_ID   00000002
[  101.200000] EV_SYN       SYN_REPORT           00000000
";
        let mut reads = 0;
        let mut rotation = || {
            reads += 1;
            // The first read sees the device upside down; the second fails.
            (reads == 1).then_some(Rotation::Deg180)
        };
        let (text, _) = record(
            stream,
            vec![screen(1079, 2399)],
            (1080, 2400),
            |_| 3_000,
            &mut rotation,
            3_000,
        );
        assert_eq!(reads, 2);
        assert_eq!(
            lines(&text),
            [
                // (100, 200) upside down on a 1080x2400 canvas.
                "[1003,979,2199]",
                "[0,0,0,1]",
                "[250,0,0]",
                "[250,0,0]",
                "[250,0,0]",
                "[250,-1,0]",
                "[100,0,0,0]",
                "[0]",
                // A failed read keeps the last rotation, and the slot keeps
                // its position. The finger is held up to the stop.
                "[100,0,0]",
                "[0,0,0,1]",
                "[250,0,0]",
                "[250,0,0]",
                "[250,0,0]"
            ]
        );
    }
}
