//! Argument parsing, per-command help and plain-text formatting for the
//! `cue` agent CLI.
//!
//! Everything here is pure, so `cargo test --lib` covers it. `src/bin/cue.rs`
//! calls [`parse`] first and prints [`Invocation::Help`] before it opens the
//! store or takes the recording lock.

use crate::{
    agent::{normalized, segment_seek_ms, FrameStyle, FrameTime, FrameTimes},
    models::Transcript,
};
use std::{fmt::Write as _, path::PathBuf};

/// What `cue` was asked to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Invocation {
    /// Print this text to stdout and exit 0, touching nothing else.
    Help(String),
    Run(Command),
}

/// How `cue transcript` prints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptFormat {
    /// One segment's text per line.
    Text,
    /// `[mm:ss | seekMs] text` per segment, with take dividers.
    Segments,
    /// The full transcript JSON.
    Json,
}

/// A parsed `cue` command with validated arguments.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Projects,
    Sessions {
        project: Option<String>,
    },
    Info {
        id: String,
    },
    Transcript {
        id: String,
        format: TranscriptFormat,
    },
    Find {
        id: String,
        phrase: String,
    },
    Frame {
        id: String,
        at: FrameTime,
        output: Option<PathBuf>,
        style: FrameStyle,
    },
    Frames {
        id: String,
        times: FrameTimes,
        output_dir: Option<PathBuf>,
        style: FrameStyle,
    },
    Clip {
        id: String,
        start_ms: u64,
        end_ms: u64,
        output: Option<PathBuf>,
    },
    Rename {
        id: String,
        name: String,
    },
    Moments {
        id: String,
        frames: bool,
        style: FrameStyle,
    },
    Transcribe {
        id: String,
    },
    DiscardTake {
        id: String,
        index: u32,
    },
    Setup {
        install: bool,
    },
    Sources,
    Microphones,
    Record {
        project: Option<String>,
        source: String,
        seconds: u64,
        mic: Option<String>,
        system_audio: bool,
        name: Option<String>,
    },
}

impl Command {
    /// Commands that change recordings or tools hold the data folder's
    /// process lock. Everything else, `rename` included, runs beside the app.
    pub fn needs_ownership(&self) -> bool {
        matches!(
            self,
            Command::Record { .. }
                | Command::Transcribe { .. }
                | Command::DiscardTake { .. }
                | Command::Setup { install: true }
        )
    }
}

/// What `cue` does with its arguments, in this order: parse them; print help
/// (returned as `Ok(Some(text))`) or report an argument error without calling
/// anything else; `open` the store; take the data folder's process lock with
/// `lock` when the command needs it; run the command with `execute` while
/// that lock is held. `src/bin/cue.rs` is only this call.
pub fn dispatch<S, L>(
    args: &[String],
    open: impl FnOnce() -> Result<S, String>,
    lock: impl FnOnce(&S) -> Result<L, String>,
    execute: impl FnOnce(&S, Command) -> Result<(), String>,
) -> Result<Option<String>, String> {
    let command = match parse(args)? {
        Invocation::Help(text) => return Ok(Some(text)),
        Invocation::Run(command) => command,
    };
    let store = open()?;
    let _held = if command.needs_ownership() {
        Some(lock(&store)?)
    } else {
        None
    };
    execute(&store, command)?;
    Ok(None)
}

struct Opt {
    flag: &'static str,
    /// Placeholder for the value, or `None` for a switch.
    value: Option<&'static str>,
    help: &'static str,
}
const fn switch(flag: &'static str, help: &'static str) -> Opt {
    Opt {
        flag,
        value: None,
        help,
    }
}
const fn valued(flag: &'static str, value: &'static str, help: &'static str) -> Opt {
    Opt {
        flag,
        value: Some(value),
        help,
    }
}

struct Spec {
    name: &'static str,
    /// Everything after `cue NAME` in the usage line.
    usage: &'static str,
    about: &'static str,
    /// Positional argument names, in order.
    positionals: &'static [&'static str],
    /// How many leading positionals are required.
    required: usize,
    options: &'static [Opt],
    notes: &'static str,
}

const MAX_WIDTH: Opt = valued(
    "--max-width",
    "N",
    "Scale frames wider than N pixels down to N, keeping the aspect ratio (never up)",
);
const MARK_CURSOR: Opt = switch(
    "--mark-cursor",
    "Draw a ring where the pointer was, when the session has a cursor track",
);

