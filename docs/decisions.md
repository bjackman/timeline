# Decision log

What was chosen, what was rejected, and why. The rejected options are the
expensive part — they are recorded so they don't get retried.

Newest first.

---

## Axis: linear, with the log axis kept as the navigator

**Reverses the "logarithmic in years ago" decision below, which is superseded.**

**Chosen:** a linear window over years, `(centre, span)`, as the main axis. The
log axis survives as a fixed navigator strip along the bottom.

**Why the reversal:** the log axis made everything visible at once but nothing
comparable. It is impossible to see that the Phanerozoic is a twenty-fifth of
Earth's history when the projection bends every duration. Seeing deep time to
scale, and then zooming into human history as a slice of it, is the point of
the product; a log axis cannot show it at any zoom.

The numbers the design has to survive, at 1400px:

| | |
| --- | --- |
| one pixel, at full view | 9.86 My |
| the whole Phanerozoic | 55 px |
| everything since the first *Homo* | 0.3 px |
| recorded history | 5×10⁻⁴ px |
| zoom range, full view to one day | 5×10¹² |

**Rejected: fixed-point or split arithmetic** for that range. `LinearView`
holds `(centre, span)` rather than `(left, right)` so `x()` subtracts years
*within the window* before scaling, which ties float64's resolution to the
window rather than to the age of the universe. At 13.8 Ga the representable
increment is about 70 seconds — a million times finer than the data's precision
there.

**Rejected: era presets** ("Universe / Life / Hominins / Modern") as the way to
travel. They are a menu of destinations, not navigation. What shipped instead
is several mechanisms that natively cross orders of magnitude: wheel zoom that
accelerates while the gesture continues (66 notches from the Big Bang to a day,
against ~160 at a flat rate), trackpad pinch, right-drag for continuous
exponential zoom, shift-drag to box-select a range, and the two strips.

**Rejected: three significant figures in tick labels.** `formatYear` is right
for a hover card and wrong for an axis: a 14,000-year window at 6.9 Ga rendered
six identical "6.90 Ga" labels and the axis looked frozen. `formatTickYear`
takes its decimals from the tick *step*, guaranteeing adjacent ticks differ.

---

## Layout: what is fixed must be known before what is negotiable

Two overlap bugs, one root cause. Worth stating as a principle because it will
recur wherever placement is greedy.

**A band's position is fixed** by lane packing. **A label's is negotiable** —
it can sit right, flip left, pin inside its own band, or be dropped. So every
band must be known before any label is placed.

**Chosen:** lanes are assigned globally in year space for all items at once,
then rendering runs in two passes — collect every visible band, then place
labels against all of them in notability order.

**Rejected: packing only the visible items, per frame.** Panning changed the
input set, so an item arriving at one edge moved everything else to a different
row; the timeline danced while scrubbing. Lane assignment now takes no input
from the viewport's position, so panning cannot change a row by construction.
Verified: 60 pan steps, 3,772 item-frames, 14 items entering view, zero lane
changes.

Lanes still depend on the *zoom*, and must: a label is fixed in pixels, so it
covers more years the further out you go. A 5% scale tolerance stops the rows
twitching during a zoom gesture.

**Rejected: placing labels while discovering bands.** A notable item chooses
early, flips left, and lands on the band of a less notable item not yet
reached — and that band cannot move. Measured: 162 labels sitting on a bar
across 405 viewports, including COVID-19 over Proterozoic.

**Rejected: reserving label space on both sides during packing.** It would keep
packing viewport-independent while making flips safe, but doubles every item's
footprint permanently to fix a case that arises at the canvas edges only.

**Rejected: a greedy packer that tracks only each lane's rightmost edge.** It
refuses any item starting left of that even when they cannot overlap. Real
interval checks lifted the full view from 32 items shown to 52.

---

## Edges: the axis runs past both ends of time

**Chosen:** 80px of margin beyond the Big Bang and beyond the present.

**Rejected: clamping hard to `[BIG_BANG, NOW]`.** The present then sits exactly
on the right edge, so the only cursor position that keeps it in view while
zooming is the final pixel — anchor anywhere to its left and it slides off, and
you have to zoom, then pan back, then zoom again. With a margin the newest
events are something you can put a cursor on: pointing at the present and
scrolling holds it at x=1320 of 1400 across 45 notches, from 13.8 Gy down to a
single day.

