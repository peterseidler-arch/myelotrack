import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { weightOut } from '../units.js';

/**
 * Render a visit report (see build.js) to a PDF: a summary first, then the
 * trial diary in the same shape as the study's paper diary (date / day,
 * taken?, time, amount per drug, 7 days per page). Built on the device.
 *
 * @returns {Blob}
 */
export function makeReportPdf(
  report,
  {
    patient = {},
    recipients = [],
    notes = '',
    weightUnit = 'lb',
    preparedAt = new Date(),
  } = {},
) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  let y = M;

  const fmtDay = (day) =>
    new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  const fmtShort = (day) =>
    new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit',
    });
  const fmtTime = (iso) =>
    iso
      ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : '';
  const fmtSlot = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  const periodText = `${fmtDay(localDayOf(report.periodStart))} – ${fmtDay(localDayOf(report.periodEnd))}`;

  const ensure = (h) => {
    if (y + h > doc.internal.pageSize.getHeight() - 56) {
      doc.addPage();
      y = M;
    }
  };
  const heading = (text) => {
    ensure(40);
    y += 10;
    doc.setFont('helvetica', 'bold').setFontSize(13).text(text, M, y);
    y += 8;
  };
  const para = (text, size = 10) => {
    doc.setFont('helvetica', 'normal').setFontSize(size);
    const lines = doc.splitTextToSize(text, W - 2 * M);
    ensure(lines.length * (size + 3) + 4);
    doc.text(lines, M, y + size);
    y += lines.length * (size + 3) + 6;
  };
  const table = (head, body, opts = {}) => {
    autoTable(doc, {
      startY: y + 4,
      head: [head],
      body,
      margin: { left: M, right: M },
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 4,
        lineColor: 180,
        lineWidth: 0.5,
      },
      headStyles: { fillColor: [235, 235, 240], textColor: 20, fontStyle: 'bold' },
      theme: 'grid',
      ...opts,
    });
    y = doc.lastAutoTable.finalY + 10;
  };

  // ---------------------------------------------------------- summary page
  doc
    .setFont('helvetica', 'bold')
    .setFontSize(20)
    .text('Visit report', M, y + 14);
  y += 24;
  doc
    .setFont('helvetica', 'normal')
    .setFontSize(10)
    .setTextColor(90)
    .text('Patient-reported · prepared with MyeloTrack', M, y + 8);
  doc.setTextColor(0);
  y += 22;

  const idRows = [
    ['Patient', patient.name || ''],
    ['MRN', patient.mrn || ''],
    ['Date of birth', patient.dob || ''],
    ['Period', periodText],
    [
      'Prepared',
      preparedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    ],
    [
      'To',
      recipients
        .map((r) => [r.name, r.email && `<${r.email}>`].filter(Boolean).join(' '))
        .join('; '),
    ],
  ].filter(([, v]) => v);
  autoTable(doc, {
    startY: y,
    body: idRows,
    margin: { left: M, right: M },
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 2 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 90 } },
  });
  y = doc.lastAutoTable.finalY + 6;

  if (notes.trim()) {
    heading('Notes from the patient');
    para(notes.trim());
  }

  for (const t of report.trials) {
    const cyclesSeen = [...new Set(t.days.map((d) => d.cycle).filter(Boolean))];
    heading(
      `Clinical trial: ${t.name}${cyclesSeen.length ? ` — cycle ${cyclesSeen.join(', ')}` : ''}`,
    );
    table(
      ['Drug', 'Scheduled doses', 'Taken', 'Missed', 'Not logged', 'Total taken'],
      t.drugs.map((d) => [
        `${d.name} ${d.dose}`,
        d.scheduled,
        d.taken,
        d.missed,
        d.unlogged,
        d.mgTaken ? `${d.mgTaken} mg` : '',
      ]),
    );
    const missed = t.drugs.flatMap((d) =>
      d.missedList.map((m) => `${d.name}: ${fmtDay(m.day)} ${fmtSlot(m.time)}`),
    );
    if (missed.length) para(`Missed doses: ${missed.join('; ')}.`, 9);
    if (t.drugs.some((d) => d.unlogged)) {
      para(
        '“Not logged” means no entry was made for that dose, not that it was missed.',
        8,
      );
    }
  }

  const s = report.symptoms;
  heading('Symptoms (MPN-SAF total symptom score, 0–100)');
  if (s) {
    const w = (kg) =>
      kg == null ? '' : `${weightOut(kg, weightUnit).toFixed(1)} ${weightUnit}`;
    const rows = [
      ['Check-ins', String(s.entries)],
      ['First, latest', `${s.first ?? '—'}, then ${s.last ?? '—'}`],
      ['Average / highest', `${s.average ?? '—'} / ${s.highest ?? '—'}`],
    ];
    if (s.weightFirstKg != null) {
      rows.push([
        'Weight first, latest',
        `${w(s.weightFirstKg)}, then ${w(s.weightLastKg)}`,
      ]);
    }
    autoTable(doc, {
      startY: y + 2,
      body: rows,
      margin: { left: M, right: M },
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 2 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 140 } },
    });
    y = doc.lastAutoTable.finalY + 6;
    if (s.notes.length) {
      para(
        `Check-in notes: ${s.notes.map((n) => `${fmtDay(n.day)}: ${n.note}`).join(' · ')}`,
        9,
      );
    }
  } else {
    para('No symptom check-ins in this period.', 9);
  }

  heading('Labs in this period');
  if (report.labs.length) {
    table(
      ['Date', 'Test', 'Result', 'Reference range', 'Flag', 'Lab'],
      report.labs.map((l) => [fmtDay(l.day), l.test, l.value, l.range, l.flag, l.source]),
      {
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 4 && data.cell.raw) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = [180, 30, 30];
          }
        },
      },
    );
  } else {
    para('No new lab results in this period.', 9);
  }

  heading('Medication changes');
  if (report.changes.length) {
    table(
      ['Date', 'Change', 'Medication', 'Dose'],
      report.changes.map((c) => [fmtDay(c.day), c.what, c.med, c.dose]),
    );
  } else {
    para('None recorded in this period.', 9);
  }

  heading('Current medications');
  table(
    ['Medication', 'Dose', 'How taken', 'Prescriber'],
    report.current.map((m) => [
      m.trial ? `${m.name} (trial)` : m.name,
      m.dose,
      m.how,
      m.prescriber,
    ]),
  );

  // ----------------------------------------------------- diary (RS3 shape)
  for (const t of report.trials) {
    const byCycle = new Map();
    for (const d of t.days) {
      const key = d.cycle ?? '—';
      if (!byCycle.has(key)) byCycle.set(key, []);
      byCycle.get(key).push(d);
    }
    for (const [cycle, days] of byCycle) {
      for (let i = 0; i < days.length; i += 7) {
        const chunk = days.slice(i, i + 7);
        doc.addPage();
        y = M;
        doc
          .setFont('helvetica', 'bold')
          .setFontSize(12)
          .text(`Patient dose diary — ${t.name}`, M, y + 10);
        y += 26;
        doc.setFontSize(11).text(`Cycle: ${cycle}`, M, y);
        y += 16;
        doc.setFont('helvetica', 'normal').setFontSize(10);
        for (const d of t.drugs) {
          const perDay =
            d.dosesPerDay === 2
              ? 'twice a day'
              : d.dosesPerDay === 1
                ? 'once a day'
                : `${d.dosesPerDay}× a day`;
          doc.text(
            `${d.name}: ${d.perDoseMg != null ? `${d.perDoseMg} mg` : d.dose} ${perDay}, every day${t.cycleDays ? ` (Days 1–${t.cycleDays})` : ''}`,
            M,
            y,
          );
          y += 14;
        }

        const body = [];
        let shade = false;
        for (const day of chunk) {
          const rowsForDay = day.slots.reduce((n, s) => n + s.entries.length, 0);
          let firstOfDay = true;
          for (const slot of day.slots) {
            let firstOfSlot = true;
            for (const e of slot.entries) {
              const row = [];
              if (firstOfDay) {
                row.push({
                  content: `${fmtShort(day.day)}\nDay ${day.cycleDay ?? '—'}`,
                  rowSpan: rowsForDay,
                  styles: { valign: 'middle', halign: 'center' },
                });
              }
              if (firstOfSlot) {
                row.push({
                  content: fmtSlot(slot.time),
                  rowSpan: slot.entries.length,
                  styles: { valign: 'middle' },
                });
              }
              row.push(
                e.med,
                e.status === 'taken' ? 'Yes' : e.status === 'missed' ? 'No' : '—',
                e.status === 'taken' ? fmtTime(e.takenAt) : '',
                e.tablets != null && e.status === 'taken' ? String(e.tablets) : '',
                e.mg != null && e.status === 'taken' ? `${e.mg} mg` : '',
              );
              body.push({ row, shade });
              firstOfDay = false;
              firstOfSlot = false;
            }
          }
          shade = !shade;
        }
        autoTable(doc, {
          startY: y + 4,
          head: [
            [
              'Date / Day',
              'Dose',
              'Drug',
              'Was dose taken?',
              'At what time?',
              'Tablets',
              'Total mg',
            ],
          ],
          body: body.map((b) => b.row),
          margin: { left: M, right: M },
          theme: 'grid',
          styles: { fontSize: 9.5, cellPadding: 5, lineColor: 120, lineWidth: 0.6 },
          headStyles: {
            fillColor: [230, 230, 230],
            textColor: 0,
            fontStyle: 'bold',
            halign: 'center',
          },
          didParseCell: (data) => {
            if (data.section !== 'body') return;
            if (body[data.row.index]?.shade) data.cell.styles.fillColor = [242, 242, 242];
          },
        });
      }
    }
  }

  // Footer on every page.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc
      .setFont('helvetica', 'normal')
      .setFontSize(8)
      .setTextColor(110)
      .text(
        `Patient-reported via MyeloTrack · not an official study record · ${periodText} · page ${p} of ${pages}`,
        W / 2,
        doc.internal.pageSize.getHeight() - 24,
        { align: 'center' },
      );
    doc.setTextColor(0);
  }
  return doc.output('blob');
}

function localDayOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  const x = new Date(d);
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
