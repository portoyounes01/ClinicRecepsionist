// ============================================================
// VICKI AI — Outbound Confirm Call (lifecycle fallback)
//
// Runs when a WhatsApp reminder got no Confirm/Cancel reply by the
// confirm-call lead time. Places an OUTBOUND call via Telnyx Call
// Control to confirm the appointment by voice.
//
// Telnyx Call Control originate (verified Jun 2026):
//   POST https://api.telnyx.com/v2/calls
//   body: { connection_id, to, from, client_state, command_id }
//
// The answered call streams to our existing /media WebSocket (set as
// the application's streaming target) and is driven by the dedicated
// confirmAgent — NOT the inbound receptionist flow.
//
// SAFETY: if Telnyx/voice isn't configured, we DON'T silently drop the
// patient — we fall back to an SMS confirm request so they can reply.
// ============================================================

const axios     = require('axios');
const db        = require('../db');
const scheduler = require('../scheduler');
const newsoft   = require('../newsoftApi');

const JOB_CONFIRM_CALL = 'confirm_call';

/** Originate the outbound confirm call. Returns the call_control_id or null. */
async function placeConfirmCall(clinic, tracked) {
  const t = clinic?.telnyx || {};
  const to = tracked.phone_e164 ? `+${tracked.phone_e164}` : null;
  if (!to) return null;

  if (process.env.VICKI_DRY_RUN) {
    console.log(`[ConfirmCall] DRY_RUN — would call ${to} for appt ${tracked.newsoft_appointment_id}`);
    return { dryRun: true };
  }
  if (!t.apiKey || !t.voiceAppId || !t.fromNumber) {
    console.warn('[ConfirmCall] Telnyx voice not configured — falling back to SMS');
    return null;
  }

  // client_state must be base64; mark this leg as a confirm call so the
  // media handler can route it to the confirm agent (not the receptionist).
  const clientState = Buffer.from(JSON.stringify({
    kind: 'confirm', trackedId: tracked.id, clinicId: clinic.id,
  })).toString('base64');

  try {
    const res = await axios.post('https://api.telnyx.com/v2/calls', {
      connection_id: t.voiceAppId,
      to,
      from: t.fromNumber,
      client_state: clientState,
      command_id: `confirm-${tracked.id}`,
      timeout_secs: 30,
      answering_machine_detection: 'detect',
    }, {
      headers: { Authorization: `Bearer ${t.apiKey}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const ccid = res.data?.data?.call_control_id || null;
    console.log(`[ConfirmCall] Originated to ${to} — call_control_id: ${ccid}`);
    return { callControlId: ccid };
  } catch (e) {
    console.error('[ConfirmCall] Originate failed:', e.response?.data?.errors?.[0]?.detail || e.message);
    return null;
  }
}

/** SMS fallback when we can't place a voice call. */
async function smsConfirmFallback(clinic, tracked) {
  // MASTER KILL-SWITCH: LIFECYCLE_SEND=off stops automated lifecycle confirmations.
  if (String(process.env.LIFECYCLE_SEND || '').toLowerCase() === 'off') {
    console.log(`[ConfirmCall] LIFECYCLE_SEND=off — blocked SMS confirm for appt ${tracked?.newsoft_appointment_id}`);
    return;
  }
  try {
    const sms = require('../smsService');
    const lang = require('../lang').pickLang(tracked.language, tracked.phone_e164);
    const locale = lang === 'en' ? 'en-GB' : 'pt-PT';
    const when = new Date(tracked.appointment_at);
    const dateStr = when.toLocaleDateString(locale);
    const timeStr = when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
    const phone = clinic.phone || clinic.mobile || '';
    const body = lang === 'en'
      ? `${clinic.name}: reminder of your appointment on ${dateStr} at ${timeStr}. `
        + `Please reply YES to confirm, or call ${phone} to reschedule.`
      : `${clinic.name}: lembrete da sua consulta em ${dateStr} as ${timeStr}. `
        + `Por favor confirme respondendo SIM, ou ligue ${phone} para remarcar.`;
    await sms.sendSMS(tracked.phone_e164, body);
    console.log(`[ConfirmCall] SMS confirm fallback sent for appt ${tracked.newsoft_appointment_id}`);
  } catch (e) {
    console.error('[ConfirmCall] SMS fallback failed:', e.message);
  }
}

// ─── Job handler ───────────────────────────────────────────────────────────────
async function handleConfirmCallJob(payload) {
  // MASTER KILL-SWITCH: stop the whole confirm job (voice call + SMS fallback).
  if (String(process.env.LIFECYCLE_SEND || '').toLowerCase() === 'off') {
    console.log('[ConfirmCall] LIFECYCLE_SEND=off — confirm job skipped');
    return;
  }
  const tracked = await db.one(
    `SELECT a.*, p.phone_e164, p.language, p.opt_out_sms
       FROM appointments_tracked a JOIN patients p ON p.id = a.patient_id
      WHERE a.id = $1`, [payload.trackedId]
  );
  if (!tracked) return;

  // Only call if still pending (they may have tapped Confirm/Cancel already).
  if (tracked.confirm_status !== 'pending') {
    console.log(`[ConfirmCall] Appt ${tracked.newsoft_appointment_id} already ${tracked.confirm_status} — skip call`);
    return;
  }

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(tracked.clinic_id);
  if (!clinic) return;

  if (!require('../sendGuard').guard(tracked.phone_e164, 'confirm-call')) return;

  const result = await placeConfirmCall(clinic, tracked);
  if (!result) {
    if (!tracked.opt_out_sms) await smsConfirmFallback(clinic, tracked);
  }
  // Whether the patient ultimately confirms is recorded by the in-call
  // confirm agent (via markConfirmOutcome) or, for SMS, by an inbound reply.
}

/**
 * Called by the in-call confirm agent when the patient answers and gives
 * a clear yes/no. Writes back to Newsoft and updates tracking.
 */
async function markConfirmOutcome(trackedId, outcome /* 'confirm'|'cancel' */) {
  if (!db.isEnabled()) return;
  const tracked = await db.one(`SELECT * FROM appointments_tracked WHERE id=$1`, [trackedId]);
  if (!tracked || tracked.confirm_status !== 'pending') return;

  if (outcome === 'confirm') {
    await newsoft.confirmAppointment({ appointmentId: tracked.newsoft_appointment_id, channel: 'call' });
    await db.query(`UPDATE appointments_tracked SET confirm_status='confirmed', confirm_channel='call', updated_at=now() WHERE id=$1`, [trackedId]);
    try {
      const { getClinic } = require('../clinics/registry');
      await require('../lifecycle/reviews').scheduleReview(getClinic(tracked.clinic_id), trackedId);
    } catch (e) { console.error('[ConfirmCall] scheduleReview failed:', e.message); }
  } else if (outcome === 'cancel') {
    await newsoft.cancelAppointment({ appointmentId: tracked.newsoft_appointment_id, reason: 'Cancelada pelo paciente na chamada de confirmação (Vicki)' });
    await db.query(`UPDATE appointments_tracked SET confirm_status='cancelled', confirm_channel='call', updated_at=now() WHERE id=$1`, [trackedId]);
  }
  console.log(`[ConfirmCall] Appt ${tracked.newsoft_appointment_id} -> ${outcome} via call`);
}

function register() {
  scheduler.registerHandler(JOB_CONFIRM_CALL, handleConfirmCallJob);
}

module.exports = { register, markConfirmOutcome, placeConfirmCall, JOB_CONFIRM_CALL };
