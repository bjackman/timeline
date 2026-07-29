#!/usr/bin/env node
// Fetch the v0 development slice: a few hundred events spanning the Big Bang to
// the present, chosen as the top-N most notable per era bucket.
//
// This is deliberately a miniature of the eventual tiling pipeline — era buckets
// are proto-tiles, and "top N by sitelink count" is the notability ranking we
// will need at full scale. If this shape is wrong, better to learn it at 500
// rows than at 500,000.
//
// Every non-obvious query decision here was forced by measurement. See
// docs/wdqs-notes.md before changing any of them.
//
// Usage: node tools/fetch-slice.mjs [--out data/slice.json] [--per-bucket 25]

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "timeline-dev/0.1 (https://github.com/bjackman/timeline)";

// Politeness. WDQS is volunteer-run infrastructure; a slow harvest that
// completes beats a fast one that gets us blocked.
const DELAY_MS = 1200;
const MAX_RETRIES = 4;

// We filter by type *after* fetching, because doing it in SPARQL costs more
// than it saves (see docs/wdqs-notes.md). Filtering after a LIMIT would leave
// half-empty buckets, so over-fetch and trim.
const OVERFETCH = 4;

// Era buckets, log-spaced through deep time and progressively finer through
// recorded history. Values are absolute years (negative = BCE). These are the
// v0 stand-in for tile boundaries.
const BUCKETS = [
  [-13_800_000_000, -1_000_000_000],
  [-1_000_000_000, -100_000_000],
  [-100_000_000, -10_000_000],
  [-10_000_000, -1_000_000],
  [-1_000_000, -100_000],
  [-100_000, -10_000],
  [-10_000, -3000],
  [-3000, -1000],
  [-1000, 0],
  [0, 500],
  [500, 1000],
  [1000, 1500],
  [1500, 1700],
  [1700, 1800],
  [1800, 1900],
  [1900, 1950],
  [1950, 1980],
  [1980, 2000],
  [2000, 2010],
  [2010, 2020],
  [2020, 2027],
];

// Calendar scaffolding. An article about "2010" is not an event that happened
// in 2010 — plotting it is tautological, and at 41% of an unfiltered slice it
// drowns everything else out.
//
// Matched against P31 directly rather than through a P279* closure. The closure
// route was tried and rejected: the only root that caught all of these
// (Q186081, time interval) also swallows Cambrian, World War II, the Middle
// Ages and the Jurassic, which are precisely what we want to keep.
const EXCLUDE_TYPES = new Set([
  "Q3186692", // calendar year
  "Q577", // year
  "Q578", // century
  "Q36507", // millennium
  "Q39911", // decade
  "Q29964144", // year BC
  "Q19828", // leap year
  "Q235729", // common year
  // "common year starting and ending on <weekday>" — one QID per weekday.
  "Q235670",
  "Q235673",
  "Q235676",
  "Q235680",
  "Q235684",
  "Q235687",
  "Q235690",
]);

// Provisional category mapping, keyed on P31 label substrings. This is a
// placeholder for the P279* closure classification described in DESIGN.md —
// good enough to make colour mean something in v0, not good enough to ship.
const CATEGORY_RULES = [
  [/\b(war|battle|siege|conflict|revolution|invasion|massacre)\b/i, "conflict"],
  [/\b(extinction|earthquake|disaster|epidemic|pandemic|famine|eruption)\b/i, "disaster"],
  [/\b(taxon|clade|species)\b/i, "life"],
  [/\b(geological|epoch|era|period|age)\b/i, "geology"],
  [/\b(election|treaty|country|state|empire|dynasty|monarch)\b/i, "politics"],
  [/\b(discovery|invention|experiment|mission|spaceflight)\b/i, "science"],
  [/\b(film|album|television|book|artwork|game)\b/i, "culture"],
  [/\b(olympics|championship|tournament|season)\b/i, "sport"],
  [/\b(historical period|historical country)\b/i, "period"],
];

function categorise(typeLabels) {
  for (const label of typeLabels) {
    for (const [re, cat] of CATEGORY_RULES) {
      if (re.test(label)) return cat;
    }
  }
  return "other";
}

