---
title: Look and feel
code:
  - src/app/useContextMenuGuard.ts
  - src/App.tsx
  - src/Sidebar.tsx
  - src/Sidebar.css
  - src/workspace/types.ts
  - src/ui/fonts.css
  - src/assets/fonts/
  - scripts/hint-figtree.py
  - src/styles.css
  - src/ui/tokens.css
  - src/ui/Dialog.css
  - src/ui/Dialog.tsx
  - src/dialogs/SettingsDialog.css
  - src/workspace/transcript.css
  - src/workspace/workspace.css
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
- **PROOF** test: src/App.test.tsx::cancels the webview menu across the workspace and keeps it in text fields
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

### Requirement: Scrollbars look like the app's
The app SHALL draw every scrollbar as a slim rounded thumb on a clear track, without arrow buttons,
more visible under the pointer, in both themes, and SHALL keep a dialog's scrollbar clear of its rounded
corners, because the default Windows scrollbar looks foreign beside the app's controls and its
square ends cut into a rounded dialog.

#### Scenario: A scrolling area shows the app's scrollbar
- **GIVEN** the sidebar, the transcript, a picker or a dialog with more content than fits
- **WHEN** the person looks at its scrollbar
- **THEN** it is a slim rounded thumb on a clear track with no arrow buttons
- **AND** the thumb gets more visible while the pointer is over it
- **PROOF** test: src/ui/lookAndFeel.test.ts::every scroll area uses the app scrollbar
- **PROOF** desk: open

#### Scenario: The Settings scrollbar clears the dialog's corners
- **GIVEN** Settings taller than the window
- **WHEN** the person scrolls it
- **THEN** the scrollbar starts and ends inside the dialog's straight edge, clear of its rounded
  corners
- **PROOF** test: src/ui/lookAndFeel.test.ts::keeps the dialog scrollbar clear of its corners
- **PROOF** desk: open

### Requirement: The Appearance dropdown looks like the app's
The app SHALL show the Appearance choice as a dropdown in the app's own style, its open list
included, with a check on the current theme, and SHALL keep it a native select, because the
system's dropdown looks unstyled beside the app's controls while a native select keeps keyboard,
typeahead and screen reader support.

#### Scenario: Opening the Appearance dropdown
- **GIVEN** Settings open
- **WHEN** the person opens the Appearance dropdown
- **THEN** a list in the app's menu style opens below it, with a check beside the current theme
- **AND** choosing the other theme applies it
- **PROOF** test: src/ui/lookAndFeel.test.ts::styles the Appearance dropdown and its open list
- **PROOF** test: src/dialogs/SettingsDialog.test.tsx::keeps the appearance, capability statuses and setup actions
- **PROOF** desk: open

### Requirement: Dialogs stand out from the app behind them
The app SHALL draw a dialog's close button as a crisp 16 px cross, and in the dark theme SHALL
darken the app behind a dialog to half black and lift the dialog one step lighter than the sheet,
because a thin cross looks jagged at 100% scaling, and a dark dialog over a barely dimmed dark app
does not read as in front.

#### Scenario: A dialog's close button is crisp
- **WHEN** a dialog with a close button is open
- **THEN** its cross is 16 px with 1.5 px strokes
- **PROOF** test: src/ui/Dialog.test.tsx::draws the close icon at 16 px with 1.5 px strokes
- **PROOF** desk: open

#### Scenario: A dialog in the dark theme stands out
- **GIVEN** the dark theme
- **WHEN** a dialog opens
- **THEN** the app behind it is darkened to half black and the dialog's surface is lighter than the
  sheet, with its text still legible
- **PROOF** test: src/ui/lookAndFeel.test.ts::darkens the backdrop in the dark theme and lifts the dialog
- **PROOF** desk: open

#### Scenario: The light theme keeps its backdrop
- **GIVEN** the light theme
- **WHEN** a dialog opens
- **THEN** the backdrop is a grey scrim at a third opacity and the dialog's surface is the sheet's
  white
- **PROOF** test: src/ui/lookAndFeel.test.ts::keeps the light theme backdrop
