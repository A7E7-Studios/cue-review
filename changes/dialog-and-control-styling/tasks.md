# Tasks: Style scrollbars, the Appearance dropdown and dialogs like the app

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks.

## 1. Scrollbars

- [x] 1.1 Global `::-webkit-scrollbar` rules and the scrollbar tokens; the `scrollbar-width: thin` rules go; test: src/ui/lookAndFeel.test.ts::every scroll area uses the app scrollbar
- [x] 1.2 The dialog's track keeps 12 px from its corners; test: src/ui/lookAndFeel.test.ts::keeps the dialog scrollbar clear of its corners

## 2. Dialogs (independent of 1)

- [x] 2.1 The close cross at 16 px, 1.5 px strokes; test: src/ui/Dialog.test.tsx::draws the close icon at 16 px with 1.5 px strokes
- [x] 2.2 Scrim and dialog surface tokens, darker and lifted in the dark theme; test: src/ui/lookAndFeel.test.ts::darkens the backdrop in the dark theme and lifts the dialog
- [x] 2.3 The light theme's backdrop unchanged; test: src/ui/lookAndFeel.test.ts::keeps the light theme backdrop

## 3. The Appearance dropdown (independent of 1 and 2)

- [x] 3.1 `appearance: base-select` with the app's menu style and a checkmark; test: src/ui/lookAndFeel.test.ts::styles the Appearance dropdown and its open list
- [x] 3.2 Choosing a theme still applies it; test: src/dialogs/SettingsDialog.test.tsx::keeps the appearance, capability statuses and setup actions

## 4. Docs and looks (after 1–3)

- [x] 4.1 docs/DESIGN.md states the scrollbar, dropdown and dialog rules; test: node tools/gate/gate.mjs --local
- [x] 4.2 The spec's looks rendered from Storybook; test: npm run build-storybook
