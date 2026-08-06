#!/usr/bin/env node
// Fetch the P279* (subclass-of) superclass closure for every P31 type in a
// slice, and cache it to data/type-closures.json.
//
// tools/fetch-slice.mjs does this itself for the types it harvests, so this
// tool is for the case where the rules need types the current slice does not
// have — or where a slice was produced before closures existed.
//
// Usage: node tools/fetch-closures.mjs [--slice data/slice.json]
//                                      [--out data/type-closures.json]
//                                      [--refresh]

import { readFile } from "node:fs/promises";
import { argValue } from "./wdqs.mjs";
import {
  ensureClosures,
  readCache,
  writeCache,
  DEFAULT_CLOSURE_PATH,
} from "./closures.mjs";

const args = process.argv.slice(2);
const slicePath = argValue(args, "--slice") ?? "data/slice.json";
const outPath = argValue(args, "--out") ?? DEFAULT_CLOSURE_PATH;
const refresh = args.includes("--refresh");

const slice = JSON.parse(await readFile(slicePath, "utf8"));
const types = slice.items.flatMap((i) => i.typeQids ?? []);

const cache = refresh ? { closures: {}, labels: {} } : await readCache(outPath);
await ensureClosures(types, cache);
const out = await writeCache(cache, outPath);

const sizes = Object.values(out.closures)
  .map((a) => a.length)
  .sort((a, b) => a - b);
console.error(
  `\nwrote ${outPath}: ${sizes.length} types, ` +
    `${Object.keys(out.labels).length} labels, closure size ` +
    `min ${sizes[0]} / median ${sizes[sizes.length >> 1]} / max ${sizes[sizes.length - 1]}`,
);
