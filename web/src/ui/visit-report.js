import { el } from '../lib/dom.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';
import { USE_API } from '../config.js';
import { openSheet, closeSheet } from './sheet.js';
import { toast } from './toast.js';
import { fmtDate } from '../lib/format.js';
import { analyteLabel } from '../data/analytes.js';
import { getUnits } from '../lib/units.js';
import { localDay, addDays } from '../lib/dose-slots.js';
import { trialInfo } from './trial-diary.js';

// Remembered on this device only: who the report goes to, and the
// identifiers printed on it.
const RECIPIENTS_KEY = 'mt_report_recipients';
const PATIENT_KEY = 'mt_report_patient';
const load = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: fine, just not remembered.
  }
};

const dayLabel = (d) =>
  fmtDate(new Date(d), { month: 'short', day: 'numeric', year: 'numeric' });

/** Default recipients: the trial's prescriber, plus the trial coordinator. */
function defaultRecipients() {
  const trialMed = store.state.medications.find((m) => m.trial);
  return [
    { name: trialMed?.prescriber || 'Doctor', email: '' },
    { name: 'Trial coordinator', email: '' },
  ];
}

/**
 * Prepare a visit report covering everything since the last one sent:
 * review it, approve it, and send the PDF from the phone's share sheet.
 */
export function openVisitReport() {
  openSheet((sheet) => {
    sheet.append(
      el('h2', {}, 'Visit report'),
      el(
        'p',
        { class: 'lede' },
        'Everything since your last report: trial doses, symptoms, weight, new labs and medication changes. Review it, add notes, then send it as a PDF.',
      ),
    );
    if (!USE_API) {
      sheet.append(
        el('p', { class: 'disclaimer' }, 'Reports need your account (sign in online).'),
      );
      return;
    }
    const body = el('div', {}, [el('div', { class: 'sub' }, 'Gathering your data…')]);
    sheet.append(body);
    prepare(body).catch(() => {
      body.replaceChildren(
        el('p', { class: 'disclaimer' }, 'Couldn’t load your data. Try again.'),
      );
    });
  });
}

