import { asyncHandler, badRequest } from '../lib/async-handler.js';

// The patient-scoped repository, bound by requireAuth (see middleware/auth.js).
const repo = (req) => req.repo;
const VALID_STATUS = ['taken', 'skipped', 'missed', 'late'];

/** GET /api/v1/medications */
export const list = asyncHandler(async (req, res) => {
  const meds = await repo(req).listMedications();
  res.json({ data: meds });
});

/** POST /api/v1/medications/:id/doses — log a dose event. */
export const logDose = asyncHandler(async (req, res) => {
  const { status = 'taken', scheduledFor, takenAt, note } = req.body || {};
  if (!VALID_STATUS.includes(status)) {
    throw badRequest(`status must be one of: ${VALID_STATUS.join(', ')}`);
  }
  const dose = await repo(req).logDose(req.params.id, {
    status,
    scheduledFor,
    takenAt,
    note,
  });
  if (!dose) throw badRequest(`unknown medication: ${req.params.id}`);
  res.status(201).json({ data: dose });
});

// ------------------------------------------------- patient-entered regimen

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIMITS = { name: 120, brand: 80, dose: 60, purpose: 120, instructions: 240 };

/** Trimmed, length-capped string; '' when absent. */
function text(v, max) {
  if (v == null) return '';
  if (typeof v !== 'string') throw badRequest('expected text');
  return v.trim().slice(0, max);
}

/** Validate a schedule: up to 8 HH:MM times, an as-needed flag, free-text instructions. */
function cleanSchedule(s = {}) {
  if (typeof s !== 'object' || s === null) throw badRequest('schedule must be an object');
  const times = Array.isArray(s.times) ? [...new Set(s.times.map(String))] : [];
  if (times.length > 8) throw badRequest('at most 8 times a day');
  for (const t of times) if (!TIME.test(t)) throw badRequest(`time must be HH:MM: ${t}`);
  return {
    times: times.sort(),
    asNeeded: Boolean(s.asNeeded),
    instructions: text(s.instructions, LIMITS.instructions),
  };
}

/** Clinical-trial marker: null, or { name, cycleDays } (cycle length 1–365 days). */
function cleanTrial(t) {
  if (!t) return null;
  if (typeof t !== 'object') throw badRequest('trial must be an object');
  const days = t.cycleDays == null || t.cycleDays === '' ? null : Number(t.cycleDays);
  if (days != null && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
    throw badRequest('trial cycle length must be 1–365 days');
  }
  return { name: text(t.name, 120) || 'Clinical trial', cycleDays: days };
}

/**
 * Pick the editable fields from a request body. With `partial`, absent fields
 * are left out (PATCH); otherwise a name is required (create).
 */
function cleanMedication(body = {}, { partial = false } = {}) {
  const out = {};
  for (const key of ['name', 'brand', 'dose', 'purpose']) {
    if (partial && !(key in body)) continue;
    out[key] = text(body[key], LIMITS[key]);
  }
  if (!partial || 'schedule' in body) out.schedule = cleanSchedule(body.schedule);
  if (!partial || 'prescriber' in body) {
    const name = text(body.prescriber?.name ?? body.prescriber, 80);
    out.prescriber = name ? { name } : null;
  }
  if (!partial || 'trial' in body) out.trial = cleanTrial(body.trial);
  if ('name' in out && !out.name) throw badRequest('name is required');
  return out;
}

/** POST /api/v1/medications — add one medication to the regimen. */
export const create = asyncHandler(async (req, res) => {
  const med = await repo(req).createMedication({
    ...cleanMedication(req.body),
    source: 'self',
    provenance: { system: 'manual' },
    startedAt: new Date(),
  });
  res.status(201).json({ data: med });
});

/**
 * PATCH /api/v1/medications/:id — edit fields, or stop it with
 * `{ active: false }` (dose history is kept).
 */
export const update = asyncHandler(async (req, res) => {
  const patch = cleanMedication(req.body, { partial: true });
  if ('active' in (req.body || {})) {
    patch.active = Boolean(req.body.active);
    patch.stoppedAt = patch.active ? null : new Date();
  }
  const med = await repo(req).updateMedication(req.params.id, patch);
  if (!med) throw badRequest(`unknown medication: ${req.params.id}`);
  res.json({ data: med });
});

/** Stable key for a list entry, so re-importing the same list updates in place. */
const listKey = (name) =>
  `list:${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;

/**
 * POST /api/v1/medications/import — save a medication list read on the
 * device (e.g. a printed or PDF med list). Entries are matched to earlier
 * imports by name, so re-importing updates instead of duplicating. With
 * `replace: true`, medications from an earlier list that are missing from this
 * one are marked stopped. Hand-added medications are never touched.
 */
export const importList = asyncHandler(async (req, res) => {
  const { medications, replace = false } = req.body || {};
  if (!Array.isArray(medications) || !medications.length) {
    throw badRequest('medications must be a non-empty array');
  }
  if (medications.length > 100) throw badRequest('at most 100 medications per import');

  const cleaned = medications.map((m) => cleanMedication(m));
  const keys = new Set();
  const incoming = [];
  for (const m of cleaned) {
    const externalId = listKey(m.name);
    if (keys.has(externalId)) continue; // first occurrence wins
    keys.add(externalId);
    incoming.push({
      ...m,
      active: true,
      stoppedAt: null,
      source: 'self',
      provenance: { system: 'medication-list', externalId },
    });
  }

  const current = await repo(req).listMedications();
  const fromList = current.filter((m) => m.provenance?.system === 'medication-list');
  const existing = new Set(fromList.map((m) => m.provenance.externalId));
  const added = incoming.filter((m) => !existing.has(m.provenance.externalId)).length;

  await repo(req).upsertMedications(incoming);

  let stopped = 0;
  if (replace) {
    for (const m of fromList) {
      if (keys.has(m.provenance.externalId)) continue;
      await repo(req).updateMedication(m._id, { active: false, stoppedAt: new Date() });
      stopped++;
    }
  }
  res.status(201).json({
    data: { added, updated: incoming.length - added, stopped },
  });
});
