// The fleet speedo: a car-style dial drawn in Braille for the TUI.
//
// Braille because each cell is a 2×4 grid of dots, which is eight times the
// resolution of a character grid, and a terminal cell is about twice as tall as
// it is wide, so the dots come out close to square and a circle drawn in them
// comes out round. Every Braille character is one display column wide.
//
// The arc sweeps 240°: zero at the lower left, full scale at the lower right,
// half scale straight up. The needle pivots at the hub, and the reading sits
// under the hub with its unit below it, and below that, when there is a row
// for it, what the fleet spent over the last hour at API prices. The needle is never drawn over the
// readings: it stops at the text's edge and picks up past it.
//
// The arc is lit in one colour up to the reading and dim past it. No green,
// yellow and red zones: the scale follows the fleet's own recent peak, so the
// top of it is "busier than lately", not a limit, and a zone would change
// colour the moment the scale stepped up under the same reading.
//
// Pure: a reading and a size in, lines out. Colour comes from the painter the
// caller hands over, so the dial is drawn with the same SGR helpers as the rest
// of the frame.

import { formatRate } from './throughput.js';
import { formatSpend } from './pricing.js';

/** Rows the dial is drawn in at the least, and at the most. Six is the smallest
 *  that keeps an arc, a reading and its unit apart; past ten the dial only grows
 *  wider, and the top block has better uses for the columns. */
export const SPEEDO_MIN_H = 6;
export const SPEEDO_MAX_H = 10;

const DEG = Math.PI / 180;
const START = 210 * DEG;  // where zero sits, counter-clockwise from 3 o'clock
const SWEEP = 240 * DEG;  // clockwise from START to full scale
// Half the arc's stroke, in dots. A one-dot stroke leaves gaps where the circle
// crosses the dot grid at a shallow angle.
const HALF_STROKE = 0.75;
// Clear dots between the needle's tip and the inside of the arc.
const TIP_GAP = 3.5;

// Braille dot bits by [row][column] within a cell (Unicode's dots 1-8).
const DOT_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
const BRAILLE_BLANK = 0x2800;

const SGR = (/** @type {string} */ code) => (/** @type {string} */ s) => `\x1b[${code}m${s}\x1b[0m`;
/** @typedef {{ cyan: (s: string) => string, dim: (s: string) => string, bold: (s: string) => string }} Painter */
/** @type {Painter} */
const DEFAULT_PAINT = { cyan: SGR('36'), dim: SGR('2'), bold: SGR('1') };

/** @typedef {'blank'|'arc'|'arc-dim'|'needle'|'value'|'unit'|'spend'|'label'} CellKind */
/** @typedef {{ ch: string, kind: CellKind }} Cell */

/**
 * The radius, in dots, of the largest arc a dial `height` rows tall holds. The
 * arc reaches R above the hub and R·sin 30° below it, and the bottom row is kept
 * for the scale labels.
 * @param {number} height
 */
function radiusFor(height) {
  return Math.floor((4 * (height - 1) - 2.5) / 1.5);
}

/**
 * The columns a dial `height` rows tall is drawn in: the arc's width, a column
 * either side, rounded up to odd so the hub sits in the middle of a column and
 * the needle stands straight at half scale.
 * @param {number} height
 */
export function speedoWidth(height) {
  const w = radiusFor(height) + 2;
  return w % 2 ? w : w + 1;
}

/** The rows the reading and its unit sit on, under the hub of an arc of radius
 *  `R`, clamped so a short dial still keeps both.
 *  @param {number} height @param {number} R */
function readingRows(height, R) {
  const valueRow = Math.max(0, Math.min(Math.floor((R + 1.5) / 4) + 1, height - 2));
  return { valueRow, unitRow: valueRow + 1 };
}

/** Whether a dial `height` rows tall has a row for the spend under its unit.
 *  The smallest does not, so the caller shows the spend elsewhere.
 *  @param {number} height */
export function speedoShowsSpend(height) {
  return readingRows(height, radiusFor(height)).unitRow + 1 < height;
}

