// ============================================================
// booking-persist-it.js — integration test (in-memory Postgres)
//
// Locks the "never miss / never falsely report a booking" workflow:
//   • logCallTranscript persists the REAL Newsoft appointmentId + verified ts.
//   • a claimed booking that isn't verified in-call enqueues a verify_booking job.
//   • bookingVerify.handleVerifyJob: FOUND → stamps verified; MISSING → alerts once.
//   • reconcile.sweep: pure LLM "booked" with no id → alerts; id present + found
//     in Newsoft → self-heals (backfills verified); dedupe holds across runs.
//
// Run: node scripts/booking-persist-it.js   (requires devDep pg-mem; no network)
// ============================================================
process.env.VICKI_DRY_RUN   = '1';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || 'test-key';
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'test-key';
process.env.RECONCILE_GRACE_MIN = '10';

const fs = require('fs');
const path = require('path');

let newDb;
try { ({ newDb } = require('pg-mem')); }
catch { console.log('SKIP: pg-mem not installed (npm i -D pg-mem to run)'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const mem = newDb();
mem.public.registerFunction({ name: 'now', returns: 'timestamptz', implementation: () => new Date() });
const memPool = new (mem.adapters.createPg().Pool)();

const db = require(path.join(ROOT, 'src/db'));
db.query = (t, p) => memPool.query(t, p);
db.one   = async (t, p) => (await memPool.query(t, p)).rows[0] || null;
db.many  = async (t, p) => (await memPool.query(t, p)).rows;
db.isEnabled = () => true;

// Mutable dry Newsoft provider — control what the verify re-read returns.
let apptsToReturn = [];
const newsoft = require(path.join(ROOT, 'src/newsoftApi'));
newsoft.__setDryRunProvider({ getPatientAppointments: async () => apptsToReturn });

// Capture Telegram alerts instead of sending.
const telegram = require(path.join(ROOT, 'src/telegramBot'));
let alerts = [];
telegram.notify = async (msg) => { alerts.push(msg); };

const { logCallTranscript } = require(path.join(ROOT, 'src/patientMemory'));
const bookingVerify = require(path.join(ROOT, 'src/lifecycle/bookingVerify'));
const reconcile     = require(path.join(ROOT, 'src/lifecycle/reconcile'));

let failures = 0;
const ok = (c, m) => { if (!c) { failures++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const flush = () => new Promise(r => setTimeout(r, 60));

(async () => {
  await memPool.query(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'));
  // Seed the clinic so jobs.clinic_id FK is satisfied (synced from .env at boot in prod).
  await memPool.query(`INSERT INTO clinics (id, name, config) VALUES ('loule','Loulé Test','{}') ON CONFLICT (id) DO NOTHING`);

  // ── [1] logCallTranscript persists the real id + enqueues a verify job ──────
  console.log('\n[1] persist real appointmentId + enqueue verify');
  const id1 = await logCallTranscript({
    clinicId: 'loule', patientId: '57125', patientName: 'Maria Leonor', callerNumber: '+351966716400',
    outcome: 'booked', intent: 'booking', actionFired: 'book_appointment',
    newsoftAppointmentId: 'SIM_1', bookingVerifiedAt: null,
    transcript: [], flags: [],
  });
  const row1 = await db.one(`SELECT * FROM call_logs WHERE id=$1`, [id1]);
  ok(row1 && row1.newsoft_appointment_id === 'SIM_1', 'newsoft_appointment_id persisted');
  ok(row1 && row1.booking_verified_at == null, 'booking_verified_at null until verified');
  await flush();
  const job1 = await db.one(`SELECT * FROM jobs WHERE type='verify_booking' AND idempotency_key=$1`, [`verifybooking:${id1}`]);
  ok(!!job1, 'verify_booking job enqueued for unverified booking');

  // ── [2] handleVerifyJob — FOUND → stamps booking_verified_at ─────────────────
  console.log('\n[2] post-call verify: appointment found in Newsoft');
  apptsToReturn = [{ appointmentId: 'SIM_1', appointmentDate: '2026-07-02', appointmentTime: '14:00' }];
  await bookingVerify.handleVerifyJob({ callLogId: id1, patientId: '57125', appointmentId: 'SIM_1' });
  const row1b = await db.one(`SELECT booking_verified_at FROM call_logs WHERE id=$1`, [id1]);
  ok(row1b && row1b.booking_verified_at != null, 'booking_verified_at set when Newsoft confirms');

  // ── [3] handleVerifyJob — MISSING → alerts once (dedupe holds) ───────────────
  console.log('\n[3] post-call verify: appointment NOT in Newsoft → alert once');
  const id3 = await logCallTranscript({
    clinicId: 'loule', patientId: '999', patientName: 'Ghost Patient', callerNumber: '+351900000000',
    outcome: 'booked', intent: 'booking', actionFired: 'book_appointment',
    newsoftAppointmentId: 'SIM_GHOST', bookingVerifiedAt: null, transcript: [], flags: [],
  });
  apptsToReturn = []; // Newsoft does NOT have it (the call #54 signature)
  alerts = [];
  await bookingVerify.handleVerifyJob({ callLogId: id3, patientId: '999', appointmentId: 'SIM_GHOST' });
  ok(alerts.length === 1, 'mismatch alert fired once');
  await bookingVerify.handleVerifyJob({ callLogId: id3, patientId: '999', appointmentId: 'SIM_GHOST' });
  ok(alerts.length === 1, 'no duplicate alert on re-run (dedupe)');
  const row3 = await db.one(`SELECT booking_verified_at FROM call_logs WHERE id=$1`, [id3]);
  ok(row3 && row3.booking_verified_at == null, 'unconfirmed booking stays unverified');

  // ── [4] reconcile.sweep — pure LLM "booked" with NO id → alert ───────────────
  console.log('\n[4] reconcile: LLM said booked but no real reservation');
  const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago (outside the 10-min grace)
  const ins = await db.one(
    `INSERT INTO call_logs (clinic_id, patient_name, caller_number, outcome, action_fired, created_at)
       VALUES ('loule','False Booking','+351911111111','booked',null,$1) RETURNING id`, [past]);
  alerts = [];
  const r4 = await reconcile.sweep({ id: 'loule' });
  ok(alerts.length === 1, 'reconcile alerted on the false booking');
  ok(r4.alerted === 1, 'sweep reports 1 alert');
  const r4b = await reconcile.sweep({ id: 'loule' });
  ok(alerts.length === 1, 'reconcile does not re-alert (dedupe)');

  // ── [5] reconcile.sweep — id present + found in Newsoft → self-heal ──────────
  console.log('\n[5] reconcile: unverified booking that DOES exist → heal');
  const heal = await db.one(
    `INSERT INTO call_logs (clinic_id, newsoft_patient_id, newsoft_appointment_id, patient_name, outcome, action_fired, created_at)
       VALUES ('loule','321','SIM_HEAL','Heal Me','booked','book_appointment',$1) RETURNING id`, [past]);
  apptsToReturn = [{ appointmentId: 'SIM_HEAL', appointmentDate: '2026-07-10', appointmentTime: '09:00' }];
  alerts = [];
  await reconcile.sweep({ id: 'loule' });
  const healed = await db.one(`SELECT booking_verified_at FROM call_logs WHERE id=$1`, [heal.id]);
  ok(healed && healed.booking_verified_at != null, 'reconcile backfilled booking_verified_at');
  ok(alerts.length === 0, 'no alert when the appointment really exists');

  // ── [6] reconcile.sweep — respects the grace window (recent rows skipped) ────
  console.log('\n[6] reconcile: recent row inside grace window is not swept');
  const recent = new Date(Date.now() - 60 * 1000); // 1 min ago (inside 10-min grace)
  await db.one(
    `INSERT INTO call_logs (clinic_id, patient_name, outcome, created_at)
       VALUES ('loule','Too Recent','booked',$1) RETURNING id`, [recent]);
  alerts = [];
  const r6 = await reconcile.sweep({ id: 'loule' });
  ok(alerts.length === 0, 'recent row not alerted (grace window respected)');

  console.log(`\nbooking-persist: ${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
