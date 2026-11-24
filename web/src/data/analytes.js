/**
 * Canonical lab analytes MyeloTrack tracks. The key matches `labResults.analyte`
 * in the backend schema; the server keeps a mirror of this catalog in
 * server/src/data/analytes.js (a server test asserts the two stay in sync).
 *
 * `refLow`/`refHigh` are display defaults only. Real results carry the
 * resulting lab's own range, which always wins. A null bound means the range is
 * one-sided ("37 U/L or below" → refLow null, refHigh 37).
 */
export const ANALYTES = {
  // --- Blood counts ---
  hemoglobin: {
    label: 'Hemoglobin',
    unit: 'g/dL',
    refLow: 13.5,
    refHigh: 17.5,
    loinc: '718-7',
  },
  platelets: {
    label: 'Platelets',
    unit: 'K/µL',
    refLow: 150,
    refHigh: 400,
    loinc: '777-3',
  },
  wbc: { label: 'WBC', unit: 'K/µL', refLow: 4.0, refHigh: 11.0, loinc: '6690-2' },
  anc: { label: 'ANC', unit: 'K/µL', refLow: 1.8, refHigh: 7.7, loinc: '751-8' },
  blasts: {
    label: 'Peripheral blasts',
    unit: '%',
    refLow: 0,
    refHigh: 0,
    loinc: '709-7',
  },

  // --- Kidney ---
  creatinine: {
    label: 'Creatinine',
    unit: 'mg/dL',
    refLow: 0.6,
    refHigh: 1.3,
    loinc: '2160-0',
  },
  egfr: {
    label: 'eGFR',
    unit: 'mL/min/1.73m²',
    refLow: 60,
    refHigh: null,
    loinc: '98979-8',
  },
  bun: { label: 'BUN', unit: 'mg/dL', refLow: 6, refHigh: 20, loinc: '3094-0' },
  uacr: {
    label: 'Urine albumin/creatinine',
    unit: 'mg/g',
    refLow: null,
    refHigh: 30,
    loinc: '9318-7',
  },

  // --- Liver ---
  ast: { label: 'AST', unit: 'U/L', refLow: null, refHigh: 37, loinc: '1920-8' },
  alt: { label: 'ALT', unit: 'U/L', refLow: null, refHigh: 55, loinc: '1742-6' },

  // --- Cell turnover ---
  ldh: { label: 'LDH', unit: 'U/L', refLow: 130, refHigh: 250, loinc: '2532-0' },
  uricAcid: {
    label: 'Uric acid',
    unit: 'mg/dL',
    refLow: 3.8,
    refHigh: 8.5,
    loinc: '3084-1',
  },
};

/** Display label for an analyte key (unknown keys fall back to the key). */
export const analyteLabel = (key) => ANALYTES[key]?.label || key;

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * Flag a value against a (possibly one-sided) reference range.
 * @returns {'low'|'high'|'normal'}
 */
export function rangeFlag(value, refLow, refHigh) {
  if (isNum(refLow) && value < refLow) return 'low';
  if (isNum(refHigh) && value > refHigh) return 'high';
  return 'normal';
}

/** "ref 130–250", "ref ≤ 37", "ref ≥ 60", or '' when there's no range. */
export function refText(refLow, refHigh) {
  const lo = isNum(refLow);
  const hi = isNum(refHigh);
  if (lo && hi) return `ref ${refLow}–${refHigh}`;
  if (hi) return `ref ≤ ${refHigh}`;
  if (lo) return `ref ≥ ${refLow}`;
  return '';
}
