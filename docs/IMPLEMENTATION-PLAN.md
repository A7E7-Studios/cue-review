# CueReview v0.2.0 implementation plan: Float v2, takes and agent tooling

This file coordinates the agents implementing v0.2.0. The coordinating session dispatches the work packages (WPs), merges them, runs reviews and keeps the **Status** table at the end up to date. Each agent reads this file and the files listed for its WP, and owns only those files.

## Goal

Ship v0.2.0 with three parts:

- **The Float v2 UI.**
- **"Record more":** recording again continues the same session as a new take.
- **Better agent tooling:** cursor tracking, batch frames, a compact transcript, per-command help, a vocabulary prompt, rename and moments.

Every part is verified, independently reviewed, squash-merged to `main` and released through the GitHub pipeline. The Windows installer is then installed on this machine.

## Design source

- Canvas: https://claude.ai/artifact/U8LUHwjG8rQV94Px1PY5G1, row "C2 · Float, revised".
- In the repo: `docs/design/float-v2/*.dc.html`. Each is one Design Component file. `{{…}}` holes are filled from the `renderVals()` script at the bottom of the file, with accent `#5B5BD6` and font Figtree. Icon paths are in `ic` in that script. `sample-capture.svg` is the sample recorded screen used in the mocks.
- The mocks cover the Review and Recording states (take 2) on Windows and the Review state on macOS. The fresh draft, compact, dark and Linux states are not mocked; derive them from the same system.

### Tokens (light)

| Role | Value |
|---|---|
| Window ground and sidebar | `#ECEEF2` |
| Sheet | `#FFFFFF`. Windows: 1px `#DFE2E7` top/left border, 8px top-left radius |
| Divider | `#EEEFF2` |
| Text | `#18181B`, secondary `#52525B`, tertiary `#66666F`, transcript body `#3F3F46`/`#52525B` |
| Accent | `#5B5BD6`. Current transcript row uses an 8% accent tint; the spoken word is accent with white text in a 999px pill |
| Neutral pill | `#F4F4F7` |
| Sidebar rows | Hover `#E2E5EA`; selected row is white with `0 1px 2px rgba(16,24,40,.07)` |
| New recording button | White with a 1px `#DCDFE5` ring |
| Scrubber | Track `#F0F0F4`, unplayed speech `#DCDCE5`, played speech accent, take tick `#A1A1AA`, white knob |
| Record and recording | Record dot `#E5484D`; Stop `#D7333A` with white text; live dot `#FF6369`; status chip `#FDECEC` with `#B42318` text; red preview ring 2px `#E5484D` |
| Recording dock | `#18181B`, divider `#3F3F46`, secondary text `#A1A1AA`, meter `#4ADE80`/`#FACC15`/`#3F3F46` |
| Radii | Window 8 (Windows) or 16 (macOS); rows 7; pills 999; video 10 (12 on macOS); macOS sidebar panel 16; current transcript row 12 |
| Sizes | Windows title bar 40, with window controls 46×40; macOS toolbar 52; sidebar 232; transcript column 320 (min 280); rows 32; New recording 36; title 18/700; body 13.5; transcript 14/1.55; meta 12; play 40; pills 32–36; dock controls 44 |
| Type | Bundled Figtree (OFL) via `@fontsource-variable/figtree`. Inter is the documented alternative. No Google Fonts: the CSP only allows `'self'` |

Dark theme: derive it from these roles and get it reviewed. It hasn't been designed yet.

## Product decisions (settled)

1. **Layout:** sessions on the left; the transcript column on the right runs the full height. The center has the title row, then the video with exactly **one border**, **top-aligned** under the title. Controls sit directly under the video.
2. **Sidebar:** it sits on the window ground, visually distinct from the white sheet. **New recording** is the primary button at the top, with a New section icon button beside it.
   - Rows show the name only. Duration and date appear on hover or focus only, as `aria-hidden` text.
   - No section counts.
3. **Header:** title, open folder, and the "Copy for agent" accent pill. No metadata chips.
4. **Status:** no "Synced" badge. A status chip shows only while Recording or Processing; nothing shows once the recording is ready. Errors appear inline with Retry, and empty states appear in the body.
5. **Markers are out of the MVP UI:**
   - Remove the marker UI, the M shortcut and the marker dialog.
   - Keep the store functions, the `get_markers`/`add_marker` commands and `markers.json` for one release so legacy data stays readable. Deprecate them in the docs. Add no CLI marker commands.
