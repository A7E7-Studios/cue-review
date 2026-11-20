# Look: Detect each take's language instead of assuming English

## Pick

**A Take line**: every take opens with its divider, which names the take's language after its
time: "Take 1 · 0:00 · German, detected", the name alone for a language chosen in Settings, and
"detecting language" while a take records and is not decided. The language sits where the take's
words begin, so a wrong one shows beside the nonsense it caused. Settings keeps its select, grouped
as Auto, then English and German, then the other languages by name, with one status row for each
model the choice needs. Nothing new enters the component library.

## Directions rejected

Each direction is shown in the default state and in the state that tells the directions apart.

- **A Take line**: the pick, drawn first as a direction.
- **B Language chip**: a chip beside the transcript title names
  only the take at the playhead, and it needs a new searchable picker in Settings for a choice most
  people make once.
- **C Take strip**: a row of chips under the title is a second
  navigation for takes, a new component, and takes room from the transcript in every session.

## States drawn

| Screen | State |
|---|---|
| Transcript | two takes, each with a detected language |
| Transcript | two takes, light theme |
| Transcript | one take in a language chosen in Settings |
| Transcript | recording a take whose language is not decided |
| Settings | Auto, both models ready |
| Settings | Auto, both models ready, light theme |
| Settings | Auto, the multilingual model downloading |
| Settings | the language list open |
| Settings | a fixed language chosen |

A session of one take gains the divider it does not have today, because that is where its language
is named. A failed download under Auto is not drawn: each model's row fails as the single row does
today.

## Components

- **From the library:** the transcript's take divider, the Settings dialog's Transcription section,
  `settings-row` with its select and the select's groups, `settings-status` with the check icon,
  `settings-note`, and the download progress bar.
- **New:** none.

## Research

- Common options first, grouped, with text search for a long drop-down (Microsoft, Combo box,
  learn.microsoft.com/en-us/windows/apps/design/controls/combo-box).
- A flat list with the default most people want and explanatory text below it (Apple, Pop-up
  buttons, developer.apple.com/design/human-interface-guidelines/pop-up-buttons).
- Automatic detection sometimes turns other speech into English, and a fixed language is the remedy
  (Superwhisper, Language detection, superwhisper.com/docs/common-issues/language-detection).
- When automatic detection is wrong, transcribe again in a named language (Descript, Automatic
  transcription, help.descript.com/script-editing/automatic-transcription).
- A mismatch between the spoken and the set language is told to the person with the language
  suggested (Microsoft Teams, live captions,
  support.microsoft.com/en-us/office/use-live-captions-in-microsoft-teams-meetings-4be2d304-f675-4b57-8347-cbd000a21260).
