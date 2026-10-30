---
title: Look and feel
code:
  - src/app/useContextMenuGuard.ts
  - src/App.tsx
  - src/Sidebar.tsx
  - src/Sidebar.css
  - src/workspace/types.ts
---
# Look and feel

## Purpose

The behaviour and look every screen of the app shares: what a right-click offers, how scrollbars,
form fields and dialogs look, and how sharply text renders. It makes the app feel like one desktop
app rather than a web page in a window.

## Requirements

### Requirement: Right-click never shows the webview's page menu
The app SHALL show no menu when the person right-clicks anywhere without a menu of its own, and
SHALL keep the system's editing menu in text fields, because the webview's page menu (Refresh,
Save as, Print, More tools) does nothing useful in a desktop app, while Cut, Copy and Paste matter
where text is typed.

#### Scenario: Right-clicking the workspace shows no menu
- **GIVEN** the app showing a recording
- **WHEN** the person right-clicks the video, the transcript, the title bar or an empty part of the
  workspace
- **THEN** no menu appears
- **PROOF** test: src/app/useContextMenuGuard.test.ts::suppresses the webview menu outside text fields
- **PROOF** desk: open

#### Scenario: Right-clicking a text field keeps its editing menu
- **WHEN** the person right-clicks the search field, the vocabulary field, a title being renamed or
  Find in transcript
- **THEN** the system's editing menu appears, with Cut, Copy and Paste
- **PROOF** test: src/app/useContextMenuGuard.test.ts::keeps the system menu in text fields
- **PROOF** desk: open

### Requirement: The left panel's menu creates recordings and sections
The app SHALL open its own menu offering New recording and New section when the person
right-clicks the left panel outside a recording row or a section heading, because creating is what
that panel is for, and SHALL disable both items whenever their buttons are disabled, because a
menu never offers what would be refused.

#### Scenario: Right-clicking the left panel offers New recording and New section
- **GIVEN** no recording or processing in progress
- **WHEN** the person right-clicks the left panel outside a recording row or a section heading
- **THEN** a menu opens at the pointer with New recording, showing its shortcut, and New section
- **AND** choosing an item does what its button does
- **PROOF** test: src/Sidebar.test.tsx::right-clicking the panel offers New recording and New section
- **PROOF** desk: open

#### Scenario: Rows and section headings keep their own menus
- **WHEN** the person right-clicks a recording row or a section heading
- **THEN** that row's or section's own menu opens, not the panel's
- **PROOF** test: src/Sidebar.test.tsx::rows and section headings keep their own menus

#### Scenario: The left panel's menu is disabled while recording
- **GIVEN** a recording or its processing in progress
- **WHEN** the person right-clicks the left panel outside a recording row or a section heading
- **THEN** the menu opens with New recording and New section both disabled
- **PROOF** test: src/Sidebar.test.tsx::the panel menu disables its items while recording
