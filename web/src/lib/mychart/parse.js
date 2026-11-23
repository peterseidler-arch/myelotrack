import { ANALYTES } from '../../data/analytes.js';

/**
 * Parse the text of a MyChart (Epic) PDF printout into lab results.
 *
 * Two printouts are understood:
 *   - "Test Details" — one panel (CBC, CMP, …) drawn on a single date, each
 *     component in a box: name, "Normal range: …", value, range-bar ticks.
 *   - "Result Trends" — one test's recent history: a Date / Value / Normal
 *     Range table.
 *
 * Input is pdf.js text items flattened to `{ str, x, y }` in points, with `y`
 * measured top-down and accumulated across pages (see pdf-items.js), so the
 * parser is pure and testable without a PDF. Components we don't track are
 * returned in `skipped` rather than guessed at.
 */

/** MyChart component name → canonical analyte key. First match wins. */
const NAME_PATTERNS = [
  ['uacr', /^malb\s*crt\s*ratio|albumin\s*\/\s*creat|microalb\w*\s*\/\s*creat/i],
  ['hemoglobin', /^(hgb|hemoglobin)\b/i],
  ['platelets', /^(platelet count|platelets?|plt)\b/i],
  ['wbc', /^(wbc|white blood cell|leukocytes?)\b(?!:)/i],
  ['anc', /^(abs(olute)?\.?\s*neut|anc\b)/i],
  ['blasts', /\bblasts?\b/i],
  ['creatinine', /^creatinine(,?\s*(serum|plasma|blood))?$/i],
  ['egfr', /^egfr\b/i],
  ['bun', /blood urea nitrogen|^bun\b/i],
  ['ast', /aspartate aminotransferase|^(ast|sgot)\b/i],
  ['alt', /alanine aminotransferase|^(alt|sgpt)\b/i],
  ['ldh', /^ldh\b|lactate dehydrogenase/i],
  ['uricAcid', /^uric acid\b/i],
];

/**
 * Units each analyte may arrive in that are numerically identical to its
 * canonical unit. Anything else is skipped, so a result in a different scale
 * (say hemoglobin in g/L) can never be charted as if it were g/dL.
 */
const UNIT_ALIASES = {
  hemoglobin: ['g/dl'],
  platelets: ['10*3/ul', '10^3/ul', 'x10e3/ul', 'k/ul', 'k/µl', 'thou/ul', '10*9/l'],
  wbc: ['10*3/ul', '10^3/ul', 'x10e3/ul', 'k/ul', 'k/µl', 'thou/ul', '10*9/l'],
  anc: ['10*3/ul', '10^3/ul', 'x10e3/ul', 'k/ul', 'k/µl', 'thou/ul', '10*9/l'],
  blasts: ['%'],
  creatinine: ['mg/dl'],
  bun: ['mg/dl'],
  uricAcid: ['mg/dl'],
  egfr: ['ml/min/1.73m2', 'ml/min/1.73m²', 'ml/min/1.73'],
  uacr: ['mg/gcreat', 'mg/g', 'mg/gcr', 'mg/gcrt', 'ug/mgcreat', 'µg/mgcreat'],
  ast: ['u/l', 'iu/l'],
  alt: ['u/l', 'iu/l'],
  ldh: ['u/l', 'iu/l'],
};

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DATE_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: (\d{1,2}):(\d{2}) ?([AP]M))?$/;
const NUM_RE = /^([<>]=?)?\s*(-?[\d,]*\.?\d+)$/;

/** Map a MyChart component name to an analyte key, or null. */
export function matchAnalyte(name) {
  const clean = String(name).trim();
  for (const [key, re] of NAME_PATTERNS) if (re.test(clean)) return key;
  return null;
}

