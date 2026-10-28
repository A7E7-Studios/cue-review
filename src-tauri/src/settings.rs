//! App-wide preferences in `<root>/settings.json`, shared by the desktop app
//! and the `cue` CLI.
//!
//! WP F adds vocabulary validation here and changes [`decoding_args`] so a
//! saved vocabulary becomes a Whisper prompt. Until then the file only stores
//! the value and decoding is unchanged.

use crate::{
    models::Settings,
    store::{read_json, write_json},
};
use std::path::{Path, PathBuf};

fn path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

/// Missing or unreadable settings fall back to the defaults, so a damaged
/// file never blocks recording or transcription.
pub fn load(root: &Path) -> Settings {
    let file = path(root);
    if !file.is_file() {
        return Settings::default();
    }
    read_json(&file).unwrap_or_default()
}

/// Writes `settings.json` atomically and returns the settings as stored.
pub fn save(root: &Path, settings: &Settings) -> Result<Settings, String> {
    write_json(&path(root), settings)?;
    Ok(settings.clone())
}

/// Whisper decoding options for every final and live transcription.
///
/// Avoid carrying mistaken text into later windows or retrying noise at higher
/// temperatures. This reduces silence hallucinations, but is not a replacement
/// for speech activity detection.
pub fn decoding_args(_settings: &Settings) -> Vec<String> {
    // WP F fills this: a set vocabulary replaces `-mc 0` with a prompt.
    [
        "-l", "auto", "-ojf", "-ng", "-mc", "0", "-nf", "-nth", "0.3",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: [&str; 9] = [
        "-l", "auto", "-ojf", "-ng", "-mc", "0", "-nf", "-nth", "0.3",
    ];

    #[test]
    fn decoding_args_match_the_v0_1_options() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(decoding_args(&load(root.path())), TODAY);
        assert_eq!(decoding_args(&Settings::default()), TODAY);
    }

    #[test]
    fn settings_round_trip_and_damaged_files_fall_back_to_defaults() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(load(root.path()), Settings::default());
        let saved = save(
            root.path(),
            &Settings {
                vocabulary: Some("CueReview, Tauri".into()),
            },
        )
        .unwrap();
        assert_eq!(load(root.path()), saved);
        assert_eq!(saved.vocabulary.as_deref(), Some("CueReview, Tauri"));
        let leftovers: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["settings.json"]);
        std::fs::write(path(root.path()), b"{broken").unwrap();
        assert_eq!(load(root.path()), Settings::default());
    }
}
