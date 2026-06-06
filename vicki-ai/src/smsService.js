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
 * Send booking confirmation SMS.
 */
async function sendBookingConfirmation({ patientName, phoneNumber, displayDate, displayTime, medicName, date, time, reasonText }) {
  const dateStr = date ? formatDatePT(date) : (displayDate || '');
  const timeStr = displayTime || time || '';
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
async function sendCancellationConfirmation({ patientName, phoneNumber, displayDate, displayTime, medicName, date }) {
  const dateStr = date ? formatDatePT(date) : (displayDate || '');
  const timeStr = displayTime || '';
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

module.exports = { sendSMS, sendBookingConfirmation, sendCancellationConfirmation };
