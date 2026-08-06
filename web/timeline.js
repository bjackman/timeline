// Canvas timeline over a logarithmic "years ago" axis.
//
// The whole difficulty of this project is that the data spans 13.8 billion
// years and also single days. A linear axis puts all of recorded history in
// well under one pixel. The coordinate transform that solves it lives in
// scale.js, which is kept DOM-free so it can be tested headlessly.
//
// Left is older, right is now.

import {
  View,
  LinearView,
  BIG_BANG,
  NOW,
  formatYear,
  formatTickYear,
  formatSpan,
  formatItemDate,
  ticks,
  linearTicks,
  itemYearRange,
  placeLabel,
} from "./scale.js";

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

// The navigator: a logarithmic strip showing all of time at once, with the
// linear window marked on it. Log is genuinely good at "everything at once"
// and genuinely bad at "to scale", so it does the first job while the main
// axis does the second. Dragging across it changes scale exponentially, which
// is what makes it a navigation device and not just a mini-map.
const NAV_HEIGHT = 34;
const NAV_GAP = 8;
const NAV_MIN_WIDTH = 3;

// Wheel zoom. The base rate is what v0 used; holding a scroll gesture ramps it
// up to ACCEL_MAX, so a flick crosses orders of magnitude while a single notch
// still nudges. 5e12 is the full zoom range, so a fixed rate cannot serve both.
const WHEEL_RATE = 0.0015;
const WHEEL_ACCEL_MAX = 5;
const WHEEL_ACCEL_PER_EVENT = 0.5;
const WHEEL_ACCEL_WINDOW_MS = 180;
// Trackpad pinch arrives as ctrl+wheel with much smaller deltas.
const PINCH_RATE = 0.012;

