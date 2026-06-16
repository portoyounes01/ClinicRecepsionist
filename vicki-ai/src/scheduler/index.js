// ============================================================
// VICKI AI — Lifecycle Job Scheduler
//
// DB-backed due-time queue. Lifecycle modules register a handler
// per job type; the poller claims due jobs and dispatches them.
//
// Design notes:
//   • Claim-with-lock (UPDATE ... RETURNING) so two poller ticks
//     (or two instances) never run the same job twice.
//   • idempotency_key on enqueue prevents duplicate scheduling.
//   • Retries with backoff up to MAX_ATTEMPTS, then status=failed.
//   • No-op if the DB is disabled (lifecycle off) — inbound flow
//     is completely unaffected.
// ============================================================

const db = require('../db');

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_MS || '60000', 10); // 1 min
const BATCH_SIZE       = parseInt(process.env.SCHEDULER_BATCH || '20', 10);
const MAX_ATTEMPTS     = parseInt(process.env.SCHEDULER_MAX_ATTEMPTS || '5', 10);

const _handlers = new Map(); // type -> async (payload, job) => void

/** Register a handler for a job type. */
function registerHandler(type, fn) {
  _handlers.set(type, fn);
}

/**
 * Enqueue a job. idempotencyKey makes the insert a no-op if a job with
 * the same key already exists (returns null then).
 *
 * @returns {Promise<{id}|null>}
 */
async function enqueue({ clinicId, type, runAt, payload = {}, idempotencyKey = null }) {
  if (!db.isEnabled()) { console.warn(`[Scheduler] DB disabled — cannot enqueue ${type}`); return null; }
  const row = await db.one(
    `INSERT INTO jobs (clinic_id, type, run_at, payload, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [clinicId || null, type, runAt, JSON.stringify(payload), idempotencyKey]
  );
  if (row) console.log(`[Scheduler] Enqueued ${type} (job ${row.id}) for ${new Date(runAt).toISOString()}`);
  return row;
}

/** Cancel pending jobs matching a type + payload key (e.g. when an appt is cancelled). */
async function cancelJobs({ type, idempotencyKeyPrefix }) {
  if (!db.isEnabled()) return 0;
  const res = await db.query(
    `UPDATE jobs SET status='cancelled', updated_at=now()
      WHERE status='pending' AND type=$1
        AND ($2::text IS NULL OR idempotency_key LIKE $2 || '%')`,
    [type, idempotencyKeyPrefix || null]
  );
  return res.rowCount;
}

// ─── Claim + run ───────────────────────────────────────────────────────────────
async function claimDueJobs() {
  // Atomically grab a batch of due, pending jobs and mark them running.
  return db.many(
    `UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1, updated_at=now()
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status='pending' AND run_at <= now()
         ORDER BY run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [BATCH_SIZE]
  );
}

function backoffMs(attempts) {
  return Math.min(60 * 60 * 1000, Math.pow(2, attempts) * 60 * 1000); // 2^n min, cap 1h
}

// Job types that SEND an outbound message to a patient. The master kill-switch
// (LIFECYCLE_SEND=off) skips these so NO reminder/recare/reactivation/confirm/
// review goes out. Inbound reply-handling jobs are not in this list.
const OUTBOUND_SEND_JOBS = new Set([
  'reminder_whatsapp', 'confirm_call', 'review_request', 'review_nudge', 'recare', 'reactivation',
]);

async function runJob(job) {
  // MASTER KILL-SWITCH: stop all automated outbound lifecycle sends at the single
  // dispatch chokepoint. Marks the job done (not failed) so it won't pile up retries.
  if (String(process.env.LIFECYCLE_SEND || '').toLowerCase() === 'off' && OUTBOUND_SEND_JOBS.has(job.type)) {
    console.log(`[Scheduler] LIFECYCLE_SEND=off — skipping outbound job ${job.id} (${job.type})`);
    await db.query(`UPDATE jobs SET status='done', last_error='skipped: LIFECYCLE_SEND=off', updated_at=now() WHERE id=$1`, [job.id]);
    return;
  }
  const handler = _handlers.get(job.type);
  if (!handler) {
    console.error(`[Scheduler] No handler for job type "${job.type}" (job ${job.id})`);
    await db.query(`UPDATE jobs SET status='failed', last_error='no handler', updated_at=now() WHERE id=$1`, [job.id]);
    return;
  }
  try {
    await handler(job.payload || {}, job);
    await db.query(`UPDATE jobs SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
  } catch (e) {
    const failed = job.attempts >= MAX_ATTEMPTS;
    const nextRun = new Date(Date.now() + backoffMs(job.attempts));
    console.error(`[Scheduler] Job ${job.id} (${job.type}) error: ${e.message}${failed ? ' — giving up' : ` — retry at ${nextRun.toISOString()}`}`);
    await db.query(
      `UPDATE jobs SET status=$2, run_at=$3, last_error=$4, updated_at=now() WHERE id=$1`,
      [job.id, failed ? 'failed' : 'pending', nextRun, String(e.message).slice(0, 500)]
    );
  }
}

let _timer = null;
let _ticking = false;

async function tick() {
  if (_ticking || !db.isEnabled()) return;
  _ticking = true;
  try {
    const jobs = await claimDueJobs();
    if (jobs.length) console.log(`[Scheduler] Running ${jobs.length} due job(s)`);
    for (const job of jobs) await runJob(job);
  } catch (e) {
    console.error('[Scheduler] Tick error:', e.message);
  } finally {
    _ticking = false;
  }
}

/** Start the poller. No-op if DB disabled. */
function start() {
  if (!db.isEnabled()) { console.warn('[Scheduler] DB disabled — scheduler not started'); return; }
  if (_timer) return;
  console.log(`[Scheduler] Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  _timer = setInterval(() => { tick().catch(e => console.error('[Scheduler]', e.message)); }, POLL_INTERVAL_MS);
  // run an immediate tick so newly-due jobs don't wait a full interval
  tick().catch(() => {});
}

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { registerHandler, enqueue, cancelJobs, start, stop, tick };