/** Where `angle` falls along the sweep, 0 at zero and 1 at full scale, or null
 *  outside it (the gap at the bottom).
 *  @param {number} angle radians, counter-clockwise from 3 o'clock */
function sweepFraction(angle) {
  let delta = (START - angle) % (2 * Math.PI);
  if (delta < 0) delta += 2 * Math.PI;
  const f = delta / SWEEP;
  return f <= 1 + 1e-9 ? Math.min(1, f) : null;
}

/** A scale end as it is labelled: `500`, `1k`, `20k`, `1M`. The scale is a
 *  1-2-5 step, so it divides evenly and `1.0k` would only be noise.
 *  @param {number} n */
export function formatScale(n) {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}


/**
 * The dial as a grid of cells, before any colour: what each cell shows and what
 * it belongs to. Exposed so the tests can find the needle without parsing SGR.
 *
 * `spend`, dollars over the last hour, goes on the row under the unit when the
 * dial has one, and takes precedence over the scale ends: they are left out if
 * it would crowd them.
 *
 * @param {{ rate: number, max: number, width: number, height: number, spend?: number|null }} opts
 * @returns {Cell[][]} `height` rows of `width` cells
 */
export function speedoCells({ rate, max, width, height, spend = null }) {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  /** @type {Cell[][]} */
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', kind: /** @type {CellKind} */ ('blank') })));
  if (!width || !height) return cells;

  const frac = max > 0 && rate > 0 ? Math.min(1, rate / max) : 0;
  const R = Math.min(radiusFor(height), width - 2);
  const Wp = width * 2;
  const Hp = height * 4;
  // Dot coordinates: x to the right, y down, a dot's centre at +0.5. With an
  // odd width, `width` dots across is the middle of the middle column.
  const cx = width;
  const cy = R + 1.5;

  // 0 nothing, 1 arc, 2 needle.
  const layer = new Uint8Array(Wp * Hp);
  if (R >= 3) {
    for (let py = 0; py < Hp; py++) {
      for (let px = 0; px < Wp; px++) {
        const dx = px + 0.5 - cx;
        const dy = py + 0.5 - cy;
        if (Math.abs(Math.hypot(dx, dy) - R) > HALF_STROKE) continue;
        if (sweepFraction(Math.atan2(-dy, dx)) !== null) layer[py * Wp + px] = 1;
      }
    }
    const angle = START - frac * SWEEP;
    // Snapped, because the hub sits on the line between the middle column's two
    // dots: cos(90°) comes out a hair either side of zero, and an upright
    // needle would zigzag between them.
    const snap = (/** @type {number} */ v) => (Math.abs(v) < 1e-9 ? 0 : v);
    const ux = snap(Math.cos(angle));
    const uy = snap(Math.sin(angle));
    const len = R - TIP_GAP;
    for (let t = 0; t <= len; t += 0.25) {
      const px = Math.floor(cx + t * ux);
      const py = Math.floor(cy - t * uy);
      if (px >= 0 && px < Wp && py >= 0 && py < Hp) layer[py * Wp + px] = 2;
    }
  }

  // The reading under the hub, its unit under that, the scale ends on the
  // bottom row beneath the arc's two ends. Rows are clamped so a short dial
  // still keeps the reading.
  const { valueRow, unitRow } = readingRows(height, R);
  const labelRow = height - 1;
  const centre = width / 2;
  const colFor = (/** @type {string} */ text) => Math.round(centre - text.length / 2);

  /** @type {{ row: number, col: number, text: string, kind: CellKind }[]} */
  const texts = [];
  const value = formatRate(rate);
  texts.push({ row: valueRow, col: colFor(value), text: value, kind: 'value' });
  if (unitRow < height) texts.push({ row: unitRow, col: colFor('tok/s'), text: 'tok/s', kind: 'unit' });
  if (typeof spend === 'number' && unitRow + 1 < height) {
    const text = formatSpend(spend);
    texts.push({ row: unitRow + 1, col: colFor(text), text, kind: 'spend' });
  }

  // Nothing but text in the box around the readings: the needle stops at its
  // edge, a column clear of the widest line.
  const boxFrom = Math.min(...texts.map(t => t.col)) - 1;
  const boxTo = Math.max(...texts.map(t => t.col + t.text.length)) + 1;
  const boxEnd = Math.max(...texts.map(t => t.row));
  const inBox = (/** @type {number} */ r, /** @type {number} */ c) => r >= valueRow && r <= boxEnd && c >= boxFrom && c < boxTo;

  // The scale ends, both or neither: a lone `0` says nothing. Each must sit in
  // the dial and clear of any text already on its row.
  if (R >= 3 && labelRow > valueRow) {
    const endX = R * Math.cos(30 * DEG);
    const place = (/** @type {string} */ text, /** @type {number} */ dotX) => {
      const col = Math.round(dotX / 2 - text.length / 2);
      return { row: labelRow, col: Math.max(0, Math.min(width - text.length, col)), text, kind: /** @type {CellKind} */ ('label') };
    };
    const ends = [place('0', cx - endX), place(formatScale(max), cx + endX)];
    const clear = (/** @type {{ row: number, col: number, text: string }} */ a) =>
      a.col >= 0 && a.col + a.text.length <= width
      && texts.every(t => t.row !== a.row || a.col + a.text.length + 1 <= t.col || t.col + t.text.length + 1 <= a.col);
    if (ends[0].col + ends[0].text.length + 1 <= ends[1].col && ends.every(clear)) texts.push(...ends);
  }

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (inBox(r, c)) continue;
      let bits = 0;
      let needle = false;
      let fsum = 0;
      let fn = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = c * 2 + dx;
          const py = r * 4 + dy;
          const v = layer[py * Wp + px];
          if (!v) continue;
          bits |= DOT_BITS[dy][dx];
          if (v === 2) needle = true;
          else {
            const f = sweepFraction(Math.atan2(-(py + 0.5 - cy), px + 0.5 - cx));
            if (f !== null) { fsum += f; fn++; }
          }
        }
      }
      if (!bits) continue;
      const ch = String.fromCodePoint(BRAILLE_BLANK + bits);
      if (needle) { cells[r][c] = { ch, kind: 'needle' }; continue; }
      const f = fn ? fsum / fn : 0;
      cells[r][c] = { ch, kind: frac > 0 && f <= frac ? 'arc' : 'arc-dim' };
    }
  }

  for (const t of texts) {
    if (t.row < 0 || t.row >= height) continue;
    for (let i = 0; i < t.text.length; i++) {
      const c = t.col + i;
      if (c >= 0 && c < width) cells[t.row][c] = { ch: t.text[i], kind: t.kind };
    }
  }
  return cells;
}

