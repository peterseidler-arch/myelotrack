import { asyncHandler, badRequest } from '../lib/async-handler.js';
import { ANALYTES, computeFlag } from '../data/analytes.js';

// The patient-scoped repository, bound by requireAuth (see middleware/auth.js).
const repo = (req) => req.repo;

/** GET /api/v1/labs?analyte=&source= — aggregated results across care teams. */
export const list = asyncHandler(async (req, res) => {
  const results = await repo(req).listLabs({
    analyte: req.query.analyte,
    source: req.query.source,
  });
  res.json({ data: results });
});

/** GET /api/v1/labs/analytes — distinct analytes seen. */
export const analytes = asyncHandler(async (req, res) => {
  res.json({ data: await repo(req).listAnalytes() });
});

// Care teams a printout can be attributed to (see web/src/data/sources.js).
const IMPORT_SOURCES = new Set(['msk', 'capital-health', 'manual']);
const MAX_RESULTS = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const optionalNumber = (v, field, i) => {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw badRequest(`results[${i}].${field} must be a number or null`);
  }
  return v;
};

/**
 * Validate one imported result and build the stored record. The client parses
 * the PDF (it never leaves the device); the server owns everything derived:
 * unit, LOINC, flag, and the dedup key.
 */
function toLabRecord(r, i, source) {
  if (!r || typeof r !== 'object') throw badRequest(`results[${i}] must be an object`);
  const meta = ANALYTES[r.analyte];
  if (!meta) throw badRequest(`results[${i}].analyte "${r.analyte}" is not supported`);
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
    throw badRequest(`results[${i}].value must be a number`);
  }
  const collectedAt = new Date(r.collectedAt);
  if (Number.isNaN(collectedAt.getTime())) {
    throw badRequest(`results[${i}].collectedAt must be a date`);
  }
  if (collectedAt.getTime() > Date.now() + DAY_MS) {
    throw badRequest(`results[${i}].collectedAt is in the future`);
  }
  // `day` is the collection date as printed (the patient's local calendar
  // day), so the dedup key can't drift with the server's time zone.
  if (typeof r.day !== 'string' || !DAY_RE.test(r.day)) {
    throw badRequest(`results[${i}].day must be YYYY-MM-DD`);
  }
  if (Math.abs(new Date(`${r.day}T12:00:00Z`) - collectedAt) > 1.5 * DAY_MS) {
    throw badRequest(`results[${i}].day does not match collectedAt`);
  }
  const refLow = optionalNumber(r.refLow, 'refLow', i);
  const refHigh = optionalNumber(r.refHigh, 'refHigh', i);
  const qualifier = ['<', '>', '<=', '>='].includes(r.qualifier)
    ? r.qualifier
    : undefined;

  return {
    analyte: r.analyte,
    loinc: meta.loinc,
    value: r.value,
    unit: meta.unit,
    refLow,
    refHigh,
    flag: computeFlag(r.analyte, r.value, { refLow, refHigh }),
    collectedAt,
    reportedAt: null,
    source,
    provenance: {
      system: 'mychart-pdf',
      // One draw per test per care team per day: re-importing the same
      // printout, or the same draw from a Trends printout, updates in place.
      externalId: `mychart:${source}:${r.analyte}:${r.day}`,
      dateOnly: r.dateOnly === true,
      ...(qualifier ? { qualifier } : {}),
    },
  };
}

/**
 * POST /api/v1/labs/import — save results parsed from MyChart printouts.
 * Body: `{ source, results: [{ analyte, value, refLow, refHigh, collectedAt,
 * day, dateOnly, qualifier? }] }`. Responds with how many were added,
 * updated, or already on file.
 */
export const importResults = asyncHandler(async (req, res) => {
  const { source, results } = req.body || {};
  if (!IMPORT_SOURCES.has(source)) {
    throw badRequest(`source must be one of: ${[...IMPORT_SOURCES].join(', ')}`);
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw badRequest('results must be a non-empty array');
  }
  if (results.length > MAX_RESULTS) {
    throw badRequest(`at most ${MAX_RESULTS} results per import`);
  }
  const records = results.map((r, i) => toLabRecord(r, i, source));

  // Compare against what's already on file for these tests.
  const existing = new Map();
  for (const analyte of new Set(records.map((r) => r.analyte))) {
    for (const lab of await repo(req).listLabs({ analyte })) {
      const id = lab.provenance?.externalId;
      if (id) existing.set(id, lab);
    }
  }

  const toWrite = new Map(); // externalId → record (last one in the batch wins)
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const rec of records) {
    const id = rec.provenance.externalId;
    const prior = existing.get(id) || toWrite.get(id);
    if (!prior) {
      added += 1;
      toWrite.set(id, rec);
      continue;
    }
    // A date-only row (from a Trends printout) never overwrites a draw that
    // already has its exact collection time.
    const priorTimed = prior.provenance && prior.provenance.dateOnly === false;
    if (rec.provenance.dateOnly && priorTimed) {
      unchanged += 1;
      continue;
    }
    const same =
      prior.value === rec.value &&
      (prior.refLow ?? null) === rec.refLow &&
      (prior.refHigh ?? null) === rec.refHigh &&
      new Date(prior.collectedAt).getTime() === rec.collectedAt.getTime();
    if (same) {
      unchanged += 1;
      continue;
    }
    if (existing.has(id) && !toWrite.has(id)) updated += 1;
    toWrite.set(id, rec);
  }

  if (toWrite.size) await repo(req).upsertLabResults([...toWrite.values()]);
  res.status(201).json({ data: { added, updated, unchanged } });
});
