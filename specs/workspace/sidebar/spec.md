---
title: Sidebar
code:
  - src/Sidebar.tsx
  - src/Sidebar.css
  - src/dialogs/SettingsDialog.tsx
  - src/stories/Sidebar.stories.tsx
---
# Sidebar

## Purpose

The column at the left that lists sessions in their sections and Recents, and where a new session
or a new section starts.

## Requirements

### Requirement: A new session starts from a plain row
The app SHALL start a new session from a "+ New session" row at the top of the sidebar, with no
red dot and no button beside it, because a red dot reads as "start recording" and a folder icon
beside it reads as a folder on disk.

#### Scenario: Starting a new session from the sidebar
- **GIVEN** the app in review
- **WHEN** the reviewer looks at the top of the sidebar
- **THEN** they see a plus and "New session" with no button frame and no red dot, and nothing
  beside it
- **AND** pressing it, or Ctrl+N (⌘N on macOS), opens a new recording to set up
- **PROOF** test: src/Sidebar.test.tsx::Float v2 sidebar puts New session alone at the top with a plus, and hides the shortcut hint from the name
- **PROOF** test: src/App.test.tsx::keyboard interaction starts a new recording with Ctrl+N, except while recording
- **PROOF** desk: open

### Requirement: The sidebar has its own menu
The app SHALL offer New session and New section in a menu that right-clicking empty space in the
sidebar opens, and that is also the New session row's context menu, because that is where a
desktop app's list keeps its create actions, and the context menu key reaches it from the
keyboard.

#### Scenario: Right-clicking empty space in the sidebar
- **GIVEN** the app in review
- **WHEN** the reviewer right-clicks empty space in the sidebar's list
- **THEN** a menu offers "New session" and "New section", and a click outside it closes it
- **AND** a right-click on a session row or a section heading, or on its options button, still opens
  that row's own menu
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu right-clicking empty space in the list offers New session and New section
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu closes the sidebar menu on a click outside it
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu a right-click on a row or section options button opens its own menu
- **PROOF** desk: open

#### Scenario: Reaching the sidebar menu from the keyboard
- **GIVEN** focus on "New session"
- **WHEN** the reviewer presses Shift+F10 or the context menu key
- **THEN** the sidebar's menu opens with focus on its first item
- **AND** Escape closes it and returns focus to "New session"
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu a row keeps its own menu, and the New session button opens the sidebar menu from the keyboard
- **PROOF** desk: open

#### Scenario: The sidebar menu while recording
- **GIVEN** a take being recorded
- **WHEN** the reviewer right-clicks empty space in the sidebar or the New session row
- **THEN** no menu opens, and "New session" is dimmed
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu offers no sidebar menu while recording
- **PROOF** test: src/App.test.tsx::record more unloads the video before recording a take, shows it live, and reloads the video with a cache-buster once processing ends
- **PROOF** desk: open
