//! Cursor tracking for Windows display and window captures (plan item C1).
//!
//! WP D records a delta-encoded `cursor.jsonl` in each take folder and fills
//! this module. The public API below is stable: until WP D lands, [`load`]
//! finds no track, which is also the permanent answer on macOS and Linux, so
//! callers already handle "no cursor data".

use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::path::Path;

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

/// All cursor samples of one session, on the combined session timeline.
#[derive(Clone, Debug, Default)]
pub struct CursorTrack {
    #[allow(dead_code)] // WP D fills this
    points: Vec<CursorPoint>,
    #[allow(dead_code)] // WP D fills this
    presses: Vec<Click>,
}

impl CursorTrack {
    /// The pointer at `ms`, or `None` when no sample is close enough to it.
    pub fn at(&self, _ms: u64) -> Option<CursorPoint> {
        None // WP D fills this
    }

    /// Clicks with `a_ms <= tMs <= b_ms`, in time order.
    pub fn clicks(&self, _a_ms: u64, _b_ms: u64) -> Vec<Click> {
        Vec::new() // WP D fills this
    }
}

/// The session's cursor track, or `None` when it has none: not recorded yet,
/// recorded on macOS or Linux, from a device source, or unreadable.
pub fn load(_store: &Store, _session_id: &str) -> Option<CursorTrack> {
    None // WP D fills this
}

/// Draws a ring at `point` on an exported frame, in place. The ring is placed
/// from the point's fractional `x`/`y`, so it also lands correctly on frames
/// scaled down to `max_width` (the `--max-width` the frame was exported with).
/// A point outside the video leaves the frame unchanged.
pub fn mark_png(_path: &Path, _point: &CursorPoint, _max_width: Option<u32>) -> Result<(), String> {
    Ok(()) // WP D fills this
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
