// ============================================================
// VICKI AI — Lifecycle: Booking Verification (post-call backstop)
//
// The in-call verify-after-write (src/aiLogic.js booking case) is best-effort
// and can be skipped if the call drops right after Newsoft returns an id. This
// module guarantees EVERY claimed booking is checked against the EHR:
//
//   • scheduleVerification(...) — enqueue a `verify_booking` job ~2 min after a
//     call that produced a real Newsoft appointmentId (called from
//     logCallTranscript). The delay lets Newsoft settle (read-after-write).
//   • handleVerifyJob — re-read the patient's appointments; FOUND → stamp
//     booking_verified_at; NOT FOUND → fire a one-time staff alert.
//   • alertMismatchOnce — shared, de-duped Telegram alert (also used by the
//     reconciliation sweep) so a given call is only ever flagged once.
//
// Safe-by-default: every path no-ops when the DB is disabled. `verify_booking`
// is NOT an outbound-send job, so LIFECYCLE_SEND=off does not silence it.
// ============================================================

const db        = require('../db');
const scheduler = require('../scheduler');
const newsoft   = require('../newsoftApi');

const JOB_VERIFY = 'verify_booking';
const VERIFY_DELAY_MS = parseInt(process.env.BOOKING_VERIFY_DELAY_MS || '120000', 10); // 2 min

function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 4 ? `***${s.slice(-4)}` : (s || '?');
}

/** True if Newsoft shows an appointment with this id for this patient. */
async function appointmentExists(patientId, appointmentId) {
  if (!patientId || !appointmentId) return false;
  const appts = await newsoft.getPatientAppointments(patientId);
  if (!Array.isArray(appts)) return false;
  return appts.some(a => String(a.appointmentId) === String(appointmentId));
}

/**
 * Fire a staff Telegram alert for a call that claimed a booking the EHR can't
 * confirm — exactly once per call_logs row. Dedupe reuses the jobs table's
 * UNIQUE idempotency_key (a conflict means "already alerted").
 */
async function alertMismatchOnce(row) {
  if (!db.isEnabled()) return false;
  const key = `reconcilealert:${row.id}`;
  // De-dupe: one alert per call_logs row. Check-then-insert (the ON CONFLICT is a
  // backstop for the rare concurrent-sweep race).
  const existing = await db.one(`SELECT id FROM jobs WHERE idempotency_key=$1`, [key]);
  if (existing) return false;
  try {
    await db.query(
      `INSERT INTO jobs (clinic_id, type, run_at, status, payload, idempotency_key)
         VALUES ($1, 'reconcile_alert', now(), 'done', $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [row.clinic_id || null, JSON.stringify({ callLogId: row.id }), key]
    );
  } catch (_) { return false; } // unique race — someone else alerted first

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const adminKey = process.env.ADMIN_KEY || 'vicki2025';
  const link = base ? `${base}/calls/${row.id}?key=${encodeURIComponent(adminKey)}` : `call_logs id=${row.id}`;
  const msg = [
    '🚨 *RESERVA NÃO CONFIRMADA NO NEWSOFT*',
    `👤 ${row.patient_name || 'Desconhecido'}  📱 ${maskPhone(row.caller_number)}`,
    `🗓 Chamada: ${row.created_at ? new Date(row.created_at).toISOString().slice(0, 16).replace('T', ' ') : '?'}`,
    row.newsoft_appointment_id ? `🆔 Marcação alegada: ${row.newsoft_appointment_id}` : '🆔 (sem id — Vicki alegou marcação sem reserva real)',
    'A Vicki reportou marcação mas o Newsoft não tem a consulta. Verificar manualmente.',
    `📄 ${link}`,
  ].join('\n');
  try { await require('../telegramBot').notify(msg); } catch (e) { console.error('[BookingVerify] alert failed:', e.message); }
  return true;
}

/** Enqueue a post-call verification for a booking that returned a real id. */
async function scheduleVerification({ callLogId, clinicId, patientId, appointmentId }) {
  if (!db.isEnabled() || !callLogId || !appointmentId) return null;
  return scheduler.enqueue({
    clinicId: clinicId || null,
    type: JOB_VERIFY,
    runAt: new Date(Date.now() + VERIFY_DELAY_MS),
    payload: { callLogId, patientId: patientId != null ? String(patientId) : null, appointmentId: String(appointmentId) },
    idempotencyKey: `verifybooking:${callLogId}`,
  });
}

// ─── Job handler ─────────────────────────────────────────────────────────────
async function handleVerifyJob(payload) {
  const { callLogId, patientId, appointmentId } = payload || {};
  if (!callLogId || !appointmentId) return;

  // Already verified (e.g. by the in-call read)? Nothing to do.
  const row = await db.one(`SELECT * FROM call_logs WHERE id=$1`, [callLogId]);
  if (!row || row.booking_verified_at) return;

  const exists = await appointmentExists(patientId, appointmentId);
  if (exists) {
    await db.query(`UPDATE call_logs SET booking_verified_at=now() WHERE id=$1`, [callLogId]);
    console.log(`[BookingVerify] ✅ call ${callLogId} appointment ${appointmentId} confirmed in Newsoft`);
  } else {
    console.error(`[BookingVerify] ❌ call ${callLogId} appointment ${appointmentId} NOT found in Newsoft — alerting`);
    await alertMismatchOnce(row);
  }
}

function register() {
  scheduler.registerHandler(JOB_VERIFY, handleVerifyJob);
}

module.exports = { register, scheduleVerification, handleVerifyJob, alertMismatchOnce, appointmentExists, JOB_VERIFY };
