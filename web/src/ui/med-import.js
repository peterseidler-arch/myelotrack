import { el } from '../lib/dom.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';
import { USE_API } from '../config.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';
import { refreshMeds, toApiMed } from './med-edit.js';

/** "08:00, 20:00" → ['08:00', '20:00']; null if any entry isn't a valid time. */
function parseTimes(text) {
  const parts = text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^\d:\d\d$/.test(t) ? `0${t}` : t));
  return parts.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
    ? [...new Set(parts)].sort()
    : null;
}

/**
 * "Import medication list": pick a PDF of a medication table (a saved doc or
 * printout), review and adjust what was read, then save. The PDF is read on
 * this device; only the reviewed list is sent to the server.
 */
export function openMedImportSheet() {
  openSheet((sheet) => {
    sheet.append(
      el('h2', {}, 'Import medication list'),
      el(
        'p',
        { class: 'lede' },
        'Choose a PDF of your medication list: a table with medication, dose and schedule columns. It’s read on this device. Check the times before saving.',
      ),
    );
    const fileInput = el('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      style: 'display:none',
    });
    const pick = el(
      'button',
      { class: 'btn', onclick: () => fileInput.click() },
      'Choose PDF',
    );
    const review = el('div');
    sheet.append(fileInput, pick, review);

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      pick.disabled = true;
      pick.textContent = 'Reading…';
      try {
        const [{ readPdfFileItems }, { parseMedList }] = await Promise.all([
          import('../lib/mychart/read-file.js'),
          import('../lib/medlist/parse.js'),
        ]);
        renderReview(review, parseMedList(await readPdfFileItems(file)));
      } catch {
        review.replaceChildren(
          el('p', { class: 'disclaimer' }, 'Couldn’t read that PDF.'),
        );
      } finally {
        pick.disabled = false;
        pick.className = 'btn secondary';
        pick.textContent = 'Choose a different PDF';
        fileInput.value = '';
      }
    });
  });
}

function renderReview(container, parsed) {
  container.replaceChildren();
  if (!parsed.medications.length) {
    container.append(
      el(
        'p',
        { class: 'disclaimer' },
        'No medication table found. The PDF needs a header row with “Medication” and “Dose” or “Schedule” columns. You can add medications one at a time instead.',
      ),
    );
    return;
  }

  const rows = parsed.medications.map((m) => ({
    include: true,
    med: {
      name: m.name,
      brand: m.brand,
      dose: m.dose,
      purpose: m.purpose,
      prescriber: m.prescriber,
      times: m.schedule.times,
      asNeeded: m.schedule.asNeeded,
      instructions: m.schedule.instructions,
      trial: m.trial,
    },
    timesText: m.schedule.times.join(', '),
  }));

  container.append(
    el(
      'div',
      { class: 'section-title' },
      `${rows.length} medications${parsed.title ? ` · ${parsed.title}` : ''}`,
    ),
  );
  const list = el('div', { class: 'card tight' });
  for (const r of rows) {
    const check = el('input', {
      type: 'checkbox',
      'aria-label': `Include ${r.med.name}`,
    });
    check.checked = true;
    check.addEventListener('change', () => (r.include = check.checked));
    const times = el('input', {
      class: 'auth-input med-times-input',
      value: r.timesText,
      placeholder: r.med.asNeeded ? 'As needed' : 'No set times',
      'aria-label': `Times for ${r.med.name}`,
    });
    times.addEventListener('input', () => {
      r.timesText = times.value;
      times.classList.toggle('invalid', parseTimes(times.value) === null);
    });
    const sub = [r.med.instructions, r.med.prescriber].filter(Boolean).join(' · ');
    list.append(
      el('div', { class: 'row med-review-row' }, [
        check,
        el('div', { class: 'grow' }, [
          el('div', { class: 'title' }, [
            `${r.med.name}${r.med.brand ? ` · ${r.med.brand}` : ''} ${r.med.dose}`,
            r.med.trial ? el('span', { class: 'trial-pill' }, 'Trial') : null,
          ]),
          el('div', { class: 'sub' }, sub),
          r.med.purpose ? el('div', { class: 'sub' }, r.med.purpose) : null,
          times,
        ]),
      ]),
    );
  }
  container.append(list);

  const replace = el('input', { type: 'checkbox' });
  replace.checked = true;
  container.append(
    el('label', { class: 'med-option', style: 'margin:14px 4px' }, [
      replace,
      el(
        'span',
        {},
        'This is my full current list: mark medications from an earlier imported list that aren’t on it as stopped. (Ones you added by hand are never touched.)',
      ),
    ]),
    el(
      'p',
      { class: 'disclaimer' },
      'Times are suggestions from the schedule wording, e.g. “twice daily” → 8:00 AM and 8:00 PM. Change them to when you actually take each one, separated by commas (24-hour, e.g. 08:00, 20:00).',
    ),
  );

  const err = el('div', {
    class: 'err',
    role: 'alert',
    style: 'color:var(--red);margin:8px 4px',
  });
  const save = el('button', { class: 'btn' }, 'Save medications');
  save.addEventListener('click', async () => {
    err.textContent = '';
    const chosen = [];
    for (const r of rows) {
      if (!r.include) continue;
      const t = parseTimes(r.timesText);
      if (t === null) {
        err.textContent = `Check the times for ${r.med.name} (use 24-hour HH:MM, e.g. 08:00, 20:00).`;
        return;
      }
      chosen.push({ ...r.med, times: t });
    }
    if (!chosen.length) {
      err.textContent = 'Select at least one medication.';
      return;
    }
    save.disabled = true;
    try {
      if (USE_API) {
        const res = await api.importMedications({
          medications: chosen.map(toApiMed),
          replace: replace.checked,
        });
        await refreshMeds();
        const parts = [`${res.added} added`];
        if (res.updated) parts.push(`${res.updated} updated`);
        if (res.stopped) parts.push(`${res.stopped} stopped`);
        toast(parts.join(', '));
      } else {
        store.commit((s) => {
          s.medications = chosen.map((m, i) => ({
            ...m,
            id: `local_${Date.now()}_${i}`,
          }));
        });
        toast(`${chosen.length} medications loaded (this session only)`);
      }
      closeSheet();
    } catch (e) {
      err.textContent = e?.serverMessage || 'Import failed. Nothing was saved.';
      save.disabled = false;
    }
  });
  container.append(err, save);
}
