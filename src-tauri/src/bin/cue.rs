use cuereview_lib::{
    agent, capture, deps,
    models::CaptureConfig,
    store::{data_root, Store},
    transcribe,
};
use std::{path::Path, time::Duration};
const HELP:&str="CueReview — local agent access\n\ncue projects\ncue sessions [PROJECT_ID]\ncue info SESSION_ID\ncue transcript SESSION_ID [--json]\ncue find SESSION_ID --phrase TEXT\ncue frame SESSION_ID (--at-ms N | --phrase TEXT [--occurrence N]) [--output PATH]\ncue clip SESSION_ID --start-ms N --end-ms N [--output PATH]\ncue transcribe SESSION_ID\ncue setup [--install]\ncue sources\ncue microphones\ncue record [--project ID] --source ID --seconds N [--mic ID] [--system-audio] [--name TEXT]\n\nAll times are milliseconds. Frame/clip output is JSON with a local path.\nCUEREVIEW_DATA_DIR overrides the shared local storage root.\nNo network access is used except explicit setup --install.\n";
fn option<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == key)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}
fn required<'a>(args: &'a [String], key: &str) -> Result<&'a str, String> {
    option(args, key).ok_or_else(|| format!("Missing {key}"))
}
fn number(args: &[String], key: &str) -> Result<u64, String> {
    required(args, key)?
        .parse()
        .map_err(|_| format!("{key} must be a non-negative integer."))
}
fn print_json(value: &impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else {
        print!("{HELP}");
        return Ok(());
    };
    if matches!(cmd, "help" | "--help" | "-h") {
        print!("{HELP}");
        return Ok(());
    }
    let store = Store::open(data_root())?;
    let id = args.get(1).map(String::as_str).unwrap_or("");
    match cmd {
        "projects" => print_json(&store.projects()?),
        "sessions" => print_json(&store.sessions((!id.is_empty()).then_some(id))?),
        "info" => print_json(&store.session(id)?),
        "transcript" => {
            let t = store.transcript(id)?;
            if args.iter().any(|a| a == "--json") {
                print_json(&t)
            } else {
                for s in t.segments {
                    println!("{}", s.text);
                }
                Ok(())
            }
        }
        "find" => print_json(&agent::find(
            &store.transcript(id)?,
            required(&args, "--phrase")?,
        )?),
        "frame" => {
            let at = if let Some(phrase) = option(&args, "--phrase") {
                let matches = agent::find(&store.transcript(id)?, phrase)?;
                let occurrence = option(&args, "--occurrence")
                    .unwrap_or("1")
                    .parse::<usize>()
                    .map_err(|_| "Occurrence must be a positive integer.")?;
                let matched = matches
                    .iter()
                    .find(|m| m.occurrence == occurrence)
                    .ok_or("Phrase occurrence was not found.")?;
                matched.seek_ms.unwrap_or(matched.start_ms)
            } else {
                number(&args, "--at-ms")?
            };
            let path = agent::frame(&store, id, at, option(&args, "--output").map(Path::new))?;
            print_json(&serde_json::json!({"path":path,"timeMs":at}))
        }
        "clip" => {
            let path = agent::clip(
                &store,
                id,
                number(&args, "--start-ms")?,
                number(&args, "--end-ms")?,
                option(&args, "--output").map(Path::new),
            )?;
            print_json(&serde_json::json!({"path":path}))
        }
        "setup" => print_json(&if args.iter().any(|a| a == "--install") {
            deps::install_transcription()?
        } else {
            deps::setup_status()
        }),
        "sources" => print_json(&capture::sources()?),
        "microphones" => print_json(&capture::microphones()?),
        "transcribe" => print_json(&agent::transcribe_existing(&store, id)?),
        "record" => {
            let seconds = number(&args, "--seconds")?;
            if !(1..=3600).contains(&seconds) {
                return Err("Use --seconds between 1 and 3600.".into());
            }
            let config = CaptureConfig {
                source_id: required(&args, "--source")?.into(),
                microphone_id: option(&args, "--mic").map(str::to_owned),
                system_audio: args.iter().any(|a| a == "--system-audio"),
                fps: 30,
            };
            let mut session = store.create_session(
                option(&args, "--project"),
                option(&args, "--name"),
                &config,
            )?;
            let result = (|| {
                let mut active = capture::start(config, &store.session_dir(&session.id)?)?;
                std::thread::sleep(Duration::from_secs(seconds));
                let stopped = active.stop();
                session.duration_ms = active.elapsed_ms();
                // Source loss may report an error after successfully finalizing usable video.
                let video = cuereview_lib::attach_finished_video(&store, &mut session);
                stopped.and(video)?;
                session.status = "processing".into();
                store.save_session(&session)?;
                let transcript = transcribe::transcribe(&store, &session.id)?;
                Store::apply_auto_title(&mut session, &transcript);
                Ok::<(), String>(())
            })();
            session.status = if result.is_ok() { "ready" } else { "error" }.into();
            session.error = result.as_ref().err().cloned();
            store.save_session(&session)?;
            print_json(&session)?;
            result
        }
        _ => Err(format!("Unknown command {cmd}. Run cue --help.")),
    }
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
