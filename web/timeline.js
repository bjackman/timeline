// Canvas timeline over a logarithmic "years ago" axis.
//
// The whole difficulty of this project is that the data spans 13.8 billion
// years and also single days. A linear axis puts all of recorded history in
// well under one pixel. The coordinate transform that solves it lives in
// scale.js, which is kept DOM-free so it can be tested headlessly.
//
// Left is older, right is now.

import { View, formatYear, formatItemDate, ticks, itemYearRange } from "./scale.js";

const CATEGORIES = [
  "conflict",
  "disaster",
  "life",
  "geology",
  "politics",
  "science",
  "culture",
  "sport",
  "period",
  "other",
];

const LANE_HEIGHT = 22;
const MARKER_RADIUS = 3.5;
const TOP_MARGIN = 56;
const DENSITY_HEIGHT = 46;
const UI_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO_FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// Canvas colours come from the same CSS custom properties as the chrome, so a
// theme change cannot leave a dark chart sitting inside a light page. Cached
// because reading computed style per frame is needless work; invalidated
// whenever the theme actually changes.
let paletteCache = null;

function palette() {
  if (paletteCache) return paletteCache;
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  paletteCache = {
    axis: v("--c-axis"),
    label: v("--c-label"),
    gridMajor: v("--c-grid-major"),
    gridMinor: v("--c-grid-minor"),
    density: v("--c-density"),
    plate: v("--c-plate"),
    cardBg: v("--c-card-bg"),
    cardBorder: v("--c-card-border"),
    cardTitle: v("--c-card-title"),
    cardBody: v("--c-card-body"),
    hoverLabel: v("--c-hover-label"),
    cat: Object.fromEntries(CATEGORIES.map((c) => [c, v(`--cat-${c}`)])),
  };
  return paletteCache;
}

export function invalidatePalette() {
  paletteCache = null;
}

// Screen extent of an item, including its precision band and its label.
// Bands are computed in year space and then projected, so they warp correctly
// under the log axis rather than being a fixed pixel width.
//
// Labels normally sit to the right of the marker. Near the right edge that
// would run them off-canvas and they get sliced mid-word, so they flip to the
// left instead. The returned left/right are the full occupied span including
// the label, whichever side it ended up on — lane packing needs that, not just
// the marker bounds.
function extent(view, item, ctx) {
  const { lo, hi } = itemYearRange(item);
  const x0 = view.x(lo);
  const x1 = view.x(hi);
  const labelWidth = ctx.measureText(item.label).width;

  const flip = x1 + 8 + labelWidth > view.width - 4 && x0 - 8 - labelWidth > 0;
  const labelX = flip ? x0 - 8 - labelWidth : x1 + 8;
  return {
    x0,
    x1,
    flip,
    labelX,
    labelWidth,
    left: flip ? labelX : x0,
    right: flip ? x1 : labelX + labelWidth,
  };
}

// Greedy lane packing: first lane where this item does not collide. Items are
// fed in notability order, so the most-wanted events get the best slots.
function assignLanes(view, items, ctx, maxLanes) {
  const laneEnds = [];
  const placed = [];
  for (const item of items) {
    const e = extent(view, item, ctx);
    // Cull on the marker, not the label span. A span reaching in from off-screen
    // left is still visible, but a marker past the right edge is not — and
    // keeping those alive only produces labels sliced by the canvas edge.
    if (e.x1 < 0 || e.x0 > view.width) continue;
    let lane = laneEnds.findIndex((end) => e.left > end + 6);
    if (lane === -1) {
      if (laneEnds.length >= maxLanes) continue; // no room; density strip reports it
      lane = laneEnds.length;
      laneEnds.push(-Infinity);
    }
    laneEnds[lane] = e.right;
    placed.push({ item, lane, ...e });
  }
  return placed;
}

