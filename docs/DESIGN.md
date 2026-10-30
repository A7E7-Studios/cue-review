# CueReview design system: Float v2

Updated 28 October 2026 for v0.2.0. The v0.1 review that led here is summarized at the end.

## Source of truth

- **Mocks:** `docs/design/float-v2/`. `FloatV2ReviewWindows.dc.html`, `FloatV2RecordMoreWindows.dc.html` (recording take 2) and `FloatV2ReviewMac.dc.html` are Design Component files: fill each `{{…}}` hole from the `renderVals()` script at the bottom (accent `#5B5BD6`, font Figtree; icon paths in `ic`). `sample-capture.svg` is the sample recorded screen. They come from row "C2 · Float, revised" of the design canvas.
- **Not mocked:** the fresh draft, compact, dark and Linux states. Derive them from the same system and review them against the mocks.
- **Tokens:** `src/ui/tokens.css`. Float v2 roles use the `--color-*`, `--size-*`, `--radius-*` and `--font-size-*` prefixes; the older short names remain only for styles not yet moved.
- **Names:** `src/workspace/types.ts`. `NAMES` holds every accessible name the app, its tests and `scripts/verify-*.cjs` find controls by; `HOOKS` lists the few class hooks the scripts still use. Renaming a control there is a breaking change.
- **Working specification:** Storybook (`npm run storybook`). Each component shows its default, hover/focus, disabled, busy, error, long-content, dark and reduced-motion states where they apply.

## Principles

Keep the shell compact and neutral. Recording starts immediately into a temporary session, sources are chosen directly, rows are text only, and sections categorize recordings without introducing a project workflow. Avoid decorative cards, large onboarding copy, repeated status footers, and animation around live media. Shrinking controls further would hurt legibility; composition and predictable behavior carry the quality.

## Layout

- **Ground and sheet.** The window ground (`--color-ground`) carries the sidebar; the white sheet (`--color-sheet`) holds the workspace. On Windows the sheet has a 1px `--color-sheet-edge` top and left border and an 8px top-left radius.
- **Sidebar, 232px.** New recording is the primary button at the top, with a New section icon button beside it. Rows show the session name only; duration and date appear on hover or focus as `aria-hidden` text. No section counts. Rows are 32px with a 7px radius; hover is `--color-row-hover`, and the selected row is white with a small shadow (on macOS, an accent tint in the inset sidebar panel). Section headings are 21.4px (12px text at 1.45 over 4px). A recording in progress shows an 8px dot before its name: `#E5484D` while recording, an accent ring (no pulse) while processing. The status is visually hidden text (the row is named `Name, recording`), so no visible label truncates the name. The sidebar auto-hides below about 1000px wide; when it hides or shows, focus moves to the toggle that brings it back.
- **Center.** The title row holds the title (click to rename), Open recording folder and the **Copy for agent** accent pill; no metadata chips. Below it, the video has exactly one border (a 1px ring drawn as a shadow, 10px radius, 12px on macOS), is top-aligned under the title and keeps its aspect ratio; unused space shows the neutral surface. The controls sit directly under the video.
- **Transcript column, 320px (at least 280px),** running the full height on the right. Focus video hides it and gives the video the space. There is no resizable split yet.
- **Compact recording mode, about 520×320:** the dock and a drag strip only.

## Window chrome

This replaces the v0.1 rule of keeping native window chrome.

| Platform | Chrome |
| --- | --- |
| Windows | `decorations: false` and a 44px custom title bar: logo, sidebar toggle, centered search (`Ctrl+K`), Settings, then Minimize, Maximize/Restore and Close at 46×44. The window-control glyphs are 10×10px with 1px lines on whole pixels, as Windows draws its own; the sidebar toggle and Settings are 20px icons in 36×32 buttons. Close hovers `#C42B1C` with white. Drag regions (`data-tauri-drag-region`) sit only on empty bar areas, never on a control or the search field; double-clicking them maximizes. |
| macOS | `titleBarStyle: Overlay` with a hidden title. The native traffic lights sit inside the inset sidebar panel (78×28 reserved). `trafficLightPosition` (24, 26) puts their top edge 26px down, so the panel's first row (the Hide sidebar button) is centred on y = 32 and New recording starts at y = 60, as in the mock. The content toolbar is 52px with search (`#F2F3F6`) and Settings (8px corners), and shows a Show sidebar toggle only while the sidebar is hidden. |
| Linux | Native decorations, with the Windows bar layout minus window controls and drag regions. |

