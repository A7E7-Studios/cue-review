---
title: Detect each take's language instead of assuming English
capabilities:
  - transcription/speech-models
---
# Detect each take's language instead of assuming English

## Why

A review recorded in German on an installation where nobody had opened Settings came out as
English nonsense: 2 h 31 min of German speech went through small.en held to English, live and
after Stop, and the app gave no sign that the language was the cause. The German choice exists in
Settings, but a person has to know it is there and remember to switch it before each recording in
another language. The transcript is what the agent works from, so a wrong language loses the whole
review.

- Measured on that recording: the installed multilingual base model names the language from the
  first 30 s of speech in 0.6 s (German, p = 0.99), and reads both audio tracks of a ten-minute
  excerpt as German (p = 0.95 and 0.96).

## What changes

- Auto is the language when none is chosen: each take's language is detected from its first speech
  and held: "A German take is transcribed as German without a setting", "An English take stays on
  small.en", "A take keeps the language it started in", "An unclear start does not decide the
  language", "Each take has its own language".
- A language chosen in Settings is used without detecting, and Settings offers every language the
  speech model knows: "A chosen language is used without detecting", "Settings offers Auto and
  every language".
- Transcribing again under Auto detects again: "Transcribing again detects the language again".
- Auto needs both small models, which download in the background: "An upgraded app fetches the
  models by itself", "The models are ready".
- The transcript says which language each take is in, and `cue` reports it: "The transcript names a
  detected language", "An agent reads each take's language".

## Review

At the desk, in the app installed over 0.3.0: Settings has Auto chosen, downloads the missing model,
then shows both ready and offers every language. A short German review comes out in German while
recording and after Stop, marked "German, detected"; Record more in English keeps the first take
German; a language chosen in Settings is used as chosen; `cue transcribe` on a German recording that
came out English reads it as German.

## Settled questions

- **Q1 Default**: Auto is the default; an installation without a saved language moves to it.
  Rejected: Auto as a choice with English staying the default.
- **Q2 Languages**: any language the speech model knows ("ideally if confidence or whatever metric
  we get drops below some threshold for some time, we re-evaluate the language"). Rejected: English
  or German only.
- **Q7 A language switch inside a take**: its own change after this one; this change detects once
  per take and holds. Rejected: in this change; not planned.
- **Q8 Models**: small.en for English and the multilingual small model for every other language.
  A GPU runtime and the larger model are built in parallel as their own change. Rejected: the
  multilingual small model for English too (9.9 % against 5.8 % word errors in the earlier
  measurement); large-v3-turbo on the CPU.
- **Q9 Settings**: Auto, then English and German, then every other language, as the remedy when
  Auto guesses wrong. Rejected: Auto, English and German only.
- **Q10 Shown**: the transcript names each take's language and `cue` reports it. Rejected: `cue`
  only; shown nowhere.
- **Q16 Summary**: confirmed as written here.

## Calls for the owner

- The language belongs to a take, not to a session: Record more in another language gets its own
  language. One language per session would be simpler to show, and would transcribe a second take
  in the wrong language.
- Settings stores only an explicit German today, so an installation where English was picked on
  purpose cannot be told from one that never chose: both move to Auto. A saved German stays German.
- A take that ends before any guess is confident is transcribed in the likeliest language heard,
  rather than in English or not at all.
- The installed base model detects the language, so detection works before the small models have
  arrived; until then base also transcribes, held to the detected language.
- Under Auto the English model downloads first and the multilingual one second, 976 MB together;
  an installation that already has small.en fetches 488 MB.
- `cue setup` reports the models as a list, `languageModels`, in place of the single
  `languageModel`, because Auto has two. An agent script reading `languageModel` has to change.
- Transcripts that already exist are not transcribed again on their own; Retry or `cue transcribe`
  does it.
- The confidence that decides a take's language, and how much speech it needs, are set in
  `design.md` from the research and measured on the German recording.

## Out of scope

- Following a language switch inside a take: the next change, `language-switches`.
- A GPU speech runtime and the larger model: `gpu-transcription`, built in parallel.
- Transcribing the system audio beside the microphone, and the echo between them:
  `both-audio-tracks`.
- A language choice per recording in the dock.
