# Look: Transcribe on the graphics card where it is faster

## Pick

**Model choice**: on a computer whose graphics card is fast enough, a Model select, Standard or
Large, sits under Language, and the model rows below follow the choice. The device is one folded
line, "Runs on NVIDIA GeForce RTX 5090"; unfolded it holds the "Use the graphics card" switch and
"Test the graphics card again", and, once Large is in use, the small models as the fallback. A
computer that transcribes on its processor gains that one line and nothing else. It is the calmest
of the three and keeps the order of importance: Language, Model, the models.

## Directions rejected

Each direction is shown in the default state and in the state that tells the directions apart.

- **Model choice** (`look/directions/model-choice/`): the pick, drawn first as a direction.
- **Two switches** (`look/directions/two-switches/`): a switch that starts a 1.6 GB download, and
  two more rows in Transcription on every fast computer.
- **Graphics card section** (`look/directions/graphics-card-section/`): the longest dialog, a
  mostly empty section on a computer without a usable card, and the model offer split from the
  model rows.

## States drawn

| Screen | State | Image |
|---|---|---|
| Settings | a fast graphics card, Standard chosen | `look/settings-default.png` |
| Settings | the same, light theme | `look/settings-default-light.png` |
| Settings | no usable graphics card | `look/settings-cpu-only.png` |
| Settings | the devices still being measured | `look/settings-measuring.png` |
| Settings | Large chosen, downloading | `look/settings-downloading.png` |
| Settings | Large in use, the fold open | `look/settings-ready.png` |
| Settings | the switch turned off, Large chosen | `look/settings-switch-off.png` |
| Settings | the graphics card stopped during a transcription | `look/settings-gpu-failed.png` |

Not drawn: the open Model list, which is the Language select's list with two entries, and a failed
download of the large model, whose row fails as the other model rows do, with Try again.

Settings, a fast graphics card, Standard chosen:

![Settings, fast graphics card](look/settings-default.png)

Settings, the same, light theme:

![Settings, fast graphics card, light](look/settings-default-light.png)

Settings, no usable graphics card:

![Settings, processor only](look/settings-cpu-only.png)

Settings, the devices still being measured:

![Settings, measuring](look/settings-measuring.png)

Settings, Large chosen, downloading:

![Settings, Large downloading](look/settings-downloading.png)

Settings, Large in use, the fold open:

![Settings, Large in use](look/settings-ready.png)

Settings, the switch turned off, Large chosen:

![Settings, switch off](look/settings-switch-off.png)

Settings, the graphics card stopped during a transcription:

![Settings, graphics card stopped](look/settings-gpu-failed.png)

## Components

- **From the library:** the Settings dialog's Transcription section, `settings-row` with its
  select, `settings-status` with the check icon, `settings-note`, `settings-issue`, the download
  progress bar, the disclosure used by Technical details, the pill button of Check again.
- **New:** a switch (`role="switch"`), which the library lacks: a 36 by 20 px track with a 16 px
  thumb, `--color-accent` when on, with its label and one line of help on the left.

## Research

- A switch for a change that takes effect at once (Microsoft, Toggle switches,
  learn.microsoft.com/en-us/windows/apps/design/controls/toggles).
- Rare options one step away, at most two levels deep (Nielsen Norman Group, Progressive
  disclosure, www.nngroup.com/articles/progressive-disclosure/).
- One switch, "Use graphics acceleration when available", under System (Google Chrome, as described
  by How-To Geek, www.howtogeek.com/412738/how-to-turn-hardware-acceleration-on-and-off-in-chrome).
- Local models listed with their sizes, large-v3-turbo at about 1.5 GiB (Superwhisper, Models,
  superwhisper.com/docs/models/voice).
- Hardware acceleration under Advanced (Discord and OBS, as described by EaseUS,
  www.easeus.com/knowledge-center/hardware-acceleration-discord.html).
