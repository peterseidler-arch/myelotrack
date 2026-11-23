import { el } from '../lib/dom.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';
import { labsToStore } from '../api/adapters.js';
import { USE_API } from '../config.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';
import { fmtDate } from '../lib/format.js';
import { ANALYTES, analyteLabel, rangeFlag } from '../data/analytes.js';
import { SOURCES } from '../data/sources.js';
import { flagWord } from '../data/labs.js';
import { mergeResults, dayKey } from '../lib/mychart/parse.js';

const SOURCE_CHOICES = ['msk', 'capital-health'];

/**
 * Open the "Import from MyChart" sheet: pick MyChart PDF printouts, review
 * what was read, choose the care team, then save. PDFs are parsed on this
 * device; only the numbers are sent to the server.
 */
export function openLabImportSheet() {
  openSheet((sheet) => {
    sheet.append(
      el('h2', {}, 'Import from MyChart'),
      el(
        'p',
        { class: 'lede' },
        'Choose “Test Details” or “Result Trends” PDFs saved from MyChart. They’re read on this device — only the numbers are saved.',
      ),
    );

    const input = el('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      multiple: '',
      style: 'display:none',
    });
    const pick = el(
      'button',
      { class: 'btn', onclick: () => input.click() },
      'Choose PDFs',
    );
    const review = el('div');
    sheet.append(input, pick, review);

    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length) return;
      pick.disabled = true;
      pick.textContent = `Reading ${files.length} PDF${files.length > 1 ? 's' : ''}…`;
      try {
        const { readMyChartFile } = await import('../lib/mychart/read-file.js');
        const parsed = [];
        for (const f of files) {
          try {
            parsed.push(await readMyChartFile(f));
          } catch {
            parsed.push({ file: f.name, kind: 'error', results: [], skipped: [] });
          }
        }
        renderReview(review, parsed);
      } finally {
        pick.disabled = false;
        pick.className = 'btn secondary';
        pick.textContent = 'Choose different PDFs';
        input.value = '';
      }
    });
  });
}

/** Show what was read, the care-team choice, and the save button. */
function renderReview(container, parsed) {
  container.replaceChildren();
  const results = mergeResults(parsed.map((p) => p.results));
  const detected = parsed.map((p) => p.source).find(Boolean);
  let source = SOURCE_CHOICES.includes(detected) ? detected : 'msk';

  // Per-file summary.
  const files = el('div', { class: 'card tight', style: 'margin-top:16px' });
  for (const p of parsed) {
    const status =
      p.kind === 'error'
        ? 'Couldn’t read this PDF'
        : p.kind === 'unknown'
          ? 'Not a MyChart test printout'
          : `${p.results.length} tracked result${p.results.length === 1 ? '' : 's'}`;
    files.append(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title' }, p.title || p.file),
          el('div', { class: 'sub' }, status),
        ]),
      ]),
    );
  }
  container.append(files);

  if (!results.length) {
    container.append(
      el(
        'p',
        { class: 'disclaimer' },
        `Nothing to import. MyeloTrack tracks: ${Object.keys(ANALYTES).map(analyteLabel).join(', ')}.`,
      ),
    );
    return;
  }

  // Care team the draws came from (Trends printouts don't name the lab).
  container.append(el('div', { class: 'section-title' }, 'Care team'));
  const seg = el('div', { class: 'seg' });
  for (const key of SOURCE_CHOICES) {
    seg.append(
      el(
        'button',
        {
          class: 'seg-btn' + (key === source ? ' active' : ''),
          onclick: (e) => {
            source = key;
            seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
          },
        },
        SOURCES[key].name,
      ),
    );
  }
  container.append(seg);

  // Results, newest first, grouped by day.
  container.append(el('div', { class: 'section-title' }, `${results.length} results`));
  const list = el('div', { class: 'card tight' });
  let lastDay = '';
  for (const r of results) {
    const day = dayKey(r.collectedAt);
    if (day !== lastDay) {
      lastDay = day;
      list.append(
        el(
          'div',
          { class: 'sub', style: 'padding:10px 0 2px;font-weight:600' },
          fmtDate(r.collectedAt, { month: 'short', day: 'numeric', year: 'numeric' }),
        ),
      );
    }
    const flag = rangeFlag(r.value, r.refLow, r.refHigh);
    list.append(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title' }, analyteLabel(r.analyte)),
        ]),
        el('div', {}, `${r.qualifier || ''}${r.value} ${r.unit}`),
        el(
          'span',
          {
            class: 'flag-' + flag,
            style: 'font-size:13px;font-weight:600;min-width:56px;text-align:right',
          },
          flagWord(flag),
        ),
      ]),
    );
  }
  container.append(list);

  const skipped = parsed.flatMap((p) => p.skipped);
  if (skipped.length) {
    container.append(
      el(
        'p',
        { class: 'disclaimer' },
        `${skipped.length} other component${skipped.length === 1 ? '' : 's'} not tracked, skipped.`,
      ),
    );
  }

  const save = el(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        save.disabled = true;
        try {
          await saveResults(results, source);
          closeSheet();
        } catch {
          toast('Import failed — nothing was saved');
          save.disabled = false;
        }
      },
    },
    `Save ${results.length} results`,
  );
  container.append(save);
}

/** Persist via the API (or, offline, into this session's store). */
async function saveResults(results, source) {
  if (USE_API) {
    const payload = results.map((r) => ({
      analyte: r.analyte,
      value: r.value,
      refLow: r.refLow,
      refHigh: r.refHigh,
      collectedAt: r.collectedAt.toISOString(),
      day: dayKey(r.collectedAt),
      dateOnly: r.dateOnly,
      ...(r.qualifier ? { qualifier: r.qualifier } : {}),
    }));
    const { added, updated, unchanged } = await api.importLabs({
      source,
      results: payload,
    });
    const labs = labsToStore(await api.getLabs());
    store.commit((s) => {
      s.labs = labs;
    });
    const parts = [`${added} added`];
    if (updated) parts.push(`${updated} updated`);
    if (unchanged) parts.push(`${unchanged} already saved`);
    toast(parts.join(' · '));
    return;
  }

  // Offline mode: merge into the in-memory labs (gone on refresh).
  store.commit((s) => {
    for (const r of results) {
      const meta = ANALYTES[r.analyte];
      const group = (s.labs[r.analyte] ||= {
        label: meta.label,
        unit: meta.unit,
        refLow: meta.refLow,
        refHigh: meta.refHigh,
        loinc: meta.loinc,
        series: [],
      });
      const day = dayKey(r.collectedAt);
      group.series = group.series.filter(
        (p) => !(p.source === source && dayKey(p.collectedAt) === day),
      );
      group.series.push({
        collectedAt: r.collectedAt,
        value: r.value,
        source,
        refLow: r.refLow,
        refHigh: r.refHigh,
      });
      group.series.sort((a, b) => a.collectedAt - b.collectedAt);
      const last = group.series[group.series.length - 1];
      if (last.refLow != null || last.refHigh != null) {
        group.refLow = last.refLow;
        group.refHigh = last.refHigh;
      }
    }
  });
  toast(`${results.length} results added for this session (offline mode)`);
}
