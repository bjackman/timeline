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
  itemYearRange,
  placeLabel,
  labelPlacements,
  chooseLabelPlacement,
  LABEL_GAP,
  LABEL_MARGIN,
  LinearView,
  FULL_SPAN_YEARS,
  linearTicks,
  formatTickYear,
  formatSpan,
  computeLanes,
  LANE_LIMIT,
} from "../web/scale.js";
import { readFile } from "node:fs/promises";

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

// --- item extents ---------------------------------------------------------
// Each end of a span carries its own precision. Getting this wrong does not
// look like a maths bug on screen, it looks like a mammoth that never went
// extinct, which is why it survived v0.

{
  // Mammuthus: starts 5 Ma at million-year precision, ends 1800 BCE at century
  // precision. The start's half-width is 500,000 years; applying it to the end
  // put the band's right edge at year 498,200, past the present, where the
  // axis clamps it.
  const mammuthus = {
    start: { year: -5_000_000 },
    startPrecision: 3,
    end: { year: -1800 },
    endPrecision: 7,
  };
  const { lo, hi } = itemYearRange(mammuthus);
  check("span start band uses the start precision", lo === -5_500_000, `got ${lo}`);
  check("span end band uses the end precision", hi === -1750, `got ${hi}`);
  check("an extinct genus does not reach the present", hi < NOW, `got ${hi}`);
}

{
  // A point: the band is symmetric about the value, and nothing else.
  const moon = { start: { year: 1969 }, startPrecision: 11, end: null };
  const { lo, hi } = itemYearRange(moon);
  close("point band is half a day back", lo, 1969 - 0.5 / 365, 1e-9);
  close("point band is half a day forward", hi, 1969 + 0.5 / 365, 1e-9);
}

{
  // A coarse point still gets a wide band — this is the "precision is not a
  // timestamp" rule, and it must not be lost while fixing the span case.
  const { lo, hi } = itemYearRange({
    start: { year: -13_787_000_000 },
    startPrecision: 3,
    end: null,
  });
  check("deep-time point keeps its million-year band", hi - lo === 1e6, `got ${hi - lo}`);
}

{
  // Missing end precision falls back to the start's rather than to a default.
  const { hi } = itemYearRange({
    start: { year: -400_000 },
    startPrecision: 4,
    end: { year: -300_000 },
  });
  check("end precision falls back to the start's", hi === -250_000, `got ${hi}`);
}

{
  // An unknown precision code must not produce NaN and drag the item to the
  // edge of the axis.
  const { lo, hi } = itemYearRange({ start: { year: 1500 }, startPrecision: 99, end: null });
  check("unknown precision code is finite", Number.isFinite(lo) && Number.isFinite(hi));
}

// --- label placement ------------------------------------------------------
// The third case is the one that matters: a band wider than the viewport has
// no on-screen end to hang a label from, and before pinning those items drew
// as anonymous full-width bars. Deep time is made of them.

{
  const { labelX, flip, pinned } = placeLabel(300, 400, 80, 1000);
  check("a label sits to the right of its band", labelX === 400 + LABEL_GAP);
  check("...and is neither flipped nor pinned", !flip && !pinned);
}

{
  // Band near the right edge: the label would be sliced, so it flips left.
  const { labelX, flip, pinned } = placeLabel(900, 950, 80, 1000);
  check("a label near the right edge flips", flip && !pinned);
  check("...to the left of the band", labelX === 900 - LABEL_GAP - 80);
}

{
  // The Jurassic case: both ends off-screen.
  const { labelX, pinned } = placeLabel(-5000, 6000, 80, 1000);
  check("a band wider than the viewport pins its label", pinned);
  check("...inside the canvas, not off the left edge", labelX >= LABEL_MARGIN, `got ${labelX}`);
  check("...and not past the right edge", labelX + 80 <= 1000 - LABEL_MARGIN, `got ${labelX}`);
}

{
  // Reaching in from the left only: still nothing to the left to flip into.
  const { labelX, pinned } = placeLabel(-5000, 990, 80, 1000);
  check("a band reaching in from off-screen left pins too", pinned);
  check("...and stays on canvas", labelX >= LABEL_MARGIN && labelX + 80 <= 1000);
}

