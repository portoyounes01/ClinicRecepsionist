# Vicki — Work Log (read this first)

> **Purpose:** running record of what we're doing, decisions made, and findings — so any new chat or agent can read this + [ROADMAP.md](ROADMAP.md) and instantly know the current state. Newest entries at the top.

## 📌 CURRENT STATE (snapshot)

- **Active goal:** launch **Super Vicki** = the patient-lifecycle engine (EPIC 1 in [ROADMAP.md](ROADMAP.md)).
- **Live engine:** ✅ ON in production. Postgres connected, tables migrated, scheduler running. Dashboard `/dashboard/api/stats` returns `enabled:true`. Nothing reaches patients yet (no WhatsApp creds + empty tables) → safe.
- **Blocked on:** Meta approving the WhatsApp number (task 1.2) — user already submitted it.
- **Known fixes needed before go-live:**
  1. ✅ FIXED (1.3a, committed not pushed) — `confirmAppointment()` now uses `PUT /appointment/status-code`; reminder eligibility now allows blank + `Z`.
  2. `DASHBOARD_KEY` still default `vicki-dash` (dashboard public) — set with the rest of the env vars in task 1.5.
  3. ⏳ Unpushed commits: the 1.3a code fix is committed locally but **not pushed** — push will redeploy the live phone line, so batch it with the task 1.5 env-var redeploy.

## ⏭️ NEXT ACTIONS

1. **USER:** paste the 3 drafted templates ([whatsapp-templates.md](whatsapp-templates.md)) into Meta WhatsApp Manager for approval (review takes days).
2. When Meta approves the number + templates → set `WHATSAPP_*` + remaining env vars + a real `DASHBOARD_KEY`, **push the unpushed commits in the same redeploy** (task 1.5), then run the E2E tests (1.6–1.9).

> ⚠️ Nothing has been pushed to `main` yet — all commits below are local. The next push will redeploy the live phone line, so it's batched with task 1.5.

---

## LOG

### 2026-06-07 — Language-by-phone + learn-from-calls + Newsoft visit backfill
- **Language:** Newsoft has no language field (confirmed). New [src/lang.js](../../vicki-ai/src/lang.js) `pickLang(knownLang, phone)`: `+351`/local → pt, foreign country code → en, known (voice-detected) language wins; default pt. Applied at every lifecycle send site. `patientMemory.updateAfterCall` now persists voice-detected language to the lifecycle `patients` row (UPDATE-only, fire-and-forget — never affects the live call).
- **Old/dormant patients:** new [src/lifecycle/backfill.js](../../vicki-ai/src/lifecycle/backfill.js) `backfillVisits(clinic, months=24)` derives `last_visit` from past Newsoft appointments (month-chunked; real-doctor + phone + attended only, excludes E/M/F/D), seeds `last_visit` + `recare_due_date` so recare/reactivation can reach them. Manual runner `scripts/backfill-visits.js`; weekly auto-run in boot.js.
- Read-only vs Newsoft, sends nothing (still gated by `LIFECYCLE_TEST_NUMBERS`). `node -c` clean; `pickLang` unit cases pass; `npm run test:lifecycle` passes.
- ⚠️ **Go-live caution:** after the first backfill, many overdue patients will be recare/reactivation-eligible. Reactivation is batch-capped (50/sweep); **recare has no cap** → could enqueue a large first batch. During testing the send-gate blocks real sends; before full go-live, consider a recare daily cap or phased rollout.
- Env added: `BACKFILL_MONTHS` (default 24).


### 2026-06-07 — Daily 07:30 reminder batch + personalized templates (built)
Implemented the user's batch model: **once each morning at 07:30, message everyone with an appointment `today+2`** (date-based), clinic-wide.
- `newsoftApi.js`: new `getAppointmentsByDateRange(begin,end)` (clinic-wide, no PatientId) + export.
- `reminder.js`: new `sweepDailyReminders(clinic)` — fetch the day's appts, filter **real doctor (clinic.doctorIds) + has phone + eligible status (blank/Z)**, upsert patient + appointments_tracked (idempotent), enqueue `reminder_whatsapp`. `handleReminderJob` already schedules the 24h confirm-call, so no separate confirm sweep needed. Updated it to use **first name + weekday/day/month date**, `bodyParams:[firstName, clinic, date, time]`.
- `boot.js`: `scheduleDailyReminderSweep()` — fires at 07:30 clinic-local (re-arms each day; DST-safe). Needs `TZ=Europe/Lisbon`.
- `whatsapp.js`: `firstName(name,lang)` helper exported (safe non-empty fallback).
- `reviews.js`/`recare.js`/`reactivation.js`: bodyParams now lead with `firstName`.
- Templates ([whatsapp-templates.md](whatsapp-templates.md)) rewritten warm/branded/bilingual, `{{1}}`=name, "Bom dia" on reminder (always morning), "Olá" on review/recare.
- **Verified vs live Newsoft (read-only):** real field names (`appointmentDateBeginLocal`, `appointmentStatusCode`, `patientPhoneNumber`, `appointmentId`, `medicId`); list returns phones for ~71% of appts (97/136 known-doctor over 30 days); the sweep correctly excludes admin/blocked entries ("Nao marcar", reception medicIds). Diagnostics kept: `scripts/check-status-codes.js`, `scripts/check-sweep-preview.js`.
- All 7 files `node -c` clean; `npm run test:lifecycle` passes (reminder send shows 1 button as intended). Note: `trackAppointment` (old per-appt path, never called) is superseded by the sweep; idempotency keys prevent any double-send.