const SPECS: &[Spec] = &[
    Spec {
        name: "projects",
        usage: "",
        about: "List projects as JSON.",
        positionals: &[],
        required: 0,
        options: &[],
        notes: "",
    },
    Spec {
        name: "sessions",
        usage: "[PROJECT_ID]",
        about: "List sessions as JSON, newest first; with PROJECT_ID, only that project's.",
        positionals: &["PROJECT_ID"],
        required: 0,
        options: &[],
        notes: "",
    },
    Spec {
        name: "info",
        usage: "SESSION_ID",
        about: "Print one session as JSON: name, status, durationMs, takes, videos and folder paths.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[],
        notes: "videos lists each take video as {take,startMs,durationMs} on the session timeline (formatVersion 2); without it, video.mp4 plays the whole timeline. Take 1's video is video.mp4 in the session folder, take N's is takes/N/video.mp4.",
    },
    Spec {
        name: "transcript",
        usage: "SESSION_ID [--segments | --json]",
        about: "Print the transcript. Without options, prints each segment's text on its own line.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[
            switch(
                "--segments",
                "One line per segment as [mm:ss | seekMs] text (h:mm:ss from one hour), with a \"── Take N · m:ss ──\" line where each take starts",
            ),
            switch(
                "--json",
                "The full transcript with word timestamps; segments and words also get cursor when the session has a cursor track",
            ),
        ],
        notes: "seekMs is the first word's alignment point when present, otherwise the segment start. Pass it to frame --at-ms.",
    },
    Spec {
        name: "find",
        usage: "SESSION_ID --phrase TEXT",
        about: "Find a spoken phrase, ignoring case and punctuation. Prints a JSON array of {occurrence,startMs,endMs,seekMs,text}, plus cursor when the session has a cursor track.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[valued("--phrase", "TEXT", "Words to find, in order")],
        notes: "",
    },
    Spec {
        name: "frame",
        usage: "SESSION_ID (--at-ms MS | --phrase TEXT [--occurrence N]) [--max-width N] [--mark-cursor] [--output PATH]",
        about: "Export one PNG frame. Prints {path,timeMs,width,height,cursor}; cursor is null without a cursor track.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[
            valued("--at-ms", "MS", "Time of the frame in milliseconds"),
            valued("--phrase", "TEXT", "Use the seek point of a spoken phrase instead"),
            valued("--occurrence", "N", "Which match of --phrase to use, from 1 (default 1)"),
            MAX_WIDTH,
            MARK_CURSOR,
            valued(
                "--output",
                "PATH",
                "Write the PNG here instead of the session's exports folder; fails if PATH exists",
            ),
        ],
        notes: "MS is session time: the frame comes from the video of the take it falls in, at that take's size. For several frames in one call, use cue frames.",
    },
    Spec {
        name: "frames",
        usage: "SESSION_ID (--at-ms MS,MS,... | --per-segment) [--max-width N] [--mark-cursor] [--output-dir DIR]",
        about: "Export several PNG frames in one call. Prints a JSON array of {path,timeMs,width,height,cursor}; --per-segment entries also have segmentId.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[
            valued("--at-ms", "MS,MS,...", "Comma-separated times in milliseconds; quote the list in PowerShell"),
            switch("--per-segment", "One frame at each transcript segment's seek point"),
            MAX_WIDTH,
            MARK_CURSOR,
            valued(
                "--output-dir",
                "DIR",
                "Write into DIR (created if missing) instead of the session's exports folder",
            ),
        ],
        notes: "Each frame comes from the video of the take its time falls in. Every frame is written to a new file; existing files are never overwritten.",
    },
    Spec {
        name: "clip",
        usage: "SESSION_ID --start-ms MS --end-ms MS [--output PATH]",
        about: "Export an MP4 clip. Prints {path}.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[
            valued("--start-ms", "MS", "Clip start in milliseconds"),
            valued("--end-ms", "MS", "Clip end in milliseconds, after the start"),
            valued(
                "--output",
                "PATH",
                "Write the MP4 here instead of the session's exports folder; fails if PATH exists",
            ),
        ],
        notes: "A clip comes from one take video: a range that crosses into the next take's video is refused, naming where that video starts; export one clip on each side.",
    },
    Spec {
        name: "rename",
        usage: "SESSION_ID NAME",
        about: "Rename a session and print it as JSON.",
        positionals: &["SESSION_ID", "NAME"],
        required: 2,
        options: &[],
        notes: "Quote a NAME with spaces; put -- before a NAME that starts with a dash. Works while the app is open: it does not take the recording lock.",
    },
    Spec {
        name: "moments",
        usage: "SESSION_ID [--frames [--max-width N] [--mark-cursor]]",
        about: "List spoken pointing moments: words such as here, there, this, these, that, those, see, look at, right here and over here. Prints a JSON array of {segmentId,term,phrase,seekMs,startMs,endMs,text,cursor,clicks}; clicks are presses within 1 s of seekMs.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[
            switch("--frames", "Also export a PNG at each moment's seekMs, given as frame"),
            MAX_WIDTH,
            MARK_CURSOR,
        ],
        notes: "Uses \"that\" only where it points (\"click that\"), not as a conjunction (\"I think that it\"), and \"there\" not in \"there is\".",
    },
    Spec {
        name: "transcribe",
        usage: "SESSION_ID",
        about: "Transcribe a finished session again, locally, and print the transcript JSON. Takes the recording lock.",
        positionals: &["SESSION_ID"],
        required: 1,
        options: &[],
        notes: "",
    },
    Spec {
        name: "discard-take",
        usage: "SESSION_ID INDEX",
        about: "Kept for scripts: takes keep their own videos now, so no take waits to be added and every take is refused. Takes the recording lock.",
        positionals: &["SESSION_ID", "INDEX"],
        required: 2,
        options: &[],
        notes: "A take of an older session that still waited to be added is upgraded when CueReview starts, or by cue transcribe, and plays from its own video.",
    },
    Spec {
        name: "setup",
        usage: "[--install]",
        about: "Print the local transcription setup status as JSON.",
        positionals: &[],
        required: 0,
        options: &[switch(
            "--install",
            "Download and install the transcription tools and model (the only network access); takes the recording lock",
        )],
        notes: "",
    },
    Spec {
        name: "sources",
        usage: "",
        about: "List capture sources as JSON.",
        positionals: &[],
        required: 0,
        options: &[],
        notes: "",
    },
    Spec {
        name: "microphones",
        usage: "",
        about: "List microphones as JSON.",
        positionals: &[],
        required: 0,
        options: &[],
        notes: "",
    },
    Spec {
        name: "record",
        usage: "--source ID --seconds N [--project ID] [--mic ID] [--system-audio] [--name TEXT]",
        about: "Record a new session, transcribe it and print the session JSON. Takes the recording lock.",
        positionals: &[],
        required: 0,
        options: &[
            valued("--source", "ID", "Capture source, from cue sources"),
            valued("--seconds", "N", "Recording length, 1 to 3600 seconds"),
            valued("--project", "ID", "Project to add the session to"),
            valued("--mic", "ID", "Microphone, from cue microphones"),
            switch("--system-audio", "Also record system audio"),
            valued("--name", "TEXT", "Session name; without it the transcript names the session"),
        ],
        notes: "",
    },
];

fn spec(name: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.name == name)
}

fn usage_line(spec: &Spec) -> String {
    format!("cue {} {}", spec.name, spec.usage)
        .trim_end()
        .to_owned()
}

