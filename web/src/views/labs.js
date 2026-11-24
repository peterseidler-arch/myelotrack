import { el, clear } from '../lib/dom.js';
import { store } from '../state/store.js';
import { fmtDate, formatVal } from '../lib/format.js';
import { lineChart } from '../lib/charts.js';
import { SOURCES } from '../data/sources.js';
import { labFlag, flagWord } from '../data/labs.js';
import { ANALYTES, refText } from '../data/analytes.js';
import { USE_API } from '../config.js';
import { openLabImportSheet } from '../ui/lab-import.js';

const importButton = () =>
  el(
    'button',
    { class: 'btn secondary', style: 'margin-bottom:14px', onclick: openLabImportSheet },
    'Import from MyChart',
  );

// UI-only selection state (which analyte is shown); persists across re-renders.
let activeAnalyte = 'hemoglobin';

/** Render the Labs tab: cross-care-team CBC trends with source provenance. */
export function renderLabs(container) {
  const { labs } = store.state;
  clear(container);

  // Catalog order (counts, kidney, liver, turnover); unknown analytes last.
  const order = Object.keys(ANALYTES);
  const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
  const analyteKeys = Object.keys(labs).sort((a, b) => rank(a) - rank(b));
  if (analyteKeys.length === 0) {
    container.append(
      el(
        'div',
        { class: 'empty' },
        'No lab results yet — import MyChart PDFs or connect a care team.',
      ),
      importButton(),
    );
    return;
  }
  if (!labs[activeAnalyte]) activeAnalyte = analyteKeys[0];

  container.append(importButton());

  // --- Analyte chips ---
  const tabs = el('div', { class: 'lab-tabs' });
  for (const key of analyteKeys) {
    tabs.append(
      el(
        'button',
        {
          class: 'chip' + (key === activeAnalyte ? ' active' : ''),
          onclick: () => {
            activeAnalyte = key;
            renderLabs(container);
          },
        },
        labs[key].label,
      ),
    );
  }
  container.append(tabs);

  const analyte = labs[activeAnalyte];
  const last = analyte.series[analyte.series.length - 1];
  const flag = labFlag(labs, activeAnalyte, last.value, last);

  // --- Headline value + chart ---
  const card = el('div', { class: 'card' });
  card.append(
    el('div', { class: 'chart-val' }, [
      el('span', { class: 'big' }, formatVal(last.value)),
      el('span', { class: 'unit' }, analyte.unit),
      el('span', { class: 'rng' }, [
        el('div', { class: 'flag-' + flag, style: 'font-weight:700' }, flagWord(flag)),
        el(
          'div',
          {},
          activeAnalyte === 'blasts'
            ? 'ref 0%'
            : refText(analyte.refLow, analyte.refHigh),
        ),
      ]),
    ]),
  );
  card.append(
    el(
      'div',
      { style: 'font-size:13px;color:var(--label-2);margin-bottom:12px' },
      `${fmtDate(last.collectedAt, { month: 'short', day: 'numeric' })} · ${SOURCES[last.source].name}`,
    ),
  );
  card.append(lineChart(analyte, activeAnalyte));

  // Source legend for this analyte.
  const seenSources = [...new Set(analyte.series.map((p) => p.source))];
  const legend = el('div', { class: 'legend' });
  for (const source of seenSources) {
    legend.append(
      el('div', { class: 'k' }, [
        el('span', { class: 'sw', style: `background:${SOURCES[source].color}` }),
        SOURCES[source].name,
      ]),
    );
  }
  card.append(legend);
  container.append(card);

  // --- Cross-team callout ---
  const note = el('div', {
    class: 'card',
    style: 'background:rgba(10,132,255,0.08);border-color:rgba(10,132,255,0.25)',
  });
  note.innerHTML = `<div style="font-size:14px;line-height:1.45"><b>Aggregated across care teams.</b>
    This trend merges draws from MSK and Capital Health into one timeline — each point keeps its
    source. Neither portal shows the other's results on its own.</div>`;
  container.append(note);

  // --- All results (newest first) ---
  container.append(el('div', { class: 'section-title' }, 'All results'));
  const list = el('div', { class: 'card tight' });
  for (const point of [...analyte.series].reverse()) {
    const pointFlag = labFlag(labs, activeAnalyte, point.value, point);
    list.append(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title' }, `${formatVal(point.value)} ${analyte.unit}`),
          el(
            'div',
            { class: 'sub' },
            fmtDate(point.collectedAt, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }),
          ),
        ]),
        el('span', { class: 'pill src-' + point.source }, [
          el('span', {
            class: 'dot',
            style: `background:${SOURCES[point.source].color}`,
          }),
          SOURCES[point.source].name.split(' ')[0],
        ]),
        el(
          'span',
          {
            class: 'flag-' + pointFlag,
            style: 'font-size:13px;font-weight:600;min-width:56px;text-align:right',
          },
          flagWord(pointFlag),
        ),
      ]),
    );
  }
  container.append(list);
  container.append(
    el(
      'p',
      { class: 'disclaimer' },
      'Reference ranges are lab-provided and vary by institution; each result is flagged against its own lab’s range.' +
        (USE_API
          ? ''
          : ' Offline mode: values are sample data, and imports last until you refresh.'),
    ),
  );
}
