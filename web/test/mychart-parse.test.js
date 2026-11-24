import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMyChartItems,
  parseRange,
  parseNumber,
  parseMyChartDate,
  matchAnalyte,
  mergeResults,
  unitMatches,
} from '../src/lib/mychart/parse.js';

// Synthetic fixtures that reproduce the *layout* of MyChart printouts (item
// positions as pdf.js reports them). Values and names are invented — real
// printouts are PHI and never belong in this repo.
const it = (x, y, str) => ({ x, y, str });
const banner = it(67, 14, 'Name: Test Patient | DOB: 01/01/1970 | MRN: 0000000');

/** One "Test Details" component box, as drawn in MyChart. */
function box(x, y, name, range, value, ticks, flag) {
  const items = [it(x, y, name), it(x, y + 14, `Normal range: ${range}`)];
  items.push(it(x + 140, y + 37, value));
  if (flag) items.push(it(x + 170, y + 37, flag));
  // Range-bar tick labels: drawn twice, below the value.
  for (const [tx, t] of ticks) items.push(it(tx, y + 81, t), it(tx, y + 81, t));
  return items;
}

function cbcDetails() {
  return [
    banner,
    it(28, 63, 'CBC W/ AUTO DIFFERENTIAL'),
    it(28, 77, 'Collected on Mar 3, 2026 9:05 AM'),
    // Two columns: x=34 and x=316.
    ...box(34, 137, 'WBC', '4.00 - 11.00 10*3/uL', '6.20', [
      [96, '4'],
      [224, '11'],
    ]),
    ...box(316, 137, 'RBC', '3.95 - 5.54 10*6/uL', '4.40', [
      [371, '3.95'],
      [502, '5.54'],
    ]),
    ...box(
      34,
      248,
      'HGB',
      '12.5 - 16.2 g/dL',
      '11.1',
      [
        [117, '12.5'],
        [229, '16.2'],
      ],
      'Low',
    ),
    ...box(
      316,
      248,
      'Platelet Count',
      '160 - 400 10*3/uL',
      '1,020',
      [
        [371, '160'],
        [502, '400'],
      ],
      'High',
    ),
    it(28, 690, 'Ordering provider:'),
    it(28, 771, 'MSKCC CLINICAL LABORATORY AT MONMOUTH'),
  ];
}

test('Test Details: reads each tracked component from a two-column panel', () => {
  const out = parseMyChartItems(cbcDetails());
  assert.equal(out.kind, 'details');
  assert.equal(out.title, 'CBC W/ AUTO DIFFERENTIAL');
  assert.equal(out.source, 'msk');

  const by = Object.fromEntries(out.results.map((r) => [r.analyte, r]));
  assert.deepEqual(Object.keys(by).sort(), ['hemoglobin', 'platelets', 'wbc']);
  assert.equal(by.wbc.value, 6.2);
  assert.equal(by.wbc.unit, 'K/µL'); // canonical unit, not the printed 10*3/uL
  assert.equal(by.hemoglobin.value, 11.1);
  assert.equal(by.hemoglobin.refLow, 12.5);
  assert.equal(by.hemoglobin.refHigh, 16.2);
  assert.equal(by.platelets.value, 1020); // thousands separator
  assert.equal(by.wbc.dateOnly, false);
  assert.deepEqual(by.wbc.collectedAt, new Date(2026, 2, 3, 9, 5));
  assert.ok(out.skipped.some((s) => s.startsWith('RBC')));
});

test('Test Details: one-sided ranges, footnotes, and page breaks', () => {
  const page = 792;
  const items = [
    banner,
    it(28, 63, 'COMPREHENSIVE METABOLIC PANEL PLASMA'),
    it(28, 77, 'Collected on Jan 9, 2026 1:30 PM'),
    ...box(34, 540, 'Aspartate Aminotransferase (AST)', '37 U/L or below', '20', [
      [226, '37'],
    ]),
    // ALT with a footnote at the column margin after its value.
    ...box(34, 640, 'Alanine Aminotransferase (ALT)', '55 U/L or below', '18', [
      [267, '55'],
    ]),
    it(34, 640 + 55, 'Recommended healthy ALT level'),
    // eGFR on the next page.
    ...box(34, page + 417, 'eGFR (Creatinine) 2021', '60 mL/min/1.73m2 or above', '95', [
      [244, '60'],
    ]),
    it(34, page + 506, 'The CKD-EPI (2021) is used to calculate the estimated GFR'),
  ];
  const out = parseMyChartItems(items);
  const by = Object.fromEntries(out.results.map((r) => [r.analyte, r]));
  assert.equal(by.ast.value, 20);
  assert.equal(by.ast.refLow, null);
  assert.equal(by.ast.refHigh, 37);
  assert.equal(by.alt.value, 18);
  assert.equal(by.egfr.value, 95);
  assert.equal(by.egfr.refLow, 60);
  assert.equal(by.egfr.refHigh, null);
});

