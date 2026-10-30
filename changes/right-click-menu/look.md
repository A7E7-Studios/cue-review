# Look: Replace the webview's right-click menu with menus that matter

## Pick

**The sidebar's own menu**: the left panel's menu is the menu the sidebar already opens on a row or
a section heading, with the same surface, rows, focus ring and 120 ms motion, plus the shortcut at
the right of New recording. One menu style in the panel means nothing new to learn, and it matches
the Claude app, which the owner named as the reference. Picked by the agent on the owner's
delegation (the owner was away); Q11 under the proposal's Calls for the owner.

## Directions rejected

No other direction was drawn. A second menu style in the same panel would make the two menus look
like different things, and the other half of the change (no menu at all) has no look.

## States drawn

| Screen | State | Image |
|---|---|---|
| Left panel | menu open | `look/left-panel-menu-default.png` |
| Left panel | menu open, dark | `look/left-panel-menu-dark.png` |
| Left panel | menu open while recording | `look/left-panel-menu-recording.png` |

Left panel, menu open:

![Left panel menu](look/left-panel-menu-default.png)

Left panel, menu open, dark:

![Left panel menu, dark](look/left-panel-menu-dark.png)

Left panel, menu open while recording:

![Left panel menu while recording](look/left-panel-menu-recording.png)

## Components

- **From the library:** the sidebar menu (`.sidebar-menu`, `src/Sidebar.css`), its keyboard
  handling and presence motion, the shortcut label from `shortcut()` in `src/chrome/windowApi.ts`.
- **New:** none.

## Research

- The Claude desktop app, the owner's reference: its conversation pane offers no menu on a
  right-click, and its sidebar offers creating a new item there (the owner's account, Q1).
- WebView2's default menus include page commands (Refresh, Save as, Print) that an app turns off
  or replaces; a `contextmenu` handler calling `preventDefault` suppresses the default menu for that
  event (Microsoft Learn, "Customize context menus in WebView2").