// Wikidata time precision codes. Keep the whole scale — deep time uses the top
// end and we must never render a "million years" value as a day.
const PRECISION = {
  0: "billion years",
  1: "hundred million years",
  2: "ten million years",
  3: "million years",
  4: "hundred thousand years",
  5: "ten thousand years",
  6: "millennium",
  7: "century",
  8: "decade",
  9: "year",
  10: "month",
  11: "day",
  12: "hour",
  13: "minute",
  14: "second",
};

// Format an absolute year as an xsd:dateTime literal WDQS will accept.
// Years outside 0..9999 are the whole point here: Wikidata uses an extended
// range, and the filters do work against it (verified against P580 < -1e6).
function yearLiteral(year) {
  if (year < 0) return `-${String(-year).padStart(4, "0")}-01-01T00:00:00Z`;
  return `${String(year).padStart(4, "0")}-01-01T00:00:00Z`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = 2000 * 2 ** (attempt - 1);
      console.error(`    retry ${attempt} in ${backoff}ms (${lastErr})`);
      await sleep(backoff);
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          Accept: "application/sparql-results+json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.status === 429 || !res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      return json.results.bindings;
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`query failed after ${MAX_RETRIES} retries: ${lastErr}`);
}

// Anchor times: a point in time (P585) or a start time (P580). We take the
// statement-value node rather than the truthy `wdt:` shortcut because that is
// the only way to get timePrecision, which we must not lose.
//
// One property per query, deliberately. Combining P585 and P580 in a UNION and
// then joining sitelinks makes the planner give up — every deep-time bucket
// 504s at the 60s limit, while each property queried alone with the identical
// filter, join and ORDER BY returns in under 4s.
//
// Labels and P31 are NOT fetched here. An OPTIONAL P31 multiplies rows, so an
// item with three type statements would eat three LIMIT slots and silently
// crowd out other events. Both are resolved in a bounded second pass instead.
function anchorQuery(prop, lo, hi, limit) {
  return `
SELECT ?item ?sitelinks ?title ?t ?prec WHERE {
  ?item p:${prop}/psv:${prop} [ wikibase:timeValue ?t ; wikibase:timePrecision ?prec ] .
  FILTER(?t >= "${yearLiteral(lo)}"^^xsd:dateTime && ?t < "${yearLiteral(hi)}"^^xsd:dateTime)
  ?item wikibase:sitelinks ?sitelinks .
  ?sl schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title .
}
ORDER BY DESC(?sitelinks)
LIMIT ${limit}`;
}

