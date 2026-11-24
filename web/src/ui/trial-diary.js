import { el } from '../lib/dom.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';
import { USE_API } from '../config.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { prettyTime, fmtDate } from '../lib/format.js';
import { refreshMeds } from './med-edit.js';
import {
  localDay,
  slotIso,
  dayBounds,
  addDays,
  cycleDayFor,
  strengthMg,
  tabletsPerDose,
} from '../lib/dose-slots.js';

/** The trial's medications and its cycle settings (shared by all of them). */
export function trialInfo(trialName, meds = store.state.medications) {
  const list = meds.filter(
    (m) => m.trial && (m.trial.name || 'Clinical trial') === trialName,
  );
  const withCycles = [...list].sort(
    (a, b) => (b.trial.cycles?.length || 0) - (a.trial.cycles?.length || 0),
  )[0];
  return {
    meds: list,
    cycleDays: list.find((m) => m.trial.cycleDays)?.trial.cycleDays || null,
    cycles: withCycles?.trial.cycles || [],
  };
}

/** Save the cycle list onto every medication in the trial. */
async function saveCycles(trialName, cycles) {
  const { meds } = trialInfo(trialName);
  for (const m of meds) {
    await api.updateMedication(m.id, { trial: { ...m.trial, cycles } });
  }
  await refreshMeds();
}

