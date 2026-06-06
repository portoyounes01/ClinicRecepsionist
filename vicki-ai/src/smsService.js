// ============================================================
// VICKI AI — SMS Service (Telnyx Alphanumeric Sender "IVB")
//
// Sends appointment confirmation SMS after successful booking.
// Uses Telnyx V2 Messaging API with alphanumeric sender ID.
//
// Required env vars:
//   TELNYX_API_KEY            — V2 API key from Telnyx portal
//   TELNYX_MESSAGING_PROFILE  — Messaging profile ID
// ============================================================

const axios = require('axios');

const TELNYX_API_KEY           = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE = process.env.TELNYX_MESSAGING_PROFILE || '40019e93-abb8-4ea7-9a4a-06c4c1126bb2';
const SENDER_ID                = 'IVB';
const CLINIC_PHONE             = '962 432 761';

/**
 * Send an SMS via Telnyx alphanumeric sender ID.
 */
async function sendSMS(to, text) {
  if (process.env.VICKI_DRY_RUN) {
    console.log(`[SMS] DRY_RUN — would send to ${to}: "${(text || '').slice(0, 60)}..."`);
    return { dryRun: true };
  }
  if (!TELNYX_API_KEY) {
    console.warn('[SMS] TELNYX_API_KEY not set — skipping SMS');
    return null;
  }
  if (!to) {
    console.warn('[SMS] No recipient number — skipping SMS');
    return null;
  }

  // Ensure E.164 format for Portugal
  let phone = String(to).replace(/\s+/g, '');
  if (phone.startsWith('9') && phone.length === 9) phone = '+351' + phone;
  else if (phone.startsWith('351') && !phone.startsWith('+')) phone = '+' + phone;
  else if (!phone.startsWith('+')) phone = '+351' + phone;

  try {
    const res = await axios.post('https://api.telnyx.com/v2/messages', {
      from:                 SENDER_ID,
      to:                   phone,
      text:                 text,
      messaging_profile_id: TELNYX_MESSAGING_PROFILE,
    }, {
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    console.log(`[SMS] Sent to ${phone} — id: ${res.data?.data?.id}`);
    return res.data;
  } catch (err) {
    console.error(`[SMS] Failed to ${phone}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Format date as DD/MM/YYYY from ISO date string (e.g. "2026-06-18" → "18/06/2026")
 */
function formatDatePT(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Format time as digits HH:MM for SMS (e.g. "14:45:00" → "14:45").
 * The spoken `displayTime` is now words ("catorze e quarenta e cinco") which is
 * wrong for a written SMS, so we always prefer the raw ISO time when available.
 */
function formatTimePT(rawTime, displayTime) {
  if (rawTime) {
    const hhmm = String(rawTime).slice(0, 5); // "14:45:00" → "14:45"
    if (/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
  }
  return displayTime || '';
}

/**
 * Send booking confirmation SMS.
 */
async function sendBookingConfirmation({ patientName, phoneNumber, displayDate, displayTime, medicName, date, time, reasonText }) {
  const dateStr = date ? formatDatePT(date) : (displayDate || '');
  const timeStr = formatTimePT(time, displayTime);
  const reason  = reasonText || '';

  const lines = [
    `Instituto Vilas Boas (Loule) confirma a sua marcacao de consulta.`,
    `Data: ${dateStr}`,
    `Hora: ${timeStr}`,
    `Medico: ${medicName || ''}`,
  ];

  if (reason) {
    lines.push(`Motivo: ${reason}`);
  }

  lines.push('');
  lines.push(`Caso nao possa comparecer, por favor contacte atraves do ${CLINIC_PHONE}.`);

  return sendSMS(phoneNumber, lines.join('\n'));
}

/**
 * Send cancellation confirmation SMS.
 */
async function sendCancellationConfirmation({ patientName, phoneNumber, displayDate, displayTime, medicName, date, time }) {
  const dateStr = date ? formatDatePT(date) : (displayDate || '');
  const timeStr = formatTimePT(time, displayTime);
  const doctorPart = medicName ? ` com ${medicName}` : '';
  const datePart   = dateStr   ? ` agendada para ${dateStr}` : '';
  const timePart   = timeStr   ? ` as ${timeStr}` : '';

  const text = [
    `Instituto Vilas Boas (Loule) confirma o cancelamento da sua consulta${doctorPart}${datePart}${timePart}.`,
    ``,
    `Para remarcar, contacte atraves do ${CLINIC_PHONE}.`,
  ].join('\n');

  return sendSMS(phoneNumber, text);
}

// ─────────────────────────────────────────────
// DEFERRED SMS QUEUE — sending an SMS mid-call competes with the audio
// stream and garbles Vicki's voice. So during a call we QUEUE the SMS and
// only flush it once the call has disconnected. Keyed by callerNumber.
// ─────────────────────────────────────────────
const _smsQueue = new Map(); // callerNumber → [ () => Promise, ... ]

function queueSMS(callKey, sendThunk) {
  if (!callKey) return sendThunk(); // no key → send immediately (best effort)
  const list = _smsQueue.get(callKey) || [];
  list.push(sendThunk);
  _smsQueue.set(callKey, list);
  console.log(`[SMS] Queued for after call ${callKey} (${list.length} pending)`);
}

// Flush every queued SMS for a call — call this AFTER the call disconnects.
async function flushQueuedSMS(callKey) {
  if (!callKey) return;
  const list = _smsQueue.get(callKey);
  if (!list || !list.length) return;
  _smsQueue.delete(callKey);
  console.log(`[SMS] Flushing ${list.length} queued message(s) for ${callKey} after disconnect`);
  for (const thunk of list) {
    try { await thunk(); } catch (e) { console.error('[SMS] Flush error:', e.message); }
  }
}

module.exports = {
  sendSMS, sendBookingConfirmation, sendCancellationConfirmation,
  queueSMS, flushQueuedSMS,
};
