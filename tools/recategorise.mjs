#!/usr/bin/env node
// Re-classify an existing slice from the cached P279* closures, offline.
//
// The slice already stores every item's typeQids, so changing the category
// rules never requires re-harvesting — which is the whole reason the closures
// are cached separately from the classification. A tuning round is:
//
//   node tools/recategorise.mjs --dry-run     # histogram + samples + churn
//   $EDITOR tools/categorise.mjs
//   node tools/recategorise.mjs               # write it
//
// Usage: node tools/recategorise.mjs [--slice data/slice.json]
//                                    [--closures data/type-closures.json]
//                                    [--dry-run] [--show CATEGORY] [--samples N]

import { readFile, writeFile } from "node:fs/promises";
import { classify, CATEGORIES } from "./categorise.mjs";
import { argValue } from "./wdqs.mjs";

const args = process.argv.slice(2);
const slicePath = argValue(args, "--slice") ?? "data/slice.json";
const closurePath = argValue(args, "--closures") ?? "data/type-closures.json";
const dryRun = args.includes("--dry-run");
const show = argValue(args, "--show");
const samples = Number(argValue(args, "--samples") ?? 6);

const slice = JSON.parse(await readFile(slicePath, "utf8"));
const { closures, labels } = JSON.parse(await readFile(closurePath, "utf8"));

const missing = new Set();
const changes = [];
const byCategory = new Map(CATEGORIES.map((c) => [c, []]));

for (const item of slice.items) {
  for (const q of item.typeQids ?? []) if (!closures[q]) missing.add(q);
  const { category, via } = classify(item.typeQids, closures);
  if (category !== item.category) changes.push([item, item.category, category]);
  item.category = category;
  item.categoryVia = via;
  byCategory.get(category)?.push({ item, via });
}

const width = Math.max(...CATEGORIES.map((c) => c.length));
const total = slice.items.length;
for (const c of CATEGORIES) {
  const n = byCategory.get(c).length;
  const pct = ((n / total) * 100).toFixed(1);
  const bar = "#".repeat(Math.round((n / total) * 50));
  console.log(`${c.padEnd(width)} ${String(n).padStart(4)} ${pct.padStart(5)}%  ${bar}`);
}
console.log(`${"total".padEnd(width)} ${String(total).padStart(4)}`);

if (missing.size) {
  console.log(
    `\n${missing.size} type QIDs have no cached closure ` +
      `(run tools/fetch-closures.mjs): ${[...missing].slice(0, 8).join(" ")}`,
  );
}

// Which rule is doing the work, so a rule that fires far more than expected is
// visible rather than merely plausible.
if (!show) {
  const viaCount = new Map();
  for (const [c, list] of byCategory) {
    for (const { via } of list) {
      if (!via) continue;
      const k = `${c} <- ${via} ${labels[via] ?? ""}`;
      viaCount.set(k, (viaCount.get(k) ?? 0) + 1);
    }
  }
  console.log("\ntop rules by items matched:");
  for (const [k, n] of [...viaCount].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
}

for (const c of show ? [show] : CATEGORIES) {
  const list = byCategory.get(c) ?? [];
  if (!list.length) continue;
  console.log(`\n${c} (${list.length}):`);
  for (const { item, via } of list.slice(0, show ? list.length : samples)) {
    console.log(
      `  ${item.label.slice(0, 44).padEnd(46)} ` +
        `${(via ? `${via} ${labels[via] ?? ""}` : "—").slice(0, 34).padEnd(36)} ` +
        `[${item.types.join(", ").slice(0, 40)}]`,
    );
  }
}

console.log(`\n${changes.length} of ${total} items changed category`);

if (dryRun) {
  console.log("dry run — not written");
} else {
  slice.count = slice.items.length;
  await writeFile(slicePath, JSON.stringify(slice, null, 2) + "\n");
  console.log(`wrote ${slicePath}`);
}