const dateLabel = (day) =>
  fmtDate(new Date(`${day}T12:00:00`), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/**
 * The trial diary: for each day of a cycle, each trial dose — taken or not,
 * when, and how many tablets (→ mg). Mirrors the study's paper diary.
 */
export function openTrialDiary(trialName) {
  openSheet((sheet) => {
    sheet.append(el('h2', {}, `${trialName} diary`));
    if (!USE_API) {
      sheet.append(
        el('p', { class: 'lede' }, 'The diary needs your account (sign in online).'),
      );
      return;
    }
    const body = el('div');
    sheet.append(body);
    let day = localDay();
    const draw = () => renderDay(body, trialName, day, (d) => ((day = d), draw()));
    draw();
  });
}

async function renderDay(body, trialName, day, go) {
  const { meds, cycles, cycleDays } = trialInfo(trialName);
  body.replaceChildren();

  if (!cycles.length) {
    body.append(cycleForm(trialName, cycles, 'Which cycle are you on?', 1, localDay()));
    return;
  }

  const where = cycleDayFor(cycles, cycleDays, day);
  const today = localDay();
  const nav = el('div', { class: 'diary-nav' }, [
    el(
      'button',
      { class: 'btn small ghost', onclick: () => go(addDays(day, -1)) },
      '‹ Prev',
    ),
    el('div', { class: 'diary-when' }, [
      el(
        'div',
        { class: 'title' },
        where ? `Cycle ${where.cycle} · Day ${where.day}` : 'Between cycles',
      ),
      el(
        'div',
        { class: 'sub' },
        day === today ? `Today · ${dateLabel(day)}` : dateLabel(day),
      ),
    ]),
    el(
      'button',
      {
        class: 'btn small ghost',
        disabled: day >= today ? '' : null,
        onclick: () => go(addDays(day, 1)),
      },
      'Next ›',
    ),
  ]);
  body.append(nav);

  const loading = el('div', { class: 'sub', style: 'padding:12px 4px' }, 'Loading…');
  body.append(loading);
  let doses = [];
  try {
    const { from, to } = dayBounds(day);
    doses = await api.getDoses(from.toISOString(), to.toISOString());
  } catch {
    loading.textContent = 'Couldn’t load this day.';
    return;
  }
  loading.remove();

  const times = [...new Set(meds.flatMap((m) => m.times))].sort();
  if (!times.length) {
    body.append(
      el(
        'p',
        { class: 'disclaimer' },
        'Set dose times on the trial medications to use the diary.',
      ),
    );
  }
  for (const time of times) {
    const card = el('div', { class: 'card tight diary-slot' }, [
      el('div', { class: 'diary-slot-head' }, `${prettyTime(time)} dose`),
    ]);
    for (const med of meds.filter((m) => m.times.includes(time))) {
      const scheduledFor = slotIso(day, time);
      const rec = doses.find(
        (d) =>
          d.medicationId === med.id &&
          new Date(d.scheduledFor).getTime() === new Date(scheduledFor).getTime(),
      );
      card.append(doseRow(med, day, time, scheduledFor, rec));
    }
    body.append(card);
  }

  // Cycle controls.
  const last = cycles[cycles.length - 1];
  body.append(
    el('details', { class: 'diary-cycles' }, [
      el('summary', {}, 'Cycles'),
      el(
        'div',
        { class: 'sub', style: 'margin:8px 0' },
        cycles.map((c) => `Cycle ${c.number} started ${dateLabel(c.start)}`).join(' · '),
      ),
      cycleForm(trialName, cycles, 'Start the next cycle', last.number + 1, today),
    ]),
  );
}

/** One medication at one dose time: taken / missed, time, tablets → mg. */
function doseRow(med, day, time, scheduledFor, rec) {
  const per = strengthMg(med.dose);
  let status =
    rec?.status === 'taken' || rec?.status === 'late' ? 'taken' : rec ? 'missed' : null;
  const takenAt = rec?.takenAt ? new Date(rec.takenAt) : null;
  const timeBox = el('input', {
    type: 'time',
    class: 'auth-input diary-time',
    value: takenAt
      ? `${String(takenAt.getHours()).padStart(2, '0')}:${String(takenAt.getMinutes()).padStart(2, '0')}`
      : time,
    'aria-label': `Time ${med.name} was taken`,
  });
  const tablets = el('input', {
    type: 'number',
    inputmode: 'decimal',
    min: '0',
    max: '100',
    step: '0.5',
    class: 'auth-input diary-tabs',
    value: String(rec?.amount?.tablets ?? tabletsPerDose(med.instructions)),
    'aria-label': `Tablets of ${med.name}`,
  });
  const mgOut = el('span', { class: 'diary-mg' });
  const showMg = () => {
    const n = Number(tablets.value);
    mgOut.textContent =
      per != null && Number.isFinite(n) ? `= ${+(n * per).toFixed(3)} mg` : '';
  };
  showMg();

  const yes = el('button', { type: 'button', class: 'seg-btn' }, 'Taken');
  const no = el('button', { type: 'button', class: 'seg-btn' }, 'Missed');
  const details = el('div', { class: 'diary-details' }, [
    el('label', { class: 'diary-inline' }, [el('span', {}, 'At'), timeBox]),
    el('label', { class: 'diary-inline' }, [el('span', {}, 'Tablets'), tablets, mgOut]),
  ]);
  const paint = () => {
    yes.classList.toggle('active', status === 'taken');
    no.classList.toggle('active', status === 'missed');
    details.hidden = status !== 'taken';
  };
  paint();

  const save = async () => {
    try {
      if (status === null) {
        await api.clearDose(med.id, scheduledFor);
      } else {
        const n = Number(tablets.value);
        await api.putDose(med.id, {
          scheduledFor,
          status: status === 'taken' ? 'taken' : 'skipped',
          takenAt: status === 'taken' ? slotIso(day, timeBox.value || time) : undefined,
          amount:
            status === 'taken'
              ? {
                  tablets: Number.isFinite(n) ? n : null,
                  mg: per != null && Number.isFinite(n) ? +(n * per).toFixed(3) : null,
                }
              : null,
        });
      }
      // Keep today's checkmarks in step.
      if (day === localDay()) {
        store.commit((s) => {
          const key = `${med.id}@${time}`;
          if (status === null) delete s.doseLog[key];
          else s.doseLog[key] = status === 'taken' ? 'taken' : 'skipped';
        });
      }
    } catch {
      toast('Couldn’t save. Try again.');
    }
  };
  yes.addEventListener('click', () => {
    status = status === 'taken' ? null : 'taken';
    paint();
    save();
  });
  no.addEventListener('click', () => {
    status = status === 'missed' ? null : 'missed';
    paint();
    save();
  });
  timeBox.addEventListener('change', () => status === 'taken' && save());
  tablets.addEventListener('input', showMg);
  tablets.addEventListener('change', () => status === 'taken' && save());

  return el('div', { class: 'diary-row' }, [
    el('div', { class: 'title' }, `${med.name} ${med.dose}`),
    el('div', { class: 'seg diary-seg' }, [yes, no]),
    details,
  ]);
}

/** "Cycle N starting <date>" form; appends a cycle to the trial. */
function cycleForm(trialName, cycles, heading, nextNumber, startDefault) {
  const number = el('input', {
    type: 'number',
    min: '1',
    max: '999',
    class: 'auth-input',
    value: String(nextNumber),
  });
  const start = el('input', { type: 'date', class: 'auth-input', value: startDefault });
  const btn = el('button', { class: 'btn', type: 'submit' }, 'Save cycle');
  const form = el('form', { class: 'med-form', novalidate: '' }, [
    el('div', { class: 'title' }, heading),
    el('label', { class: 'med-field' }, [el('span', {}, 'Cycle number'), number]),
    el('label', { class: 'med-field' }, [el('span', {}, 'Day 1 was'), start]),
    btn,
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = Number(number.value);
    if (!Number.isInteger(n) || n < 1 || !start.value) {
      toast('Enter a cycle number and its Day 1 date');
      return;
    }
    btn.disabled = true;
    try {
      const next = [
        ...cycles.filter((c) => c.number !== n),
        { number: n, start: start.value },
      ];
      next.sort((a, b) => a.start.localeCompare(b.start));
      await saveCycles(trialName, next);
      toast(`Cycle ${n} saved`);
      openTrialDiary(trialName);
    } catch (err) {
      toast(err?.serverMessage || 'Couldn’t save the cycle');
      btn.disabled = false;
    }
  });
  return form;
}
