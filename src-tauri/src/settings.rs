//! App-wide preferences in `<root>/settings.json`, shared by the desktop app
//! and the `cue` CLI.
//!
//! A saved vocabulary becomes a Whisper prompt. Three facts about the pinned
//! whisper.cpp (b5454, `whisper_full_with_state`) shape how it is passed:
//!
//! - The prompt and the text carried over from earlier 30 s windows share one
//!   budget, `min(-mc, n_text_ctx / 2)` tokens minus one, and history is only
//!   used at all when `-mc` is above 0. Today's `-mc 0` therefore drops a prompt.
//! - Without `--carry-initial-prompt` the prompt only reaches the first window
//!   before decoded text pushes it out. With it, the prompt is repeated in every
//!   window and decoded text only fills what is left of the budget.
//! - A prompt longer than the budget loses its *first* tokens.
//!
//! So `-mc` is set to the prompt's exact token count plus one, which carries
//! the vocabulary into every window while keeping decoded text out of the
//! context, as `-mc 0` does today. Measured on the speech and noise fixtures,
//! even 23 tokens of carried text let a hallucination repeat across a noisy
//! recording, and prompts of 130 tokens or more invented long lists on noise,
//! so the vocabulary is kept short.

use crate::{
    deps,
    models::Settings,
    store::{read_json, write_json},
};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
};

/// Most terms a vocabulary may hold.
pub const MAX_TERMS: usize = 20;
/// Most characters of the stored vocabulary, terms joined by ", ".
pub const MAX_CHARS: usize = 200;
/// Most prompt tokens [`estimate_tokens`] may predict. A 20-term list measured
/// 70 real tokens and estimates 73.
pub const MAX_ESTIMATED_TOKENS: usize = 75;
/// A prompt whose real token count exceeds this is not used, so a list the
/// estimate underrated cannot reach the lengths that invented text on noise.
const MAX_PROMPT_TOKENS: usize = 96;

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

/// Validates and normalizes the settings, writes `settings.json` atomically
/// and returns the settings as stored. An empty vocabulary turns the prompt off.
pub fn save(root: &Path, settings: &Settings) -> Result<Settings, String> {
    let stored = Settings {
        vocabulary: normalize_vocabulary(settings.vocabulary.as_deref().unwrap_or(""))?,
    };
    write_json(&path(root), &stored)?;
    Ok(stored)
}

/// Terms are separated by commas or new lines. Each is trimmed with its inner
/// whitespace collapsed; empty and repeated terms (ignoring case) are dropped,
/// and the rest are joined with ", ". `Ok(None)` means no vocabulary.
///
/// Only printable ASCII is accepted: `whisper-cli` on Windows reads its
/// arguments in the ANSI code page, so other characters would arrive garbled.
pub fn normalize_vocabulary(text: &str) -> Result<Option<String>, String> {
    if let Some(bad) = text
        .chars()
        .find(|c| !c.is_whitespace() && !c.is_ascii_graphic())
    {
        let code = format!("U+{:04X}", bad as u32);
        return Err(if bad.is_control() {
            format!("Remove the control character {code} from the vocabulary.")
        } else {
            format!("The transcriber can only read plain ASCII letters, numbers and punctuation. Remove “{bad}” ({code}).")
        });
    }
    let mut terms: Vec<String> = Vec::new();
    for raw in text.split([',', '\n', '\r']) {
        let term = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if !term.is_empty() && !terms.iter().any(|seen| seen.eq_ignore_ascii_case(&term)) {
            terms.push(term);
        }
    }
    if terms.is_empty() {
        return Ok(None);
    }
    if terms.len() > MAX_TERMS {
        return Err(format!(
            "Use at most {MAX_TERMS} terms. This list has {}.",
            terms.len()
        ));
    }
    let joined = terms.join(", ");
    if joined.len() > MAX_CHARS {
        return Err(format!(
            "Keep the vocabulary to {MAX_CHARS} characters or fewer. This list has {}.",
            joined.len()
        ));
    }
    if estimate_tokens(&joined) > MAX_ESTIMATED_TOKENS {
        return Err("These terms need more room than the transcriber's prompt allows. Remove a few or use shorter ones.".into());
    }
    Ok(Some(joined))
}

