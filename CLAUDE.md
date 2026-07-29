# Timeline

A zoomable timeline of every event and time period that has a Wikipedia page.

**Read `DESIGN.md` first** for the architecture and why it is that way.
**Read `docs/wdqs-notes.md` before writing any SPARQL** — it records measured
query behaviour that is not obvious and cost real time to find.

## Where things are

```
DESIGN.md                   architecture and phasing
docs/wdqs-notes.md          measured WDQS behaviour — read before touching queries
docs/decisions.md           decision log: chosen, rejected, why; known limitations
tools/fetch-slice.mjs       builds the v0 dev slice from WDQS
tools/test-scale.mjs        headless tests for the time-scale maths
tools/build-standalone.mjs  bundles everything into one self-contained HTML file
tools/screenshot.mjs        renders the page at several zooms (needs playwright)
data/slice.json             the v0 slice (committed; regenerate with the tool)
web/                        canvas frontend, no build step
dist/                       derived, gitignored
```

## Running it

No build, no dependencies, no server framework. Node 22+ for the fetcher.

```sh
# tests for the time-scale maths — fast, no network
node tools/test-scale.mjs

# serve — must be over http, the page fetches ../data/slice.json
python3 -m http.server 8000
# then open http://localhost:8000/web/

# regenerate the data slice (~20 min, hits WDQS politely)
node tools/fetch-slice.mjs --per-bucket 25

# bundle into one file that opens straight off disk, no server
node tools/build-standalone.mjs      # -> dist/timeline.html
```

`tools/screenshot.mjs` needs Playwright, which is deliberately not a dependency:
`npm install --no-save playwright`. It prefers an already-installed Chromium over
downloading one, since an ad-hoc install usually wants a browser build the
machine does not have.

`web/` is plain ES modules on purpose. A bundler buys nothing at this size and
costs a working checkout when `node_modules` rots. Revisit if the frontend
outgrows a couple of files.

## Current state

v0. A ~500-item slice spanning the Big Bang to the present renders on a
logarithmic "years ago" axis with zoom, pan, category filters and precision
bands. The full harvest is not built yet.

See `DESIGN.md` for phasing. Next up is v1: the full sharded harvest and the
tile pipeline.

## Things that will bite you

These are load-bearing. Each one is a bug that has already been hit.

- **Never put a Wikidata date through `Date`.** Deep-time years have 11 digits
  (`-13787000000-01-01T00:00:00Z`). `Date.parse` does not throw on these, it
  returns garbage. Parse with a regex, keep the year as a number.
- **Precision is not a timestamp.** Every date carries a precision code from
  billion-years down to seconds, and year-precision outnumbers day-precision
  ~3:1 even in the modern era. Rendering a precision-3 value as a point is
  wrong. The UI draws bands.
- **Never `UNION` two date properties and then join sitelinks.** It reliably
  504s. One property per query, merge client-side. See `docs/wdqs-notes.md`.
- **Never combine a row-multiplying `OPTIONAL` with `LIMIT`.** An item with
  three `P31` values eats three slots and the limit silently under-returns.
- **Calendar units must be excluded by direct `P31` match**, never by `P279*`
  closure — every closure root broad enough to catch them also catches Cambrian
  and World War II.
- **Wikidata items may have no English label.** Fall back to the enwiki sitelink
  title.
- **Canvas colours must come from the CSS tokens**, via `palette()` in
  `web/timeline.js` — never hardcoded. The page renders in the viewer's light or
  dark theme, and a hardcoded chart goes dark-on-light for anyone preferring
  light mode. Adding a colour means adding a `--c-*` or `--cat-*` token to
  `web/index.html` in **all three** theme blocks: `:root`, the
  `prefers-color-scheme: dark` media query, and both `[data-theme]` overrides.
- **Do not hand-edit `dist/timeline.html`.** It is generated; edit `web/` and
  rebuild.

## Working style for this repo

The point of the docs above is that a fresh session can pick this up cold.
Keep that true:

- When a measurement contradicts an assumption, record it in
  `docs/wdqs-notes.md` with the numbers.
- When a design fork is resolved, record the rejected option and why in
  `docs/decisions.md`. The rejected options are the expensive part.
- Prefer comments that explain *why* over *what*, especially for the query
  shapes — they look arbitrary and are not.

## Etiquette

WDQS and the Wikimedia dumps are volunteer-run. Descriptive `User-Agent`,
concurrency 1, ~1.2s between queries, back off on 429. Do not launch a full
harvest casually.

Data is CC0 (Wikidata). Wikipedia article extracts, if shown, are CC BY-SA and
need attribution plus a link back.
