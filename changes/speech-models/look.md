# Look: Transcribe with the small model of the chosen language

## Pick

**A Transcription section**: its own section above Vocabulary holds what shapes the transcript, the
Language select (the same control as Appearance) and the model's state: Ready, its download with
size and a progress bar, or a failure with Try again. It keeps "Recording tools" about installed
tools, and the select follows Microsoft's advice for a choice whose default is the usual pick.

## Directions rejected

Each direction is shown in the default state and in the state that tells the directions apart.

- **A Transcription section** (`look/directions/section/`): the pick, drawn first as a direction.
- **B Inline in Recording tools** (`look/directions/inline/`): mixes a choice into a list of tool
  statuses, and its progress bar sits between unrelated rows.

## States drawn

| Screen | State | Image |
|---|---|---|
| Settings | ready | `look/settings-ready.png` |
| Settings | downloading the German model | `look/settings-downloading.png` |
| Settings | download failed | `look/settings-failed.png` |

Settings, ready:

![Settings, ready](look/settings-ready.png)

Settings, downloading the German model:

![Settings, downloading](look/settings-downloading.png)

Settings, download failed:

![Settings, download failed](look/settings-failed.png)

## Components

- **From the library:** the Settings dialog's section, `settings-row` with its select,
  `settings-status` with the check icon, `settings-note`, `settings-issue`, `settings-pill`.
- **New:** a progress bar: 4 px, `--color-divider` track, `--color-accent` fill, 999 px radius;
  nothing in the library shows a determinate download.

## Research

- Combo box for a choice with a usual default, radio buttons when the options deserve equal weight
  (Microsoft, Radio buttons, learn.microsoft.com/windows/apps/design/controls/radio-button).
- Local Whisper apps fetch models from Hugging Face on demand, cache them and switch to them
  automatically, with a notice when a download fails (MacWhisper guides and release notes).
- A determinate bar with the size left for downloads of known size (Microsoft, Progress controls,
  learn.microsoft.com/windows/apps/design/controls/progress-controls).
