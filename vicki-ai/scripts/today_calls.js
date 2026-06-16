// One-off: list today's calls from call_logs. Run via `railway run node scripts/today_calls.js`.
// Prefer the public proxy URL (internal host doesn't resolve from a local machine).
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const db = require('../src/db');
(async () => {
  try {
    const rows = await db.many(
      `SELECT id, patient_name, caller_number, outcome, intent,
              transferred_to_human, action_fired, duration_seconds,
              unclear_turns, language, summary, flags,
              recording_url IS NOT NULL AS has_recording, created_at
         FROM call_logs
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Lisbon') AT TIME ZONE 'Europe/Lisbon'
        ORDER BY created_at ASC`
    );
    console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
  } catch (e) {
    console.error('QUERY_ERROR', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
