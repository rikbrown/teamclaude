import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSpeedo, speedoCells, speedoWidth, speedoCostRows, formatScale, SPEEDO_MIN_H, SPEEDO_MAX_H } from '../src/speedo.js';
import { displayWidth } from '../src/tui.js';

// The dial is set beside the dashboard's top block, and that merge trusts it to
// be exactly as wide as it says: a line one column long pushes nothing (the
// dial is last on its line) but is cut by fitLine on a terminal that is only
// just wide enough, and a short one lets the previous frame show through.

const strip = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const SIZES = [];
for (let h = SPEEDO_MIN_H; h <= SPEEDO_MAX_H; h++) SIZES.push([speedoWidth(h), h]);

test('every line is exactly the width asked for, and there are exactly `height` of them', () => {
  const odd = [[40, 10], [30, 6], [11, 6], [5, 3], [1, 1], [3, 12], [0, 4], [9, 0]];
  for (const [width, height] of [...SIZES, ...odd]) {
    for (const [rate, max] of [[0, 100], [55, 100], [1_400, 2_000], [9e9, 100]]) {
      for (const cost of [null, 0, 0.004, 12.34, 9e9]) {
        const lines = renderSpeedo({ rate, max, width, height, cost });
        assert.equal(lines.length, height, `${width}x${height}: ${lines.length} lines`);
        for (const l of lines) assert.equal(displayWidth(l), width, `${width}x${height} @${rate} $${cost}: |${strip(l)}|`);
      }
    }
  }
});

test('the dial is round: its width follows its height, and is odd so the hub has a column', () => {
  for (const [w, h] of SIZES) {
    assert.equal(w % 2, 1, `height ${h}`);
    // Braille dots are about square, so a round dial is about 2.4 columns per row.
    assert.ok(w >= 2 * h && w <= 3 * h, `height ${h} draws ${w} wide`);
  }
});

test('the reading sits in the middle, bold, with a dim unit under it', () => {
  for (const [width, height] of SIZES) {
    for (const [rate, text] of [[0, '0'], [84, '84'], [950, '950'], [1_400, '1.4k']]) {
      const cells = speedoCells({ rate, max: 2_000, width, height });
      const row = cells.findIndex(r => r.some(c => c.kind === 'value'));
      assert.ok(row > 0, `${height}: no reading`);
      const cols = cells[row].map((c, i) => (c.kind === 'value' ? i : -1)).filter(i => i >= 0);
      assert.equal(cells[row].filter(c => c.kind === 'value').map(c => c.ch).join(''), text);
      const left = cols[0];
      const right = width - 1 - cols[cols.length - 1];
      assert.ok(Math.abs(left - right) <= 1, `${height} "${text}": ${left} left, ${right} right`);
      assert.equal(cells[row + 1].filter(c => c.kind === 'unit').map(c => c.ch).join(''), 'tok/s');
    }
  }
});

/** The needle's cells, as { row, col }. */
function needle(rate, max, width, height) {
  const out = [];
  speedoCells({ rate, max, width, height }).forEach((r, row) => r.forEach((c, col) => { if (c.kind === 'needle') out.push({ row, col }); }));
  assert.ok(out.length > 0, 'no needle drawn');
  return out;
}

test('the needle points lower left at zero, lower right at full scale, and straight up at half', () => {
  for (const [width, height] of SIZES) {
    const mid = (width - 1) / 2;
    // An upright needle runs from the hub's row to near the top.
    const hubRow = Math.max(...needle(500, 1_000, width, height).map(p => p.row));

    const zero = needle(0, 1_000, width, height);
    assert.ok(zero.every(p => p.col <= mid), `${height}: a zero needle strays right of the hub`);
    // Level with the hub or under it: on the smallest dial the whole tip fits
    // in the hub's own row, 30° down being less than a cell over that length.
    assert.ok(Math.min(...zero.map(p => p.row)) >= hubRow, `${height}: a zero needle rises above the hub`);
    assert.ok(Math.min(...zero.map(p => p.col)) < mid - 2, `${height}: a zero needle does not reach left`);

    const full = needle(1_000, 1_000, width, height);
    assert.ok(full.every(p => p.col >= mid), `${height}: a full needle strays left of the hub`);
    assert.ok(Math.min(...full.map(p => p.row)) >= hubRow, `${height}: a full needle rises above the hub`);
    assert.ok(Math.max(...full.map(p => p.col)) > mid + 2, `${height}: a full needle does not reach right`);

    const half = needle(500, 1_000, width, height);
    assert.ok(half.every(p => p.col === mid), `${height}: a half-scale needle leans`);
    assert.ok(Math.min(...half.map(p => p.row)) <= 1, `${height}: a half-scale needle falls short of the top`);
  }
});

test('a reading past full scale pins the needle rather than wrapping it round', () => {
  const [w, h] = SIZES[SIZES.length - 1];
  assert.deepEqual(needle(5_000, 1_000, w, h), needle(1_000, 1_000, w, h));
});

test('the needle never crosses the reading or its unit', () => {
  for (const [width, height] of SIZES) {
    for (let rate = 0; rate <= 1_000; rate += 50) {
      const cells = speedoCells({ rate, max: 1_000, width, height });
      const vRow = cells.findIndex(r => r.some(c => c.kind === 'value'));
      for (const row of [vRow, vRow + 1]) {
        const texts = cells[row].map((c, i) => (c.kind === 'value' || c.kind === 'unit' ? i : -1)).filter(i => i >= 0);
        const from = Math.min(...texts) - 1;
        const to = Math.max(...texts) + 1;
        for (let c = from; c <= to; c++) {
          assert.notEqual(cells[row][c]?.kind, 'needle', `${height} @${rate}: needle at row ${row} col ${c}`);
        }
      }
    }
  }
});

