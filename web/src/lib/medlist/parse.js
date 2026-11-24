/**
 * Read a medication list out of a PDF's positioned text items ({ str, x, y },
 * see lib/mychart/pdf-items.js). Built for the common printed or saved table:
 *
 *   Section heading                   [Dr. Name]
 *   Medication            Dose        Schedule              [Prescriber]
 *   Name (Brand)          50 mg       1 tablet twice daily  Dr. Name
 *
 * Columns come from the header row; a column of doctor names to the right
 * without a header is picked up too. A row with only a name-column cell is a
 * section heading; it becomes the purpose of the medications below it, and a
 * doctor named on it becomes their default prescriber.
 *
 * Every result is a suggestion for the review screen, which the patient checks
 * before anything is saved.
 */

const HEADERS = {
  name: /^(medications?|medicines?|drugs?|name)$/i,
  dose: /^(dose|dosage|strength)$/i,
  schedule: /^(schedule|frequency|directions|instructions|how to take|sig|when)$/i,
  prescriber: /^(prescriber|prescribed by|provider|doctor|physician)$/i,
};
const DOCTOR = /^(dr\.?\s|doctor\s)|\b(md|do|np|pa-c)$|doctor$/i;
// Words that mark a parenthetical as a drug class, not a brand name.
const CLASS_WORDS =
  /(inhibitor|blocker|agonist|antagonist|antibod|statin|steroid|supplement|vitamin|\/)/i;

/** Group items into rows by y (items within `tol` points share a row). */
export function toRows(items, tol = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    if (row && Math.abs(it.y - row.y) <= tol) row.cells.push(it);
    else rows.push({ y: it.y, cells: [it] });
  }
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    // Merge fragments a PDF split mid-phrase (same row, close together).
    const merged = [];
    for (const c of r.cells) {
      const prev = merged.at(-1);
      if (prev && c.x - prev.end < 4) {
        prev.str += (c.x - prev.end > 1 ? ' ' : '') + c.str;
        prev.end = c.x + (c.w ?? c.str.length * 5);
      } else {
        merged.push({ ...c, str: c.str, end: c.x + (c.w ?? c.str.length * 5) });
      }
    }
    r.cells = merged.map((c) => ({ ...c, str: c.str.replace(/\u200b/g, '').trim() }));
    r.cells = r.cells.filter((c) => c.str);
  }
  return rows.filter((r) => r.cells.length);
}

/** Find the header row and the x where each column starts. */
function findColumns(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cols = {};
    for (const c of rows[i].cells) {
      for (const [key, re] of Object.entries(HEADERS)) {
        if (!cols[key] && re.test(c.str)) cols[key] = c.x;
      }
    }
    if (cols.name != null && (cols.dose != null || cols.schedule != null)) {
      return { headerIndex: i, cols };
    }
  }
  return null;
}

/** Which column a cell belongs to: the right-most column starting at or left of it. */
function columnOf(x, cols) {
  let best = null;
  for (const [key, start] of Object.entries(cols)) {
    if (start - 6 <= x && (best == null || start > cols[best])) best = key;
  }
  return best;
}

/** "Metformin XR (Glucophage)" → name + brand; "(CDK4/6 inhibitor)" → drug class. */
export function splitName(raw) {
  const m = /^(.*?)\s*\(([^)]*)\)?\s*$/.exec(raw);
  if (!m || !m[1]) return { name: raw.trim(), brand: '', drugClass: '' };
  const inner = m[2].trim();
  return CLASS_WORDS.test(inner) || /^[a-z]/.test(inner)
    ? { name: m[1].trim(), brand: '', drugClass: inner }
    : { name: m[1].trim(), brand: inner, drugClass: '' };
}

/**
 * Turn schedule wording into suggested clock times. Returns
 * `{ times, asNeeded }`; the original wording is kept separately as
 * instructions. Unrecognized wording yields no times (the patient sets them).
 */
