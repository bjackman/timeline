#!/usr/bin/env node
// Headless render tests, against a stub DOM.
//
//   node tools/test-render.mjs
//
// test-scale.mjs covers the pure maths. This covers the part that maths cannot
// reach: that the renderer actually runs, and that its layout invariants hold
// over the real slice. Every bug this file guards against was a real one, and
// none of them would have failed a unit test:
//
//   - labels landing on their neighbours' labels, and on their bars
//   - rows reshuffling while panning
//   - a first paint that throws, which shows up as a blank page
//
// The stub is deliberately thin. It is not a browser and does not try to be —
// it records canvas calls and lets the layout code run. Anything needing real
// text metrics or real CSS belongs in a browser, not here.

import { readFile } from "node:fs/promises";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

// --- the stub -------------------------------------------------------------

const calls = new Map();
const ctx = new Proxy(
  {},
  {
    get(_, k) {
      // Approximates 12px system-ui closely enough for layout to be exercised.
      if (k === "measureText") return (s) => ({ width: String(s).length * 6.2 });
      if (k === "canvas") return { width: 1400, height: 800 };
      return () => calls.set(k, (calls.get(k) ?? 0) + 1);
    },
    set: () => true,
  },
);

const el = (tag = "div") => ({
  tagName: tag,
  style: {},
  dataset: {},
  classList: { add() {}, toggle() {}, remove() {} },
  children: [],
  appendChild(c) {
    this.children.push(c);
  },
  addEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 800 }),
  getContext: () => ctx,
  setPointerCapture() {},
  releasePointerCapture() {},
  querySelectorAll: () => [],
  querySelector: () => el(),
});

const canvas = el("canvas");
globalThis.document = {
  documentElement: el(),
  body: el(),
  _byId: new Map(),
  getElementById(id) {
    if (id === "tl") return canvas;
    if (!this._byId.has(id)) this._byId.set(id, el());
    return this._byId.get(id);
  },
  createElement: (t) => el(t),
  addEventListener() {},
};
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener() {},
  open() {},
  matchMedia: () => ({ addEventListener() {} }),
  getComputedStyle: () => ({ getPropertyValue: () => "#888888" }),
};
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.MutationObserver = class {
  observe() {}
};

const slice = JSON.parse(await readFile("data/slice.json", "utf8"));
window.__SLICE__ = slice;

await import("../web/timeline.js");
await new Promise((r) => setTimeout(r, 20));
const tl = window.__timeline;

// --- first paint ----------------------------------------------------------

check("main() completed", !!tl);
check("first paint drew something", (calls.get("fillRect") ?? 0) > 50);
check("first paint drew labels", (calls.get("fillText") ?? 0) > 10);
check("items were placed", tl.placed.length > 0, `${tl.placed.length} placed`);

// --- layout invariants over the real slice --------------------------------
// The two overlap bugs, asserted directly on what the renderer produced.

function overlaps(views) {
  let labelOnLabel = 0;
  let labelOnBand = 0;
  for (const { centre, span } of views) {
    tl.view.centre = centre;
    tl.view.span = span;
    tl.view.clamp();
    tl.render();
    for (const a of tl.placed) {
      if (a.labelX === null) continue;
      const a0 = a.labelX;
      const a1 = a.labelX + a.labelWidth;
      for (const b of tl.placed) {
        if (b === a || b.lane !== a.lane) continue;
        if (a0 < b.x1 && b.x0 < a1) labelOnBand++;
        if (b.labelX !== null && a0 < b.labelX + b.labelWidth && b.labelX < a1) labelOnLabel++;
      }
    }
  }
  return { labelOnLabel: labelOnLabel / 2, labelOnBand };
}

{
  const views = [];
  for (let z = 0; z < 30; z++) {
    const span = 13.8e9 * Math.pow(0.55, z);
    for (let c = 0; c <= 4; c++) {
      views.push({ span, centre: 2026 - span / 2 - (13.8e9 - span) * (c / 4) });
    }
  }
  const { labelOnLabel, labelOnBand } = overlaps(views);
  check(`no label overlaps another label (${views.length} viewports)`, labelOnLabel === 0,
    `${labelOnLabel} overlaps`);
  check(`no label overlaps a bar (${views.length} viewports)`, labelOnBand === 0,
    `${labelOnBand} overlaps`);
}

// --- panning must not reshuffle rows --------------------------------------

{
  tl.view.showRange(-4000, 2026);
  tl.render();
  const lanes = new Map(tl.placed.map((p) => [p.item.qid, p.lane]));
  let moved = 0;
  let entered = 0;
  let checked = 0;
  for (let i = 0; i < 60; i++) {
    tl.view.panPixels(i < 30 ? 40 : -40);
    tl.render();
    for (const p of tl.placed) {
      if (lanes.has(p.item.qid)) {
        checked++;
        if (lanes.get(p.item.qid) !== p.lane) moved++;
      } else entered++;
      lanes.set(p.item.qid, p.lane);
    }
  }
  check("panning never changes a row", moved === 0, `${moved} of ${checked} item-frames moved`);
  check("...with items genuinely entering view", entered > 0, `${entered} entered`);
}

// --- the hover card -------------------------------------------------------

{
  tl.view.showRange(-4000, 2026);
  tl.render();
  const target = tl.placed[0];
  let hovered = false;
  for (let y = 0; y < 400 && !hovered; y++) {
    tl.hover = null;
    tl.updateHover(target.x0 + 1, y);
    hovered = tl.hover?.item?.qid === target.item.qid;
  }
  check("hovering an item finds it", hovered);

  const card = document.getElementById("card");
  check("the card is shown", card.hidden === false);
  check("the card links to the hovered item", card.dataset.qid === target.item.qid);

  // The card must outlive the pointer leaving the item, or its links are
  // unreachable.
  tl.updateHover(2, 2);
  check("leaving the item does not hide the card immediately", tl.hover !== null);
  check("...it schedules the hide instead", !!tl.hideTimer);
  tl.keepCard();
  await new Promise((r) => setTimeout(r, 350));
  check("entering the card cancels the hide", tl.hover !== null);
  tl.scheduleHide();
  await new Promise((r) => setTimeout(r, 350));
  check("leaving the card hides it", tl.hover === null && card.hidden === true);
}

// --- navigation paths do not throw ----------------------------------------

{
  let threw = null;
  try {
    tl.view.zoomAt(700, 1e-6);
    tl.render();
    tl.view.panPixels(-300);
    tl.render();
    tl.view.showRange(-66e6, -65e6);
    tl.render();
    for (const strip of ["nav", "map", null]) {
      tl.select = { x0: 100, x1: 400, strip };
      tl.render();
    }
    tl.select = null;
    tl.render();
  } catch (e) {
    threw = e.message;
  }
  check("zoom, pan, range and selection all render", threw === null, threw ?? "");
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
