---
title: Search
code:
  - src/search/
  - src/Sidebar.tsx
  - src/Sidebar.css
  - src/chrome/TitleBar.tsx
  - src/chrome/chrome.css
  - src/workspace/TranscriptPane.tsx
  - src/workspace/transcript.css
  - src/workspace/types.ts
  - src/App.tsx
  - scripts/verify-sidebar.cjs
---
# Search

## Purpose

Finding a recording, or the moment in it where something was said: one search over every
recording's name and transcript, opened from the sidebar or with Ctrl+K, and a find bar for the
transcript of the recording that is open.

## Requirements

### Requirement: Search opens from the sidebar
The app SHALL open a search window from a Search row at the top of the sidebar and from Ctrl+K (⌘K
on macOS), and SHALL show no search field in the title bar, because one search, placed where the
Claude app places it, reads cleaner than a field across the window's top.

#### Scenario: A person opens search
- **GIVEN** nothing is recording
- **WHEN** the person presses Search in the sidebar, or Ctrl+K
- **THEN** a search window opens over the app with its field focused
- **AND** before anything is typed it lists the most recent recordings
- **AND** Escape closes it and returns focus to where it was
- **PROOF** test: src/search/SearchDialog.test.tsx::opens with recent recordings and closes on Escape
- **PROOF** test: src/App.test.tsx::opens search from the sidebar and with Ctrl+K
- **PROOF** desk: open

#### Scenario: The title bar has no search field
- **WHEN** the review workspace shows
- **THEN** the title bar holds the app's name, the sidebar toggle, Settings and the window controls,
  and no search field
- **PROOF** test: src/chrome/TitleBar.test.tsx::has no search field
- **PROOF** desk: open

#### Scenario: Search waits while recording
- **GIVEN** a recording is in progress
- **WHEN** the person presses Ctrl+K
- **THEN** no search window opens, and the sidebar's Search row is unavailable
- **PROOF** test: src/App.test.tsx::does not open search while recording

### Requirement: Search finds names and transcript lines
The app SHALL list, as the person types, the recordings whose name contains the text and the
transcript lines that contain it, ignoring case, each line with its recording's name, the matching
text marked and its time, because a person often remembers what was said rather than what the
recording was called.

#### Scenario: A person searches for a word
- **GIVEN** recordings whose names or transcripts contain "filter"
- **WHEN** the person types "filter"
- **THEN** Recordings lists the recordings whose names contain it
- **AND** In transcripts lists each line that contains it, with its recording's name, the word
  marked and the line's time
- **PROOF** test: src/search/searchIndex.test.ts::finds names and transcript lines ignoring case
- **PROOF** test: src/search/SearchDialog.test.tsx::lists recordings and transcript lines
- **PROOF** desk: open

#### Scenario: A person opens a result
- **GIVEN** search shows results
- **WHEN** the person moves to a transcript line with the arrow keys and presses Enter, or clicks it
- **THEN** the search window closes, the line's recording opens, and playback stands at the line's
  time
- **AND** choosing a recording opens it from its start
- **PROOF** test: src/App.test.tsx::opens a transcript line at its time
- **PROOF** desk: open

#### Scenario: Nothing matches
- **WHEN** the person types text that no name or transcript contains
- **THEN** the window says No matches
- **PROOF** test: src/search/SearchDialog.test.tsx::says No matches

### Requirement: Find in transcript slides in
The app SHALL open the find bar above the open recording's transcript with Ctrl+F (⌘F on macOS) or
the transcript's Find button, sliding it in over 180ms, or at once under reduced motion, because a
bar that appears in one frame pushes the transcript down with a jolt.

#### Scenario: A person finds a word in the open transcript
- **GIVEN** a recording in review
- **WHEN** the person presses Ctrl+F
- **THEN** the find bar slides in above the transcript with its field focused
- **AND** it finds as today, with a count and previous and next
- **AND** Escape closes it and returns focus to where it was
- **PROOF** test: src/workspace/TranscriptPane.test.tsx::opens the find bar with Ctrl+F
- **PROOF** test: src/App.test.tsx::finds in the transcript with Ctrl+F
- **PROOF** desk: open