test('Test Details: a "Value" box and a box with no value', () => {
  const items = [
    banner,
    it(28, 77, 'Collected on Jan 9, 2026 1:30 PM'),
    it(34, 471, 'Blasts Man'),
    it(34, 485, 'Normal range: 0.0 - 0.0 %'),
    it(50, 509, 'Value'),
    it(50, 523, '2.0'),
    it(61, 545, 'High'),
    it(34, 583, 'LDH'),
    it(34, 597, 'Normal range: 130 - 250 U/L'),
    it(50, 621, 'Value'),
    it(50, 635, 'No value'),
    it(34, 700, 'Uric Acid, Plasma'),
    it(34, 714, 'Normal range: 3.8 - 8.5 mg/dL'),
    it(200, 737, '5.0'),
  ];
  const out = parseMyChartItems(items);
  const by = Object.fromEntries(out.results.map((r) => [r.analyte, r]));
  assert.equal(by.blasts.value, 2);
  assert.equal(by.ldh, undefined, 'never borrows the next box’s number');
  assert.equal(by.uricAcid.value, 5);
  assert.ok(out.skipped.some((s) => /^LDH: no numeric value/.test(s)));
});

test('Test Details: a unit in a different scale is skipped, not mis-charted', () => {
  const items = [
    banner,
    it(28, 77, 'Collected on Jan 9, 2026 1:30 PM'),
    ...box(34, 137, 'Hemoglobin', '125 - 162 g/L', '111', [
      [117, '125'],
      [229, '162'],
    ]),
  ];
  const out = parseMyChartItems(items);
  assert.equal(out.results.length, 0);
  assert.match(out.skipped[0], /unexpected unit "g\/L"/);
});

function trendRows(rows) {
  const items = [
    banner,
    it(28, 63, 'Result Trends'),
    it(149, 114, 'Showing up to 10 most recent results'),
    it(34, 155, 'Malb Crt Ratio'),
    it(34, 168, 'Normal range: 30.0 mg/G Creat or below'),
    // Chart axis labels look like dates but lack the year on the same item.
    it(51, 343, 'May 4'),
    it(53, 352, '2026'),
    it(39, 386, 'Date'),
    it(163, 386, 'Value'),
    it(305, 386, 'Normal Range'),
  ];
  rows.forEach(([date, value, flag], i) => {
    const y = 420 + i * 39;
    items.push(it(39, y, date), it(163, y - 7, value), it(163, y + 6, 'mg/G Creat'));
    if (flag) items.push(it(197, y, flag));
    items.push(it(305, y, '30 mg/G Creat or below'));
  });
  items.push(it(211, 603, '1 - 4 (of 4)'));
  return items;
}

test('Result Trends: reads every row with its own range', () => {
  const out = parseMyChartItems(
    trendRows([
      ['Feb 2, 2026', '512.5', 'High'],
      ['Jan 5, 2026', '1,200', 'High'],
      ['Dec 1, 2025', '25'],
    ]),
  );
  assert.equal(out.kind, 'trends');
  assert.equal(out.title, 'Malb Crt Ratio');
  assert.equal(out.source, null);
  assert.equal(out.results.length, 3);
  const [a, b, c] = out.results;
  assert.equal(a.analyte, 'uacr');
  assert.equal(a.value, 512.5);
  assert.equal(a.unit, 'mg/g');
  assert.equal(a.refHigh, 30);
  assert.equal(a.refLow, null);
  assert.equal(a.dateOnly, true);
  assert.deepEqual(a.collectedAt, new Date(2026, 1, 2, 12, 0));
  assert.equal(b.value, 1200);
  assert.equal(c.value, 25);
});

test('mergeResults: one per analyte per day, timed draw beats date-only', () => {
  const timed = {
    analyte: 'ldh',
    value: 300,
    collectedAt: new Date(2026, 0, 9, 13, 30),
    dateOnly: false,
  };
  const dateOnly = {
    analyte: 'ldh',
    value: 300,
    collectedAt: new Date(2026, 0, 9, 12),
    dateOnly: true,
  };
  const older = {
    analyte: 'ldh',
    value: 280,
    collectedAt: new Date(2025, 11, 1, 12),
    dateOnly: true,
  };
  const merged = mergeResults([[dateOnly, older], [timed]]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], timed);
  assert.equal(merged[1], older);
});

test('helpers', () => {
  assert.deepEqual(parseRange('Normal range: 4.00 - 11.00 10*3/uL'), {
    refLow: 4,
    refHigh: 11,
    unit: '10*3/uL',
  });
  assert.deepEqual(parseRange('12.3 % or below'), {
    refLow: null,
    refHigh: 12.3,
    unit: '%',
  });
  assert.equal(parseRange('See Comment'), null);

  assert.deepEqual(parseNumber('1,410'), { value: 1410 });
  assert.deepEqual(parseNumber('>90'), { value: 90, qualifier: '>' });
  assert.equal(parseNumber('No value'), null);
  assert.equal(parseNumber('Nov 20, 2026'), null);

  assert.deepEqual(parseMyChartDate('Dec 31, 2025 12:05 AM'), {
    date: new Date(2025, 11, 31, 0, 5),
    dateOnly: false,
  });
  assert.equal(parseMyChartDate('May 4'), null);

  assert.equal(matchAnalyte('Blood Urea Nitrogen (BUN)'), 'bun');
  assert.equal(matchAnalyte('Creatinine'), 'creatinine');
  assert.equal(matchAnalyte('Abs Neutro Man'), 'anc');
  assert.equal(matchAnalyte('Neutrophil Man'), null); // a %, not the absolute count
  assert.equal(matchAnalyte('Lactate Dehydrogenase'), 'ldh');
  assert.equal(matchAnalyte('Microalbumin/Creatinine Ratio'), 'uacr');
  assert.equal(matchAnalyte('Magnesium, Plasma'), null);

  assert.ok(unitMatches('uacr', 'mg/G Creat'));
  assert.ok(unitMatches('egfr', 'mL/min/1.73m2'));
  assert.ok(!unitMatches('creatinine', 'umol/L'));
});
