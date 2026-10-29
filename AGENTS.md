# Agent instructions — CueReview

CueReview records a review (a display, a window or an Android/Quest device, with the microphone
and system audio), transcribes it locally and hands the evidence to an agent through the `cue`
CLI. Claude Code and Codex read this file natively. What the app is and how to run it:
[README.md](README.md); how it works: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the design
system: [docs/DESIGN.md](docs/DESIGN.md); the tests, scripts and hardware checks:
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Specs and changes

The workflow is the faster-spec kit's: [specs/README.md](specs/README.md),
[changes/README.md](changes/README.md), the four skills in `.agents/skills/` (spec, design, ship,
triage). The kit's files are a vendored copy pinned by `tools/kit/lock.json`; never edit them here
([tools/kit/README.md](tools/kit/README.md)). Run `node tools/setup-agents/setup.mjs` once per
checkout or worktree.

| Check | Here |
|---|---|
| Human checks | `desk`: the app at a Windows computer (recording, playback, the window chrome, an Android device on USB), Storybook, the `cue` CLI's output, a gate run on GitHub. `headset`: a Quest capture checked wearing the headset. The other checks have no use here |
| A build | an installed release: `build <version>` (`0.2.0`), the version the installer's name and Windows' installed-apps list show; its commit is `git rev-parse v<version>^{commit}`, the tag the release was published from. A build from source: `build <short sha>`, its commit that sha; a build from a dirty tree is no build to check. The app shows no version itself |
| A look | Storybook or the running app, [below](#rendering-a-look) |
| The other repository | none: CueReview is the whole solution |
| Restricted material | none |

- **Every behaviour change carries a change folder** and edits the living spec of the capability it
  touches in the same pull request; a capability gets its spec with the first change that touches
  it. Which pull requests need none:
  [changes/README.md](changes/README.md#which-pull-requests-carry-a-change-folder).
- The domains are in [specs/domains.json](specs/domains.json): capture, transcription, the review
  workspace and the agent CLI.
- **Only the owner's word sets `pass` or `fail`** on a PROOF line; agents write `test:` and `open`.
- **The owner merges** a pull request that touches a protected path (`tools/gate/config.json`
  `protectedPaths`: the kit, `.github/`, the agent rules and settings, the Tauri capabilities and
  configs, the release script, the licence); the gate's `protected` check fails it and an agent
  never merges it.

## Quality gate

Every suite for what changed is green before a change is done. The commands and what each covers
are in [docs/VERIFICATION.md](docs/VERIFICATION.md#unattended-set); per area:

| Changed | Run |
|---|---|
| Anything | `node tools/gate/gate.mjs --local` (commit first: it reads git objects, not the working tree) |
| `src/`, `.storybook/`, `index.html`, `package.json`, the Vite or TypeScript config | `npm test`, `npm run build`, `npm run build-storybook` |
| `src-tauri/` | `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml --lib --locked` |
| Capture, takes, transcription, the CLI, recovery, the window chrome | also the ignored integration tests and `scripts/verify-*` that cover the area: [the tests](docs/VERIFICATION.md#ignored-integration-tests), [the scripts](docs/VERIFICATION.md#scripts) |
| The kit (a sync) | `cd tools/gate && npm test`, `cd tools/overview && npm test`, `cd tools/kit && npm test`, `cd tools/setup-agents && npm test`, `node tools/kit/sync.mjs --check` |

- **Attended runs** record the screen, a window or the microphone, play tones or move the pointer:
  tell the owner before one starts, and run only the ones the owner agrees to
  ([attended runs](docs/VERIFICATION.md#attended-runs)). Anything that needs a device or a person
  and was not run is named under the pull request's `## Not verified`.
- Every behaviour change lands **with** its test. The scripts find controls by the accessible names
  in `src/workspace/types.ts` (`NAMES`); renaming one is a breaking change.
- A test never touches the normal app data: tests and scripts use an isolated
  `CUEREVIEW_DATA_DIR`, as the scripts already do.

## Rendering a look

The component library is the app's own: `src/ui/` (tokens in `src/ui/tokens.css`, the dialog),
`src/chrome/`, `src/workspace/`, `src/dialogs/` and `src/Sidebar.tsx`, with the rules, tokens and
mocks in [docs/DESIGN.md](docs/DESIGN.md). Storybook is the working specification.

- **Storybook.** `npm run storybook` serves `http://127.0.0.1:6006`. One story alone, for a
  screenshot: `http://127.0.0.1:6006/iframe.html?id=<story-id>&viewMode=story&globals=theme:dark`
  (`theme:light`, `motion:reduced`). Screenshot it with Playwright (a dev dependency;
  `npx playwright install chromium` once) at the sizes DESIGN.md names, at most 1280 px wide.
  `npm run build-storybook` writes the same workshop to `storybook-static/` for a static server.
  Story fixtures replace the backend: no capture, microphone or files.
- **The running app**, for what only it shows (native capture, real playback, the window chrome):
  the release build as a test app on CDP port 9224 with its own data folder
  ([how](docs/VERIFICATION.md#scripts)), then `node scripts/inspect-desktop.cjs`, which prints
  what the window shows and saves `test-results/ui/desktop.png`. It clicks nothing.

## Worktrees

Worktrees live under the main checkout's `.claude/worktrees/` (ignored), one per change, cut from
a freshly fetched `origin/main`:

```
git fetch origin
git -C "$(git rev-parse --path-format=absolute --git-common-dir)/.." worktree add .claude/worktrees/<change-id> -b <change-id> origin/main
```

Then, inside it, `npm ci` and `node tools/setup-agents/setup.mjs`.

## Documentation

- Each fact has one home: the specs for behaviour and its proof, README.md for installing, running
  and building, docs/ARCHITECTURE.md for how it works, docs/DESIGN.md for the design system,
  docs/VERIFICATION.md for the tests, the scripts and the recorded evidence, a tool's README for
  that tool, this file for the rules. Link to a fact's home; never restate it.
- Living docs (specs, READMEs, docs/ARCHITECTURE.md, this file) state what IS: no history, no
  status, no pull request numbers or dates outside PROOF lines. Rewrite, don't append. Write a hex
  colour as inline code.
- Byte budgets: this file 32 KiB, a README 40 KiB, a spec and each `.md` of a change folder 30 KiB.

## Commit style

- A sentence-case imperative subject, no prefix, no trailing period, about 70 characters at most:
  `Keep device frames after a portrait/landscape rotation`, `Track Android touches in device
  recordings`. A pull request is squash-merged, so its title is the subject on main.
- The body, wrapped at 72, says in prose what now happens and why, and how it was verified (a test,
  a device, a script). One logical change per commit.
- Code changed where its nearest README does not change carries a `Doc-Impact: none; <reason>`
  trailer on one of the pull request's commits.
- Commit on a branch, never on `main`.
