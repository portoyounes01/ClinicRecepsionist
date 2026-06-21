// ============================================================
// VICKI AI — Lifecycle: Booking Reconciliation Sweep
//
// Final safety net. Periodically re-checks recent call_logs rows that CLAIM a
// booking but are not yet verified, against the Newsoft EHR:
//
//   • FOUND   → backfill booking_verified_at (self-heals rows whose in-call /
//               post-call verify was skipped).
//   • MISSING → fire a one-time staff alert (shared, de-duped helper).
//
// The query's `OR outcome='booked'` clause is the net that catches the exact
// call #54 signature: a row Vicki labelled "booked" that has NO real
// appointmentId and was never verified.
//
// Read-only against Newsoft + idempotent alerts. No-op when DB is disabled.
// ============================================================

const db = require('../db');
const { appointmentExists, alertMismatchOnce } = require('./bookingVerify');

const LOOKBACK_HOURS = parseInt(process.env.RECONCILE_LOOKBACK_HOURS || '48', 10);
const GRACE_MINUTES  = parseInt(process.env.RECONCILE_GRACE_MIN || '10', 10); // let in-call/post-call verify go first
const SWEEP_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || String(30 * 60 * 1000), 10); // 30 min

/**
 * Sweep one clinic. Returns { checked, healed, alerted }.
 * @param {object} clinic - { id }
 */
async function sweep(clinic) {
  if (!db.isEnabled()) return { checked: 0, healed: 0, alerted: 0 };
  const clinicId = clinic?.id || null;

  // Compute the time window in JS (portable: no SQL interval-cast needed).
  const nowMs = Date.now();
  const lookbackCutoff = new Date(nowMs - LOOKBACK_HOURS * 3600 * 1000);
  const graceCutoff    = new Date(nowMs - GRACE_MINUTES * 60 * 1000);
  const params = [lookbackCutoff, graceCutoff];
  let clinicFilter = '';
  if (clinicId) { params.push(clinicId); clinicFilter = `AND clinic_id = $${params.length}`; }

  let rows;
  try {
    rows = await db.many(
      `SELECT id, clinic_id, newsoft_patient_id, newsoft_appointment_id,
              patient_name, caller_number, outcome, action_fired, created_at
         FROM call_logs
        WHERE created_at >= $1 AND created_at < $2
          AND booking_verified_at IS NULL
          ${clinicFilter}
          AND (newsoft_appointment_id IS NOT NULL
               OR action_fired = 'book_appointment'
               OR outcome = 'booked')
        ORDER BY created_at DESC
        LIMIT 200`,
      params
    );
  } catch (e) {
    console.error('[Reconcile] query failed:', e.message);
    return { checked: 0, healed: 0, alerted: 0 };
  }

  let healed = 0, alerted = 0;
  for (const row of rows) {
    // No real id AND no patient id → nothing to re-read; this is a pure LLM
    // "booked" claim with no booking → straight to the alert (de-duped).
    if (!row.newsoft_appointment_id || !row.newsoft_patient_id) {
      if (await alertMismatchOnce(row)) alerted++;
      continue;
    }
    let exists;
    try {
      exists = await appointmentExists(row.newsoft_patient_id, row.newsoft_appointment_id);
    } catch (e) {
      // Newsoft read error — don't alert on a transient failure; next tick retries.
      console.error(`[Reconcile] Newsoft read failed for call ${row.id}:`, e.message);
      continue;
    }
    if (exists) {
      await db.query(`UPDATE call_logs SET booking_verified_at=now() WHERE id=$1`, [row.id]);
      healed++;
    } else if (await alertMismatchOnce(row)) {
      alerted++;
    }
  }

  if (rows.length) console.log(`[Reconcile] ${clinicId || 'all'}: checked ${rows.length}, healed ${healed}, alerted ${alerted}`);
  return { checked: rows.length, healed, alerted };
}

let _timer = null;

/** Start the periodic sweep across all clinics. No-op if DB disabled. */
function start() {
  if (!db.isEnabled()) { console.warn('[Reconcile] DB disabled — sweep not started'); return; }
  if (_timer) return;
  const { allClinics } = require('../clinics/registry');
  const run = async () => {
    for (const clinic of allClinics()) {
      try { await sweep(clinic); } catch (e) { console.error('[Reconcile] sweep error:', e.message); }
    }
  };
  console.log(`[Reconcile] Started — sweeping every ${Math.round(SWEEP_INTERVAL_MS / 60000)} min`);
  setTimeout(run, 90_000);                 // initial run ~90s after boot
  _timer = setInterval(run, SWEEP_INTERVAL_MS);
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { sweep, start, stop };
