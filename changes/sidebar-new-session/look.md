# Look: Start a session from a plain New session row and create sections from the sidebar menu

## Pick

**Plain row**: "+ New session" as a row with a plus, like a session row (hover tint, no frame, no
shadow), and nothing beside it. It is how the Claude desktop app starts a session, which the owner
named as the model, and it no longer competes with the workspace's own primary action.

## Directions rejected

Each direction is shown in review and with the sidebar's menu open.

- **Button** (`look/directions/button/`): today's white raised button with a plus where the red dot
  was; it keeps a second primary-looking control in the sidebar.

## States drawn

| Screen | State | Image |
|---|---|---|
| workspace | review, light | `look/workspace-review-light.png` |
| workspace | review, dark | `look/workspace-review-dark.png` |
| workspace | recording (New session dimmed) | `look/workspace-recording.png` |
| sidebar | menu on empty space | `look/sidebar-menu.png` |
| sidebar | menu while recording (items disabled) | `look/sidebar-menu-recording.png` |

Workspace, review, light:

![Review, light](look/workspace-review-light.png)

Workspace, review, dark:

![Review, dark](look/workspace-review-dark.png)

Workspace, recording:

![Recording](look/workspace-recording.png)

Sidebar, menu on empty space:

![Sidebar menu](look/sidebar-menu.png)

Sidebar, menu while recording:

![Sidebar menu while recording](look/sidebar-menu-recording.png)

## Components

- **From the library:** the sidebar row styles (`--color-row-hover`, `--radius-row`), the sidebar
  menu (`.sidebar-menu`), the `plus` icon.
- **New:** none.

## Research

- The Claude desktop app starts a session from a "+ New session" row at the top of its sidebar, and
  keeps its create actions in the sidebar's right-click menu (the owner's reference).
- Windows: a context menu holds the commands for what was right-clicked, and Shift+F10 or the
  context menu key opens it from the keyboard (Microsoft Learn, "Menus and context menus",
  https://learn.microsoft.com/en-us/windows/apps/design/controls/menus-and-context-menus).