{
  // A label wider than the whole viewport cannot be placed. The renderer skips
  // anything left of the margin, so returning that is the "no room" signal.
  const { labelX } = placeLabel(-500, 1500, 1200, 1000);
  check("an over-wide label is left unplaceable", labelX < LABEL_MARGIN, `got ${labelX}`);
}

// --- linear view ----------------------------------------------------------
// The main axis. Its whole reason to exist is that durations are proportional
// to pixels, so that is what gets asserted first.

{
  const v = new LinearView(1000);
  close("full view reaches the Big Bang, plus a margin", v.left, BIG_BANG - v.padYears, 1);
  close("...and the present, plus a margin", v.right, NOW + v.padYears, 1);
  close("the Big Bang sits one margin in from the left edge", v.x(BIG_BANG), v.padPixels, 0.5);
  close("the present sits one margin in from the right edge", v.x(NOW), 1000 - v.padPixels, 0.5);

  // To scale: twice the duration, twice the pixels. This is the property the
  // log axis could not offer and the reason for the switch.
  const px = (a, b) => v.x(b) - v.x(a);
  close(
    "equal durations are equal widths, anywhere on the axis",
    px(-1e9, -0.9e9),
    px(-5e9, -4.9e9),
    1e-6,
  );
  close("double the duration is double the width", px(-2e9, -1.8e9), px(-1e9, -0.9e9) * 2, 1e-6);
}

{
  // Zoom about the cursor: whatever is under it stays under it. Getting this
  // wrong is the classic "the map slides away while you zoom" bug.
  // Interior positions only: at the very edges the window is already against
  // its bounds, and the clamp is allowed to override the anchor rather than
  // let the view drift into the margin. That case is asserted separately.
  const v = new LinearView(1000);
  for (const x of [137, 500, 800]) {
    const before = v.yearAt(x);
    v.zoomAt(x, 0.5);
    const after = v.yearAt(x);
    // Relative tolerance: at 13.8 Ga a year is far below float resolution.
    check(
      `zoom holds the year under x=${x}`,
      Math.abs(after - before) < Math.max(1, Math.abs(before) * 1e-9),
      `${before} -> ${after}`,
    );
  }
}

{
  const v = new LinearView(1000);
  for (let i = 0; i < 200; i++) v.zoomAt(500, 0.5);
  check("zoom in is floored at a day", v.span >= MIN_SPAN_YEARS, `got ${v.span}`);
  check("...and does not collapse or go negative", v.span > 0 && Number.isFinite(v.span));
}

{
  const v = new LinearView(1000);
  v.zoomAt(500, 1e-9);
  for (let i = 0; i < 100; i++) v.zoomAt(500, 4);
  close("zoom out is capped at all of time plus margins", v.span, v.maxSpan(), 1);
  check("...which is a little more than time itself", v.span > FULL_SPAN_YEARS);
  close("...and re-centres on the full range", v.centre, (BIG_BANG + NOW) / 2, 1);
}

{
  // The complaint this margin exists for: zooming in on the newest events.
  // Without a margin the present is a wall at the last pixel, so anchoring
  // anywhere to its left slides it off screen and you have to pan back.
  const v = new LinearView(1000);
  const onThePresent = v.x(NOW);
  check("the present is not jammed against the edge", onThePresent < 1000 - 10);
  for (let i = 0; i < 40; i++) v.zoomAt(onThePresent, 0.7);
  check("zooming on the present keeps it on screen", v.x(NOW) <= 1000 && v.x(NOW) > 0,
    `x=${v.x(NOW)}`);
  close("...and holds it under the cursor", v.x(NOW), onThePresent, 1);
  check("...having actually zoomed in", v.span < 1e5, `span=${v.span}`);
}

{
  // The margin is bounded: it is breathing room, not an endless future.
  const v = new LinearView(1000);
  v.zoomAt(990, 1e-7);
  for (let i = 0; i < 50; i++) v.panPixels(-500);
  check("panning cannot wander past the margin", v.right <= NOW + v.padYears + 1e-3,
    `right=${v.right}, now+pad=${NOW + v.padYears}`);
  check("...and the present stays visible", v.x(NOW) <= 1000);
}

{
  // No ticks out in the margin: a "2050" label past the present reads as a bug.
  const v = new LinearView(1000);
  v.zoomAt(v.x(NOW), 1e-7);
  const beyond = linearTicks(v).filter((t) => t.year > NOW + 1e-6 || t.year < BIG_BANG);
  check("ticks never leave real time", beyond.length === 0, `${beyond.length} strays`);
}

