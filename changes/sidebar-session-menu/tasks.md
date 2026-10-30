# Tasks: Move to section as a submenu, and new sessions straight into a section

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. The submenu

- [x] 1.1 `placeSubmenu`: beside the menu, flipped left at the right edge, shifted up at the bottom; test: src/ui/submenuPlacement.test.ts
- [x] 1.2 Move to section opens the submenu on pointer rest, click, → and Enter; ← and Escape close it; test: src/Sidebar.test.tsx::opens Move to section as a submenu on hover
- [x] 1.3 Moving with the keyboard, focus back on the moved row; test: src/Sidebar.test.tsx::moves a recording through the submenu with the keyboard
- [x] 1.4 → into a submenu the pointer opened, and a timed close returns focus; test: src/Sidebar.test.tsx::moves focus into a submenu the pointer already opened
- [x] 1.5 New section… ends the submenu; test: src/Sidebar.test.tsx::offers New section at the end of the submenu
- [x] 1.6 `scripts/verify-sidebar.cjs` opens the submenu by hovering and checks it sits beside the menu; test: node scripts/verify-sidebar.cjs

## 2. Making sections and sessions (independent of 1)

- [x] 2.1 New section… in a section's … menu; test: src/Sidebar.test.tsx::offers New section in a section's menu
- [x] 2.2 The + on a section heading, hidden while recording or searching; test: src/Sidebar.test.tsx::hides the new-session button while a search filters the sidebar
- [x] 2.3 A session started there records into that section; test: src/App.test.tsx::files a session started from a section heading in that section
- [x] 2.4 Update `docs/DESIGN.md` (no README under `src/`; README.md's sidebar paragraph still holds); test: node tools/gate/gate.mjs --local