Pixels rather than a fraction of the span, so the margin looks the same at
every zoom. It also gives present-day labels somewhere to go other than
flipping left — which was a cause of the label collisions above.

Ticks are clipped to real time and the ends are drawn as dashed hairlines, so
the margin reads as the edge of what exists rather than as a rendering failure.

---

## The minimap floors its mark, and says so

**Chosen:** a fixed linear minimap above the detail view, with leader lines to
the detail view's edges, the viewport mark floored at 2px, and a caption giving
the true fraction.

The viewport is routinely far below a pixel on it — at full zoom, one part in
five trillion of history. The floor is a deliberate lie about *width*, and the
only one: the position is exact, the leader lines run to the true edges, and
the caption states the real fraction. Without the floor there is nothing to
see; without the caption the floor overstates how much of time is on screen by
a factor of a million.

**Why both strips:** the log navigator can show every era legibly and cannot
show proportion; the linear minimap shows proportion and cannot show recent
history at all. Neither does the other's job.

---

## The hover card is DOM, not canvas

**Chosen:** a positioned DOM element, kept alive for 260ms after the pointer
leaves the item and cancelled when the pointer enters the card.

**Rejected: drawing it on the canvas**, which is what v0 did. Canvas text is
measured and drawn in separate calls and nothing enforces that the two agree —
the card measured its title in `UI_FONT` and painted it at 650 weight, so long
titles ("Sustainable Development Goals") ran out of a box sized for narrower
text. Letting the browser lay out text removes the whole class of bug, and only
DOM can hold real links: Wikipedia and Wikidata as anchors that can be
right-clicked, opened in a tab, and reached by keyboard.

The delay is load-bearing rather than polish: without it the card cannot be
reached at all, and the Wikidata link is unclickable.

---

## Bad upstream data is fixed upstream, not filtered in the pipeline

**Chosen:** treat Wikidata as golden. When a value is garbage, fix it on
Wikidata rather than working around it here.

**Rejected (for now):** a validation pass that drops self-contradictory deep
time values. The case that raised it: Gondwana (Q80583) had an end time of
`-0335-00-00T00:00:00Z` at precision 3 — "335 BCE, known to the nearest million
years". The intent was 335 **Ma**; the value is a million times too small. It
rendered as a bar stretching from ~500 kya to the present day, because a
precision-3 band is ±500,000 years wide and the band swamped the value.

The rule that would catch it, if it is ever wanted: **a value whose magnitude
is smaller than its own precision granularity is self-contradictory.** Measured
against the 525-item slice it flags Gondwana and nothing else — no false
positives.

Also measured, and worse: **"the year must be a multiple of the granularity"
wrongly flags 19 legitimate items**, including Paleolithic (`-3300000` at
million-year precision), Upper Paleolithic and Aurignacian (`-38000` at
ten-thousand-year precision) and most century-precision dates like `-3351`.
Wikidata does not round values to their stated precision, so that rule is not
usable. Do not reach for it.

Deferred rather than rejected outright: precision handling deserves a general
strategy, and this is one input to it, not the whole question.

Worth knowing when checking a suspect value: **WDQS lags the authoritative
data**, and different replicas disagree. Gondwana's start time read as broken
through the query service minutes after it had already been fixed upstream.
`Special:EntityData/Q<id>.json` is the source of truth. Note it stores unknown
month and day as `00`, which `wikibase:timeValue` normalises to `01` — so the
two views of the same statement differ in a way that looks like a bug and is
not.

---

## Categories: P279* closure, ordered rules, cached offline

**Chosen:** classify each item by expanding its `P31` types to their full
`P279*` superclass closure and matching against an **ordered flat list** of
root QIDs (`tools/categorise.mjs`). The closures are fetched once and cached in
`data/type-closures.json`; the classification itself is pure and offline.

**Rejected:** the keyword-substring rules this replaces. Measured on the same
525-item slice: **40.4% of items in `other`**, `science` with 2 items, and
`geology` inflated to 62 by a rule matching the word "period" or "age" in any
type label. After the closure rules: **14.5% other**, and the categories mean
what they say. Full before/after:

| category | keyword rules | closure rules |
| --- | --- | --- |
| conflict | 66 | 82 |
| disaster | 9 | 15 |
| life | 113 | 120 |
| geology | 62 | 15 |
| politics | 26 | 55 |
| science | 2 | 4 |
| culture | 23 | 80 |
| sport | 12 | 31 |
| period | 0 | 47 |
| other | **212** | **76** |

