# Tasks: Give the title bar room, legible icons and a sliding sidebar

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. Title bar

- [x] 1.1 `--size-titlebar` 44px, 36×32 icon buttons with 20px icons; test: src/chrome/chromeSizes.test.ts
- [x] 1.2 `WindowGlyph`: 10×10 window-control glyphs with 1px lines; test: src/chrome/TitleBar.test.tsx::draws window-control glyphs at 10px and toolbar icons at 20px
- [x] 1.3 `scripts/verify-native-ux.cjs` expects 44px and 46×44; check: A person looks at the title bar on Windows
- [x] 1.4 Update `docs/DESIGN.md` and `docs/VERIFICATION.md` (no README under `src/`); test: node tools/gate/gate.mjs --local

## 2. Sidebar slide (independent of 1)

- [x] 2.1 `useSidebarSlide` keeps the sidebar mounted and inert while it slides out; test: src/App.test.tsx::slides the sidebar out and in
- [x] 2.2 Instant beside a live preview or a recording; test: src/App.test.tsx::hides the sidebar at once beside live video
- [x] 2.3 Over the sheet in a narrow window; test: src/App.test.tsx::slides the sidebar over the sheet in a narrow window
- [x] 2.4 `--motion-sidebar`, 0ms under reduced motion, and no delayed unmount; test: src/App.test.tsx::hides the sidebar at once under reduced motion
- [x] 2.5 Update the motion contract in `docs/DESIGN.md`; test: node tools/gate/gate.mjs --local