class Timeline {
  constructor(canvas, data) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    // Most-notable-first, so lane packing gives the best slots to the events
    // most people are looking for. Same ranking the tile pipeline will use.
    this.all = [...data.items].sort((a, b) => b.sitelinks - a.sitelinks);
    this.items = this.all;
    this.enabled = new Set(CATEGORIES);
    this.hover = null;
    this.dragging = false;
    this.resize();
    this.bindEvents();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, rect.width * dpr);
    this.canvas.height = Math.max(1, rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    if (!this.view) this.view = new View(rect.width);
    else this.view.width = rect.width;
  }

  applyFilter() {
    this.items = this.all.filter((i) => this.enabled.has(i.category));
  }

  bindEvents() {
    const c = this.canvas;

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        this.view.zoomAt(e.clientX - rect.left, Math.exp(e.deltaY * 0.0015));
        this.render();
      },
      { passive: false },
    );

    let lastX = 0;
    c.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.moved = false;
      lastX = e.clientX;
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener("pointermove", (e) => {
      const rect = c.getBoundingClientRect();
      if (this.dragging) {
        const dx = e.clientX - lastX;
        if (Math.abs(dx) > 2) this.moved = true;
        lastX = e.clientX;
        this.view.panPixels(dx);
        this.render();
        return;
      }
      this.updateHover(e.clientX - rect.left, e.clientY - rect.top);
    });

    c.addEventListener("pointerup", (e) => {
      this.dragging = false;
      c.releasePointerCapture(e.pointerId);
      // A drag should not also open an article.
      if (!this.moved && this.hover) {
        window.open(
          `https://en.wikipedia.org/wiki/${encodeURIComponent(this.hover.item.title)}`,
          "_blank",
          "noopener",
        );
      }
    });

    c.addEventListener("pointerleave", () => {
      this.hover = null;
      this.render();
    });

    window.addEventListener("resize", () => {
      this.resize();
      this.render();
    });
  }

  updateHover(x, y) {
    const prev = this.hover?.item?.qid;
    this.hover = null;
    for (const p of this.placed ?? []) {
      const yTop = TOP_MARGIN + p.lane * LANE_HEIGHT;
      if (y >= yTop && y <= yTop + LANE_HEIGHT - 4 && x >= p.left - 6 && x <= p.right) {
        this.hover = p;
        break;
      }
    }
    this.canvas.style.cursor = this.hover ? "pointer" : "grab";
    if (this.hover?.item?.qid !== prev) this.render();
  }

  render() {
    const { ctx } = this;
    const W = this.cssWidth;
    const H = this.cssHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.font = UI_FONT;
    ctx.textBaseline = "middle";

    this.drawAxis(H);

    const maxLanes = Math.floor((H - TOP_MARGIN - DENSITY_HEIGHT) / LANE_HEIGHT);
    this.placed = assignLanes(this.view, this.items, ctx, maxLanes);
    for (const p of this.placed) this.drawItem(p);

    this.drawDensity(H);
    this.drawHoverCard();
    this.updateReadout();
  }

  drawAxis(H) {
    const { ctx, view } = this;
    for (const t of ticks(view)) {
      const x = view.x(t.year);
      if (x < 0 || x > this.cssWidth) continue;
      ctx.strokeStyle = t.major ? palette().gridMajor : palette().gridMinor;
      ctx.beginPath();
      ctx.moveTo(x, t.major ? 30 : 38);
      ctx.lineTo(x, H - DENSITY_HEIGHT);
      ctx.stroke();
      if (t.major) {
        // Centred text gets sliced at the canvas edges, so nudge the outermost
        // labels inward and align them accordingly.
        ctx.font = MONO_FONT;
        const text = formatYear(t.year);
        const w = ctx.measureText(text).width;
        if (x - w / 2 < 2) ctx.textAlign = "left";
        else if (x + w / 2 > this.cssWidth - 2) ctx.textAlign = "right";
        else ctx.textAlign = "center";
        const tx = ctx.textAlign === "left" ? 2 : ctx.textAlign === "right" ? this.cssWidth - 2 : x;
        ctx.fillStyle = palette().axis;
        ctx.fillText(text, tx, 20);
        ctx.font = UI_FONT;
      }
    }
  }

  drawItem(p) {
    const { ctx } = this;
    const { item } = p;
    const y = TOP_MARGIN + p.lane * LANE_HEIGHT + LANE_HEIGHT / 2;
    const pal = palette();
    const colour = pal.cat[item.category] ?? pal.cat.other;
    const isHover = this.hover?.item?.qid === item.qid;
    const bandWidth = p.x1 - p.x0;

    if (item.end || bandWidth > 3) {
      // A span, or a point whose date uncertainty is wide enough to see. Either
      // way the on-screen extent is meaningful and must be drawn.
      ctx.save();
      ctx.globalAlpha = item.end ? 0.8 : 0.33;
      ctx.fillStyle = colour;
      ctx.fillRect(p.x0, y - 5, Math.max(bandWidth, 2), 10);
      ctx.restore();
      if (!item.end) {
        // Uncertain point: mark the nominal value inside its band.
        ctx.fillStyle = colour;
        ctx.fillRect(this.view.x(item.start.year) - 0.75, y - 6, 1.5, 12);
      }
    } else {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(p.x0, y, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // A label that does not fit on either side is omitted rather than drawn and
    // sliced by the canvas edge. The marker stays, and hovering still names it.
    if (p.labelX < 0 || p.labelX + p.labelWidth > this.cssWidth) return;

    ctx.textAlign = "left";
    if (isHover) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 4;
      ctx.fillStyle = pal.hoverLabel;
    } else {
      ctx.fillStyle = pal.label;
    }
    ctx.fillText(item.label, p.labelX, y);
    if (isHover) ctx.restore();
  }

  // The honesty strip. Lane packing silently drops whatever does not fit, so
  // show the true count per column underneath. Without this, a top-N cut looks
  // like complete coverage.
  drawDensity(H) {
    const { ctx, view } = this;
    const W = this.cssWidth;
    const yTop = H - DENSITY_HEIGHT;
    const BIN = 4;
    const bins = new Array(Math.ceil(W / BIN)).fill(0);
    for (const item of this.items) {
      const x = view.x(item.start.year);
      if (x < 0 || x >= W) continue;
      bins[Math.floor(x / BIN)]++;
    }
    const max = Math.max(1, ...bins);
    ctx.fillStyle = palette().density;
    for (let i = 0; i < bins.length; i++) {
      if (!bins[i]) continue;
      const h = (bins[i] / max) * (DENSITY_HEIGHT - 18);
      ctx.fillRect(i * BIN, yTop + (DENSITY_HEIGHT - 18) - h + 8, BIN - 1, h);
    }
    const shown = this.placed.length;
    const inView = bins.reduce((a, b) => a + b, 0);
    const caption =
      inView > shown
        ? `showing ${shown} of ${inView} in view — ${inView - shown} hidden (zoom in)`
        : `showing all ${shown} in view`;
    // Plate behind the caption: it sits over the histogram, and this is the one
    // piece of text that must stay readable — it is what stops a top-N cut from
    // looking like complete coverage.
    ctx.font = MONO_FONT;
    const cw = ctx.measureText(caption).width;
    ctx.fillStyle = palette().plate;
    ctx.fillRect(4, H - 20, cw + 10, 17);
    ctx.fillStyle = palette().axis;
    ctx.textAlign = "left";
    ctx.fillText(caption, 9, H - 11);
    ctx.font = UI_FONT;
  }

  drawHoverCard() {
    if (!this.hover) return;
    const { ctx } = this;
    const { item } = this.hover;
    const lines = [
      item.label,
      formatItemDate(item),
      `${item.category} · ${item.sitelinks} language versions`,
    ];
    const fonts = [UI_FONT, MONO_FONT, MONO_FONT];
    const w =
      Math.max(
        ...lines.map((l, i) => {
          ctx.font = fonts[i];
          return ctx.measureText(l).width;
        }),
      ) + 20;
    const h = lines.length * 17 + 14;
    const x = Math.max(8, Math.min(this.hover.x0 + 12, this.cssWidth - w - 8));
    const y = Math.min(
      TOP_MARGIN + this.hover.lane * LANE_HEIGHT + 18,
      this.cssHeight - h - DENSITY_HEIGHT,
    );

    const pc = palette();
    ctx.fillStyle = pc.cardBg;
    ctx.strokeStyle = pc.cardBorder;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "left";
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? pc.cardTitle : pc.cardBody;
      ctx.font = i === 0 ? '650 12px system-ui, -apple-system, sans-serif' : MONO_FONT;
      ctx.fillText(line, x + 10, y + 16 + i * 17);
    });
  }

  updateReadout() {
    const el = document.getElementById("readout");
    if (!el) return;
    el.textContent = `${formatYear(this.view.yearAt(0))} → ${formatYear(
      this.view.yearAt(this.cssWidth),
    )}`;
  }
}