**Rejected: a map of category -> roots.** The priority that matters is between
individual roots, not between categories. A war is also a historical period; an
Olympic Games edition is also a recurring event; a historical country is both a
polity and a period. A flat ordered list makes those precedences explicit and
testable, and `tools/test-categories.mjs` pins the ambiguous cases so that
reordering to fix one cannot silently regress another.

**Rejected: four broad "last resort" roots**, tried at the very end of the list
where they could only catch leftovers, to drain the residual `other`. Each was
measured and removed — the numbers are in `tools/categorise.mjs`, kept next to
the code so they are not re-derived:

| root | what it actually caught |
| --- | --- |
| `Q2424752` product | Titanic, Oktoberfest, April Fools' Day, hamburger |
| `Q123691918` tool | every currency in the slice, filed as science |
| `Q42240` research | Hellenistic period, via "middle chronology" |
| `Q11862829` academic discipline | early modern period, via "academic major" |
| `Q336` science | Hellenistic period again, and pinyin — both its matches |

Their target — the daily-life technology in `other` (oven, torch, sickle,
beer) — turned out to be unreachable by any rule: those items carry no `P31`
statement at all. A rule cannot fix missing data.

**Why the closures are cached rather than queried during classification:** the
rules are the part that changes. With the closures on disk, a tuning round is
`recategorise.mjs --dry-run`, an edit, and a re-run — offline, instant, and
zero load on WDQS. The slice stores each item's `typeQids`, so re-classifying
never requires re-harvesting either.

**Accepted imprecision:** `Q10931` revolution is filed under conflict, which is
right for the American, French, Russian, Iranian, Glorious and October
revolutions and wrong for the Neolithic Revolution — 1 of 9 in the slice.
Dropping the rule loses eight correct classifications to fix one, so it stays.
Terrorist attacks and assassinations currently land in `disaster` rather than
`conflict`; defensible either way, not yet worth a rule.

Each item also records `categoryVia`, the root QID that matched, so a
surprising category can be traced to the rule that caused it without
re-deriving anything.

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

**Superseded** by the linear-axis entry at the top of this file. Kept because
the reasoning below is still why the log axis exists at all — it is now the
navigator strip rather than the main axis, and the rejected options below are
still rejected.

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

- ~~**Spans wider than the viewport lose their labels.**~~ Fixed: `placeLabel`
  in `web/scale.js` pins them inside the visible part of the band. It mattered
  more than it sounds — at 25x zoom, 13 of the 16 visible items were unlabelled.
- ~~**Category mapping is a keyword hack.**~~ Fixed: `P279*` closure
  classification, above. The residual `other` is 14.5% and is genuinely
  miscellaneous — currencies, historical ethnic groups, archaeological sites,
  scripts, and items with no `P31` at all. None of the ten categories fits
  them, and forcing one would be worse than the honest fallthrough. At harvest
  scale the residual is worth re-examining: settlements, buildings and
  organisations will be large enough to deserve categories of their own, which
  the ten-token palette does not yet have.
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

**`flake.lock` is now committed** (2026-08-06), generated against the real
inputs — `nixpkgs` b7c2ada, `flake-utils` 11707dc — on a machine where GitHub
was reachable. `nix flake check` passes there against the committed lock.

Getting it required a workaround worth recording: nix's bundled libgit2 cannot
read packfiles on a **virtiofs** mount, which is what `/mnt/src` is, so any
`nix` command in the checkout fails with `object not found` on a commit that
`git cat-file` resolves fine, plus a spurious "Git tree is dirty". Isolated by
elimination — a fresh repo with loose objects works, a copy of this repo on
ext4 works, and a copy left on virtiofs with its objects unpacked to loose also
works. Use `nix ... 'path:/mnt/src/timeline'`, which skips the git fetcher
entirely.

The flake is otherwise verified rather than assumed: all outputs evaluated
clean, `packages.standalone`, `packages.default` and `checks.scale-tests` all
built (the check reporting 46 passed inside the sandbox), `nix run .#test`
worked, and the resulting `index.html` was loaded in Chromium in both themes
with zero console errors. Verification used `nixpkgs` from
`channels.nixos.org` and `flake-utils` from `flakehub.com`; the committed file
differs from the verified one only in those two input URLs.
