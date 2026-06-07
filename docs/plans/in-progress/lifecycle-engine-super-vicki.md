# Vicki → Dental Patient-Lifecycle Engine (WhatsApp + Outbound Voice)

## Context

Vicki is today an **inbound-only** PT-PT voice receptionist. The booking/receptionist flow **works well and must NOT be changed**. The goal is to add a **patient-lifecycle automation engine** (reminders, confirmations, reviews, recare, reactivation) as a **separate, additive layer** built on the **WhatsApp Business Cloud API** with outbound voice as fallback — eventually sellable to many dental clinics.

> ⛔ **HARD CONSTRAINT (non-negotiable):** Do **not** edit the existing agents ([src/agents/](vicki-ai/src/agents/)) or the working inbound booking/receptionist pipeline ([callHandler.js](vicki-ai/src/callHandler.js), inbound flow in [server.js](vicki-ai/src/server.js)). All new work lives in **new files / new folders / new agents**. Existing files may be *imported/read* and at most *additively extended* (e.g. new exported function in `newsoftApi.js`) — never have their existing behavior modified.

### Locked decisions
- **WhatsApp:** Direct **Meta Cloud API** (best margin, full control). We build webhook signature verification + idempotency ourselves.
- **Database:** **Postgres** (Railway add-on).
- **First feature:** **WhatsApp reminder + confirm flow.**

---

## Target lifecycle flow (refined per user)

