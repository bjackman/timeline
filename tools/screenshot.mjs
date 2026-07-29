#!/usr/bin/env node
// Render the timeline at several zoom levels and write PNGs. This is the only
// way to check the thing that actually matters — that the axis is legible from
// the Big Bang down to a single day — since the tests can only assert on the
// maths, not on whether the result reads.
//
//   python3 -m http.server 8000 &
//   node tools/screenshot.mjs [--out /tmp/shots] [--url http://localhost:8000/web/]
//
// Playwright is not a project dependency; install it ad hoc:
//   npm install --no-save playwright

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";

const args = process.argv.slice(2);
const argValue = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const OUT = argValue("--out", "/tmp/shots");
const URL = argValue("--url", "http://localhost:8000/web/");

// Each shot zooms toward a screen x, then screenshots. Zooming toward the right
// edge walks forward through time, which is how a user actually explores.
const SHOTS = [
  { name: "01-full", steps: 0, x: 0.5, note: "everything: Big Bang to now" },
  { name: "02-deep", steps: 10, x: 0.22, note: "deep time / geology" },
  { name: "03-history", steps: 14, x: 0.70, note: "recorded history" },
  { name: "04-modern", steps: 20, x: 0.82, note: "modern era" },
];

// An ad-hoc `npm install playwright` often pulls a version whose expected
// browser build differs from whatever is already on the machine, and it then
// refuses to launch. Prefer any Chromium we can find over downloading one.
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = globSync("/opt/pw-browsers/chromium-*/chrome-linux/chrome").sort();
  if (candidates.length) return candidates[candidates.length - 1];
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(p)) return p;
  }
  return undefined; // fall back to Playwright's own resolution
}

const executablePath = findChromium();
if (executablePath) console.log(`using chromium: ${executablePath}\n`);
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForSelector("body[data-ready='1']", { timeout: 15000 });

await mkdir(OUT, { recursive: true });

for (const shot of SHOTS) {
  // Reset, then apply this shot's zoom from a known state.
  await page.click("#reset");
  if (shot.steps) {
    await page.evaluate(
      ({ steps, x }) => {
        const c = document.getElementById("tl");
        const rect = c.getBoundingClientRect();
        for (let i = 0; i < steps; i++) {
          c.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: -120,
              clientX: rect.left + rect.width * x,
              clientY: rect.top + rect.height / 2,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      },
      { steps: shot.steps, x: shot.x },
    );
  }
  const readout = await page.textContent("#readout");
  await page.screenshot({ path: `${OUT}/${shot.name}.png` });
  console.log(`${shot.name.padEnd(12)} ${String(readout).padEnd(28)} ${shot.note}`);
}

// Hover an item to prove hit-testing and the detail card work.
await page.click("#reset");
const hovered = await page.evaluate(() => {
  const c = document.getElementById("tl");
  const rect = c.getBoundingClientRect();
  // Reach into the instance the page exposes for testing.
  const tl = window.__timeline;
  if (!tl || !tl.placed?.length) return null;
  const p = tl.placed.find((q) => q.item.label.length > 3) ?? tl.placed[0];
  const y = 56 + p.lane * 22 + 11;
  c.dispatchEvent(
    new PointerEvent("pointermove", {
      clientX: rect.left + p.x0 + 2,
      clientY: rect.top + y,
      bubbles: true,
    }),
  );
  return p.item.label;
});
if (hovered) {
  await page.screenshot({ path: `${OUT}/05-hover.png` });
  console.log(`05-hover     hovered: ${hovered}`);
} else {
  console.log("05-hover     SKIPPED (no placed items exposed)");
}

await browser.close();

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  process.exit(1);
}
console.log("\nno console errors");