### 2026-06-07 — Template buttons revised (per user)
- Reminder buttons changed: **Confirmar** (quick reply) + **Remarcar/Cancelar** as a **Call phone number** CTA that dials the clinic (no self-service auto-cancel). Verified via Meta docs that quick-reply + call button can coexist (grouped, max 1 phone btn).
- Code: [reminder.js](../../vicki-ai/src/lifecycle/reminder.js) now sends only the confirm quick-reply; the call button is static in the template (no component). The old `cancel:` webhook branch is now unused (left in place, harmless).
- All 3 templates to be submitted in **both pt_PT and en**.

### 2026-06-07 — Task 1.4 drafted (WhatsApp templates)
Wrote [whatsapp-templates.md](whatsapp-templates.md): `appointment_reminder` (vars clinic/date/time, buttons Confirmar/Cancelar), `review_request` (vars clinic/link, no buttons), `recare_reminder` (var clinic, button Marcar). pt-PT + EN, variable order matches the code exactly. Ready for the user to submit to Meta. Flagged that recare may be classed as Marketing.

### 2026-06-07 — Task 1.3a done (applied the confirm fix + Z eligibility)
- [newsoftApi.js](../../vicki-ai/src/newsoftApi.js#L242) `confirmAppointment()`: `POST /appointment/confirm` → `PUT /appointment/status-code`, body `{clinicNif, clinicId, costCenterId, appointmentId, appointmentStatusCode:"C", observation}`.
- [reminder.js](../../vicki-ai/src/lifecycle/reminder.js) `isEligibleStatus()`: now allows `""` and `Z` (first-time) via `REMINDABLE_STATUSES`.
- Both syntax-checked (`node -c`). Committed locally; **push deferred** to batch with the 1.5 env redeploy (avoids an extra live-line restart). Fix is dormant until WhatsApp goes live anyway.

### 2026-06-07 — Task 1.3 verified (Newsoft confirm endpoint + status codes)
Ran a read-only diagnostic ([scripts/check-status-codes.js](../../vicki-ai/scripts/check-status-codes.js)) against live Newsoft `GET /appointments/status-code`.

**Live status-code catalog:**
| Code | Meaning | Upcoming/active? |
|---|---|---|
| `""` | pending (not confirmed) | yes — remind |
| `Z` | 1.ª Vez (first-time patient) | yes — remind (currently skipped) |
| `U` | Urgência | yes |
| `C` | **Confirmada** | confirmed — skip |
| `P` | Presença (arrived) | skip |
| `E` | Desmarcada (cancelled) | skip |
| `M` | Desmarcada Médico | skip |
| `D` | Paciente Desistiu | skip |
| `F` | Paciente Faltou (no-show) | skip |
| `N` | Em Consulta | skip |
| `R` | Realizada (done) | skip |
| `S` | SMS Enviado | skip |

**Findings:**
- ✅ Confirmed code is `C` ("Confirmada") → `NEWSOFT_CONFIRMED_STATUS_CODE='C'` is correct.
- ❌ `confirmAppointment()` posts to `/appointment/confirm` — **no such endpoint** in the Newsoft v1 API ([reference](../../vapi-build-plan/newsoft_v1_api_reference.md)). Correct endpoint: `PUT /api/v1/appointment/status-code`, body `{clinicNif, clinicId, costCenterId, appointmentId, appointmentStatusCode:"C", observation}`. (The AI variant `PATCH /ai/appointment/status-code-ai` claims an integer `appointmentStateByAI`, but the live catalog returns string codes — so use the string-code `PUT` path.)
- ⚠️ Reminder eligibility ([reminder.js](../../vicki-ai/src/lifecycle/reminder.js) `isEligibleStatus`) only allows blank status → skips `Z` (first-time) patients. Broaden to `{"" , Z}` (and consider `U`).
- ✅ Cancel path (`DELETE /appointment`) matches the API — no change needed.

### 2026-06-07 — Task 1.1 done (Postgres / DATABASE_URL)
- Discovered Postgres was **already provisioned** in Railway project "The AI Voice" but the app service wasn't wired to it (`enabled:false`).
- Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the `ClinicRecepsionist` service via Railway CLI → redeploy → engine booted, schema migrated, `enabled:true`. Lifecycle engine is now live (idle).

### 2026-06-07 — Plans organized
- Created `docs/plans/` (committed): `ROADMAP.md` (master plan), `overview-super-vicki.md`, `README.md`, and `todo/ in-progress/ done/` buckets with the 5 Vicki plans (copied from `~/.claude/plans/`, originals kept).
- Confirmed "Super Vicki" = the lifecycle engine (WhatsApp reminders, confirm calls, reviews, recare, reactivation). Built + 18 tests passing, not yet live.
