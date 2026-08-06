// Pure time-scale logic. No DOM, no canvas — so it can be tested headlessly
// (see tools/test-scale.mjs). This is where the project's hardest constraint
// lives, so it is worth being able to assert on it.

export const NOW = 2026;
export const BIG_BANG = -13_800_000_000;

// Wikidata time precision codes.
export const PRECISION_NAMES = {
  0: "billion years",
  1: "hundred million years",
  2: "ten million years",
  3: "million years",
  4: "hundred thousand years",
  5: "ten thousand years",
  6: "millennium",
  7: "century",
  8: "decade",
  9: "year",
  10: "month",
  11: "day",
  12: "hour",
  13: "minute",
  14: "second",
};

// Half-width, in years, of the uncertainty each precision code implies. This is
// "precision is not a timestamp" made concrete: a precision-3 value is known to
// the million years and must be drawn as a band 1My wide, not as a line.
export const PRECISION_HALF_WIDTH_YEARS = {
  0: 5e8,
  1: 5e7,
  2: 5e6,
  3: 5e5,
  4: 5e4,
  5: 5e3,
  6: 500,
  7: 50,
  8: 5,
  9: 0.5,
  10: 0.5 / 12,
  11: 0.5 / 365,
  12: 0.5 / 8760,
  13: 0.5 / 525600,
  14: 0.5 / 31536000,
};

// The full extent of an item in years: its nominal value plus the uncertainty
// band at each end.
//
// The two ends carry their own precision and each must use its own. Mammuthus
// is the case that proves it: the genus starts at 5 Ma (precision 3, a band a
// million years wide) and ends in 1800 BCE (precision 7, a band one century
// wide). Applying the start's half-width to the end put the end of its band at
// year 498,200 — which the axis clamps to the present, so the mammoth rendered
// as though it were still with us. 60 of the 274 spans in the v0 slice were
// wrong this way and four of them ran to the present day.
//
// A missing endPrecision falls back to the start's rather than to a default,
// since the two ends of one statement usually share a precision. The fetcher
// always writes both, so this only matters for malformed input.
export function itemYearRange(item) {
  const startHalf = PRECISION_HALF_WIDTH_YEARS[item.startPrecision] ?? 0.5;
  const startYear = item.start.year;
  if (!item.end) return { lo: startYear - startHalf, hi: startYear + startHalf };

  const endHalf = PRECISION_HALF_WIDTH_YEARS[item.endPrecision ?? item.startPrecision] ?? 0.5;
  return {
    lo: Math.min(startYear - startHalf, item.end.year - endHalf),
    hi: Math.max(item.end.year + endHalf, startYear + startHalf),
  };
}

// Gap between a band and its label, and the margin kept clear at the canvas
// edges. Exported so the tests state the rule in the same units the renderer
// uses rather than reimplementing it.
export const LABEL_GAP = 8;
export const LABEL_MARGIN = 4;

// Where an item's label goes, given its band on screen and the viewport width.
//
// Three cases, in order of preference:
//
//   1. To the right of the band — the default.
//   2. Flipped to its left, when the right would run off the canvas and get
//      sliced mid-word.
//   3. Pinned inside the visible part of the band.
//
// The third case exists because a band wider than the viewport has *both* ends
// off-screen, so there is no edge left to hang a label from. Deep time is made
// of exactly those: the Jurassic at full zoom is a bar running off both sides,
// and without pinning it draws as an anonymous stripe. Pinning to the viewport
// edge is what map labels do with long roads, for the same reason.
//
// Returns pinned so the renderer can back the text with a plate — a pinned
// label sits on top of the band's own fill rather than on empty canvas.
export function placeLabel(x0, x1, labelWidth, width) {
  const right = x1 + LABEL_GAP;
  if (right + labelWidth <= width - LABEL_MARGIN) {
    return { labelX: right, flip: false, pinned: false };
  }
  const left = x0 - LABEL_GAP - labelWidth;
  if (left >= LABEL_MARGIN) {
    return { labelX: left, flip: true, pinned: false };
  }
  // Clamped both ways: never left of the margin, never past the right edge.
  // A label wider than the whole viewport ends up with labelX < LABEL_MARGIN,
  // which the renderer treats as "no room" and skips.
  const inside = Math.max(x0, 0) + LABEL_GAP;
  const furthest = width - LABEL_MARGIN - labelWidth;
  return {
    labelX: Math.min(Math.max(inside, LABEL_MARGIN), furthest),
    flip: false,
    pinned: true,
  };
}

export const yearsAgo = (year) => NOW - year;

// The internal coordinate. +1 keeps log10 finite at the present; the clamp
// stops future dates producing NaN rather than silently corrupting the view.
export const toU = (year) => Math.log10(Math.max(1, yearsAgo(year) + 1));
export const fromU = (u) => NOW - (Math.pow(10, u) - 1);

export const U_MAX = toU(BIG_BANG);

// Finest useful viewport, in years. Day precision (code 11) is the finest the
// data reaches in practice, so there is nothing to see below this.
export const MIN_SPAN_YEARS = 1 / 365;

