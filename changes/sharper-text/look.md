# Look: Sharpen text by bundling an auto-hinted Figtree

## Pick

**Auto-hinted Figtree** (`look/directions/autohinted-figtree/`): the owner picked it (Q2) from
renders at 100% scaling. It keeps the Float v2 typeface and every line break, while ClearType
snaps stems and the x-height to whole pixels, so text reads close to Segoe UI's sharpness.

## Directions rejected

Each direction is drawn as the same sample line at 13.5 px and 12 px in Edge at 100% scaling.

- **Segoe UI Variable** (`look/directions/segoe-ui-variable/`): the sharpest, but the app would
  stop looking like the Float v2 mocks on Windows.
- **Keep Figtree, adjust size and weight** (`look/directions/size-and-weight/`): today's font at
  13.5/400, 14/400, 13.5/450 and 14/450; heavier text is darker, but its stems stay soft.

## States drawn

| Screen | State | Image |
|---|---|---|
| Review workspace | light | `look/review-light.png` |
| Review workspace | dark | `look/review-dark.png` |
| Settings | before (top) and after (bottom), zoomed 2× | `look/settings-before-after.png` |

Review workspace, light:

![Review workspace, light](look/review-light.png)

Review workspace, dark:

![Review workspace, dark](look/review-dark.png)

Settings, before (top) and after (bottom), zoomed 2×:

![Settings before and after](look/settings-before-after.png)

## Components

- **From the library:** every component, unchanged; only the font faces behind `--font-family`
  change.
- **New:** `src/ui/fonts.css`, the hinted faces.

## Research

- Unhinted fonts at small sizes on Windows: Windows rasterizes with ClearType, which aligns stems
  to pixels only through TrueType instructions; ttfautohint generates them for fonts that ship
  without (ttfautohint manual, freetype.org/ttfautohint).
- The bundled `figtree-latin-wght-normal.woff2` has no `fpgm` or `cvt ` table and a `gasp` of 15
  for every size: unhinted, smoothed at all sizes (inspected with fontTools).
- The owner's machine: 96 DPI (100%), ClearType on (`FontSmoothingType` 2), and the app's
  WebView2 reports `devicePixelRatio` 1 with no zoom, so neither scaling nor zoom adds the blur.