{
  // Panning is a rigid window: it stops at the edges rather than squashing.
  // The pans are deliberately far larger than the whole axis, since the point
  // is what happens when you run into the end of time.
  const v = new LinearView(1000);
  v.zoomAt(500, 1e-6);
  const span = v.span;
  v.panPixels(1e9);
  close("panning left stops one margin past the Big Bang", v.left, BIG_BANG - v.padYears, 1e-3);
  v.panPixels(-1e9);
  close("panning right stops one margin past the present", v.right, NOW + v.padYears, 1e-3);
  close("...without changing the span", v.span, span, 1e-6);
}

{
  const v = new LinearView(1000);
  v.showRange(-66e6, -65e6);
  check("showRange frames the range", v.left < -66e6 && v.right > -65e6);
  check("...snugly", v.span < 1.2e6, `got ${v.span}`);
}

// --- linear ticks and labels ----------------------------------------------

{
  // Across every decade of zoom the axis must stay populated but not explode.
  const v = new LinearView(1000);
  let worstLow = Infinity;
  let worstHigh = 0;
  for (let i = 0; i < 120; i++) {
    const majors = linearTicks(v).filter((t) => t.major).length;
    worstLow = Math.min(worstLow, majors);
    worstHigh = Math.max(worstHigh, majors);
    v.zoomAt(500, 0.75);
  }
  check("every zoom level has ticks", worstLow >= 1, `min ${worstLow}`);
  check("no zoom level floods the axis", worstHigh <= 40, `max ${worstHigh}`);
}

{
  // The bug that made a linear axis look frozen: three significant figures put
  // every tick in a narrow deep-time window on the same label.
  const step = 2000;
  const a = formatTickYear(-6.9034412e9, step);
  const b = formatTickYear(-6.9034432e9, step);
  check("deep-time tick labels differ when the ticks do", a !== b, `${a} vs ${b}`);
}

check("tick labels use Ga in deep time", formatTickYear(-13e9, 1e9).endsWith("Ga"));
check("tick labels use Ma in the Phanerozoic", formatTickYear(-5e8, 1e8).endsWith("Ma"));
check("tick labels use BCE in recorded history", formatTickYear(-500, 100) === "500 BCE");
check("tick labels use plain years in the CE era", formatTickYear(1900, 100) === "1900");

check("span formats as Gy", formatSpan(13.8e9).endsWith("Gy"));
check("span formats as My", formatSpan(5e6).endsWith("My"));
check("span formats as ky", formatSpan(5e3).endsWith("ky"));
check("span formats as days below a month", formatSpan(1 / 365).endsWith("d"));

// --- label placement against neighbours -----------------------------------
// Lane packing assumes a label sits to the right, because it has to assume
// something to stay pan-invariant. A label that flips left at the canvas edge
// therefore lands where a neighbour already is, unless something checks.

{
  const p = labelPlacements(300, 400, 80, 1000);
  check("preferred placement is to the right", p[0].labelX === 400 + LABEL_GAP);
  check("a flip is offered as the fallback", p[1].flip === true);
  check("pinning is offered last", p[p.length - 1].pinned === true);
}

{
  // Nothing in the way: the first choice stands.
  const chosen = chooseLabelPlacement(labelPlacements(300, 400, 80, 1000), 80, []);
  check("an unobstructed label takes its first choice", chosen.labelX === 408);
}

{
  // The clash: a band near the right edge can only flip left, into a
  // neighbour. The neighbour was placed first, so this one must move on.
  const placements = labelPlacements(900, 950, 80, 1000);
  check("near the right edge, flipping is the only option", placements.length === 2);
  const neighbour = [[790, 890]];
  const chosen = chooseLabelPlacement(placements, 80, neighbour);
  check("a flip that would land on a neighbour is rejected", chosen?.flip !== true);
}

{
  // Everything taken: the label is dropped rather than drawn over something.
  const chosen = chooseLabelPlacement(labelPlacements(900, 950, 80, 1000), 80, [[0, 1000]]);
  check("a label with nowhere free is dropped", chosen === null);
}

