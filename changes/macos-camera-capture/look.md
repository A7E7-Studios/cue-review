# Look: Prefer displays and make macOS camera capture usable

## Pick

**Existing picker, review-first order**: Q3 explicitly keeps the current picker design. Retain its
components, keyboard behaviour, tokens and accessible names; show displays before windows, devices
and cameras, with the selected source checked. Use the existing inline error and Retry for a blocked
camera, adding useful guidance to the message.

This visual direction is settled by Q3. The owner approved the technical design in Q4.

## Directions rejected

The owner instructed that the picker design stay unchanged, so no alternative layouts or new
components are proposed. Hiding the built-in camera was rejected in Q1; keeping the camera first
would contradict the confirmed initial selection.

## States drawn

These 1280 by 820 renders use the repository's actual CaptureControls and MediaStage components
with illustrative fixtures. They activate no recording hardware. Other selection and unavailable
source states keep their current presentation.

| Screen | State |
|---|---|
| Recording draft | Display selected, ordered picker open |
| Recording draft | Camera deliberately selected, ordered picker open |
| Recording draft | Camera blocked, existing error and Retry |

## Components

- **From the library:** CaptureControls, its anchored popover and OptionList, MediaStage, Icon,
  the existing Retry button and Float v2 tokens.
- **New:** None.

## Research

- The repository's [design system](../../docs/DESIGN.md) defines text-only source options and inline
  errors with Retry; those are retained.
- [Apple camera access](https://support.apple.com/guide/mac-help/control-access-to-your-camera-mchlf6d108da/mac)
  identifies System Settings as the place to allow a third-party app, so blocked-access guidance
  names that action.
- [Image intrinsic dimensions](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/naturalWidth)
  distinguish an image with available dimensions from one with no available data; use that
  distinction for preview startup failure without adding a new loading presentation.
