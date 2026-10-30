# Tasks: Search recordings and transcripts from the sidebar, and slide in Find

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. Search index

- [x] 1.1 `searchIndex`: normalise, match every word, mark matches, recent recordings, limits, newest first; test: src/search/searchIndex.test.ts

## 2. The search window (after 1)

- [x] 2.1 `SearchDialog`: field, recent recordings, Recordings and In transcripts, ↑↓ and Enter, No matches; test: src/search/SearchDialog.test.tsx
- [x] 2.2 App: the Search row and Ctrl+K open it, unavailable while recording; transcripts load when it opens; test: src/App.test.tsx::opens search from the sidebar and with Ctrl+K
- [x] 2.3 A line opens its recording at its time, paused; test: src/App.test.tsx::opens a transcript line at its time
- [x] 2.4 The title bar's field and the sidebar's filter go; test: src/chrome/TitleBar.test.tsx::has no search field

## 3. Find in transcript (independent of 1 and 2)

- [x] 3.1 Ctrl+F opens Find; the bar slides open over 180ms; test: src/workspace/TranscriptPane.test.tsx::opens the find bar with Ctrl+F

## 4. Docs and scripts (after 2 and 3)

- [x] 4.1 `scripts/verify-sidebar.cjs` searches through the window; test: node scripts/verify-sidebar.cjs
- [x] 4.2 Update README.md and `docs/DESIGN.md`; test: node tools/gate/gate.mjs --local
