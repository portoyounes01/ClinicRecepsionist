// ============================================================
// VICKI AI — Clinic Registry (config shim)
//
// Single source of truth for per-clinic config used by the NEW
// lifecycle engine (reminders, confirms, reviews, recare).
//
// For now it holds ONE clinic, seeded from the existing .env vars
// (Instituto Vilas Boas, Loulé). This keeps the lifecycle layer
// clinic-scoped from day one without touching the inbound flow,
// which still reads .env directly. Adding a second clinic later is
// a new entry here (or a row in the `clinics` table) — no schema or
// code change required.
// ============================================================

const db = require('../db');

const LOULE_ID = process.env.CLINIC_ID_SLUG || 'loule';

/**
 * Build the Loulé clinic config from environment variables.
 * Mirrors the env names already used across the codebase so there is
 * one canonical clinic object instead of scattered process.env reads.
 */
function buildLouleClinic() {
  const louleDoctorIds = (process.env.LOULE_DOCTOR_IDS || '1,3,11,13,25,33,36,39')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

  return {
    id:       LOULE_ID,
    name:     process.env.CLINIC_NAME || 'Instituto Vilas Boas',
    location: process.env.CLINIC_LOCATION || 'Loulé',
    address:  process.env.CLINIC_ADDRESS || '',
    phone:    process.env.CLINIC_PHONE || '',
    mobile:   process.env.CLINIC_PHONE_MOBILE || '',
    email:    process.env.CLINIC_EMAIL || '',
    hours:    process.env.CLINIC_HOURS || '',
    locale:   process.env.CLINIC_LOCALE || 'pt-PT',

    newsoft: {
      baseUrl:      process.env.NEWSOFT_BASE_URL,
      nif:          process.env.NEWSOFT_CLINIC_NIF,
      clinicId:     process.env.NEWSOFT_CLINIC_ID,
      costCenterId: process.env.NEWSOFT_COST_CENTER_ID,
    },

    doctorIds: louleDoctorIds,

    // WhatsApp Business Cloud API (direct Meta). Per-clinic credentials.
    whatsapp: {
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      wabaId:        process.env.WHATSAPP_WABA_ID,
      token:         process.env.WHATSAPP_TOKEN,           // permanent system-user token
      appSecret:     process.env.WHATSAPP_APP_SECRET,      // for webhook signature verify
      verifyToken:   process.env.WHATSAPP_VERIFY_TOKEN,    // for webhook GET handshake
      templates: {
        reminder:    process.env.WHATSAPP_TEMPLATE_REMINDER     || 'appointment_reminder',
        review:      process.env.WHATSAPP_TEMPLATE_REVIEW        || 'review_requests',
        reviewNudge: process.env.WHATSAPP_TEMPLATE_REVIEW_NUDGE  || 'review_followup',
        recare:      process.env.WHATSAPP_TEMPLATE_RECARE        || 'recare_reminders',
      },
    },

    // Telnyx (SMS + outbound voice). SMS already configured for inbound.
    telnyx: {
      apiKey:           process.env.TELNYX_API_KEY,
      messagingProfile: process.env.TELNYX_MESSAGING_PROFILE,
      smsSenderId:      process.env.TELNYX_SMS_SENDER || 'IVB',
      voiceAppId:       process.env.TELNYX_APP_ID,
      fromNumber:       process.env.TELNYX_OUTBOUND_NUMBER, // E.164 for outbound calls
    },

    // Reviews
    googleReviewUrl: process.env.GOOGLE_REVIEW_URL || '',  // clinic's "write a review" link

    // Recare
    recareIntervalMonths: parseInt(process.env.RECARE_INTERVAL_MONTHS || '6', 10),

    // Lifecycle timing (hours / overridable for testing)
    reminderLeadHours:   parseInt(process.env.REMINDER_LEAD_HOURS   || '48', 10),
    confirmCallLeadHours: parseInt(process.env.CONFIRM_CALL_LEAD_HOURS || '24', 10),
    reviewDelayHours:    parseInt(process.env.REVIEW_DELAY_HOURS    || '2', 10),

    // Public base URL for hosted pages (review form, tracked links)
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  };
}

// In-memory cache of clinics by id.
let _clinics = null;

function loadClinics() {
  if (_clinics) return _clinics;
  _clinics = new Map();
  const loule = buildLouleClinic();
  _clinics.set(loule.id, loule);
  return _clinics;
}

function getClinic(clinicId) {
  return loadClinics().get(clinicId) || null;
}

/** The default/only clinic for the current single-tenant deployment. */
function getDefaultClinic() {
  return getClinic(LOULE_ID);
}

function allClinics() {
  return Array.from(loadClinics().values());
}

/**
 * Upsert each clinic into the `clinics` table so lifecycle rows can
 * FK to it. No-op if the DB is disabled. Call once at boot after migrate().
 */
async function syncClinicsToDb() {
  if (!db.isEnabled()) return;
  for (const c of allClinics()) {
    await db.query(
      `INSERT INTO clinics (id, name, config, updated_at)
         VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config, updated_at = now()`,
      [c.id, c.name, JSON.stringify(c)]
    );
  }
  console.log(`[Clinics] Synced ${allClinics().length} clinic(s) to DB`);
}

module.exports = { getClinic, getDefaultClinic, allClinics, syncClinicsToDb };
