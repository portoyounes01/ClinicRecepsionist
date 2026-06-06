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
  // Outbound confirm-call + reviews + recare handlers register themselves
  // when those modules are required (added in later steps).
  try { require('../outbound/voiceConfirm').register(); } catch (_) {}
  try { require('./reviews').register(); } catch (_) {}
  try { require('./recare').register(); } catch (_) {}
  try { require('./reactivation').register(); } catch (_) {}

  scheduler.start();

  // Daily sweeps for recare + reactivation (find due/dormant patients and
  // enqueue their messages). Runs once at boot, then every 24h.
  startDailySweeps();

  console.log('[Lifecycle] Engine booted');
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
