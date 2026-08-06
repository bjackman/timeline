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
// Every placement that fits on the canvas, best first. The renderer walks this
// list and takes the first that no neighbour has already claimed.
export function labelPlacements(x0, x1, labelWidth, width) {
  const out = [];
  const right = x1 + LABEL_GAP;
  if (right + labelWidth <= width - LABEL_MARGIN) {
    out.push({ labelX: right, flip: false, pinned: false });
  }
  const left = x0 - LABEL_GAP - labelWidth;
  if (left >= LABEL_MARGIN) {
    out.push({ labelX: left, flip: true, pinned: false });
  }
  const pinned = pinnedPlacement(x0, labelWidth, width);
  if (pinned.labelX >= LABEL_MARGIN) out.push(pinned);
  return out;
}

// Clamped both ways: never left of the margin, never past the right edge. A
// label wider than the whole viewport comes back with labelX < LABEL_MARGIN,
// which is the "no room anywhere" signal.
function pinnedPlacement(x0, labelWidth, width) {
  const inside = Math.max(x0, 0) + LABEL_GAP;
  const furthest = width - LABEL_MARGIN - labelWidth;
  return {
    labelX: Math.min(Math.max(inside, LABEL_MARGIN), furthest),
    flip: false,
    pinned: true,
  };
}

// The preferred placement, ignoring neighbours.
export function placeLabel(x0, x1, labelWidth, width) {
  return (
    labelPlacements(x0, x1, labelWidth, width)[0] ?? pinnedPlacement(x0, labelWidth, width)
  );
}

// Pick the first placement not already taken by something else in the same
// lane, or null when they are all taken.
//
// This is what stops a flipped label landing on its neighbour. Lane packing is
// deliberately pan-invariant, which means it has to assume a side — it assumes
// the right — so a label that flips left at the canvas edge lands in space
// that packing gave to the item beside it. Measured across 280 viewports of
// the v0 slice: 529 clashing pairs, every single one a flip landing on a
// right-placed neighbour.
//
// Callers feed items in notability order, so the more notable label keeps its
// spot and the less notable one moves or, failing that, is dropped. A dropped
// label is not a lost item: the band still draws and hovering still names it.
export function chooseLabelPlacement(placements, labelWidth, occupied) {
  for (const p of placements) {
    const a = p.labelX - LABEL_MARGIN;
    const b = p.labelX + labelWidth + LABEL_MARGIN;
    if (!occupied.some(([oa, ob]) => a < ob && oa < b)) return p;
  }
  return null;
}

// Lanes we bother to assign. Independent of window height on purpose: the
// viewport decides how many lanes it can *show*, but if it decided how many
// exist then resizing the window would reshuffle every item.
export const LANE_LIMIT = 64;

// Gap between neighbours in a lane, in pixels, converted to years by the
// caller. Packing happens in year space; see computeLanes.
export const LANE_GAP_PX = 6;

