import { el, clear } from '../lib/dom.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { api } from '../api/client.js';
import { USE_API } from '../config.js';
import { store } from '../state/store.js';
import { SOURCES } from '../data/sources.js';
import { MPN_SUBTYPES } from '../data/risk.js';
import { fmtDate } from '../lib/format.js';

const FHIR_SOURCES = ['msk', 'capital-health'];

/** A labelled row with a control on the right. */
function field(label, control) {
  return el('div', { class: 'field-row' }, [
    el('div', { class: 'field-label' }, label),
    control,
  ]);
}

/** A <select> bound to `value`, calling `onChange` with the chosen value. */
function selectControl(value, options, onChange) {
  const sel = el(
    'select',
    { class: 'field-control', onchange: (e) => onChange(e.target.value) },
    options.map((o) => el('option', { value: o.value }, o.label)),
  );
  sel.value = value;
  return sel;
}

/** A yes/no control (kept a select for reliable touch behavior). */
function yesNoControl(value, onChange) {
  return selectControl(
    value ? 'yes' : 'no',
    [
      { value: 'no', label: 'No' },
      { value: 'yes', label: 'Yes' },
    ],
    (v) => onChange(v === 'yes'),
  );
}

/** Clinical-profile section — the semi-static facts that feed the Score tab. */
function renderProfile(sheet) {
  const u = store.state.user;
  const set = (patch) => store.commit((s) => Object.assign(s.user, patch));
  sheet.append(
    el('h2', {}, 'Clinical profile'),
    el('p', { class: 'lede' }, 'These feed your risk score on the Score tab.'),
  );
  const card = el('div', { class: 'card tight' });
  card.append(
    field(
      'MPN subtype',
      selectControl(
        u.mpnSubtype || 'PMF',
        MPN_SUBTYPES.map((t) => ({ value: t.id, label: t.label })),
        (v) => set({ mpnSubtype: v }),
      ),
    ),
    field(
      'Date of birth',
      el('input', {
        type: 'date',
        class: 'field-control',
        value: u.dob || '',
        onchange: (e) => set({ dob: e.target.value }),
      }),
    ),
    field(
      'JAK2 V617F',
      selectControl(
        u.jak2 || 'unknown',
        [
          { value: 'positive', label: 'Positive' },
          { value: 'negative', label: 'Negative' },
          { value: 'unknown', label: 'Unknown' },
        ],
        (v) => set({ jak2: v }),
      ),
    ),
    field(
      'Prior thrombosis',
      yesNoControl(!!u.priorThrombosis, (v) => set({ priorThrombosis: v })),
    ),
    field(
      'Transfusion-dependent',
      yesNoControl(!!u.transfusionDependent, (v) => set({ transfusionDependent: v })),
    ),
  );
  sheet.append(card);
}

/** Trigger a client-side download of a Blob under the given filename. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build an export document from the in-memory store (offline/sample mode). */
function offlineExportDoc() {
  const s = store.state;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    app: 'MyeloTrack',
    note: 'Exported locally in sample/offline mode.',
    records: {
      user: s.user,
      todayItems: s.todayItems,
      symptomHistory: s.symptomHistory,
      medications: s.medications,
      labs: s.labs,
      // Drop the inline image data URLs — keep the metadata only.
      pallor: (s.pallor || []).map(({ img: _img, ...rest }) => rest),
    },
  };
}

async function exportData(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `myelotrack-export-${stamp}.json`;
  try {
    if (USE_API) {
      const res = await fetch(api.exportUrl(), { credentials: 'include' });
      if (!res.ok) throw new Error(`export ${res.status}`);
      downloadBlob(await res.blob(), filename);
    } else {
      const json = JSON.stringify(offlineExportDoc(), null, 2);
      downloadBlob(new Blob([json], { type: 'application/json' }), filename);
    }
    toast('Data exported');
  } catch {
    toast('Export failed');
  } finally {
    btn.disabled = false;
  }
}

async function deleteData(event) {
  const ok = window.confirm(
    'Permanently delete all your MyeloTrack data? This cannot be undone.',
  );
  if (!ok) return;
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await api.deleteAccount();
    toast('Your data was deleted');
    // Reload so the app reflects the now-empty record.
    setTimeout(() => window.location.reload(), 600);
  } catch {
    toast('Delete failed');
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

/** "Your data" section — export a copy, or erase everything (consent promise). */
function renderDataControls(sheet) {
  sheet.append(
    el('h2', {}, 'Your data'),
    el(
      'p',
      { class: 'lede' },
      'Download a copy of everything, or permanently delete it.',
    ),
  );
  const card = el('div', { class: 'card tight' });
  card.append(
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, 'Export my data'),
        el('div', { class: 'sub' }, 'Download all your records as a JSON file.'),
      ]),
      el('div', { class: 'trail' }, [
        el('button', { class: 'btn small ghost', onclick: exportData }, 'Export'),
      ]),
    ]),
  );
  card.append(
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, 'Delete my data'),
        el(
          'div',
          { class: 'sub' },
          USE_API
            ? 'Permanently erase your entire record.'
            : 'Erasing your synced record needs the backend API.',
        ),
      ]),
      ...(USE_API
        ? [
            el('div', { class: 'trail' }, [
              el('button', { class: 'btn small danger', onclick: deleteData }, 'Delete'),
            ]),
          ]
        : []),
    ]),
  );
  sheet.append(card);
}

/**
 * "Sign-in" section (live API only): the account's email, add or change its
 * password, and sign out.
 */
