# Tasks: Choose playback speed from a list, and focus the video by hiding both sidebars

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. Playback speed

- [x] 1.1 `SpeedControl`: a list of 0.5× to 2× with a check, chosen by pointer; test: src/workspace/PlaybackBar.test.tsx::chooses a speed from the speed list
- [x] 1.2 The list's keyboard: opens on the current speed, arrows, Enter or Space, Escape; test: src/workspace/PlaybackBar.test.tsx::chooses a speed with the keyboard
- [x] 1.3 A fixed 56px width; test: src/workspace/playbackStyles.test.ts::gives the speed button a fixed width
- [x] 1.4 The chosen speed is kept in local storage and applied to each video as it loads; test: src/App.test.tsx::keeps the chosen speed for the next recording and the next start
- [x] 1.5 `scripts/verify-native-ux.cjs` chooses 1.5× from the list and checks the button keeps its width; test: node scripts/verify-native-ux.cjs --review-only

## 2. Focus video (independent of 1)

- [x] 2.1 Focus video keeps its icon and carries `aria-pressed`; test: src/workspace/PlaybackBar.test.tsx::shows Focus video pressed with the same icon
- [x] 2.2 Focus hides the sidebar and the transcript, also if the window widens meanwhile; test: src/App.test.tsx::keeps both sidebars hidden in focus when a narrow window widens
- [x] 2.3 A second press or Escape restores both, the sidebar docked again only if it was before; test: src/App.test.tsx::docks the sidebar again after focus even if the window narrowed meanwhile
- [x] 2.4 Show sidebar or a new recording ends focus; a search does not; test: src/App.test.tsx::ends focus when the sidebar is shown or the workspace leaves review
- [x] 2.5 Update README.md and `docs/DESIGN.md`; test: node tools/gate/gate.mjs --local