// First index whose interval starts at or after x.
function lowerBound(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fits(list, a, b) {
  const i = lowerBound(list, a);
  if (i < list.length && list[i][0] < b) return false;
  if (i > 0 && list[i - 1][1] > a) return false;
  return true;
}

// Assign every item a lane, in YEAR space, for the whole timeline at once.
//
// The bug this fixes: packing only the visible items, every frame, meant that
// panning changed the input set, so an item arriving at one edge could push
// everything else to a different row. The timeline shuffled while you scrubbed.
//
// Packing globally in year space makes the result independent of where the
// viewport is, so panning cannot change any item's row — by construction, not
// by luck. It still depends on the zoom, because a label's width is fixed in
// pixels and therefore covers more years the further you zoom out. That is why
// the only input from the view is yearsPerPixel.
//
// Items are fed in notability order, so the most-wanted events take the top
// lanes globally rather than merely locally. Anything past LANE_LIMIT is
// dropped; the density strip is what reports it.
//
// Packing assumes the label sits to the right. At draw time a label near the
// canvas edge may flip or pin, which can overlap a neighbour — a rare, purely
// horizontal cost, and much cheaper than reserving space on both sides of
// every item forever.
export function computeLanes(items, yearsPerPixel, labelWidthPx) {
  const lanes = new Map();
  const occupied = [];
  const gap = LANE_GAP_PX * yearsPerPixel;

  for (const item of items) {
    const { lo, hi } = itemYearRange(item);
    const a = lo - gap;
    const b = hi + (labelWidthPx(item) + LABEL_GAP) * yearsPerPixel + gap;

    let lane = occupied.findIndex((list) => fits(list, a, b));
    if (lane === -1) {
      if (occupied.length >= LANE_LIMIT) continue;
      lane = occupied.length;
      occupied.push([]);
    }
    occupied[lane].splice(lowerBound(occupied[lane], a), 0, [a, b]);
    lanes.set(item.qid, lane);
  }
  return lanes;
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
// Widest possible linear window: the whole of time.
export const FULL_SPAN_YEARS = NOW - BIG_BANG;

// A linear window over years — the main axis.
//
// State is (centre, span) rather than (left, right) so that x() subtracts
// years *within* the window before scaling. That keeps float64's resolution
// tied to the window rather than to the age of the universe: at 13.8 Ga the
// representable increment is about 70 seconds, which is a million times finer
// than the data's precision there, so no fixed-point arithmetic is needed.
//
// Deliberately the same interface as the log View, so the renderer does not
// know or care which projection it is drawing.
export class LinearView {
  constructor(width, centre = (BIG_BANG + NOW) / 2, span = FULL_SPAN_YEARS) {
    this.width = width;
    this.centre = centre;
    this.span = span;
  }

  get left() {
    return this.centre - this.span / 2;
  }

  get right() {
    return this.centre + this.span / 2;
  }

  x(year) {
    return ((year - this.centre) / this.span) * this.width + this.width / 2;
  }

  yearAt(x) {
    return this.centre + (x / this.width - 0.5) * this.span;
  }

  // Keep the window inside [BIG_BANG, NOW], sliding rather than squashing —
  // the same rigid-window rule the log view pans by.
  clamp() {
    if (this.span >= FULL_SPAN_YEARS) {
      this.span = FULL_SPAN_YEARS;
      this.centre = (BIG_BANG + NOW) / 2;
      return;
    }
    if (this.left < BIG_BANG) this.centre = BIG_BANG + this.span / 2;
    if (this.right > NOW) this.centre = NOW - this.span / 2;
  }

  // Zoom about a fixed screen position, so whatever is under the cursor stays
  // under the cursor. factor > 1 zooms out.
  zoomAt(x, factor) {
    const anchor = this.yearAt(x);
    const span = Math.min(
      FULL_SPAN_YEARS,
      Math.max(MIN_SPAN_YEARS, this.span * factor),
    );
    this.centre = anchor - (x / this.width - 0.5) * span;
    this.span = span;
    this.clamp();
  }

  panPixels(dx) {
    this.centre -= (dx / this.width) * this.span;
    this.clamp();
  }

  // Frame an explicit year range — what a drag-selection and the navigator
  // both ultimately do. Padding keeps the selection off the canvas edges.
  showRange(lo, hi, pad = 0.02) {
    const span = Math.max(MIN_SPAN_YEARS, (hi - lo) * (1 + pad * 2));
    this.centre = (lo + hi) / 2;
    this.span = Math.min(FULL_SPAN_YEARS, span);
    this.clamp();
  }
}

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

// Ticks for the linear axis: round year values, majors labelled, four minors
// between them. Round *absolute* years rather than round durations-ago, since
// on a linear axis a reader is looking for 1900 and 2000, not "126 years ago".
// Deep-time labels still come out in Ga/Ma because formatYear converts.
export function linearTicks(view) {
  const out = [];
  const step = niceStep(view.span / 8);
  if (!(step > 0) || !Number.isFinite(step)) return out;

  const minor = step / 5;
  const first = Math.ceil(view.left / minor) * minor;
  for (let y = first; y <= view.right; y += minor) {
    // Integer index rather than a modulo on the accumulated float, which drifts.
    const isMajor = Math.abs(Math.round(y / step) * step - y) < minor / 2;
    out.push({ year: y, major: isMajor, step });
  }
  // A window narrower than one nice step lands every candidate outside it. An
  // axis with no ticks at all is worse than one labelled only at its edges.
  if (out.length === 0) {
    out.push({ year: view.left, major: true }, { year: view.right, major: true });
  }
  return out;
}

// A tick label whose precision follows the tick STEP rather than the value's
// magnitude.
//
// formatYear gives three significant figures, which is right for a hover card
// and wrong for a linear axis: zoom to a 14,000-year window at 6.9 Ga and every
// tick rounds to "6.90 Ga", so the axis shows six identical labels and the view
// appears frozen. Deciding the decimals from the step guarantees adjacent ticks
// differ — "6.903441 Ga" and "6.903443 Ga" — which is the whole job of an axis.
export function formatTickYear(year, step) {
  const ago = NOW - year;
  const unit = ago >= 1e9 ? 1e9 : ago >= 1e6 ? 1e6 : 0;
  if (unit) {
    const decimals = Math.min(9, Math.max(0, Math.ceil(Math.log10(unit / step))));
    return `${(ago / unit).toFixed(decimals)} ${unit === 1e9 ? "Ga" : "Ma"}`;
  }
  // Sub-year steps: without decimals every tick in a six-month window reads as
  // the same year. Not a date yet — that is worth doing properly later.
  if (step < 1) {
    const decimals = Math.min(6, Math.ceil(Math.log10(1 / step)));
    return year < 0 ? `${(-year).toFixed(decimals)} BCE` : year.toFixed(decimals);
  }
  if (year < 0) return `${Math.round(-year).toLocaleString("en-US")} BCE`;
  return String(Math.round(year));
}

// A duration, for the scale readout. This is what makes "to scale" legible
// rather than merely true: the number that says one pixel is nine million
// years is the whole reason to use a linear axis.
export function formatSpan(years) {
  const y = Math.abs(years);
  if (y >= 1e9) return `${sig3(y / 1e9)} Gy`;
  if (y >= 1e6) return `${sig3(y / 1e6)} My`;
  if (y >= 1e3) return `${sig3(y / 1e3)} ky`;
  if (y >= 1) return `${sig3(y)} y`;
  // A twelfth of a year, not a 365th: below one month, days are the unit a
  // reader wants, and "0.0329 mo" is not a duration anyone recognises.
  if (y >= 1 / 12) return `${sig3(y * 12)} mo`;
  return `${sig3(y * 365)} d`;
}

export function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}