/// `cue --help`: every command's usage line.
pub fn overview() -> String {
    let mut text = String::from(
        "CueReview — local agent access\n\nRun cue help COMMAND or cue COMMAND --help for a command's options.\n\n",
    );
    for spec in SPECS {
        let _ = writeln!(text, "{}", usage_line(spec));
    }
    text.push_str(
        "\nAll times are milliseconds on the session timeline; prefer seekMs for visual lookup.\n\
         Frame, frames, clip and moments output is JSON with local paths; exports never overwrite a file.\n\
         cursor is null or absent when the session has no cursor track.\n\
         CUEREVIEW_DATA_DIR overrides the shared local storage root.\n\
         No network access is used except explicit setup --install.\n",
    );
    text
}

/// `cue COMMAND --help`.
fn command_help(spec: &Spec) -> String {
    let mut text = format!("Usage: {}\n\n{}\n", usage_line(spec), spec.about);
    let width = spec
        .options
        .iter()
        .map(|o| o.flag.len() + o.value.map_or(0, |v| v.len() + 1))
        .max()
        .unwrap_or(0)
        .max("-h, --help".len());
    text.push_str("\nOptions:\n");
    for opt in spec.options {
        let left = match opt.value {
            Some(value) => format!("{} {value}", opt.flag),
            None => opt.flag.to_owned(),
        };
        let _ = writeln!(text, "  {left:<width$}  {}", opt.help);
    }
    let _ = writeln!(text, "  {:<width$}  Show this help", "-h, --help");
    if !spec.notes.is_empty() {
        let _ = writeln!(text, "\n{}", spec.notes);
    }
    text
}

/// The help text for `cue help NAME` and `cue NAME --help`.
pub fn help(command: Option<&str>) -> Result<String, String> {
    match command {
        None => Ok(overview()),
        Some(name) => spec(name)
            .map(command_help)
            .ok_or_else(|| unknown_command(name)),
    }
}

fn unknown_command(name: &str) -> String {
    format!("Unknown command {name}. Run cue --help for the list of commands.")
}

fn wants_help(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| *arg != "--")
        .any(|arg| arg == "--help" || arg == "-h")
}

/// Parses `cue`'s arguments, without the program name. Help never fails on
/// the other arguments, so `cue frame --help` works without `--at-ms`.
pub fn parse(args: &[String]) -> Result<Invocation, String> {
    let Some(first) = args.first() else {
        return Ok(Invocation::Help(overview()));
    };
    match first.as_str() {
        "--help" | "-h" => return Ok(Invocation::Help(overview())),
        "help" => {
            return match &args[1..] {
                [] => Ok(Invocation::Help(overview())),
                [flag] if flag == "--help" || flag == "-h" => Ok(Invocation::Help(overview())),
                [name] => help(Some(name.as_str())).map(Invocation::Help),
                [_, extra, ..] => Err(format!(
                    "Unexpected argument {extra}. Run cue help COMMAND for one command."
                )),
            };
        }
        _ => {}
    }
    let spec = spec(first).ok_or_else(|| unknown_command(first))?;
    let rest = &args[1..];
    if wants_help(rest) {
        return Ok(Invocation::Help(command_help(spec)));
    }
    let hint = |e: String| format!("{e} Run cue {} --help for usage.", spec.name);
    let matches = tokenize(spec, rest).map_err(hint)?;
    build(spec, &matches).map(Invocation::Run).map_err(hint)
}

#[derive(Default)]
struct Matches<'a> {
    positionals: Vec<&'a str>,
    options: Vec<(&'static str, Option<&'a str>)>,
}

impl<'a> Matches<'a> {
    fn has(&self, flag: &str) -> bool {
        self.options.iter().any(|(name, _)| *name == flag)
    }
    fn value(&self, flag: &str) -> Option<&'a str> {
        self.options
            .iter()
            .find(|(name, _)| *name == flag)
            .and_then(|(_, value)| *value)
    }
    fn required(&self, flag: &str) -> Result<&'a str, String> {
        self.value(flag).ok_or_else(|| format!("Missing {flag}."))
    }
    fn positional(&self, index: usize) -> String {
        self.positionals
            .get(index)
            .map_or_else(String::new, |value| (*value).to_owned())
    }
}

fn tokenize<'a>(spec: &Spec, args: &'a [String]) -> Result<Matches<'a>, String> {
    let mut found = Matches::default();
    let mut args = args.iter();
    let mut positional_only = false;
    while let Some(arg) = args.next() {
        let arg = arg.as_str();
        if positional_only || arg == "-" || !arg.starts_with('-') {
            found.positionals.push(arg);
            continue;
        }
        if arg == "--" {
            positional_only = true;
            continue;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value)),
            _ => (arg, None),
        };
        let opt = spec
            .options
            .iter()
            .find(|opt| opt.flag == flag)
            .ok_or_else(|| format!("Unknown option {flag} for cue {}.", spec.name))?;
        if found.has(opt.flag) {
            return Err(format!("{} was given more than once.", opt.flag));
        }
        let value = match (opt.value, inline) {
            (None, None) => None,
            (None, Some(_)) => return Err(format!("{} does not take a value.", opt.flag)),
            (Some(_), Some(value)) => Some(value),
            (Some(placeholder), None) => match args.next() {
                Some(value) if !value.starts_with("--") => Some(value.as_str()),
                _ => return Err(format!("{} needs a value ({placeholder}).", opt.flag)),
            },
        };
        found.options.push((opt.flag, value));
    }
    if let Some(extra) = found.positionals.get(spec.positionals.len()) {
        return Err(format!(
            "Unexpected argument {extra}. Quote values that contain spaces."
        ));
    }
    if found.positionals.len() < spec.required {
        return Err(format!(
            "Missing {}.",
            spec.positionals[found.positionals.len()]
        ));
    }
    Ok(found)
}

fn milliseconds(flag: &str, value: &str) -> Result<u64, String> {
    value.trim().parse().map_err(|_| {
        format!("{flag} must be a non-negative integer of milliseconds, not {value:?}.")
    })
}

fn millisecond_list(flag: &str, value: &str) -> Result<Vec<u64>, String> {
    value
        .split(',')
        .map(|item| {
            if item.trim().is_empty() {
                Err(format!(
                    "{flag} needs comma-separated milliseconds, such as 1000,2500."
                ))
            } else {
                milliseconds(flag, item)
            }
        })
        .collect()
}

