# Tasks: Stop the webview's page menu on right-click

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks.

## 1. The document guard

- [x] 1.1 `useContextMenuGuard` cancels the `contextmenu` event outside text fields; test: src/app/useContextMenuGuard.test.ts::suppresses the webview menu outside text fields
- [x] 1.2 Text fields keep the system menu; test: src/app/useContextMenuGuard.test.ts::keeps the system menu in text fields
- [x] 1.3 `App` installs the guard; test: src/App.test.tsx::cancels the webview menu across the workspace and keeps it in text fields
- [x] 1.4 docs/DESIGN.md states the right-click rule; test: node tools/gate/gate.mjs --local
