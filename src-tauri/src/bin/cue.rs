use cuereview_lib::{
    agent, capture,
    cli::{self, Command, Invocation, TranscriptFormat},
    cursor, deps,
    models::CaptureConfig,
    store::{data_root, Store},
    transcribe,
};
use std::time::Duration;
fn print_json(value: &impl serde::Serialize) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
    );
    Ok(())
}
fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    // Help and argument errors come first: they never open the store or take the lock.
    let command = match cli::parse(&args)? {
        Invocation::Help(text) => {
            print!("{text}");
            return Ok(());
        }
        Invocation::Run(command) => command,
    };
    let store = Store::open(data_root())?;
    let _ownership = if command.needs_ownership() {
        Some(store.acquire_ownership()?)
    } else {
        None
    };
    match command {
        Command::Projects => print_json(&store.projects()?),
        Command::Sessions { project } => print_json(&store.sessions(project.as_deref())?),
        Command::Info { id } => print_json(&store.session(&id)?),
        Command::Transcript { id, format } => {
            let t = store.transcript(&id)?;
            match format {
                TranscriptFormat::Text => {
                    for s in t.segments {
                        println!("{}", s.text);
                    }
                    Ok(())
                }
                TranscriptFormat::Segments => {
                    if t.segments.is_empty() {
                        eprintln!(
                            "No transcript segments (status: {}).",
                            t.status.as_deref().unwrap_or("none")
                        );
                    }
                    print!("{}", cli::format_segments(&t));
                    Ok(())
                }
                TranscriptFormat::Json => match cursor::load(&store, &id) {
                    Some(track) => print_json(&agent::transcript_with_cursor(&t, &track)),
                    None => print_json(&t),
                },
            }
        }
        Command::Find { id, phrase } => print_json(&agent::find_with_cursor(&store, &id, &phrase)?),
        Command::Frame {
            id,
            at,
            output,
            style,
        } => print_json(&agent::frame_at(
            &store,
            &id,
            &at,
            output.as_deref(),
            style,
        )?),
        Command::Frames {
            id,
            times,
            output_dir,
            style,
        } => print_json(&agent::frames(
            &store,
            &id,
            &times,
            output_dir.as_deref(),
            style,
        )?),
        Command::Clip {
            id,
            start_ms,
            end_ms,
            output,
        } => {
            let path = agent::clip(&store, &id, start_ms, end_ms, output.as_deref())?;
            print_json(&serde_json::json!({"path":path}))
        }
        Command::Rename { id, name } => print_json(&store.rename_session(&id, &name)?),
        Command::Moments { id, frames, style } => {
            print_json(&agent::moments(&store, &id, frames, style)?)
        }
        Command::Setup { install } => print_json(&if install {
            deps::install_transcription()?
        } else {
            deps::setup_status()
        }),
        Command::Sources => print_json(&capture::sources()?),
        Command::Microphones => print_json(&capture::microphones()?),
        Command::Transcribe { id } => print_json(&agent::transcribe_existing(&store, &id)?),
        Command::Record {
            project,
            source,
            seconds,
            mic,
            system_audio,
            name,
        } => {
            let config = CaptureConfig {
                source_id: source,
                microphone_id: mic,
                system_audio,
                fps: 30,
            };
            let mut session = store.create_session(project.as_deref(), name.as_deref(), &config)?;
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
    }
}
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