// Labels and types for a bounded set of IDs. Cheap because VALUES pins the
// result size up front — the same query shape is unusably slow when the set is
// open-ended. Returns one row per (item, type) pair; the caller collects them.
function labelQuery(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  return `
SELECT ?item ?itemLabel ?type ?typeLabel WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P31 ?type . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

function endTimeQuery(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  return `
SELECT ?item ?t ?prec WHERE {
  VALUES ?item { ${values} }
  ?item p:P582/psv:P582 [ wikibase:timeValue ?t ; wikibase:timePrecision ?prec ] .
}`;
}

// Wikidata's extended-range years break Date.parse — an 11-digit year is not
// something the JS Date constructor will touch, and it will not throw either,
// it just returns garbage. Parse by hand, keep the year as a plain number, and
// never route these through Date.
const TIME_RE = /^([+-]?\d+)-(\d{2})-(\d{2})T/;

function parseTime(literal) {
  const m = TIME_RE.exec(literal);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

const qidOf = (uri) => uri.split("/").pop();

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const outPath = argValue(args, "--out") ?? "data/slice.json";
  const perBucket = Number(argValue(args, "--per-bucket") ?? 25);

  const byQid = new Map();

  for (const [bucketIndex, [lo, hi]] of BUCKETS.entries()) {
    process.stderr.write(`bucket ${lo} .. ${hi}\n`);
    for (const [prop, kind] of [
      ["P585", "point"],
      ["P580", "start"],
    ]) {
      const rows = await sparql(anchorQuery(prop, lo, hi, perBucket * OVERFETCH));
      for (const r of rows) {
        const qid = qidOf(r.item.value);
        const t = parseTime(r.t.value);
        if (!t) {
          console.error(`    unparseable time on ${qid}: ${r.t.value}`);
          continue;
        }
        // An item can carry both a P585 and a P580. P585 is queried first and
        // wins, since a point in time is the more specific claim.
        if (byQid.has(qid)) continue;
        byQid.set(qid, {
          qid,
          // Falls back to the enwiki title when Wikidata has no English label.
          // This is not rare: Archaea (Q10872) has an enwiki article and no
          // en label at all, which is common for taxa.
          label: r.title.value,
          title: r.title.value,
          sitelinks: Number(r.sitelinks.value),
          types: [],
          typeQids: [],
          category: "other",
          start: t,
          startPrecision: Number(r.prec.value),
          startPrecisionName: PRECISION[Number(r.prec.value)] ?? "unknown",
          anchorKind: kind,
          end: null,
          endPrecision: null,
          bucketIndex,
        });
      }
      process.stderr.write(`    ${prop}: ${rows.length} rows\n`);
      await sleep(DELAY_MS);
    }
  }

  // Labels and types, in bounded chunks.
  const allQids = [...byQid.keys()];
  for (let i = 0; i < allQids.length; i += 100) {
    const chunk = allQids.slice(i, i + 100);
    process.stderr.write(`labels ${i}..${i + chunk.length}\n`);
    for (const r of await sparql(labelQuery(chunk))) {
      const item = byQid.get(qidOf(r.item.value));
      if (!item) continue;
      if (r.itemLabel?.value && !r.itemLabel.value.startsWith("Q")) {
        item.label = r.itemLabel.value;
      }
      if (r.type?.value) {
        const tq = qidOf(r.type.value);
        if (!item.typeQids.includes(tq)) item.typeQids.push(tq);
        const tl = r.typeLabel?.value;
        if (tl && !item.types.includes(tl)) item.types.push(tl);
      }
    }
    await sleep(DELAY_MS);
  }

  // Drop calendar scaffolding, then trim each bucket back to perBucket. Trimming
  // per bucket rather than globally is what keeps deep time on the timeline at
  // all — the modern era would otherwise win every slot on sitelink count.
  const excluded = [];
  const kept = new Map();
  for (const item of byQid.values()) {
    if (item.typeQids.some((t) => EXCLUDE_TYPES.has(t))) {
      excluded.push(item);
      continue;
    }
    item.category = categorise(item.types);
    kept.set(item.qid, item);
  }

  const perBucketKept = new Map();
  for (const item of kept.values()) {
    const list = perBucketKept.get(item.bucketIndex) ?? [];
    list.push(item);
    perBucketKept.set(item.bucketIndex, list);
  }
  const selected = [];
  for (const [, list] of perBucketKept) {
    list.sort((a, b) => b.sitelinks - a.sitelinks);
    selected.push(...list.slice(0, perBucket));
  }

  // End times only for what survived, to avoid wasting queries.
  const selectedQids = selected.map((i) => i.qid);
  const byQidSelected = new Map(selected.map((i) => [i.qid, i]));
  for (let i = 0; i < selectedQids.length; i += 100) {
    const chunk = selectedQids.slice(i, i + 100);
    process.stderr.write(`end times ${i}..${i + chunk.length}\n`);
    for (const r of await sparql(endTimeQuery(chunk))) {
      const item = byQidSelected.get(qidOf(r.item.value));
      const t = parseTime(r.t.value);
      if (item && t) {
        item.end = t;
        item.endPrecision = Number(r.prec.value);
      }
    }
    await sleep(DELAY_MS);
  }

  const items = selected.sort((a, b) => a.start.year - b.start.year);

  const out = {
    // No generatedAt timestamp: it would churn the diff on every run and make
    // it hard to see whether the data actually changed.
    source: "Wikidata Query Service",
    license: "CC0 (Wikidata)",
    perBucket,
    buckets: BUCKETS.length,
    count: items.length,
    excludedAsCalendarUnits: excluded.length,
    precisionScale: PRECISION,
    items,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");

  const spans = items.filter((i) => i.end).length;
  console.error(
    `\nwrote ${outPath}: ${items.length} items (${spans} spans), ` +
      `${excluded.length} calendar units dropped, ` +
      `${items[0].start.year} .. ${items[items.length - 1].start.year}`,
  );
}

await main();
