# WDQS field notes

Measured behaviour of the Wikidata Query Service, recorded so nobody has to
rediscover it. Every entry here cost real time to find. Dates are when measured;
WDQS performance drifts, so re-measure before trusting an old number.

Measured 2026-07-29 from a cloud container.

## The 60-second wall

WDQS kills queries at 60s and returns HTTP 504. There is no partial result. A
query that works on a small range will silently start failing as you widen it,
so every query shape here is recorded with the range it was tested against.

## `YEAR(?t)` is a trap

```sparql
FILTER(YEAR(?when) = 1944)          # 504, times out
FILTER(?when >= "1944-01-01"^^xsd:dateTime
    && ?when <  "1945-01-01"^^xsd:dateTime)   # 7.6s
```

The function call forces evaluation per row; the range comparison uses the
index. Always filter dateTime by range.

## UNION of two date properties does not scale

This was the single most expensive lesson. Measured against the deep-time
bucket (−13.8Ga to −1Ga):

| query | result |
| --- | --- |
| `p:P585` alone, no joins | 2.5s, ok |
| `p:P585` + enwiki sitelink filter | 3.7s, ok |
| `p:P585` + sitelinks + `ORDER BY DESC(?n)` | 3.3s, ok |
| `p:P580` + sitelinks + `ORDER BY DESC(?n)` | 0.85s, ok |
| `UNION` of P585/P580, no joins | 0.78s, ok |
| **`UNION` of P585/P580 + sitelinks + ORDER BY** | **504 at 65s** |

Each ingredient is fine alone. The combination defeats the planner. **Query one
date property at a time and merge client-side.**

The Blazegraph optimizer hint `hint:Query hint:optimizer "None"` was tried as a
fix and made things worse — still 504, no improvement.

## Bounded `VALUES` rescues expensive patterns

Anything that is unusably slow over an open-ended result set tends to be fine
when `VALUES` pins the input to a known list of QIDs:

- Label service over an open query: contributes to timeouts.
- Label service over `VALUES` with 100 QIDs: 0.7s.
- `wdt:P31/wdt:P279*` closure inside an anchor query: 504.
- Same closure over `VALUES` with 100 QIDs: 4.4s.

**Pattern: cheap anchor query to get IDs, then bounded second passes to enrich
them.** This is why `fetch-slice.mjs` has separate anchor / label / end-time
passes rather than one query.

## `OPTIONAL { ?item wdt:P31 ?type }` corrupts `LIMIT`

It multiplies rows — one per type statement. With `LIMIT 25`, an item with three
`P31` values consumes three slots. The limit then silently returns fewer
distinct items than asked for. Never combine row-multiplying OPTIONALs with
LIMIT; enrich in a second pass.

## Precision must come from the statement node

The truthy `wdt:P585` shortcut gives a value with no precision. To get it you
need the full statement value node:

```sparql
?item p:P585/psv:P585 [ wikibase:timeValue ?t ; wikibase:timePrecision ?prec ] .
```

Precision codes: 0 billion years, 1 hundred million, 2 ten million, 3 million,
4 hundred thousand, 5 ten thousand, 6 millennium, 7 century, 8 decade, 9 year,
10 month, 11 day, 12–14 hour/minute/second.

Measured distribution for events in 1900–1910 with an enwiki page:

| precision | count |
| --- | --- |
| 9 (year) | 3786 |
| 11 (day) | 1424 |
| 10 (month) | 268 |
| 7 (century) | 47 |
| 8 (decade) | 18 |

**Year precision outnumbers day precision roughly 3:1 even in the well-documented
modern era.** Any UI that renders these as exact points is lying most of the
time.

## Deep time works, but breaks JavaScript

Wikidata stores dates outside ±9999 in an extended ISO range:

```
Big Bang (Q323)        P585  -13787000000-01-01T00:00:00Z  precision 3
Hadean (Q104460)       P580  -4567300000-01-01T00:00:00Z   precision 4
Cambrian (Q79064)      P580  -538800000-01-01T00:00:00Z    precision 4
```

Two consequences:

1. Range `FILTER`s **do** work against these values — 5,439 items have a P580
   before −1Ma. Deep time is queryable.
2. **`new Date()` / `Date.parse()` cannot handle an 11-digit year.** It does not
   throw, it returns garbage. Parse with a regex, keep the year as a plain
   number, and never route these values through `Date`.

Deep-time items use `P580`/`P582` (start/end), not `P585`. Querying only `P585`
misses all of geology.

## Missing English labels are normal

`Q10872` is Archaea. It has an enwiki article and **no English label** in
Wikidata at all. Common for taxa. Always request the sitelink title
(`schema:name`) and fall back to it — you need the title for the REST summary
API anyway.

## Calendar scaffolding dominates unfiltered results