/** "Nov 20, 2026 2:47 PM" → { date, dateOnly } (local time), or null. */
export function parseMyChartDate(text) {
  const m = DATE_RE.exec(String(text).trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const dateOnly = m[4] == null;
  let hours = 12; // date-only draws sit at local noon so the day never shifts
  let minutes = 0;
  if (!dateOnly) {
    hours = (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
    minutes = Number(m[5]);
  }
  return { date: new Date(Number(m[3]), month, Number(m[2]), hours, minutes), dateOnly };
}

/** "1,410" → { value: 1410 }; "<0.2" → { value: 0.2, qualifier: '<' }; else null. */
export function parseNumber(text) {
  const m = NUM_RE.exec(String(text).trim());
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return m[1] ? { value, qualifier: m[1] } : { value };
}

/**
 * Parse a reference-range string (with or without the "Normal range:" prefix).
 *   "4.00 - 11.00 10*3/uL"     → { refLow: 4, refHigh: 11, unit: '10*3/uL' }
 *   "37 U/L or below"           → { refLow: null, refHigh: 37, unit: 'U/L' }
 *   "60 mL/min/1.73m2 or above" → { refLow: 60, refHigh: null, unit: … }
 */
export function parseRange(text) {
  const s = String(text)
    .replace(/^normal range:\s*/i, '')
    .trim();
  let m = /^([\d.,]+)\s*-\s*([\d.,]+)\s*(.*)$/.exec(s);
  if (m) return { refLow: num(m[1]), refHigh: num(m[2]), unit: m[3].trim() };
  m = /^([\d.,]+)\s*(.*?)\s*or below$/i.exec(s);
  if (m) return { refLow: null, refHigh: num(m[1]), unit: m[2].trim() };
  m = /^([\d.,]+)\s*(.*?)\s*or above$/i.exec(s);
  if (m) return { refLow: num(m[1]), refHigh: null, unit: m[2].trim() };
  return null;
}

const num = (s) => Number(String(s).replace(/,/g, ''));
const unitKey = (u) => String(u).toLowerCase().replace(/\s+/g, '');

/** True when `unit` (as printed) is compatible with the analyte's canonical unit. */
export function unitMatches(analyte, unit) {
  if (!unit) return true; // no unit printed — the range was matched by name
  return (UNIT_ALIASES[analyte] || []).includes(unitKey(unit));
}

/** Detect the care team from lab names printed on the page. */
export function detectSource(items) {
  const text = items.map((i) => i.str).join(' ');
  if (/MSKCC|Memorial Sloan/i.test(text)) return 'msk';
  if (/Capital Health/i.test(text)) return 'capital-health';
  return null;
}

const byPosition = (a, b) => a.y - b.y || a.x - b.x;

/** The item directly above `below` in the same left-aligned column. */
function labelAbove(items, below) {
  return items
    .filter((i) => i !== below && Math.abs(i.x - below.x) < 3)
    .filter((i) => below.y - i.y > 4 && below.y - i.y < 24)
    .sort((a, b) => b.y - a.y)[0];
}

/**
 * Build one result, or a skip reason. `range` is the lab's printed range.
 * @returns {{ result?: object, skip?: string }}
 */
function buildResult({ name, valueText, range, unit, when }) {
  const analyte = matchAnalyte(name);
  if (!analyte) return { skip: `${name}: not a tracked test` };
  const parsed = parseNumber(valueText);
  if (!parsed) return { skip: `${name}: no numeric value` };
  const printedUnit = unit || range?.unit || '';
  if (!unitMatches(analyte, printedUnit)) {
    return { skip: `${name}: unexpected unit "${printedUnit}"` };
  }
  if (!when) return { skip: `${name}: no collection date` };
  return {
    result: {
      analyte,
      name: name.trim(),
      value: parsed.value,
      ...(parsed.qualifier ? { qualifier: parsed.qualifier } : {}),
      unit: ANALYTES[analyte].unit,
      refLow: range?.refLow ?? null,
      refHigh: range?.refHigh ?? null,
      collectedAt: when.date,
      dateOnly: when.dateOnly,
    },
  };
}

/** Parse a "Test Details" printout (one panel, one collection time). */
function parseDetails(items) {
  const results = [];
  const skipped = [];

  // Panel collection time: "Collected on Nov 20, 2026 2:47 PM", or the
  // "Collection date:" footer field.
  let when = null;
  for (const i of items) {
    const m = /^Collected on (.+)$/i.exec(i.str.trim());
    if (m) when = parseMyChartDate(m[1]);
    if (when) break;
  }
  if (!when) {
    const label = items.find((i) => /^Collection date:/i.test(i.str.trim()));
    const value =
      label &&
      items.find((i) => i !== label && Math.abs(i.y - label.y) < 3 && i.x > label.x);
    when = value ? parseMyChartDate(value.str) : null;
  }

  const rangeItems = items.filter((i) => /^Normal range:/i.test(i.str.trim()));
  const columnXs = [...new Set(rangeItems.map((r) => Math.round(r.x)))].sort(
    (a, b) => a - b,
  );

  for (const r of rangeItems) {
    const nameItem = labelAbove(items, r);
    if (!nameItem) continue;
    const name = nameItem.str;
    if (!matchAnalyte(name)) {
      skipped.push(`${name.trim()}: not a tracked test`);
      continue;
    }

    // The box spans from its range line down to the next thing printed at the
    // column's left margin (next component, a footnote), and across to the
    // next column. The value is the first number in it; the range-bar tick
    // labels are drawn below the value, so they never come first.
    const colRight = columnXs.find((x) => x > r.x + 50) ?? Infinity;
    const end = Math.min(
      Infinity,
      ...items.filter((i) => Math.abs(i.x - r.x) < 3 && i.y > r.y + 2).map((i) => i.y),
    );
    const valueItem = items
      .filter((i) => i.y > r.y + 2 && i.y < end)
      .filter((i) => i.x >= r.x - 5 && i.x < colRight - 5)
      .filter((i) => parseNumber(i.str))
      .sort(byPosition)[0];

    const { result, skip } = buildResult({
      name,
      valueText: valueItem?.str ?? '',
      range: parseRange(r.str),
      when,
    });
    if (result) results.push(result);
    else skipped.push(skip);
  }
  return { results, skipped };
}

/** Parse a "Result Trends" printout (one test, a table of recent draws). */
function parseTrends(items) {
  const results = [];
  const skipped = [];

  const topRange = items.find((i) => /^Normal range:/i.test(i.str.trim()));
  const nameItem = topRange && labelAbove(items, topRange);
  const name = nameItem?.str?.trim() || '';
  const header = {
    date: items.find((i) => i.str.trim() === 'Date'),
    value: items.find((i) => i.str.trim() === 'Value'),
    range: items.find((i) => i.str.trim() === 'Normal Range'),
  };
  if (!name || !header.date || !header.value) return { results, skipped };
  if (!matchAnalyte(name)) return { results, skipped: [`${name}: not a tracked test`] };

  const rangeX = header.range?.x ?? Infinity;
  const rows = items
    .filter((i) => Math.abs(i.x - header.date.x) < 6 && i.y > header.date.y)
    .filter((i) => parseMyChartDate(i.str))
    .sort(byPosition);

  for (const row of rows) {
    const inRow = items.filter(
      (i) => Math.abs(i.y - row.y) <= 10 && i.x > header.value.x - 6 && i.x < rangeX - 6,
    );
    const valueItem = inRow.filter((i) => parseNumber(i.str)).sort(byPosition)[0];
    // Units print just under the value ("382" / "U/L").
    const unitItem = valueItem
      ? items.find(
          (i) =>
            Math.abs(i.x - valueItem.x) < 4 &&
            i.y > valueItem.y &&
            i.y - valueItem.y < 20 &&
            !parseNumber(i.str),
        )
      : null;
    const rangeItem = header.range
      ? items.find(
          (i) => Math.abs(i.x - header.range.x) < 6 && Math.abs(i.y - row.y) <= 4,
        )
      : null;

    const { result, skip } = buildResult({
      name,
      valueText: valueItem?.str ?? '',
      range: parseRange(rangeItem?.str ?? topRange.str),
      unit: unitItem?.str,
      when: parseMyChartDate(row.str),
    });
    if (result) results.push(result);
    else skipped.push(`${skip} (${row.str.trim()})`);
  }
  return { results, skipped };
}

/**
 * Parse positioned text from a MyChart printout.
 *
 * @param {{ str: string, x: number, y: number }[]} items
 * @returns {{
 *   kind: 'details'|'trends'|'unknown',
 *   title: string,
 *   source: string|null,
 *   results: object[],
 *   skipped: string[],
 * }}
 */
export function parseMyChartItems(items) {
  const clean = items.filter((i) => i.str && i.str.trim());
  const isTrends = clean.some((i) => i.str.trim() === 'Result Trends');
  const isDetails =
    !isTrends && clean.some((i) => /^(Normal range:|Collected on )/i.test(i.str.trim()));
  const kind = isTrends ? 'trends' : isDetails ? 'details' : 'unknown';

  // Title: the test name for a trend; else the first heading under the banner.
  const sorted = [...clean].sort(byPosition);
  const trendRange = isTrends && sorted.find((i) => /^Normal range:/i.test(i.str.trim()));
  const title =
    (trendRange
      ? labelAbove(clean, trendRange)?.str
      : sorted.find((i) => !/^Name:/.test(i.str))?.str
    )?.trim() || '';

  const parsed =
    kind === 'details'
      ? parseDetails(clean)
      : kind === 'trends'
        ? parseTrends(clean)
        : { results: [], skipped: [] };

  return { kind, title, source: detectSource(clean), ...parsed };
}

/** Local calendar day of a Date, "YYYY-MM-DD". */
export function dayKey(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Merge results from several printouts, one per analyte per day. The same
 * draw often appears in both a Test Details and a Result Trends printout; the
 * one with an exact collection time wins over a date-only row.
 */
export function mergeResults(lists) {
  const byKey = new Map();
  for (const r of lists.flat()) {
    const key = `${r.analyte}@${dayKey(r.collectedAt)}`;
    const existing = byKey.get(key);
    if (!existing || (existing.dateOnly && !r.dateOnly)) byKey.set(key, r);
  }
  return [...byKey.values()].sort(
    (a, b) => b.collectedAt - a.collectedAt || a.analyte.localeCompare(b.analyte),
  );
}