// Parse a Wikidata time literal.
//
// Deliberately NOT using Date: deep-time years have 11 digits
// (-13787000000-01-01T00:00:00Z) and Date.parse does not throw on those, it
// returns garbage. Regex, and keep the year as a plain number.
const TIME_RE = /^([+-]?\d+)-(\d{2})-(\d{2})T/;

export function parseWikidataTime(literal) {
  const m = TIME_RE.exec(literal);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// Significant-figure formatting that never falls back to scientific notation —
// `toPrecision` renders 1000 Ma as "1.00e+3 Ma", which is unreadable on an axis.
function sig3(v) {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function formatYear(year) {
  const ago = yearsAgo(year);
  // Thresholds are nudged below the round number on purpose. Tick positions are
  // built from a log transform that carries a -1 offset, so a tick meant for
  // "1 Ga ago" can arrive as 999,999,999 and would otherwise be rendered in the
  // units one step down.
  if (ago >= 1e9 - 1) return `${sig3(ago / 1e9)} Ga`;
  if (ago >= 1e6 - 1) return `${sig3(ago / 1e6)} Ma`;
  if (year < -10000) return `${Math.round(-year).toLocaleString("en-US")} BCE`;
  if (year < 0) return `${Math.round(-year)} BCE`;
  return String(Math.round(year));
}

export function formatItemDate(item) {
  const p = item.startPrecision;
  const startStr =
    p >= 10
      ? `${item.start.year}-${String(item.start.month).padStart(2, "0")}` +
        (p >= 11 ? `-${String(item.start.day).padStart(2, "0")}` : "")
      : formatYear(item.start.year);
  if (!item.end) return `${startStr} (${item.startPrecisionName})`;
  return `${startStr} – ${formatYear(item.end.year)}`;
}

// The viewport: a window over u. uLeft is the older edge (larger u), uRight the
// more recent (smaller u). Left is older, right is now.
export class View {
  constructor(width) {
    this.width = width;
    this.uLeft = U_MAX;
    this.uRight = 0;
  }

  x(year) {
    const u = toU(year);
    return ((this.uLeft - u) / (this.uLeft - this.uRight)) * this.width;
  }

  yearAt(x) {
    return fromU(this.uLeft - (x / this.width) * (this.uLeft - this.uRight));
  }

  // Zoom about a fixed screen position, so whatever is under the cursor stays
  // under the cursor.
  zoomAt(x, factor) {
    const uAnchor = this.uLeft - (x / this.width) * (this.uLeft - this.uRight);
    let left = uAnchor + (this.uLeft - uAnchor) * factor;
    let right = uAnchor + (this.uRight - uAnchor) * factor;
    if (left > U_MAX) left = U_MAX;
    if (right < 0) right = 0;
    // Floor the zoom by a real duration, not by a u-space epsilon. Near the
    // present, u-space is so fine that a small epsilon still permits a viewport
    // a fraction of a second wide, which makes tick generation degenerate and
    // means nothing to a user. One day is the finest the data itself goes.
    if (fromU(right) - fromU(left) < MIN_SPAN_YEARS) return;
    this.uLeft = left;
    this.uRight = right;
  }

  panPixels(dx) {
    const span = this.uLeft - this.uRight;
    const du = (dx / this.width) * span;
    let left = this.uLeft + du;
    let right = this.uRight + du;
    // Pan as a rigid window: hitting an edge stops it rather than squashing it.
    if (left > U_MAX) {
      right -= left - U_MAX;
      left = U_MAX;
    }
    if (right < 0) {
      left -= right;
      right = 0;
    }
    this.uLeft = left;
    this.uRight = right;
  }
}

// Axis ticks, chosen in log space so density stays roughly constant however far
// you zoom. Below ~1.2 decades of span the view is effectively linear, so
// subdivide in year space instead.
export function ticks(view) {
  const out = [];
  if (view.uLeft - view.uRight > 1.2) {
    for (let k = Math.floor(view.uRight); k <= Math.ceil(view.uLeft); k++) {
      for (const m of [1, 2, 5]) {
        const uu = k + Math.log10(m);
        if (uu < view.uRight || uu > view.uLeft) continue;
        // Derive the year from an exact round duration rather than from
        // fromU(uu). fromU carries a -1 offset, which lands a tick intended for
        // "1 Ma ago" on 999,999 and makes the label render in the wrong units.
        const ago = m * Math.pow(10, k);
        out.push({ year: NOW - ago, major: m === 1 });
      }
    }
  } else {
    const yearLeft = fromU(view.uLeft);
    const yearRight = fromU(view.uRight);
    const step = niceStep((yearRight - yearLeft) / 8);
    if (step > 0 && Number.isFinite(step)) {
      for (let y = Math.ceil(yearLeft / step) * step; y <= yearRight; y += step) {
        out.push({ year: y, major: true });
      }
    }
    // Rounding to a nice step can land every candidate outside the window when
    // the span is very small. An axis with no ticks at all is worse than one
    // labelled only at its edges.
    if (out.length === 0) {
      out.push({ year: yearLeft, major: true }, { year: yearRight, major: true });
    }
  }
  return out;
}

export function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}
