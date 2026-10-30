---
title: Choose playback speed from a list, and focus the video by hiding both sidebars
capabilities:
  - workspace/playback-controls
review: unreviewed
---
# Choose playback speed from a list, and focus the video by hiding both sidebars

## Why

Two playback controls behaved unlike the players people know. The speed button cycled through
speeds on each click and changed its width as the label grew, and the Focus video button hid only
the transcript, then turned into a sidebar icon. The owner named YouTube as the reference.

- "there was a make this screen larger button. I'm not sure about this one because it changes then
  to an expand the sidebar button and hides the right sidebar" at 8:25–9:00; the owner wants either
  proper video controls like YouTube with real fullscreen, or one button that hides both the left
  and right sidebars and restores them on a second click. Not shown in the recording, which was in
  progress at the time.
- "because 1.5 is wider than 1 … which feels a bit unpolished, and just clicking through them when
  it's actually a selection box also feels weird … reference is probably YouTube to have a proper
  selection" at 9:05–9:42.

## What changes

- The speed button keeps one width and opens a list of speeds instead of cycling: scenarios "A
  person chooses a playback speed" and "The speed button keeps its width".
- The list is 0.5×, 0.75×, 1× (Normal), 1.25×, 1.5×, 1.75× and 2× with a check on the current one,
  and works with the keyboard: scenario "A person chooses a speed with the keyboard".
- The chosen speed stays for the next session and the next start of the app: scenario "The speed
  stays for the next session".
- Focus video hides both the sidebar and the transcript, and restores both on a second press or
  Escape; its icon stays and shows pressed: scenarios "A person focuses the video" and "A person
  leaves focus".

## Settled questions

- **Q5 Focus video**: one toggle hides the sessions sidebar and the transcript together and
  restores both on the second press; the same icon, shown pressed; Escape also restores. It stays
  inside the window. Rejected: theater plus a YouTube-style fullscreen button; fullscreen only.
- **Q6 Playback speed**: a fixed-width button showing the current speed that opens an anchored list
  with a check on the current speed, with arrow keys and Enter, like YouTube's speed list.
  Rejected: a settings gear menu with a Playback speed entry.
- **Q7 Speeds**: 0.5, 0.75, 1 (Normal), 1.25, 1.5, 1.75 and 2, YouTube's list; the choice stays for
  the next session. Rejected: keeping 0.75, 1, 1.5 and 2.
- **Q9 Summary**: confirmed as written here.

## Calls for the owner

- Leaving focus brings the sidebar back only if it showed before focus; a sidebar the person had
  hidden stays hidden. Restoring it regardless would undo the person's own choice.
- Showing the sidebar with its own toggle while focused also ends focus, so the transcript returns
  with it; otherwise the layout would be half-focused with no pressed control to explain it. A
  search that shows the sidebar leaves focus on, since the person is looking for a recording, not
  leaving focus. Starting a new recording ends focus, which belongs to review: scenario "Focus ends
  when the sidebar or another recording takes over".
- Focus video stays named "Focus video" in both states and carries the pressed state
  (`aria-pressed`); the "Restore transcript" name goes. `scripts/verify-native-ux.cjs` and the
  tests move to the new name and to the speed list.
- The speed is kept in the app's local storage on this computer, not in the session's files.

## Out of scope

- Real fullscreen (Q5's rejected options).
- The Record more pill beside these controls: the recording-flow batch (`always-on-recording-bar`).