fn positive(flag: &str, value: &str) -> Result<u32, String> {
    value
        .trim()
        .parse()
        .ok()
        .filter(|n: &u32| *n > 0)
        .ok_or_else(|| format!("{flag} must be a positive integer, not {value:?}."))
}

fn style(found: &Matches) -> Result<FrameStyle, String> {
    Ok(FrameStyle {
        max_width: found
            .value("--max-width")
            .map(|v| positive("--max-width", v))
            .transpose()?,
        mark_cursor: found.has("--mark-cursor"),
    })
}

fn build(spec: &Spec, found: &Matches) -> Result<Command, String> {
    let id = || found.positional(0);
    let path = |flag: &str| found.value(flag).map(PathBuf::from);
    Ok(match spec.name {
        "projects" => Command::Projects,
        "sessions" => Command::Sessions {
            project: found.positionals.first().map(|p| (*p).to_owned()),
        },
        "info" => Command::Info { id: id() },
        "transcript" => Command::Transcript {
            id: id(),
            format: match (found.has("--segments"), found.has("--json")) {
                (true, true) => return Err("Use either --segments or --json, not both.".into()),
                (true, false) => TranscriptFormat::Segments,
                (false, true) => TranscriptFormat::Json,
                (false, false) => TranscriptFormat::Text,
            },
        },
        "find" => Command::Find {
            id: id(),
            phrase: found.required("--phrase")?.to_owned(),
        },
        "frame" => {
            let at = match (found.value("--at-ms"), found.value("--phrase")) {
                (Some(_), Some(_)) => return Err("Use either --at-ms or --phrase, not both.".into()),
                (Some(at), None) if at.contains(',') => {
                    return Err(
                        "frame exports one time; use cue frames SESSION_ID --at-ms MS,MS,... for several."
                            .into(),
                    )
                }
                (Some(at), None) => {
                    if found.has("--occurrence") {
                        return Err("--occurrence only applies to --phrase.".into());
                    }
                    FrameTime::AtMs(milliseconds("--at-ms", at)?)
                }
                (None, Some(phrase)) => FrameTime::Phrase {
                    phrase: phrase.to_owned(),
                    occurrence: found
                        .value("--occurrence")
                        .map(|v| positive("--occurrence", v))
                        .transpose()?
                        .unwrap_or(1) as usize,
                },
                (None, None) => return Err("Missing --at-ms or --phrase.".into()),
            };
            Command::Frame {
                id: id(),
                at,
                output: path("--output"),
                style: style(found)?,
            }
        }
        "frames" => Command::Frames {
            id: id(),
            times: match (found.value("--at-ms"), found.has("--per-segment")) {
                (Some(_), true) => {
                    return Err("Use either --at-ms or --per-segment, not both.".into())
                }
                (Some(list), false) => FrameTimes::AtMs(millisecond_list("--at-ms", list)?),
                (None, true) => FrameTimes::PerSegment,
                (None, false) => return Err("Missing --at-ms or --per-segment.".into()),
            },
            output_dir: path("--output-dir"),
            style: style(found)?,
        },
        "clip" => Command::Clip {
            id: id(),
            start_ms: milliseconds("--start-ms", found.required("--start-ms")?)?,
            end_ms: milliseconds("--end-ms", found.required("--end-ms")?)?,
            output: path("--output"),
        },
        "rename" => Command::Rename {
            id: id(),
            name: found.positional(1),
        },
        "moments" => {
            let frames = found.has("--frames");
            let style = style(found)?;
            if !frames && style != FrameStyle::default() {
                return Err("--max-width and --mark-cursor need --frames.".into());
            }
            Command::Moments {
                id: id(),
                frames,
                style,
            }
        }
        "transcribe" => Command::Transcribe { id: id() },
        "discard-take" => {
            let index = found.positional(1);
            Command::DiscardTake {
                id: id(),
                index: index
                    .trim()
                    .parse()
                    .ok()
                    .filter(|index: &u32| *index >= 2)
                    .ok_or_else(|| {
                        format!("INDEX must be a take number from 2 on, not {index:?}.")
                    })?,
            }
        }
        "setup" => Command::Setup {
            install: found.has("--install"),
        },
        "sources" => Command::Sources,
        "microphones" => Command::Microphones,
        "record" => {
            let seconds = found.required("--seconds")?;
            let seconds = seconds
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|s| (1..=3600).contains(s))
                .ok_or("Use --seconds between 1 and 3600.")?;
            Command::Record {
                project: found.value("--project").map(str::to_owned),
                source: found.required("--source")?.to_owned(),
                seconds,
                mic: found.value("--mic").map(str::to_owned),
                system_audio: found.has("--system-audio"),
                name: found.value("--name").map(str::to_owned),
            }
        }
        other => return Err(unknown_command(other)),
    })
}

fn hms(ms: u64) -> (u64, u64, u64) {
    let seconds = ms / 1000;
    (seconds / 3600, seconds / 60 % 60, seconds % 60)
}

/// `m:ss`, or `h:mm:ss` from one hour on, as in "Take 2 · 2:14".
pub fn clock(ms: u64) -> String {
    match hms(ms) {
        (0, minutes, seconds) => format!("{minutes}:{seconds:02}"),
        (hours, minutes, seconds) => format!("{hours}:{minutes:02}:{seconds:02}"),
    }
}

/// `mm:ss`, or `h:mm:ss` from one hour on, for segment lines.
pub fn stamp(ms: u64) -> String {
    match hms(ms) {
        (0, minutes, seconds) => format!("{minutes:02}:{seconds:02}"),
        (hours, minutes, seconds) => format!("{hours}:{minutes:02}:{seconds:02}"),
    }
}

