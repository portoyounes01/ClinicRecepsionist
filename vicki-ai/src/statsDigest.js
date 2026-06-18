// ============================================================
// VICKI AI — Call Stats Digest (Telegram)
//
// ADDITIVE + self-contained. Reads call_logs (the real source of truth) and
// sends a clean stats rollup to Telegram — DAILY and MONTHLY. Does not touch
// the nightly improvement agent (which does LLM pattern analysis).
//
// "Completed" = Vicki resolved the request herself:
//   booked | cancelled | confirmed | info_given  (NOT transferred/no_action/abandoned)
// Confirms land as outcome 'info_given' (or 'booked' when confirm_appointment
// fired); we count both confirm-style and info answers as completed.
// ============================================================

const db = require('./db');

const COMPLETED_OUTCOMES = ['booked', 'cancelled', 'confirmed', 'info_given'];

// Pull aggregate stats for calls in [sinceExpr, now). sinceExpr is a SQL
// interval boundary already applied by the caller via the WHERE clause.
async function computeStats(whereSql, params) {
  const rows = await db.many(
    `SELECT outcome, action_fired, transferred_to_human, duration_seconds
       FROM call_logs ${whereSql}`, params);

  const total = rows.length;
  const transferred = rows.filter(r => r.transferred_to_human || r.outcome === 'transferred').length;
  const booked    = rows.filter(r => r.action_fired === 'book_appointment' || r.outcome === 'booked').length;
  const cancelled = rows.filter(r => r.action_fired === 'cancel_appointment' || r.outcome === 'cancelled').length;
  const confirmed = rows.filter(r => r.action_fired === 'confirm_appointment').length;
  const infoGiven = rows.filter(r => r.outcome === 'info_given').length;
  const abandoned = rows.filter(r => r.outcome === 'abandoned').length;

  // Completed = resolved by Vicki (any of the success outcomes), not transferred.
  const completed = rows.filter(r =>
    !r.transferred_to_human && r.outcome !== 'transferred' &&
    (COMPLETED_OUTCOMES.includes(r.outcome) ||
      ['book_appointment', 'cancel_appointment', 'confirm_appointment'].includes(r.action_fired))
  ).length;

  const noAction = total - completed - transferred - abandoned;
  const completionRate = total ? Math.round((completed / total) * 100) : 0;
  const avgDur = total ? Math.round(rows.reduce((s, r) => s + (r.duration_seconds || 0), 0) / total) : 0;

  return { total, completed, completionRate, booked, cancelled, confirmed, infoGiven, transferred, abandoned, noAction: Math.max(0, noAction), avgDur };
}

function formatDigest(title, s) {
  const m = Math.floor(s.avgDur / 60), sec = s.avgDur % 60;
  return [
    `📊 <b>${title}</b>`,
    `📞 Total de chamadas: <b>${s.total}</b>`,
    `✅ Concluídas pela Vicki: <b>${s.completed}</b> (${s.completionRate}%)`,
    `   • Marcadas: ${s.booked}`,
    `   • Canceladas: ${s.cancelled}`,
    `   • Confirmadas: ${s.confirmed}`,
    `   • Informação dada: ${s.infoGiven}`,
    `👤 Transferidas para a equipa: ${s.transferred}`,
    `📭 Sem ação / abandonadas: ${s.noAction + s.abandoned}`,
    `⏱ Duração média: ${m}m${String(sec).padStart(2, '0')}`,
  ].join('\n');
}

// Build the digest text for a period: 'today' | 'thisMonth' | 'lastMonth'.
// Returns a ready-to-send HTML string (or a friendly "no calls" message).
async function buildDigest(period = 'today') {
  let whereSql, title;
  if (period === 'thisMonth') {
    whereSql = `WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Lisbon') AT TIME ZONE 'Europe/Lisbon'`;
    title = 'Resumo do mês (até agora)';
  } else if (period === 'lastMonth') {
    whereSql = `WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Lisbon') - interval '1 month'
                  AND created_at <  date_trunc('month', now() AT TIME ZONE 'Europe/Lisbon')`;
    title = 'Resumo mensal';
  } else {
    whereSql = `WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Lisbon') AT TIME ZONE 'Europe/Lisbon'`;
    title = 'Resumo do dia';
  }
  const s = await computeStats(whereSql, []);
  if (s.total === 0) return `📊 <b>${title}</b>\nSem chamadas neste período.`;
  return formatDigest(title, s);
}

async function sendDaily() {
  if (!db.isEnabled()) return;
  const { notify } = require('./telegramBot');
  try {
    const s = await computeStats(
      `WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Lisbon') AT TIME ZONE 'Europe/Lisbon'`, []);
    if (s.total === 0) return; // nothing to report
    await notify(formatDigest('Resumo do dia', s), { parse_mode: 'HTML' });
    console.log(`[Stats] Daily digest sent (${s.total} calls, ${s.completionRate}% completed)`);
  } catch (e) { console.error('[Stats] Daily digest failed:', e.message); }
}

async function sendMonthly() {
  if (!db.isEnabled()) return;
  const { notify } = require('./telegramBot');
  try {
    const msg = await buildDigest('lastMonth');
    await notify(msg, { parse_mode: 'HTML' });
    console.log('[Stats] Monthly digest sent');
  } catch (e) { console.error('[Stats] Monthly digest failed:', e.message); }
}

// ─── Schedulers ─────────────────────────────────────────────────────────────
// Date.now()/new Date() are fine here (production runtime, not a workflow).
function scheduleDigests() {
  // DAILY at 20:00 Europe/Lisbon-ish (server clock). Re-checks each hour so we
  // don't depend on exact ms drift; fires once when the hour matches.
  const DAILY_HOUR = parseInt(process.env.STATS_DAILY_HOUR || '20', 10);
  let lastDailyDay = null, lastMonthlyMonth = null;
  setInterval(() => {
    const now = new Date();
    const dayKey = now.toDateString();
    // Daily: once per day at the target hour.
    if (now.getHours() === DAILY_HOUR && lastDailyDay !== dayKey) {
      lastDailyDay = dayKey;
      sendDaily();
    }
    // Monthly: on the 1st at the target hour, once.
    const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
    if (now.getDate() === 1 && now.getHours() === DAILY_HOUR && lastMonthlyMonth !== monthKey) {
      lastMonthlyMonth = monthKey;
      sendMonthly();
    }
  }, 60 * 60 * 1000); // hourly tick
  console.log(`[Stats] Digest scheduler started (daily ${DAILY_HOUR}:00, monthly on the 1st)`);
}

module.exports = { scheduleDigests, sendDaily, sendMonthly, computeStats, buildDigest };
