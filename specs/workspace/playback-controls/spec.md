---
title: Playback controls
code:
  - src/workspace/PlaybackBar.tsx
  - src/workspace/workspace.css
  - src/workspace/types.ts
  - src/App.tsx
  - scripts/verify-native-ux.cjs
---
# Playback controls

## Purpose

The controls under the video while reviewing a recording: play and pause, the time, the playback
speed and Focus video, which gives the video the whole window.

## Requirements

### Requirement: Playback speed is chosen from a list
The app SHALL show the playback speed on a button of fixed width that opens a list of 0.5×, 0.75×,
1× (Normal), 1.25×, 1.5×, 1.75× and 2× with a check on the current speed, because a control that
changes width moves the controls beside it, and a list shows every choice at once.

#### Scenario: A person chooses a playback speed
- **GIVEN** a recording plays at 1×
- **WHEN** the person presses the speed button and chooses 1.5×
- **THEN** the recording plays at 1.5× and the button reads 1.5×
- **AND** the list closes and focus returns to the speed button
- **PROOF** test: src/workspace/PlaybackBar.test.tsx::chooses a speed from the speed list
- **PROOF** test: src/App.test.tsx::plays at the speed chosen from the list
- **PROOF** desk: open

#### Scenario: A person chooses a speed with the keyboard
- **GIVEN** focus is on the speed button
- **WHEN** the person presses Enter
- **THEN** the list opens with focus on the current speed, which is checked
- **AND** ArrowUp and ArrowDown move through the speeds, Enter chooses one, Escape closes the list
  without a change, and focus returns to the speed button
- **PROOF** test: src/workspace/PlaybackBar.test.tsx::chooses a speed with the keyboard
- **PROOF** desk: open

#### Scenario: The speed button keeps its width
- **GIVEN** the speed button reads 1×
- **WHEN** the person chooses 1.75×
- **THEN** the speed button keeps the same width and the controls beside it do not move
- **PROOF** test: src/workspace/playbackStyles.test.ts::gives the speed button a fixed width
- **PROOF** desk: open

### Requirement: The playback speed stays
The app SHALL keep the chosen playback speed for every recording opened afterwards, also after the
app restarts, because a person who reviews at 1.5× reviews every recording at 1.5×.

#### Scenario: The speed stays for the next session
- **GIVEN** the person chose 1.5×
- **WHEN** they open another recording, or restart the app and open one
- **THEN** it plays at 1.5× and the speed button reads 1.5×
- **PROOF** test: src/App.test.tsx::keeps the chosen speed for the next recording and the next start
- **PROOF** desk: open

### Requirement: Focus video hides both sidebars
The app SHALL hide both the sidebar of recordings and the transcript with one Focus video toggle
that keeps its icon and shows itself pressed, and SHALL restore both on a second press or Escape,
because one toggle that keeps its icon reads as one control in two states.

#### Scenario: A person focuses the video
- **GIVEN** a recording in review with the sidebar and the transcript showing
- **WHEN** the person presses Focus video
- **THEN** the sidebar and the transcript hide and the video takes the window's width
- **AND** Focus video keeps its icon and shows pressed
- **PROOF** test: src/workspace/PlaybackBar.test.tsx::shows Focus video pressed with the same icon
- **PROOF** test: src/App.test.tsx::hides the sidebar and the transcript in focus
- **PROOF** desk: open

#### Scenario: A person leaves focus
- **GIVEN** the video is focused
- **WHEN** the person presses Focus video again, or presses Escape
- **THEN** the transcript returns, and the sidebar returns beside the sheet if it showed there
  before focus
- **AND** Focus video shows not pressed
- **PROOF** test: src/App.test.tsx::restores both sidebars when focus ends
- **PROOF** test: src/App.test.tsx::docks the sidebar again after focus even if the window narrowed meanwhile
- **PROOF** desk: open

#### Scenario: Focus ends when the sidebar or another recording takes over
- **GIVEN** the video is focused
- **WHEN** the person presses Show sidebar, or starts a new recording
- **THEN** focus ends: the sidebar and the transcript show, and Focus video shows not pressed
- **AND** a search that shows the sidebar leaves focus on, and Hide sidebar hides it again
- **PROOF** test: src/App.test.tsx::ends focus when the sidebar is shown or the workspace leaves review
- **PROOF** test: src/App.test.tsx::keeps focus when a search shows the sidebar, and hides it again with its toggle
- **PROOF** desk: open
