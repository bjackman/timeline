# Timeline — design

A zoomable timeline of every event and time period that has a Wikipedia page.

## Data source: Wikidata, not Wikipedia

Wikipedia article text is the wrong input — it's unstructured, and the dates
live in prose and inconsistent infoboxes. Wikidata already holds the structured
version:

- `P31` / `P279*` (instance-of / subclass-of) — selects the event and
  time-period subtrees.
- `P585` (point in time), `P580`/`P582` (start/end), `P571`/`P576`
  (inception/dissolution) — the dates.
- Sitelinks — an item's `enwiki` sitelink *is* the "has a Wikipedia page"
  filter, for free.

Licensing: Wikidata is CC0. Wikipedia article extracts, if shown, are CC BY-SA
4.0 and need attribution plus a link back to the source article.

Prior art: Histropedia built roughly this on Wikidata a decade ago. Worth
studying for what worked and where it stalled.

## Scope: the editorial question

Items with a date and an enwiki sitelink number in the low millions. That count
is dominated by long-tail regularities — every football season, every national
election, every asteroid discovery.

So the hard question isn't technical, it's editorial: does `1994 FIFA World Cup`
count? Does `Barack Obama` (a person is a time period)? Does `Roman Empire`?

**Decision: don't answer it.** Ingest everything with a date, classify each item
into ~10 top-level categories via the `P279*` closure, and make category filters
a first-class UI control. The hard scoping call becomes a checkbox.

Categories: conflict, disaster, politics, science, culture, sport, space,
disease, geological era, historical period, lifespan.

## Ingestion: sharded WDQS first, dumps later

Two routes exist. Measured behaviour decides the order.

### Primary: sharded Wikidata Query Service

Naive queries time out — the query service caps at 60s, and a `YEAR(?when)`
filter forces a full scan. Rewritten as a range filter over the raw dateTime,
the same query is index-friendly and fast:

```sparql
SELECT ?item ?itemLabel ?when WHERE {
  ?item wdt:P585 ?when .
  FILTER(?when >= "1944-01-01"^^xsd:dateTime && ?when < "1945-01-01"^^xsd:dateTime)
  ?sl schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```

Measured: 7.6s for a count, ~15s for rows. 1,053 items for 1944 alone.

Shard by month for dense modern periods, by decade or century for sparse ancient
ones. The corpus becomes a few thousand independent queries. Each shard is
cacheable, resumable, and checkpointed to disk — a crash costs one shard, not
the run.

WDQS is volunteer-run infrastructure. Rate limit, set a descriptive
`User-Agent`, and back off on 429.

Known gap: `wdt:` truthy predicates drop qualifier nuance (e.g. a date that
holds only under a particular `P518` applies-to-part). Acceptable for v1.

### Secondary: the full dump

`latest-truthy.nt.bz2` is the completeness answer, and eventually necessary. Not
the starting point:

- 43 GB compressed. Measured throughput to `dumps.wikimedia.org` from a cloud
  container: **4.4 MB/s** — ~2.7 hours of transfer before parsing a single
  triple.
- Decompressed it's several hundred GB of N-triples.
- It exceeds the free disk on a typical ephemeral container, so it must be
  streamed, and any failure restarts the whole run.

Run it on a machine with real disk, or on Toolforge, which has the dumps mounted
locally. The pipeline code can be written and tested against a slice — the dump
host supports range requests.

## Time representation — three things that will bite

**Precision is not a timestamp.** Wikidata dates carry explicit precision, from
day up through decade, century, and on to billions of years. Rendering "circa
15th century" as a tick on 1400-01-01 is a lie the UI would tell thousands of
times. Store `(year, month, day, precision)` and render uncertainty as a visible
band, not a point.

**13.8 billion years down to a single day.** A linear axis is useless. The
transition between geological and human scales needs deliberate design — it's
the signature moment of the whole product.

**Calendars.** Pre-1582 dates carry a Julian/Gregorian calendar model flag, and
there is no year zero. Get this wrong once and every ancient date is off.

## Serving: a 1-D map tile problem

A million items can't be rendered, and can't be queried per-frame. But this is a
solved problem — it's a slippy map with one axis.

Precompute tiles offline: `/tiles/{z}/{x}.json`, each holding the top ~200 items
in that time bucket at that zoom. An item appears at the lowest zoom where it
qualifies, like map label placement. The client dedupes by ID so zooming doesn't
double-add.

Serve as static JSON from a CDN. No backend, no database, no request-time
queries. Article summaries come from Wikimedia's REST
`page/summary/{title}` endpoint — CORS-enabled and cached, so preview cards need
no server either.

**Notability ranking is load-bearing**, since tiles are a top-N cut. The
cheapest strong signal is sitelink count — how many language Wikipedias carry
the article. Blend with pageview dumps and statement count.

Under the main track, a density histogram showing "+4,200 more events here".
That is what makes a top-N cut honest rather than a silent truncation.

## Stack

As built in v0 — this section originally guessed Rust and TypeScript, and the
guess did not survive contact with the work. See `docs/decisions.md`.

- Ingestion: Node, no dependencies. The bottleneck is WDQS latency and the
  politeness delay between queries, not local compute, so a faster language buys
  nothing. Revisit for the dump route, where parsing hundreds of GB of
  N-triples *is* compute-bound — Rust earns its place there.
- Frontend: plain JavaScript ES modules + canvas. No build step. Canvas rather
  than DOM because it is thousands of elements per frame; plain JS rather than
  TypeScript because a bundler buys nothing at two files and a rotted
  `node_modules` is how a checkout stops working six months later.
- Time-scale logic lives in `web/scale.js`, kept DOM-free so it can be tested
  headlessly (`tools/test-scale.mjs`). It is the part most likely to be subtly
  wrong in ways that still look plausible on screen.
- Hosting: static. GitHub Pages or Cloudflare Pages.

## Phasing

- **v0 — done.** Sharded WDQS pull, 525 items from the Big Bang to the present,
  rendered on a log axis with zoom, pan, precision bands, category filters and a
  density strip. Proved the zoom UX, which was the risky part. See
  `docs/decisions.md` for what it does not do yet.
- **v0.1 — done.** Category classification via the `P279*` closure, replacing
  the keyword placeholder. Done before the harvest rather than after, because
  categories are assigned at fetch time: harvesting millions of items under
  rules that misfile 40% of them bakes the mistake into every tile. The
  closures are cached, so re-tuning never re-queries and re-classifying never
  re-harvests.
- **v1** — full sharded harvest, tiling, notability ranking.
- **v2** — category filters, search, preview cards.
- **v3** — dump-based completeness pass, pageview ranking, images, other
  language Wikipedias.

Do v0 before writing any pipeline code. The time-axis UX is where this succeeds
or fails, and it's testable with 5,000 rows.
