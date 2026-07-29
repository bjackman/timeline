#!/usr/bin/env node
// Headless tests for the time-scale logic. No test framework — this is a few
// dozen assertions on pure functions and does not need one.
//
//   node tools/test-scale.mjs
//
// The axis is the part of this project most likely to be subtly wrong in ways
// that look fine on screen, which is why it lives in a DOM-free module.

import {
  MIN_SPAN_YEARS,
  View,
  toU,
  fromU,
  U_MAX,
  NOW,
  BIG_BANG,
  parseWikidataTime,
  formatYear,
  niceStep,
  ticks,
  PRECISION_HALF_WIDTH_YEARS,
} from "../web/scale.js";

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function close(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= tol, `got ${actual}, want ~${expected}`);
}

// --- parsing --------------------------------------------------------------
// The deep-time cases are the whole reason this function exists instead of Date.

check(
  "parses an ordinary date",
  parseWikidataTime("1944-06-06T00:00:00Z")?.year === 1944,
);
check(
  "parses a BCE date",
  parseWikidataTime("-0500-01-01T00:00:00Z")?.year === -500,
);
check(
  "parses an 11-digit deep-time year",
  parseWikidataTime("-13787000000-01-01T00:00:00Z")?.year === -13787000000,
);
check("rejects junk", parseWikidataTime("not a date") === null);

// Guard the specific trap this module exists to avoid. If someone "simplifies"
// parseWikidataTime back to Date.parse, this fails.
check(
  "Date really cannot handle deep time (justifies the regex)",
  Number.isNaN(Date.parse("-13787000000-01-01T00:00:00Z")) ||
    new Date("-13787000000-01-01T00:00:00Z").getUTCFullYear() !== -13787000000,
);

// --- coordinate transform -------------------------------------------------

close("toU/fromU round-trip at 1944", fromU(toU(1944)), 1944, 1e-6);
close("toU/fromU round-trip at the Big Bang", fromU(toU(BIG_BANG)), BIG_BANG, 1e3);
close("toU/fromU round-trip at 1 CE", fromU(toU(1)), 1, 1e-6);
check("u is 0 at the present", Math.abs(toU(NOW)) < 1e-9);
check("u increases going back in time", toU(1000) > toU(1900));
check("Big Bang is the largest u", U_MAX > toU(-1e9));
close("U_MAX is about 10.14", U_MAX, 10.14, 0.05);

// Future dates must clamp rather than produce NaN.
check("future years clamp instead of going NaN", Number.isFinite(toU(NOW + 500)));

// --- viewport -------------------------------------------------------------

{
  const v = new View(1000);
  close("full view: Big Bang at left edge", v.x(BIG_BANG), 0, 0.5);
  close("full view: present at right edge", v.x(NOW), 1000, 0.5);
  // On a log axis 82 years ago lands ~81% across, not in a thin sliver at the
  // edge — that generous allocation to recent history is the point of the scale.
  check("full view: 1944 sits well into the right-hand side", v.x(1944) > 750, `x=${v.x(1944)}`);
  check("full view: 1944 is not jammed against the edge", v.x(1944) < 900, `x=${v.x(1944)}`);
}

// Zoom must keep the point under the cursor fixed — the property that makes
// zooming feel correct rather than sliding.
{
  const v = new View(1000);
  const anchorX = 640;
  const yearBefore = v.yearAt(anchorX);
  v.zoomAt(anchorX, 0.5);
  close("zoom in preserves the year under the cursor", v.yearAt(anchorX), yearBefore, Math.abs(yearBefore) * 1e-6 + 1);
  v.zoomAt(anchorX, 2.0);
  close("zoom out preserves it too", v.yearAt(anchorX), yearBefore, Math.abs(yearBefore) * 1e-6 + 1);
}

// Clamping: never past the Big Bang, never past the present.
{
  const v = new View(1000);
  for (let i = 0; i < 50; i++) v.zoomAt(500, 2.0);
  check("cannot zoom out past the Big Bang", v.uLeft <= U_MAX + 1e-9);
  check("cannot zoom out past the present", v.uRight >= -1e-9);
}

{
  const v = new View(1000);
  for (let i = 0; i < 200; i++) v.panPixels(500);
  check("panning stops at the present edge", v.uRight >= -1e-9);
  close("pan preserves the window width at the edge", v.uLeft - v.uRight, U_MAX, 1e-6);
}

