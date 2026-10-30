# Look: Show the microphone's level, name and mute plainly in the recording dock

## Pick

**Mic chip**: one fixed-width chip names the microphone, shows its level and mutes it. It answers
the owner's three questions in one place: which microphone, does it hear me, am I muted. Muted, the
whole chip turns the live colour and reads "Muted" over a flat meter, so the state is carried by a
word and a changed container, not by colour or an icon alone (WCAG 1.4.1, Material 3). The chip
keeps its width, so muting moves nothing under the pointer, and it costs less room than a separate
label and toggle.

## Directions rejected

Each direction is shown speaking at −38 dBFS and muted.

- **Name label + Mute toggle** (`look/directions/mute-toggle/`): the clearest toggle, but the
  widest by about 240 px; the source truncates at the default window width.
- **Two-line meter** (`look/directions/two-line-meter/`): the smallest, but the name is 11 px
  secondary text and mute stays a round icon button, the control the owner misread.

## States drawn

The pick in every state its scenarios name: one PNG per screen and state in `look/`, at most
1280 px wide. Rendered from boards built of the library's tokens and dock styles.

| Screen | State | Image |
|---|---|---|
| Recording dock | speaking at −38 dBFS | `look/dock-speaking.png` |
| Recording dock | muted | `look/dock-muted.png` |
| Recording dock, dark theme | speaking | `look/dock-speaking-dark.png` |
| Recording dock, dark theme | muted | `look/dock-muted-dark.png` |
| Recording dock, narrow window | speaking: the name drops, icon and meter stay | `look/dock-narrow.png` |
| Recording dock, narrow window | muted | `look/dock-narrow-muted.png` |

Recording dock, speaking at −38 dBFS:

![](look/dock-speaking.png)

Recording dock, muted:

![](look/dock-muted.png)

Recording dock, dark theme, speaking:

![](look/dock-speaking-dark.png)

Recording dock, dark theme, muted:

![](look/dock-muted-dark.png)

Recording dock, narrow window, speaking:

![](look/dock-narrow.png)

Recording dock, narrow window, muted:

![](look/dock-narrow-muted.png)

## Components

- **From the library:** the dock (`.cr-dock`), `.cr-btn`, the level meter (`.cr-meter`), the
  `mic` and `micOff` icons, the dock and meter tokens (`--color-dock*`, `--color-meter-*`,
  `--color-live`).
- **New:** the microphone chip (`.cr-mic-chip`): a pill-shaped toggle holding the microphone's
  icon, its name and the meter, replacing the round mute button. No library component combines a
  label, a live meter and a toggle state.

## Research

- WCAG 2.2 SC 1.4.1, Use of Color: a state is not carried by colour alone, so the muted chip reads
  "Muted" (w3.org/WAI/WCAG22/Understanding/use-of-color).
- OBS Studio's audio mixer meters read −60 to 0 dB, and a muted source keeps its meter in place:
  the scale and the flat meter follow it (obsproject.com/kb/audio-mixer-guide).
- Apple HIG, Toggles: a toggle's state is clear at a glance, labelled where an icon alone is
  ambiguous (developer.apple.com/design/human-interface-guidelines/toggles).
- Material 3 icon buttons: a selected toggle changes its container, not only its icon
  (m3.material.io/components/icon-buttons/guidelines).
