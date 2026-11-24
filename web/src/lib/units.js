/**
 * Display units for weight and temperature. Values are always stored in kg
 * and °C; these settings only change what's shown and entered. Saved per
 * device (it's a display preference, not health data).
 */
const KEY = 'mt_units';
const DEFAULTS = { weight: 'lb', temperature: 'F' };
const LB_PER_KG = 2.20462;

export function getUnits() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setUnits(patch) {
  const next = { ...getUnits(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode): the choice lasts for this session.
  }
  return next;
}

/** kg → shown weight, and back. */
export const weightOut = (kg, u = getUnits().weight) =>
  u === 'lb' ? kg * LB_PER_KG : kg;
export const weightIn = (x, u = getUnits().weight) => (u === 'lb' ? x / LB_PER_KG : x);
/** °C → shown temperature, and back. */
export const tempOut = (c, u = getUnits().temperature) =>
  u === 'F' ? (c * 9) / 5 + 32 : c;
export const tempIn = (x, u = getUnits().temperature) =>
  u === 'F' ? ((x - 32) * 5) / 9 : x;
