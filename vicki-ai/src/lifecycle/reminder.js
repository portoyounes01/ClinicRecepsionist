// ============================================================
// VICKI AI — Lifecycle: Reminder + Confirm
//
// Flow:
//   1. Track an appointment (from voice booking or Newsoft sync).
//   2. ~48h before: send WhatsApp utility template w/ Confirm/Cancel
//      buttons — ONLY if the appointment status is empty (eligible).
//   3. Confirm tap  -> Newsoft confirmAppointment + mark confirmed.
//      Cancel  tap  -> Newsoft cancelAppointment  + mark cancelled.
//   4. No reply by ~24h before -> schedule an outbound confirm CALL.
//
// ⚠️ ELIGIBILITY: remind only for still-pending appointments — blank status
//    ("" = not yet confirmed) or "Z" (1.ª Vez = first-time patient). Every
//    other live code is skipped: C confirmed, E/M cancelled, D/F withdrawn/
//    no-show, P/N/R/S arrived/in-consult/done/sms. (Verified 2026-06-07 vs
//    the live Newsoft status-code catalog — see docs/plans/WORKLOG.md.)
// ============================================================

const db        = require('../db');
const scheduler = require('../scheduler');
const wa        = require('../integrations/whatsapp');
const newsoft   = require('../newsoftApi');

const JOB_REMINDER     = 'reminder_whatsapp';
const JOB_CONFIRM_CALL = 'confirm_call';

/**
 * Eligible for a reminder when the appointment is still pending: blank status
 * ("" = not yet confirmed) or "Z" = 1.ª Vez (first-time patient). All other
 * codes (C/E/M/D/F/P/N/R/S/U...) are skipped.
 */
const REMINDABLE_STATUSES = new Set(['', 'Z']);
function isEligibleStatus(statusCode) {
  const code = (statusCode === null || statusCode === undefined)
    ? '' : String(statusCode).trim().toUpperCase();
  return REMINDABLE_STATUSES.has(code);
}

// ─── Upsert helpers ────────────────────────────────────────────────────────────
async function upsertPatient({ clinicId, newsoftPatientId, name, phone, language }) {
  const row = await db.one(
    `INSERT INTO patients (clinic_id, newsoft_patient_id, name, phone_e164, language, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (clinic_id, newsoft_patient_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, patients.name),
           phone_e164 = COALESCE(EXCLUDED.phone_e164, patients.phone_e164),
           language = COALESCE(EXCLUDED.language, patients.language),
           updated_at = now()
     RETURNING id`,
    [clinicId, String(newsoftPatientId), name || null, wa.toWaNumber(phone), language || null]
  );
  return row.id;
}

/**
 * Track an appointment and schedule its reminder (if eligible).
 * Idempotent on (clinic_id, newsoft_appointment_id).
 *
 * @param {object} clinic
 * @param {object} appt - { newsoftAppointmentId, appointmentAt(ISO), statusCode,
 *                          patient:{ newsoftPatientId, name, phone, language }, source }
 */
async function trackAppointment(clinic, appt) {
  if (!db.isEnabled()) return null;

  if (!isEligibleStatus(appt.statusCode)) {
    console.log(`[Reminder] Skip appt ${appt.newsoftAppointmentId} — status "${appt.statusCode}" not eligible`);
    return null;
  }

  const patientId = await upsertPatient({
    clinicId: clinic.id,
    newsoftPatientId: appt.patient.newsoftPatientId,
    name: appt.patient.name,
    phone: appt.patient.phone,
    language: appt.patient.language,
  });

  const tracked = await db.one(
    `INSERT INTO appointments_tracked
       (clinic_id, patient_id, newsoft_appointment_id, appointment_at, status_code_at_send, source)
       VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (clinic_id, newsoft_appointment_id) DO NOTHING
     RETURNING id`,
    [clinic.id, patientId, String(appt.newsoftAppointmentId), appt.appointmentAt, appt.statusCode || '', appt.source || 'newsoft_sync']
  );
  if (!tracked) return null; // already tracked

  // Schedule reminder reminderLeadHours before the appointment (or now if past lead).
  const apptTime = new Date(appt.appointmentAt).getTime();
  const reminderAt = new Date(Math.max(Date.now(), apptTime - clinic.reminderLeadHours * 3600_000));
  await scheduler.enqueue({
    clinicId: clinic.id,
    type: JOB_REMINDER,
    runAt: reminderAt,
    payload: { trackedId: tracked.id },
    idempotencyKey: `reminder:${clinic.id}:${appt.newsoftAppointmentId}`,
  });

  console.log(`[Reminder] Tracked appt ${appt.newsoftAppointmentId}, reminder at ${reminderAt.toISOString()}`);
  return tracked.id;
}

