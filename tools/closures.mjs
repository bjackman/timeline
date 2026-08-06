// Fetching and caching P279* closures. Shared by the standalone
// tools/fetch-closures.mjs and by the harvest in tools/fetch-slice.mjs, so a
// fresh harvest classifies its own new types without a second manual step.
//
// The cache is keyed by type QID and stores the closure whole rather than a
// pre-computed category, because the category rules are the part that changes.
// See tools/categorise.mjs.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { sparql, sleep, chunks, qidOf, DELAY_MS } from "./wdqs.mjs";

export const DEFAULT_CLOSURE_PATH = "data/type-closures.json";

// A bounded VALUES set is what makes the closure affordable at all — the same
// pattern inside an open-ended anchor query 504s (docs/wdqs-notes.md). 50
// rather than 100 because this returns one row per (type, ancestor) pair, not
// one per type: a chunk of 50 is already a few thousand rows.
const CLOSURE_CHUNK = 50;

// Measured at 0.7s for 100 QIDs. No reason to push it.
const LABEL_CHUNK = 100;

function closureQuery(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  // No label service here. It would label ?anc as well, multiplying an already
  // large result by the cost of the label lookup; labels come from a separate
  // bounded pass over the distinct ancestor set instead.
  return `
SELECT ?type ?anc WHERE {
  VALUES ?type { ${values} }
  ?type wdt:P279* ?anc .
}`;
}

function labelQuery(qids) {
  const values = qids.map((q) => `wd:${q}`).join(" ");
  return `
SELECT ?item ?itemLabel WHERE {
  VALUES ?item { ${values} }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

// Stable key order, so a re-fetch that changes nothing produces no diff.
function sortedObject(obj) {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k]]),
  );
}

export async function readCache(path = DEFAULT_CLOSURE_PATH) {
  try {
    const json = JSON.parse(await readFile(path, "utf8"));
    return { closures: json.closures ?? {}, labels: json.labels ?? {} };
  } catch (e) {
    if (e.code === "ENOENT") return { closures: {}, labels: {} };
    throw e;
  }
}

export async function writeCache(cache, path = DEFAULT_CLOSURE_PATH) {
  const out = {
    source: "Wikidata Query Service",
    license: "CC0 (Wikidata)",
    note: "P279* closure per P31 type, including the type itself. Cached so category tuning is offline.",
    closureCount: Object.keys(cache.closures).length,
    closures: sortedObject(cache.closures),
    labels: sortedObject(cache.labels),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(out, null, 2) + "\n");
  return out;
}

// Fill in any closures the cache is missing, and label everything in the
// resulting graph. Mutates and returns `cache`. Fetches nothing when the cache
// already covers the requested types, which is the common case.
export async function ensureClosures(typeQids, cache, { labels = true } = {}) {
  const wanted = [...new Set(typeQids)].sort();
  const missing = wanted.filter((q) => !cache.closures[q]);
  console.error(
    `closures: ${wanted.length} distinct types, ` +
      `${wanted.length - missing.length} cached, ${missing.length} to fetch`,
  );

  for (const [n, chunk] of chunks(missing, CLOSURE_CHUNK).entries()) {
    process.stderr.write(
      `  closures ${n * CLOSURE_CHUNK}..${n * CLOSURE_CHUNK + chunk.length} of ${missing.length}\n`,
    );
    // Seed every requested type, so a type with no P279 statement at all is
    // recorded as fetched-and-empty rather than looking missing forever.
    const seeded = new Map(chunk.map((q) => [q, new Set([q])]));
    for (const r of await sparql(closureQuery(chunk))) {
      seeded.get(qidOf(r.type.value))?.add(qidOf(r.anc.value));
    }
    for (const [q, set] of seeded) cache.closures[q] = [...set].sort();
    await sleep(DELAY_MS);
  }

  if (!labels) return cache;

  // Labels for the types and every ancestor. Not used for classification — the
  // rules match by QID — but they are what makes the cache file readable when
  // tuning the rules by hand, which is most of the work.
  const needLabels = [
    ...new Set(
      wanted.flatMap((q) => [q, ...(cache.closures[q] ?? [])]),
    ),
  ]
    .filter((q) => !cache.labels[q])
    .sort();
  for (const [n, chunk] of chunks(needLabels, LABEL_CHUNK).entries()) {
    process.stderr.write(
      `  labels ${n * LABEL_CHUNK}..${n * LABEL_CHUNK + chunk.length} of ${needLabels.length}\n`,
    );
    for (const r of await sparql(labelQuery(chunk))) {
      const q = qidOf(r.item.value);
      const l = r.itemLabel?.value;
      // The label service echoes the QID back when there is no English label.
      if (l && l !== q) cache.labels[q] = l;
    }
    await sleep(DELAY_MS);
  }

  return cache;
}
