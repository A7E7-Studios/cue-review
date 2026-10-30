---
title: Capture source selection
code:
  - src/app/useCaptureDevices.ts
---
# Capture source selection

## Purpose

The source picker puts the sources most useful for a visual review first and starts with an
available source. Refreshing the list respects the source the person has chosen.

## Requirements

### Requirement: Sources are ordered for a visual review
The app SHALL list displays, then windows, then Android and Quest devices, then cameras, because
a reviewer usually shows work on a screen or device and selects a camera deliberately.

#### Scenario: A camera is discovered before a display
- **GIVEN** discovery returns a camera before a display, a window and an Android or Quest device
- **WHEN** the person opens the source picker
- **THEN** the display is first, followed by the window, the device and the camera
- **AND** sources within the same category keep their discovery order
- **PROOF** test: src/App.test.tsx::lists displays windows and devices before cameras
- **PROOF** desk: open

### Requirement: Initial selection uses the first available source in picker order
The app SHALL initially select the first available source in picker order, because an unavailable
entry must not displace a usable display, window, device or camera.

#### Scenario: First use selects an available display before a camera
- **GIVEN** discovery returns an available camera before an available display
- **WHEN** the app first loads its capture sources
- **THEN** the display is selected
- **AND** the camera remains available for explicit selection
- **PROOF** test: src/App.test.tsx::initially selects a display before a camera
- **PROOF** desk: open

#### Scenario: An unavailable display is skipped
- **GIVEN** the display and window entries are unavailable and a device and camera are available
- **WHEN** the app first loads its capture sources
- **THEN** the available device is selected
- **PROOF** test: src/App.test.tsx::skips unavailable sources when selecting the initial source

#### Scenario: A camera is the only available source
- **GIVEN** cameras are available and no display, window or device is available
- **WHEN** the app first loads its capture sources
- **THEN** the first available camera is selected
- **PROOF** test: src/App.test.tsx::selects a camera when no higher priority source is available

#### Scenario: No source is available
- **GIVEN** discovery returns no sources or only unavailable sources
- **WHEN** the app first loads its capture sources
- **THEN** no source is selected automatically
- **AND** recording is unavailable until the person selects an available source
- **PROOF** test: src/App.test.tsx::does not select an unavailable initial source

### Requirement: Refresh preserves an explicit choice
The app SHALL preserve an explicit source choice when refreshing sources, because discovering a
display must not silently redirect a recording the person intended to make with a camera or device.

#### Scenario: A selected camera stays selected when a display appears
- **GIVEN** the person has selected a camera
- **WHEN** refreshing discovers an available display before that camera
- **THEN** the camera stays selected
- **AND** the display appears in its normal position in the picker
- **PROOF** test: src/App.test.tsx::keeps an explicit camera selection when a display appears

#### Scenario: A selected camera disappears
- **GIVEN** the person has selected a camera
- **WHEN** refreshing no longer finds that camera
- **THEN** the selected source is shown as unavailable
- **AND** the app does not select a different source automatically
- **PROOF** test: src/App.test.tsx::preserves a missing camera as an unavailable selection