function renderSignIn(sheet) {
  sheet.append(el('h2', {}, 'Sign-in'));
  const card = el('div', { class: 'card tight' }, [
    el('div', { class: 'row' }, [el('div', { class: 'grow' }, 'Loading…')]),
  ]);
  sheet.append(card);

  api
    .authMe()
    .then((auth) => drawSignIn(card, auth))
    .catch(() => {
      clear(card);
      card.append(
        el('div', { class: 'row' }, [el('div', { class: 'grow' }, 'Unavailable')]),
      );
    });
}

function drawSignIn(card, auth) {
  clear(card);
  const hasPassword = Boolean(auth.email);
  const form = el('form', { class: 'account-form', hidden: '', novalidate: '' });
  const toggle = el(
    'button',
    { class: 'btn small ghost', type: 'button' },
    hasPassword ? 'Change' : 'Add',
  );
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('input')?.focus();
  });

  card.append(
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, 'Email and password'),
        el(
          'div',
          { class: 'sub' },
          hasPassword ? auth.email : 'Not set. You sign in with a passkey.',
        ),
      ]),
      el('div', { class: 'trail' }, [toggle]),
    ]),
    form,
  );

  const input = (attrs) => el('input', { class: 'auth-input', ...attrs });
  const email = input({
    type: 'email',
    placeholder: 'Email',
    autocomplete: 'username',
    autocapitalize: 'none',
    value: auth.email || '',
  });
  const current = input({
    type: 'password',
    placeholder: 'Current password',
    autocomplete: 'current-password',
  });
  const next = input({
    type: 'password',
    placeholder: 'New password (12+ characters)',
    autocomplete: 'new-password',
  });
  const err = el('div', { class: 'err', role: 'alert' });
  const save = el('button', { class: 'btn small', type: 'submit' }, 'Save');
  form.append(email, ...(hasPassword ? [current] : []), next, err, save);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (next.value.length < 12) {
      err.textContent = 'Use at least 12 characters.';
      return;
    }
    save.disabled = true;
    try {
      const res = await api.setPassword({
        email: email.value.trim(),
        newPassword: next.value,
        ...(hasPassword ? { currentPassword: current.value } : {}),
      });
      toast('Password saved');
      drawSignIn(card, { ...auth, email: res.email });
    } catch (e2) {
      err.textContent =
        e2?.status === 429
          ? 'Too many attempts. Try again later.'
          : e2?.serverMessage || 'Couldn’t save. Try again.';
      save.disabled = false;
    }
  });

  card.append(
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'title' }, 'Sign out')]),
      el('div', { class: 'trail' }, [
        el(
          'button',
          {
            class: 'btn small danger',
            type: 'button',
            onclick: async () => {
              await api.authLogout().catch(() => {});
              window.location.reload();
            },
          },
          'Sign out',
        ),
      ]),
    ]),
  );
}

/** Open the settings sheet: sign-in, clinical profile, data, care teams. */
export function openSettingsSheet() {
  openSheet((sheet) => {
    if (USE_API) renderSignIn(sheet);
    renderProfile(sheet);
    renderDataControls(sheet);
    sheet.append(
      el('h2', {}, 'Care teams'),
      el(
        'p',
        { class: 'lede' },
        'Connect your patient portals to sync labs and medications into one timeline.',
      ),
    );

    if (!USE_API) {
      sheet.append(
        el(
          'div',
          { class: 'empty' },
          'Connecting a care team needs the backend API. Set VITE_API_BASE_URL to enable it.',
        ),
      );
      return;
    }

    const card = el('div', { class: 'card tight' });
    card.append(el('div', { class: 'row' }, [el('div', { class: 'grow' }, 'Loading…')]));
    sheet.append(card);

    renderRows(card);
  });
}

async function renderRows(card) {
  let statuses = [];
  try {
    statuses = await api.getIntegrationsStatus();
  } catch {
    clear(card);
    card.append(
      el('div', { class: 'row' }, [el('div', { class: 'grow' }, 'Status unavailable')]),
    );
    return;
  }
  const bySource = Object.fromEntries(statuses.map((s) => [s.source, s]));
  clear(card);

  for (const source of FHIR_SOURCES) {
    const st = bySource[source];
    const connected = st?.status === 'connected';
    const sub = connected
      ? st.lastSyncAt
        ? `Last synced ${fmtDate(new Date(st.lastSyncAt), { month: 'short', day: 'numeric' })}`
        : 'Connected'
      : 'Not connected';

    const actions = el('div', { class: 'trail' });
    actions.append(
      el(
        'button',
        { class: 'btn small ghost', onclick: () => connectCareTeam(source) },
        connected ? 'Reconnect' : 'Connect',
      ),
    );
    if (connected) {
      actions.append(
        el(
          'button',
          { class: 'btn small secondary', onclick: (e) => syncCareTeam(source, e) },
          'Sync',
        ),
      );
    }

    card.append(
      el('div', { class: 'row' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'title' }, SOURCES[source]?.name || source),
          el('div', { class: 'sub' }, sub),
        ]),
        actions,
      ]),
    );
  }
}

async function connectCareTeam(source) {
  try {
    const { authorizeUrl } = await api.connectSource(source);
    window.location.assign(authorizeUrl); // hand off to the portal's OAuth
  } catch {
    toast(`${SOURCES[source]?.name || source} isn't configured yet`);
  }
}

async function syncCareTeam(source, event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const result = await api.syncSource(source);
    const labs = result?.labs?.upserted ?? 0;
    const meds = result?.medications?.upserted ?? 0;
    await store.hydrate();
    toast(`Synced ${labs} labs, ${meds} meds`);
  } catch {
    toast('Sync failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync';
  }
}
