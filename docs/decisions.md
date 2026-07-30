# Decision log

What was chosen, what was rejected, and why. The rejected options are the
expensive part — they are recorded so they don't get retried.

Newest first.

---

## Frontend: plain ES modules, no build step

**Chosen:** plain JavaScript ES modules served statically.

**Rejected:** TypeScript + Vite (the original DESIGN.md guess).

A bundler buys nothing for two files, and a rotted `node_modules` is a common
way for a checkout to stop working months later. The project is meant to be
picked up cold by a new session. Revisit when the frontend outgrows a couple of
files — the migration is cheap and the data format is unaffected.

---

## Time axis: logarithmic in "years ago"

**Chosen:** internal coordinate `u = log10(yearsAgo + 1)`, viewport is a window
over u, zoom narrows the window.

**Rejected:** linear year axis. Over 13.8Gy, all of recorded history occupies
well under one pixel — not a scaling annoyance, a fundamental unusability.

**Rejected:** piecewise axis with hand-tuned segments per era. More control over
the geological/human transition, but the seams are arbitrary and every seam is a
place where zoom behaves discontinuously.

The log axis is locally near-linear once zoomed in, so panning and zooming feel
normal at every scale, and it naturally allocates screen space in proportion to
how much people care.

---

## Calendar units: excluded entirely

