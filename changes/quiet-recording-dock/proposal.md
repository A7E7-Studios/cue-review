---
title: Take the take label and the caption out of the recording dock
capabilities:
  - workspace/recording-dock
review: unreviewed
---
# Take the take label and the caption out of the recording dock

## Why

From the second take on, the dock grew a "Take 3" label and a caption under it, "Adding to this
session. Stop to process take 3 on this device." The owner found neither adds anything while
recording: the transcript already shows "Take 3 · recording", and the label made the dock change
width between takes.

- Evidence: `evidence/caption-selected.png`, the owner selecting the caption: "this text is also
  … can be taken out" at 2:15–2:32.
- Evidence: `evidence/take-3-label.png`, "take free can also be taken out … not sure if we gain any
  information from that so probably I would just take out take free as well" at 2:32 and 3:17–3:24.

## What changes

- The dock shows no "Take N" label and no caption under it, so it keeps one width from take to take
  (scenario: Recording a later take). Screen readers still hear the take in the timer's name, "Take
  N elapsed time".

## Settled questions

- **The caption** (review item, 2:15–2:32): taken out, nothing replaces it.
- **The "Take N" label** (review item, 2:32 and 3:21): taken out; the transcript's divider names the
  take.
- **Q11 The look**: the removal as drawn in `look/workspace-recording-take-2.png`. Rejected: changes to
  it.

## Calls for the owner

- The look has one direction, the removal the owner asked for, rather than two or three: no other
  direction keeps to what was settled. The pick is `look.md`.
- The timer keeps its accessible name "Take N elapsed time". Dropping the take from it too would
  leave screen-reader users without the take number the divider shows sighted users; scripts find
  the timer by that name.

## Out of scope

- The dock's level meter, mute and microphone name, which the audio capture batch changes.
- One always-shown recording bar with source and microphone pickers: the change
  `always-on-recording-bar`.