async function prepare(body) {
  const [reports, history, labs, symptoms] = await Promise.all([
    api.getReports(),
    api.getMedicationHistory(),
    api.getLabs(),
    api.getSymptoms(),
  ]);
  const last = reports[0];
  // Start: where the last report ended; else the current trial cycle's Day 1;
  // else four weeks ago.
  let startDay;
  if (last) startDay = localDay(new Date(last.periodEnd));
  else {
    const trialName = store.state.medications.find((m) => m.trial)?.trial.name;
    const cycles = trialName ? trialInfo(trialName).cycles : [];
    startDay = cycles.length ? cycles[cycles.length - 1].start : addDays(localDay(), -28);
  }

  body.replaceChildren();
  if (last) {
    body.append(
      el(
        'div',
        { class: 'sub', style: 'margin:0 4px 10px' },
        `Last report sent ${dayLabel(last.sentAt)} (covered to ${dayLabel(last.periodEnd)}).`,
      ),
    );
  }

  const start = el('input', {
    type: 'date',
    class: 'auth-input',
    value: startDay,
    max: localDay(),
  });
  const patient = load(PATIENT_KEY, { name: '', mrn: '', dob: '' });
  const pName = el('input', {
    class: 'auth-input',
    value: patient.name,
    placeholder: 'Name as on your chart',
  });
  const pMrn = el('input', {
    class: 'auth-input',
    value: patient.mrn,
    placeholder: 'Optional',
  });
  const pDob = el('input', {
    class: 'auth-input',
    value: patient.dob,
    placeholder: 'MM/DD/YYYY',
  });
  const recipients = load(RECIPIENTS_KEY, null) || defaultRecipients();
  const recipientRows = recipients.map((r) => ({
    name: el('input', { class: 'auth-input', value: r.name, placeholder: 'Name' }),
    email: el('input', {
      class: 'auth-input',
      type: 'email',
      value: r.email,
      placeholder: 'Email',
      autocapitalize: 'none',
    }),
  }));
  const notes = el('textarea', {
    class: 'auth-input report-notes',
    rows: '4',
    placeholder: 'Side effects, questions, anything you want them to know',
  });
  const preview = el('div', { class: 'report-preview' });

  const field = (label, control) =>
    el('label', { class: 'med-field' }, [el('span', {}, label), control]);
  body.append(
    el('div', { class: 'med-form' }, [
      field('Report covers from', start),
      el('div', { class: 'section-title' }, 'Send to'),
      ...recipientRows.map((r) =>
        el('div', { class: 'report-recipient' }, [r.name, r.email]),
      ),
      el('div', { class: 'section-title' }, 'Printed on the report'),
      field('Your name', pName),
      field('MRN', pMrn),
      field('Date of birth', pDob),
      field('Notes for your care team', notes),
    ]),
    el('div', { class: 'section-title' }, 'Preview'),
    preview,
  );

  const { buildReport } = await import('../lib/report/build.js');
  let report;
  const rebuild = async () => {
    const periodStart = new Date(`${start.value}T00:00:00`);
    const periodEnd = new Date();
    const { from, to } = { from: periodStart.toISOString(), to: periodEnd.toISOString() };
    const doses = await api.getDoses(from, to);
    report = buildReport({
      periodStart,
      periodEnd,
      meds: history,
      doses,
      labs,
      symptoms,
      labLabel: analyteLabel,
      firstReport: !last,
    });
    renderPreview(preview, report);
  };
  start.addEventListener('change', () => rebuild().catch(() => toast('Couldn’t update')));
  await rebuild();

  const err = el('div', {
    class: 'err',
    role: 'alert',
    style: 'color:var(--red);margin:8px 4px',
  });
  const pdfBtn = el('button', { class: 'btn secondary' }, 'Open PDF to check');
  const sendBtn = el('button', { class: 'btn' }, 'Approve & send');
  body.append(err, pdfBtn, sendBtn);

  const inputs = () => {
    const rec = recipientRows
      .map((r) => ({ name: r.name.value.trim(), email: r.email.value.trim() }))
      .filter((r) => r.name || r.email);
    const pat = {
      name: pName.value.trim(),
      mrn: pMrn.value.trim(),
      dob: pDob.value.trim(),
    };
    save(RECIPIENTS_KEY, rec);
    save(PATIENT_KEY, pat);
    return { recipients: rec, patient: pat };
  };
  const makePdf = async () => {
    const { makeReportPdf } = await import('../lib/report/pdf.js');
    const { recipients: rec, patient: pat } = inputs();
    const blob = makeReportPdf(report, {
      patient: pat,
      recipients: rec,
      notes: notes.value,
      weightUnit: getUnits().weight,
    });
    return new File([blob], `MyeloTrack-visit-report-${localDay()}.pdf`, {
      type: 'application/pdf',
    });
  };

  pdfBtn.addEventListener('click', async () => {
    const file = await makePdf();
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });

  sendBtn.addEventListener('click', async () => {
    err.textContent = '';
    const { recipients: rec } = inputs();
    const emails = rec.map((r) => r.email).filter(Boolean);
    const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad) {
      err.textContent = `Check this email address: ${bad}`;
      return;
    }
    if (!emails.length) {
      err.textContent = 'Add at least one email address.';
      return;
    }
    sendBtn.disabled = true;
    try {
      const file = await makePdf();
      const subject = `Visit report ${dayLabel(report.periodStart)} – ${dayLabel(report.periodEnd)}`;
      // The share sheet can't pre-fill recipients, so put them on the clipboard.
      await navigator.clipboard?.writeText(emails.join(', ')).catch(() => {});
      let sent = false;
      if (navigator.canShare?.({ files: [file] })) {
        toast('Email addresses copied: paste them into “To”');
        try {
          await navigator.share({ files: [file], title: subject, text: subject });
          sent = window.confirm('Did you send the report? Tap OK to record it as sent.');
        } catch (e) {
          if (e?.name !== 'AbortError') throw e;
        }
      } else {
        // Desktop: download the PDF and open an email draft to attach it to.
        const url = URL.createObjectURL(file);
        const a = el('a', { href: url, download: file.name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        window.location.href = `mailto:${emails.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent('Attached: my visit report (PDF).')}`;
        sent = window.confirm(
          'Attach the downloaded PDF to the email and send it. Tap OK once sent.',
        );
      }
      if (sent) {
        const { reportDigest } = await import('../lib/report/build.js');
        await api.createReport({
          periodStart: report.periodStart.toISOString(),
          periodEnd: report.periodEnd.toISOString(),
          recipients: rec,
          summary: reportDigest(report),
        });
        toast('Report recorded. The next one starts from here.');
        closeSheet();
      }
    } catch {
      err.textContent = 'Couldn’t make or share the PDF. Try “Open PDF to check”.';
    } finally {
      sendBtn.disabled = false;
    }
  });
}

/** On-screen summary of what the PDF will say. */
function renderPreview(container, r) {
  container.replaceChildren();
  const card = el('div', { class: 'card tight' });
  const line = (title, sub) =>
    el('div', { class: 'row' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'title' }, title),
        sub ? el('div', { class: 'sub' }, sub) : null,
      ]),
    ]);

  for (const t of r.trials) {
    for (const d of t.drugs) {
      const parts = [`${d.taken} of ${d.scheduled} doses taken`];
      if (d.missed) parts.push(`${d.missed} missed`);
      if (d.unlogged) parts.push(`${d.unlogged} not logged`);
      card.append(line(`${d.name} (trial)`, parts.join(' · ')));
    }
  }
  const unlogged = r.trials.some((t) => t.drugs.some((d) => d.unlogged));
  const s = r.symptoms;
  card.append(
    line(
      'Symptoms',
      s
        ? `${s.entries} check-ins · score ${s.first} then ${s.last} (average ${s.average})`
        : 'No check-ins',
    ),
  );
  card.append(
    line(
      'Labs',
      r.labs.length
        ? `${r.labs.length} results${r.labs.some((l) => l.flag) ? ` · ${r.labs.filter((l) => l.flag).length} flagged` : ''}`
        : 'None new',
    ),
  );
  card.append(
    line(
      'Medication changes',
      r.changes.length ? r.changes.map((c) => `${c.what} ${c.med}`).join(' · ') : 'None',
    ),
  );
  card.append(line('Current medications', `${r.current.length} listed`));
  container.append(card);
  if (unlogged) {
    container.append(
      el(
        'p',
        { class: 'disclaimer' },
        'Some trial doses are “not logged”. Fill them in from the Dose diary before sending, if you can; the report says they weren’t logged, not that they were missed.',
      ),
    );
  }
}
