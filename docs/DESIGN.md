# CueReview design review and shared foundation

Review date: 28 October 2026. Baseline: installed v0.1.0; improvements on `codex/design-polish`.

## Assessment

The compact, neutral shell is the right direction. The next quality step comes from stronger composition and predictable behavior. Making the controls progressively smaller would hurt legibility without resolving the empty workspace, abrupt state changes, or uneven keyboard behavior.

Keep one application identity in native window chrome, text-only recording rows, optional sections, immediate recording into a temporary session, and direct source selection. Avoid decorative cards, large onboarding copy, repeated status footers, and animation around live media. Sections categorize recordings; they do not introduce a project workflow.

The font is `system-ui`, with `Segoe UI` and sans-serif fallbacks. On Windows this resolves to the system UI font; it is not a bundled custom font. The new scale is 13px body, 12px controls, 11px metadata, and 16px session titles. A shared family across platforms should mean a consistent hierarchy, rather than forcing Windows typography onto macOS.

## Changes implemented in this pass

| Area | Change | Purpose |
| --- | --- | --- |
| Foundation | Semantic colors, spacing, radii, control sizes and motion in `src/ui/tokens.css` | Establish reusable decisions instead of one-off screen values |
| Readability | Stronger secondary text, 13px transcript, 11px metadata | Preserve compact density while making actual work easier to read |
| Controls | 28px icon targets, 30–32px common controls, small glyphs | Make compact controls easier to acquire |
| Settings | Three capability statuses; technical paths/tools behind a disclosure | Keep everyday decisions visible and troubleshooting available |
| Dialogs | Shared portal, background inertness, focus containment/restoration, busy guards | Make keyboard behavior match the modal appearance |
| Markers | Capture the timestamp when Add marker is invoked | Preserve the intended moment while the user writes a note |
| Sidebar | Section reveal, menu entry/exit, measured edge placement, typeahead and one tab stop | Improve continuity and keyboard predictability |
| Reduced motion | Shared CSS and JS preference, including transcript seeking | Avoid smooth movement when the user requests reduced motion |
| Workshop | 25 real-component stories, light/dark, reduced motion, compact sizes, errors and long content | Make states repeatable and inspectable without recording or changing files |

`src/ui/polish.css` is a transitional layer over the existing screen stylesheet. Move legacy rules into component styles when those components are extracted; avoid accumulating further override layers. Shared dialog CSS uses the same tokens. The workshop imports the actual application styles and components, not a second implementation.

## Prioritized next changes

These are open findings, not completed behavior.

### 1. Give each workspace state an intentional composition

**Fresh session:** the empty transcript column currently reserves space without helping the next action. Let the source preview own the workspace; reveal transcript space when text or processing status exists. Keep source/audio controls in one quiet bottom strip. No welcome paragraph or naming step.

**Review:** video remains top-aligned while the transcript stretches, leaving a large unused area below the player. Use a bounded, resizable split between media and transcript. Preserve media aspect ratio and keep playback controls attached to the media. Use the neutral surface for unused media space; do not add a black decorative frame in light mode. Persist the user's split preference, with sane minimum sizes.

**Recording to review:** retain the same media region and source context through stop, finalization and transcription. Change the relevant status in place. Do not replace the entire workspace with a spinner or move the primary action unexpectedly.

Acceptance: fresh, recording, processing and review feel related at 1280×820 and 900×650. Compact mode remains usable at 520×320. No nested horizontal scrolling, clipped primary actions or large unexplained blank panels.

### 2. Finish the source picker as a single-step control

The direct picker already satisfies the one-click requirement, but the list mixes displays, windows and connected devices. Group by source type; show only actual available devices, with a short reason for unavailable sources. Add search only when the list becomes long. Anchor to the invoking control and flip within the viewport instead of relying on fixed offsets.

Complete Arrow Up/Down, Home/End and typeahead support, keeping Tab and Escape predictable. Preserve focus on the trigger after selection. Device failure must say what failed and offer a retry; it must not simultaneously say “Loading preview”.

### 3. Make transcript navigation calm and keyboard efficient

Every word currently creates a tab stop. Use one entry point for the active segment and arrow navigation within the transcript, retaining pointer word seeking. Keep focus visible independently of playback highlighting.

Follow playback initially. If the user scrolls to read another passage, suspend automatic following and expose a contextual “Return to playback” action. Resume on explicit seek or that action. Do not add an always-visible preference for normal following, and do not force the scroll position while the user is reading elsewhere.

