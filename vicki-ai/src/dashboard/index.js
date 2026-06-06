// ============================================================
// VICKI AI — Owner Dashboard (lifecycle metrics)
//
//   GET /dashboard?key=DASHBOARD_KEY        -> HTML overview
//   GET /dashboard/api/stats?key=...        -> JSON metrics
//
// Reads ONLY the lifecycle Postgres tables. Does not touch the
// existing inbound call logging. Auth is a per-deployment key
// (DASHBOARD_KEY) — NOT the global ADMIN_KEY used for memory.
// ============================================================

const db = require('../db');

function authed(req) {
  const key = process.env.DASHBOARD_KEY || 'vicki-dash';
  return req.query.key === key;
}

async function stats() {
  if (!db.isEnabled()) return { enabled: false };

  const num = (r) => parseInt(r?.n || 0, 10);

  const remindersSent  = num(await db.one(`SELECT count(*) n FROM appointments_tracked WHERE reminder_sent_at IS NOT NULL`));
  const confirmed      = num(await db.one(`SELECT count(*) n FROM appointments_tracked WHERE confirm_status='confirmed'`));
  const confirmedWa    = num(await db.one(`SELECT count(*) n FROM appointments_tracked WHERE confirm_status='confirmed' AND confirm_channel='whatsapp'`));
  const confirmedCall  = num(await db.one(`SELECT count(*) n FROM appointments_tracked WHERE confirm_status='confirmed' AND confirm_channel='call'`));
  const cancelled      = num(await db.one(`SELECT count(*) n FROM appointments_tracked WHERE confirm_status='cancelled'`));
  const pending        = num(await db.one(`SELECT count(*) n FROM appointments_tracked WHERE confirm_status='pending'`));

  const reviewsDone    = num(await db.one(`SELECT count(*) n FROM reviews WHERE completed=true`));
  const reviewsSent    = num(await db.one(`SELECT count(*) n FROM reviews`));
  const toGoogle       = num(await db.one(`SELECT count(*) n FROM reviews WHERE sent_to_google=true`));
  const lowReviews     = num(await db.one(`SELECT count(*) n FROM reviews WHERE completed=true AND rating < 4`));
  const avgRatingRow   = await db.one(`SELECT round(avg(rating)::numeric,2) a FROM reviews WHERE completed=true`);
  const avgRating      = avgRatingRow?.a || null;

  const ratingDist     = await db.many(`SELECT rating, count(*) n FROM reviews WHERE completed=true GROUP BY rating ORDER BY rating`);

  const jobsPending    = num(await db.one(`SELECT count(*) n FROM jobs WHERE status='pending'`));
  const jobsFailed     = num(await db.one(`SELECT count(*) n FROM jobs WHERE status='failed'`));

  const confirmRate = remindersSent ? Math.round((confirmed / remindersSent) * 100) : 0;
  const reviewRate  = reviewsSent ? Math.round((reviewsDone / reviewsSent) * 100) : 0;

  return {
    enabled: true,
    reminders: { sent: remindersSent, confirmed, confirmedWa, confirmedCall, cancelled, pending, confirmRate },
    reviews:   { sent: reviewsSent, completed: reviewsDone, toGoogle, low: lowReviews, avgRating, reviewRate,
                 dist: ratingDist.map(r => ({ rating: r.rating, n: parseInt(r.n, 10) })) },
    jobs:      { pending: jobsPending, failed: jobsFailed },
  };
}

function card(title, value, sub) {
  return `<div class="card"><div class="t">${title}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}

function render(s) {
  if (!s.enabled) return '<p style="font-family:system-ui;padding:40px">Lifecycle DB not enabled (set DATABASE_URL).</p>';
  const r = s.reminders, v = s.reviews;
  const dist = [1,2,3,4,5].map(n => {
    const found = v.dist.find(d => d.rating === n);
    return `${n}★: ${found ? found.n : 0}`;
  }).join(' &nbsp; ');

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Vicki Dashboard</title>
<style>
  body{margin:0;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:28px}
  h1{font-size:1.4rem;margin:0 0 4px} .muted{color:#94a3b8;margin:0 0 24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:28px}
  .card{background:#1e293b;border-radius:14px;padding:18px}
  .card .t{color:#94a3b8;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
  .card .v{font-size:2rem;font-weight:700;margin-top:6px}
  .card .s{color:#64748b;font-size:.85rem;margin-top:4px}
  h2{font-size:1rem;color:#cbd5e1;margin:24px 0 12px}
  .dist{background:#1e293b;border-radius:14px;padding:18px;font-size:1.05rem}
  .warn{color:#fca5a5}
</style></head><body>
<h1>Vicki — Patient Lifecycle</h1>
<p class="muted">Reminders, confirmations and reviews</p>

<h2>Reminders & Confirmations</h2>
<div class="grid">
  ${card('Reminders sent', r.sent)}
  ${card('Confirmed', r.confirmed, `${r.confirmRate}% confirm rate`)}
  ${card('Confirmed via WhatsApp', r.confirmedWa)}
  ${card('Confirmed via call', r.confirmedCall)}
  ${card('Cancelled', r.cancelled)}
  ${card('Awaiting reply', r.pending)}
</div>

<h2>Reviews</h2>
<div class="grid">
  ${card('Requests sent', v.sent)}
  ${card('Completed', v.completed, `${v.reviewRate}% completion`)}
  ${card('Avg rating', v.avgRating ?? '—')}
  ${card('Sent to Google', v.toGoogle)}
  ${card('Low reviews (caught)', `<span class="${v.low ? 'warn' : ''}">${v.low}</span>`, 'kept off Google')}
</div>
<div class="dist">${dist}</div>

<h2>Jobs</h2>
<div class="grid">
  ${card('Pending', s.jobs.pending)}
  ${card('Failed', `<span class="${s.jobs.failed ? 'warn' : ''}">${s.jobs.failed}</span>`)}
</div>
<script>setTimeout(function(){location.reload()}, 30000)</script>
</body></html>`;
}

function mount(app) {
  app.get('/dashboard', async (req, res) => {
    if (!authed(req)) return res.status(403).send('Forbidden');
    try { res.type('html').send(render(await stats())); }
    catch (e) { console.error('[Dashboard]', e.message); res.status(500).send('Error'); }
  });
  app.get('/dashboard/api/stats', async (req, res) => {
    if (!authed(req)) return res.status(403).json({ error: 'Forbidden' });
    try { res.json(await stats()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  console.log('[Lifecycle] Routes mounted: /dashboard');
}

module.exports = { mount, stats };
