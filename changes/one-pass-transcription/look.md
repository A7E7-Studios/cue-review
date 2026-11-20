# Look: Transcribe a take while it is recorded and refine it after Stop

## Pick

**Rows and the live box**: finished stretches become ordinary rows with their time as soon as they
are final, and only the words still being heard sit in the live box, greyed, with the red caret and
the note "Grey words are still being heard and may change." The box is the one people already know;
the boundary between final and unsettled words is a container, not only a colour, as WCAG's use of
colour asks.

## Directions rejected

Each direction is shown in the default state and in the state that tells the directions apart.

- **Rows and the live box**: the pick, drawn first as a direction.
- **One row**: the unsettled words continue the last row in grey
  italics; the grey is barely apart from the transcript's text at AA contrast, so the boundary is
  lost.

## States drawn

| Screen | State |
|---|---|
| Transcript column | recording, a finished stretch and words still being heard |
| Transcript column | the same, dark |

## Components

- **From the library:** the transcript row, the live box (`.cr-row.is-tail` on
  `--color-live-tail`), the live caret and note, the take divider.
- **New:** none.

## Research

- Live captions (Windows Live Captions, Google Meet) show unstable words apart from settled ones and
  settle them in place; text people read should not move once final.
- WCAG 2.2 1.4.3 (contrast minimum) keeps the greyed words at 4.5:1, and 1.4.1 (use of colour) asks
  for a second cue besides colour; the box is that cue (w3.org/TR/WCAG22).