### 4. Separate pending, failed and acknowledged states

When selecting another recording, pause the old media and show which row is loading. Preserve the workspace geometry until the requested content is ready. Keep failed selection recoverable and avoid displaying old content as if it belongs to the newly selected row.

Track acknowledged errors by failure identity so the 700ms runtime poll cannot immediately resurrect a dismissed message. Scope busy labels to the affected action: copying text or renaming a section should not turn Record into “Please wait…”. Use inline errors where a recovery action belongs, and transient status only for completed actions.

### 5. Finish desktop input conventions

Support Command on macOS and Control on Windows/Linux, including visible shortcut labels. Ignore recording/seek shortcuts inside editable controls and popovers. A bare marker shortcut must not accidentally match unrelated modifier combinations.

For drag organization, add edge autoscroll and delayed expansion when hovering over a collapsed section. Announce the resulting move to assistive technology and preserve a keyboard equivalent. Section deletion must continue returning recordings to Recents; recording deletion remains explicitly destructive.

## Motion contract

Use motion to explain a state change. Recording start/stop, timecode, video frames and word highlighting must remain immediate.

| Interaction | Intended motion | Implementation status |
| --- | --- | --- |
| Hover/selection | 120ms color change; no scale | Implemented |
| Context menu | 120ms opacity and 3px translation, including exit | Implemented |
| Device popover | 120ms opacity and 4px translation | Entry implemented; exit continuity remains open |
| Dialog | 180ms opacity and 5px translation | Implemented; background stays inert through exit |
| Section disclosure | 180ms height reveal; chevron rotation | Implemented; collapsed content inert immediately |
| Toast | 180ms opacity | Entry implemented; dismissal continuity remains open |
| Workspace changes | At most 180–220ms restrained transition after content is ready | Proposed; do not animate resize or crossfade live video |
| Reduced motion | No translation, fade, smooth scroll or delayed unmount | Implemented for shared surfaces and explicit transcript scroll |

Use `cubic-bezier(.2,.8,.2,1)` for surface motion. No bounce, spring, pulsing recording border or indefinite decorative loop. Interruptions must reverse cleanly: opening and closing quickly cannot strand a backdrop, leave an invisible focus target, or delay Stop.

## Reuse boundary

Keep the foundation local until another helper app needs it. Export tokens, Dialog/presence behavior, and eventually Button, IconButton and anchored Menu primitives. Keep capture, transcription, storage, shortcuts and workflow orchestration in CueReview. Reuse should not require every helper app to have the same sidebar or recording footer.

Storybook is the working specification. Each shared component should show default, hover/focus, disabled, busy, error, long-content, dark and reduced-motion behavior where relevant. Prefer a small set of real primitives over a broad speculative component library.

## Verification and limits

- Automated application tests cover marker timing, dialog focus/inertness/busy behavior, section hiding and menu keyboard behavior. Production and static Storybook builds are required.
- The workshop isolates its backend with Storybook-only Vite aliases. Its captures, recordings and file operations are in-memory fixtures. They do not validate native capture or filesystem behavior.
- Accessibility scans are visible in Storybook and configured as inspection findings, not a blocking CI gate or certification. The foundation scan caught selected-label contrast; that token and dark destructive-button foreground were corrected.
- This pass: 74 automated tests passed, along with the production build and static Storybook build. Manual workshop checks covered light/dark foundations, Settings, 520×320 compact recording, direct device selection, dialog focus, reduced-motion computed styles, and moving a recording to Recents. Foundation scans reported zero violations in both themes; this is a narrow scan result, not whole-application accessibility certification.
- Independent review caught keyboard activation during dialog exit and installation preventing Settings dismissal. Both were corrected and covered by regressions, including cancelling deletion then immediately pressing Enter, and closing Settings to stop a recording during installation.
- Inspect the real app at normal and compact sizes, both themes, 100% and increased OS scaling, keyboard-only input, and reduced motion. Observe rapid open/close and interrupted transitions. Unit tests alone cannot establish visual quality.
- Recheck native window chrome, resize, Quest/display preview smoothness and actual stop/finalization with a dedicated test recording before shipping a new release. This design pass does not change capture encoding or certify hardware performance.

Run `npm run storybook` for development or `npm run build-storybook` for a static workshop. The installed v0.1.0 app remains separate from this branch until a new release is built and installed.