/// A rough count of Whisper prompt tokens, without the tokenizer's vocabulary.
/// Letter runs are split at case changes; words cost a token per three letters,
/// acronyms one per two, digits one per two, and each symbol one. Calibrated on
/// 36 measured lists: within -5 and +17 tokens of the real count, overrating
/// common English words. Only validation uses it; decoding uses the real count.
pub fn estimate_tokens(prompt: &str) -> usize {
    let bytes = prompt.as_bytes();
    let mut total = 0;
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        let byte = bytes[i];
        if byte.is_ascii_alphabetic() {
            while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                i += 1;
            }
            total += letter_tokens(&bytes[start..i]);
        } else if byte.is_ascii_digit() {
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            total += (i - start).div_ceil(2);
        } else {
            i += 1;
            if !byte.is_ascii_whitespace() {
                total += 1;
            }
        }
    }
    total
}

fn letter_tokens(run: &[u8]) -> usize {
    let mut total = 0;
    let mut i = 0;
    while i < run.len() {
        let uppers = run[i..]
            .iter()
            .take_while(|b| b.is_ascii_uppercase())
            .count();
        // "HTTPServer" is HTTP + Server; "gRPC" is g + RPC.
        let acronym = if i + uppers < run.len() {
            uppers.saturating_sub(1)
        } else {
            uppers
        };
        if acronym >= 2 {
            total += acronym.div_ceil(2);
            i += acronym;
            continue;
        }
        let start = i;
        i += uppers.min(1);
        while i < run.len() && run[i].is_ascii_lowercase() {
            i += 1;
        }
        if i == start {
            i += 1;
        }
        total += (i - start).div_ceil(3);
    }
    total
}

const BASE_ARGS: [&str; 4] = ["-l", "auto", "-ojf", "-ng"];
const TAIL_ARGS: [&str; 3] = ["-nf", "-nth", "0.3"];

/// Whisper decoding options for every final and live transcription.
///
/// Avoid carrying mistaken text into later windows or retrying noise at higher
/// temperatures. This reduces silence hallucinations, but is not a replacement
/// for speech activity detection. A saved vocabulary adds a prompt repeated in
/// every window, sized so no decoded text is carried (see the module notes).
/// When the prompt's tokens cannot be counted, decoding stays as without it.
pub fn decoding_args(settings: &Settings) -> Vec<String> {
    decoding_args_with(settings, prompt_tokens)
}

fn decoding_args_with(
    settings: &Settings,
    count_tokens: impl FnOnce(&str) -> Option<usize>,
) -> Vec<String> {
    let prompt = settings
        .vocabulary
        .as_deref()
        .and_then(|text| normalize_vocabulary(text).ok().flatten())
        .and_then(|prompt| {
            count_tokens(&prompt)
                .filter(|tokens| (1..=MAX_PROMPT_TOKENS).contains(tokens))
                .map(|tokens| (prompt, tokens))
        });
    let mut args: Vec<String> = BASE_ARGS.into_iter().map(String::from).collect();
    match prompt {
        Some((prompt, tokens)) => args.extend([
            "-mc".into(),
            (tokens + 1).to_string(),
            "--prompt".into(),
            prompt,
            "--carry-initial-prompt".into(),
        ]),
        None => args.extend(["-mc".into(), "0".into()]),
    }
    args.extend(TAIL_ARGS.into_iter().map(String::from));
    args
}

/// The prompt's exact token count from the transcription model's own tokenizer,
/// remembered for the life of the process.
fn prompt_tokens(prompt: &str) -> Option<usize> {
    static COUNTS: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
    let model = deps::model_path();
    let key = format!("{}\n{prompt}", model.display());
    let counts = COUNTS.get_or_init(Default::default);
    if let Some(count) = counts.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(*count);
    }
    let count = probe_prompt_tokens(&model, prompt)?;
    counts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, count);
    Some(count)
}

