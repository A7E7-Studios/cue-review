# Design: Transcribe the system audio beside the microphone

## Context

A take writes `mic.wav` and `system.wav` (`capture.rs`), but only one of them reaches the
transcript: the live worker (`lib.rs` `live_transcription`) copies the capture's single
`snapshot_source`, the microphone when there is one, cuts it into stretches (`stretches.rs`) and
transcribes them; whole-take passes (`transcribe.rs` `transcribe_media_in`, through `media_source`)
read `mic.wav` when it exists. Each take's language is detected and held per take
(`Stretches` version 2, `detect_take_language`), and the transcript carries it on the transcript
and on each take mark. A `Segment` has no notion of where it was heard.

The constraint that shapes the design: the two tracks share a clock, and the loudspeakers reach
the microphone 80 to 176 ms late, about 20 dB below the system track and only about 7 dB below the
reviewer's own voice, so the echo has to be recognised from the audio before it is transcribed.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| What a two-track take is | A take with both `mic.wav` and `system.wav`. Each is cut into stretches, detected and transcribed on its own, with one stretches file per track; a take with one of them is transcribed exactly as today | One pass over `audio.wav`: the reviewer is about 13 dB below the call in the mix, and nothing says who spoke | Q5 |
| Live audio per track | The capture offers a copy of either track from a point (`snapshot_audio_from` takes the track); the live worker keeps one stretch state per track and serves the system track first each cycle, then the microphone, under the one inference lock | Two workers: they would contend for the lock and the processor without an order | Q15 |
| How echo is recognised | Per microphone speech region: the share of its 300 to 3400 Hz power that the system audio of the same span explains linearly (power-weighted coherence, 64 ms Welch segments, after a lag search from -50 to +500 ms). A region is echo when the system audio is above -45 dBFS in the span and that share is 0.4 or more. Regions under 1 s are scored on a 1.5 s window around them | Unweighted coherence: separates much worse; microphone level against the predicted echo level: drops 81 % of a headphone user's speech; matching the two transcripts' words: needs the echo transcribed first, which is what sends Whisper into repetition loops, and keeps about 930 garbled regions the audio rule drops | Measurement on the 2 h 31 min recording (below) |
| What happens to an echo region | It is silenced in the audio handed to Whisper and to the live guess, so it is never transcribed and the take's timing is untouched. A region with the reviewer's words and echo together scores below 0.4 and is kept whole | Dropping rows after transcription: pays for transcribing the echo and for its hallucinations ("Vielen Dank" 247 times on the measured recording) | - |
| The transform | The `rustfft` crate (pure Rust, MIT or Apache-2.0) at 16 kHz mono | A hand-written radix-2 FFT: about 60 lines of numeric code to own; no FFT, a 64-tap least-squares fit at 4 kHz: matches the result but needs a 64 by 64 solve per region | https://crates.io/crates/rustfft |
| Merging | Rows of both tracks are merged by start time, the system row first on a tie, and renumbered. A `Segment` gains `track`: `microphone` or `system`, absent in a one-track take and in transcripts made earlier | A speaker field with names: nothing tells the people on a call apart | Q5 |
| Languages | Each track keeps its own decision. The transcript and each take mark gain `trackLanguages` (per track: `language`, `languageDetected`); `language` stays, as the microphone's, for readers that know one language per take | One language per take: "The reviewer and the call speak different languages" forbids it | `auto-language` design |
| The live guess | The microphone's words still being heard are guessed every cycle, the system's every second cycle, each in its own live box on its side; silenced echo is never guessed | Both every cycle: the base model would run twice a second and push the microphone past the three seconds live transcription promises | `live-transcription` spec |
| Whole-take passes | Stop's remainder, Retry, `cue transcribe` and the refining pass run per track, the system track first; an earlier recording with both files gets both | Leaving earlier recordings on the microphone: the recording this change is for would stay half transcribed | Q19 |
| `cue transcript` | JSON rows carry `track`; the text and segment formats put `mic` or `system` after the time of each row of a two-track take | A separate command per track: an agent wants the conversation in order | - |
| The look | F as picked: system rows as today, microphone rows inset 48 px with a right-hand time gutter, the track tag on hover and focus, the track in each time button's accessible name, one live box per side, the two languages on their sides of the take line | - | `look.md` |

Measured on the recording, over all 2313 microphone speech regions, with labels made by comparing
each region's words on the two tracks (about 200 checked by eye):

| | Echo left in | Own speech lost | A headphone user's speech lost |
|---|---|---|---|
| Share 0.4 or more (chosen) | 12 of 1005 (1.2 %) | 9 of 275 by label, 0 by eye: all nine are garbled echo | 0.6 % |
| Share 0.5 or more | 1.6 % | the same nine | 0.2 % |
| Cross-correlation 0.3 or more at 4 kHz | 0.8 % | 12 of 275 | 1.0 to 1.7 % |

