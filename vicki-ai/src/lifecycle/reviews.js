// ============================================================
// VICKI AI — Lifecycle: Reviews (hosted star-form, gated)
//
// Flow:
//   1. ~2h after a confirmed appointment ends -> send WhatsApp + SMS
//      with a link to OUR review page: /review/:token
//   2. Patient picks 1-5 stars + writes a comment on our page.
//   3. < 4 stars -> do NOT send to Google. Show apology. Notify the
//      real receptionist (Telegram) with the rating + comment.
//   4. >= 4 stars -> redirect to the clinic's Google review URL with
//      their comment pre-copied so they can paste/post it.
//   5. No submission -> one nudge next day, one a week later, then stop.
//
// The star page itself lives in ../reviewpage/ and reads/writes here.
// ============================================================

const db        = require('../db');
const scheduler = require('../scheduler');
const wa        = require('../integrations/whatsapp');
const crypto    = require('crypto');

const JOB_REVIEW_REQUEST = 'review_request';
const JOB_REVIEW_NUDGE   = 'review_nudge';

const NUDGE_NEXT_DAY_HOURS = 24;
const NUDGE_WEEK_HOURS     = 24 * 7;
const MAX_NUDGES           = 2; // next-day, then one week later, then stop

function makeToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Schedule the post-visit review request for a tracked appointment.
 * Call this when an appointment is confirmed/attended.
 */
async function scheduleReview(clinic, trackedId) {
  if (!db.isEnabled()) return;
  const tracked = await db.one(`SELECT * FROM appointments_tracked WHERE id=$1`, [trackedId]);
  if (!tracked) return;

  // One review per appointment.
  const existing = await db.one(`SELECT id FROM reviews WHERE appointment_id=$1`, [trackedId]);
  if (existing) return;

  const token = makeToken();
  await db.query(
    `INSERT INTO reviews (clinic_id, patient_id, appointment_id, token) VALUES ($1,$2,$3,$4)`,
    [tracked.clinic_id, tracked.patient_id, trackedId, token]
  );

  const runAt = new Date(new Date(tracked.appointment_at).getTime() + clinic.reviewDelayHours * 3600_000);
  await scheduler.enqueue({
    clinicId: clinic.id,
    type: JOB_REVIEW_REQUEST,
    runAt: runAt < new Date() ? new Date(Date.now() + 60_000) : runAt,
    payload: { trackedId, token },
    idempotencyKey: `review:${clinic.id}:${tracked.newsoft_appointment_id}`,
  });
}

function reviewLink(clinic, token) {
  const base = (clinic.publicBaseUrl || '').replace(/\/$/, '');
  return `${base}/review/${token}`;
}

// ─── Job: send the review request (WhatsApp + SMS) ─────────────────────────────
async function handleReviewRequestJob(payload) {
  const review = await db.one(
    `SELECT r.*, p.name, p.phone_e164, p.language, p.opt_out_whatsapp, p.opt_out_sms
       FROM reviews r JOIN patients p ON p.id = r.patient_id
      WHERE r.id IS NOT NULL AND r.token=$1`, [payload.token]
  );
  if (!review || review.completed) return;

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(review.clinic_id);
  if (!clinic) return;

  const link = reviewLink(clinic, review.token);

  // WhatsApp template (utility) with the review link as a body/URL param.
  if (!review.opt_out_whatsapp) {
    const sent = await wa.sendTemplate(clinic, review.phone_e164, clinic.whatsapp.templates.review, {
      lang: review.language === 'en' ? 'en' : 'pt_PT',
      bodyParams: [wa.firstName(review.name, review.language), clinic.name, link],
    });
    if (sent) {
      await db.query(
        `INSERT INTO messages (clinic_id, patient_id, channel, direction, template_name, wa_message_id, status)
           VALUES ($1,$2,'whatsapp','out',$3,$4,'sent')`,
        [clinic.id, review.patient_id, clinic.whatsapp.templates.review, sent.messageId]
      );
    }
  }

  // SMS fallback so it reaches non-WhatsApp users too.
  if (!review.opt_out_sms && require('../sendGuard').isAllowed(review.phone_e164)) {
    try {
      const sms = require('../smsService');
      const msg = review.language === 'en'
        ? `${clinic.name}: how was your visit? Leave a quick review: ${link}`
        : `${clinic.name}: como correu a sua visita? Deixe a sua opiniao: ${link}`;
      await sms.sendSMS(review.phone_e164, msg);
    } catch (e) { console.error('[Reviews] SMS send failed:', e.message); }
  }

  // Schedule the first nudge (next day) if still not completed.
  await scheduler.enqueue({
    clinicId: clinic.id,
    type: JOB_REVIEW_NUDGE,
    runAt: new Date(Date.now() + NUDGE_NEXT_DAY_HOURS * 3600_000),
    payload: { token: review.token },
    idempotencyKey: `reviewnudge1:${clinic.id}:${review.token}`,
  });
}