**Chosen:** drop items whose `P31` is a calendar unit (calendar year, year,
century, millennium, decade, year BC, leap year, "common year starting and
ending on ⟨weekday⟩").

**Rejected:** keeping them as a filterable category. They are tautological — an
article *about* "2010" placed at 2010 conveys nothing — and at **41% of an
unfiltered slice** they crowd out real events from every top-N cut.

**Rejected:** excluding via `wdt:P31/wdt:P279*` closure. No workable root. The
only root that catches all of them (`Q186081`, time interval) also catches
Cambrian, World War II, the Middle Ages and the Jurassic. Verified directly.
Direct `P31` matching against an explicit QID list it is.

---

## Taxa: kept, tagged, filterable

**Chosen:** keep items like Archaea and *fish*, tag them `life`, expose a filter.

**Rejected:** excluding them alongside calendar units.

They rank high by sitelink count and are not what most people mean by "event",
but "when this clade first appeared" is a real event at a real time. Unlike
calendar units the placement is meaningful, so this is a taste question — which
DESIGN.md resolves by making it the user's choice rather than ours.

---

## Ingestion: sharded WDQS first, dumps deferred

**Chosen:** sharded Query Service queries as the primary route to v1.

**Rejected (deferred to v3):** the `latest-truthy.nt.bz2` dump as the starting
point. 43 GB compressed, measured at 4.4 MB/s from a cloud container — ~2.7
hours of transfer before parsing a single triple, expanding to several hundred
GB of N-triples, on a container with 30 GB of free disk. It must be streamed,
so any failure restarts everything.

Sharded queries are resumable at shard granularity, individually cacheable, and
need no disk. The dump remains the eventual completeness answer, to be run
somewhere with real disk (a workstation, or Toolforge, which has the dumps
mounted locally).

---

## Query structure: one date property per query

**Chosen:** separate anchor queries for `P585` and `P580`, merged client-side,
then bounded second passes for labels, types and end times.

**Rejected:** a single `UNION` query fetching everything at once. Measured: each
ingredient is fast alone, the combination 504s on every deep-time bucket. Full
numbers in `docs/wdqs-notes.md`.

**Rejected:** the Blazegraph `hint:optimizer "None"` hint as a workaround. Tried,
made it worse.

---

## Type filtering: after fetch, with over-fetch

**Chosen:** fetch `perBucket * 4`, filter by type client-side, trim to
`perBucket`.

**Rejected:** filtering inside the anchor query. The `FILTER NOT EXISTS` closure
needed to do it costs more than it saves (504s), and filtering *after* a LIMIT
without over-fetching leaves buckets half empty.

---

## Bucket trimming: per bucket, not global

**Chosen:** apply the top-N cut within each era bucket.

**Rejected:** a global top-N by sitelink count. The modern era wins essentially
every slot — deep time disappears entirely from the timeline. Per-bucket
trimming is what keeps the Big Bang and the Cambrian on screen at all, and it is
the same principle the tile pipeline needs at full scale.

---

## No `generatedAt` timestamp in `data/slice.json`

**Chosen:** omit it.

It would churn the diff on every regeneration, making it impossible to see at a
glance whether the *data* actually changed. Provenance lives in git history.

---

## Known limitations in v0

Recorded so they are not rediscovered as bugs.

- **Spans wider than the viewport lose their labels.** The label is drawn to the
  right of the marker, or flipped left when that would overflow. A span whose
  both ends are off-screen has nowhere to put it, so it renders as an unlabelled
  full-width bar. The fix is to pin such labels to the viewport edge; not done
  yet.
- **Category mapping is a keyword hack.** `CATEGORY_RULES` in
  `tools/fetch-slice.mjs` matches substrings of P31 labels. It leaves ~40% of
  items in `other` (dog, cat, astronomy, Latin all fall through). DESIGN.md
  calls for a real `P279*` closure classification; that is v1 work.
- **`NOW` is a hardcoded constant** (`web/scale.js`). Fine for a timeline whose
  finest resolution is a day, wrong eventually.
- **The slice is 525 items, not a corpus.** Bucket coverage is deliberately
  uneven — 25 per era bucket regardless of how many events that era really has.
  Deep-time buckets are dominated by taxa because that is what has dates there.

---

## Canvas colours read from CSS custom properties

**Chosen:** the canvas resolves its colours from the same `--c-*` / `--cat-*`
tokens that style the chrome, cached and invalidated on theme change.

**Rejected:** hardcoded colour constants in `timeline.js` (what v0 shipped with).
A hosted page renders in the viewer's theme, so a hardcoded dark chart sits
inside a light page for anyone whose system prefers light mode — the chrome flips
and the chart does not.

**Rejected:** a JS palette object with a light and dark variant. Works, but then
the same colour is declared in two places and they drift. Tokens keep one source
of truth.

Category hues are separately tuned per theme rather than reused: `#d1495b` reads
correctly on `#0e1016` and goes muddy on white, so the light theme uses darker,
more saturated variants.

Two consequences worth knowing: span fills use `ctx.globalAlpha` rather than
appending alpha to a hex string, since a token may be authored as `rgb()`; and
the viewer's theme toggle stamps `data-theme` on the root element without firing
an event, so it needs a `MutationObserver`, not just a `matchMedia` listener.

---

## `dist/` is generated and gitignored

**Chosen:** build `dist/timeline.html` on demand with
`node tools/build-standalone.mjs`.

**Rejected:** committing the bundle. It embeds a full copy of `data/slice.json`,
so it silently goes stale whenever the slice is regenerated, and a stale
committed demo is worse than no committed demo. It also would not buy a working
link — GitHub serves raw HTML as `text/plain`.

The bundle exists because a hosted page under a strict CSP cannot fetch
`../data/slice.json`; everything has to be inline. It is generated from the same
`web/` sources the dev server uses, so the two cannot diverge.

---

## Nix: the fetcher is an app, the bundle is the package

**Chosen:** `flake-utils.lib.eachDefaultSystem`, with
`packages.default` = the bundled single-file site, `checks` = the scale tests
plus the bundle build, and the WDQS fetcher exposed as `apps.fetch-slice`.

**Rejected:** making the fetcher a package. A Nix build sandbox has no network,
so a derivation cannot query WDQS. Anything that talks to the network has to be
an app.

**Rejected:** shipping the `web/` + `data/` dev layout as the package. The dev
page fetches `../data/slice.json`, which only resolves when the server root is
the repo root — so a naive `$out` with `index.html` at the top would break. The
bundle has no fetch at all and sidesteps it, which is what DESIGN.md wants for
deployment anyway. `apps.dev` still serves the working tree for iteration.

**Not done: `flake.lock` is absent.** It could not be generated where this was
written — GitHub was unreachable for repositories outside the project's own
owner, so `nixpkgs` and `flake-utils` could not be resolved, and a lock pinning
the mirrors used for verification would have been actively misleading. Run
`nix flake lock` once locally.

The flake is otherwise verified rather than assumed: all outputs evaluated
clean, `packages.standalone`, `packages.default` and `checks.scale-tests` all
built (the check reporting 46 passed inside the sandbox), `nix run .#test`
worked, and the resulting `index.html` was loaded in Chromium in both themes
with zero console errors. Verification used `nixpkgs` from
`channels.nixos.org` and `flake-utils` from `flakehub.com`; the committed file
differs from the verified one only in those two input URLs.
