# Design: Transcribe a take while it is recorded and refine it after Stop

## Context

The live worker (`live_transcription` in `src-tauri/src/lib.rs`) copies the last 30 s of the take's
live audio track (`ActiveCapture::snapshot_audio`, `mic.wav` or `system.wav`) every 8 s after the
previous inference, runs `transcribe::transcribe_snapshot` with base, and merges the words into the
provisional live transcript (`transcribe::merge_live`). After Stop, `finish_transcription` or
`finish_takes` call `transcribe::transcribe` / `transcribe_take`, which run `transcribe_media` on the
whole take folder: `mic.wav`, else `audio.wav`, else `video.mp4`, gated by the Silero detector. The
stop and take flow (`run_take`, `finish_takes`) belongs to the take-videos work and stays as it is.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Where a stretch ends | Silero regions of the pending audio (`whisper-vad-speech-segments`, already bundled, padded 100 ms): once 28 s wait, 300 ms into the last pause of ≥ 600 ms between 10 and 30 s; past 30 s, the middle of the longest gap ≥ 200 ms in the first 30 s, else 30 s; 28 s without speech skipped but their last second | energy threshold in Rust: noisier rooms cut mid-word; fixed 30 s windows: cut words in half, which caused the old seams | whisper.cpp `examples/vad-speech-segments`; Silero VAD |
| Audio of a stretch | the live track itself, from the end of the last stretch (`snapshot_audio_from(start_ms)`), at most 60 s, converted to 16 kHz by FFmpeg as before | the last 30 s: drops speech when a cycle is slow | `capture.rs` `snapshot_track` |
| Model of a stretch | the language's model (`deps::final_model`), the final decoding options, live threads | base: the final words would be base's | speech-models |
| Words still being heard | base with one beam and no alignment points on the audio after the last stretch, every second, shown before stretches are finished | the language's model: about three times slower per guess | measurements in speech-models |
| Live transcript | stretches' words (final) then one segment of guessed words with an id starting `live-`; the app shows `live-` segments greyed in the live box | a `provisional` field on every segment: changes 22 struct literals and the transcript format for a live-only state | — |
| Saved stretches | `<take folder>/stretches/stretches.json` (`version`, `source` file name, `model` file name, `language`, `untilMs`, take-relative segments) and each stretch's raw Whisper JSON beside it, written atomically after every stretch | keeping them in memory only: Stop would redo the take after any restart of the worker | `store::atomic_write` |
| Using them at Stop | `transcribe_media` reuses them when `source` is the file it would read (`mic.wav`, or `system.wav` when the take has no microphone, which it then reads instead of `audio.wav`), and `model` and `language` match; it transcribes only from `untilMs` (FFmpeg `-ss`), shifts those words, and joins | trusting them always: a changed model or language would mix two models in one transcript | — |
| Retry, `cue transcribe` | delete the take's `stretches.json` first, so the whole take is transcribed | a flag through `transcribe_take`: touches the take flow's signatures | — |
| Refining after Stop | after the Stop job, a background thread transcribes each take made from stretches whole (cancellable), replaces its words and forgets the stretches; `transcriptRevision` in the recording status tells the app to read the transcript again; a recording, Retry or a delete stops it | keeping the transcript from stretches: about 4 points more word errors (replays of take 3); a whole-take pass at Stop: 23 s of waiting for 5 minutes | proposal.md measurements |
| The old live path | the live worker no longer uses `transcribe::merge_live`, `transcribe_snapshot` or the 30 s `snapshot_audio`; they stay for the ignored Whisper tests, which check the speech gate and alignment on base through them; guesses go through `guess_words` | deleting them: those tests check the gate and alignment that `transcribe_media` still relies on | — |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | new `src-tauri/src/stretches.rs` (cuts, saving, loading, joining); `capture.rs` (`snapshot_audio_from`); `transcribe.rs` (VAD regions, `transcribe_media` reusing stretches); `lib.rs` (the live worker, Retry); `agent.rs` (`cue transcribe` forgets stretches); `src/workspace/TranscriptPane.tsx`, `transcript.css`, `types.ts`; README.md, docs/ARCHITECTURE.md (the live transcription paragraph), docs/VERIFICATION.md |
| Formats and contracts | `stretches/stretches.json` is new and internal; the saved transcript format is unchanged; live segments with ids starting `live-` are the guessed words |
| Storage | `stretches/` in each take folder, a few KB per stretch; kept like the raw `whisper.json` |

## Test plan

| Scenario or logic | Test |
|---|---|
| A take made from stretches refined once | `src-tauri/src/transcribe.rs::tests::stop_s_stretches_are_refined_by_a_whole_take_pass`, unit; `src/App.test.tsx::reads the open transcript again once it is refined after Stop` |
| Cuts at pauses, the 30 s limit, the longest gap | `src-tauri/src/stretches.rs::tests::cuts_at_pauses_and_never_past_thirty_seconds`, unit |
| Every spoken word appears once | `src-tauri/src/stretches.rs::tests::stretches_join_without_gaps_or_overlaps`, unit; `actual_replay_matches_a_whole_take_pass`, ignored |
| Retry / a take without live audio | `src-tauri/src/stretches.rs::tests::saved_stretches_are_used_only_when_they_match`, unit |
| The transcript is ready seconds after Stop | `src-tauri/src/stretches.rs::tests::actual_replay_finishes_within_seconds_of_stop`, ignored: take 4 of the review fed in real time |
| Live words follow the speaker | `src-tauri/src/stretches.rs::tests::actual_replay_shows_words_within_seconds`, ignored |
| VAD regions parsed | `src-tauri/src/transcribe.rs::tests::detector_regions_are_read_in_milliseconds`, unit |
| Words still being heard are greyed in the live box | `src/workspace/TranscriptPane.test.tsx::shows finished stretches as rows and greys only the words still being heard` |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| The transcript is ready seconds after Stop | desk | Record a few minutes with the microphone, stop: the transcript is there within about 5 s |
| Live words follow the speaker | desk | While speaking, words appear about two seconds later; finished sentences stop changing |
| Words still being heard are greyed in the live box | desk | Only the newest words sit greyed in the box; earlier ones are plain rows |

## Risks

- CPU while recording: a stretch takes about 2.5 s with small.en and 4 threads on the reference PC,
  and a guess about 0.5–1 s with base; slower PCs see slower live words, never lost ones, since the
  pending audio grows until it is cut. The replay test measures it.
- A take that ends mid-sentence leaves up to 30 s for Stop; on the reference PC that is about 2.5 s.
- If the live worker fails, the take is transcribed whole after Stop, as before.
- The refinement holds the inference lock for about 30 s per 5 minutes of a take; a recording starting meanwhile cancels it (the whisper process is killed within 0.1 s), so its live words wait at most that long.

Approved by the owner as first drawn (Q18); the refinement, the stretch lengths and the guess settings were added on measurements while the owner was away (proposal.md, Calls for the owner).
