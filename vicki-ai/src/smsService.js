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

/**
 * Send an SMS via Telnyx alphanumeric sender ID.
 * @param {string} to — E.164 phone number (e.g. "+351969191933")
 * @param {string} text — Message body (max ~160 chars for 1 segment)
 * @returns {object|null} — Telnyx response data or null on failure
 */
async function sendSMS(to, text) {
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

    console.log(`[SMS] ✅ Sent to ${phone} — id: ${res.data?.data?.id}`);
    return res.data;
  } catch (err) {
    console.error(`[SMS] ❌ Failed to ${phone}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Send booking confirmation SMS.
 * @param {object} opts
 * @param {string} opts.patientName — e.g. "VALTER MIGUEL"
 * @param {string} opts.phoneNumber — e.g. "+351969191933"
 * @param {string} opts.displayDate — e.g. "quinta-feira, dia 18 de junho"
 * @param {string} opts.displayTime — e.g. "14h45"
 * @param {string} opts.medicName   — e.g. "Dr. Hermes"
 * @param {string} opts.date        — ISO date e.g. "2026-06-18"
 * @param {string} opts.time        — e.g. "14:45"
 */
async function sendBookingConfirmation({ patientName, phoneNumber, displayDate, displayTime, medicName, date, time }) {
  // Build a clean, short SMS (fits in 1-2 segments)
  const firstName = (patientName || '').split(/\s+/)[0];
  const dateStr   = displayDate || date || '';
  const timeStr   = displayTime || time || '';

  const text = [
    `Olá ${firstName}!`,
    `A sua consulta está confirmada:`,
    `📅 ${dateStr}`,
    `🕐 ${timeStr}`,
    `👨‍⚕️ ${medicName}`,
    ``,
    `Instituto Vilas Boas`,
    `📍 Loulé`,
    `📞 289 060 010`,
  ].join('\n');

  return sendSMS(phoneNumber, text);
}

/**
 * Send cancellation confirmation SMS.
 */
async function sendCancellationConfirmation({ patientName, phoneNumber, displayDate, displayTime, medicName }) {
  const firstName = (patientName || '').split(/\s+/)[0];
  const text = [
    `Olá ${firstName},`,
    `A sua consulta${medicName ? ` com ${medicName}` : ''}${displayDate ? ` de ${displayDate}` : ''} foi cancelada com sucesso.`,
    ``,
    `Para remarcar, ligue 289 060 010.`,
    `Instituto Vilas Boas`,
  ].join('\n');

  return sendSMS(phoneNumber, text);
}

module.exports = { sendSMS, sendBookingConfirmation, sendCancellationConfirmation };
