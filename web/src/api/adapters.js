import { pallorSwatch } from '../lib/pallor-image.js';
import { API_BASE } from '../config.js';
import { ANALYTES, analyteLabel } from '../data/analytes.js';

/**
 * Map API response shapes onto the client store's shapes. The API returns
 * normalized, schema-flat records; the views want a few view-friendly shapes
 * (labs grouped by analyte, meds with `id`/`times`, pallor with a display
 * image). Keeping the translation here means the views never learn the wire
 * format.
 */

/**
 * Group a flat array of lab results into the `{ analyte: {…, series} }` shape.
 * Each draw keeps its own lab-provided range; the analyte's headline range is
 * the most recent draw's (falling back to the catalog default).
 */
export function labsToStore(apiLabs) {
  const byAnalyte = {};
  for (const row of apiLabs) {
    const meta = ANALYTES[row.analyte] || {};
    const group = (byAnalyte[row.analyte] ||= {
      label: analyteLabel(row.analyte),
      unit: row.unit || meta.unit || '',
      refLow: meta.refLow ?? null,
      refHigh: meta.refHigh ?? null,
      loinc: row.loinc || meta.loinc,
      series: [],
    });
    group.series.push({
      collectedAt: new Date(row.collectedAt),
      value: row.value,
      source: row.source,
      refLow: row.refLow ?? null,
      refHigh: row.refHigh ?? null,
    });
  }
  for (const group of Object.values(byAnalyte)) {
    group.series.sort((a, b) => a.collectedAt - b.collectedAt);
    const last = group.series[group.series.length - 1];
    if (last.refLow != null || last.refHigh != null) {
      group.refLow = last.refLow;
      group.refHigh = last.refHigh;
    }
  }
  return byAnalyte;
}

/** Map API medications to the store shape (`_id` → `id`, flatten schedule). */
export function medsToStore(apiMeds) {
  return apiMeds.map((m) => ({
    id: m._id,
    name: m.name,
    brand: m.brand || '',
    dose: m.dose || '',
    purpose: m.purpose || '',
    times: m.schedule?.times || [],
    asNeeded: Boolean(m.schedule?.asNeeded),
    instructions: m.schedule?.instructions || '',
    prescriber: m.prescriber?.name || '',
    trial: m.trial || null,
  }));
}

/**
 * Map API pallor readings to the store shape. Readings with a stored image use
 * the decrypted-image endpoint; metadata-only ones fall back to a synthesized
 * swatch so the gallery still renders.
 */
export function pallorToStore(apiPallor) {
  return apiPallor.map((p) => ({
    id: p._id,
    capturedAt: new Date(p.capturedAt),
    eye: p.eye || 'right',
    pallorScore: p.pallorScore,
    img: p.storage?.key
      ? `${API_BASE}/api/v1/pallor/${p._id}/image`
      : pallorSwatch(p.pallorScore ?? 0.42),
  }));
}

/** Recent daily totals (oldest→newest) for the Today trend delta. */
export function symptomHistoryToStore(apiSymptoms) {
  return [...apiSymptoms]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((e) => e.total ?? 0);
}
