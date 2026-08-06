# Timeline

A zoomable timeline of every event and time period that has a Wikipedia page.

**Read `DESIGN.md` first** for the architecture and why it is that way.
**Read `docs/wdqs-notes.md` before writing any SPARQL** — it records measured
query behaviour that is not obvious and cost real time to find.

## Where things are

```
flake.nix                   Nix packaging (flake-utils), with flake.lock committed
DESIGN.md                   architecture and phasing
docs/wdqs-notes.md          measured WDQS behaviour — read before touching queries
docs/decisions.md           decision log: chosen, rejected, why; known limitations
tools/wdqs.mjs              shared WDQS client: politeness, retries, chunking
tools/fetch-slice.mjs       builds the v0 dev slice from WDQS
tools/closures.mjs          fetches and caches P279* type closures
tools/fetch-closures.mjs    CLI over the above, for types outside the slice
tools/categorise.mjs        ordered closure rules -> category (pure, no network)
tools/recategorise.mjs      re-classify a slice from the cache (offline, instant)
tools/test-scale.mjs        headless tests for the time-scale maths
tools/test-categories.mjs   headless tests for the category rules
tools/test-render.mjs       headless render tests against a stub DOM
tools/build-standalone.mjs  bundles everything into one self-contained HTML file
tools/screenshot.mjs        renders the page at several zooms (needs playwright)
data/slice.json             the v0 slice (committed; regenerate with the tool)
data/type-closures.json     cached P279* closures + labels (committed)
web/                        canvas frontend, no build step
dist/                       derived, gitignored
```

## Running it

### With Nix

```sh
nix run                 # build and serve the bundle on :8000
nix run .#dev           # serve the working tree (repo root) at /web/
nix run .#test          # the time-scale tests
nix run .#fetch-slice   # re-fetch data/slice.json from Wikidata (~20 min)
nix run .#fetch-closures   # fill in missing P279* type closures
nix run .#recategorise -- --dry-run   # re-classify from the cache, offline
nix build               # -> result/index.html, deployable as-is
nix flake check         # tests + bundle build
nix develop             # node, python3, jq
nix fmt                 # nixfmt-rfc-style
```

**On virtiofs, use `path:` rather than the bare flake ref.** Nix's bundled
libgit2 cannot read packfiles on a virtiofs mount, so every `nix` command in a
checkout under `/mnt/src` fails with `object not found` and a spurious "Git
tree is dirty". `nix flake check 'path:/mnt/src/timeline'` bypasses the git
fetcher and works. Verified: the same repo copied to ext4 works, and a copy
left on virtiofs with its objects unpacked to loose works — it is packfiles on
virtiofs specifically.

The fetcher is an **app, not a package**, because it needs network and a Nix
build sandbox has none. `packages.default` is the bundled single file rather than
the `web/` + `data/` dev layout, since the dev page fetches
`../data/slice.json` and that only resolves when the server root is the repo
root.

### Without Nix

Node 22+ for the tools, Python for the server.

```sh
# tests — fast, no network
node tools/test-scale.mjs
node tools/test-categories.mjs
node tools/test-render.mjs      # layout invariants over the real slice

# re-classify the slice after editing the category rules — offline, instant
node tools/recategorise.mjs --dry-run     # histogram, sample items, churn
node tools/recategorise.mjs               # write it back to data/slice.json

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
bands. Categories come from the real `P279*` closure, not keywords. The full
harvest is not built yet.

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
- **Never pick a classification root by browsing the ontology.** Measure which
  ancestors actually occur first. Wikidata's upper ontology puts 88 of 525
  historical events under "topological space", files every currency under
  "tool" and every film under "product". `RULES` in `tools/categorise.mjs` is
  **ordered and the order is load-bearing** — a war is also a historical
  period, a historical country is also a polity. Reordering it to fix one
  classification is how another regresses, which is what
  `tools/test-categories.mjs` exists to catch.
- **Wikidata items may have no English label.** Fall back to the enwiki sitelink
  title.
- **Canvas colours must come from the CSS tokens**, via `palette()` in
  `web/timeline.js` — never hardcoded. The page renders in the viewer's light or
  dark theme, and a hardcoded chart goes dark-on-light for anyone preferring
  light mode. Adding a colour means adding a `--c-*` or `--cat-*` token to
  `web/index.html` in **all three** theme blocks: `:root`, the
  `prefers-color-scheme: dark` media query, and both `[data-theme]` overrides.
- **Lane assignment must not depend on where the viewport is.** `computeLanes`
  packs every item in *year space*, globally, so panning cannot move an item to
  a different row. Packing only the visible items — the obvious thing — makes
  the whole timeline reshuffle as items enter at the edges. Lanes may depend on
  the zoom, because a label's width is fixed in pixels and so covers more years
  the further out you go; nothing else.
- **What is fixed must be known before what is negotiable.** Bands are fixed by
  lane packing; labels can move, flip, pin or drop. So `render` collects every
  visible band *first* and only then places labels against all of them. Placing
  labels as bands are discovered puts a notable item's label on top of a bar it
  had not seen yet — 162 such overlaps across 405 test viewports.
- **Never measure canvas text in one font and draw it in another.** Nothing
  enforces that they agree, so the box comes out narrower than the text. This
  is why the hover card is DOM: the browser lays it out, and it can hold real
  links. Canvas text that remains (labels, ticks) measures and draws with the
  same constant.
- **The main axis is linear** (`LinearView`). The log `View` still exists but
  only projects the navigator strip. Do not reintroduce it as the main axis;
  see `docs/decisions.md` for why it was reversed.
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

## Committing

**This project is entirely vibe-coded, commit history included.** Nobody is
writing these commits by hand, so do not wait to be asked: when a piece of work
reaches a working state, commit it. Committing directly on `master` is the
normal flow here.

Normal best practice still applies, and matters *more* here rather than less —
the history is the only account of how this was built:

- **Small commits that step from one working state to the next.** Not one giant
  commit at the end of a session, and not a snapshot of a half-finished
  refactor.
- **Never commit something broken.** Run the tests first — `node
  tools/test-scale.mjs` and `node tools/test-categories.mjs`, plus `nix flake
  check 'path:.'` when the flake changed. A commit that does not build is worse
  than no commit, because it makes `git bisect` lie.
- **Order the commits so each one stands alone.** If a change needs a new
  module, the module lands first. A commit that only works because of the next
  one is a broken commit.
- **Write the message the way the existing ones are written**: imperative
  subject, then prose explaining *why*, what was measured, and what was
  verified. Same standard as the docs — the rejected option is the expensive
  part.
- Derived files (`dist/`, `result`) are gitignored and stay that way. Data
  files (`data/slice.json`, `data/type-closures.json`) are committed, so a
  regeneration that churns them belongs in its own commit.

## Etiquette

WDQS and the Wikimedia dumps are volunteer-run. Descriptive `User-Agent`,
concurrency 1, ~1.2s between queries, back off on 429. Do not launch a full
harvest casually.

Data is CC0 (Wikidata). Wikipedia article extracts, if shown, are CC BY-SA and
need attribution plus a link back.
