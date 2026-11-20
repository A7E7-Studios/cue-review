---
title: Move the specs and change folders to the kit's new formats
capabilities:
  - agent-cli/take-frames
  - capture/audio-tracks
  - capture/camera-capture
  - capture/macos-permissions
  - capture/record-more
  - capture/recording-startup
  - capture/source-selection
  - transcription/live-transcription
  - transcription/speech-detection
  - transcription/speech-models
  - transcription/speech-runtime
  - transcription/transcribed-tracks
  - workspace/look-and-feel
  - workspace/playback-controls
  - workspace/recording-dock
  - workspace/search
  - workspace/sidebar
  - workspace/take-playback
  - workspace/transcript-following
  - workspace/window-chrome
---
# Move the specs and change folders to the kit's new formats

## Why

Changes needed several review rounds each, because a round failed on nits and the author did not
check the change before the reviewer did. The faster-spec kit now ends review rounds once no
blocker or major is left, and has the author check the whole change before every round. Taking it
brings the kit's new formats too: the owner reviews each feature as a whole and the verdict lives
in its spec, scenarios are proven by tests only, and looks are HTML boards rather than pictures.
The new gate refuses the old config and formats, so every spec and change folder moves at once.

## What changes

- **Every spec** starts `review: unreviewed`. `## Purpose` becomes `## Summary`, rewritten to say
  when you meet the feature. The 103 `desk: open` PROOF lines go: none held a pass or a fail, and
  the owner's review of the feature takes their place. Three statements that ran past one sentence
  become one, saying the same: "Speech is transcribed while recording, so Stop leaves little to
  do", "Each take is transcribed in its own language with that language's model" and
  "Transcription uses a share of the processor that fits the job". No requirement or scenario
  changes otherwise; every scenario already had one WHEN and one THEN.
- **The pictures go**: the 50 under the specs' `look/` folders and the 250 under the change
  folders' `look/` and `evidence/`, with the Git LFS rules kept only for them. They stay in git
  history. A feature with a visual side gets a board when the design skill next draws it.
- **Every change folder** loses its `review` and `follow-ups` keys and gains a `## Review` section
  saying what the owner looks at and where, drawn from its desk checks. Its evidence keeps the
  owner's words and times without the file, and its `look.md` keeps the states drawn without the
  images.
- **The gate's config** takes the renamed overview keys, the boards' budget and a `solutionMap`
  block.

## Review

At the desk, no build needed, since nothing the app does changes: open the Solution map
(`node tools/solution-map/solution-map.mjs`), where all 20 features wait for you. Read each
Summary: does it say what the feature does and when you meet it? The three one-sentence statements
should say what the three statements they replace said. Each feature's own review, in the app, is
in the `## Review` of the change folders that name it.

## Settled questions

- **Q1 Scope**: the whole kit at `6d844e1` and the migration it requires, in one pull request.
  Rejected: taking only the two skill changes, which the kit cannot vendor apart from the rest.
- **Q2 Meaning**: the specs change in form, not in behaviour. Rejected: rewriting requirements
  beyond the three statements the one-sentence rule needs.

## Calls for the owner

- **No `design` block yet.** The block CueReview wants names its own design system:
  `src/ui/tokens.css` as the tokens, `docs/DESIGN.md` as the brief and Storybook as the catalogue.
  The kit's gate suite asserts that the project's own config has no `design` block, so with it one
  kit test fails here, and kit files are not edited in a project. Until the kit's test reads only
  its starter config, the design skill finds the component library and its tokens through
  AGENTS.md, as it did before. The alternatives were the block with one red kit test, or the kit's
  house style, whose tokens the app does not use. Adding the block later is one config edit.
- **The Solution map names this repository `cue-review`**, as on GitHub. Renaming it is one config
  edit.
- **The Summaries were rewritten** to the new form: each keeps what the Purpose said and adds when
  you meet the feature. Where a Purpose said only what the feature is, the added sentence (for
  example "You use them whenever you watch a review back" for the playback controls) is the
  agent's reading.
- **The change-level verdicts do not carry over.** `always-on-recording-bar` and
  `macos-camera-capture` were `changes-requested`, answered by `macos-recording-controls`; their
  features start `unreviewed` like every other, as the kit's migration says.
- **`design.md`'s Human checks tables and `tasks.md`'s `check:` items** in older change folders
  stay as they were written: they are the plans those changes were built from, and the `## Review`
  sections say the same for the owner.

## Out of scope

- Boards for the features with a visual side: drawn by the design skill when a change next
  touches each.
- `specs/systems.json`: optional; without it the overview lists the code outside any system.
- Tests for the two scenarios no automation reaches: "An installed macOS app records the selected
  microphone" and "Screen recording remains available after an update" stay untested.