// One colour, lit up to the reading: the scale follows the fleet's recent peak,
// so a green-to-red zone would say nothing a reading of 900 on 1k and 1,001 on
// 2k did not contradict.
test('the arc is lit up to the reading and dim past it, in one colour', () => {
  const [w, h] = SIZES[SIZES.length - 1];
  const arcs = (rate) => speedoCells({ rate, max: 1_000, width: w, height: h }).flat().filter(c => c.kind === 'arc' || c.kind === 'arc-dim');
  assert.ok(arcs(1_000).every(c => c.kind === 'arc'), 'a full reading lights the whole arc');
  assert.ok(arcs(0).every(c => c.kind === 'arc-dim'), 'an idle dial is lit nowhere');
  const half = arcs(500);
  const lit = half.filter(c => c.kind === 'arc').length;
  assert.ok(lit > 0 && lit < half.length, 'half scale lights part of it');
  assert.ok(Math.abs(lit / half.length - 0.5) < 0.15, `half scale lit ${lit} of ${half.length}`);
  assert.ok(arcs(900).every(c => !('zone' in c)), 'no zones');
});

test('the scale ends are labelled when they fit, and never on the arc', () => {
  const [w, h] = SIZES[SIZES.length - 1];
  const cells = speedoCells({ rate: 300, max: 2_000, width: w, height: h });
  const bottom = cells[h - 1];
  assert.equal(strip(bottom.map(c => c.ch).join('')).trim().replace(/\s+/g, ' '), '0 2k');
  assert.ok(bottom.every(c => c.kind === 'blank' || c.kind === 'label'), 'the arc reached the label row');
  assert.equal(formatScale(100), '100');
  assert.equal(formatScale(5_000), '5k');
  assert.equal(formatScale(20_000), '20k');
  assert.equal(formatScale(1e6), '1M');
});

test('no colour runs on past its cell, or past the dial', () => {
  for (const [width, height] of SIZES) {
    for (const l of renderSpeedo({ rate: 700, max: 1_000, width, height })) {
      // Every SGR that sets a colour is closed by a reset before the line ends.
      const codes = [...l.matchAll(/\x1b\[([0-9;]*)m/g)].map(m => m[1]);
      if (codes.length) assert.equal(codes[codes.length - 1], '0', `unclosed colour: ${JSON.stringify(l)}`);
      let open = 0;
      for (const c of codes) open = c === '0' ? 0 : open + 1;
      assert.equal(open, 0);
    }
  }
});

test('the painter the caller hands over is the one used', () => {
  const tag = (name) => (s) => `<${name}>${s}</${name}>`;
  const paint = { cyan: tag('c'), dim: tag('d'), bold: tag('b') };
  const lines = renderSpeedo({ rate: 900, max: 1_000, width: speedoWidth(10), height: 10, paint });
  const all = lines.join('\n');
  assert.match(all, /<b>900<\/b>/, 'the reading is bold');
  assert.match(all, /<c>[\u2801-\u28ff]+<\/c>/, 'the lit arc is cyan');
  assert.match(all, /<d>[\u2801-\u28ff]+<\/d>/, 'the rest of the arc is dim');
  assert.match(all, /<d>tok\/s<\/d>/);
  assert.doesNotMatch(all, /\x1b/, 'a raw escape bypassed the painter');
});

test('the spend sits under the unit, $/s then $/h, centred, as far as the dial has rows', () => {
  const text = (row, kind) => row.filter(c => c.kind === kind).map(c => c.ch).join('');
  for (const [width, height] of SIZES) {
    const cells = speedoCells({ rate: 640, max: 1_000, width, height, cost: 0.27 });
    const unit = cells.findIndex(r => r.some(c => c.kind === 'unit'));
    const rows = cells.flatMap((r, i) => (r.some(c => c.kind === 'cost') ? [i] : []));
    assert.equal(rows.length, speedoCostRows(height), `height ${height}`);
    rows.forEach((row, i) => {
      assert.equal(row, unit + 1 + i, `${height}: the spend is not under the unit`);
      assert.equal(text(cells[row], 'cost'), ['$0.27/s', '$972/h'][i]);
      const cols = cells[row].map((c, j) => (c.kind === 'cost' ? j : -1)).filter(j => j >= 0);
      assert.ok(Math.abs(cols[0] - (width - 1 - cols[cols.length - 1])) <= 1, `${height}: off centre`);
      assert.ok(!cells[row].some(c => c.kind === 'needle'), `${height}: the needle crossed the spend`);
    });
  }
  // The smallest dial has room for neither, the largest for both.
  assert.equal(speedoCostRows(SPEEDO_MIN_H), 0);
  assert.equal(speedoCostRows(SPEEDO_MAX_H), 2);
  for (let h = SPEEDO_MIN_H + 1; h < SPEEDO_MAX_H; h++) assert.ok(speedoCostRows(h) >= 1, `height ${h}`);
});

test('the scale ends give way to a spend that would crowd them, and no spend means none drawn', () => {
  const h = SPEEDO_MIN_H + 1;
  const w = speedoWidth(h);
  const kinds = (cost) => new Set(speedoCells({ rate: 6_400, max: 20_000, width: w, height: h, cost }).flat().map(c => c.kind));
  assert.ok(kinds(0.27).has('label'), 'a short spend leaves room for the ends');
  assert.ok(!kinds(12.34).has('label'), 'a long one takes their row');
  assert.ok(kinds(12.34).has('cost'));
  assert.ok(!kinds(null).has('cost'));
});
