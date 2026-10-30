---
title: Sidebar
code:
  - src/Sidebar.tsx
  - src/Sidebar.css
  - src/App.tsx
  - src/workspace/types.ts
---
# Sidebar

## Purpose

The column of recordings on the left: Recents and the sections a person files recordings into, with
the menus that move, rename and delete them and start new sessions.

## Requirements

### Requirement: Move to section is a submenu
The app SHALL open Move to section as a submenu beside the recording's menu when the pointer rests
on it, it is clicked, or ArrowRight or Enter is pressed on it, keeping the recording's menu open,
because a menu that replaced its own items lost the person's place, and the Claude app's submenu is
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
section submenu, because the sidebar has no New section button of its own.

#### Scenario: A person adds a section from a section's menu
- **GIVEN** a section's … menu is open
- **WHEN** the person chooses New section… and names the section
- **THEN** a new, empty section appears in the sidebar
- **PROOF** test: src/Sidebar.test.tsx::offers New section in a section's menu
- **PROOF** desk: open

### Requirement: A section heading starts a session in that section
The app SHALL show a + at the right of a section heading while the pointer is over the heading or
keyboard focus is in it, starting a new session that is filed in that section when it records,
because a person often records straight into the section they are looking at.

#### Scenario: A person starts a session in a section
- **GIVEN** nothing is recording
- **WHEN** the person presses the + on the heading of a section
- **THEN** a new session opens, ready to record
- **AND** once it records, the recording appears in that section
- **PROOF** test: src/Sidebar.test.tsx::shows a new-session button on a section heading
- **PROOF** test: src/App.test.tsx::files a session started from a section heading in that section
- **PROOF** desk: open

#### Scenario: The + is hidden while recording
- **GIVEN** a recording is in progress
- **WHEN** the person points at a section heading
- **THEN** no + appears
- **PROOF** test: src/Sidebar.test.tsx::hides the new-session button while recording
