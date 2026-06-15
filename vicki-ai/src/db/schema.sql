-- ============================================================
-- VICKI AI — Patient-Lifecycle Engine Schema (Postgres)
--
-- This schema powers the ADDITIVE lifecycle layer (reminders,
-- confirmations, reviews, recare, reactivation). It does NOT touch
-- the existing inbound booking flow, which still uses flat files.
--
-- All statements are idempotent (CREATE ... IF NOT EXISTS) so the
-- migration runner can re-run safely on every boot.
-- ============================================================

-- ── Clinics ────────────────────────────────────────────────
-- One row per clinic (tenant). config holds Newsoft/WhatsApp/Telnyx
-- credentials + dental settings as JSONB so onboarding a new clinic
-- is a single INSERT (no schema change). Seeded from .env at boot.
CREATE TABLE IF NOT EXISTS clinics (
  id            TEXT PRIMARY KEY,            -- e.g. 'loule'
  name          TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}', -- full clinic config object
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Patients (lifecycle facts) ─────────────────────────────
-- Mirrors the minimum we need to drive lifecycle jobs. NOT a copy
-- of Newsoft — only what we schedule/contact on. PHI kept minimal.
CREATE TABLE IF NOT EXISTS patients (
  id                BIGSERIAL PRIMARY KEY,
  clinic_id         TEXT NOT NULL REFERENCES clinics(id),
  newsoft_patient_id TEXT NOT NULL,
  name              TEXT,
  phone_e164        TEXT,                    -- normalized +351...
  language          TEXT,                    -- 'pt' | 'en'
  last_visit        DATE,
  recare_due_date   DATE,
  opt_out_whatsapp  BOOLEAN NOT NULL DEFAULT false,
  opt_out_sms       BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, newsoft_patient_id)
);
CREATE INDEX IF NOT EXISTS idx_patients_recare ON patients (clinic_id, recare_due_date);

-- ── Tracked appointments ───────────────────────────────────
-- One row per appointment we are managing the lifecycle for.
-- status_code_at_send records the Newsoft appointmentStatusCode at
-- the moment we picked it up — we ONLY remind on empty status.
CREATE TABLE IF NOT EXISTS appointments_tracked (
  id                   BIGSERIAL PRIMARY KEY,
  clinic_id            TEXT NOT NULL REFERENCES clinics(id),
  patient_id           BIGINT REFERENCES patients(id),
  newsoft_appointment_id TEXT NOT NULL,
  appointment_at       TIMESTAMPTZ NOT NULL,
  status_code_at_send  TEXT,                 -- '' eligible; C/I/E -> never reminded
  confirm_status       TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|cancelled|no_response
  confirm_channel      TEXT,                 -- whatsapp|call|null
  reminder_sent_at     TIMESTAMPTZ,
  source               TEXT,                 -- voice_booking|newsoft_sync
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, newsoft_appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_appts_when ON appointments_tracked (clinic_id, appointment_at);

-- ── Jobs (scheduler queue) ─────────────────────────────────
-- Generic due-time queue. idempotency_key prevents duplicate work
-- when webhooks/retries fire more than once.
CREATE TABLE IF NOT EXISTS jobs (
  id              BIGSERIAL PRIMARY KEY,
  clinic_id       TEXT REFERENCES clinics(id),
  type            TEXT NOT NULL,             -- reminder_whatsapp|confirm_call|review_request|review_nudge|recare|reactivation
  run_at          TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|cancelled
  payload         JSONB NOT NULL DEFAULT '{}',
  idempotency_key TEXT UNIQUE,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  locked_at       TIMESTAMPTZ,               -- claim marker (avoid double-dispatch)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs (status, run_at);

-- ── Messages (audit of every outbound/inbound message) ─────
CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  clinic_id       TEXT REFERENCES clinics(id),
  patient_id      BIGINT REFERENCES patients(id),
  channel         TEXT NOT NULL,             -- whatsapp|sms|call
  direction       TEXT NOT NULL,             -- out|in
  template_name   TEXT,
  wa_message_id   TEXT,                      -- dedupe key for inbound webhooks
  status          TEXT,                      -- sent|delivered|read|failed|received
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wamid ON messages (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- ── Call logs (full inbound voice-call record) ─────────────
-- One row per completed inbound call. Stores the outcome + the FULL
-- transcript (conversationHistory) so calls are searchable and you can
-- see exactly what Vicki and the patient said. Written fire-and-forget
-- at hangup — never blocks or breaks a call. PHI: transcript may contain
-- patient details — DB is the HIPAA-relevant store.
CREATE TABLE IF NOT EXISTS call_logs (
  id                   BIGSERIAL PRIMARY KEY,
  clinic_id            TEXT,
  newsoft_patient_id   TEXT,
  patient_name         TEXT,
  caller_number        TEXT,
  outcome              TEXT,                 -- booked|cancelled|info|transferred|abandoned
  intent               TEXT,
  transferred_to_human BOOLEAN NOT NULL DEFAULT false,
  action_fired         TEXT,                 -- book_appointment|cancel_appointment|null (proof a real action ran)
  duration_seconds     INT,
  unclear_turns        INT,
  language             TEXT,
  summary              TEXT,
  flags                JSONB NOT NULL DEFAULT '[]',
  transcript           JSONB NOT NULL DEFAULT '[]', -- full conversationHistory
  telnyx_call_sid      TEXT,                 -- Telnyx call_control_id — links the recording webhook back to this row
  recording_url        TEXT,                 -- filled in later by the recording.saved webhook
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_logs_when ON call_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_outcome ON call_logs (outcome);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs (caller_number);
CREATE INDEX IF NOT EXISTS idx_call_logs_telnyx_sid ON call_logs (telnyx_call_sid);

-- Safe re-run for DBs created before these columns existed.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS telnyx_call_sid TEXT;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_url   TEXT;

-- ── Reviews ────────────────────────────────────────────────
-- Drives the hosted star-form gating flow.
CREATE TABLE IF NOT EXISTS reviews (
  id                    BIGSERIAL PRIMARY KEY,
  clinic_id             TEXT NOT NULL REFERENCES clinics(id),
  patient_id            BIGINT REFERENCES patients(id),
  appointment_id        BIGINT REFERENCES appointments_tracked(id),
  token                 TEXT UNIQUE NOT NULL, -- opaque token in the /review/:token link
  rating                INT,                  -- 1..5, null until submitted
  comment               TEXT,
  completed             BOOLEAN NOT NULL DEFAULT false,
  sent_to_google        BOOLEAN NOT NULL DEFAULT false,
  receptionist_notified BOOLEAN NOT NULL DEFAULT false,
  nudge_count           INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reviews_token ON reviews (token);
