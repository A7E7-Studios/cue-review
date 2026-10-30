---
title: Show the microphone's level, name and mute plainly in the recording dock
capabilities:
  - workspace/recording-dock
review: unreviewed
---
# Show the microphone's level, name and mute plainly in the recording dock

## Why

Recording a review, the owner could not tell whether the microphone worked. Their speech, at −35
to −40 dBFS, lit none of the meter's bars: the meter lit its first bar only at about −26 dBFS
(`round(level × 10)` of a linear RMS). The dock did not say which microphone it recorded.
Wanting to test it, they pressed the dock's microphone button 22 times, muting and unmuting 11
times, and recorded 13.7 s of silence without noticing, because the muted state was only a
different icon. Muting also hid the meter, so the dock changed width under the pointer.

- Evidence: `evidence/meter-dark-while-speaking.png`, "I don't know which microphone I'm using
  but it's like I'm basically exactly next to the microphone I think and shows zero, yeah zero
  volume here" at 2:37–2:53 (157914–173594).
- `evidence/muted-dock-narrower.png` and `evidence/unmuted-dock-wider.png`, the dock muted and
  unmuted two seconds apart, at 3:06 and 3:08; "maybe it makes sense to still show it or show it
  flat or whatever" at 3:08 (188534).

## What changes

- The meter reads in decibels, from −60 to 0 dBFS, and holds the loudest level since its last
  update: "Quiet speech lights the meter".
- The dock names the microphone it records: "The dock names the microphone".
- Muted, the dock says so in words, keeps the meter in place and flat, and keeps its width:
  "Muting the microphone while recording".
- A mute from the dock lasts for its take: "The next take starts unmuted".

## Settled questions

- **Q1 Record more's controls** (answered here, built elsewhere): "Ideally, the recording UI is the
  same as when there is no recording at all. Why two different UIs? We could partially integrate
  the playback into the video youtube style. In general needs some design, but I would keep the
  screen and microphone options as well as the recording button consistent between initial
  recording and record more." The always-shown recording bar carries it.
- **Q5 Record more's source** (answered here, built elsewhere): "Allow any source but technically we
  should not need to cut the videos together. The AI can analyze multiple videos if needed (or
  generally our tool provides screenshots from the right video based on the timing when calling
  the command). I would keep the videos themself separate." The separate-take-videos change carries
  it.
- **Q2 Mute at the start of a take**: every take starts unmuted unless Mute is ticked in the picker
  before it starts; muting from the dock lasts for that take only. Rejected: carrying the mute
  over, but showing it.
- **Q3 Meter scale**: −60 to 0 dBFS, 10 bars of 6 dB, the top two (above −12 dBFS) in the high
  colour, holding the loudest level since its last update so short words show. Rejected: −70 to
  −10 dBFS.
- **Q6 A warning for a silent microphone**: none; the meter on its new scale shows a dead
  microphone. Rejected: "No sound from <mic>" after 5 s of silence.
- **Q9 Summary**: confirmed as above; the look gets two or three directions for the owner to pick.
- **Q11 Look**: the mic chip, the meter on its scale and the mute shared with the recording bar's
  dock (agreed with `always-on-recording-bar`). Rejected: a name label with a labelled Mute toggle; a two-line meter.

## Calls for the owner

- The level the backend reports is the loudest packet RMS since the UI last read it (the status
  poll), not the last packet's, so a word between two polls still shows. The alternative, a decay
  in the UI, would lag behind the voice.
- The chip shows the device's short name: a leading "Default — " and a one-word endpoint wrapper in
  any language ("Microphone (…)", "Mikrofon (…)") are dropped ("HD Pro Webcam C920"), and the tooltip
  names the whole device. Showing the full
  name would truncate to "Default — Microphone (HD…" and hide the part that tells devices apart.
- In a window too narrow for the name, the chip keeps its icon and meter; muted, it keeps the
  live colour and the crossed-out icon but has no room for "Muted" (its tooltip and pressed state
  still say so). The alternative, dropping the meter before the name, loses the level first.
- The chip names the microphone during a take, as the picked look draws it, although the recording
  bar shows the microphone before a take: during a take the bar becomes this dock, and the name is
  what the owner asked for at 2:37. Dropping it later means removing one span.
- The chip's button keeps the accessible name "Mute microphone" (the scripts find it by that
  name), its pressed state says whether it is muted, and the microphone's name, drawn over the chip
  beside the button rather than inside it, is its description.
- A bar lights as soon as the level reaches into its 6 dB step (bar n above −60 + 6(n − 1) dBFS),
  so −38 dBFS lights four bars and the top two light above −12 and −6 dBFS, as the scale was asked
  for. Counting whole steps instead would light the tenth bar only at full scale.

## Out of scope

- Choosing the source and microphone before a take, for a new recording and for Record more: the
  always-shown recording bar (`always-on-recording-bar`), which shows the mute state before a take.
- Keeping each take's video separate and recording another source in a take.
- Switching the microphone during a take.
- The take label and the caption under the dock: the `quiet-recording-dock` change.
