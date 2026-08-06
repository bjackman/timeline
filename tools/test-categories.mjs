#!/usr/bin/env node
// Headless tests for closure-based category classification. Same style as
// test-scale.mjs: assertions on pure functions, no framework, no network.
//
//   node tools/test-categories.mjs
//
// Two kinds of test here, and the second kind is the point:
//
//   1. Structural — the rule table is well formed.
//   2. Golden — real items from the committed slice, classified through the
//      committed closures, land in the category a reader would expect.
//
// The golden cases are deliberately the ambiguous ones. Every single one has
// types that match two categories, so each is really a test that the ORDER of
// RULES is right. Reordering the table to fix one classification is exactly
// how another silently regresses.

import { readFile } from "node:fs/promises";
import { classify, RULES, CATEGORIES } from "./categorise.mjs";

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --- structure ------------------------------------------------------------

{
  const seen = new Map();
  const dupes = [];
  for (const [root, cat] of RULES) {
    if (seen.has(root)) dupes.push(`${root} (${seen.get(root)} and ${cat})`);
    seen.set(root, cat);
  }
  check("no root QID appears twice", dupes.length === 0, dupes.join(", "));
}

check(
  "every rule names a known category",
  RULES.every(([, c]) => CATEGORIES.includes(c)),
  RULES.filter(([, c]) => !CATEGORIES.includes(c))
    .map(([r, c]) => `${r}->${c}`)
    .join(", "),
);

check(
  "every rule root looks like a QID",
  RULES.every(([r]) => /^Q\d+$/.test(r)),
  RULES.filter(([r]) => !/^Q\d+$/.test(r))
    .map(([r]) => r)
    .join(", "),
);

check(
  "'other' is never a rule target — it is the fallthrough",
  RULES.every(([, c]) => c !== "other"),
);

// --- fallthrough ----------------------------------------------------------

check("no types at all classifies as other", classify([], {}).category === "other");
check("undefined types classifies as other", classify(undefined, {}).category === "other");
check(
  "an unknown type with no closure classifies as other",
  classify(["Q99999999"], {}).category === "other",
);
check(
  "a type that is itself a root matches without a closure entry",
  classify(["Q16521"], {}).category === "life",
  "ancestorsOf falls back to the type itself",
);

// --- ordering, on a synthetic closure -------------------------------------
// Cheap to state, and independent of whatever the real ontology does today.

{
  const closures = {
    QwarPeriod: ["QwarPeriod", "Q350604", "Q11514315"], // conflict + period
    QolympicPolity: ["QolympicPolity", "Q13406554", "Q1063239"], // sport + politics
    QcountryPeriod: ["QcountryPeriod", "Q3024240", "Q17524420"], // politics + period
  };
  check(
    "conflict beats period",
    classify(["QwarPeriod"], closures).category === "conflict",
  );
  check(
    "sport beats politics",
    classify(["QolympicPolity"], closures).category === "sport",
  );
  check(
    "politics beats aspect-of-history",
    classify(["QcountryPeriod"], closures).category === "politics",
  );
}

{
  // The union of an item's types is what gets classified, not just the first.
  const closures = { Qa: ["Qa"], Qb: ["Qb", "Q16521"] };
  check(
    "a later type still classifies the item",
    classify(["Qa", "Qb"], closures).category === "life",
  );
}

// --- golden cases against the committed data ------------------------------

const { closures } = JSON.parse(await readFile("data/type-closures.json", "utf8"));
const slice = JSON.parse(await readFile("data/slice.json", "utf8"));
const byQid = new Map(slice.items.map((i) => [i.qid, i]));

// [QID, expected category, why it is ambiguous]
const GOLDEN = [
  ["Q362", "conflict", "World War II — world war AND historical period"],
  ["Q6534", "conflict", "French Revolution — revolution AND historical event"],
  ["Q2277", "politics", "Roman Empire — historical country AND historical period"],
  ["Q4692", "culture", "Renaissance — art movement AND cultural movement"],
  ["Q81068910", "disaster", "COVID-19 — pandemic AND disease outbreak"],
  ["Q10876", "life", "bacteria — taxon, the deep-time backbone"],
  ["Q4916", "other", "euro — a currency is none of our categories, and must not be forced into one"],
];

for (const [qid, want, why] of GOLDEN) {
  const item = byQid.get(qid);
  if (!item) {
    check(`golden ${qid} is present in the slice`, false, why);
    continue;
  }
  const got = classify(item.typeQids, closures);
  check(
    `${item.label} -> ${want}`,
    got.category === want,
    `got ${got.category} via ${got.via} (${why})`,
  );
}

{
  // The regression this whole exercise exists to prevent: the keyword-matching
  // classifier it replaces left 40% of the slice in "other".
  const counts = {};
  for (const item of slice.items) {
    const { category } = classify(item.typeQids, closures);
    counts[category] = (counts[category] ?? 0) + 1;
  }
  const otherFraction = counts.other / slice.items.length;
  check(
    "fewer than a fifth of slice items fall through to other",
    otherFraction < 0.2,
    `got ${(otherFraction * 100).toFixed(1)}%`,
  );
  check(
    "every category except science has items in the slice",
    CATEGORIES.filter((c) => c !== "science").every((c) => counts[c] > 0),
    // science is thin by data, not by bug — see the note in categorise.mjs.
    CATEGORIES.filter((c) => !counts[c]).join(", "),
  );
}

// --- report ---------------------------------------------------------------

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
