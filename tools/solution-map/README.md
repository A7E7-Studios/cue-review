# Solution map

A local web page over the [overview](../overview/README.md)'s index: what waits for the owner's
review, every feature by domain or by the system it ships in, and how well each is tested. It
serves on 127.0.0.1 only, deploys nothing and writes nothing. What it does for a person: the
kit's spec `overview/solution-map`.

No npm dependencies; Node 22 or later. It reads the overview's JSON **version 3** only.

```
node tools/solution-map/solution-map.mjs [--repo <id>=<folder>]... [--port <n>] [--pages <address>] [--no-open]
node tools/solution-map/solution-map.mjs --from <overview.json> [--port <n>] [--no-open]
```

| Option | Does |
|---|---|
| `--repo <id>=<folder>` | a repository to read, any number; without it, `solutionMap.repos` in the project's `tools/gate/config.json` |
| `--port <n>` | the port on 127.0.0.1; default 7317, or the next free one of the 20 after it |
| `--pages <address>` | the base address a Looks `page:` path is joined to; default `solutionMap.pages` |
| `--from <file>` | serve a saved overview instead of fetching and building one; boards are not served |
| `--no-open` | do not open the browser |

Exit: **2** on a usage error or a port it cannot listen on; otherwise it runs until stopped.

## Config

```json
{ "solutionMap": { "repos": [{ "id": "app", "path": "." }, { "id": "api", "path": "../notes-api" }], "pages": "http://localhost:5173" } }
```

`path` is relative to the repository the command runs in. `pages` is optional, and so is
`review.app`, the CueReview program Start review opens; without it, CueReview's default install:
`%LOCALAPPDATA%\Programs\CueReview\cuereview.exe` on Windows, the CueReview app on macOS,
`cuereview` on PATH on Linux.

## What one build does

On start, on opening the page and on Refresh:

1. **Fetch** each repository (`git fetch origin`, 20 s, in parallel). A repository with no
   `origin/main` is `missing`; one whose fetch fails is `stale` and keeps its existing
   `origin/main`, with the time of its last good fetch (`FETCH_HEAD`'s modification time).
2. **Build** the overview in the process (`buildOverview` from `tools/overview`) over every
   repository that is not missing, at `origin/main`. Another version than 3 gives a banner and an
   empty map.
3. **Ask** each Looks page address once whether it answers (`HEAD`, 2 s).
4. **Adapt** the index into the view model the page draws (`lib/adapt.mjs`, the only code that
   reads the overview's fields).

## Files

| Path | What |
|---|---|
| `solution-map.mjs` | the command line |
| `lib/sources.mjs` | naming, fetching and reading the repositories |
| `lib/build.mjs` | one build: fetch, overview, page probes, adapt |
| `lib/adapt.mjs` | the overview's JSON to the view model: features, the queue, the groups, links, banners |
| `lib/review.mjs` | Start review: where CueReview is, and opening it detached |
| `lib/server.mjs` | the HTTP server: the page, `GET /api/map`, `POST /api/refresh`, `POST /api/review`, `GET /board/<repo>/<path>?section=<id>`; a POST needs the header `x-solution-map: 1`, which only the map's own page sends |
| `page/` | the page: `index.html`, `style.css`, `view.mjs` (pure HTML from the view model), `app.mjs` (events and the address) |

- **Addresses**: `/waiting/<feature>`, `/explore/<feature>`, `/explore/by-system/<system>/<feature>`,
  `/search/<feature>?q=<text>`; a feature id is `<domain>/<capability>`.
- **Boards** come from git at the commit read, showing only the section with the id, in a sandboxed
  frame that runs no script.
- **Links** go to GitHub at the commit read, for a repository whose `origin` is on GitHub; any
  other repository gets plain text.
- **Theme**: light and dark follow the system; the page's toggle is kept in the browser. A project
  restyles the page by overriding its CSS custom properties in `kit-pages/theme.css`, served as
  `/theme.css` after the page's own styles.

## Tests

```
cd tools/solution-map && npm test     # node --test; throwaway repositories in the OS temp folder
```

The adapter and view tests run on a sample index held to the overview's schema
(`test/fixtures/overview-v3.json`, checked with the overview's own `test/schema.mjs`). The server
tests build bare origins and clones and push to them; the board test runs the kit's overview on a
spec there, the others a stand-in that reports only each repository's commit, so a fetch's effect
is seen alone.