/**
 * The dial as `height` lines of exactly `width` display columns each.
 *
 * Colour runs are closed on every change of style, so no cell's colour can
 * bleed into the next, or past the dial into whatever follows it on the line.
 *
 * @param {{ rate: number, max: number, width: number, height: number, spend?: number|null, paint?: Painter }} opts
 * @returns {string[]}
 */
export function renderSpeedo({ rate, max, width, height, spend = null, paint = DEFAULT_PAINT }) {
  // Cyan is the dashboard's accent for what is live — the spinner, the active
  // count — and the lit arc is exactly that.
  /** @type {Record<CellKind, (s: string) => string>} */
  const style = {
    blank: (s) => s,
    arc: (s) => paint.cyan(s),
    'arc-dim': (s) => paint.dim(s),
    needle: (s) => paint.bold(s),
    value: (s) => paint.bold(s),
    unit: (s) => paint.dim(s),
    spend: (s) => paint.bold(s),
    label: (s) => paint.dim(s),
  };
  return speedoCells({ rate, max, width, height, spend }).map(row => {
    let out = '';
    let run = '';
    /** @type {Cell|null} */
    let head = null;
    const flush = () => { if (head) out += style[head.kind](run); run = ''; };
    for (const cell of row) {
      if (!head || cell.kind !== head.kind) { flush(); head = cell; }
      run += cell.ch;
    }
    flush();
    return out;
  });
}