1. **Reminder** — WhatsApp utility template with **Confirm / Cancel** quick-reply buttons, ~48h before appointment.
   - ⚠️ **Eligibility filter:** ONLY send for appointments whose **`appointmentStatusCode` is empty/blank**. If it contains `C`/`c`, `I`/`i`, `E`/`e` (or any non-empty status) → **skip** — these are cancelled / patient-not-coming / doctor-cancelled, so we must never confirm them. Status comes from the existing `getPatientAppointments` ([newsoftApi.js:186](vicki-ai/src/newsoftApi.js#L186)); booking sets it to `''` at [newsoftApi.js:223](vicki-ai/src/newsoftApi.js#L223). **[TODO: verify exact meaning of C/I/E against live Newsoft data before shipping.]**
2. **Confirm** — button tap → webhook → write confirmation back to Newsoft.
3. **No reply** → **outbound voice call** ~24h before to confirm (separate confirm-only agent).
4. **Post-visit reviews (hosted star form, NOT a bare link)** — 2h after appointment, WhatsApp + SMS with a link to **our own review page**:
   - Patient picks **1–5 stars** and writes a comment on our page.
   - **< 4 stars:** do NOT send to Google. Show apologetic message ("This is very valuable — we're sorry, we'll let our team know"). **Notify the real receptionist** (Telegram/WhatsApp/dashboard alert) with the comment + rating.
   - **≥ 4 stars:** redirect to **Google Maps review**, with their typed comment **pre-copied** (clipboard + prefilled where possible) so they paste/post it directly.
5. **Review nudge** — if no review submitted: resend next day (once), then stop; retry once a week later, then stop permanently.
6. **Database reactivation** — re-engage dormant patients (lapsed recare, no future appointment), frequency-capped, opt-out respected.

---

## Architecture (all additive — nothing rewires the existing flow)

### 1. Postgres (Railway add-on)
Small query layer (`pg` + simple SQL migrations, no heavy ORM). Tables:
- `clinics` — per-clinic config (Newsoft creds, WhatsApp creds, doctor IDs, Google review URL, recare interval).
- `patients` — lifecycle facts (newsoftPatientId, phone, language, lastVisit, recareDueDate, optOut).
- `appointments_tracked` — (id, clinicId, patientId, newsoftAppointmentId, datetime, **statusCodeAtSend**, confirmStatus, source).
- `jobs` — (type, runAt, status, payload, idempotencyKey, attempts).
- `messages` — (channel, templateName, waMessageId, status, direction, payload).
- `reviews` — (appointmentId, patientId, rating, comment, completed, sentToGoogle, nudgeCount, receptionistNotified).

### 2. Clinic config shim (`src/clinics/registry.js`)
Wrap the current Loulé `.env` into **one `clinic` object** seeded in the registry, so all NEW lifecycle code is clinic-scoped from day one. The existing inbound flow keeps using `.env` directly — we do **not** retrofit it now (that touches working code). Multi-tenant onboarding of a *second* clinic is a later, separate phase.

### 3. WhatsApp Cloud API (`src/integrations/whatsapp.js`)
Platform rules baked in:
- Cloud API only (on-prem deprecated Oct 2025). Meta App + WABA + verified number.
- **Utility templates** with up to 3 quick-reply buttons (Confirm/Cancel).
- Webhook must: verify `X-Hub-Signature-256` (HMAC-SHA256 w/ App Secret), return **200 < 5s**, process async, be **idempotent** (Meta retries up to 7 days → dedupe on `waMessageId`).
- **24h service window:** free replies/utility templates inside an open window.
- Functions: `sendTemplate(clinic, to, templateName, vars, buttons)`, `verifyWebhook(req)`, `parseInbound(payload)`.
- New webhook endpoint mounted in server (additively): `POST/GET /whatsapp/webhook`.

### 4. Scheduler + jobs (`src/scheduler/index.js`)
DB-backed job queue (poll every N min for due `jobs`, dispatch by type, mark done/failed with retry/backoff, idempotency keys). Job types: `reminder_whatsapp`, `confirm_call`, `review_request`, `review_nudge`, `recare`, `reactivation`. Modeled on the existing nightly-schedule shape ([improvementAgent.js:153](vicki-ai/src/improvementAgent.js#L153)) but generalized — **new file, existing one untouched.**

### 5. Outbound confirm voice (`src/outbound/voiceConfirm.js` + new `src/agents-lifecycle/confirmAgent.js`)
Telnyx **Call Control (V2) originate** (distinct from existing inbound TeXML path). A **brand-new minimal confirm-only agent** (in a NEW folder `src/agents-lifecycle/`, NOT `src/agents/`) handles: "Confirming your appointment {date} {time} — can you make it?" → writes result back to Newsoft. Reuses the audio pipeline from [callHandler.js](vicki-ai/src/callHandler.js) by *importing* its helpers, without modifying it.

### 6. Reviews module (`src/lifecycle/reviews.js` + `src/reviewpage/`)
- Hosted star-rating page (server-rendered or tiny SPA) at `/review/:token` (token maps to appointment+patient).
- On submit: store rating+comment. Branch on rating (<4 vs ≥4) per the flow above.
- Receptionist notification reuses existing Telegram `notify` ([telegramBot.js](vicki-ai/src/telegramBot.js)) — additively (new message type), plus dashboard later.
- Google handoff: ≥4 → redirect to clinic's Google review URL with comment copied to clipboard (and prefilled via URL param where Google supports it). **[ASSUMPTION — verify Google review URL prefill behavior.]**

### 7. Newsoft confirm write-back (additive export in `newsoftApi.js`)
Add a NEW exported function (e.g. `confirmAppointment({appointmentId})`) that sets the appropriate status code — **without altering** existing `getPatientAppointments`/`bookAppointment`/`cancelAppointment`. **[TODO: verify which Newsoft endpoint/field marks "confirmed" before deploying.]**

---

## Lifecycle modules (`src/lifecycle/`)
- `reminder.js` — find eligible appointments (empty status only), create `appointments_tracked`, schedule + send WhatsApp reminder; handle Confirm/Cancel webhook → Newsoft write-back; schedule `confirm_call` fallback if no reply by 24h.
- `reviews.js` — 2h post-appointment request, star-form gating, nudge cadence (next day once → weekly once → stop).
- `recare.js` — recare-due patients (lastVisit + interval, no future appt) → re-engagement template.
- `reactivation.js` — dormant patients, frequency-capped, opt-out respected.

**Compliance:** honor WhatsApp STOP / opt-out per channel; keep PHI out of logs (per CLAUDE.md).

---

## Owner dashboard (later phase, `src/dashboard/`)
Reads the new Postgres tables: reminders sent, confirmations (WhatsApp vs call), no-shows recovered, review completion + rating distribution, low-rating alerts, recare/reactivation pipeline. Per-clinic auth (don't reuse global `ADMIN_KEY`). Does not touch existing inbound logging.

---

## Build order (each step shippable; existing flow untouched throughout)

1. **Postgres + clinic-config shim** — provision Railway Postgres, create tables, seed Loulé clinic config in `src/clinics/registry.js`.
2. **WhatsApp integration + webhook** — `src/integrations/whatsapp.js`, `/whatsapp/webhook` (signature verify, idempotent). Approve utility reminder template in Meta.
3. **Reminder + confirm flow** — eligibility filter (empty `appointmentStatusCode` only), scheduler fires `reminder_whatsapp`, Confirm/Cancel → Newsoft write-back (new `confirmAppointment`).
4. **Outbound confirm-call fallback** — `voiceConfirm.js` + new `confirmAgent` (in `src/agents-lifecycle/`), Telnyx Call Control originate, no-reply trigger.
5. **Reviews flow** — hosted star form, <4 vs ≥4 gating, receptionist alert, Google handoff, nudge cadence.
6. **Recare + reactivation.**
7. **Owner dashboard.**
8. **Multi-tenant onboarding** — second clinic, per-clinic auth, number→clinic routing (only here do we consider touching inbound routing — separately, carefully).

---

## Critical files

**New (all additive):** `src/clinics/registry.js`, `src/db/` (schema + queries), `src/integrations/whatsapp.js`, `src/scheduler/index.js`, `src/lifecycle/{reminder,reviews,recare,reactivation}.js`, `src/outbound/voiceConfirm.js`, `src/agents-lifecycle/confirmAgent.js`, `src/reviewpage/`, `src/dashboard/`.

**Extended additively only (no existing behavior changed):**
- [src/newsoftApi.js](vicki-ai/src/newsoftApi.js) — add `confirmAppointment(...)` export; reuse `getPatientAppointments` read-only for the eligibility filter.
- [src/server.js](vicki-ai/src/server.js) — mount NEW routes (`/whatsapp/webhook`, `/review/:token`, dashboard) alongside existing ones; do not alter existing route handlers.
- [src/telegramBot.js](vicki-ai/src/telegramBot.js) — reuse `notify` for receptionist low-rating alerts (new call site, no change to existing logic).

**Imported read-only / reused, NEVER modified:** [src/agents/](vicki-ai/src/agents/) (all), [src/callHandler.js](vicki-ai/src/callHandler.js) (import audio helpers for confirm call), [src/aiLogic.js](vicki-ai/src/aiLogic.js).

---

## Verification

- **No-regression first:** run existing harnesses ([scripts/textGym.js](vicki-ai/scripts/textGym.js), [voiceGym.js](vicki-ai/scripts/voiceGym.js), [golden-routing-language-test.js](vicki-ai/scripts/golden-routing-language-test.js)) and confirm the inbound booking flow is byte-for-byte unchanged.
- **Eligibility filter:** feed mock `getPatientAppointments` results with statuses `''`, `C`, `I`, `E` → assert reminders scheduled ONLY for `''`.
- **WhatsApp:** Meta test number → send reminder template to your own WhatsApp, tap Confirm → webhook hits `/whatsapp/webhook`, signature passes, Newsoft `confirmAppointment` succeeds. Replay same webhook → no double-write (idempotent).
- **Confirm call fallback:** with `VICKI_DRY_RUN=1`, simulate no WhatsApp reply → assert `confirm_call` job scheduled; live-test originate to your own phone.
- **Reviews:** simulate appointment +2h → form link sent. Submit 5★ → redirected to Google with comment copied. Submit 2★ → apology shown, receptionist Telegram alert fires, NOT sent to Google. No submission → one nudge next day, one a week later, then stop.
- **Scheduler:** insert job `runAt` +1 min (dry-run) → fires once, marks done, not re-run.

---

## Open questions to resolve while building
- **Newsoft confirm field** — exact endpoint/status code that marks "confirmed". [TODO: verify before deploying]
- **Status letters** — confirm C/I/E meanings (cancelled / not-coming / doctor-cancelled?) against live data. [TODO: verify]
- **Google review prefill** — confirm how much of the comment we can prefill vs clipboard-only. [ASSUMPTION — verify]