export function scheduleTimes(textIn) {
  const t = ` ${String(textIn || '').toLowerCase()} `;
  if (/\bas needed\b|\bprn\b|\bif needed\b/.test(t)) return { times: [], asNeeded: true };
  if (/\btbd\b|\bdepends\b|\bper (doctor|clinic|protocol)\b/.test(t)) {
    return { times: [], asNeeded: false };
  }
  const n = /\b(4|four)\s*(x|times)\b|\bqid\b|every 6 hours/.test(t)
    ? 4
    : /\b(3|three)\s*(x|times)\b|\btid\b|every 8 hours/.test(t)
      ? 3
      : /\btwice\b|\b(2|two)\s*(x|times)\s*(a|per)?\s*day|\bbid\b|every 12 hours/.test(t)
        ? 2
        : /\bonce\b|\bdaily\b|\bevery (day|morning|evening|night)\b|\bqd\b|\bbedtime\b|\bat night\b|\bin the (morning|evening)\b|\bqhs\b/.test(
              t,
            )
          ? 1
          : 0;
  if (n === 4) return { times: ['08:00', '12:00', '16:00', '20:00'], asNeeded: false };
  if (n === 3) return { times: ['08:00', '14:00', '20:00'], asNeeded: false };
  if (n === 2) return { times: ['08:00', '20:00'], asNeeded: false };
  if (n === 1) {
    if (/bedtime|at night|qhs/.test(t)) return { times: ['22:00'], asNeeded: false };
    if (/evening/.test(t)) return { times: ['19:00'], asNeeded: false };
    return { times: ['08:00'], asNeeded: false };
  }
  return { times: [], asNeeded: false };
}

/**
 * Parse positioned items into medication suggestions.
 * @returns {{ title: string, medications: object[], skipped: string[] }}
 */
export function parseMedList(items) {
  const rows = toRows(items);
  const found = findColumns(rows);
  if (!found) return { title: '', medications: [], skipped: [], kind: 'unknown' };
  const { headerIndex } = found;
  const cols = { ...found.cols };

  // A doctor column to the right with no header of its own.
  if (cols.prescriber == null) {
    const right = Math.max(...Object.values(cols));
    const xs = rows
      .slice(headerIndex + 1)
      .flatMap((r) => r.cells)
      .filter((c) => c.x > right + 40 && DOCTOR.test(c.str))
      .map((c) => c.x);
    if (xs.length) cols.prescriber = Math.min(...xs);
  }

  const title = rows[0]?.cells.map((c) => c.str).join(' ') || '';
  const medications = [];
  const skipped = [];
  let section = '';
  let sectionDoctor = '';

  const readSection = (row) => {
    const nameCell = row.cells[0];
    section = nameCell.str;
    sectionDoctor = row.cells.slice(1).find((c) => DOCTOR.test(c.str))?.str || '';
  };

  // A heading directly above the header row (e.g. "Trial name   Dr. Name").
  for (let i = headerIndex - 1; i > 0; i--) {
    const r = rows[i];
    if (Math.abs(r.cells[0].x - cols.name) < 8) {
      readSection(r);
      break;
    }
  }

  for (const row of rows.slice(headerIndex + 1)) {
    const cell = {};
    for (const c of row.cells) {
      const key = columnOf(c.x, cols);
      if (!key) continue;
      cell[key] = cell[key] ? `${cell[key]} ${c.str}` : c.str;
    }
    if (!cell.name) continue;
    // A repeated header (multi-page tables).
    if (HEADERS.name.test(cell.name)) continue;

    const isSection =
      !cell.schedule && (!cell.dose || DOCTOR.test(cell.dose)) && !cell.prescriber;
    const isSectionWithDoctor = !cell.schedule && !cell.dose && cell.prescriber;
    if (isSection || isSectionWithDoctor) {
      section = cell.name;
      sectionDoctor = cell.prescriber || (DOCTOR.test(cell.dose || '') ? cell.dose : '');
      continue;
    }

    const { name, brand, drugClass } = splitName(cell.name);
    if (!name) {
      skipped.push(cell.name);
      continue;
    }
    // Drop a stray closing parenthesis with no opening one ("…per week)").
    const raw = cell.schedule || '';
    const scheduleText = raw.includes('(') ? raw : raw.replace(/\)\s*$/, '');
    const { times, asNeeded } = scheduleTimes(scheduleText);
    const dose = /^tbd$/i.test(cell.dose || '') ? 'TBD' : cell.dose || '';
    medications.push({
      name,
      brand,
      dose,
      purpose: [section, drugClass].filter(Boolean).join(' · '),
      prescriber: cell.prescriber || sectionDoctor || '',
      schedule: { times, asNeeded, instructions: scheduleText.trim() },
    });
  }
  return { title, medications, skipped, kind: 'medlist' };
}