// ─── Job: nudge if not completed ───────────────────────────────────────────────
async function handleReviewNudgeJob(payload) {
  const review = await db.one(
    `SELECT r.*, p.name, p.phone_e164, p.language, p.opt_out_whatsapp
       FROM reviews r JOIN patients p ON p.id = r.patient_id WHERE r.token=$1`, [payload.token]
  );
  if (!review || review.completed) return;            // done -> stop
  if (review.nudge_count >= MAX_NUDGES) return;        // exhausted -> stop

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(review.clinic_id);
  if (!clinic) return;

  const link = reviewLink(clinic, review.token);
  if (!review.opt_out_whatsapp) {
    await wa.sendTemplate(clinic, review.phone_e164, clinic.whatsapp.templates.review, {
      lang: review.language === 'en' ? 'en' : 'pt_PT',
      bodyParams: [wa.firstName(review.name, review.language), clinic.name, link],
    });
  }
  const newCount = review.nudge_count + 1;
  await db.query(`UPDATE reviews SET nudge_count=$2 WHERE id=$1`, [review.id, newCount]);

  // After the next-day nudge, schedule the final weekly nudge.
  if (newCount === 1) {
    await scheduler.enqueue({
      clinicId: clinic.id,
      type: JOB_REVIEW_NUDGE,
      runAt: new Date(Date.now() + NUDGE_WEEK_HOURS * 3600_000),
      payload: { token: review.token },
      idempotencyKey: `reviewnudge2:${clinic.id}:${review.token}`,
    });
  }
}

// ─── Submit handler (called by the hosted star page) ───────────────────────────
/**
 * Record a submitted review and decide routing.
 * @returns {object} { ok, gate:'google'|'apology', googleUrl?, comment? }
 */
async function submitReview(token, rating, comment) {
  if (!db.isEnabled()) return { ok: false };
  const review = await db.one(`SELECT * FROM reviews WHERE token=$1`, [token]);
  if (!review) return { ok: false, notFound: true };

  const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
  const text = (comment || '').slice(0, 2000);

  // Idempotent: if already completed, return the same routing.
  const goesToGoogle = r >= 4;

  const { getClinic } = require('../clinics/registry');
  const clinic = getClinic(review.clinic_id);

  await db.query(
    `UPDATE reviews SET rating=$2, comment=$3, completed=true, completed_at=now(),
            sent_to_google=$4 WHERE id=$1`,
    [review.id, r, text, goesToGoogle]
  );

  if (goesToGoogle) {
    return { ok: true, gate: 'google', googleUrl: clinic?.googleReviewUrl || '', comment: text, rating: r };
  }

  // < 4 stars: apologize + notify the receptionist (once).
  if (!review.receptionist_notified) {
    await notifyReceptionist(clinic, review, r, text);
    await db.query(`UPDATE reviews SET receptionist_notified=true WHERE id=$1`, [review.id]);
  }
  return { ok: true, gate: 'apology', rating: r };
}

async function notifyReceptionist(clinic, review, rating, comment) {
  try {
    const patient = await db.one(`SELECT name, phone_e164 FROM patients WHERE id=$1`, [review.patient_id]);
    const { notify } = require('../telegramBot');
    notify(
      `⚠️ *Low review* (${rating}★) — ${clinic?.name || ''}\n` +
      `Patient: ${patient?.name || 'Unknown'} (${patient?.phone_e164 || '—'})\n` +
      `Comment: ${comment || '—'}\n\n` +
      `Please follow up — NOT sent to Google.`
    );
  } catch (e) { console.error('[Reviews] Receptionist notify failed:', e.message); }
}

function register() {
  scheduler.registerHandler(JOB_REVIEW_REQUEST, handleReviewRequestJob);
  scheduler.registerHandler(JOB_REVIEW_NUDGE, handleReviewNudgeJob);
}

module.exports = {
  scheduleReview, submitReview, register,
  reviewLink,
  handleReviewRequestJob, handleReviewNudgeJob, // exported for tests
  JOB_REVIEW_REQUEST, JOB_REVIEW_NUDGE,
};