/// `cue transcript --segments`: one `[mm:ss | seekMs] text` line per segment,
/// with a `── Take N · m:ss ──` line before the first segment of each take.
pub fn format_segments(transcript: &Transcript) -> String {
    let mut text = String::new();
    let mut takes = transcript.takes.iter().peekable();
    let divider = |text: &mut String, index: u32, start_ms: u64| {
        let _ = writeln!(text, "── Take {index} · {} ──", clock(start_ms));
    };
    for segment in &transcript.segments {
        while let Some(take) = takes.next_if(|take| take.start_ms <= segment.start_ms) {
            divider(&mut text, take.index, take.start_ms);
        }
        let seek = segment_seek_ms(segment);
        let words = segment
            .text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let line = format!("[{} | {seek}] {words}", stamp(seek));
        let _ = writeln!(text, "{}", line.trim_end());
    }
    // Takes without speech still get their divider.
    for take in takes {
        divider(&mut text, take.index, take.start_ms);
    }
    text
}

/// A pointing word or phrase found by [`deictic_matches`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deictic {
    /// Index into `transcript.segments`.
    pub segment: usize,
    /// Index of the first matched word in that segment's `words`.
    pub first: usize,
    /// Index of the last matched word, inclusive.
    pub last: usize,
    /// The matched words, normalized and joined, for example `"look at this"`.
    pub term: String,
}

struct Token {
    word: usize,
    norm: String,
    /// Punctuation after this word ends the phrase, so it gives no context.
    ends_clause: bool,
}

fn ends_clause(text: &str) -> bool {
    text.trim_end_matches(['"', '\'', ')', ']', '”', '’'])
        .ends_with([',', '.', '!', '?', ';', ':', '…', '—'])
}

/// After "there" these make it existential: "there is", "there were".
const EXISTENTIAL: &[&str] = &[
    "is", "are", "was", "were", "will", "would", "should", "could", "can", "might", "may", "must",
    "has", "have", "had", "isnt", "arent", "wasnt", "werent", "wont", "used", "seems", "seem",
    "appears", "been",
];
/// After "this" these make it temporal: "this time", "this week".
const TEMPORAL: &[&str] = &[
    "time",
    "morning",
    "afternoon",
    "evening",
    "night",
    "week",
    "weekend",
    "month",
    "year",
    "quarter",
    "sprint",
];
/// Before "that" these make it a conjunction: "I think that", "so that".
const CONJUNCTION_BEFORE: &[&str] = &[
    "think", "thought", "thinks", "know", "knew", "knows", "say", "said", "says", "so", "such",
    "now", "sure", "seems", "seem", "seemed", "means", "mean", "meant", "feel", "felt", "hope",
    "believe", "realize", "realized", "notice", "noticed", "assume", "except", "given", "guess",
    "suppose", "wish", "expect", "expected", "ensure", "true", "fact", "idea", "way",
];
/// After "that" these start a clause, so "that" is a conjunction or a
/// relative pronoun: "that the panel", "that it works".
const CLAUSE_START: &[&str] = &[
    "i", "you", "we", "they", "he", "she", "it", "the", "a", "an", "there", "this", "these",
    "those", "my", "your", "our", "their", "his", "her", "its", "if", "when",
];

fn next(tokens: &[Token], i: usize) -> Option<&str> {
    tokens
        .get(i + 1)
        .filter(|_| !tokens[i].ends_clause)
        .map(|t| t.norm.as_str())
}

fn prev(tokens: &[Token], i: usize) -> Option<&str> {
    i.checked_sub(1)
        .map(|p| &tokens[p])
        .filter(|t| !t.ends_clause)
        .map(|t| t.norm.as_str())
}

/// Whether the demonstrative at `i` points rather than connects.
fn demonstrative(tokens: &[Token], i: usize) -> bool {
    let after = next(tokens, i);
    let after_in = |list: &[&str]| after.is_some_and(|n| list.contains(&n));
    match tokens[i].norm.as_str() {
        "here" | "these" | "those" => true,
        "there" => {
            !after_in(EXISTENTIAL) && !matches!(prev(tokens, i), Some("hi" | "hey" | "hello"))
        }
        "this" => !after_in(TEMPORAL),
        "that" => {
            !prev(tokens, i).is_some_and(|p| CONJUNCTION_BEFORE.contains(&p))
                && !after_in(CLAUSE_START)
        }
        _ => false,
    }
}

/// 1 when the word after `i` is a pointing demonstrative, so "look at this"
/// is one moment rather than two.
fn extension(tokens: &[Token], i: usize) -> usize {
    usize::from(next(tokens, i).is_some() && demonstrative(tokens, i + 1))
}

/// How many tokens a pointing phrase starting at `i` spans, if one does.
fn deictic_at(tokens: &[Token], i: usize) -> Option<usize> {
    let after = next(tokens, i);
    match tokens[i].norm.as_str() {
        "look" | "looking" | "looks" if after == Some("at") => Some(2 + extension(tokens, i + 1)),
        "right" | "over" if matches!(after, Some("here" | "there")) => Some(2),
        "see" => {
            let understanding = prev(tokens, i) == Some("i");
            let conditional = matches!(after, Some("if" | "whether" | "you"));
            (!understanding && !conditional).then(|| 1 + extension(tokens, i))
        }
        _ => demonstrative(tokens, i).then_some(1),
    }
}

