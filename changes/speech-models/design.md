# Design: Transcribe with the small model of the chosen language

## Context

`deps.rs` knows one speech model, `ggml-base.bin`, installed by Install transcription (or
`cue setup --install`) and checked by its exact size; `transcribe.rs` runs it with `-l auto` and
the `base` alignment preset, and `settings.rs` builds the decoding options from `settings.json`,
which today holds only the vocabulary. The app (`lib.rs`) and `cue` share all three. Settings
(`src/dialogs/SettingsDialog.tsx`) reads `get_setup_status` and `get_settings`.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Where the language lives | `settings.json` `language`: `"en"` or `"de"`, absent meaning English | a per-recording field: Q10 chose app-wide; a new file: settings are already shared by app and CLI | Q10 |
| The models | A table in `deps.rs`: base, small.en, small, each with its file, pinned URL at revision `5359861c`, size and SHA-256; English → small.en, German → small | `resolve/main` URLs: an unpinned model could change under the same name; medium for German: Q12 | huggingface.co/ggerganov/whisper.cpp (X-Linked-Size and X-Linked-ETag of each file) |
| Which model transcribes | The language's model when installed (exact size), else base; `CUEREVIEW_MODEL` still wins | Refusing to transcribe until the download ends: Q9 says base keeps working | Q9 |
| Holding the language | `-l en` or `-l de` replaces `-l auto` in every final and live run | auto-detection: it can switch language per recording or per live snapshot | whisper.cpp `examples/cli/cli.cpp` (`-l`) |
| Alignment preset | The model's own (`base`, `small.en`, `small`) | always `base`: DTW heads differ per model, so word seek points would be wrong | whisper.cpp `whisper.h` alignment heads presets |
| Live words | base, held to the language | small: about twice as long per update; `one-pass-transcription` revisits it | measurements in proposal.md |
| Download | One background thread (`deps::start_language_model_download`, which runs `fetch_loop`), started at app start, after Install transcription, when a saved language changes and on Try again; a running download whose language is no longer chosen stops and the loop fetches the chosen one; streams to `<file>.download`, checks size and SHA-256, then renames; a failure deletes the partial file and records the error | resuming partial downloads: more code for a rare case; a download per transcription: blocks Stop | `reqwest` blocking client, already used by `download` |
| Progress to the UI | `SetupStatus.languageModel { language, model, state: ready / downloading / failed / missing, receivedBytes, totalBytes, error }`; Settings polls `get_setup_status` each second while it is `downloading`; `download_language_model` command for Try again (refused, with the reason, before Install transcription); a light `get_language_model` for polling, each poll after the previous reply | events from Rust: the dialog already reads setup status by command | Tauri commands as in `lib.rs` |
| The vocabulary's token probe | counts with the model that will transcribe | base always: small.en's tokenizer differs, so the count could be off | `settings.rs` module notes |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `src-tauri/src/deps.rs`, `settings.rs`, `models.rs`, `transcribe.rs`, `lib.rs`, `cli.rs`; `src/backend.ts`, `src/dialogs/SettingsDialog.tsx` and `.css`, its test and story, `src/stories/backend.fixture.ts`; README.md (Install transcription, Settings), docs/ARCHITECTURE.md (Local transcription), docs/DESIGN.md (Settings dialog) |
| Formats and contracts | `settings.json` gains optional `language`; older files read as English. `cue setup` JSON gains `languageModel`; consumers only gain a field |
| Storage | `<root>/models/ggml-small.en.bin` (487,614,201 bytes) and, when German is chosen, `ggml-small.bin` (487,601,967 bytes); base stays. Nothing is removed; existing transcripts are untouched |

## Test plan

| Scenario or logic | Test |
|---|---|
| English is the default | `src-tauri/src/deps.rs::tests::english_uses_small_en_by_default`, new; `src-tauri/src/settings.rs::tests::decoding_is_held_to_the_chosen_language`, new |
| Choosing German transcribes German speech | `src-tauri/src/deps.rs::tests::german_uses_the_multilingual_small_model`, new |
| An upgraded app fetches the English model by itself | `src-tauri/src/deps.rs::tests::a_missing_language_model_falls_back_to_base`, new |
| Choosing German fetches the German model | `src/dialogs/SettingsDialog.test.tsx::shows the language model's download progress`, new |
| A damaged download is never used | `src-tauri/src/deps.rs::tests::a_damaged_model_download_is_discarded`, new (a local one-shot HTTP server serves wrong bytes); `src/dialogs/SettingsDialog.test.tsx::offers to retry a failed model download`, new |
| The model is ready | `src/dialogs/SettingsDialog.test.tsx::shows the chosen language and its ready model`, new |
| Settings round trip with `language` | `src-tauri/src/settings.rs::tests` round trip, extended |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| An upgraded app fetches the English model by itself | desk | Install the release over 0.2.0, open Settings: the English model downloads; record after it finishes: "font size", "take three" come out right |
| Choosing German transcribes German speech | desk | Choose German, wait for the model, record a short German review: German words, no English translation |
| Choosing German fetches the German model | desk | Settings shows the German model's progress, then Ready |
| The model is ready | desk | Settings shows Language and "English model ✓ Ready" |

## Risks

- A 488 MB download on a slow or metered connection: it runs once, in the background, and base keeps
  working; Settings shows its size. We notice through a `failed` state.
- small.en is about 2.5 times slower than base: with the AVX2 runtime, 23 s for five minutes on
  the owner's PC; `one-pass-transcription` removes the wait after Stop.
- German quality is unmeasured (no German recording): the `desk` check on German covers it.
