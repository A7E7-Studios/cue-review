# Look: Transcribe the system audio beside the microphone

## Pick

**F Chat sides, name on hover**: computer-audio rows sit on the left as rows do today; microphone
rows are inset 48 px and carry their time in a right-hand gutter, so who spoke shows at rest with
nothing added to a row. Hovering a row, or moving keyboard focus into it, shows a small tag above
it with an icon and the track's name, and its language when the two tracks differ; no text moves.
While recording each side has its own grey live box. The owner asked for a view that stays clear by
default, and the tag answers the rule that position alone may not carry meaning.

## Directions rejected

Each direction is shown in the default state and in the state that tells the directions apart.

- **F Chat sides, name on hover** (`look/directions/chat-sides-hover/`): the pick, drawn first as a
  direction.
- **E Chat sides** (`look/directions/chat-sides/`): the same layout without the tag, so nothing
  ever names the track and the side is the only cue.
- **D Hover reveal** (`look/directions/hover-reveal/`): no difference at rest, so a reader cannot
  find the reviewer's remarks in a long call without hovering row by row.
- **A Run headings** (`look/directions/run-headings/`), **B Track in the gutter**
  (`look/directions/track-in-gutter/`), **C Reviewer lane** (`look/directions/reviewer-lane/`): the
  first round, each marking every row or every run; the owner found all three cluttered.

## States drawn

| Screen | State | Image |
|---|---|---|
| Transcript | a two-track take in review, at rest | `look/transcript-review-two-tracks.png` |
| Transcript | the same, light theme | `look/transcript-review-two-tracks-light.png` |
| Transcript | a microphone row hovered | `look/transcript-review-hover.png` |
| Transcript | a row with keyboard focus | `look/transcript-review-focus.png` |
| Transcript | ten rows in a row from one side | `look/transcript-run-of-ten.png` |
| Transcript | recording, both tracks producing live words | `look/transcript-recording-two-tracks.png` |
| Transcript | the two tracks in different languages | `look/transcript-two-languages.png` |
| Transcript | the same with a row hovered | `look/transcript-two-languages-hover.png` |
| Transcript | a one-track take, then a two-track take | `look/transcript-one-then-two-tracks.png` |

A soft fill behind the microphone rows was tried and dropped: a run of rows became a stack of
bubbles, and the fill was close to the grey of the live box. Microphone rows keep about 25
characters per line at the 320 px column against 33 on the left, and about 18 at the 280 px
minimum, which is measured and not drawn. Find in transcript over two sides is not drawn either.

Transcript, a two-track take in review, at rest:

![Transcript, two tracks, at rest](look/transcript-review-two-tracks.png)

Transcript, the same, light theme:

![Transcript, two tracks, light](look/transcript-review-two-tracks-light.png)

Transcript, a microphone row hovered:

![Transcript, a row hovered](look/transcript-review-hover.png)

Transcript, a row with keyboard focus:

![Transcript, a row focused](look/transcript-review-focus.png)

Transcript, ten rows in a row from one side:

![Transcript, a run of ten](look/transcript-run-of-ten.png)

Transcript, recording, both tracks producing live words:

![Transcript, recording](look/transcript-recording-two-tracks.png)

Transcript, the two tracks in different languages:

![Transcript, two languages](look/transcript-two-languages.png)

Transcript, the same with a row hovered:

![Transcript, two languages, hovered](look/transcript-two-languages-hover.png)

Transcript, a one-track take, then a two-track take:

![Transcript, one track then two](look/transcript-one-then-two-tracks.png)

## Components

- **From the library:** the transcript row with its time button and words, the take divider with
  its language, the live box, the microphone and speaker icons.
- **New:** the right-hand time gutter of a microphone row; the track tag shown on hover and focus
  (an icon and a name on the row-hover surface, 999 px radius). Each row's time button names its
  track for a screen reader ("Seek to 0:21, microphone").

## Research

- The microphone as "Me" on the right and system audio as "Them" on the left (Granola,
  Transcription, docs.granola.ai/help-center/taking-notes/transcription).
- Speaker labels moved from the margin into the text made transcripts hard to scan (Descript,
  feedback, feedback.descript.com/features/p/speaker-labels-shouldnt-clutter-transcript).
- Each speaker labelled once and applied throughout (Descript, Speaker detection,
  help.descript.com/script-editing/speaker-detection).
- Adjacent entries of one speaker merged for reading (endjin, TeamsTranscript,
  github.com/endjin/TeamsTranscript).
- Colour or position may mark a difference only if shape or text repeats it (W3C, WCAG 2.2,
  Understanding 1.4.1, www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).
