---
title: Sidebar
code:
  - src/Sidebar.tsx
  - src/Sidebar.css
  - src/App.tsx
  - src/workspace/types.ts
  - src/dialogs/SettingsDialog.tsx
  - src/stories/Sidebar.stories.tsx
---
# Sidebar

## Purpose

The column of recordings on the left: Recents and the sections a person files recordings into, where
a new session or section starts, with the menus that move, rename and delete them.

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
The app SHALL offer New session and New section in a menu that right-clicking anywhere in the
sidebar outside its rows, section headings and their buttons opens, the New session row
included, because that is where a desktop app's list keeps its create actions, and the context
menu key reaches it from the keyboard.

#### Scenario: Right-clicking empty space in the sidebar
- **GIVEN** the app in review
- **WHEN** the reviewer right-clicks empty space in the sidebar: the list, around New session or
  the bottom area
- **THEN** a menu offers "New session" and "New section", and a click anywhere outside it, the New
  session row included, closes it
- **AND** a right-click on a session row or a section heading, or on one of their buttons, still
  opens that row's own menu
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu right-clicking empty space in the list offers New session and New section
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu closes the sidebar menu on a click outside it
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu opens from anywhere in the sidebar outside rows and headings
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu closes when the New session row it was opened from is clicked
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu a right-click on a row or section options button opens its own menu
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu closes a section menu opened by right-click when its + is clicked
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
- **THEN** the sidebar's menu opens with "New session" and "New section" disabled, and "New
  session" in the sidebar is dimmed
- **PROOF** test: src/Sidebar.test.tsx::the sidebar menu opens the sidebar menu with both items disabled while recording
- **PROOF** test: src/App.test.tsx::record more unloads the video before recording a take, shows it live, and reloads the video with a cache-buster once processing ends
- **PROOF** desk: open

### Requirement: Move to section is a submenu
The app SHALL open Move to section as a submenu beside the recording's menu when the pointer rests
on it, it is clicked, or ArrowRight or Enter is pressed on it, keeping the recording's menu open,
because a submenu keeps the person's place in the recording's menu, and the Claude app's submenu is
the behaviour the person expects.

#### Scenario: A person points at Move to section
- **GIVEN** a recording's menu is open
- **WHEN** the pointer rests on Move to section
- **THEN** a submenu opens beside the menu, its first item level with Move to section
- **AND** it lists Recents and every section in sidebar order, the recording's current place checked
  and unavailable, then New section…
- **AND** the recording's menu stays open with Move to section highlighted
- **PROOF** test: src/Sidebar.test.tsx::opens Move to section as a submenu on hover
- **PROOF** desk: open

#### Scenario: A person moves a recording with the keyboard
- **GIVEN** a recording's menu is open with Move to section focused
- **WHEN** the person presses ArrowRight
- **THEN** focus moves to the submenu's first available item
- **AND** ArrowLeft or Escape closes the submenu and returns focus to Move to section
- **AND** Enter on a section moves the recording there, closes both menus and keeps focus on the
  moved recording
- **PROOF** test: src/Sidebar.test.tsx::moves a recording through the submenu with the keyboard
- **PROOF** test: src/Sidebar.test.tsx::moves focus into a submenu the pointer already opened
- **PROOF** desk: open

#### Scenario: A person moves a recording into a new section
- **GIVEN** the Move to section submenu is open
- **WHEN** the person chooses New section… and names the section
- **THEN** the section is created and the recording moves into it
- **PROOF** test: src/Sidebar.test.tsx::offers New section at the end of the submenu
- **PROOF** desk: open

#### Scenario: The submenu stays inside the window
- **GIVEN** a recording's menu sits near the window's right or bottom edge
- **WHEN** its Move to section submenu opens
- **THEN** the submenu opens to the left of the menu when the right has no room
- **AND** it shifts up so its last item stays inside the window
- **PROOF** test: src/ui/submenuPlacement.test.ts::flips to the left at the right edge
- **PROOF** test: src/ui/submenuPlacement.test.ts::shifts up at the bottom edge
- **PROOF** desk: open

### Requirement: Sections are made from the menus
The app SHALL offer New section… in each section's menu, as it does at the end of the Move to
section submenu, because a person makes a section from where they are already working in the
sidebar.

#### Scenario: A person adds a section from a section's menu
- **GIVEN** a section's … menu is open
- **WHEN** the person chooses New section… and names the section
- **THEN** a new, empty section appears in the sidebar
- **PROOF** test: src/Sidebar.test.tsx::offers New section in a section's menu
- **PROOF** desk: open

### Requirement: A section heading starts a session in that section
The app SHALL show a + at the right of a section heading while the pointer is over the heading or
keyboard focus is in it, and not while a recording is in progress or a search filters the sidebar,
starting a new session that is filed in that section when it records, because a person often records
straight into the section they are looking at.

#### Scenario: A person starts a session in a section
- **GIVEN** nothing is recording
- **WHEN** the person presses the + on the heading of a section
- **THEN** a new session opens, ready to record, and the section opens if it was collapsed
- **AND** once it records, the recording appears in that section
- **PROOF** test: src/Sidebar.test.tsx::shows a new-session button on a section heading
- **PROOF** test: src/App.test.tsx::files a session started from a section heading in that section
- **PROOF** desk: open

#### Scenario: The + is hidden while recording
- **GIVEN** a recording is in progress
- **WHEN** the person points at a section heading
- **THEN** no + appears
- **PROOF** test: src/Sidebar.test.tsx::hides the new-session button while recording

#### Scenario: The + is hidden while searching
- **GIVEN** a search filters the sidebar
- **WHEN** the person points at a section heading
- **THEN** no + appears
- **PROOF** test: src/Sidebar.test.tsx::hides the new-session button while a search filters the sidebar