{
  // Bands block labels exactly as labels do. The renderer feeds in every band
  // in the lane, including those of items it has not placed a label for yet:
  // a band cannot move, so a label must be the one to give way. Placing labels
  // as bands are discovered instead produced 162 labels sitting on a bar
  // across 405 test viewports.
  const bandToTheLeft = [[780, 895]];
  const chosen = chooseLabelPlacement(labelPlacements(900, 950, 80, 1000), 80, bandToTheLeft);
  check("a label blocked from flipping still finds a spot", chosen !== null);
  check("...which is not the flip onto the band", chosen?.flip !== true);
  check(
    "...and does not overlap it",
    chosen !== null && !(chosen.labelX < 895 && 780 < chosen.labelX + 80),
    `labelX=${chosen?.labelX}`,
  );
}

{
  // A pinned label sits inside its own band, so the band must not block it.
  const placements = labelPlacements(-500, 1500, 80, 1000);
  check("a viewport-spanning band offers only pinning", placements.length === 1);
  check("...and it is chosen when the lane is otherwise clear",
    chooseLabelPlacement(placements, 80, []) !== null);
}

// --- lane assignment ------------------------------------------------------
// The property under test is that a lane depends on the zoom and on nothing
// else. Panning must not be able to move an item to a different row, which is
// what happened when only the visible items were packed, every frame.

const laneItem = (qid, year, endYear = null, precision = 9) => ({
  qid,
  label: qid,
  start: { year },
  startPrecision: precision,
  end: endYear === null ? null : { year: endYear },
  endPrecision: endYear === null ? null : precision,
});

const width20 = () => 20; // every label 20px wide

{
  const items = [laneItem("A", 1000), laneItem("B", 1900)];
  const lanes = computeLanes(items, 1, width20);
  check("items far apart share a lane", lanes.get("A") === lanes.get("B"));
}

{
  const items = [laneItem("A", 1000, 1900), laneItem("B", 1500, 1800)];
  const lanes = computeLanes(items, 1, width20);
  check("overlapping items take different lanes", lanes.get("A") !== lanes.get("B"));
}

{
  // Notability order decides who gets the top lane; the first item in wins.
  const items = [laneItem("first", 1000, 1900), laneItem("second", 1500, 1800)];
  const lanes = computeLanes(items, 1, width20);
  check("the first item listed takes the top lane", lanes.get("first") === 0);
}

{
  // A label is fixed in pixels, so it covers more years as you zoom out — the
  // one and only reason lanes depend on the scale at all.
  const items = [laneItem("A", 1000), laneItem("B", 1050)];
  check("close items fit one lane when zoomed in", computeLanes(items, 1, width20).get("B") === 0);
  check("...and separate when zoomed out", computeLanes(items, 10, width20).get("B") === 1);
}

{
  // Beyond the limit, items are dropped rather than assigned a lane no window
  // could show. The density strip is what reports them.
  const items = Array.from({ length: LANE_LIMIT + 20 }, (_, i) => laneItem(`i${i}`, 1000, 1900));
  const lanes = computeLanes(items, 1, width20);
  check("lane count is capped", Math.max(...lanes.values()) === LANE_LIMIT - 1);
  check("...and the overflow is dropped", lanes.size === LANE_LIMIT);
}

{
  // The real slice, at several zooms: no two items sharing a lane may overlap.
  // A greedy packer that is subtly wrong still looks plausible on screen.
  const slice = JSON.parse(await readFile("data/slice.json", "utf8"));
  const items = [...slice.items].sort((a, b) => b.sitelinks - a.sitelinks);
  let worst = null;
  for (const yearsPerPixel of [1e7, 1e5, 1e3, 10, 0.1]) {
    const lanes = computeLanes(items, yearsPerPixel, () => 60);
    const byLane = new Map();
    for (const item of items) {
      const lane = lanes.get(item.qid);
      if (lane === undefined) continue;
      const { lo, hi } = itemYearRange(item);
      const label = (60 + LABEL_GAP) * yearsPerPixel;
      const list = byLane.get(lane) ?? [];
      for (const [a, b] of list) {
        if (lo < b && a < hi + label) worst = `${item.label} at ${yearsPerPixel} y/px`;
      }
      list.push([lo, hi + label]);
      byLane.set(lane, list);
    }
  }
  check("no two items in a lane overlap, at any zoom", worst === null, worst ?? "");
}

// --- report ---------------------------------------------------------------

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