{
  const v = new View(1000);
  v.zoomAt(500, 0.01);
  const span = v.uLeft - v.uRight;
  for (let i = 0; i < 200; i++) v.panPixels(-500);
  check("panning stops at the Big Bang edge", v.uLeft <= U_MAX + 1e-9);
  close("zoomed pan preserves window width", v.uLeft - v.uRight, span, 1e-6);
}

// Zooming in should terminate rather than collapse to a degenerate window.
{
  const v = new View(1000);
  for (let i = 0; i < 2000; i++) v.zoomAt(500, 0.5);
  check("deep zoom does not collapse the window", v.uLeft - v.uRight > 0);
  check("deep zoom keeps coordinates finite", Number.isFinite(v.yearAt(500)));
  check(
    "deep zoom bottoms out at the minimum span, not at a u-space epsilon",
    v.yearAt(1000) - v.yearAt(0) >= MIN_SPAN_YEARS * 0.99,
    `span=${v.yearAt(1000) - v.yearAt(0)}y, floor=${MIN_SPAN_YEARS}y`,
  );
}

// The same floor must hold near the present, where u-space is finest — this is
// the case that originally produced a viewport a fraction of a second wide.
{
  const v = new View(1000);
  for (let i = 0; i < 200; i++) v.zoomAt(1000, 0.5);
  check(
    "zooming at the present edge respects the minimum span",
    v.yearAt(1000) - v.yearAt(0) >= MIN_SPAN_YEARS * 0.99,
    `span=${v.yearAt(1000) - v.yearAt(0)}y`,
  );
  check("ticks still exist at maximum zoom", ticks(v).length > 0);
}

// --- precision ------------------------------------------------------------

check(
  "every precision code 0..14 has a half-width",
  Array.from({ length: 15 }, (_, i) => i).every(
    (p) => typeof PRECISION_HALF_WIDTH_YEARS[p] === "number",
  ),
);
check(
  "half-widths decrease monotonically as precision increases",
  Array.from({ length: 14 }, (_, i) => i).every(
    (p) => PRECISION_HALF_WIDTH_YEARS[p] > PRECISION_HALF_WIDTH_YEARS[p + 1],
  ),
);
check("million-year precision spans 1My", PRECISION_HALF_WIDTH_YEARS[3] === 5e5);
check("day precision is sub-year", PRECISION_HALF_WIDTH_YEARS[11] < 0.01);

// A precision-3 point must be visibly wide when zoomed to deep time — the
// whole point of drawing bands.
{
  const v = new View(1000);
  v.zoomAt(100, 0.05); // zoom into the deep-time end
  const half = PRECISION_HALF_WIDTH_YEARS[3];
  const width = Math.abs(v.x(-500e6 + half) - v.x(-500e6 - half));
  check("million-year precision is a visible band when zoomed in", width > 1, `width=${width}px`);
}

// --- formatting -----------------------------------------------------------

check("formats deep time in Ga", formatYear(-13.8e9).endsWith("Ga"));
check("formats mid-deep time in Ma", formatYear(-500e6).endsWith("Ma"));
check("formats prehistory in BCE", formatYear(-50000).includes("BCE"));
check("formats classical BCE", formatYear(-500) === "500 BCE");
check("formats CE years plainly", formatYear(1066) === "1066");
check("no negative-zero weirdness at the boundary", !formatYear(0).startsWith("-"));

// --- ticks ----------------------------------------------------------------

check("niceStep returns a positive step", niceStep(37) > 0);
check("niceStep snaps 37 to 50", niceStep(37) === 50);

{
  const v = new View(1000);
  const t = ticks(v);
  check("full view produces ticks", t.length > 0, `got ${t.length}`);
  check("full view ticks are all in range", t.every((k) => k.year >= BIG_BANG - 1 && k.year <= NOW + 1));
}

{
  // Zoomed right in, ticks should switch to linear year subdivision and stay
  // a sane count rather than exploding or vanishing.
  const v = new View(1000);
  for (let i = 0; i < 40; i++) v.zoomAt(999, 0.5);
  const t = ticks(v);
  check("zoomed view produces a sane number of ticks", t.length > 0 && t.length < 200, `got ${t.length}`);
}

// --- report ---------------------------------------------------------------

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
