---
title: Look and feel
code:
  - src/app/useContextMenuGuard.ts
  - src/App.tsx
  - src/ui/fonts.css
  - src/assets/fonts/
  - scripts/hint-figtree.py
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

### Requirement: Text is sharp at 100% display scaling
The app SHALL set its text in a hinted build of its typeface, in every weight its styles use,
because the unhinted Figtree blurs at the app's 12–14 px sizes on a display at 100% scaling, and a
weight without its own face would render in the nearest declared weight instead of its own.

#### Scenario: Text renders sharply at 100% display scaling
- **GIVEN** Windows at 100% display scaling
- **WHEN** the person reads the sidebar, the transcript and Settings
- **THEN** letter stems are crisp, with no grey fringe beside each stroke
- **AND** the text keeps the Float v2 typeface, sizes and line breaks
- **PROOF** test: src/ui/fonts.test.ts::ships hinted static Figtree faces
- **PROOF** test: src/ui/fonts.test.ts::is the family the app and Storybook set text in
- **PROOF** desk: open

#### Scenario: Every weight the styles use has its own face
- **WHEN** a style sets a font weight
- **THEN** the bundled typeface has a face of that weight for Latin and extended Latin text
- **PROOF** test: src/ui/fonts.test.ts::declares a face for every weight the styles use
