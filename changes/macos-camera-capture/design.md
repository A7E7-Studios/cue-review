# Design: Prefer displays and make macOS camera capture usable

## Context

The owner approved this technical design in Q4. The requirements are committed on
`macos-camera-capture`.
Q3 explicitly retains the current picker, so there is no new layout or component direction to
choose. Only its source order, default selection and existing error text change.

`useCaptureDevices` currently stores discovery order and selects its first available entry.
`preview.rs` starts FFmpeg, sends MJPEG over token-protected loopback HTTP and discards decoder
stderr. `MediaStage` already polls image dimensions, but silently stops checking after about ten
seconds. The transport silently stops waiting for its first viewer after fifteen seconds.

The camera delivered 150 frames in a direct five-second FFmpeg test. The installed CLI completed a
camera-only recording that decoded without errors. In the packaged app, synthetic moving frames
rendered correctly. A bounded camera probe also reached the app's live-image state before its
intentional five-second end; it logged pixel-format negotiation warnings rather than a fatal
capture error. The original camera failure has not been reproduced, and these checks do not prove
that the transition from real camera preview to recording works.

## Decisions

| Decision | Chosen | Alternatives, and why not | Sources |
|---|---|---|---|
| Where source priority belongs | Copy and stably sort the discovered sources in `useCaptureDevices` before storing them; use the same ordered list for initial selection and the picker. Android and Quest share a rank. Retain the current selection and missing-source placeholder. | Changing source IDs or sorting by names would affect identity or reorder displays unnecessarily. The CLI's discovery output needs no ordering change. | [Array sorting and stability](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort), `src/app/useCaptureDevices.ts` |
| Camera input and preview transport | Retain AVFoundation and the loopback MJPEG transport. Their working baselines do not support replacing the capture backend or adding a transport-security exception. | An alternative backend, broad ATS exceptions or hard-coded camera formats would add unproven fixes. | [FFmpeg AVFoundation input](https://ffmpeg.org/ffmpeg-devices.html#avfoundation), `src-tauri/src/capture.rs`, packaged synthetic probe |
| Useful decoder failures | Continuously drain FFmpeg stderr into a bounded in-memory tail of at most 8 KiB. Prefer a useful decoder failure over generic EOF, add concise camera-access/reconnect guidance, and join owned workers during teardown. | Discarded stderr hides causes; an unread pipe can stall the child; unbounded buffering can grow without limit. No persistent diagnostic format is needed. | [Rust process pipes and deadlock caution](https://doc.rust-lang.org/std/process/struct.Stdio.html#method.piped), [Apple camera access](https://support.apple.com/guide/mac-help/control-access-to-your-camera-mchlf6d108da/mac) |
| Preview that never becomes visible | Report the existing no-viewer timeout through the error callback. Use the existing image-dimension polling to report failure after ten seconds without a drawable first frame. Cancel it for obsolete URLs and route the failure through the existing Retry state. | An MJPEG stream need not finish loading, so a load event alone is insufficient; adding another loading component does not recover the stream. | [Image intrinsic dimensions](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/naturalWidth), `src/workspace/MediaStage.tsx`, `src/app/usePreviewStream.ts` |
| Preview and recording access | First exercise the macOS preview-to-recording transition. Retain concurrent access unless an actual contention failure is demonstrated. If it is demonstrated, release and join the preview before recording, using the existing exclusive-camera lifecycle and paused-preview presentation. | Automatically treating every AVFoundation source as exclusive would also pause desktop previews and would be a broader behavioural change. | `src-tauri/src/preview.rs::Preview::stop_for_recording`, `src/App.tsx`, [FFmpeg AVFoundation input](https://ffmpeg.org/ffmpeg-devices.html#avfoundation) |

## What it touches

| Area | Detail |
|---|---|
| Modules and READMEs | Frontend device selection, preview state and media-stage error handling; Rust preview process and transport handling. Update the root README's source selection and recovery guidance, and link detailed proof from `docs/VERIFICATION.md`. |
| Formats and contracts | Preserve source IDs, accessible control names and the IPC stream shape. Any additional first-frame callbacks are internal frontend props. |
| Storage | Existing session files and models are unchanged. Decoder diagnostics are bounded in memory; test artifacts remain in isolated ignored folders. |

## Test plan

| Scenario or logic | Test |
|---|---|
| All seven source-order and selection scenarios | New acceptance tests in `src/App.test.tsx`, named by the source-selection spec; test mixed discovery order, same-category stability, unavailable entries, camera-only and empty lists, refresh and disappearance. |
| Decoder failure details | New `src-tauri/src/preview.rs` unit/process tests: stderr is retained, bounded and readable after EOF; verbose stderr cannot deadlock; teardown releases the child and readers. Use synthetic subprocesses. |
| No viewer connects | New `preview.rs` transport test with an injectable short deadline; assert one actionable error and resource release. |
| A stream has no drawable image | New `MediaStage.test.tsx` and `usePreviewStream.test.tsx` tests with fake timers: timeout, Retry, first-frame success, obsolete URL cleanup and late-error isolation. |
| Camera preview and recording acceptance | The camera-capture spec's App and preview acceptance tests plus a packaged macOS run. Synthetic sources cover process/transport/rendering paths without camera access; actual camera transition and playback remain a `desk` check. |
| Regression suites | `npm test`, `npm run build`, `npm run build-storybook`; Rust fmt, Clippy and library tests with the AGENTS.md flags; commit, then `node tools/gate/gate.mjs --local`. Relevant ignored tests must use synthetic input unless a hardware run has fresh authorization. |

## Human checks

| Scenario | Check | What the person looks at |
|---|---|---|
| Display-first selection and picker order | desk | Fresh app selects an available display; opening the unchanged picker shows displays, windows, devices and cameras in that order. |
| Explicit built-in camera selection | desk | Choose FaceTime HD Camera; its preview shows the real view and updates. |
| Recording from an active camera preview | desk | Record, stop and replay the camera video in the app. Confirm no unexpected camera-access conflict. |
| Blocked camera and recovery | desk | A denied or unavailable camera gives useful guidance and Retry. After restoring access, retry without restarting the app. |

## Risks

- The initial camera failure has not been reproduced. Do not call it fixed merely because the CLI
  works; retain the owner's app check and any new diagnostic evidence.
- The owner authorized three bounded camera-only tests and those have been used. Further attended
  camera, screen or microphone runs need agreement as AGENTS.md requires. Synthetic tests need none.
- A timeout can fire after a source switch or on a slowly starting device. Tie it to the exact
  viewer URL, cancel it on cleanup and retain the established startup allowance.
- Decoder stdout and stderr must be consumed concurrently and killed before worker joins, or a
  preview switch can hang. Exercise failure and teardown with synthetic processes.
- If camera contention is reproduced, identify cameras by their source kind rather than treating
  all `avfoundation:` indices as cameras. Keep display preview behaviour intact.
