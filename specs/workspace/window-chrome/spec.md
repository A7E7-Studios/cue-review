---
title: Window chrome
code:
  - src/chrome/
  - src/icons.tsx
  - src/ui/tokens.css
  - src/app/useSidebarLayout.ts
  - src/App.tsx
  - src/styles.css
  - scripts/verify-native-ux.cjs
---
# Window chrome

## Purpose

The bar across the top of the window: the app's name, the sidebar toggle, search, Settings and, on
Windows, Minimize, Maximize and Close. Its toggle hides and shows the sidebar.

## Requirements

### Requirement: The title bar has room around its controls
The app SHALL draw the Windows title bar and the Linux toolbar 44px tall, with 46×44 window
controls, because a 40px bar made its controls feel cramped.

#### Scenario: A person looks at the title bar on Windows
- **WHEN** the review workspace shows on Windows
- **THEN** the title bar is 44px tall
- **AND** Minimize, Maximize and Close are each 46×44
- **PROOF** test: src/chrome/chromeSizes.test.ts::the title bar is 44px with 46×44 window controls
- **PROOF** test: scripts/verify-native-ux.cjs
- **PROOF** desk: open

### Requirement: Title bar icons are legible
The app SHALL draw the window-control glyphs 10×10px with crisp 1px lines, as Windows draws its
own, and the sidebar toggle and Settings icons 20px in 36×32 buttons, because smaller icons looked
tiny and soft beside other apps.

#### Scenario: A person compares the window controls with another Windows app
- **WHEN** the title bar shows on Windows at 100% scaling
- **THEN** the Minimize, Maximize, Restore and Close glyphs each span 10×10px with 1px lines on
  whole pixels
- **AND** the sidebar toggle and Settings icons are 20px in 36×32 buttons
- **PROOF** test: src/chrome/TitleBar.test.tsx::draws window-control glyphs at 10px and toolbar icons at 20px
- **PROOF** test: src/chrome/chromeSizes.test.ts::toolbar icon buttons are 36×32
- **PROOF** desk: open

### Requirement: The sidebar slides when it hides or shows
The app SHALL slide the sidebar out and in over 200ms with the workspace widening and narrowing
with it, and SHALL change it at once while recording or under reduced motion, because a sidebar
that vanishes in one frame reads as a glitch, while live video is never resized by an animation.

#### Scenario: A person hides and shows the sidebar
- **GIVEN** the sidebar shows beside the workspace and nothing is recording
- **WHEN** the person presses Hide sidebar
- **THEN** the sidebar slides out over 200ms while the workspace widens with it
- **AND** Show sidebar slides it back in the same way
- **PROOF** test: src/App.test.tsx::slides the sidebar out and in
- **PROOF** desk: open

#### Scenario: The sidebar changes at once while recording
- **GIVEN** a recording in progress
- **WHEN** the person hides or shows the sidebar
- **THEN** it hides or shows in one frame, without a slide
- **PROOF** test: src/App.test.tsx::hides the sidebar at once while recording
- **PROOF** desk: open

#### Scenario: The sidebar changes at once under reduced motion
- **GIVEN** the system asks for reduced motion
- **WHEN** the person hides or shows the sidebar
- **THEN** it hides or shows in one frame, without a slide
- **PROOF** test: src/chrome/chromeSizes.test.ts::the sidebar slide is instant under reduced motion
- **PROOF** desk: open