6. **One slot, two modes:**
   - Review: a scrubber of speech segments with take ticks, plus play, time, 1×, focus and a **Record more** pill.
   - Recording: the same slot becomes the dark dock. It holds the timer (role=timer), "Take N", level meter, locked source, mute, compact and Stop.
   - There is no progress bar while recording. The Live badge and red ring appear on the preview.
7. **Shortcut hints are hidden until hover or focus**, as in the Claude app ("Ctrl+N", "⌘N").
   - The `<kbd>` is `aria-hidden`, and the control gets `aria-keyshortcuts`, so accessible names don't change.
   - Pill buttons put the shortcut in their tooltip.
   - Use Ctrl on Windows and Linux and ⌘ on macOS.
8. **Shortcuts:**
   - Ctrl/⌘+R records or stops in a draft, means **Record more** in review, and means Stop while recording.
   - Ctrl/⌘+N or the New recording button is the only way to start a new session.
   - Ctrl/⌘+K focuses search.
   - Space and ←/→ keep their current behavior.
9. **Window chrome:**
   - Windows: `decorations:false` with the custom title bar (logo, sidebar toggle, centered search, settings, min/max/close).
   - macOS: `titleBarStyle:Overlay`, `hiddenTitle`, native traffic lights inside the inset sidebar panel.
   - Linux: native decorations, toolbar without window controls.
   - Close stays guarded while recording.
   - Window control names: "Minimize window", "Maximize window"/"Restore window", "Close window".
   - DESIGN.md's "native chrome" rule is superseded; update it.
10. **Takes:**
    - Take N is recorded into `sessions/<id>/takes/<N>/`. The legacy root files are take 1.
    - Each take's offset equals the validated base duration.
    - The combined `video.mp4` is rebuilt with the ffconcat demuxer: video is copied and audio re-encoded. The resolution is normalized when it differs.
    - The source is locked to the session's source.
    - Transcription covers only the new take, shifted by its offset. Segment ids get a `t{N}-` prefix.
    - The transcript shows a "Take N · m:ss" divider.
    - Copy for agent is disabled while recording.
11. **Search:** filters by session name only. Full transcript search comes later.
12. **Word-level seek stays.** Words render inline with a roving tab stop. Labels stay "Seek to {word} at m:ss" and "Seek to m:ss".
13. **No resizable split yet.** The transcript column is at least 280px, and the sidebar auto-hides below about 1000px.
14. **Theme toggle** lives only in Settings → Appearance.

## Agent tooling (from the review-session learnings)

- **C1 Cursor tracking.**
  - Windows display and window sources only. Sample pointer x/y and button transitions at 30–60 Hz on the capture epoch clock, using raw FFI (`GetCursorPos`, `GetAsyncKeyState`, per-monitor DPI v2).
  - Origin: monitor bounds for displays; DWM extended frame bounds per sample for windows, plus `overSource` via `WindowFromPoint`.
  - Storage: delta-encoded `cursor.jsonl` in each take folder, flushed about every second. Canvas size goes into `capture-timing.json`.
  - Exposed as `cursor{x,y,px,py,inVideo}` on transcript words and segments, `find`, `frame`, `frames` and `moments`. `--mark-cursor` draws a ring on exported frames.
  - On macOS and Linux it is a no-op returning `null`; document what each would need.
- **C2 Batch frames:** `cue frames ID --at-ms a,b,c | --per-segment [--max-width N] [--mark-cursor]`. Output is a JSON array, and existing files are never overwritten.
- **C3 Compact transcript:** `cue transcript ID --segments` prints `[mm:ss | seekMs] text`, switching to h:mm:ss after an hour, with take dividers.
- **C4 Per-command help:** `cue <cmd> --help` exits 0 before opening the store or taking the lock. Unknown flags are rejected. The argument parser and help live in `src-tauri/src/cli.rs` so `cargo test --lib` covers them.
- **C5 Vocabulary prompt:**
  - Stored in `<root>/settings.json` (atomic write) and shared by the app and the CLI.
  - Off by default. When set, replace `-mc 0` with a small `-mc` value plus `--prompt "<terms>"`. Validate ASCII and cap at about 200 tokens.
  - Rerun the quiet-noise, VAD and DTW tests with it enabled.
  - Set it in the Settings dialog.
- **C6 Rename:** `cue rename ID NAME` reuses `Store::rename_session`. It doesn't take the global lock; a per-session write lock covers concurrent writes. The app refreshes the sidebar on window focus.
- **C7 Moments:** `cue moments ID` lists segments containing deictic words ("here", "this", "these", "that", "look at", …) with the cursor position, clicks within ±1 s and an optional frame.
- **Handoff:** the "Copy for agent" text lists the new commands and recommends this workflow: segments, then `frames --per-segment --mark-cursor`, then targeted `frame`/`clip`.
- **Compatibility:** JSON output stays backward-compatible (new fields only).
- **Follow-up, not in v0.2.0:** better automatic titles (needs a summarizer); `rename` is the stopgap.

