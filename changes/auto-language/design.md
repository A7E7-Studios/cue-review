# Design: Detect each take's language instead of assuming English

## Context

`settings.rs` holds every transcription to one language, `settings.json` `language`: `"de"`, or
English when absent (`language()`, `decoding_args`). `deps.rs` maps it to a model (`language_model`:
small.en or small, base while that is missing) and downloads that one model in the background
(`fetch_loop`). The live worker (`lib.rs` `live_transcription`) reads the language once per take,
cuts the take into stretches (`stretches.rs`), transcribes each with the language's model and keeps
`model` and `language` in `stretches.json`, so Stop reuses them only when both still match
(`stretches::usable`). Whole-take passes (`transcribe_media_with`: Stop without stretches, Retry,
`cue transcribe`, the refine pass) read the language from the settings again. `Transcript.language`
already exists and carries what Whisper reported.

The constraint: `whisper-cli` is a child process per run and detects a language only from the
first 30 s of the file it is given, printing the top language and its probability.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Where the choice lives | `settings.json` `language`: absent means Auto; one of the speech model's 100 codes means that language, `"en"` now written too. An unknown code reads as Auto and is dropped on save | A separate `auto` flag: two fields that can disagree; keeping "absent = English": an explicit English could not be told from never having chosen | Q1, Q9 |
| The language list | One table in `settings.rs`: the 100 codes and English names of whisper.cpp's `g_lang` at the pinned revision, served to the app by a `get_languages` command | A second copy in TypeScript: two lists that drift; asking `whisper-cli` at run time: it has no list command | whisper.cpp `src/whisper.cpp` `g_lang` at `d1be6fde` (https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037) |
| How a language is detected | `whisper-cli -m ggml-base.bin -f <speech> -dl -ng`, reading `auto-detected language: xx (p = n)` from its log; 0.6 s for 30 s of speech on the reference PC | The small multilingual model: more accurate but not installed until its download ends; `-l auto` on the transcribing run: English would never get small.en, and every stretch would detect anew | whisper.cpp `examples/cli/cli.cpp` (`-dl`), `whisper_lang_auto_detect` |
| When a take's language is decided | By the first stretch whose top language has p >= 0.9. On every stretch of the German recording, as if a take started there: 0 of 436 wrong on the microphone, 5 of 436 on the system audio (some of them real English), decided at the first stretch in the median and by the seventh at the latest | p >= 0.8: 2.3 % and 5.5 % wrong; two stretches in a row at 0.8: the same errors, one stretch later; detecting per stretch without holding: 12 % and 16 % of stretches in the wrong language; faster-whisper's default 0.5: too weak for a decision that holds for the whole take | faster-whisper `language_detection_threshold`, `language_detection_segments` (https://github.com/SYSTRAN/faster-whisper); Azure at-start language identification (https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification); measurement in `proposal.md` |
| Stretches before the decision | Each is transcribed in its own top guess and marked provisional. Once the take is decided, provisional stretches made in another language are transcribed again from the take's audio, before newer ones. A take that stops undecided takes the language with the largest summed probability, and Stop redoes its other provisional stretches | Holding stretches back until the decision: no words on screen for up to seven stretches; never redoing them: the start of a take stays in the wrong language, which "An unclear start does not decide the language" forbids | - |
| Whole-take passes | Stop without usable stretches, Retry and `cue transcribe` detect first: up to three windows of 30 s of speech-only audio, cut by the speech regions the pass already computes, with the same rule and fallback. The refine pass keeps the language its stretches decided | Detecting on the first 30 s of the file: a quiet or noisy start decides; one window only: the fallback would rest on a single guess | whisper.cpp `whisper-vad-speech-segments` |
| The model of a language | `"en"`: small.en; every other code: the multilingual small model held to it; base, which is multilingual, while that model is missing. The alignment preset follows the model | The multilingual model for English too: 9.9 % against 5.8 % word errors | Q8; `changes/speech-models` measurement |
| Live words | base held to the decided language; `-l auto` until the take is decided | Waiting for the decision: nothing shown for the first seconds | - |
| Downloads | The models a choice needs, in order: Auto small.en then small; English small.en; any other language small. `fetch_loop` walks that list, and a changed choice still stops a download nothing needs any more | Both in parallel: twice the bandwidth while recording; the multilingual model first: English, the common case, would wait | - |
| Model state to the UI and `cue setup` | `SetupStatus.languageModels`: one `{ model, state, receivedBytes, totalBytes, error }` per needed model, replacing `languageModel`; `get_language_models` replaces the light poll | Keeping `languageModel` for the first model only: Settings could not show the second | - |
| The language of a transcript | `Transcript.languageDetected` beside the existing `language`; in a session with takes each `TakeMark` gains `language` and `languageDetected`. `stretches.json` version 2 adds the decision and each stretch's guess; version 1 files are not reused | A session-level language only: "Each take has its own language" needs it per take | - |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `src-tauri/src/settings.rs`, `deps.rs`, `models.rs`, `transcribe.rs`, `stretches.rs`, `lib.rs`, `takes.rs`, `agent.rs`, `cli.rs`, `bin/cue.rs`; `src/backend.ts`, `src/dialogs/SettingsDialog.tsx`, `src/workspace/TranscriptPane.tsx` and `types.ts`, their tests and stories, `src/stories/backend.fixture.ts`; README.md (Settings, `cue setup`), docs/ARCHITECTURE.md (Local transcription), docs/DESIGN.md (Settings dialog, transcript), docs/VERIFICATION.md (the new ignored tests) |
| Formats and contracts | `settings.json`: absent `language` now means Auto, `"en"` is stored. `transcript.json`: optional `languageDetected`, and `language`, `languageDetected` on each take mark; older files read as before. `stretches.json` version 2. `cue setup` JSON: `languageModels` (a list) replaces `languageModel`. `cue transcript` JSON gains the same fields as `transcript.json` |
| Storage | `<root>/models/ggml-small.bin` (487,601,967 bytes) beside small.en under Auto. Existing transcripts stay as they are until Retry or `cue transcribe` |

## Test plan

| Scenario or logic | Test |
|---|---|
| A German take is transcribed as German without a setting | `src-tauri/src/settings.rs::tests::a_take_is_held_to_its_detected_language`, new; `src-tauri/src/transcribe.rs::tests::actual_german_speech_is_detected_and_transcribed_as_german`, new, ignored (needs the runtime, the models and a German sample) |
| An English take stays on small.en | `src-tauri/src/deps.rs::tests::english_uses_small_en_and_every_other_language_the_multilingual_model`, replaces the two per-language tests |
| A take keeps the language it started in | `src-tauri/src/stretches.rs::tests::a_detected_language_is_kept_for_the_rest_of_the_take`, new |
| An unclear start does not decide the language | `src-tauri/src/stretches.rs::tests::an_unconfident_guess_waits_for_more_speech`, `::a_take_without_a_confident_guess_uses_the_likeliest_language`, new |
| Each take has its own language | `src-tauri/src/transcribe.rs::tests::each_take_is_detected_on_its_own`, new |
| A chosen language is used without detecting | `src-tauri/src/settings.rs::tests::a_chosen_language_is_used_without_detecting`, replaces `decoding_is_held_to_the_chosen_language` |
| Transcribing again detects the language again | `src-tauri/src/agent.rs::tests::transcribing_again_detects_the_language_again`, new |
| An upgraded app fetches the models by itself | `src-tauri/src/deps.rs::tests::auto_fetches_both_small_models_english_first`, new; `::a_missing_language_model_falls_back_to_base`, existing |
| The models are ready; Settings offers Auto and every language | `src/dialogs/SettingsDialog.test.tsx`, two new tests; `src-tauri/src/settings.rs::tests::every_language_of_the_speech_model_can_be_chosen`, new |
| The transcript names a detected language | `src/workspace/TranscriptPane.test.tsx::names each take's language and whether it was detected`, new |
| An agent reads each take's language | `src-tauri/src/agent.rs::tests::the_transcript_reports_each_take_s_language`, new |
| The detection log line is parsed, a missing line is no decision | `src-tauri/src/transcribe.rs::tests::the_detected_language_is_read_from_the_log`, unit test |
| The decision rule on recorded guesses | `src-tauri/src/stretches.rs::tests`, unit tests on sequences of (language, p) |
| `settings.json` round trip: absent, `"en"`, `"de"`, another code, an unknown code | `src-tauri/src/settings.rs::tests`, extended |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| A German take is transcribed as German without a setting | desk | With Auto, record a short German review: German words while recording and after Stop |
| Each take has its own language | desk | Record more in English after a German take: the first stays German, the new take is English |
| A chosen language is used without detecting | desk | Choose a language in Settings, record in another: the transcript is in the chosen one |
| Transcribing again detects the language again | desk | Run `cue transcribe` on the German recording that came out English: it reads as German |
| An upgraded app fetches the models by itself; The models are ready; Settings offers Auto and every language | desk | Install over 0.3.0, open Settings: Auto is chosen, the missing model downloads, then both read Ready; the list offers every language |
| The transcript names a detected language | desk | The German take is marked "German, detected" |

## Risks

- A wrong decision holds for the whole take. The threshold rests on one German recording; no
  recording in a third language was measured. The transcript names the language, so a wrong one
  shows at once, and a fixed language with Retry repairs it.
- Base misreads German with many English terms as English, on this recording with p up to 0.89 on
  the microphone and 0.95 on the system audio; 0.9 keeps most of it out, not all.
- English really spoken inside a German take (an assistant's voice in the measured recording) is
  transcribed as German until `language-switches`.
- Languages other than English and German run on the small model without any measurement of their
  quality here.
- Each undecided stretch costs one more `whisper-cli` run of about 0.6 s, and a redone provisional
  stretch one more transcription; both happen at the start of a take only.
