// One-off runner for the initial Newsoft visit backfill.
//   railway run node scripts/backfill-visits.js        (uses prod DB + Newsoft)
//   node scripts/backfill-visits.js                    (uses local .env)
// Read-only against Newsoft; writes last_visit/recare_due_date to our DB.
// Sends NOTHING to patients.
require('dotenv').config();

(async () => {
  const db = require('../src/db');
  if (!db.isEnabled()) { console.error('DATABASE_URL not set — nothing to do.'); process.exit(1); }
  await db.migrate();
  const { allClinics, syncClinicsToDb } = require('../src/clinics/registry');
  await syncClinicsToDb();
  const { backfillVisits } = require('../src/lifecycle/backfill');

  const months = parseInt(process.argv[2] || process.env.BACKFILL_MONTHS || '24', 10);
  for (const clinic of allClinics()) {
    console.log(`\n=== Backfill ${clinic.id} (${months} months) ===`);
    const res = await backfillVisits(clinic, months);
    console.log(`Done: ${res.patients} patients, ${res.scanned} appointments scanned.`);
  }
  process.exit(0);
})().catch(e => { console.error('Backfill error:', e); process.exit(1); });