## Work packages and file ownership

Rules:
- Each Phase 1 agent works in its own git worktree branched from the Phase 0 commit and edits only the files it owns.
- `models.rs`, `backend.ts`, `ui/tokens.css` and `icons.tsx` are frozen after Phase 0. Request changes through the coordinator.
- Phase 1 UI components are built and tested in isolation and are not mounted in `App.tsx` until WP9.
- No new crates. Windows-only `#[cfg]` code must not create dead-code warnings on macOS or Linux, because CI runs clippy with `-D warnings`.

### Phase 0 (coordinator, then one agent)

- **S0 Baseline:** commit the uncommitted design-foundation work on `codex/design-polish`: `src/ui`, `.storybook`, `src/stories`, `docs/DESIGN.md`, App, Sidebar and styles changes, plus this plan and `docs/design/`.
- **P0 Contracts** (one agent).
  - **Rust:**
    - New types in `models.rs`: `Take`, `Session.takes`, `Transcript.takes`, `RecordingStatus.takeIndex/takeOffsetMs`, `Settings`.
    - `serde(default, skip_serializing_if)` on the new fields, so legacy JSON re-serializes byte-identical (prove it with a test).
    - Stub modules `takes.rs`, `cursor.rs` (`load`, `at`, `clicks`, `mark_png`), `settings.rs` and `cli.rs`.
    - Commands `record_more` (stub returning Err) and `get_settings`/`save_settings`.
    - `transcribe.rs` builds its decoding args through `settings::decoding_args()` (today's values).
  - **Web:**
    - Types and commands in `backend.ts`.
    - All icons from the mocks in `icons.tsx`.
    - Float v2 light and derived dark tokens in `ui/tokens.css`.
    - The Figtree package, imported in `main.tsx` and `.storybook/preview.tsx`.
    - Storybook backend alias regex `/^(\.\.?\/)+backend$/`.
    - `src/chrome/windowApi.ts`, guarded by `isTauri()`.
    - `src/workspace/types.ts` with frozen prop interfaces and an accessible-name table.
    - A two-take fixture session in `src/stories/*fixture*`.
  - **Accept:** no behavior change; all tests, `npm run build`, `build-storybook`, `cargo fmt/clippy/test --lib` green.

### Phase 1 (parallel worktrees)

| WP | Owns | Delivers / accept | Verify |
|---|---|---|---|
| **A: Chrome + Sidebar** (WP1+WP2) | `tauri.conf.json`, `tauri.windows.conf.json`, `tauri.macos.conf.json`, `capabilities/default.json`, `index.html`, `src/chrome/**`, `Sidebar.tsx/.css/.test.tsx`, `Chrome.stories.tsx`, `Sidebar.stories.tsx` | Decision 9 (platform files copy the whole `windows[0]` entry; add capabilities `allow-minimize`, `allow-toggle-maximize`, `allow-close`, `allow-start-dragging`; drag regions only on empty bar areas; Ctrl/⌘+K focuses search; compact drag strip leaving 78×28 for the traffic lights). Decisions 2 and 7 for the sidebar, plus a `filter` prop with a "No matches" state, while keeping every existing name, menu and drag/keyboard behavior | Unit tests with mocked `windowApi`; stories match the mocks; `App.test.tsx` unchanged and green |
| **B: Media + Transcript** (WP3+WP4) | `src/workspace/{SessionHeader,MediaStage,PlaybackBar,Scrubber,CaptureControls,RecordingDock,TranscriptPane}.tsx`, `workspace.css`, `transcript.css`, `scrubber.ts`, `mediaFit.ts`, `src/review.ts`, `review.test.ts`, the new tests, `Media.stories.tsx`, `Transcript.stories.tsx` | Decisions 1, 3, 4, 6, 7 and 12. Single-border, top-aligned video sized with ResizeObserver. A visually hidden native range labelled "Playback position" with speech segments, a take tick and the played portion drawn over it. Draft controls keep `.source-trigger`/`.mic-trigger`. Take dividers, a live take tail with its note, find in transcript, and "Return to playback" after scrolling away. Works at 520×320 | Unit tests and stories compared to the mocks |
| **C: Takes backend** (WP5) | `takes.rs`, `store.rs`, `lib.rs`, `transcribe.rs` | Decision 10, live transcription offsets, stop bookkeeping (probe the take, then the combined file; re-read `session.json`), and a swap retry/backoff that falls back to the "swapping" status. Recovery matrix: recording → take interrupted and session ready; finalizing → keep raw tracks; swapping → compare durations; transcribing → that take errors, Retry handles only that take; delete stray `video.*.tmp.mp4`. Per-session write lock | Unit tests; ignored ffmpeg two-take test (boundary frame colour and audio onset); ignored Whisper offset test |
| **D: Cursor** (WP6) | `cursor.rs`, `capture.rs` | C1, used by both app and `cue record` | Unit tests for mapping, lookup, stitching and marking; ignored test with an owned window and `SetCursorPos` |
| **E: CLI + handoff** (WP7) | `cli.rs`, `bin/cue.rs`, `agent.rs`, `scripts/verify-cli.cjs` | C2–C4, C6, C7, handoff text; codes against the cursor stub until D merges | `cli.rs` tests in `--lib`; updated handoff test; ignored ffmpeg frames test; `verify-cli.cjs` on the pipeline fixture |
| **F: Vocabulary + Settings dialog** (WP8) | `settings.rs`, `src/dialogs/SettingsDialog.tsx/.css`, `Dialog.stories.tsx` | C5; the dialog holds Appearance, capability statuses, technical details and the vocabulary field | Unit tests; ignored Whisper regression with the prompt on |

### Phase 2 (sequential)

- **G: App integration** (WP9).
  - **Owns:** `App.tsx`, `App.test.tsx`, `styles.css`, `ui/polish.css`, `main.tsx`, `Workspace.stories.tsx`, `Foundations.stories.tsx`.
  - **Delivers:** mounts everything; removes the marker UI; decisions 8, 11, 13 and 14; the Record more flow, which unloads the video before recording; compact mode; sidebar refresh on focus; deletes legacy CSS.
  - **Accept:** 1280×820, 900×650 and compact 520×320 in both themes; vitest, build and Storybook green.
- **H: Docs + scripts** (WP10).
  - **Owns:** `README.md`, `docs/*` (except this plan), `scripts/verify-*.cjs`, `verify-pipeline.ps1`, new `scripts/verify-takes.cjs` (records an owned `ffplay -f lavfi testsrc2` window twice through the UI), `.github/RELEASE_NOTES.md`.
  - **Delivers:** updated names and flows in the verify scripts (markers removed, native-chrome check replaced, theme toggle moved to Settings); DESIGN.md updated.

### Phase 3: review and verification

- **Independent review.** Fresh reviewer agents get the diff (`main...HEAD`) and this plan, not the implementers' summaries. One reviews frontend, Tauri config and a11y; one reviews Rust takes, cursor, CLI and settings. Findings are fixed by the owning area and re-reviewed until there are no blocking findings.
- **Design check.**
  - Render the mocks to static HTML by filling the `{{…}}` holes.
  - Screenshot Storybook and the dev app at 1280×820 against them: spacing, type, colors, radii, states.
  - Also check 900×650, compact, and the dark theme.
- **Unattended verification:**
  - vitest, `npm run build`, `build-storybook`, and `cargo fmt/clippy/test --lib`;
  - the ignored ffmpeg and Whisper tests, with `%LOCALAPPDATA%\Programs\CueReview\tools\whisper-b5454` on PATH;
  - `verify-failures`, `verify-alignment`, `verify-sidebar`, `verify-recovery`, `verify-folder-open`, `verify-cli`, `verify-pipeline.ps1`;
  - all against release builds and an isolated `CUEREVIEW_DATA_DIR`.
- **Attended verification:**
  - Runs: the `capture::actual_*` tests with cursor, `verify-takes`, `verify-desktop` and `verify-native-ux` (CDP port 9224).
  - Plus a manual check of drag, double-click maximize, edge resize, snapping, and close being blocked while recording.
  - These record the screen and microphone and play quiet tones; nothing leaves the machine. Tell the user before they start.
  - Device runs (`verify-device-ui`) only if a Quest/ADB device is connected.

### Phase 4: release and install

1. **Version:** bump to `0.2.0` in `package.json` and `package-lock.json` (`npm version 0.2.0 --no-git-tag-version`), `src-tauri/Cargo.toml`, the root entry in `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Write release notes.
2. **PR to main:** push `codex/design-polish`, open the PR, and wait for CI (about 17 min, four platforms) to go green.
3. **Merge:** squash-merge to `main`.
4. **Tag:** `git tag v0.2.0 <main sha>` and `git push origin v0.2.0`. `release.yml` builds, verifies five assets plus SHA256SUMS and publishes (about 19 min). The repo is public, so the release is public.
5. **Install:**
   - Download `CueReview_0.2.0_windows-x64_setup.exe` and check it with `Get-FileHash` against SHA256SUMS.
   - Close CueReview; never upgrade during a recording.
   - Run `setup.exe /S`. It installs to `%LOCALAPPDATA%\Programs\CueReview`; user data stays in `%LOCALAPPDATA%\CueReview`.
   - Smoke-check the install: `cue.exe --help`, `cue sessions`, launch the app and open an existing session.

## Known limits and risks

- Custom controls lose the Windows 11 Snap Layouts hover on the maximize button.
- Polling can miss clicks shorter than about 16 ms. The secure desktop (UAC, lock screen) leaves cursor gaps.
- Takes need about 2× disk space during the swap. Renaming over `video.mp4` fails while it is open, so retry and recover.
- The vocabulary prompt mainly helps the first 30 s window of each take.
- macOS/Linux cursor tracking is not implemented, and macOS/Linux hardware validation is still outstanding.

## Status

| Step | State | Notes |
|---|---|---|
| S0 baseline commit | done | 35ad509 |
| P0 contracts | done | c6fbf18. Figtree is now the default font; new tokens use the `--color-*` prefix; NAMES keeps "Compact"/"Expand" |
| A chrome + sidebar | merged | c9f07cd. 96 web tests; `tauri build --debug` OK. For G: pass `showCollapse={false}` on Windows/Linux; fix "New recording" truncating while its Ctrl+N hint shows at 232px; the sidebar now always contains a `role=status` element |
| B media + transcript | merged | 02ee1c9. Merged branch: 157 web tests, build OK. For G: `MediaStage` takes `children` (the controls slot); use `platform?` props and the `review.ts` helpers. Rename `scrubber.ts` → `scrubberGeometry.ts`, because it collides with `Scrubber.tsx` on case-insensitive file systems. Status chips use role=status |
| C takes backend | merged | f1227fc. Combined: clippy clean; 103 lib tests passing, 24 ignored. The ignored ffmpeg concat, Whisper take-2 offset, recovery and snapshot tests pass. Adds `capture-timing.json` `normalize{scale,padX,padY,baseWidth,baseHeight}`; follow-up: `cursor.rs` must apply it. For G: unload the video before Record more and keep it unloaded until processing ends; add a cache-buster to the video URL; Stop returns before the swap finishes, so refresh the session on idle |
| D cursor | merged | 40bbff4. Combined `cargo test --lib`: 78 passed, 22 ignored. `px`/`py` for later takes assume the take is scaled to take 1's size without padding; reconcile with C's scale+pad. The `SetCursorPos` test is reserved for the attended phase |
| E CLI + handoff | merged | 515d0b4. 65 lib tests passing; 2 ignored ffmpeg tests passing; verify-cli 9/9. `cursor` is null in frame/frames/moments until D lands |
| F vocabulary + settings | merged | b95916c. Combined: 170 web tests, 111 lib tests passing (25 ignored), clippy clean. Prompt cap is about 75 tokens (20 terms, 200 characters). `-mc` = prompt tokens + 1 with `--carry-initial-prompt`, so decoded text is never carried; the Whisper regression passes. The validation story's play test needs a focused tab |
| G app integration | merged | adccdbe (merge bc58c90). Full branch: 198 web tests, 116 lib tests, build and `tauri build --debug` OK. Matches the mocks within about 2px at 1280×820. Minor gaps: word pill, sidebar heading +3px, recording row label vs dot. Real-app checks: video swap lock and reload, drag and maximize, Ctrl+R in WebView2, compact resize order, focus refresh after `cue rename` |
| H docs + scripts | merged | 6e070e4 (+ 4135be1 doc fix). verify-cli 9/9, verify-pipeline, verify-failures and verify-alignment pass. Adds `scripts/test-env.cjs` and `verify-takes.cjs` (not yet run); release notes in `.github/RELEASE_NOTES.md`. Open: ship the Figtree OFL licence text; confirm H's assumed names against G (Title bar, Recording video and Transcript regions, Recording controls group, "Take N elapsed time", Record more, Dismiss error, Agent instructions copied) |
| Independent review + fixes | pending | |
| Design check | pending | |
| Unattended verification | pending | |
| Attended verification | pending | |
| Version, PR, CI, squash merge | pending | |
| Tag, release, install | pending | |
