/**
 * Scheduled-dose helpers shared by the Today checkmarks, the trial diary and
 * the visit report. A dose slot is a medication + a local calendar day + a
 * clock time; its server key is that local moment as an ISO timestamp.
 */

/** 'YYYY-MM-DD' for a Date in local time. */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local day + 'HH:MM' → ISO timestamp (the dose record's scheduledFor). */
export function slotIso(day, time) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

/** Local midnight at the start of `day`, and of the day after. */
export function dayBounds(day) {
  const [y, m, d] = day.split('-').map(Number);
  return { from: new Date(y, m - 1, d), to: new Date(y, m - 1, d + 1) };
}

/** Add n days to a 'YYYY-MM-DD'. */
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

/** Whole days from a to b ('YYYY-MM-DD'), b − a. */
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/** mg per tablet from a dose like "5 mg" or "0.4 mg"; null if not plain mg. */
export function strengthMg(dose) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*mg\s*$/i.exec(dose || '');
  return m ? Number(m[1]) : null;
}

/** Tablets per dose from instructions like "3 tablets twice daily"; default 1. */
export function tabletsPerDose(instructions) {
  const m = /(\d+(?:\.\d+)?)\s*(tablets?|tabs?|capsules?|caps?|pills?)\b/i.exec(
    instructions || '',
  );
  return m ? Number(m[1]) : 1;
}

/**
 * For a trial and a date, which cycle and day it falls in. `cycles` is
 * [{ number, start }] sorted by start. Null before the first cycle, or past
 * the end of the last one when the cycle length is known.
 */
export function cycleDayFor(cycles, cycleDays, day) {
  let found = null;
  for (const c of cycles || []) if (c.start <= day) found = c;
  if (!found) return null;
  const n = daysBetween(found.start, day) + 1;
  if (cycleDays && n > cycleDays) return null;
  return { cycle: found.number, day: n, start: found.start };
}
