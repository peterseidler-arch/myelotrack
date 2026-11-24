import { el, clear } from '../lib/dom.js';
import { store } from '../state/store.js';
import { prettyTime } from '../lib/format.js';
import { makeDoseCheck } from '../ui/dose-check.js';
import { todaysDoses, todaysAdherence } from '../data/meds.js';
import { openMedSheet } from '../ui/med-edit.js';
import { openMedImportSheet } from '../ui/med-import.js';

/** One line describing when a medication is taken. */
function whenText(med) {
  const parts = [];
  if (med.times.length) {
    parts.push(`${med.times.length}×/day · ${med.times.map(prettyTime).join(', ')}`);
  }
  if (med.asNeeded) parts.push('as needed');
  if (!parts.length) parts.push(med.instructions || 'No set times');
  return parts.join(' · ');
}

/** Render the Meds tab: today's progress, scheduled doses, and full regimen. */
export function renderMeds(container) {
  const { state } = store;
  clear(container);

  const today = todaysAdherence(state);
  const rollingPct = Math.round(state.adherence30 * 100);
  const todayPct = today.total ? Math.round((today.taken / today.total) * 100) : 0;

  // --- Today progress ---
  const progress = el('div', { class: 'card' });
  progress.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
      <div style="font-size:15px;font-weight:600">Today</div>
      <div style="font-family:'Inter Tight';font-weight:800;font-size:20px">${today.taken}/${today.total}</div>
    </div>
    <div class="adherence-bar"><span style="width:${todayPct}%"></span></div>
    <div style="font-size:13px;color:var(--label-2);margin-top:10px">30-day adherence ·
      <b style="color:var(--green)">${rollingPct}%</b></div>`;
  container.append(progress);

  // --- Today's doses grouped by time ---
  container.append(el('div', { class: 'section-title' }, "Today's doses"));
  const byTime = {};
  for (const dose of todaysDoses(state)) {
    (byTime[dose.time] = byTime[dose.time] || []).push(dose);
  }
  for (const time of Object.keys(byTime).sort()) {
    container.append(
      el(
        'div',
        {
          style:
            'font-size:13px;color:var(--label-3);margin:14px 4px 6px;font-weight:600',
        },
        prettyTime(time),
      ),
    );
    const card = el('div', { class: 'card tight' });
    for (const dose of byTime[time]) {
      card.append(
        el('div', { class: 'row' }, [
          makeDoseCheck(dose),
          el('div', { class: 'grow' }, [
            el(
              'div',
              { class: 'title' },
              `${dose.med.name}${dose.med.brand ? ` · ${dose.med.brand}` : ''}`,
            ),
            el('div', { class: 'sub' }, `${dose.med.dose} — ${dose.med.purpose}`),
          ]),
        ]),
      );
    }
    container.append(card);
  }

  // --- Full regimen: tap a medication to edit or stop it ---
  container.append(el('div', { class: 'section-title' }, 'Regimen'));
  container.append(
    el('div', { class: 'med-actions' }, [
      el('button', { class: 'btn secondary', onclick: () => openMedSheet() }, '+ Add'),
      el(
        'button',
        { class: 'btn secondary', onclick: openMedImportSheet },
        'Import list (PDF)',
      ),
    ]),
  );
  if (!state.medications.length) {
    container.append(
      el(
        'div',
        { class: 'empty' },
        'No medications yet. Add them one at a time, or import a PDF of your medication list.',
      ),
    );
    return;
  }
  const regimen = el('div', { class: 'card tight' });
  for (const med of state.medications) {
    regimen.append(
      el(
        'button',
        {
          class: 'row row-button',
          type: 'button',
          onclick: () => openMedSheet(med),
          'aria-label': `Edit ${med.name}`,
        },
        [
          el('div', { class: 'grow' }, [
            el(
              'div',
              { class: 'title' },
              `${med.name}${med.brand ? ` · ${med.brand}` : ''} ${med.dose}`,
            ),
            el('div', { class: 'sub' }, whenText(med)),
            med.prescriber || med.purpose
              ? el(
                  'div',
                  { class: 'sub' },
                  [med.purpose, med.prescriber].filter(Boolean).join(' · '),
                )
              : null,
          ]),
          el('span', { class: 'chevron' }, '›'),
        ],
      ),
    );
  }
  container.append(regimen);
}
