import { el } from '../lib/dom.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';
import { medsToStore } from '../api/adapters.js';
import { USE_API } from '../config.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';

/** Re-read the regimen from the API into the store. */
export async function refreshMeds() {
  const meds = medsToStore(await api.getMedications());
  store.commit((s) => {
    s.medications = meds;
  });
}

/** Store-shaped med → API body. */
export function toApiMed(m) {
  return {
    name: m.name,
    brand: m.brand || '',
    dose: m.dose || '',
    purpose: m.purpose || '',
    prescriber: m.prescriber ? { name: m.prescriber } : null,
    trial: m.trial || null,
    schedule: {
      times: m.times || [],
      asNeeded: Boolean(m.asNeeded),
      instructions: m.instructions || '',
    },
  };
}

const input = (attrs) => el('input', { class: 'auth-input', ...attrs });
const label = (text, control) =>
  el('label', { class: 'med-field' }, [el('span', {}, text), control]);

/** An editable list of clock times (HH:MM) with add/remove. */
function timesEditor(initial) {
  const times = [...initial];
  const wrap = el('div', { class: 'med-times' });
  const draw = () => {
    wrap.replaceChildren();
    times.forEach((t, i) => {
      const box = input({ type: 'time', value: t, class: 'auth-input med-time' });
      box.addEventListener('change', (e) => (times[i] = e.target.value));
      wrap.append(
        el('div', { class: 'med-time-row' }, [
          box,
          el(
            'button',
            {
              type: 'button',
              class: 'btn small danger',
              'aria-label': 'Remove time',
              onclick: () => {
                times.splice(i, 1);
                draw();
              },
            },
            'Remove',
          ),
        ]),
      );
    });
    wrap.append(
      el(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          onclick: () => {
            times.push(times.length ? '20:00' : '08:00');
            draw();
          },
        },
        '+ Add a time',
      ),
    );
  };
  draw();
  return { node: wrap, get: () => [...new Set(times.filter(Boolean))].sort() };
}

/**
 * Add or edit one medication. `med` is a store-shaped medication, or
 * undefined to add a new one.
 */
export function openMedSheet(med) {
  const editing = Boolean(med);
  openSheet((sheet) => {
    sheet.append(el('h2', {}, editing ? 'Edit medication' : 'Add medication'));

    const name = input({ value: med?.name || '', placeholder: 'e.g. Ruxolitinib' });
    const brand = input({ value: med?.brand || '', placeholder: 'Optional' });
    const dose = input({ value: med?.dose || '', placeholder: 'e.g. 5 mg' });
    const instructions = input({
      value: med?.instructions || '',
      placeholder: 'e.g. 3 tablets twice daily',
    });
    const purpose = input({ value: med?.purpose || '', placeholder: 'Optional' });
    const prescriber = input({ value: med?.prescriber || '', placeholder: 'Optional' });
    const asNeeded = el('input', { type: 'checkbox' });
    asNeeded.checked = Boolean(med?.asNeeded);
    const times = timesEditor(med?.times || []);
    const isTrial = el('input', { type: 'checkbox' });
    isTrial.checked = Boolean(med?.trial);
    const trialName = input({
      value: med?.trial?.name || '',
      placeholder: 'e.g. study name',
    });
    const cycleDays = input({
      type: 'number',
      inputmode: 'numeric',
      min: '1',
      max: '365',
      value: med?.trial?.cycleDays ?? '',
      placeholder: 'e.g. 28',
    });
    const trialFields = el('div', { class: 'med-trial-fields' }, [
      label('Trial name', trialName),
      label('Cycle length (days)', cycleDays),
    ]);
    trialFields.hidden = !isTrial.checked;
    isTrial.addEventListener('change', () => (trialFields.hidden = !isTrial.checked));
    const err = el('div', { class: 'err', role: 'alert' });

    const form = el('form', { class: 'med-form', novalidate: '' }, [
      label('Name', name),
      label('Brand', brand),
      label('Dose', dose),
      label('How to take', instructions),
      el('div', { class: 'med-field' }, [el('span', {}, 'Times each day'), times.node]),
      el('label', { class: 'med-option' }, [
        asNeeded,
        el('span', {}, 'Also/only as needed'),
      ]),
      label('What it’s for', purpose),
      label('Prescriber', prescriber),
      el('label', { class: 'med-option' }, [
        isTrial,
        el('span', {}, 'Clinical trial drug'),
      ]),
      trialFields,
      err,
    ]);
    const save = el('button', { class: 'btn', type: 'submit' }, 'Save');
    form.append(save);
    sheet.append(form);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!name.value.trim()) {
        err.textContent = 'Enter the medication name.';
        name.focus();
        return;
      }
      const next = {
        ...(med || {}),
        name: name.value.trim(),
        brand: brand.value.trim(),
        dose: dose.value.trim(),
        instructions: instructions.value.trim(),
        purpose: purpose.value.trim(),
        prescriber: prescriber.value.trim(),
        times: times.get(),
        asNeeded: asNeeded.checked,
        trial: isTrial.checked
          ? {
              name: trialName.value.trim() || 'Clinical trial',
              cycleDays: cycleDays.value ? Number(cycleDays.value) : null,
            }
          : null,
      };
      save.disabled = true;
      try {
        if (USE_API) {
          if (editing) await api.updateMedication(med.id, toApiMed(next));
          else await api.createMedication(toApiMed(next));
          await refreshMeds();
        } else {
          store.commit((s) => {
            if (editing) {
              const i = s.medications.findIndex((m) => m.id === med.id);
              s.medications[i] = next;
            } else {
              s.medications.push({ ...next, id: `local_${Date.now()}` });
            }
          });
        }
        toast(editing ? 'Saved' : `${next.name} added`);
        closeSheet();
      } catch (e2) {
        err.textContent = e2?.serverMessage || 'Couldn’t save. Try again.';
        save.disabled = false;
      }
    });

    if (editing) {
      sheet.append(
        el(
          'button',
          {
            class: 'btn danger',
            style: 'margin-top:8px',
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (!window.confirm(`Stop ${med.name}? Its dose history is kept.`)) return;
              btn.disabled = true;
              try {
                if (USE_API) {
                  await api.updateMedication(med.id, { active: false });
                  await refreshMeds();
                } else {
                  store.commit((s) => {
                    s.medications = s.medications.filter((m) => m.id !== med.id);
                  });
                }
                toast(`${med.name} stopped`);
                closeSheet();
              } catch {
                toast('Couldn’t stop it. Try again.');
                btn.disabled = false;
              }
            },
          },
          'Stop this medication',
        ),
      );
    }
    if (!editing) name.focus();
  });
}
