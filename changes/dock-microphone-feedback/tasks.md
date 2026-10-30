# Tasks: Show the microphone's level, name and mute plainly in the recording dock

Each task is one line and names how it is proven: `test:` a test path or a command, or `check:` the
scenario a person checks. A `test:` task is ticked when its test passes; a `check:` task when its
work is done and its scenario carries `<check>: open`. Each group ends by updating the README
nearest the code it changes.

## 1. Level (src-tauri/src/capture.rs)

- [ ] 1.1 Hold the loudest packet RMS until the status reads it, then reset; test: src-tauri/src/capture.rs::tests::the_level_is_the_loudest_since_it_was_read
- [ ] 1.2 Update docs/ARCHITECTURE.md where it describes the live level; test: node tools/gate/gate.mjs --local

## 2. Dock (src/workspace/RecordingDock.tsx, workspace.css, types.ts)

- [ ] 2.1 Meter on −60 to 0 dBFS, one bar per 6 dB, the top two high; test: src/workspace/RecordingDock.test.tsx::RecordingDock lights one bar per 6 dB above −60 dBFS
- [ ] 2.2 The microphone chip with the short name, the meter and the mute toggle; test: src/workspace/RecordingDock.test.tsx::RecordingDock names the microphone on its chip
- [ ] 2.3 Muted: live colour, "Muted", a flat meter, the same width; test: src/workspace/RecordingDock.test.tsx::RecordingDock keeps the chip and a flat meter while muted, and says Muted
- [ ] 2.4 The container-query steps for the new widest dock, the name dropping before the meter; check: Muting the microphone while recording
- [ ] 2.5 Stories for speaking, muted, dark and narrow, and the spec looks; test: npm run build-storybook
- [ ] 2.6 Update docs/DESIGN.md (the dock); test: node tools/gate/gate.mjs --local

## 3. App (src/App.tsx) (after 2)

- [ ] 3.1 Pass the microphone's name to the dock; test: src/App.test.tsx::a mute from the dock ends with its take
- [ ] 3.2 Reset the mute when a take stops; test: src/App.test.tsx::a mute from the dock ends with its take
