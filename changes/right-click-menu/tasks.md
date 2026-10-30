# Tasks: Replace the webview's right-click menu with menus that matter

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks.

## 1. The document guard

- [x] 1.1 `useContextMenuGuard` cancels the `contextmenu` event outside text fields; test: src/app/useContextMenuGuard.test.ts::suppresses the webview menu outside text fields
- [x] 1.2 Text fields keep the system menu; test: src/app/useContextMenuGuard.test.ts::keeps the system menu in text fields
- [x] 1.3 `App` installs the guard; test: src/App.test.tsx::cancels the webview menu across the workspace and keeps it in text fields

## 2. The left panel's menu (independent of 1)

- [x] 2.1 A `panel` menu kind with New recording (shortcut shown) and New section; test: src/Sidebar.test.tsx::right-clicking the panel offers New recording and New section
- [x] 2.2 Rows and section headings keep theirs; test: src/Sidebar.test.tsx::rows and section headings keep their own menus
- [x] 2.3 Both items disabled while locked; test: src/Sidebar.test.tsx::the panel menu disables its items while recording
- [x] 2.4 Storybook stories `PanelMenu` and `PanelMenuBusy`, the spec's looks rendered from them; test: npm run build-storybook
- [x] 2.5 docs/DESIGN.md states the right-click rule; test: node tools/gate/gate.mjs --local
