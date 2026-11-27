---
title: Let a long source list scroll
capabilities:
  - workspace/recording-dock
review: unreviewed
---
# Let a long source list scroll

## Why

With more displays, windows and devices than fit beside the recording bar, the source picker's
list could not be scrolled: every scroll snapped it back to the top, so the sources past the fold,
an Android or Quest device among them, could not be chosen. The owner met it choosing a display.

## What changes

- The source and microphone lists scroll and stay where the reviewer scrolled them; resizing the
  window or scrolling the page still re-places the picker. Scenario: Scrolling to the last source.

## Settled questions

None: the fix restores what the picker's layout already intended.

## Calls for the owner

- The picker is re-placed for a scroll anywhere except inside its own panel, and each list keeps
  its scroll position across a re-placement. The alternative, measuring the panel without lifting
  its height cap, needs the list's natural height from its children; reversing costs nothing.

## Out of scope

- How many sources the picker lists and their order: `capture/source-selection`.