// ─── Daily batch sweep: remind everyone with an appointment N days out ─────────
// Pulls ALL clinic appointments for the target day from Newsoft and enqueues a
// reminder for each REAL, eligible patient appointment. Called once each morning
// (07:30 via boot.js). Idempotent: appointments_tracked + job idempotency keys
// prevent duplicate reminders, so it's safe to re-run the same day.
const DAYS_AHEAD = parseInt(process.env.REMINDER_DAYS_AHEAD || '2', 10);

async function sweepDailyReminders(clinic) {
  if (!db.isEnabled()) return 0;

  const target = new Date();
  target.setDate(target.getDate() + DAYS_AHEAD);
  const dayStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;

  let appts;
  try {
    appts = await newsoft.getAppointmentsByDateRange(`${dayStr}T00:00:00.000`, `${dayStr}T23:59:59.000`);
  } catch (e) {
    console.error('[Reminder] Daily sweep — Newsoft fetch failed:', e.message);
    return 0;
  }

  const doctorIds = new Set((clinic.doctorIds || []).map(Number));
  let queued = 0, skipped = 0;

  for (const a of appts) {
    const phone = a.patientPhoneNumber || a.patientPhoneNumber2;
    // Real patient appointments only — known doctor (filters reception/admin
    // blocks like "Nao marcar"), has a phone, eligible status, real patient.
    if (doctorIds.size && !doctorIds.has(Number(a.medicId))) { skipped++; continue; }
    if (!phone || !a.appointmentId || !a.patientId) { skipped++; continue; }
    if (!isEligibleStatus(a.appointmentStatusCode)) { skipped++; continue; }

    const patientId = await upsertPatient({
      clinicId: clinic.id,
      newsoftPatientId: a.patientId,
      name: a.patientName,
      phone,
      language: null, // Newsoft has no language; upsert keeps any known value
    });

    const tracked = await db.one(
      `INSERT INTO appointments_tracked
         (clinic_id, patient_id, newsoft_appointment_id, appointment_at, status_code_at_send, source)
         VALUES ($1,$2,$3,$4,$5,'newsoft_sweep')
       ON CONFLICT (clinic_id, newsoft_appointment_id) DO UPDATE SET updated_at=now()
       RETURNING id, reminder_sent_at`,
      [clinic.id, patientId, String(a.appointmentId),
       a.appointmentDateBeginLocal || a.appointmentDateBegin, a.appointmentStatusCode || '']
    );
    if (tracked.reminder_sent_at) { skipped++; continue; } // already reminded

    await scheduler.enqueue({
      clinicId: clinic.id,
      type: JOB_REMINDER,
      runAt: new Date(),
      payload: { trackedId: tracked.id },
      idempotencyKey: `reminder:${clinic.id}:${a.appointmentId}`,
    });
    queued++;
  }

  console.log(`[Reminder] Daily sweep ${clinic.id} for ${dayStr}: ${queued} queued, ${skipped} skipped, ${appts.length} fetched`);
  return queued;
}

