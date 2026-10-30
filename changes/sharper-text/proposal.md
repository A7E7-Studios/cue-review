---
title: Sharpen text by bundling an auto-hinted Figtree
capabilities:
  - workspace/look-and-feel
review: unreviewed
---
# Sharpen text by bundling an auto-hinted Figtree

## Why

At the app's 12–14 px text sizes, the owner finds the text "not fully sharp". The owner's display
runs at 100% scaling with ClearType on, and the app is not zoomed. The cause is the font: the
bundled Figtree variable font is unhinted (it has no TrueType instructions), so at 100% its stems
fall between pixels and render as grey fringes. Segoe UI, which is hinted, looks crisp beside it at
the same size.

- Evidence: `evidence/soft-text-1m24s.png`, "it might be because the font size is so small or so,
  but it has a bit of this feel that it's not sharp, not fully sharp" at 1:24–1:31.

## What changes

- The app bundles Figtree as auto-hinted static weights (400, 500, 600, 700, Latin and extended
  Latin) in place of the unhinted variable font. The typeface, sizes and line breaks stay the
  same ("Text renders sharply at 100% display scaling").
- Every weight the styles use has its own face, and a test fails when a style uses a weight
  without one ("Every weight the styles use has its own face").
- `scripts/hint-figtree.py` rebuilds the faces from the font package, reproducibly.

## Settled questions

- **Q2 Text sharpness**: Figtree, auto-hinted. The owner compared renders of today's Figtree, an
  auto-hinted Figtree and Segoe UI Variable at 100% scaling. Rejected: Segoe UI Variable on Windows
  (sharpest, but the app stops matching the Float v2 mocks); keeping the font and adjusting size or
  weight (stems stay soft).
- **Q7 Summary**: confirmed as written here.

## Calls for the owner

- **Hinting settings**: ttfautohint with its defaults, hinting up to 50 px and Windows
  compatibility on. The extended Latin subset lacks the letters ttfautohint measures, so it is
  hinted in symbol mode against the Latin face of the same weight. Other settings (a larger
  x-height, a different stem mode) are a change to the script and a rebuild.
- **Weights 400–700 only**: the styles use 400, 500, 600 and 700 (and `<strong>`, which resolves to
  700). The variable font offered 300–900; a new weight now needs a face first, which the test
  enforces.
- **The font package moves to devDependencies**: the app no longer imports
  `@fontsource-variable/figtree`; the script reads it. Rebuilding needs Python with `fonttools`,
  `brotli` and `ttfautohint-py`, named in the script.
- **Checked in Edge, not in the installed app**: the renders come from Storybook in Microsoft
  Edge at 100% scaling, the same Chromium engine and ClearType path as the app's WebView2. The
  owner's desk check confirms it in the installed app.

## Out of scope

- Font sizes and weights of the type scale (docs/DESIGN.md Typography): unchanged.
- macOS and Linux render without TrueType hinting; there the change is invisible.