An unfiltered slice of 869 items came out **41% calendar units** — articles
about "2010", "29th century BC", "1990s". These are Wikipedia articles *about* a
time period, and plotting them at that time period is tautological.

Exact `P31` QIDs, from the full slice histogram:

| QID | label | count |
| --- | --- | --- |
| Q3186692 | calendar year | 169 |
| Q577 | year | 72 |
| Q578 | century | 59 |
| Q19828 | leap year | 29 |
| Q36507 | millennium | 19 |
| Q29964144 | year BC | 19 |
| Q39911 | decade | 18 |
| Q235729 | common year | 11 |
| Q235670/3/6/80/84/87/90 | "common year starting and ending on ⟨weekday⟩" | ~125 total |

**Exclude by direct `P31` match against that list.** Do not try to catch them
with a `P279*` closure: the only root that catches them all, `Q186081` (time
interval), also catches Cambrian, World War II, the Middle Ages and the
Jurassic — exactly what we want to keep. Verified:

```
EXCLUDED  Cambrian          EXCLUDED  World War II
EXCLUDED  Middle Ages       EXCLUDED  Jurassic
kept      French Revolution kept      history of architecture
```

## The P279* closure is cheap over VALUES, and worth caching

Measured 2026-08-06. Fetching the full superclass closure for the 377 distinct
`P31` types in the 525-item slice:

| pass | shape | cost |
| --- | --- | --- |
| closures | `VALUES ?type {50 QIDs} ?type wdt:P279* ?anc` | 8 queries, none slow |
| labels | `VALUES ?item {100 QIDs}` + label service | 16 queries, one 502 (retried fine) |

Closure sizes: min 2, median 36, max 132 ancestors per type. The whole thing is
~250 KB of JSON for 377 types, which is why it is cached in
`data/type-closures.json` rather than re-queried: **classification rules need
tuning, and tuning against live queries means re-querying on every edit.** With
the closures on disk a tuning round is instant and offline.

Do not add the label service to the closure query itself. It would label `?anc`
too, multiplying an already large result set. Labels come from a second bounded
pass over the distinct ancestor set — the same anchor-then-enrich shape as the
rest of the pipeline.

## Wikidata's upper ontology is useless for classification

Measured 2026-08-06. The most common ancestors across the slice, by number of
items that reach them:

| items | QID | label |
| --- | --- | --- |
| 515 | Q35120 | entity |
| 413 | Q99527517 | collective entity |
| 374 | Q488383 | object |
| 289 | Q246672 | mathematical object |
| 259 | Q67518978 | occurrent |
| 137 | Q748349 | mathematical structure |
| 88 | Q179899 | topological space |

That is 88 of 525 historical events reaching "topological space". Sense
collision is the rule, not the exception, and it does not stop at the top:

- `Q3505845` "state" reaches **104** items, almost none of them political — it
  is state-of-a-system, not statehood.
- `Q2424752` "product" reaches **100**, including every film and album.
- `Q123691918` "tool" reaches every currency in the slice.
- `Q1047113` "field of study" reaches 69.

**Choose roots by measuring which ancestors actually occur in the data, not by
browsing the ontology downward.** A root that looks specific from its label may
sit above a whole sense you did not intend. See `docs/decisions.md` for the
rules this produced and the four that were measured and thrown away.

## Some items have no P31 at all

`oven`, `torch`, `sickle` and `beer` are in the slice with a date and an enwiki
article and an **empty** `typeQids`. No classification rule can reach them —
there is nothing to classify. Worth remembering before writing a rule aimed at
a cluster you can see in the output: check the cluster actually has types
first.

## Notability ranking surfaces non-events

Ranking by sitelink count, the top of an unfiltered slice is: dog (332
languages), cat (321), animal (317), astronomy (316), Latin (303). These carry a
`P580` meaning "domesticated around" or "first appeared" — defensible data, but
not what a user means by an event. Taxa (`Q16521`, `Q23038290`) are ~13% of a
slice.

Current decision: **keep them, tag them as a category, let the user filter**.
Unlike calendar units they are not tautological. See DESIGN.md.

## Throughput and dumps

- `dumps.wikimedia.org` measured at **4.4 MB/s** from a cloud container.
- `latest-truthy.nt.bz2` is **43 GB** compressed (Content-Length 43,067,097,065,
  last modified 2026-07-17). ~2.7 hours of transfer minimum.
- The host **does** support range requests (`206`), so the pipeline can be
  developed against a slice without pulling the whole file.

## Etiquette

WDQS is volunteer-run. Send a descriptive `User-Agent` with a contact URL, keep
concurrency at 1, delay ~1.2s between queries, and back off on 429. A harvest
that finishes slowly beats one that gets the IP blocked.
