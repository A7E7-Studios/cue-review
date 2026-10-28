//! Takes: "Record more" continues a session as a new take (plan decision 10).
//!
//! WP C fills this module. Take N is recorded into `sessions/<id>/takes/<N>/`,
//! and the legacy root files are take 1. Each take starts at the validated
//! duration of the takes before it; the combined `video.mp4` is rebuilt with
//! the ffconcat demuxer, and only the new take is transcribed, shifted by its
//! offset, with `t{N}-` segment ids. The shared types live in
//! [`crate::models`]: [`Take`](crate::models::Take),
//! [`TakeStatus`](crate::models::TakeStatus) and
//! [`TakeMark`](crate::models::TakeMark).
