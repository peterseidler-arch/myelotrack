import { asyncHandler, badRequest } from '../lib/async-handler.js';

// The patient-scoped repository, bound by requireAuth (see middleware/auth.js).
const repo = (req) => req.repo;

/** GET /api/v1/reports — visit reports already sent, newest first. */
export const list = asyncHandler(async (req, res) => {
  res.json({ data: await repo(req).listReports() });
});

/**
 * POST /api/v1/reports — record that the patient approved and sent a visit
 * report covering [periodStart, periodEnd]. The next report starts where this
 * one ended. `summary` is a small digest (counts), not the document itself.
 */
export const create = asyncHandler(async (req, res) => {
  const { periodStart, periodEnd, recipients = [], summary = null } = req.body || {};
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (isNaN(start) || isNaN(end) || start > end) {
    throw badRequest('periodStart and periodEnd must be dates, start before end');
  }
  if (!Array.isArray(recipients) || recipients.length > 10) {
    throw badRequest('recipients must be a list of up to 10');
  }
  const cleanRecipients = recipients.map((r) => ({
    name: String(r?.name ?? '')
      .trim()
      .slice(0, 80),
    email: String(r?.email ?? '')
      .trim()
      .slice(0, 254),
  }));
  if (summary != null && JSON.stringify(summary).length > 4000) {
    throw badRequest('summary is too large');
  }
  const report = await repo(req).createReport({
    periodStart: new Date(start),
    periodEnd: new Date(end),
    recipients: cleanRecipients,
    summary,
  });
  res.status(201).json({ data: report });
});
