# Design: Transcribe on the graphics card where it is faster

## Context

The speech runtime is whisper.cpp at a pinned revision, built by `scripts/build-speech-runtime.mjs`
as a static `whisper-cli` and `whisper-vad-speech-segments` in two processor variants; `deps.rs`
picks the `avx2` one where the processor supports it. Every run passes `-ng` (`settings.rs`
`BASE_ARGS`), so nothing ever uses a graphics card. `deps.rs` holds the model table (base,
small.en, small) with pinned URLs and hashes, fetches what the language choice needs, and reports
it as `languageModels`. Each take picks its models once (`TakeModels`), and each stretch records
the model that made it.

The constraints: `whisper-cli` is a child process per run; a run that cannot use the card falls
back to the processor inside the same process and still exits with 0, so only its log tells; the
Vulkan build imports `vulkan-1.dll` directly and does not start where that is missing.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| The backend | Vulkan: one more static `whisper-cli` in a `vulkan` subfolder of the runtime, on Windows x64 only, with the processor flags of the `avx2` variant plus `-DGGML_VULKAN=ON`. Measured as fast as CUDA on the RTX 5090, and it used the AMD integrated chip too | CUDA: NVIDIA only and about 770 MB of libraries to ship; a build that loads backends at run time: more files to ship, and the static build did not show the feared silent fallback | Q17; whisper.cpp at `d1be6fde` (https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037); measurement in `proposal.md` |
| Building it | The build script adds the variant when the Vulkan SDK is present (`VULKAN_SDK`), with Ninja in a short build directory, because the shader sub-build exceeds Windows' 260-character paths under the repository; `--require-vulkan` makes its absence an error, which the build server passes. The speech detector is not built for it | The Visual Studio generator: fails on the path length; building the detector too: 48 MB for a tool that runs on the processor | measured on the owner's PC |
| The build server | The Windows job installs a pinned Vulkan SDK (version and SHA-256 in the workflow) before building the runtime | A third-party install action: one more party in the build; an unpinned download: a build that changes under us | https://vulkan.lunarg.com/doc/sdk/latest/windows/getting_started.html |
| The sample for measuring | whisper.cpp's own `samples/jfk.wav` (11 s of speech, public domain), copied into the runtime folder by the build script | A generated tone: it times the encoder but decodes no words; a clip of our own: something to record and license | whisper.cpp `samples/README.md` |
| Measuring | In the background, under the inference lock: the sample through the small multilingual model (small.en where only English is chosen, base before either is installed; only a small model's measurement offers the large model) on the processor build and on each graphics card the Vulkan build lists (`-dev N`), twice each, the second run counted, so the card's one-time warm-up (16 s here) is not. A run counts for a card only when its log shows that card's backend in use. The fastest wins; a tie goes to the processor | Trusting the card's kind: an integrated chip can be fast or, as measured, slower than the processor; timing the first run: it would rank a fast card below the processor | Q20 |
| When to measure | At start when no result is saved, or when the app's version, the runtime or the display adapters and their driver versions (from the registry's display class) differ from the saved ones; when it was made with base and a small model is now installed; once the large model is installed and waits to be timed; and when the person asks. A recording or a transcription that starts cancels it; it runs again at the next idle moment | Every start: seconds of card time for nothing; never again after the first: a driver update could not repair or break it | - |
| What runs on the card | Stretches, the pass after Stop, Retry, `cue transcribe` and the refining pass, with `-dev N`, four threads and no `-ng`; in a take with two tracks both tracks' runs, which in a whole-take pass means two at the same time on the card. Language detection, the grey live guess, the vocabulary's token probe and the speech detector stay on the processor build | Everything on the card: detection and the guess are as fast on the processor, and keeping them there leaves the card to the long work | measured: `-dl` 0.49 s on the card against 0.41 s on the processor |
| A run that fails | A run on the card that crashes or exits with an error is done again on the processor build with the small models, the card is marked as stopped in the saved result, and later runs use the processor until a new measurement. A run that exits well but whose log shows the processor is kept, and the card is marked the same way | Trying the card again at once: a crashing driver would cost every stretch twice | whisper.cpp `whisper_backend_init_gpu`; measured fallbacks in `proposal.md` |
| The large model | `ggml-large-v3-turbo.bin` (1,624,555,275 bytes, SHA-256 `1fc70f77…2bc69`, alignment preset `large.v3.turbo`) from the pinned Hugging Face revision, downloaded like the others when Large is chosen | The 574 MB quantised file: not measured here | https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1 |
| When Large is offered | When the winning card ran the sample in two thirds of the processor's time or less: on the RTX 5090 the large model took 1.5 times the small one's time on a 20 s stretch, so such a card runs Large no slower than the processor runs small. After the download the sample is timed with Large itself, two runs with the second counted, then run twice at the same time, as a take with two tracks runs it; if it is slower than the processor with small, or one of those runs fails, Standard transcribes, Settings says so and the card stays in use | Offering it on every card that wins: a card barely faster than the processor would get slower with Large | measured: 2.0 s against 1.3 s on the card, 2.7 s on the processor |
| What Large transcribes | Every take in every language, held to the take's language, on the card only. With the switch off, the card stopped or the download unfinished, the small models transcribe on the processor | Large on the processor: 8.4 s for a 20 s stretch, behind a recording | Q21 |
| Stored choices | `settings.json`: `model: "large"` when chosen (absent is Standard) and `graphicsCard: false` when switched off (absent is on). The measurement lives beside it in `speech-device.json` | The measurement inside `settings.json`: the person's choices and a machine's facts in one file | - |
| To the app and `cue` | `SetupStatus.speechDevice`: `{ state: measuring or ready, kind: graphicsCard or processor, name, card?: { name, stopped }, largeOffered, largeSlow, largeInUse, measurable }`; `get_speech_device` for the light poll while measuring; `test_speech_devices` for "Test the graphics card again". The large model joins `languageModels` when Large is chosen | - | - |
| The look | Model choice as picked, with a new switch component | - | `look.md` |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | `scripts/build-speech-runtime.mjs`, `scripts/package.mjs`, `scripts/verify-bundle.mjs`, `.github/workflows/build.yml`; `src-tauri/src/deps.rs` (the variant, the measurement, the large model), `settings.rs` (arguments, the two choices), `transcribe.rs` (running on the device, the repeat on the processor), `models.rs`, `lib.rs`, `cli.rs`, `bin/cue.rs`; `src/backend.ts`, `src/dialogs/SettingsDialog.tsx` with its CSS, tests and stories, a switch in `src/ui/`, `src/stories/backend.fixture.ts`; README.md (building, Settings, `cue setup`, installer size), docs/ARCHITECTURE.md (Local transcription), docs/DESIGN.md (the switch, Settings), docs/VERIFICATION.md |
| Formats and contracts | `settings.json` gains optional `model` and `graphicsCard`. New `speech-device.json` in the data folder. `cue setup` JSON gains `speechDevice`. The runtime folder gains `vulkan/whisper-cli.exe` and `jfk.wav`; `runtime.json` names the variants |
| Storage | `<root>/models/ggml-large-v3-turbo.bin` when Large is chosen; it stays when Standard is chosen again. The installer grows by one executable of about 48 MB before compression |

