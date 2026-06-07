// ============================================================
// VICKI AI — Newsoft visit backfill
//
// Newsoft never tells us a patient's "last visit" directly, so we derive
// it from their PAST appointments: scan the last N months month-by-month,
// and for each real patient keep the most recent attended date. Then seed
// the lifecycle `patients` row (last_visit + recare_due_date) so RECARE
// (6mo) and REACTIVATION (12mo) sweeps can reach old/dormant patients.
//
// Read-only against Newsoft; writes only to our own DB. Sends nothing.
// Idempotent (upsert per patient) — safe to re-run.
// ============================================================

const db      = require('../db');
const newsoft = require('../newsoftApi');
const reminder = require('./reminder');   // upsertPatient
const recare   = require('./recare');     // setRecareDue

// Statuses that are NOT a real visit (cancelled / dr-cancelled / no-show / withdrew).
const NON_VISIT = new Set(['E', 'M', 'F', 'D']);
const pad = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function backfillVisits(clinic, monthsBack = parseInt(process.env.BACKFILL_MONTHS || '24', 10)) {
  if (!db.isEnabled()) { console.warn('[Backfill] DB disabled — skipped'); return { patients: 0, scanned: 0 }; }

  const doctorIds = new Set((clinic.doctorIds || []).map(Number));
  const lastByPatient = new Map(); // newsoftPatientId -> { date, name, phone }
  const now = new Date();
  let scanned = 0;

  for (let m = 0; m < monthsBack; m++) {
    const start = new Date(now.getFullYear(), now.getMonth() - m, 1);
    let end = new Date(now.getFullYear(), now.getMonth() - m + 1, 0); // last day of that month
    if (end > now) end = now;
    if (start > now) continue;

    let appts;
    try {
      appts = await newsoft.getAppointmentsByDateRange(`${dayStr(start)}T00:00:00.000`, `${dayStr(end)}T23:59:59.000`);
    } catch (e) {
      console.error(`[Backfill] fetch failed for ${dayStr(start)}:`, e.message);
      continue;
    }
    scanned += appts.length;

    for (const a of appts) {
      const phone = a.patientPhoneNumber || a.patientPhoneNumber2;
      if (doctorIds.size && !doctorIds.has(Number(a.medicId))) continue;   // skip reception/admin/blocks
      if (!phone || !a.patientId) continue;
      if (NON_VISIT.has(String(a.appointmentStatusCode || '').trim().toUpperCase())) continue;

      const date = (a.appointmentDateBeginLocal || a.appointmentDateBegin || '').slice(0, 10);
      if (!date) continue;

      const prev = lastByPatient.get(a.patientId);
      if (!prev || date > prev.date) lastByPatient.set(a.patientId, { date, name: a.patientName, phone });
    }
  }

  let count = 0;
  for (const [pid, info] of lastByPatient) {
    try {
      const dbId = await reminder.upsertPatient({
        clinicId: clinic.id, newsoftPatientId: pid, name: info.name, phone: info.phone, language: null,
      });
      await recare.setRecareDue(clinic, dbId, info.date);
      count++;
    } catch (e) {
      console.error(`[Backfill] upsert failed for patient ${pid}:`, e.message);
    }
  }

  console.log(`[Backfill] ${clinic.id}: scanned ${scanned} appts over ${monthsBack}mo → ${count} patients with last_visit set`);
  return { patients: count, scanned };
}

module.exports = { backfillVisits };