Window control names are "Minimize window", "Maximize window" or "Restore window", and "Close window". Compact mode keeps only a drag strip: Minimize and Close on Windows, room for the traffic lights on macOS, nothing on Linux. Close stays guarded while recording or processing, whichever control asks. Known cost: custom controls lose the Windows 11 Snap Layouts flyout on the maximize button.

## Typography

- **Family:** Figtree, bundled as a variable font through `@fontsource-variable/figtree` and imported in `src/main.tsx` and `.storybook/preview.tsx`. Fallbacks are `system-ui`, `Segoe UI` and sans-serif. Inter is the documented alternative. No Google Fonts: the CSP allows only `'self'`.
- **Scale:** title 18/700; body 13.5; transcript 14 with 1.55 line height; meta 12; controls 12.5; shortcut hints 11; the dock timer 19 with tabular numbers.
- **Attribution:** Figtree is Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree), licensed under the SIL Open Font License 1.1. The license text ships with the app: `public/licenses/Figtree-OFL.txt` (copied from `node_modules/@fontsource-variable/figtree/LICENSE`) is built into `dist/licenses/`, and Settings ends with the font's notice.

## Tokens (light)

| Role | Value |
| --- | --- |
| Ground and sidebar | `#ECEEF2` |
| Sheet | `#FFFFFF`; Windows edge `#DFE2E7` |
| Divider | `#EEEFF2` |
| Text | `#18181B`; secondary `#52525B`; tertiary `#66666F`; rows `#27272A`; transcript `#3F3F46`, past `#52525B` |
| Accent | `#5B5BD6`. The current transcript row is an 8% accent tint (`#F2F2FC`); the spoken word is accent with white text in a 999px pill |
| Neutral pill | `#F4F4F7` |
| New recording | White with a 1px `#DCDFE5` ring; on macOS `rgba(24, 24, 27, .07)` |
| macOS selected row | `#D9DBF0`; tertiary text on it is `#5E5E68` (4.6:1; `#66666F` is 4.15:1 there) |
| Scrubber | Track `#F0F0F4`, unplayed speech `#DCDCE5`, played speech accent, take tick `#7A7A84` (the mock's `#A1A1AA` is 2.25:1 on the track; this is 3.7:1, and 3.1:1 over speech), white knob |
| Recording | Record dot `#E5484D`; Stop `#D7333A` with white text; live dot `#FF6369`; status chip `#FDECEC` with `#B42318`; preview ring 2px `#E5484D` |
| Recording dock and bar | `#18181B`, divider `#3F3F46`, secondary text `#A1A1AA`, meter `#4ADE80` / `#FACC15` / `#3F3F46`; the bar's Record is Stop's `#D7333A` (white text 4.7:1; on `#E5484D` it would be 3.9:1) |
| Radii | Window 8 (16 on macOS); rows 7; pills 999; video 10 (12 on macOS); macOS sidebar panel 16; current transcript row 12 |
| Sizes | Windows title bar 44 with 46×44 controls and 36×32 icon buttons; macOS toolbar 52; sidebar 232; transcript 320 (min 280); rows 32; New recording 36; play 40; pills 32–36; dock controls 44 |

The dark theme (`:root[data-theme='dark']`) is derived from these roles. It has not been designed in the mocks yet and needs its own review. The theme is chosen only in **Settings → Appearance**; there is no theme button in the sidebar or title bar. `src/chrome/platformAttribute.ts` applies the saved theme to `<html>` before React loads, so the page never paints light first. The native window background (`backgroundColor` in the platform configs) is still light and shows for a moment before the webview paints; following the theme there needs the Rust side or a window capability.

## States and components

- **Status.** A status chip shows only while Recording or Processing; nothing shows once the recording is ready, and there is no "Synced" badge. Errors appear inline where they happen, with Retry; empty states appear in the body.
- **One bar, always under the video.** Whenever nothing records, the dark recording bar (a group named "Recording bar") sits under the video: the dock's capsule (`--color-dock`, `--shadow-dock`, 44px controls in 6px of padding) holding the source picker, the microphone picker (icon, label, chevron) and **Record** in Stop's red with a white dot, the only filled red button in the workspace. In a draft it is centred under the preview. In review the slot is the scrubber and controls first (a visually hidden native range named "Playback position" with speech segments, take ticks and the played part drawn over it, then play, time, speed with no minimum width, as in the mock, and focus), and the bar sits centred in its own row under them with **Record more**. There its microphone picker sets the next take's microphone, and its source picker shows the session's own source, disabled and titled "Another source for Record more comes with separate take videos" ("Original source" once that source is no longer listed). A refusal of Record more (a source that is gone) shows under the bar with New recording and Dismiss. While recording, the bar's row becomes the dark dock: timer (`role=timer`, named "Take N elapsed time"), level meter, the locked source, mute, compact and Stop. There is no progress bar while recording; the Live badge and the red ring appear on the preview. The idle bar shows no microphone level; the meter appears once a take records.
- **The bar stays on one row.** It needs 476px in review and 439px in a draft with "Display 1" and "Studio microphone"; longer names truncate first (a picker is at most 220px). Below 476.5px the picker labels drop to icons and their chevrons go, and below 249px (the icon-only bar with Transcribing…) Record's label goes too, leaving a 150px bar. Labels become visually hidden text, so every control keeps its name. It fits from 1280×800 down to the 640×480 window minimum.
- **The dock stays on one row.** It needs 481px with a microphone, the same for every take: the take shows only in the timer's name and the transcript's divider. As its slot narrows (container queries in `workspace.css`, with their own steps for compact mode's 36px controls), a long source name truncates, then the source drops to an icon, then Stop becomes a round icon button and the divider goes, then the meter goes. Labels become visually hidden text, so every control keeps its name, and Stop is always shown. Compact mode's dock needs 429px. It fits at 900×650, 1000–1135px with the sidebar, and the 420×250 compact minimum.
- **Busy is not disabled.** While another action runs, Copy for agent, Record, Record more, Retry and Stop stay focusable with `aria-disabled` and ignore activation, so keyboard focus never drops to the page. Record more stays focusable while its take starts, although the video is unloaded meanwhile, so a refusal leaves focus on it, above its message. When a control does go away (Record becomes Stop, Stop becomes the review controls, Compact becomes Expand), focus moves to the control that takes its place. Retry is disabled outright while any recording transcribes, since the runtime takes one job at a time.
- **Pickers.** The recording bar's source and microphone pickers are anchored popovers that flip within the viewport, with arrow keys, Home/End and typeahead.
- **Takes.** The transcript shows a "Take N · m:ss" divider where each take starts, and "Take N · recording" with a live tail and its note while recording. Copy for agent is disabled while recording.
- **Transcript.** Word-level seek stays: words are inline `role=button` spans (a `<button>` lays out as one unbreakable box, so phrase-length tokens overflowed) with one roving tab stop, Enter and Space, labelled "Seek to {word} at m:ss" or "Seek to m:ss". The column follows the sentence the playhead last reached (the newest words while recording) until the reader scrolls away, then offers **Return to playback** (**Back to live** while recording); nothing is offered before the playhead reaches the first sentence, and scrolling back resumes following. **Find in transcript** searches the text in review; it is hidden while recording. Title bar search filters sessions by name only.
- **Spoken-word pill.** The pill is painted by `::before` around the word: 1px above and below the text (19px tall, as in the mock) and `--size-spoken-pill-x` (4px) into the word gap on each side. It takes no room, so moving it never reflows the line. To keep a visible space beside it, transcript text adds `--size-transcript-word-gap` (0.18em, 2.5px) to each space: the pill is 32px wide around "grid" with 2px of space on each side.
- **The dock shows no "Take N" label and no caption, a deliberate deviation from the mock.** `FloatV2RecordMoreWindows` draws "Take 2" in the dock and "Adding to this session. Stop to process take 2 on this device." under it. The transcript's "Take 2 · recording" divider already names the take, so the dock leaves both out and keeps one width on every take.
- **The recording bar replaces the mock's pills, a deliberate deviation from the mock.** The Float v2 mocks draw the draft's source and microphone as light pills with a small black Record at the right, and Record more as a black pill at the end of the playback row. The owner found that Record "feels a bit lost" though it is the call to action, and that Record more offered no audio options, so both live in the one dark bar, shaped like the dock, with Record in red.
- **New section is disabled while recording, a deliberate deviation from the mock.** `FloatV2RecordMoreWindows` dims New recording but leaves New section at full strength. Sections cannot change while recording, so the sidebar keeps New section disabled (and dimmed) with New recording, its rows and its section controls, rather than offering a control that would only be refused.
- **Accepted deviations from the mock, so playback never reflows text.** The mock's pill has 7px of padding, which only fits beside a 3.5px space by pushing the neighbouring words apart; a layout-free pill can reach as far as the word gap minus the space left visible, hence 4px into a widened gap. The current row keeps weight 400 (mock 500) and 8px vertical padding (mock 10px), because changing either when a row becomes current would rewrap it and shift every row below.
- **Settings dialog.** Appearance, the recording tools' status with Install transcription and technical details, the vocabulary field, and the shortcut list.

## Shortcuts and hints

| Action | Windows and Linux | macOS |
| --- | --- | --- |
| Record in a draft, Record more in review, Stop while recording | `Ctrl+R` | `⌘R` |
| New recording, the only way to start a new session | `Ctrl+N` | `⌘N` |
| Focus search | `Ctrl+K` | `⌘K` |
| Play or pause; seek 5 s | `Space`; `←` / `→` | `Space`; `←` / `→` |

Shortcut hints stay hidden until hover or focus, as in the Claude app ("Ctrl+N", "⌘N"). The `<kbd>` is `aria-hidden` and the control carries `aria-keyshortcuts`, so accessible names never change. Pill buttons put the shortcut in their tooltip. Shortcuts must not fire inside editable fields, dialogs or menus.

## Markers removed

Markers are out of the v0.2.0 UI: no Add marker button, no M shortcut, no marker dialog and no marker CLI commands. Spoken pointing ("look at this") replaces them, found by `cue moments`. The store keeps reading `markers.json` for one release.

## Motion contract

Use motion to explain a state change. Recording start/stop, timecode, video frames and word highlighting must remain immediate.

| Interaction | Intended motion | Implementation status |
| --- | --- | --- |
| Hover/selection | 120ms color change; no scale | Implemented |
| Context menu | 120ms opacity and 3px translation, including exit | Implemented |
| Device popover | 120ms opacity and 4px translation | Entry implemented; exit continuity remains open |
| Dialog | 180ms opacity and 5px translation | Implemented; background stays inert through exit |
| Section disclosure | 180ms height reveal; chevron rotation | Implemented; collapsed content inert immediately |
| Sidebar hide and show | 200ms width ease with the sidebar sliding out and the sheet following (over the sheet below 1000px) | Implemented; instant beside a live preview or a recording; the leaving sidebar is inert |
| Toast | 180ms opacity | Entry implemented; dismissal continuity remains open |
| Shortcut hints | 120ms opacity on hover or focus | Implemented |
| Workspace changes | At most 180–220ms restrained transition after content is ready | Proposed; do not animate resize or crossfade live video |
| Reduced motion | No translation, fade, smooth scroll or delayed unmount | Implemented for shared surfaces and explicit transcript scroll |

Use `cubic-bezier(.2,.8,.2,1)` for surface motion. No bounce, spring, pulsing recording border or indefinite decorative loop. Interruptions must reverse cleanly: opening and closing quickly cannot strand a backdrop, leave an invisible focus target, or delay Stop.

## Reuse boundary

Keep the foundation local until another helper app needs it. Export tokens, Dialog/presence behavior, and eventually Button, IconButton and anchored Menu primitives. Keep capture, transcription, storage, shortcuts and workflow orchestration in CueReview. Reuse should not require every helper app to have the same sidebar or recording dock. Prefer a small set of real primitives over a broad speculative component library.

## Verification and limits

- Compare Storybook and the dev app with the rendered mocks at 1280×820: spacing, type, colors, radii and states. Also check 900×650, compact 520×320 and the dark theme, at 100% and increased OS scaling, with keyboard-only input and reduced motion. Unit tests alone cannot establish visual quality.
- The workshop isolates its backend with Storybook-only Vite aliases. Its captures, recordings and file operations are in-memory fixtures and do not validate native capture, window management or filesystem behavior.
- Accessibility scans in Storybook are inspection findings, not a blocking CI gate or a certification.
- Native chrome needs a manual pass on Windows: drag, double-click to maximize, edge resize, snapping, and close blocked while recording. `scripts/verify-native-ux.cjs` checks the bar's size, controls and drag regions.

## Still open

- The dark theme review, and the fresh draft, compact and Linux states that the mocks do not cover.
- A resizable media/transcript split (decision 13 defers it) and full transcript search in the sidebar (search covers names only).
- From the v0.1 review, not part of v0.2.0: grouping sources by type, drag edge autoscroll with delayed expansion of collapsed sections and a spoken announcement of moves, and tracking acknowledged errors by failure identity.

## History: the v0.1 review

The 28 October 2026 review of v0.1.0 found the compact neutral shell right and asked for stronger composition and predictable behavior: an intentional layout for each workspace state, a single-step source picker with full keyboard support, one tab stop in the transcript with a "Return to playback" escape, separate pending/failed/acknowledged states, and Command/Control parity. It also built the shared foundation (tokens, the Dialog with focus containment, presence-based motion, reduced motion) and the Storybook workshop. Float v2 is the composition that review asked for; the items it did not cover are listed above.
