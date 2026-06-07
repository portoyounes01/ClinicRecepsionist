// ============================================================
// VICKI AI — Lifecycle: Recare (6-month hygiene recall)
//
// The dental goldmine: bring patients back for routine cleanings.
//
// A daily sweep finds patients whose recare_due_date has arrived,
// who have NO upcoming appointment and haven't opted out, and sends
// a WhatsApp "time for your cleaning" template with a booking button.
// On tap, we route them to booking (link or outbound call) — wired in
// routes.routeButton later.
//
// recare_due_date is set when we learn a patient's last visit (from
// Newsoft sync or after an attended appointment): last_visit + N months.
// ============================================================

const db        = require('../db');
const scheduler = require('../scheduler');
const wa        = require('../integrations/whatsapp');

const JOB_RECARE = 'recare';

/** Set/refresh a patient's recare due date = lastVisit + interval. */
async function setRecareDue(clinic, patientDbId, lastVisitDate) {
  if (!db.isEnabled() || !lastVisitDate) return;
  const due = new Date(lastVisitDate);
  due.setMonth(due.getMonth() + (clinic.recareIntervalMonths || 6));
  await db.query(
    `UPDATE patients SET last_visit=$2, recare_due_date=$3, updated_at=now() WHERE id=$1`,
    [patientDbId, lastVisitDate, due.toISOString().slice(0, 10)]
  );
}

/** Daily sweep: enqueue a recare message per due patient. */
async function sweep() {
  if (!db.isEnabled()) return;
  const { allClinics } = require('../clinics/registry');

  for (const clinic of allClinics()) {
    // Due today or earlier, not opted out, and no future appointment tracked.
    const due = await db.many(
      `SELECT p.* FROM patients p
        WHERE p.clinic_id=$1
          AND p.opt_out_whatsapp = false
          AND p.recare_due_date IS NOT NULL
          AND p.recare_due_date <= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM appointments_tracked a
             WHERE a.patient_id = p.id
               AND a.appointment_at > now()
               AND a.confirm_status <> 'cancelled'
          )`,
      [clinic.id]
    );

    for (const p of due) {
      await scheduler.enqueue({
        clinicId: clinic.id,
        type: JOB_RECARE,
        runAt: new Date(),
        payload: { patientId: p.id },
        // due-date in key => one recare per due cycle (re-runs next cycle).
        idempotencyKey: `recare:${clinic.id}:${p.id}:${p.recare_due_date}`,
      });
    }
    if (due.length) console.log(`[Recare] ${clinic.id}: queued ${due.length} recare message(s)`);
  }
}

async function handleRecareJob(payload) {
  const p = await db.one(`SELECT * FROM patients WHERE id=$1`, [payload.patientId]);
  if (!p || p.opt_out_whatsapp) return;

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(p.clinic_id);
  if (!clinic) return;

  const lang = require('../lang').pickLang(p.language, p.phone_e164);
  const sent = await wa.sendTemplate(clinic, p.phone_e164, clinic.whatsapp.templates.recare, {
    lang: lang === 'en' ? 'en' : 'pt_PT',
    bodyParams: [wa.firstName(p.name, lang), clinic.name],
    buttons: [{ index: 0, payload: `recare_book:${p.id}` }],
  });
  if (sent) {
    await db.query(
      `INSERT INTO messages (clinic_id, patient_id, channel, direction, template_name, wa_message_id, status)
         VALUES ($1,$2,'whatsapp','out',$3,$4,'sent')`,
      [clinic.id, p.id, clinic.whatsapp.templates.recare, sent.messageId]
    );
  }
  // Push the next recare cycle out so we don't re-nudge immediately.
  const next = new Date();
  next.setMonth(next.getMonth() + (clinic.recareIntervalMonths || 6));
  await db.query(`UPDATE patients SET recare_due_date=$2, updated_at=now() WHERE id=$1`,
    [p.id, next.toISOString().slice(0, 10)]);
}

function register() {
  scheduler.registerHandler(JOB_RECARE, handleRecareJob);
}

module.exports = { setRecareDue, sweep, register, JOB_RECARE };
