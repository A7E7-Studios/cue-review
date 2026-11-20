---
title: Transcribe on the graphics card where it is faster
capabilities:
  - transcription/speech-runtime
  - transcription/speech-models
---
# Transcribe on the graphics card where it is faster

## Why

Transcription runs on the processor only, even on a computer with a fast graphics card. A long
review keeps the processor busy for minutes after Stop, and the small models are the largest the
processor can run in step with a recording, which shows in German and other languages. The owner
asked for GPU support and for larger models where the system allows them.

Measured on the owner's PC (Ryzen 9 9950X, RTX 5090, AMD integrated graphics) with whisper.cpp at
the pinned revision, on ten minutes of German speech with the app's own arguments:

| Runtime | small | large-v3-turbo |
|---|---|---|
| Processor, 8 threads (today) | 57 to 81 s | 151 to 187 s |
| Vulkan, RTX 5090 | 15 to 21 s | 12 to 13 s |
| CUDA, RTX 5090 | 15 to 23 s | 12 to 16 s |
| Vulkan, AMD integrated graphics | 148 s | 282 s |

- A 20 s stretch, as live transcription cuts them, takes 1.3 s with small and 2.0 s with
  large-v3-turbo on the RTX 5090 through Vulkan, against 2.7 s and 8.4 s on the processor.
- Large-v3-turbo read the German clearly better than small, and read the echo-laden microphone
  track without the repetition loops small fell into.
- The static Vulkan build used the card, kept word timing and language detection working, and fell
  back to the processor without crashing on every bad device setting tried.

## What changes

- On Windows the app measures once which device transcribes fastest and uses it, while recording
  and after Stop: "A fast graphics card transcribes", "A slow graphics card is left alone", "The
  devices are measured once, in the background", "A computer without a usable graphics card works
  as before".
- A run that fails on the graphics card is done again on the processor: "A failed graphics-card
  run is repeated on the processor".
- Settings shows where transcription runs and can keep it off the graphics card, and `cue setup`
  reports it: "Settings names the device", "The switch keeps transcription on the processor", "The
  person has the graphics card tested again", "An agent reads the device".
- A fast graphics card can run the larger model for every language: "Settings offers the larger
  model on a fast graphics card", "The larger model transcribes every language", "Without the
  graphics card the small models transcribe", "Choosing Standard goes back to the small models", "A
  slower computer is not offered the larger model".

## Review

At the desk, on the PC with the RTX 5090, in the installed app: the first start measures the devices
in the background while recording works, then Settings reads "Runs on NVIDIA GeForce RTX 5090" and a
long recording's transcript is ready sooner; the second start does not measure. Switched off,
transcription stays on the processor across a restart; testing the graphics card again measures it
again. Choosing Large shows its download, then a German and an English review both come out with it,
the English one no worse; choosing Standard goes back to the small models.

## Settled questions

- **Q8 GPU now**: GPU support is built in parallel with the language change, as its own change.
  Rejected: small models only for now; large-v3-turbo on the processor.
- **Q12 Platforms**: Windows now, macOS as a follow-up checked on a Mac. Rejected: both together.
- **Q13 The larger model**: a choice in Settings, shown when a graphics card is fast enough; the
  small models stay the default. Rejected: downloading and using it automatically.
- **Q14 Measuring**: test builds and large-v3-turbo were downloaded into a scratch folder and
  measured on the owner's PC.
- **Q17 Backend**: Vulkan, with CUDA as the fallback plan. Vulkan measured as fast as CUDA, so the
  fallback is not needed. Rejected: CUDA (NVIDIA only, about 770 MB of libraries to ship); both.
- **Q18 Vulkan SDK**: installed on the owner's PC for the build.
- **Q20 Choosing the device**: measure once and use the fastest. Rejected: discrete cards only,
  which is wrong for a fast integrated chip.
- **Q21 What the larger model transcribes**: every language, English included ("If the multi
  language model is supposed to be better, I would probably just use it overall"). Published
  averages favour it and it can write foreign words inside a take, which small.en cannot. Rejected:
  every language but English, which one five-minute local measurement suggested (6.9 % against
  5.8 % word errors, on the processor).
- **Q22 While recording**: the graphics card is used while recording too, with a switch in Settings
  to keep transcription off it. Rejected: only after Stop; no switch.
- **Q23 Summary**: confirmed as written here.
- **Q24 Two tracks at once**: the large model is judged on one run against the processor's one
  run with the small model; two runs at once, as a take with two tracks runs them, only have to
  succeed on the card. Measured on the owner's PC on 20 s of German: Large 2.3 s alone and 3.3 s
  two at once on the RTX 5090, against 3.5 s and 4.8 s for small on the processor. Rejected: the
  slower of two runs at once against one processor run, which passes here by 0.2 s; timing the
  processor two at once as well.
- **Q25 The sample's length**: every sample run hears `jfk.wav` twice back to back, about 22 s,
  as long as a stretch. On `jfk.wav` once (11 s), loading the 1.6 GB model is so much of the run
  that Large against the processor with small flipped between measurements on the owner's PC
  (Large 1.8 to 2.8 s, the processor 2.3 to 4.4 s), while on 20 s of German Large took 2.3 s
  against 3.5 s. Rejected: keeping 11 s with a margin picked by hand; keeping it as built.
- **Look**: Model choice (`look.md`): a Model select, Standard or Large, and one folded "Runs on"
  line holding the switch. Rejected: two switches; a Graphics card section of its own.
- **Another engine**: faster-whisper (CTranslate2) was weighed on the owner's question and not
  chosen: it has no Vulkan path, so no Intel graphics, adds 0.85 to 1.4 GB of runtime, and would
  replace the model, word-timing and prompt pipeline.

## Calls for the owner

- The installer grows by one more `whisper-cli`, about 48 MB before compression. The speech
  detector keeps running from the processor build, which is as fast there.
- A computer without a Vulkan loader, or where the Vulkan build does not start, stays on the
  processor builds and shows no error: nothing is worse than today.
- "Fast enough" for the larger model means the card transcribes with it no slower than the
  processor does with the small model. How that is judged before the 1.6 GB download is set in
  `design.md`.
- The measurement uses a few seconds of speech shipped with the app and takes the one-time warm-up
  of a card's first Vulkan run (16 s here) off the first recording.
- The larger model never runs on the processor: with the switch off or a failed card, the small
  models transcribe, so both stay installed.
- The words shown while recording, the stretches, the pass after Stop, Retry, `cue transcribe`
  and the refining pass all follow the chosen device; the grey live guess and language detection
  stay on the processor, where they are as fast.
- The build server needs the Vulkan SDK and a short build path. That is a workflow change under
  `.github/`, a protected path, so the owner merges this pull request.
- English on the larger model rests on published averages; the local English sample went the
  other way by one point. The desk check on an English review covers it.
- Only this PC's two cards were measured: an NVIDIA card and an AMD integrated one. Intel graphics
  and AMD discrete cards are untested.

## Out of scope

- macOS (Metal): `gpu-transcription-macos`.
- Dropping the grey live guess and the refining pass now that stretches are fast: a later change,
  once this one has been used.
- CUDA, and other speech engines such as faster-whisper or Parakeet.
- Finalizing the video on the graphics card, and making Stop not wait for it.