/// Pointing words in every segment, in transcript order. Matching uses
/// normalized words and cheap context rules to skip the most common
/// non-pointing uses ("I think that it", "there is", "this week", "I see").
pub fn deictic_matches(transcript: &Transcript) -> Vec<Deictic> {
    let mut found = Vec::new();
    for (segment_index, segment) in transcript.segments.iter().enumerate() {
        let mut tokens: Vec<Token> = Vec::with_capacity(segment.words.len());
        for (word, item) in segment.words.iter().enumerate() {
            let norm = normalized(&item.text);
            let ends = ends_clause(&item.text);
            if norm.is_empty() {
                // A standalone dash or ellipsis still ends the phrase before it.
                if let (true, Some(last)) = (ends, tokens.last_mut()) {
                    last.ends_clause = true;
                }
                continue;
            }
            tokens.push(Token {
                word,
                norm,
                ends_clause: ends,
            });
        }
        let mut i = 0;
        while i < tokens.len() {
            let Some(len) = deictic_at(&tokens, i) else {
                i += 1;
                continue;
            };
            let span = &tokens[i..i + len];
            found.push(Deictic {
                segment: segment_index,
                first: span[0].word,
                last: span[len - 1].word,
                term: span
                    .iter()
                    .map(|t| t.norm.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            });
            i += len;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Segment, TakeMark, Word};

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }
    fn run(line: &str) -> Command {
        match parse(&args(line)) {
            Ok(Invocation::Run(command)) => command,
            other => panic!("{line}: {other:?}"),
        }
    }
    fn fails(line: &str) -> String {
        match parse(&args(line)) {
            Err(e) => e,
            other => panic!("{line} should fail: {other:?}"),
        }
    }
    fn help_text(line: &str) -> String {
        match parse(&args(line)) {
            Ok(Invocation::Help(text)) => text,
            other => panic!("{line} should print help: {other:?}"),
        }
    }
    const ID: &str = "0b6f3c1e-8a4f-4d0a-9a51-2f3b8d6c9e10";

    #[test]
    fn every_command_has_help_that_needs_no_other_arguments() {
        let overview = help_text("--help");
        assert_eq!(help_text(""), overview);
        assert_eq!(help_text("-h"), overview);
        assert_eq!(help_text("help"), overview);
        for spec in SPECS {
            let name = spec.name;
            assert!(overview.contains(&format!("cue {name}")), "{name} missing");
            let text = help_text(&format!("{name} --help"));
            assert!(text.starts_with(&format!("Usage: cue {name}")), "{text}");
            assert!(text.contains("-h, --help"));
            for opt in spec.options {
                assert!(text.contains(opt.flag), "{name} help lacks {}", opt.flag);
            }
            assert_eq!(help_text(&format!("help {name}")), text);
            assert_eq!(help_text(&format!("{name} -h")), text);
            // Help wins over missing or invalid arguments.
            assert_eq!(help_text(&format!("{name} {ID} --bogus --help")), text);
        }
        assert!(help_text("frame --help").contains("--max-width N"));
        assert!(help_text("frames --help").contains("--per-segment"));
        assert!(fails("help nope").contains("Unknown command nope"));
        assert!(fails("help frame extra").contains("Unexpected argument extra"));
        assert!(fails("nope").contains("Run cue --help"));
    }

    /// Runs [`dispatch`] with fakes that log each step, as `cue` would.
    fn steps(line: &str) -> (Result<Option<String>, String>, Vec<String>) {
        struct Held<'a>(&'a std::cell::RefCell<Vec<String>>);
        impl Drop for Held<'_> {
            fn drop(&mut self) {
                self.0.borrow_mut().push("unlock".into());
            }
        }
        let log = std::cell::RefCell::new(Vec::new());
        let note = |step: &str| log.borrow_mut().push(step.to_owned());
        let result = dispatch(
            &args(line),
            || {
                note("open");
                Ok("store")
            },
            |store: &&str| {
                note(&format!("lock {store}"));
                Ok(Held(&log))
            },
            |_, command| {
                note(&format!("run {command:?}"));
                Ok(())
            },
        );
        let log = log.borrow().clone();
        (result, log)
    }

    #[test]
    fn help_never_takes_the_lock_but_mutating_commands_do() {
        // Help and argument errors print before the store is opened.
        for line in [
            "record --help",
            "transcribe --help",
            "setup --install --help",
            "discard-take --help",
            "help record",
            "--help",
        ] {
            let (result, log) = steps(line);
            assert!(result.unwrap().unwrap().contains("cue"), "{line}");
            assert!(log.is_empty(), "{line}: {log:?}");
        }
        for line in ["record --seconds 5", "transcribe", "frames --bogus"] {
            let (result, log) = steps(line);
            assert!(result.unwrap_err().contains("--help"), "{line}");
            assert!(log.is_empty(), "{line}: {log:?}");
        }
        // Mutating commands run inside the lock, which is released after.
        for line in [
            "record --source monitor:1 --seconds 5".to_owned(),
            format!("transcribe {ID}"),
            format!("discard-take {ID} 2"),
            "setup --install".to_owned(),
        ] {
            let (result, log) = steps(&line);
            assert_eq!(result, Ok(None));
            assert_eq!(log.len(), 4, "{line}: {log:?}");
            assert_eq!(
                (&*log[0], &*log[1], &*log[3]),
                ("open", "lock store", "unlock")
            );
            assert!(log[2].starts_with("run "), "{line}: {log:?}");
        }
        // Everything else runs beside the app, without the lock.
        for line in [
            "setup".to_owned(),
            format!("rename {ID} Better"),
            format!("frames {ID} --per-segment"),
        ] {
            let (_, log) = steps(&line);
            assert_eq!(log.len(), 2, "{line}: {log:?}");
            assert_eq!(log[0], "open");
            assert!(log[1].starts_with("run "));
        }
        // A refused lock stops before the command runs.
        let refused = dispatch(
            &args(&format!("transcribe {ID}")),
            || Ok(()),
            |_| Err::<(), _>("CueReview is already using this data folder.".to_string()),
            |_, _| panic!("ran without the lock"),
        );
        assert!(refused.unwrap_err().contains("already using"));
    }

    #[test]
    fn frame_help_names_the_take_video() {
        let frame = help_text("frame --help");
        assert!(
            frame.contains("the frame comes from the video of the take it falls in"),
            "{frame}"
        );
        assert!(help_text("frames --help").contains("the take its time falls in"));
        assert!(help_text("clip --help").contains("crosses into the next take's video is refused"));
        assert!(help_text("info --help").contains("takes/N/video.mp4"));
    }
    #[test]
    fn discard_take_names_a_later_take() {
        assert_eq!(
            run(&format!("discard-take {ID} 3")),
            Command::DiscardTake {
                id: ID.into(),
                index: 3
            }
        );
        for index in ["1", "0", "two", "4294967296"] {
            let error = fails(&format!("discard-take {ID} {index}"));
            assert!(error.contains("take number from 2"), "{index}: {error}");
        }
        assert!(fails(&format!("discard-take {ID}")).contains("Missing INDEX"));
        assert!(fails(&format!("discard-take {ID} 2 3")).contains("Unexpected argument 3"));
        let help = help_text("discard-take --help");
        assert!(help.starts_with("Usage: cue discard-take SESSION_ID INDEX"));
        assert!(help.contains("Takes the recording lock"));
    }

    #[test]
    fn parses_every_command() {
        let id = || ID.to_owned();
        assert_eq!(run("projects"), Command::Projects);
        assert_eq!(run("sessions"), Command::Sessions { project: None });
        assert_eq!(
            run(&format!("sessions {ID}")),
            Command::Sessions {
                project: Some(id())
            }
        );
        assert_eq!(run(&format!("info {ID}")), Command::Info { id: id() });
        for (flags, format) in [
            ("", TranscriptFormat::Text),
            ("--segments", TranscriptFormat::Segments),
            ("--json", TranscriptFormat::Json),
        ] {
            assert_eq!(
                run(&format!("transcript {ID} {flags}")),
                Command::Transcript { id: id(), format }
            );
        }
        assert_eq!(
            run(&format!("find {ID} --phrase here")),
            Command::Find {
                id: id(),
                phrase: "here".into()
            }
        );
        assert_eq!(
            run(&format!("frame {ID} --at-ms 1500")),
            Command::Frame {
                id: id(),
                at: FrameTime::AtMs(1500),
                output: None,
                style: FrameStyle::default()
            }
        );
        assert_eq!(
            run(&format!(
                "frame {ID} --phrase here --occurrence 2 --max-width 800 --mark-cursor --output out.png"
            )),
            Command::Frame {
                id: id(),
                at: FrameTime::Phrase {
                    phrase: "here".into(),
                    occurrence: 2
                },
                output: Some("out.png".into()),
                style: FrameStyle {
                    max_width: Some(800),
                    mark_cursor: true
                }
            }
        );
        assert_eq!(
            run(&format!(
                "frames {ID} --at-ms 0,1500,3000 --output-dir shots"
            )),
            Command::Frames {
                id: id(),
                times: FrameTimes::AtMs(vec![0, 1500, 3000]),
                output_dir: Some("shots".into()),
                style: FrameStyle::default()
            }
        );
        assert_eq!(
            run(&format!(
                "frames {ID} --per-segment --max-width=1600 --mark-cursor"
            )),
            Command::Frames {
                id: id(),
                times: FrameTimes::PerSegment,
                output_dir: None,
                style: FrameStyle {
                    max_width: Some(1600),
                    mark_cursor: true
                }
            }
        );
        assert_eq!(
            run(&format!("clip {ID} --start-ms 100 --end-ms 900")),
            Command::Clip {
                id: id(),
                start_ms: 100,
                end_ms: 900,
                output: None
            }
        );
        let spaced: Vec<String> = ["rename", ID, "Library review, take two"]
            .map(String::from)
            .into();
        assert_eq!(
            parse(&spaced).unwrap(),
            Invocation::Run(Command::Rename {
                id: id(),
                name: "Library review, take two".into()
            })
        );
        assert_eq!(
            run(&format!("rename {ID} -- -draft-")),
            Command::Rename {
                id: id(),
                name: "-draft-".into()
            }
        );
        assert_eq!(
            run(&format!("moments {ID}")),
            Command::Moments {
                id: id(),
                frames: false,
                style: FrameStyle::default()
            }
        );
        assert_eq!(
            run(&format!(
                "moments {ID} --frames --max-width 640 --mark-cursor"
            )),
            Command::Moments {
                id: id(),
                frames: true,
                style: FrameStyle {
                    max_width: Some(640),
                    mark_cursor: true
                }
            }
        );
        assert_eq!(
            run(&format!("transcribe {ID}")),
            Command::Transcribe { id: id() }
        );
        assert_eq!(run("setup"), Command::Setup { install: false });
        assert_eq!(run("setup --install"), Command::Setup { install: true });
        assert_eq!(run("sources"), Command::Sources);
        assert_eq!(run("microphones"), Command::Microphones);
        assert_eq!(
            run("record --source monitor:1 --seconds 30 --mic mic:A --system-audio --name Demo --project P"),
            Command::Record {
                project: Some("P".into()),
                source: "monitor:1".into(),
                seconds: 30,
                mic: Some("mic:A".into()),
                system_audio: true,
                name: Some("Demo".into())
            }
        );
    }

    #[test]
    fn rejects_unknown_flags_missing_values_and_conflicts() {
        let unknown = fails(&format!("frame {ID} --at-ms 0 --bogus"));
        assert!(unknown.contains("Unknown option --bogus for cue frame"));
        assert!(unknown.contains("Run cue frame --help"));
        assert!(fails(&format!("transcript {ID} --segmnts")).contains("--segmnts"));
        assert!(fails(&format!("info {ID} -x")).contains("Unknown option -x"));
        assert!(fails("projects --json").contains("Unknown option --json"));
        let missing = fails(&format!("frame {ID} --at-ms"));
        assert!(missing.contains("--at-ms needs a value"), "{missing}");
        assert!(fails(&format!("frame {ID} --output --at-ms 5")).contains("--output needs a value"));
        assert!(fails(&format!("frame {ID}")).contains("Missing --at-ms or --phrase"));
        assert!(fails("frame").contains("Missing SESSION_ID"));
        assert!(fails(&format!("rename {ID}")).contains("Missing NAME"));
        assert!(fails(&format!("rename {ID} two words")).contains("Unexpected argument words"));
        assert!(fails(&format!("info {ID} extra")).contains("Unexpected argument extra"));
        assert!(fails(&format!("find {ID}")).contains("Missing --phrase"));
        assert!(fails(&format!("frame {ID} --at-ms 1 --at-ms 2")).contains("more than once"));
        assert!(fails(&format!("frame {ID} --mark-cursor=yes --at-ms 1"))
            .contains("does not take a value"));
        assert!(fails(&format!("frame {ID} --at-ms -5")).contains("non-negative integer"));
        assert!(fails(&format!("frame {ID} --at-ms 1.5")).contains("non-negative integer"));
        assert!(fails(&format!("frame {ID} --at-ms 1,2")).contains("cue frames"));
        assert!(fails(&format!("frame {ID} --at-ms 1 --phrase x")).contains("not both"));
        assert!(fails(&format!("frame {ID} --at-ms 1 --occurrence 2")).contains("--phrase"));
        assert!(
            fails(&format!("frame {ID} --phrase x --occurrence 0")).contains("positive integer")
        );
        assert!(fails(&format!("frame {ID} --at-ms 1 --max-width 0")).contains("positive integer"));
        assert!(fails(&format!("frames {ID}")).contains("Missing --at-ms or --per-segment"));
        assert!(fails(&format!("frames {ID} --at-ms 1 --per-segment")).contains("not both"));
        assert!(fails(&format!("frames {ID} --at-ms 1,,2")).contains("comma-separated"));
        assert!(fails(&format!("transcript {ID} --json --segments")).contains("not both"));
        assert!(fails(&format!("moments {ID} --max-width 5")).contains("need --frames"));
        assert!(fails(&format!("clip {ID} --start-ms 1")).contains("Missing --end-ms"));
        assert!(fails("record --source s --seconds 0").contains("between 1 and 3600"));
        assert!(fails("record --seconds 5").contains("Missing --source"));
    }

    #[test]
    fn formats_times_with_hours_only_from_one_hour() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(4_999), "0:04");
        assert_eq!(clock(134_000), "2:14");
        assert_eq!(clock(3_599_999), "59:59");
        assert_eq!(clock(3_600_000), "1:00:00");
        assert_eq!(clock(3_723_000), "1:02:03");
        assert_eq!(stamp(4_290), "00:04");
        assert_eq!(stamp(754_000), "12:34");
        assert_eq!(stamp(3_599_999), "59:59");
        assert_eq!(stamp(3_600_000), "1:00:00");
        assert_eq!(stamp(36_005_000), "10:00:05");
    }

    fn word(text: &str, start_ms: u64, seek_ms: Option<u64>) -> Word {
        Word {
            text: text.into(),
            start_ms,
            end_ms: start_ms + 200,
            seek_ms,
        }
    }
    fn segment(id: &str, start_ms: u64, text: &str) -> Segment {
        let words = text
            .split_whitespace()
            .enumerate()
            .map(|(i, w)| word(w, start_ms + 250 * i as u64, None))
            .collect::<Vec<_>>();
        Segment {
            id: id.into(),
            start_ms,
            end_ms: start_ms + 250 * words.len() as u64,
            text: format!(" {text}"),
            words,
        }
    }

    #[test]
    fn segments_use_seek_points_and_take_dividers() {
        let mut first = segment("segment-0", 1_000, "Open the library.");
        first.words[0].seek_ms = Some(1_220);
        let transcript = Transcript {
            segments: vec![
                first,
                segment("segment-1", 4_290, "When I click here,   the panel stays."),
                segment("t2-segment-0", 134_500, "Take two starts here."),
                segment("t3-segment-0", 3_725_000, "An hour in."),
            ],
            takes: vec![
                TakeMark {
                    index: 1,
                    start_ms: 0,
                },
                TakeMark {
                    index: 2,
                    start_ms: 134_000,
                },
                TakeMark {
                    index: 3,
                    start_ms: 3_723_000,
                },
                TakeMark {
                    index: 4,
                    start_ms: 3_730_000,
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            format_segments(&transcript),
            "── Take 1 · 0:00 ──\n\
             [00:01 | 1220] Open the library.\n\
             [00:04 | 4290] When I click here, the panel stays.\n\
             ── Take 2 · 2:14 ──\n\
             [02:14 | 134500] Take two starts here.\n\
             ── Take 3 · 1:02:03 ──\n\
             [1:02:05 | 3725000] An hour in.\n\
             ── Take 4 · 1:02:10 ──\n"
        );
        // Single-take sessions have no marks and no dividers.
        let single = Transcript {
            segments: vec![segment("segment-0", 0, "")],
            ..Default::default()
        };
        assert_eq!(format_segments(&single), "[00:00 | 0]\n");
        assert_eq!(format_segments(&Transcript::default()), "");
    }

    fn terms(text: &str) -> Vec<String> {
        let transcript = Transcript {
            segments: vec![segment("s", 0, text)],
            ..Default::default()
        };
        deictic_matches(&transcript)
            .into_iter()
            .map(|m| m.term)
            .collect()
    }

    #[test]
    fn deictic_matcher_finds_pointing_words() {
        assert_eq!(terms("When I click Here, the panel stays."), ["here"]);
        assert_eq!(
            terms("Move this button over there."),
            ["this", "over there"]
        );
        assert_eq!(
            terms("Look at this. Then look at the menu"),
            ["look at this", "look at"]
        );
        assert_eq!(
            terms("Put it right here, not there."),
            ["right here", "there"]
        );
        assert_eq!(terms("These icons and those labels"), ["these", "those"]);
        assert_eq!(terms("Click that. Then that one"), ["that", "that"]);
        assert_eq!(terms("You can see this flicker"), ["see this"]);
        assert_eq!(terms("over here"), ["over here"]);
        // Matched words map back to word indices.
        let transcript = Transcript {
            segments: vec![
                segment("a", 0, "fine"),
                segment("b", 500, "so - look at that"),
            ],
            ..Default::default()
        };
        assert_eq!(
            deictic_matches(&transcript),
            [Deictic {
                segment: 1,
                first: 2,
                last: 4,
                term: "look at that".into()
            }]
        );
    }

    #[test]
    fn deictic_matcher_skips_common_non_pointing_uses() {
        assert!(terms("I think that it works").is_empty());
        assert!(terms("Make sure that the panel updates").is_empty());
        assert!(terms("so that we can ship").is_empty());
        assert!(terms("The button that you clicked").is_empty());
        assert!(terms("There is a delay and there were errors").is_empty());
        assert!(terms("this time it worked this week").is_empty());
        assert!(terms("I see, let me see if it loads").is_empty());
        assert!(terms("Hi there").is_empty());
        assert!(terms("Nothing points anywhere").is_empty());
        // Punctuation separates clauses, so context does not leak across it.
        assert_eq!(terms("I think, that one"), ["that"]);
        assert_eq!(terms("Over there."), ["over there"]);
    }
}
