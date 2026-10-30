# Look: Move to section as a submenu, and new sessions straight into a section

## Pick

**The Claude app's submenu, copied**: Move to section opens its list beside the recording's menu
instead of replacing it, so the person keeps their place, which is what the owner asked for ("look at
how the Claude app does it and copy this basically one to one"). The current section is checked and
greyed, New section… comes last, and the list flips to the left when the right has no room. Section
headings show a + beside their … menu on hover, as the Claude app's section headings do.

## Directions rejected

The owner settled the direction before anything was drawn (copy the Claude app; Q8 for the +), so
no other direction was rendered.

- **The menu swapping its items for the section list** (today): loses the person's place and does
  not open as the pointer reaches it.
- **A + beside the Recents heading as well** (Q8): Recents is where a plain New session lands
  already.

## States drawn

| Screen | State | Image |
|---|---|---|
| Recording menu | Move to section open, light | `look/move-submenu-light.png` |
| Recording menu | Move to section open, dark | `look/move-submenu-dark.png` |
| Recording menu | opened with → in a narrow window, flipped left | `look/move-submenu-flipped-narrow.png` |
| Section heading | hovered, light | `look/section-heading-hover-light.png` |
| Section heading | hovered, dark | `look/section-heading-hover-dark.png` |
| Section menu | open, with New section… | `look/section-menu.png` |

Recording menu, Move to section open, light:

![Move to section open, light](look/move-submenu-light.png)

Recording menu, Move to section open, dark:

![Move to section open, dark](look/move-submenu-dark.png)

Recording menu, opened with → in a narrow window, flipped left:

![Submenu flipped left](look/move-submenu-flipped-narrow.png)

Section heading, hovered, light:

![Section heading hovered, light](look/section-heading-hover-light.png)

Section heading, hovered, dark:

![Section heading hovered, dark](look/section-heading-hover-dark.png)

Section menu, open:

![Section menu](look/section-menu.png)

## Components

- **From the library:** the sidebar's menu (`.sidebar-menu`), its roving focus and typeahead, the
  section heading's icon button, `Icon` (`chevron`, `check`, `plus`), the motion tokens.
- **New:** the submenu (`.sidebar-submenu`) and `placeSubmenu`, the pure function that places it
  beside its menu; the library had no submenu.

## Research

- The Claude app builds its menus on Radix; a Radix submenu opens on pointer rest, click, → and
  Enter, closes on ← and Escape, sits beside its trigger with its first item level with it, and flips
  to the other side when it collides with the viewport
  (https://www.radix-ui.com/primitives/docs/components/dropdown-menu#sub).
- WAI-ARIA menu pattern: → opens a submenu and focuses its first item, ← closes it and returns focus
  to its parent item, Escape closes the current menu
  (https://www.w3.org/WAI/ARIA/apg/patterns/menubar/).
- The design system's context-menu motion: 120ms opacity (`docs/DESIGN.md`).