The first half of the recording against the second: 0.9 % and 1.5 % of echo left in. Every
headphone loss is a region shorter than 1.2 s. About eight of the twelve echo regions left in are
echo followed by the reviewer's reply, kept whole on purpose.

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `src-tauri/src/capture.rs` (a copy of either live track), `stretches.rs`, `transcribe.rs` (the echo gate, per-track passes, the merge), a new `src-tauri/src/echo.rs`, `lib.rs` (the live worker), `takes.rs`, `models.rs`, `agent.rs`, `cli.rs`, `bin/cue.rs`, `Cargo.toml` and `Cargo.lock` (`rustfft`); `src/backend.ts`, `src/review.ts`, `src/workspace/TranscriptPane.tsx` with its CSS, tests and stories; README.md (`cue transcript`, licences), docs/ARCHITECTURE.md (Local transcription), docs/DESIGN.md (transcript), docs/VERIFICATION.md |
| Formats and contracts | `transcript.json` and `cue transcript` JSON: optional `track` on a segment, optional `trackLanguages` on the transcript and on a take mark; files without them read as before. `cue transcript` text: `mic` or `system` after the time on rows of a two-track take. A stretches file per track in the take's `stretches` folder; earlier single files are still read for one-track takes |
| Storage | No new media. Existing transcripts stay as they are until Retry or `cue transcribe` |

## Test plan

| Scenario or logic | Test |
|---|---|
| The reviewer and the call are both in the transcript | `src-tauri/src/transcribe.rs::tests::a_take_with_two_tracks_is_transcribed_from_both`, `::rows_of_two_tracks_are_merged_by_time`, new |
| Both tracks are ready seconds after Stop | `src-tauri/src/stretches.rs::tests::actual_replay_of_two_tracks_finishes_within_seconds_of_stop`, new, ignored (needs a recorded two-track fixture) |
| A take with one track is transcribed as before | `src-tauri/src/transcribe.rs::tests::the_audio_a_take_is_transcribed_from`, existing, extended |
| The reviewer and the call speak different languages | `src-tauri/src/transcribe.rs::tests::each_track_is_detected_on_its_own`, new |
| An earlier recording gains the call on Retry | `src-tauri/src/agent.rs::tests::transcribing_again_reads_both_tracks`, new |
| Rows are marked as microphone or computer audio; A row names its track on demand | `src/workspace/TranscriptPane.test.tsx`, two new tests |
| An agent reads each row's track | `src-tauri/src/agent.rs::tests::the_transcript_reports_each_row_s_track`, new |
| A call played through speakers appears once | `src-tauri/src/transcribe.rs::tests::microphone_speech_that_matches_the_system_audio_is_left_out`, new; `::actual_speaker_echo_is_transcribed_once`, new, ignored (two installed voices: one as the call, the other as the reviewer with the first mixed in late and quiet) |
| The reviewer's own words are kept; A reviewer on headphones loses nothing | `src-tauri/src/transcribe.rs::tests::microphone_speech_without_a_match_is_kept`, new |
| The echo share on made-up signals: a late quiet filtered copy, unrelated audio, both together, a region under 1 s, a silent system track, a lag at each end of the search | `src-tauri/src/echo.rs::tests`, unit tests |
| Silencing regions keeps the audio's length and the other regions' samples | `src-tauri/src/echo.rs::tests`, unit test |
| The live worker's order: system first, the microphone's guess every cycle, the system's every second | `src-tauri/src/stretches.rs::tests`, unit test on the schedule |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| The reviewer and the call are both in the transcript; A call played through speakers appears once; The reviewer's own words are kept | desk | Record a short call over the loudspeakers and speak in the pauses: the call's words appear once on the left, yours on the right |
| A reviewer on headphones loses nothing | desk | The same on headphones, speaking over the call: both are there |
| Both tracks are ready seconds after Stop | desk | Stop after several minutes of a call: the transcript of both sides is there within seconds |
| The reviewer and the call speak different languages | desk | A German call with English remarks: the take line names German on the left and English on the right |
| An earlier recording gains the call on Retry | desk | `cue transcribe` on the German recording: the others' words are now clear, on the left |
| Rows are marked as microphone or computer audio; A row names its track on demand | desk | Hover and Tab through rows: the tag names the track and no text moves |

## Risks

- The rule rests on one recording, one room and one microphone. A louder room, a different delay
  or a microphone with its own echo cancellation may sit elsewhere; the delay search covers -50 to
  +500 ms, and the desk checks on loudspeakers and on headphones are the first other evidence.
- While recording, the two tracks are compared before the take's final resampling. If their clocks
  have drifted apart by more than the search covers, echo is left in until the pass after Stop,
  which compares the resampled files.
- Words the reviewer says exactly over the loudspeakers survive only when their region scores
  below 0.4; a short "yes" under a loud call can be lost. On the measured recording none was.
- Two tracks double the live work on a computer without a graphics card. Echo regions are never
  transcribed, which takes most of the microphone's work away during a call; the five seconds after
  Stop are measured by the ignored replay test, whose fixture has to be recorded first.
- `rustfft` is a new dependency: its licence joins the app's licence list.