## Test plan

| Scenario or logic | Test |
|---|---|
| A fast graphics card transcribes; A slow graphics card is left alone | `src-tauri/src/deps.rs::tests::the_fastest_measured_device_transcribes`, new; `src-tauri/src/transcribe.rs::tests::actual_graphics_card_transcribes_and_keeps_word_timing`, new, ignored (needs the Vulkan build and a graphics card) |
| The devices are measured once, in the background | `src-tauri/src/deps.rs::tests::devices_are_measured_again_only_when_the_computer_changed`, new |
| A computer without a usable graphics card works as before | `src-tauri/src/deps.rs::tests::no_usable_graphics_card_means_the_processor_build`, new |
| A failed graphics-card run is repeated on the processor | `src-tauri/src/transcribe.rs::tests::a_failed_graphics_card_run_is_repeated_on_the_processor`, new |
| Settings names the device; The switch keeps transcription on the processor; The person has the graphics card tested again | `src/dialogs/SettingsDialog.test.tsx`, three new tests; `src-tauri/src/deps.rs::tests::the_switch_keeps_transcription_on_the_processor`, `::a_failed_graphics_card_is_used_again_after_a_new_measurement`, new |
| An agent reads the device | `src-tauri/src/models.rs::tests::the_transcription_device_is_reported_in_camel_case`, new |
| Settings offers the larger model on a fast graphics card; A slower computer is not offered the larger model | `src/dialogs/SettingsDialog.test.tsx`, two new tests |
| The larger model transcribes every language; Without the graphics card the small models transcribe; Choosing Standard goes back to the small models | `src-tauri/src/deps.rs::tests::the_larger_model_transcribes_every_language_once_installed`, `::the_larger_model_never_runs_on_the_processor`, `::standard_goes_back_to_the_small_models`, new; `src/dialogs/SettingsDialog.test.tsx::shows the larger model's download progress`, new |
| The device lines and the backend line read from a Vulkan log; a log without them is the processor | `src-tauri/src/deps.rs::tests`, unit tests on recorded logs |
| The measurement's ranking: second runs counted, ties to the processor, a card whose log shows the processor left out, the two-thirds rule | `src-tauri/src/deps.rs::tests`, unit tests |
| The bundle holds the Vulkan variant and the sample on Windows x64 | `scripts/verify-bundle.mjs`, extended |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| A fast graphics card transcribes | desk | After an install, Settings reads "Runs on NVIDIA GeForce RTX 5090"; a long recording's transcript is ready sooner than before |
| The devices are measured once, in the background | desk | The first start shows the measuring state briefly and recording works meanwhile; the second start does not measure |
| The switch keeps transcription on the processor | desk | Switch off, record: Settings reads "Runs on the processor" and stays so after a restart |
| The person has the graphics card tested again | desk | After a stop of the card, or at will, the button measures again and the card returns |
| Settings offers the larger model on a fast graphics card; The larger model transcribes every language | desk | Choose Large: the download shows its progress, then a German and an English review both come out with it, the English one no worse than before |
| Choosing Standard goes back to the small models | desk | Choose Standard: the small models transcribe again |

## Risks

- Only two cards were measured, an NVIDIA RTX 5090 and an AMD integrated chip. Intel graphics, AMD
  discrete cards and older drivers are unknown; whisper.cpp's tracker has crash reports on some.
  The measurement leaves out a card that does not run the sample, and a failed run falls back.
- The reviewed app may need the card. Runs are short bursts with 0.5 to 1.6 GB of video memory;
  the switch is the remedy, and nothing detects a stutter by itself.
- The build server gains a dependency and minutes: a pinned Vulkan SDK download per Windows build.
  It is a workflow change, so the owner merges this pull request.
- The large model on English rests on published averages; the one local sample went the other way
  by a point. The desk check on an English review covers it.
- The two-thirds rule comes from one card's ratio between the two models; the timing with Large
  itself after the download is the check that it holds on another card.
- A static executable of about 48 MB joins the installer.
