/**
 * Canonical lab analytes the server accepts. Mirrors web/src/data/analytes.js
 * (labels live client-side); test/analytes.test.js keeps the two in sync.
 *
 * `refLow`/`refHigh` are fallbacks only — a result's own lab-provided range
 * wins. A null bound means the range is one-sided.
 */
export const ANALYTES = {
  hemoglobin: { unit: 'g/dL', refLow: 13.5, refHigh: 17.5, loinc: '718-7' },
  platelets: { unit: 'K/µL', refLow: 150, refHigh: 400, loinc: '777-3' },
  wbc: { unit: 'K/µL', refLow: 4.0, refHigh: 11.0, loinc: '6690-2' },
  anc: { unit: 'K/µL', refLow: 1.8, refHigh: 7.7, loinc: '751-8' },
  blasts: { unit: '%', refLow: 0, refHigh: 0, loinc: '709-7' },
  creatinine: { unit: 'mg/dL', refLow: 0.6, refHigh: 1.3, loinc: '2160-0' },
  egfr: { unit: 'mL/min/1.73m²', refLow: 60, refHigh: null, loinc: '98979-8' },
  bun: { unit: 'mg/dL', refLow: 6, refHigh: 20, loinc: '3094-0' },
  uacr: { unit: 'mg/g', refLow: null, refHigh: 30, loinc: '9318-7' },
  ast: { unit: 'U/L', refLow: null, refHigh: 37, loinc: '1920-8' },
  alt: { unit: 'U/L', refLow: null, refHigh: 55, loinc: '1742-6' },
  ldh: { unit: 'U/L', refLow: 130, refHigh: 250, loinc: '2532-0' },
  uricAcid: { unit: 'mg/dL', refLow: 3.8, refHigh: 8.5, loinc: '3084-1' },
};

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Clinical flag for a value. Uses `range` (the result's own lab-provided
 * bounds) when given, else the catalog default; unknown analytes with no
 * range are 'normal' rather than an error.
 *
 * @param {string} analyte
 * @param {number} value
 * @param {{ refLow?: number|null, refHigh?: number|null }} [range]
 * @returns {'low'|'high'|'critical'|'normal'}
 */
export function computeFlag(analyte, value, range) {
  if (analyte === 'blasts') {
    if (value <= 0) return 'normal';
    return value >= 5 ? 'critical' : 'high';
  }
  const own = range && (isNum(range.refLow) || isNum(range.refHigh));
  const { refLow, refHigh } = own ? range : ANALYTES[analyte] || {};
  if (isNum(refLow) && value < refLow) return 'low';
  if (isNum(refHigh) && value > refHigh) return 'high';
  return 'normal';
}
