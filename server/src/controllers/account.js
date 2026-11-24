import { asyncHandler } from '../lib/async-handler.js';
import { clearSessionCookie } from '../middleware/auth.js';

// The patient-scoped repository, bound by requireAuth (see middleware/auth.js).
const repo = (req) => req.repo;

// Bump when the export shape changes, so downstream readers can adapt.
const EXPORT_SCHEMA_VERSION = 1;

/**
 * GET /api/v1/account/export — download the patient's full record.
 *
 * Deliberately NOT wrapped in the usual `{ data }` envelope: this is a
 * self-contained document meant to be saved to disk, so the file is clean,
 * portable JSON. Served with Content-Disposition so a browser downloads it.
 */
export const exportData = asyncHandler(async (req, res) => {
  const records = await repo(req).exportData();
  const filename = `myelotrack-export-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    app: 'MyeloTrack',
    records,
  });
});

/** Best-effort purge of every encrypted pallor blob before its record goes. */
async function purgePallorBlobs(req) {
  const storage = req.app.locals.storage;
  if (!storage?.delete) return;
  const photos = await repo(req).listPallor();
  for (const p of photos) {
    if (!p.storage?.key) continue;
    try {
      await storage.delete(p.storage.key);
    } catch (err) {
      // Log the failure without the key: keys embed the user id.
      console.error('[account] pallor blob purge failed:', err?.code || err?.message);
    }
  }
}

/**
 * DELETE /api/v1/account/data — erase all of the patient's health data but
 * keep the account. Purges encrypted pallor blobs, drops every PHI record and
 * keeps the passkey, so the patient can sign back into a now-empty app.
 */
export const deleteData = asyncHandler(async (req, res) => {
  await purgePallorBlobs(req);
  const deleted = await repo(req).deleteAllData();
  res.json({ data: { deleted } });
});

/**
 * DELETE /api/v1/account — close the account entirely (App Store guideline
 * 5.1.1(v)). Purges pallor blobs, erases all PHI, removes the user and every
 * passkey, and ends the session; the old session token stops working because
 * requireAuth rejects sessions for users that no longer exist. The audit log
 * keeps its entries (append-only), which hold no health data.
 */
export const deleteAccount = asyncHandler(async (req, res) => {
  await purgePallorBlobs(req);
  const deleted = await repo(req).deleteAllData();
  await req.app.locals.repo.deleteUser(req.authUserId);
  clearSessionCookie(res);
  res.json({ data: { deleted, accountDeleted: true } });
});