// ─── Job handler: send the WhatsApp reminder ───────────────────────────────────
async function handleReminderJob(payload) {
  const tracked = await db.one(
    `SELECT a.*, p.name, p.phone_e164, p.language, p.opt_out_whatsapp
       FROM appointments_tracked a JOIN patients p ON p.id = a.patient_id
      WHERE a.id = $1`, [payload.trackedId]
  );
  if (!tracked) return;

  // Re-check eligibility at send time (status may have changed since tracking).
  if (!isEligibleStatus(tracked.status_code_at_send) || tracked.confirm_status !== 'pending') {
    console.log(`[Reminder] Appt ${tracked.newsoft_appointment_id} no longer eligible — skip send`);
    return;
  }
  if (tracked.opt_out_whatsapp) { console.log('[Reminder] Patient opted out of WhatsApp'); return; }

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(tracked.clinic_id);
  if (!clinic) return;

  const when = new Date(tracked.appointment_at);
  const locale = tracked.language === 'en' ? 'en-GB' : 'pt-PT';
  const dateStr = when.toLocaleDateString(locale, { weekday: 'long', day: '2-digit', month: 'long' });
  const timeStr = when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const fName = wa.firstName(tracked.name, tracked.language);

  const sent = await wa.sendTemplate(clinic, tracked.phone_e164, clinic.whatsapp.templates.reminder, {
    lang: tracked.language === 'en' ? 'en' : 'pt_PT',
    bodyParams: [fName, clinic.name, dateStr, timeStr],
    // Button 0 = "Confirmar" (quick reply → confirms in Newsoft).
    // Button 1 in the template is a STATIC "Call phone number" CTA
    // (Remarcar/Cancelar → dials the clinic so a human handles it), which
    // needs no send-time component. We never auto-cancel from a button tap.
    buttons: [
      { index: 0, payload: `confirm:${tracked.id}` },
    ],
  });

  await db.query(`UPDATE appointments_tracked SET reminder_sent_at=now(), updated_at=now() WHERE id=$1`, [tracked.id]);
  if (sent) {
    await db.query(
      `INSERT INTO messages (clinic_id, patient_id, channel, direction, template_name, wa_message_id, status)
         VALUES ($1,$2,'whatsapp','out',$3,$4,'sent')`,
      [tracked.clinic_id, tracked.patient_id, clinic.whatsapp.templates.reminder, sent.messageId]
    );
  }

  // Schedule the confirm-call fallback for confirmCallLeadHours before the appt.
  const callAt = new Date(Math.max(Date.now() + 60_000, when.getTime() - clinic.confirmCallLeadHours * 3600_000));
  await scheduler.enqueue({
    clinicId: clinic.id,
    type: JOB_CONFIRM_CALL,
    runAt: callAt,
    payload: { trackedId: tracked.id },
    idempotencyKey: `confirmcall:${clinic.id}:${tracked.newsoft_appointment_id}`,
  });
}

// ─── Webhook entry: a Confirm/Cancel button was tapped ─────────────────────────
/**
 * Handle a quick-reply button payload of the form "confirm:<id>" / "cancel:<id>".
 * Idempotent: re-processing the same tap won't double-write.
 * @returns {boolean} whether the payload was a reminder button we handled
 */
async function handleButton(buttonPayload) {
  if (!db.isEnabled() || !buttonPayload) return false;
  const m = /^(confirm|cancel):(\d+)$/.exec(buttonPayload);
  if (!m) return false;
  const action = m[1];
  const trackedId = parseInt(m[2], 10);

  const tracked = await db.one(`SELECT * FROM appointments_tracked WHERE id=$1`, [trackedId]);
  if (!tracked) return true;
  if (tracked.confirm_status !== 'pending') {
    console.log(`[Reminder] Appt ${tracked.newsoft_appointment_id} already ${tracked.confirm_status} — ignore duplicate`);
    return true; // idempotent
  }

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(tracked.clinic_id);

  try {
    if (action === 'confirm') {
      await newsoft.confirmAppointment({ appointmentId: tracked.newsoft_appointment_id, channel: 'whatsapp' });
      await db.query(`UPDATE appointments_tracked SET confirm_status='confirmed', confirm_channel='whatsapp', updated_at=now() WHERE id=$1`, [trackedId]);
      console.log(`[Reminder] Appt ${tracked.newsoft_appointment_id} CONFIRMED via WhatsApp`);
      // Queue the post-visit review request.
      try { await require('./reviews').scheduleReview(clinic, trackedId); } catch (e) { console.error('[Reminder] scheduleReview failed:', e.message); }
    } else {
      await newsoft.cancelAppointment({ appointmentId: tracked.newsoft_appointment_id, reason: 'Cancelada pelo paciente via WhatsApp (Vicki)' });
      await db.query(`UPDATE appointments_tracked SET confirm_status='cancelled', confirm_channel='whatsapp', updated_at=now() WHERE id=$1`, [trackedId]);
      console.log(`[Reminder] Appt ${tracked.newsoft_appointment_id} CANCELLED via WhatsApp`);
    }
    // Either way, cancel the pending confirm-call fallback.
    await scheduler.cancelJobs({ type: JOB_CONFIRM_CALL, idempotencyKeyPrefix: `confirmcall:${clinic.id}:${tracked.newsoft_appointment_id}` });
  } catch (e) {
    console.error(`[Reminder] Newsoft write-back failed for appt ${tracked.newsoft_appointment_id}:`, e.message);
    throw e; // let webhook layer decide; status stays pending so it can retry
  }
  return true;
}

/** Register the reminder job handler. Confirm-call handler is registered by outbound module. */
function register() {
  scheduler.registerHandler(JOB_REMINDER, handleReminderJob);
}

module.exports = {
  trackAppointment, sweepDailyReminders, handleButton, register,
  isEligibleStatus,
  handleReminderJob, // exported for tests
  JOB_REMINDER, JOB_CONFIRM_CALL,
};
