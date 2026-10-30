# Look: Style scrollbars, the Appearance dropdown and dialogs like the app

## Pick

Picked by the agent on the owner's delegation (the owner was away); the reasons are under the
proposal's Calls for the owner (Q8–Q11).

- **Slim rail** (`look/directions/slim-rail/`): a 4 px rounded thumb in a 10 px gutter, no arrows,
  kept 12 px clear of the dialog's corners. Always visible, so Settings shows that it scrolls.
- **Styled dropdown** (`look/directions/styled-dropdown/`): still a native select; its open list
  looks like the app's menus, with a check on the current theme.
- **Darker and lifted** (`look/directions/darker-and-lifted/`): 50% black behind, the dialog one
  step lighter than the sheet, as dark themes show elevation.
- **Close cross**: 16 px with 1.5 px strokes, in place of 15 px with 1 px diagonals.

## Directions rejected

Each is drawn in Settings over the review workspace, 1280×820 at 100% scaling.

- **Hover-reveal scrollbar** (`look/directions/hover-reveal/`): hides that the dialog scrolls, and
  WebView2 repainted its thumb late (the render shows the pointer over the dialog, thumb hidden).
- **Native thin scrollbar** (`look/directions/native-thin/`): keeps Chromium's arrow buttons and
  ignores the corner inset.
- **Segmented Light | Dark** (`look/directions/segmented/`): one click, but no longer the dropdown
  the owner pointed at.
- **Styled field, system list** (`look/directions/styled-field/`): the open list, which is what
  looked unstyled, stays the system's.
- **Darker only** (`look/directions/darker-only/`): 60% black; the split comes only from the back.

## States drawn

| Screen | State | Image |
|---|---|---|
| Settings | light, scrolled content, pointer over the dialog | `look/settings-light.png` |
| Settings | dark | `look/settings-dark.png` |
| Settings | Appearance open, light | `look/appearance-open-light.png` |
| Settings | Appearance open, dark | `look/appearance-open-dark.png` |

Settings, light:

![Settings, light](look/settings-light.png)

Settings, dark:

![Settings, dark](look/settings-dark.png)

Settings, Appearance open, light:

![Appearance open, light](look/appearance-open-light.png)

Settings, Appearance open, dark:

![Appearance open, dark](look/appearance-open-dark.png)

## Components

- **From the library:** the Dialog (`src/ui/Dialog.tsx`), the sidebar menu's surface, rows and
  shadow for the open list, the `close` icon, the tokens.
- **New:** tokens `--color-scrollbar`, `--color-scrollbar-hover`, `--color-scrim`,
  `--color-dialog` and `--color-dialog-edge`.

## Research

- Fluent 2's `colorBackgroundOverlay` is 40% black in the light theme and 50% black in the dark
  one (fluent2.microsoft.design/color-tokens2).
- Chrome 135 made `<select>` customizable with `appearance: base-select` and `::picker(select)`,
  keeping its native keyboard and accessibility behaviour (developer.chrome.com/blog/a-customizable-select).
  The app's WebView2 is Chromium 156.
- Chromium ignores `::-webkit-scrollbar` styling on an element that sets `scrollbar-width` or
  `scrollbar-color` (Chrome 121), so the app's `scrollbar-width: thin` rules go.