async function main() {
  // The single-file build injects the slice on window; the dev server fetches it.
  const data = window.__SLICE__ ?? (await (await fetch("../data/slice.json")).json());

  const canvas = document.getElementById("tl");
  const tl = new Timeline(canvas, data);

  // Category filter chips — the mechanism DESIGN.md calls for to sidestep the
  // "what counts as an event" argument rather than settle it.
  const bar = document.getElementById("filters");
  const counts = {};
  for (const i of data.items) counts[i.category] = (counts[i.category] ?? 0) + 1;
  for (const cat of CATEGORIES) {
    if (!counts[cat]) continue;
    const colour = palette().cat[cat];
    const chip = document.createElement("button");
    chip.className = "chip on";
    chip.dataset.cat = cat;
    chip.innerHTML =
      `<span class="dot" style="background:${colour}"></span>${cat} ` +
      `<span class="n num">${counts[cat]}</span>`;
    chip.onclick = () => {
      if (tl.enabled.has(cat)) tl.enabled.delete(cat);
      else tl.enabled.add(cat);
      chip.classList.toggle("on");
      tl.applyFilter();
      tl.render();
    };
    bar.appendChild(chip);
  }

  document.getElementById("reset").onclick = () => {
    tl.view = new View(tl.cssWidth);
    tl.render();
  };

  const onThemeChange = () => {
    invalidatePalette();
    for (const chip of bar.querySelectorAll(".chip")) {
      const dot = chip.querySelector(".dot");
      if (dot) dot.style.background = palette().cat[chip.dataset.cat];
    }
    tl.render();
  };
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onThemeChange);
  // The viewer's theme toggle stamps data-theme on the root element rather than
  // firing an event, so watch the attribute directly.
  new MutationObserver(onThemeChange).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  tl.applyFilter();
  tl.render();
  // Signals to the screenshot harness that first paint is done.
  // Exposed for tools/screenshot.mjs to drive hover hit-testing. Harmless in
  // production and the alternative is synthesising pointer events blind.
  window.__timeline = tl;
  document.body.dataset.ready = "1";
}

main();
