// ============================================================
// VICKI AI — Lifecycle Engine Boot
//
// Single entry point that wires up the ADDITIVE lifecycle layer.
// Call bootLifecycle(app) once from server.js after the app is built.
//
// Safe-by-default: if DATABASE_URL is missing or migration fails, the
// engine stays disabled and the inbound voice flow is unaffected.
// Always skipped under VICKI_DRY_RUN so the gym never touches it.
// ============================================================

const db        = require('../db');
const scheduler = require('../scheduler');
const routes    = require('./routes');
const reminder  = require('./reminder');
const { syncClinicsToDb } = require('../clinics/registry');

async function bootLifecycle(app) {
  if (process.env.VICKI_DRY_RUN) {
    console.log('[Lifecycle] Skipped (VICKI_DRY_RUN)');
    return;
  }

  // Routes can mount even if the DB is down (webhook will 200 + no-op),
  // so Meta's verification keeps working and we don't lose events config.
  try { routes.mount(app); } catch (e) { console.error('[Lifecycle] Route mount failed:', e.message); }

  const ok = await db.migrate();
  if (!ok) {
    console.warn('[Lifecycle] Engine disabled — set DATABASE_URL to enable reminders/reviews/recare');
    return;
  }

  try { await syncClinicsToDb(); } catch (e) { console.error('[Lifecycle] Clinic sync failed:', e.message); }

  // Register job handlers from each lifecycle module.
  reminder.register();
  // Post-call booking verification (re-reads Newsoft to confirm a claimed booking).
  try { require('./bookingVerify').register(); } catch (e) { console.error('[Lifecycle] bookingVerify register failed:', e.message); }
  // Outbound confirm-call + reviews + recare handlers register themselves
  // when those modules are required (added in later steps).
  try { require('../outbound/voiceConfirm').register(); } catch (_) {}
  try { require('./reviews').register(); } catch (_) {}
  try { require('./recare').register(); } catch (_) {}
  try { require('./reactivation').register(); } catch (_) {}

  scheduler.start();

  // Reconciliation sweep: catch any claimed-but-unconfirmed booking and alert
  // staff (final safety net behind the in-call + post-call verification).
  try { require('./reconcile').start(); } catch (e) { console.error('[Lifecycle] reconcile start failed:', e.message); }

  // Daily sweeps for recare + reactivation (find due/dormant patients and
  // enqueue their messages). Runs once at boot, then every 24h.
  startDailySweeps();

  // Daily reminder batch at a fixed clinic-local time (default 07:30): message
  // every patient whose appointment is REMINDER_DAYS_AHEAD days out.
  scheduleDailyReminderSweep();

  // Weekly Newsoft visit backfill so recare/reactivation know each patient's
  // last visit. First run ~2 min after boot, then every 7 days.
  scheduleWeeklyBackfill();

  console.log('[Lifecycle] Engine booted');
}

function scheduleWeeklyBackfill() {
  const { allClinics } = require('../clinics/registry');
  const { backfillVisits } = require('./backfill');
  const run = async () => {
    for (const clinic of allClinics()) {
      try { await backfillVisits(clinic); }
      catch (e) { console.error('[Backfill] weekly run error:', e.message); }
    }
  };
  setTimeout(run, 120_000);                       // initial run shortly after boot
  setInterval(run, 7 * 24 * 60 * 60 * 1000);      // then weekly
}

// Daily reminder batch at a fixed wall-clock time (clinic-local; set
// TZ=Europe/Lisbon on the host). Re-computes the next run after each fire so
// it stays on 07:30 across DST changes (unlike a flat 24h interval).
const SWEEP_HOUR = parseInt(process.env.REMINDER_SWEEP_HOUR || '7', 10);
const SWEEP_MIN  = parseInt(process.env.REMINDER_SWEEP_MIN  || '30', 10);

function scheduleDailyReminderSweep() {
  const { allClinics } = require('../clinics/registry');
  const reminder = require('./reminder');

  const runSweep = async () => {
    for (const clinic of allClinics()) {
      try { await reminder.sweepDailyReminders(clinic); }
      catch (e) { console.error('[Reminder] daily sweep error:', e.message); }
    }
  };
  const msUntilNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(SWEEP_HOUR, SWEEP_MIN, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  const arm = () => {
    const ms = msUntilNext();
    const hhmm = `${String(SWEEP_HOUR).padStart(2, '0')}:${String(SWEEP_MIN).padStart(2, '0')}`;
    console.log(`[Reminder] Daily sweep scheduled — next run in ${Math.round(ms / 3600000)}h (${hhmm})`);
    setTimeout(async () => { await runSweep(); arm(); }, ms);
  };
  arm();
}

function startDailySweeps() {
  const runSweeps = async () => {
    try { await require('./recare').sweep(); } catch (e) { console.error('[Recare] sweep error:', e.message); }
    try { await require('./reactivation').sweep(); } catch (e) { console.error('[Reactivation] sweep error:', e.message); }
  };
  // Initial run shortly after boot, then daily.
  setTimeout(runSweeps, 30_000);
  setInterval(runSweeps, 24 * 60 * 60 * 1000);
}

module.exports = { bootLifecycle };
