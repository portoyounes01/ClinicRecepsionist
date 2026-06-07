// ============================================================
// VICKI AI — Lifecycle: Database Reactivation
//
// Re-engage DORMANT patients: no visit in a long time, no upcoming
// appointment, and recare nudges already exhausted. Sends an occasional
// "we'd love to see you again" WhatsApp template, frequency-capped and
// opt-out respected.
//
// Conservative by design: a wide net here = spam complaints + WhatsApp
// quality-rating damage. We cap to one reactivation per patient per
// REACTIVATION_COOLDOWN_DAYS and only target the genuinely dormant.
// ============================================================

const db        = require('../db');
const scheduler = require('../scheduler');
const wa        = require('../integrations/whatsapp');

const JOB_REACTIVATION = 'reactivation';

const DORMANT_MONTHS   = parseInt(process.env.REACTIVATION_DORMANT_MONTHS || '12', 10);
const COOLDOWN_DAYS    = parseInt(process.env.REACTIVATION_COOLDOWN_DAYS || '180', 10);
const BATCH_PER_SWEEP  = parseInt(process.env.REACTIVATION_BATCH || '50', 10); // protect WA quality rating

/** Daily sweep: enqueue reactivation for a capped batch of dormant patients. */
async function sweep() {
  if (!db.isEnabled()) return;
  const { allClinics } = require('../clinics/registry');

  for (const clinic of allClinics()) {
    const dormant = await db.many(
      `SELECT p.* FROM patients p
        WHERE p.clinic_id=$1
          AND p.opt_out_whatsapp = false
          AND p.last_visit IS NOT NULL
          AND p.last_visit < (CURRENT_DATE - ($2 || ' months')::interval)
          AND NOT EXISTS (
            SELECT 1 FROM appointments_tracked a
             WHERE a.patient_id = p.id AND a.appointment_at > now()
               AND a.confirm_status <> 'cancelled'
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.patient_id = p.id AND m.template_name = $3
               AND m.created_at > (now() - ($4 || ' days')::interval)
          )
        ORDER BY p.last_visit ASC
        LIMIT $5`,
      [clinic.id, String(DORMANT_MONTHS), reactivationTemplate(clinic), String(COOLDOWN_DAYS), BATCH_PER_SWEEP]
    );

    for (const p of dormant) {
      await scheduler.enqueue({
        clinicId: clinic.id,
        type: JOB_REACTIVATION,
        runAt: new Date(),
        payload: { patientId: p.id },
        idempotencyKey: `reactivation:${clinic.id}:${p.id}:${monthStamp()}`,
      });
    }
    if (dormant.length) {
      console.log(`[Reactivation] ${clinic.id}: queued ${dormant.length} (capped at ${BATCH_PER_SWEEP})`);
    }
  }
}

// Reactivation reuses the recare template by default unless a dedicated one is set.
function reactivationTemplate(clinic) {
  return process.env.WHATSAPP_TEMPLATE_REACTIVATION || clinic.whatsapp.templates.recare;
}

// Coarse month stamp for the idempotency key (one reactivation/patient/month max).
// Note: scheduler also enforces COOLDOWN_DAYS via the sweep query above.
function monthStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
}

async function handleReactivationJob(payload) {
  const p = await db.one(`SELECT * FROM patients WHERE id=$1`, [payload.patientId]);
  if (!p || p.opt_out_whatsapp) return;

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(p.clinic_id);
  if (!clinic) return;

  const tmpl = reactivationTemplate(clinic);
  const lang = require('../lang').pickLang(p.language, p.phone_e164);
  const sent = await wa.sendTemplate(clinic, p.phone_e164, tmpl, {
    lang: lang === 'en' ? 'en' : 'pt_PT',
    bodyParams: [wa.firstName(p.name, lang), clinic.name],
    buttons: [{ index: 0, payload: `recare_book:${p.id}` }],
  });
  if (sent) {
    await db.query(
      `INSERT INTO messages (clinic_id, patient_id, channel, direction, template_name, wa_message_id, status)
         VALUES ($1,$2,'whatsapp','out',$3,$4,'sent')`,
      [clinic.id, p.id, tmpl, sent.messageId]
    );
  }
}

function register() {
  scheduler.registerHandler(JOB_REACTIVATION, handleReactivationJob);
}

module.exports = { sweep, register, JOB_REACTIVATION };
