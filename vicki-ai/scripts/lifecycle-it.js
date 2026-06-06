// ============================================================
// VICKI AI — Lifecycle Integration Test (in-memory Postgres)
//
// Exercises the headline flows against a real SQL engine (pg-mem):
//   eligibility filter, reminder send, confirm/cancel webhook,
//   Newsoft write-back, confirm-call scheduling/cancellation,
//   review gating (<4 apology + receptionist notify, >=4 Google),
//   and idempotency.
//
// Run: node scripts/lifecycle-it.js   (requires devDep pg-mem)
// No network, no real DB — safe to run anywhere.
// ============================================================

const fs = require('fs');
const path = require('path');

process.env.VICKI_DRY_RUN = '1';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.GOOGLE_REVIEW_URL = 'https://g.page/r/test/review';

let newDb;
try { ({ newDb } = require('pg-mem')); }
catch { console.log('SKIP: pg-mem not installed (npm i -D pg-mem to run)'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const mem = newDb();
mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
const memPool = new (mem.adapters.createPg().Pool)();

// Inject pg-mem into the db layer.
const db = require(path.join(ROOT, 'src/db'));
db.query = (t, p) => memPool.query(t, p);
db.one   = async (t, p) => (await memPool.query(t, p)).rows[0] || null;
db.many  = async (t, p) => (await memPool.query(t, p)).rows;
db.isEnabled = () => true;

// Dry Newsoft provider so confirm/cancel never hit the network.
const newsoft = require(path.join(ROOT, 'src/newsoftApi'));
const fx = { confirmed: [], cancelled: [] };
newsoft.__setDryRunProvider({
  confirmAppointment: async ({ appointmentId }) => { fx.confirmed.push(appointmentId); return { ok: true }; },
  cancelAppointment:  async ({ appointmentId }) => { fx.cancelled.push(appointmentId); return { ok: true }; },
});

const reminder = require(path.join(ROOT, 'src/lifecycle/reminder'));
const reviews  = require(path.join(ROOT, 'src/lifecycle/reviews'));
const { getDefaultClinic, syncClinicsToDb } = require(path.join(ROOT, 'src/clinics/registry'));

let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };

// Drive due jobs through the exported handlers (pg-mem lacks SKIP LOCKED,
// which the real scheduler uses; the production claim query is valid PG).
// We force pending jobs due first so the test doesn't wait real hours —
// the scheduler's run_at gating itself is verified separately in [2b].
async function drainJobs() {
  await db.query(`UPDATE jobs SET run_at = now() - interval '1 minute' WHERE status='pending'`);
  const due = await db.many(`SELECT * FROM jobs WHERE status='pending' AND run_at <= now() ORDER BY run_at ASC`);
  for (const job of due) {
    await db.query(`UPDATE jobs SET status='running' WHERE id=$1`, [job.id]);
    try {
      if (job.type === 'reminder_whatsapp') await reminder.handleReminderJob(job.payload);
      else if (job.type === 'review_request') await reviews.handleReviewRequestJob(job.payload);
      else if (job.type === 'review_nudge') await reviews.handleReviewNudgeJob(job.payload);
      await db.query(`UPDATE jobs SET status='done' WHERE id=$1`, [job.id]);
    } catch (e) {
      await db.query(`UPDATE jobs SET status='failed', last_error=$2 WHERE id=$1`, [job.id, e.message]);
      console.error('   job error:', e.message);
    }
  }
}

(async () => {
  await memPool.query(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'));
  reminder.register(); reviews.register();
  const clinic = getDefaultClinic();
  await syncClinicsToDb();

  const base = {
    appointmentAt: new Date(Date.now() + 72 * 3600e3).toISOString(),
    patient: { newsoftPatientId: 'P1', name: 'Joana', phone: '912345678', language: 'pt' },
    source: 'test',
  };

  console.log('\n[1] Eligibility filter (empty status only)');
  const tE = await reminder.trackAppointment(clinic, { ...base, newsoftAppointmentId: 'A-empty', statusCode: '' });
  const tC = await reminder.trackAppointment(clinic, { ...base, newsoftAppointmentId: 'A-C', statusCode: 'C', patient: { ...base.patient, newsoftPatientId: 'P2' } });
  const tX = await reminder.trackAppointment(clinic, { ...base, newsoftAppointmentId: 'A-e', statusCode: 'e', patient: { ...base.patient, newsoftPatientId: 'P3' } });
  ok(tE, 'empty-status appt tracked');
  ok(tC === null, 'status "C" skipped');
  ok(tX === null, 'status "e" skipped');
  ok(String((await db.one(`SELECT count(*) n FROM appointments_tracked`)).n) === '1', 'exactly 1 tracked');

  console.log('\n[2] Reminder send -> confirm_call scheduled');
  // 2b: reminder is scheduled in the FUTURE (48h before a 72h-away appt ≈ +24h)
  const remJobBefore = await db.one(`SELECT run_at FROM jobs WHERE type='reminder_whatsapp'`);
  ok(new Date(remJobBefore.run_at).getTime() > Date.now() + 60_000, 'reminder scheduled for the future (lead time honored)');
  await drainJobs();
  ok((await db.one(`SELECT reminder_sent_at FROM appointments_tracked WHERE id=$1`, [tE])).reminder_sent_at, 'reminder marked sent');
  ok(await db.one(`SELECT 1 FROM jobs WHERE type='confirm_call'`), 'confirm_call fallback scheduled');

  console.log('\n[3] Confirm button webhook');
  ok(await reminder.handleButton(`confirm:${tE}`), 'confirm button handled');
  const cs = await db.one(`SELECT confirm_status, confirm_channel FROM appointments_tracked WHERE id=$1`, [tE]);
  ok(cs.confirm_status === 'confirmed' && cs.confirm_channel === 'whatsapp', 'confirmed via whatsapp');
  ok(fx.confirmed.includes('A-empty'), 'Newsoft confirmAppointment called');
  ok((await db.one(`SELECT status FROM jobs WHERE type='confirm_call'`)).status === 'cancelled', 'confirm_call cancelled after confirm');
  ok(await db.one(`SELECT 1 FROM jobs WHERE type='review_request'`), 'review_request scheduled after confirm');
  ok(await reminder.handleButton(`confirm:${tE}`), 'duplicate confirm idempotent (no throw)');

  console.log('\n[4] Review gating (>=4 Google, <4 apology+notify)');
  await drainJobs();
  const rev = await db.one(`SELECT token FROM reviews LIMIT 1`);
  ok(rev && rev.token, 'review token created');
  const high = await reviews.submitReview(rev.token, 5, 'Excelente!');
  ok(high.gate === 'google' && high.googleUrl.includes('g.page'), '5★ routes to Google');
  const t2 = await reminder.trackAppointment(clinic, { ...base, newsoftAppointmentId: 'A2', statusCode: '', patient: { ...base.patient, newsoftPatientId: 'P9' } });
  await reviews.scheduleReview(clinic, t2);
  const rev2 = await db.one(`SELECT token FROM reviews WHERE appointment_id=$1`, [t2]);
  const low = await reviews.submitReview(rev2.token, 2, 'Demorou');
  ok(low.gate === 'apology', '2★ routes to apology');
  const l2 = await db.one(`SELECT sent_to_google, receptionist_notified FROM reviews WHERE token=$1`, [rev2.token]);
  ok(l2.sent_to_google === false, '2★ NOT sent to Google');
  ok(l2.receptionist_notified === true, 'receptionist notified for 2★');

  console.log('\n[5] Cancel button webhook');
  const t3 = await reminder.trackAppointment(clinic, { ...base, newsoftAppointmentId: 'A3', statusCode: '', patient: { ...base.patient, newsoftPatientId: 'P10' } });
  await reminder.handleButton(`cancel:${t3}`);
  ok((await db.one(`SELECT confirm_status FROM appointments_tracked WHERE id=$1`, [t3])).confirm_status === 'cancelled', 'cancel button cancels appt');
  ok(fx.cancelled.includes('A3'), 'Newsoft cancelAppointment called');

  console.log('\n' + (failures ? `FAILED (${failures} assertion failures)` : 'ALL LIFECYCLE INTEGRATION TESTS PASSED'));
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
