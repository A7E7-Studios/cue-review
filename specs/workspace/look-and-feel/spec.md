---
title: Look and feel
code:
  - src/app/useContextMenuGuard.ts
  - src/App.tsx
---
# Look and feel

## Purpose

The behaviour and look every screen of the app shares: what a right-click offers, how scrollbars,
form fields and dialogs look, and how sharply text renders. It makes the app feel like one desktop
app rather than a web page in a window.

## Requirements

### Requirement: Right-click never shows the webview's page menu
The app SHALL show no menu when the person right-clicks anywhere without a menu of its own (the
sidebar's menus are in the sidebar capability), and SHALL keep the system's editing menu in text
fields, because the webview's page menu (Refresh, Save as, Print, More tools) does nothing useful in
a desktop app, while Cut, Copy and Paste matter where text is typed.

#### Scenario: Right-clicking the workspace shows no menu
- **GIVEN** the app showing a recording
- **WHEN** the person right-clicks the video, the transcript, the title bar or an empty part of the
  workspace
- **THEN** no menu appears
- **PROOF** test: src/app/useContextMenuGuard.test.ts::suppresses the webview menu outside text fields
- **PROOF** test: src/App.test.tsx::cancels the webview menu across the workspace and keeps it in text fields
- **PROOF** desk: open

#### Scenario: Right-clicking a text field keeps its editing menu
- **WHEN** the person right-clicks the search field, the vocabulary field, a title being renamed or
  Find in transcript
- **THEN** the system's editing menu appears, with Cut, Copy and Paste
- **PROOF** test: src/app/useContextMenuGuard.test.ts::keeps the system menu in text fields
- **PROOF** desk: open
