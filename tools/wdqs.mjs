// Shared Wikidata Query Service client.
//
// The politeness settings live here rather than in each tool, so anything that
// talks to WDQS inherits them by construction. WDQS is volunteer-run: one
// request at a time, a descriptive User-Agent with a contact URL, a delay
// between queries, and exponential backoff on failure.
//
// Read docs/wdqs-notes.md before writing a new query. Most of the query shapes
// in this project look arbitrary and are not — they are what survived
// measurement.

export const ENDPOINT = "https://query.wikidata.org/sparql";
export const UA = "timeline-dev/0.1 (https://github.com/bjackman/timeline)";

// A harvest that finishes slowly beats one that gets the IP blocked.
export const DELAY_MS = 1200;
const MAX_RETRIES = 4;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wikidata entity URI -> QID. Every query here returns URIs, never bare QIDs.
export const qidOf = (uri) => uri.split("/").pop();

export async function sparql(query) {
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

// Split a list into fixed-size chunks. Every expensive pattern in this project
// becomes affordable when VALUES pins the input size up front, so chunking is
// the default shape of a second pass, not an optimisation.
export function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