// Vertical drag zoom, Google-Earth style: pixels of drag per e-fold.
const DRAG_ZOOM_PIXELS_PER_EFOLD = 90;
const DOUBLE_CLICK_ZOOM = 4;
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
// Label placement lives in scale.js; see placeLabel for the three cases. The
// returned left/right are the full occupied span including the label, wherever
// it ended up — lane packing needs that, not just the band bounds.
function extent(view, item, ctx) {
  const { lo, hi } = itemYearRange(item);
  const x0 = view.x(lo);
  const x1 = view.x(hi);
  const labelWidth = ctx.measureText(item.label).width;
  const { labelX, flip, pinned } = placeLabel(x0, x1, labelWidth, view.width);

  return {
    x0,
    x1,
    flip,
    pinned,
    labelX,
    labelWidth,
    left: Math.min(x0, labelX),
    right: Math.max(x1, labelX + labelWidth),
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
    if (!this.view) this.view = new LinearView(rect.width);
    else this.view.width = rect.width;
    // The navigator's own projection: log, fixed at the full extent, never
    // zoomed. It is a fixed frame of reference — that is the point of it.
    this.nav = new View(rect.width);
  }

  // Vertical layout, bottom-up: navigator, gap, density strip, then the lanes.
  get navTop() {
    return this.cssHeight - NAV_HEIGHT;
  }

  get densityTop() {
    return this.navTop - NAV_GAP - DENSITY_HEIGHT;
  }

  applyFilter() {
    this.items = this.all.filter((i) => this.enabled.has(i.category));
  }

  // Zoom rate that ramps while a scroll gesture continues. A fixed rate cannot
  // serve a 5e12 zoom range: slow enough to place a decade precisely is far too
  // slow to climb out to the Big Bang, and fast enough to climb is unusable up
  // close. Ramping lets one gesture do both — keep scrolling and it accelerates.
  wheelAccel(now) {
    if (now - (this.lastWheelAt ?? 0) > WHEEL_ACCEL_WINDOW_MS) this.wheelRun = 0;
    else this.wheelRun = (this.wheelRun ?? 0) + 1;
    this.lastWheelAt = now;
    return Math.min(WHEEL_ACCEL_MAX, 1 + this.wheelRun * WHEEL_ACCEL_PER_EVENT);
  }

  bindEvents() {
    const c = this.canvas;
    const at = (e) => {
      const rect = c.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const { x } = at(e);
        // Trackpad pinch arrives as ctrl+wheel with much smaller deltas, and
        // is already a deliberate zoom gesture, so it skips the ramp.
        const rate = e.ctrlKey ? PINCH_RATE : WHEEL_RATE * this.wheelAccel(e.timeStamp);
        this.view.zoomAt(x, Math.exp(e.deltaY * rate));
        this.render();
      },
      { passive: false },
    );

    // Right-drag is a zoom gesture, so the context menu has to go.
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    let last = { x: 0, y: 0 };
    let anchorX = 0;

    c.addEventListener("pointerdown", (e) => {
      const p = at(e);
      last = p;
      anchorX = p.x;
      this.moved = false;
      c.setPointerCapture(e.pointerId);

      if (p.y >= this.navTop) {
        // Navigator. Shift selects a range; otherwise grab and slide, jumping
        // straight to wherever you pressed.
        this.mode = e.shiftKey ? "nav-select" : "nav-drag";
        if (this.mode === "nav-select") this.select = { x0: p.x, x1: p.x, nav: true };
        else this.view.centre = this.nav.yearAt(p.x);
      } else if (e.shiftKey) {
        this.mode = "select";
        this.select = { x0: p.x, x1: p.x, nav: false };
      } else if (e.button === 2 || e.button === 1) {
        this.mode = "zoom-drag";
      } else {
        this.mode = "pan";
      }
      this.view.clamp();
      this.render();
    });

    c.addEventListener("pointermove", (e) => {
      const p = at(e);
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.moved = true;

      switch (this.mode) {
        case "pan":
          this.view.panPixels(dx);
          break;
        case "zoom-drag":
          // Up zooms in. Continuous and exponential, so one long drag crosses
          // as many orders of magnitude as you have screen for.
          this.view.zoomAt(anchorX, Math.exp(dy / DRAG_ZOOM_PIXELS_PER_EFOLD));
          break;
        case "nav-drag":
          this.view.centre = this.nav.yearAt(p.x);
          this.view.clamp();
          break;
        case "select":
        case "nav-select":
          this.select.x1 = p.x;
          break;
        default:
          last = p;
          this.updateHover(p.x, p.y);
          return;
      }
      last = p;
      this.render();
    });

    c.addEventListener("pointerup", (e) => {
      const p = at(e);
      c.releasePointerCapture(e.pointerId);

      if (this.select) {
        const { x0, x1, nav } = this.select;
        const proj = nav ? this.nav : this.view;
        // A stray shift-click is not a selection; ignore anything too narrow to
        // be meant, rather than zooming to a one-pixel sliver of time.
        if (Math.abs(x1 - x0) > 4) {
          const a = proj.yearAt(Math.min(x0, x1));
          const b = proj.yearAt(Math.max(x0, x1));
          this.view.showRange(a, b);
        }
        this.select = null;
      } else if (this.mode === "pan" && !this.moved && this.hover) {
        // A drag should not also open an article — and neither should a
        // double-click meant as zoom, which would otherwise fire this twice on
        // the way past and open two tabs. Hold the open long enough for a
        // second click to cancel it.
        const { title } = this.hover.item;
        this.pendingOpen = setTimeout(() => {
          this.pendingOpen = null;
          window.open(
            `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
            "_blank",
            "noopener",
          );
        }, 260);
      }
      this.mode = null;
      this.updateHover(p.x, p.y);
      this.render();
    });

    c.addEventListener("dblclick", (e) => {
      const { x, y } = at(e);
      clearTimeout(this.pendingOpen);
      this.pendingOpen = null;
      if (y >= this.navTop) return;
      const out = e.shiftKey || e.altKey;
      this.view.zoomAt(x, out ? DOUBLE_CLICK_ZOOM : 1 / DOUBLE_CLICK_ZOOM);
      this.render();
    });

    c.addEventListener("pointerleave", () => {
      this.hover = null;
      this.render();
    });

    window.addEventListener("keydown", (e) => {
      if (e.target !== document.body) return;
      const centre = this.cssWidth / 2;
      const step = this.cssWidth * 0.15;
      switch (e.key) {
        case "=":
        case "+":
          this.view.zoomAt(centre, 1 / 1.6);
          break;
        case "-":
        case "_":
          this.view.zoomAt(centre, 1.6);
          break;
        case "ArrowLeft":
          this.view.panPixels(step);
          break;
        case "ArrowRight":
          this.view.panPixels(-step);
          break;
        case "0":
          this.view = new LinearView(this.cssWidth);
          break;
        default:
          return;
      }
      e.preventDefault();
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

    const maxLanes = Math.floor((this.densityTop - TOP_MARGIN) / LANE_HEIGHT);
    this.placed = assignLanes(this.view, this.items, ctx, maxLanes);
    for (const p of this.placed) this.drawItem(p);

    this.drawDensity(H);
    this.drawNavigator();
    this.drawSelection();
    this.drawHoverCard();
    this.updateReadout();
  }

  // The window being dragged out, drawn while the pointer is down. Without it
  // a range selection is invisible until it has already happened.
  drawSelection() {
    if (!this.select) return;
    const { ctx } = this;
    const { x0, x1, nav } = this.select;
    const top = nav ? this.navTop : TOP_MARGIN - 8;
    const bottom = nav ? this.cssHeight : this.densityTop;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = palette().label;
    ctx.fillRect(Math.min(x0, x1), top, Math.abs(x1 - x0), bottom - top);
    ctx.restore();
  }

  // All of time, on a log axis, with the linear window marked. The window is
  // routinely a billionth of the total, so it is drawn with a floor width and
  // a hairline at its centre — otherwise there is nothing to see or grab.
  drawNavigator() {
    const { ctx, nav } = this;
    const pal = palette();
    const top = this.navTop;
    const W = this.cssWidth;

    ctx.save();
    ctx.fillStyle = pal.plate;
    ctx.fillRect(0, top, W, NAV_HEIGHT);

    ctx.strokeStyle = pal.gridMinor;
    ctx.fillStyle = pal.axis;
    ctx.font = MONO_FONT;
    ctx.textAlign = "center";
    for (const t of ticks(nav)) {
      if (!t.major) continue;
      const x = nav.x(t.year);
      if (x < 0 || x > W) continue;
      ctx.beginPath();
      ctx.moveTo(x, top + NAV_HEIGHT - 11);
      ctx.lineTo(x, top + NAV_HEIGHT);
      ctx.stroke();
      ctx.fillText(formatYear(t.year), x, top + NAV_HEIGHT - 20);
    }

    // Every item as a one-pixel mark, so the strip shows where the data is.
    ctx.globalAlpha = 0.5;
    for (const item of this.items) {
      const { lo, hi } = itemYearRange(item);
      const x = nav.x(lo);
      const w = Math.max(1, nav.x(hi) - x);
      ctx.fillStyle = pal.cat[item.category] ?? pal.cat.other;
      ctx.fillRect(x, top + 3, w, 4);
    }
    ctx.globalAlpha = 1;

    const xa = nav.x(Math.max(this.view.left, BIG_BANG));
    const xb = nav.x(Math.min(this.view.right, NOW));
    const x0 = Math.min(xa, xb);
    const w = Math.max(NAV_MIN_WIDTH, Math.abs(xb - xa));
    ctx.fillStyle = pal.label;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x0, top, w, NAV_HEIGHT);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.label;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, top + 0.5, Math.max(1, w - 1), NAV_HEIGHT - 1);
    ctx.restore();
  }

  drawAxis(H) {
    const { ctx, view } = this;
    for (const t of linearTicks(view)) {
      const x = view.x(t.year);
      if (x < 0 || x > this.cssWidth) continue;
      ctx.strokeStyle = t.major ? palette().gridMajor : palette().gridMinor;
      ctx.beginPath();
      ctx.moveTo(x, t.major ? 30 : 38);
      ctx.lineTo(x, this.densityTop);
      ctx.stroke();
      if (t.major) {
        // Centred text gets sliced at the canvas edges, so nudge the outermost
        // labels inward and align them accordingly.
        ctx.font = MONO_FONT;
        const text = formatTickYear(t.year, t.step);
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

    // A pinned label sits on top of the band's own fill rather than on empty
    // canvas, so it needs a backing plate to stay readable. The plate token is
    // the translucent page colour, which is why this works in both themes.
    if (p.pinned) {
      ctx.fillStyle = pal.plate;
      ctx.fillRect(p.labelX - 4, y - 8, p.labelWidth + 8, 16);
    }

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
    const yTop = this.densityTop;
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
    const capY = yTop + DENSITY_HEIGHT - 9;
    ctx.fillStyle = palette().plate;
    ctx.fillRect(4, capY - 8, cw + 10, 17);
    ctx.fillStyle = palette().axis;
    ctx.textAlign = "left";
    ctx.fillText(caption, 9, capY);
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
    // The scale numbers are the reason for a linear axis: "1 px = 9.86 My" is
    // what makes "to scale" legible rather than merely true.
    const { span } = this.view;
    el.textContent =
      `${formatYear(this.view.yearAt(0))} → ${formatYear(this.view.yearAt(this.cssWidth))}` +
      `  ·  span ${formatSpan(span)}  ·  ${formatSpan(span / this.cssWidth)}/px`;
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
    tl.view = new LinearView(tl.cssWidth);
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
