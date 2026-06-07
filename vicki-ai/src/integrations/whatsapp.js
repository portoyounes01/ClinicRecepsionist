// ============================================================
// VICKI AI — WhatsApp Business Cloud API (direct Meta)
//
// Handles outbound template/text messages and inbound webhook
// verification + parsing for the lifecycle engine.
//
// Reference (verified Jun 2026):
//   POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
//   Auth: Bearer {WHATSAPP_TOKEN}
//   Webhook: verify X-Hub-Signature-256 = HMAC-SHA256(rawBody, APP_SECRET)
//
// Platform rules baked in:
//   • Cloud API only (on-prem deprecated Oct 2025)
//   • Utility templates with up to 3 quick-reply buttons
//   • Reply to webhook with 200 < 5s, process async, be idempotent
//   • 24h service window: free-form text only allowed within it
//
// PHI note: never log message bodies (patient data). Log ids/status only.
// ============================================================

const axios  = require('axios');
const crypto = require('crypto');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

function graphUrl(phoneNumberId) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

/** Normalize a Portuguese number to E.164 digits (no '+') for the `to` field. */
function toWaNumber(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d]/g, '');
  if (p.length === 9 && p.startsWith('9')) p = '351' + p; // local PT mobile
  return p || null;
}

/**
 * Send a template message with optional body variables and quick-reply buttons.
 *
 * @param {object} clinic        - clinic config from registry (clinic.whatsapp.*)
 * @param {string} to            - patient phone (any format)
 * @param {string} templateName  - approved template name
 * @param {object} opts
 * @param {string} opts.lang     - language code, default 'pt_PT'
 * @param {string[]} opts.bodyParams - ordered {{1}},{{2}}... body text values
 * @param {Array<{index:number,payload:string}>} opts.buttons - quick-reply payloads
 * @returns {Promise<{messageId:string}|null>}
 */
async function sendTemplate(clinic, to, templateName, opts = {}) {
  const wa = clinic?.whatsapp || {};
  const lang       = opts.lang || (clinic?.locale === 'en' ? 'en' : 'pt_PT');
  const bodyParams = opts.bodyParams || [];
  const buttons    = opts.buttons || [];

  const waTo = toWaNumber(to);
  if (!waTo) { console.warn('[WA] No recipient — skipping template'); return null; }

  if (process.env.VICKI_DRY_RUN) {
    console.log(`[WA] DRY_RUN — would send template "${templateName}" to ${waTo} (${buttons.length} buttons)`);
    return { messageId: `dry_${templateName}_${waTo}` };
  }
  if (!wa.token || !wa.phoneNumberId) {
    console.warn('[WA] WHATSAPP_TOKEN / PHONE_NUMBER_ID not set — skipping');
    return null;
  }

  const components = [];
  if (bodyParams.length) {
    components.push({ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) });
  }
  for (const b of buttons) {
    components.push({
      type: 'button', sub_type: 'quick_reply', index: String(b.index),
      parameters: [{ type: 'payload', payload: b.payload }],
    });
  }

  const body = {
    messaging_product: 'whatsapp',
    to: waTo,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      ...(components.length ? { components } : {}),
    },
  };

  try {
    const res = await axios.post(graphUrl(wa.phoneNumberId), body, {
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const messageId = res.data?.messages?.[0]?.id || null;
    console.log(`[WA] Template "${templateName}" sent to ${waTo} — id: ${messageId}`);
    return { messageId };
  } catch (err) {
    console.error(`[WA] Template send failed (${templateName}):`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * Send a free-form text message. ONLY valid inside the 24h customer
 * service window (i.e. patient messaged us in the last 24h). Use for
 * follow-ups after a button tap, never to initiate.
 */
async function sendText(clinic, to, text) {
  const wa = clinic?.whatsapp || {};
  const waTo = toWaNumber(to);
  if (!waTo) return null;

  if (process.env.VICKI_DRY_RUN) {
    console.log(`[WA] DRY_RUN — would send text to ${waTo}`);
    return { messageId: `dry_text_${waTo}` };
  }
  if (!wa.token || !wa.phoneNumberId) return null;

  try {
    const res = await axios.post(graphUrl(wa.phoneNumberId), {
      messaging_product: 'whatsapp', to: waTo, type: 'text', text: { body: text },
    }, {
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return { messageId: res.data?.messages?.[0]?.id || null };
  } catch (err) {
    console.error('[WA] Text send failed:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

/**
 * First name for greetings (e.g. "Olá *João*"). WhatsApp rejects empty
 * template variables, so this always returns a non-empty value.
 */
function firstName(name, lang) {
  const f = String(name || '').trim().split(/\s+/)[0];
  if (f) return f.charAt(0).toUpperCase() + f.slice(1);
  return lang === 'en' ? 'there' : 'Paciente';
}

// ─── Webhook: GET verification handshake ───────────────────────────────────────
/**
 * Handle Meta's GET verification. Returns the challenge string to echo
 * back (200) if the verify token matches, else null (caller -> 403).
 */
function verifyWebhookSubscription(query, clinic) {
  const mode      = query['hub.mode'];
  const token     = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expected  = clinic?.whatsapp?.verifyToken;
  if (mode === 'subscribe' && token && expected && token === expected) {
    return challenge;
  }
  return null;
}

// ─── Webhook: POST signature verification ──────────────────────────────────────
/**
 * Verify X-Hub-Signature-256 against the RAW request body.
 * `rawBody` must be the exact bytes received (use express.raw or a
 * verify hook that stashes req.rawBody). Returns true/false.
 */
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) {
    console.warn('[WA] APP_SECRET not set — cannot verify webhook signature');
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret)
    .update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch { return false; }
}

// ─── Webhook: parse inbound events ─────────────────────────────────────────────
/**
 * Flatten a webhook POST body into a simple list of events we care about.
 * Handles: quick-reply button taps, plain text replies, and status updates.
 *
 * @returns {Array<{kind, waMessageId, from, buttonPayload?, text?, status?}>}
 */
function parseInbound(payload) {
  const out = [];
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      const value = change.value || {};

      // Incoming messages (button taps, text)
      for (const msg of (value.messages || [])) {
        const base = { waMessageId: msg.id, from: msg.from };
        if (msg.type === 'button') {
          // Quick-reply on a TEMPLATE message
          out.push({ kind: 'button', ...base, buttonPayload: msg.button?.payload, text: msg.button?.text });
        } else if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
          // Quick-reply on an interactive (non-template) message
          out.push({ kind: 'button', ...base, buttonPayload: msg.interactive.button_reply?.id, text: msg.interactive.button_reply?.title });
        } else if (msg.type === 'text') {
          out.push({ kind: 'text', ...base, text: msg.text?.body });
        } else {
          out.push({ kind: 'other', ...base, msgType: msg.type });
        }
      }

      // Delivery / read status updates for messages WE sent
      for (const st of (value.statuses || [])) {
        out.push({ kind: 'status', waMessageId: st.id, from: st.recipient_id, status: st.status });
      }
    }
  }
  return out;
}

module.exports = {
  sendTemplate, sendText,
  verifyWebhookSubscription, verifySignature, parseInbound,
  toWaNumber, firstName,
};