/// whisper.cpp logs a carried prompt's token count when it exceeds the budget.
/// With a one-token budget every longer prompt is reported, and `-d 100` stops
/// decoding before the encoder runs, so this takes about one model load.
fn probe_prompt_tokens(model: &Path, prompt: &str) -> Option<usize> {
    if !model.is_file() {
        return None;
    }
    let mut command = deps::command("whisper-cli").ok()?;
    command
        .arg("-m")
        .arg(model)
        .args(["-f", "-", "-ng", "-d", "100", "-mc", "2"])
        .args(["--carry-initial-prompt", "--prompt", prompt, "-t", "1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    // Write from another thread so a full stderr pipe cannot stall either side.
    let writer = std::thread::spawn(move || stdin.write_all(&silent_wav()));
    let output = child.wait_with_output().ok()?;
    let _ = writer.join();
    if !output.status.success() {
        return None;
    }
    parse_prompt_tokens(&String::from_utf8_lossy(&output.stderr), prompt)
}

fn parse_prompt_tokens(log: &str, prompt: &str) -> Option<usize> {
    const MARK: &str = "initial prompt is too long (";
    if let Some(at) = log.find(MARK) {
        let rest = &log[at + MARK.len()..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if !rest[digits..].starts_with(" tokens)") {
            return None;
        }
        return rest[..digits].parse().ok();
    }
    // A one-token prompt fits the budget and logs nothing. Trust that only when
    // decoding got past its input checks and the prompt plausibly is one token,
    // so a runtime that rejects the flags or words the log differently is ignored.
    (log.contains("whisper_print_timings")
        && !log.contains("input is too short")
        && estimate_tokens(prompt) <= 2)
        .then_some(1)
}

/// A quarter second of 16 kHz mono silence as a WAV file.
fn silent_wav() -> Vec<u8> {
    const SAMPLES: u32 = 4000;
    let data = SAMPLES * 2;
    let mut wav = Vec::with_capacity(44 + data as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes()); // bytes per second
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    wav.resize(44 + data as usize, 0);
    wav
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: [&str; 9] = [
        "-l", "auto", "-ojf", "-ng", "-mc", "0", "-nf", "-nth", "0.3",
    ];

    fn vocabulary(text: &str) -> Settings {
        Settings {
            vocabulary: Some(text.into()),
        }
    }

    #[test]
    fn decoding_args_match_the_v0_1_options() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(decoding_args(&load(root.path())), TODAY);
        assert_eq!(decoding_args(&Settings::default()), TODAY);
        let never = |_: &str| -> Option<usize> { panic!("no prompt to count") };
        assert_eq!(decoding_args_with(&Settings::default(), never), TODAY);
        assert_eq!(decoding_args_with(&vocabulary(" ,\n "), never), TODAY);
    }

    #[test]
    fn a_vocabulary_is_carried_into_every_window_without_decoded_history() {
        let args = decoding_args_with(&vocabulary("CueReview,\n  Tauri  , Figtree"), |prompt| {
            assert_eq!(prompt, "CueReview, Tauri, Figtree");
            Some(10)
        });
        assert_eq!(
            args,
            [
                "-l",
                "auto",
                "-ojf",
                "-ng",
                "-mc",
                "11",
                "--prompt",
                "CueReview, Tauri, Figtree",
                "--carry-initial-prompt",
                "-nf",
                "-nth",
                "0.3",
            ]
        );
    }

    #[test]
    fn decoding_falls_back_when_the_prompt_cannot_be_used() {
        // The tokenizer is unavailable, or the real count is out of range.
        for count in [None, Some(0), Some(MAX_PROMPT_TOKENS + 1)] {
            assert_eq!(
                decoding_args_with(&vocabulary("CueReview"), |_| count),
                TODAY
            );
        }
        assert_eq!(
            decoding_args_with(&vocabulary("CueReview"), |_| Some(MAX_PROMPT_TOKENS))[5],
            (MAX_PROMPT_TOKENS + 1).to_string()
        );
        // A hand-edited settings.json is validated like a saved one.
        let never = |_: &str| -> Option<usize> { panic!("invalid vocabulary was counted") };
        assert_eq!(decoding_args_with(&vocabulary("Café"), never), TODAY);
        let too_many = (0..=MAX_TERMS).map(|i| format!("t{i}")).collect::<Vec<_>>();
        assert_eq!(
            decoding_args_with(&vocabulary(&too_many.join(",")), never),
            TODAY
        );
    }

    #[test]
    fn prompts_stay_one_argument_whatever_they_contain() {
        // Command passes each argument without a shell, quoting it for the
        // MSVC runtime on Windows; whisper-cli takes the next argument as the
        // prompt even when it starts with a dash.
        let text = r#"-mc 999, "quoted" term, C:\path\, & | > %PATH% $(x)"#;
        let prompt = normalize_vocabulary(text).unwrap().unwrap();
        assert_eq!(
            prompt,
            r#"-mc 999, "quoted" term, C:\path\, & | > %PATH% $(x)"#
        );
        let args = decoding_args_with(&vocabulary(text), |_| Some(20));
        let at = args.iter().position(|arg| arg == "--prompt").unwrap();
        assert_eq!(args[at + 1], prompt);
        assert_eq!(args.len(), 12);
    }

    #[test]
    fn vocabulary_is_trimmed_collapsed_split_and_deduplicated() {
        assert_eq!(normalize_vocabulary("").unwrap(), None);
        assert_eq!(normalize_vocabulary(" , \n\r\n\t,").unwrap(), None);
        assert_eq!(
            normalize_vocabulary("  CueReview ,Tauri\r\nFigtree\n\nNadia   Okafor,\tQuest 3 ")
                .unwrap()
                .as_deref(),
            Some("CueReview, Tauri, Figtree, Nadia Okafor, Quest 3")
        );
        assert_eq!(
            normalize_vocabulary("Tauri, tauri,TAURI, WebView2")
                .unwrap()
                .as_deref(),
            Some("Tauri, WebView2")
        );
        // Pasted non-breaking spaces are whitespace, not text.
        assert_eq!(
            normalize_vocabulary("Quest\u{a0}3").unwrap().as_deref(),
            Some("Quest 3")
        );
    }

    #[test]
    fn vocabulary_rejects_what_whisper_cannot_read_or_hold() {
        assert_eq!(
            normalize_vocabulary("Café, Tauri").unwrap_err(),
            "The transcriber can only read plain ASCII letters, numbers and punctuation. Remove “é” (U+00E9)."
        );
        assert_eq!(
            normalize_vocabulary("Tauri\u{7}").unwrap_err(),
            "Remove the control character U+0007 from the vocabulary."
        );
        let terms = |n: usize| {
            (1..=n)
                .map(|i| format!("t{i}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        assert!(normalize_vocabulary(&terms(MAX_TERMS)).is_ok());
        assert_eq!(
            normalize_vocabulary(&terms(MAX_TERMS + 3)).unwrap_err(),
            "Use at most 20 terms. This list has 23."
        );
        let long = (1..=7)
            .map(|i| format!("onboarding checkout dashboard {i}"))
            .collect::<Vec<_>>()
            .join(", ");
        assert_eq!(long.len(), 229);
        assert_eq!(
            normalize_vocabulary(&long).unwrap_err(),
            "Keep the vocabulary to 200 characters or fewer. This list has 229."
        );
        let dense = "XQZ-9, k8s, i18n, a11y, OAuth2, JWT, gRPC, WASM, SIMD, AVX-512, XQZ-8, k9s, i19n, a12y, OAuth3, JWS, gRPD, WASI, SIMT, AVX-256";
        assert!(dense.len() <= MAX_CHARS);
        assert_eq!(
            normalize_vocabulary(dense).unwrap_err(),
            "These terms need more room than the transcriber's prompt allows. Remove a few or use shorter ones."
        );
    }

    #[test]
    fn token_estimate_tracks_measured_whisper_counts() {
        // Real counts from the base model's tokenizer (b5454).
        for (prompt, measured, estimated) in [
            ("CueReview, Tauri, Figtree, Nadia, Quest", 16, 16),
            ("Kubernetes, PostgreSQL, Grafana, Prometheus, Terraform", 18, 23),
            ("Siobhan, Aoife, Niamh, Tadhg, Caoimhe, Saoirse, Oisin", 26, 23),
            ("XQZ-9, k8s, i18n, a11y, OAuth2, JWT, gRPC, WASM, SIMD, AVX-512", 40, 40),
            ("HTTP/2, TLS 1.3, IPv6, DNS-over-HTTPS, WebRTC, QUIC", 30, 31),
            ("CueReview, Tauri, Figtree, Nadia, Quest, WebView2, scrcpy, ffmpeg, ffprobe, Whisper, Silero, Storybook, Vitest, Clippy, rustfmt, DTW, VAD, Recents, Record more, Copy for agent", 70, 73),
        ] {
            assert_eq!(estimate_tokens(prompt), estimated, "{prompt} ({measured} tokens)");
            assert!(normalize_vocabulary(prompt).is_ok(), "{prompt}");
        }
    }

    #[test]
    fn token_counts_are_read_from_the_whisper_log() {
        let log = "whisper_full_with_state: initial prompt is too long (16 tokens), will use only the last 1 tokens\nwhisper_print_timings:     load time =   106.49 ms\n";
        assert_eq!(parse_prompt_tokens(log, "CueReview, Tauri"), Some(16));
        let quiet = "whisper_print_timings:   encode time =     0.00 ms /     1 runs\n";
        assert_eq!(parse_prompt_tokens(quiet, "Q"), Some(1));
        // Silence is only trusted for prompts that can be one token.
        assert_eq!(parse_prompt_tokens(quiet, "CueReview, Tauri"), None);
        for broken in [
            "error: unknown argument: --carry-initial-prompt\nusage: ...",
            "whisper_full_with_state: input is too short - 90 ms < 100 ms\nwhisper_print_timings: ...",
            "initial prompt is too long (many tokens)",
            "",
        ] {
            assert_eq!(parse_prompt_tokens(broken, "Q"), None, "{broken}");
        }
        let wav = silent_wav();
        assert_eq!(
            (&wav[..4], &wav[8..16], wav.len()),
            (&b"RIFF"[..], &b"WAVEfmt "[..], 8044)
        );
    }

    #[test]
    fn save_validates_and_stores_the_normalized_vocabulary() {
        let root = tempfile::tempdir().unwrap();
        let saved = save(root.path(), &vocabulary(" CueReview \n Tauri,, ")).unwrap();
        assert_eq!(saved.vocabulary.as_deref(), Some("CueReview, Tauri"));
        assert_eq!(load(root.path()), saved);
        let error = save(root.path(), &vocabulary("Ünïcode")).unwrap_err();
        assert!(error.contains("Remove “Ü”"), "{error}");
        assert_eq!(load(root.path()), saved, "a rejected save keeps the file");
        let cleared = save(root.path(), &vocabulary("  \n ")).unwrap();
        assert_eq!(cleared, Settings::default());
        assert_eq!(std::fs::read_to_string(path(root.path())).unwrap(), "{}");
    }

    #[test]
    fn settings_round_trip_and_damaged_files_fall_back_to_defaults() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(load(root.path()), Settings::default());
        let saved = save(root.path(), &vocabulary("CueReview, Tauri")).unwrap();
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

    /// Whisper itself, with the speech gate bypassed, so noise reaches the
    /// prompted decoder. Mirrors transcribe.rs: DTW `base` for the default model.
    fn ungated_whisper(
        settings: &Settings,
        input: &Path,
        prefix: &Path,
    ) -> (crate::models::Transcript, String) {
        let mut whisper = deps::command("whisper-cli").unwrap();
        let preset = match std::env::var_os("CUEREVIEW_MODEL") {
            None => Some("base".to_string()),
            Some(_) => std::env::var("CUEREVIEW_DTW_MODEL").ok(),
        };
        if let Some(preset) = preset {
            whisper.args(["-dtw", &preset, "-nfa"]);
        }
        let output = whisper
            .arg("-m")
            .arg(deps::model_path())
            .arg("-f")
            .arg(input)
            .args(decoding_args(settings))
            .args(["-t", "2", "-of"])
            .arg(prefix)
            .output()
            .unwrap();
        let log = String::from_utf8_lossy(&output.stderr).into_owned();
        std::fs::write(prefix.with_extension("log"), &log).unwrap();
        assert!(output.status.success(), "whisper-cli failed: {log}");
        let raw: serde_json::Value = read_json(&prefix.with_extension("json")).unwrap();
        (crate::transcribe::parse_whisper(&raw).unwrap(), log)
    }

    #[test]
    #[ignore = "Requires whisper-b5454 on PATH, FFmpeg, the base model, test-results/speech/reference.wav, silence-check/quiet-noise.wav and vad-experiment/delayed-speech.wav"]
    fn actual_vocabulary_prompt_keeps_speech_and_alignment_and_adds_nothing_to_noise() {
        use crate::{agent::find, transcribe::transcribe_snapshot};
        use std::sync::atomic::AtomicBool;
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("test-results");
        let evidence = fixtures.join("vocabulary-prompt");
        std::fs::create_dir_all(&evidence).unwrap();
        let root = tempfile::tempdir().unwrap();
        let settings = save(
            root.path(),
            &vocabulary("CueReview, Tauri, Figtree, Nadia, Quest"),
        )
        .unwrap();
        let prompt = settings.vocabulary.clone().unwrap();
        let cancel = AtomicBool::new(false);

        // The model's own tokenizer sizes the context so no decoded text is carried.
        let began = std::time::Instant::now();
        let tokens = prompt_tokens(&prompt).expect("whisper-cli should count the prompt");
        let probe_ms = began.elapsed().as_millis();
        assert!((8..=32).contains(&tokens), "{tokens} tokens");
        let args = decoding_args(&settings);
        let context = (tokens + 1).to_string();
        assert_eq!(
            args[4..9],
            [
                "-mc",
                context.as_str(),
                "--prompt",
                prompt.as_str(),
                "--carry-initial-prompt"
            ]
        );
        assert!(!args.windows(2).any(|pair| pair == ["-mc", "0"]));

        // Quiet pink noise, about -68 dB mean, like an idle microphone.
        let noise = evidence.join("quiet-pink-noise.wav");
        let mut ffmpeg = deps::command("ffmpeg").unwrap();
        let generated = ffmpeg
            .args(["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("anoisesrc=color=pink:amplitude=0.002:sample_rate=16000:duration=30:seed=7")
            .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
            .arg(&noise)
            .status()
            .unwrap();
        assert!(generated.success());

        // Speech keeps every phrase and alignment point, through the app's own
        // path (speech gate, then Whisper) and through Whisper alone.
        let speech = fixtures.join("speech/reference.wav");
        let gated_dir = tempfile::tempdir().unwrap();
        let gated = transcribe_snapshot(root.path(), &speech, gated_dir.path(), &cancel).unwrap();
        let (ungated, log) = ungated_whisper(&settings, &speech, &evidence.join("speech"));
        assert!(!log.contains("initial prompt is too long"), "{log}");
        for transcript in [&gated, &ungated] {
            for phrase in ["open the library", "click here", "top toolbar"] {
                assert!(
                    !find(transcript, phrase).unwrap().is_empty(),
                    "Lost phrase with the prompt on: {phrase}"
                );
            }
            let words: Vec<_> = transcript.segments.iter().flat_map(|s| &s.words).collect();
            assert!(words.len() >= 25, "only {} words", words.len());
            assert!(
                words.iter().all(|word| word.seek_ms.is_some()),
                "Every word keeps a DTW seek point"
            );
        }

        // Noise yields no words, from the gated path and from Whisper alone.
        for (name, input) in [
            ("generated-noise", noise.clone()),
            (
                "microphone-noise",
                fixtures.join("silence-check/quiet-noise.wav"),
            ),
        ] {
            let folder = tempfile::tempdir().unwrap();
            let gated = transcribe_snapshot(root.path(), &input, folder.path(), &cancel).unwrap();
            assert!(
                gated.segments.is_empty(),
                "{name}: the gated path produced text"
            );
            let (ungated, _) = ungated_whisper(&settings, &input, &evidence.join(name));
            assert!(
                ungated.segments.is_empty(),
                "{name}: the prompt made Whisper invent {:?}",
                ungated.segments.iter().map(|s| &s.text).collect::<Vec<_>>()
            );
        }

        // Ten seconds of leading silence: the phrase keeps its aligned time.
        let delayed_dir = tempfile::tempdir().unwrap();
        let delayed = transcribe_snapshot(
            root.path(),
            &fixtures.join("vad-experiment/delayed-speech.wav"),
            delayed_dir.path(),
            &cancel,
        )
        .unwrap();
        let click = find(&delayed, "click here").unwrap();
        assert!((14000..15000).contains(&click[0].seek_ms.unwrap()));

        let summary = serde_json::json!({
            "prompt": prompt,
            "promptTokens": tokens,
            "probeMs": probe_ms,
            "decodingArgs": args,
            "speech": ungated.segments.iter().map(|s| &s.text).collect::<Vec<_>>(),
            "delayedFirstWord": delayed.segments[0].words[0].text,
            "delayedClickHereSeekMs": click[0].seek_ms,
        });
        std::fs::write(
            evidence.join("regression.json"),
            serde_json::to_vec_pretty(&summary).unwrap(),
        )
        .unwrap();
    }
}
