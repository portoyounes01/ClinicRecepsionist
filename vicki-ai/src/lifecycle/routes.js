// ============================================================
// VICKI AI — Lifecycle HTTP routes (additive)
//
// Mounted onto the existing Express app via mount(app) from boot.js.
// Does NOT touch any existing routes. Provides:
//   GET  /whatsapp/webhook   — Meta verification handshake
//   POST /whatsapp/webhook   — inbound events (button taps, statuses)
//
// The webhook needs the RAW body for X-Hub-Signature-256, so this
// router uses express.raw() ONLY on that path — global express.json()
// in server.js is unaffected for every other route.
// ============================================================

const express = require('express');
const wa      = require('../integrations/whatsapp');
const db      = require('../db');
const { getDefaultClinic } = require('../clinics/registry');

function mount(app) {
  // ── GET verification handshake ────────────────────────────────────────────
  app.get('/whatsapp/webhook', (req, res) => {
    const clinic = getDefaultClinic();
    const challenge = wa.verifyWebhookSubscription(req.query, clinic);
    if (challenge) {
      console.log('[WA] Webhook verified');
      return res.status(200).send(challenge);
    }
    console.warn('[WA] Webhook verification failed');
    return res.sendStatus(403);
  });

  // ── POST inbound events ───────────────────────────────────────────────────
  // Raw body parser scoped to this route only.
  app.post('/whatsapp/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const clinic = getDefaultClinic();
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.body; // Buffer (from express.raw)

    if (!wa.verifySignature(rawBody, signature, clinic?.whatsapp?.appSecret)) {
      console.warn('[WA] Bad webhook signature — rejecting');
      return res.sendStatus(401);
    }

    // ACK immediately (Meta requires 200 < 5s), then process async.
    res.sendStatus(200);

    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch { console.error('[WA] Webhook body not JSON'); return; }

    setImmediate(() => processWebhook(payload).catch(e => console.error('[WA] Webhook processing error:', e.message)));
  });

  // Hosted review page (/review/:token)
  try { require('../reviewpage').mount(app); } catch (e) { console.error('[Lifecycle] Review page mount failed:', e.message); }

  // Owner dashboard (/dashboard)
  try { require('../dashboard').mount(app); } catch (e) { console.error('[Lifecycle] Dashboard mount failed:', e.message); }

  console.log('[Lifecycle] Routes mounted: /whatsapp/webhook');
}

// ─── Async webhook processing (idempotent) ─────────────────────────────────────
async function processWebhook(payload) {
  if (!db.isEnabled()) return;
  const events = wa.parseInbound(payload);

  for (const ev of events) {
    // Idempotency: skip if we've already recorded this inbound message id.
    if (ev.waMessageId && (ev.kind === 'button' || ev.kind === 'text')) {
      const existing = await db.one(`SELECT 1 FROM messages WHERE wa_message_id=$1`, [ev.waMessageId]);
      if (existing) { console.log(`[WA] Duplicate webhook ${ev.waMessageId} — skip`); continue; }
      await db.query(
        `INSERT INTO messages (channel, direction, wa_message_id, status, payload)
           VALUES ('whatsapp','in',$1,'received',$2)
         ON CONFLICT (wa_message_id) DO NOTHING`,
        [ev.waMessageId, JSON.stringify({ kind: ev.kind })]
      );
    }

    if (ev.kind === 'button') {
      await routeButton(ev);
    } else if (ev.kind === 'text') {
      await routeText(ev);
    } else if (ev.kind === 'status') {
      if (ev.waMessageId) {
        await db.query(`UPDATE messages SET status=$2 WHERE wa_message_id=$1 AND direction='out'`, [ev.waMessageId, ev.status]);
      }
    }
  }
}

// A button payload may belong to several lifecycle features. Try each
// handler; the one that recognizes its prefix handles it.
async function routeButton(ev) {
  const reminder = require('./reminder');
  if (await reminder.handleButton(ev.buttonPayload)) return;

  // Recare / reactivation "book now" tap -> tell the patient how to book.
  // (We deliberately don't auto-book here — booking goes through the existing
  // voice receptionist flow, which we must not touch.)
  const m = /^recare_book:(\d+)$/.exec(ev.buttonPayload || '');
  if (m) { await handleRecareBook(parseInt(m[1], 10), ev.from); return; }

  console.log(`[WA] Unrecognized button payload: ${ev.buttonPayload}`);
}

async function handleRecareBook(patientDbId, from) {
  const clinic = getDefaultClinic();
  const phone = clinic?.phone || clinic?.mobile || '';
  // Free-form reply is allowed: the patient just messaged us (button tap
  // opens the 24h service window), so a plain text reply is free + fine.
  const wa = require('../integrations/whatsapp');
  const msg = `Com todo o gosto! Para marcar a sua consulta, ligue-nos para ${phone} `
    + `ou responda a esta mensagem e a nossa equipa ajuda-o a agendar.`;
  try { await wa.sendText(clinic, from, msg); } catch (e) { console.error('[WA] recare_book reply failed:', e.message); }
  console.log(`[Recare] Patient ${patientDbId} tapped book — sent booking instructions`);
}

// Handle STOP / opt-out and free-text replies.
async function routeText(ev) {
  const txt = (ev.text || '').trim().toLowerCase();
  if (['stop', 'parar', 'sair', 'unsubscribe', 'cancelar subscricao'].includes(txt)) {
    const phone = wa.toWaNumber(ev.from);
    await db.query(`UPDATE patients SET opt_out_whatsapp=true, updated_at=now() WHERE phone_e164=$1`, [phone]);
    console.log(`[WA] Opt-out recorded for ${phone}`);
  }
  // Other free-text within the 24h window can be routed to support later.
}

module.exports = { mount, processWebhook };
