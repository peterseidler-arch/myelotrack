import {
  localDay,
  slotIso,
  addDays,
  cycleDayFor,
  strengthMg,
  tabletsPerDose,
} from '../dose-slots.js';

/**
 * Assemble a visit report from raw API data for [periodStart, periodEnd].
 * Pure: no network, no DOM, so it is unit-tested and the PDF and on-screen
 * preview render the same model.
 *
 * @param {object} input
 * @param {Date} input.periodStart
 * @param {Date} input.periodEnd
 * @param {object[]} input.meds - API medications incl. stopped (history)
 * @param {object[]} input.doses - API dose records in the period
 * @param {object[]} input.labs - API lab results
 * @param {object[]} input.symptoms - API symptom entries
 * @param {(key: string) => string} [input.labLabel]
 * @param {boolean} [input.firstReport]
 */
export function buildReport({
  periodStart,
  periodEnd,
  meds,
  doses,
  labs,
  symptoms,
  labLabel = (k) => k,
  // On the first report every medication is "new" to the app, so starts
  // aren't listed as changes; only later reports show them.
  firstReport = false,
}) {
  const inPeriod = (d) => {
    const t = new Date(d).getTime();
    return t >= periodStart.getTime() && t <= periodEnd.getTime();
  };
  const firstDay = localDay(periodStart);
  const lastDay = localDay(periodEnd);
  const days = [];
  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) days.push(d);

  const active = meds.filter((m) => m.active !== false);
  const doseKey = (medId, iso) => `${medId}|${new Date(iso).getTime()}`;
  const doseByKey = new Map(
    doses.map((d) => [doseKey(d.medicationId, d.scheduledFor), d]),
  );

  // ---- Clinical trials: per trial, per day, per scheduled dose.
  const trialNames = [...new Set(active.filter((m) => m.trial).map((m) => m.trial.name))];
  const trials = trialNames.map((name) => {
    const tmeds = active.filter((m) => m.trial?.name === name);
    const cycleDays = tmeds.find((m) => m.trial.cycleDays)?.trial.cycleDays || null;
    const cycles =
      [...tmeds].sort(
        (a, b) => (b.trial.cycles?.length || 0) - (a.trial.cycles?.length || 0),
      )[0]?.trial.cycles || [];
    const times = [...new Set(tmeds.flatMap((m) => m.schedule?.times || []))].sort();
    const now = Date.now();

    const drugs = tmeds.map((m) => {
      const per = strengthMg(m.dose);
      const tabs = tabletsPerDose(m.schedule?.instructions);
      return {
        id: m._id,
        name: m.name,
        dose: m.dose,
        perDoseMg: per == null ? null : +(per * tabs).toFixed(3),
        dosesPerDay: (m.schedule?.times || []).length,
        scheduled: 0,
        taken: 0,
        missed: 0,
        unlogged: 0,
        mgTaken: 0,
        missedList: [],
      };
    });
    const drugById = new Map(drugs.map((d) => [d.id, d]));

    const diaryDays = [];
    for (const day of days) {
      const where = cycleDayFor(cycles, cycleDays, day);
      const slots = [];
      for (const time of times) {
        const iso = slotIso(day, time);
        // Only doses due by now, and within the period.
        if (new Date(iso).getTime() > now || !inPeriod(iso)) continue;
        const entries = [];
        for (const m of tmeds.filter((x) => (x.schedule?.times || []).includes(time))) {
          const rec = doseByKey.get(doseKey(m._id, iso));
          const drug = drugById.get(m._id);
          drug.scheduled++;
          const status = !rec
            ? 'unlogged'
            : rec.status === 'taken' || rec.status === 'late'
              ? 'taken'
              : 'missed';
          if (status === 'taken') {
            drug.taken++;
            if (rec.amount?.mg != null) drug.mgTaken += rec.amount.mg;
          } else if (status === 'missed') {
            drug.missed++;
            drug.missedList.push({ day, time });
          } else {
            drug.unlogged++;
          }
          entries.push({
            med: m.name,
            status,
            takenAt: rec?.takenAt || null,
            tablets: rec?.amount?.tablets ?? null,
            mg: rec?.amount?.mg ?? null,
            note: rec?.note || '',
          });
        }
        if (entries.length) slots.push({ time, entries });
      }
      if (slots.length) {
        diaryDays.push({
          day,
          cycle: where?.cycle ?? null,
          cycleDay: where?.day ?? null,
          slots,
        });
      }
    }
    for (const d of drugs) d.mgTaken = +d.mgTaken.toFixed(3);
    return { name, cycleDays, cycles, times, drugs, days: diaryDays };
  });

  // ---- Symptoms and weight.
  const sx = symptoms
    .filter((s) => inPeriod(s.date))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const totals = sx.map((s) => s.total).filter((n) => Number.isFinite(n));
  const weights = sx.filter((s) => Number.isFinite(s.weightKg));
  const symptomSummary = sx.length
    ? {
        entries: sx.length,
        first: totals[0] ?? null,
        last: totals[totals.length - 1] ?? null,
        average: totals.length
          ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)
          : null,
        highest: totals.length ? Math.max(...totals) : null,
        latestItems: sx[sx.length - 1].items || {},
        weightFirstKg: weights[0]?.weightKg ?? null,
        weightLastKg: weights[weights.length - 1]?.weightKg ?? null,
        notes: sx
          .filter((s) => s.note && s.note.trim())
          .map((s) => ({ day: localDay(new Date(s.date)), note: s.note.trim() })),
      }
    : null;

  // ---- Labs collected in the period, newest first.
  const labRows = labs
    .filter((l) => l.collectedAt && inPeriod(l.collectedAt))
    .sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt))
    .map((l) => ({
      day: localDay(new Date(l.collectedAt)),
      test: labLabel(l.analyte),
      value: `${l.qualifier || ''}${l.value} ${l.unit || ''}`.trim(),
      range:
        l.refLow != null && l.refHigh != null
          ? `${l.refLow}–${l.refHigh}`
          : l.refLow != null
            ? `${l.refLow} or above`
            : l.refHigh != null
              ? `${l.refHigh} or below`
              : '',
      flag: l.flag && l.flag !== 'normal' ? l.flag : '',
      source: l.source || '',
    }));

  // ---- Medication changes and the current list.
  const changes = [];
  for (const m of meds) {
    if (!firstReport && m.createdAt && inPeriod(m.createdAt) && m.provenance?.system) {
      changes.push({
        day: localDay(new Date(m.createdAt)),
        what: 'Started',
        med: m.name,
        dose: m.dose,
      });
    }
    if (m.active === false && m.stoppedAt && inPeriod(m.stoppedAt)) {
      changes.push({
        day: localDay(new Date(m.stoppedAt)),
        what: 'Stopped',
        med: m.name,
        dose: m.dose,
      });
    }
  }
  changes.sort((a, b) => a.day.localeCompare(b.day));
  const current = active.map((m) => ({
    name: m.brand ? `${m.name} (${m.brand})` : m.name,
    dose: m.dose,
    how: [
      m.schedule?.instructions,
      !m.schedule?.instructions && m.schedule?.times?.length
        ? `${m.schedule.times.length}×/day`
        : '',
      m.schedule?.asNeeded && !/as needed/i.test(m.schedule?.instructions || '')
        ? 'as needed'
        : '',
    ]
      .filter(Boolean)
      .join('; '),
    prescriber: m.prescriber?.name || '',
    trial: m.trial?.name || '',
  }));

  return {
    periodStart,
    periodEnd,
    trials,
    symptoms: symptomSummary,
    labs: labRows,
    changes,
    current,
  };
}

/** A small digest of a report, stored with the "sent" record. */
export function reportDigest(report) {
  return {
    trials: report.trials.map((t) => ({
      name: t.name,
      drugs: t.drugs.map((d) => ({
        name: d.name,
        scheduled: d.scheduled,
        taken: d.taken,
        missed: d.missed,
        unlogged: d.unlogged,
      })),
    })),
    labs: report.labs.length,
    symptomEntries: report.symptoms?.entries || 0,
    changes: report.changes.length,
  };
}
