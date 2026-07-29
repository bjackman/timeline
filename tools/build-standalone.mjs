#!/usr/bin/env node
// Bundle the timeline into one self-contained HTML file with the data inlined.
//
//   node tools/build-standalone.mjs [--out dist/timeline.html]
//
// Needed because a hosted Artifact runs under a strict CSP: no external fetches,
// so `fetch("../data/slice.json")` cannot work and every asset must be inline.
// Generated from the same sources the dev server uses, so the two cannot drift —
// do not hand-edit the output.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const argValue = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = argValue("--out", "dist/timeline.html");

const [html, scale, timeline, sliceRaw] = await Promise.all([
  readFile("web/index.html", "utf8"),
  readFile("web/scale.js", "utf8"),
  readFile("web/timeline.js", "utf8"),
  readFile("data/slice.json", "utf8"),
]);

// Compact the JSON — pretty-printing is for the committed file, not the payload.
const slice = JSON.stringify(JSON.parse(sliceRaw));

// Concatenate the two modules into one classic script: strip the export keywords
// and the import statement that joins them. Crude, but the alternative is a
// bundler dependency for two files, and the surface is small enough to verify.
function flatten(src) {
  return src
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*$/m, "")
    .replace(/^export\s+(const|function|class|let)\s/gm, "$1 ");
}

const script = `${flatten(scale)}\n${flatten(timeline)}`;

if (/^\s*(import|export)\s/m.test(script)) {
  console.error("refusing to build: module syntax survived flattening");
  process.exit(1);
}

// Inject the data ahead of the script. JSON embedded in HTML must not be able to
// close the script element early; `<` is the only character that can do it.
const dataTag = `<script>window.__SLICE__=${slice.replace(/</g, "\\u003c")};</script>`;

const out = html
  .replace('<script type="module" src="./timeline.js"></script>', `${dataTag}\n    <script>\n${script}\n    </script>`)
  .replace(
    "<title>Timeline — 13.8 billion years of Wikipedia</title>",
    "<title>Timeline — 13.8 billion years of Wikipedia</title>",
  );

if (out.includes('src="./timeline.js"')) {
  console.error("refusing to build: script tag was not replaced");
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `wrote ${OUT} — ${kb(out.length)} total ` +
    `(${kb(slice.length)} data, ${kb(script.length)} code)`,
);
