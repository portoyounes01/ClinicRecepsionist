# Vicki — Work Log (read this first)

> **Purpose:** running record of what we're doing, decisions made, and findings — so any new chat or agent can read this + [ROADMAP.md](ROADMAP.md) and instantly know the current state. Newest entries at the top.

## 2026-06-24 (later) — Reschedule now KEEPS the same doctor + leads the caller

Call 71: patient rescheduling with Dr. Hermes was offered Silvia, then Nadine —
Vicki lost the doctor; patient had to insist "com o Dr. Hermes" → confusion.

Root cause (two gaps): (1) the new-slot search wasn't locked to the existing
doctor — the rotation/unlock at [aiLogic.js check_slots](../../vicki-ai/src/aiLogic.js)
deliberately spans the specialty and offers OTHER doctors; (2) the same-doctor
handoff (`rebookContext`) was set only on cancel, consumed at the guard, and its
trigger phrase ("nova vaga/data") didn't match real reschedule wording ("outro horário").

Fix (all null-safe — keyed on `rebookContext`, null for normal bookings):
- `resolveMedicIdByName()` — appointments carry only the doctor NAME (Newsoft omits
  medicId on read-back), so resolve name → id to lock the same doctor.
- `check_slots`: when a rebook is active, lock that doctor's medicId + treat as a
  named-doctor request → suppresses the unlock/rotation that surfaced other doctors.
  Patient can still switch by naming a doctor or saying "outro médico".
- Persist `rebookContext` through the rebook (was nulled at the guard); also derive
  it from the existing appointment at the appointments→booking handoff (no-cancel
  path, call 71); clear on successful booking or explicit doctor change.
- Broaden the rebook-guard trigger to real reschedule phrasings.
- Lead the caller: name the doctor + offer 2 concrete slots; DON'T re-ask the motivo
  on a reschedule (same consulta) — less friction for impatient callers.
- textGym: thread `rebookContext` (was reset every turn → flow untestable); new
  scenario `resched_mesmo_medico`.

**Validation:** `resched_mesmo_medico` 4/4, offers ONLY Dr. Hermes, 0 hallucinations,
log shows `[Rebook] locking same doctor … medicId 11`. Full regression gate GREEN
(safety all 3/3; cancel + resched_later + confirm 2/2). Deployed `614a2bf`, ● Online,
clean boot.

## 2026-06-24 — Regression gate so new edits can't break previous fixes

User: "make a workflow so when you make edits you don't fuck up the previous ones."
Built one command + a mandatory CLAUDE.md rule.

- **`npm run test:regression`** ([vicki-ai/scripts/regression.js](../../vicki-ai/scripts/regression.js)):
  - Phase 0 — `npm ci --dry-run` deploy-readiness (package.json/lock in sync).
  - Phase 1 — deterministic: anti-lie (9/9) + booking-persist (no API key).
  - Phase 2 — gym SAFETY (emg/insurance/human/billing, majority ≥2/3 over 3 runs,
    no hallucinations) + CORE flows (booking/cancel/reschedule/confirm/info; 0% = regression).
  - Exits non-zero on lock drift, any safety miss, or a core regression. `REGRESSION_SKIP_GYM=1`
    runs only the fast 0+1 checks. Safety bar is majority (not strict 100%) so gym
    flakiness doesn't false-fail.
- **Bundled fetch shim** ([scripts/sim/openai-fetch-shim.js](../../vicki-ai/scripts/sim/openai-fetch-shim.js)):
  best-effort `undici.fetch` injection so the gym runs on local Node 24/26 (built-in
  fetch drops OpenAI SSE); no-op on LTS/CI. Added `undici` devDep.
- **CLAUDE.md rule** (🛡️ REGRESSION GATE): branch → change → gate green → deploy →
  verify boot → revert if a green flow goes red.

**Baseline scorecard (deployed `main`):** core flows + ALL safety paths green;
soft spots are pre-existing (new-patient booking ~50% flaky) or gym artifacts
(confirm dry-run can't reach NewSoft) — NOT regressions from recent edits.

**Self-inflicted lesson:** first deploy of this tooling FAILED — added `undici` to
package.json but installed it with `--no-save`, so the lock was out of sync and
Railway's `npm ci` aborted. Live line stayed on the prior good build (no outage);
fixed by `npm install --package-lock-only` + commit (9986e7e). Then added the Phase 0
`npm ci` check so the gate catches this class of failure itself (c271946).

Commits: 1cacd25 (gate), 9986e7e (lock fix), c271946 (Phase 0 hardening).

## 2026-06-17 (later) — RICARDO #38 forever-loop: STT reprompt had NO working escape

Caller kept saying "confirmar a consulta de amanhã"; Vicki repeated the EXACT same
"Desculpe, não percebi bem, pode repetir?" forever until HE hung up. DB transcript
showed only 3 user turns, ZERO assistant turns — her repeats were never logged.

Root cause = the low-STT-confidence reprompt path (callHandler ~901, fires on
confidence<0.55 && wordCount<=4, speaks a FIXED string). Why it never escaped:
- `consecutiveReprompts` (cap at 2) RESETS to 0 whenever a real turn fires → a
  caller alternating clear/unclear fragments resets it forever → cap never hit.
- Silence watchdog (90s) never fired because `lastSpeechTime` updates on EVERY STT
  msg incl. low-confidence ones — he was talking, just misheard, so never "silent".
- Max-duration (15min) irrelevant (call was 28s).
- The reprompts weren't pushed to conversationHistory → invisible in logs AND
  hidden from the history-based STUCK-LOOP detector.

Fixes (additive, callHandler audio layer — NOT gym-testable):
1. Reprompts now pushed to conversationHistory (visible + detectable).
2. New `totalReprompts` counter, NEVER reset → escalate to human at 2-consecutive
   OR 3-total "didn't understand". This is the only backstop that catches an
   actively-talking-but-misheard caller.
3. After the cap, transfer to a human (was: go silent, which stranded the caller).

Deeper cause is 8kHz audio + short pt-PT utterances = genuinely low STT confidence.
Reprompt fix stops the bad UX; raising STT accuracy (16kHz/context weighting) is the
separate lever (user asked about it; no codec change made — needs to know if calls
arrive over wideband vs plain mobile PSTN first).

## 2026-06-17 — Fix two prod failures from JEANINE's calls + confirm/cancel/voice polish

Audited today's 5 calls (call_logs ids 27–31). Two real fuck-ups, both fixed + pushed:
- **#31 false "no appointments":** caller asked to confirm her FATHER's appointment; get_appointments reads only the CALLER's chart → Vicki said "no appointments" (twice). Fix: deterministic intercept BEFORE manage-existing routing — family member + manage verb (confirm/cancel/reschedule/check/"tem consulta") → transfer_to_human. Also broadened FAMILY_MEMBER_RE to PT parents/siblings ("meu pai" wasn't matched — the exact miss).
- **#30 cold emergency:** father's broken tooth handed off with the generic transfer line, no empathy. Cause: the synthetic [continua] turn injected the generic "open naturally" instruction for the emergency agent. Fix: emergency gets its own synthetic instruction (empathy + wish-well + stay on line + transfer).

Also shipped this session: inbound confirm_appointment action wired to Newsoft (PUT status-code "C") with wait-for-true-then-confirm-else-transfer; calmer confirm/booking lines (dropped "!" → over-excited TTS); family-booking plural routing ("os meus filhos"); rebook offer immediately after a cancel.

**Decision (user):** ship what's fixed, watch real calls — do NOT over-engineer against hypotheticals.
**Open watch-items (verify via call_logs on real traffic, not test calls — user can't place test calls):**
1. Family detection is regex-based — a relative NAMED without a relationship word (e.g. "the appointment for António tomorrow") has no family signal and still routes to the caller's chart. Watch for recurrences.
2. Emergency empathy fix is CODE-verified only, not yet seen speaking on a live emergency call.
3. `railway logs` only dumps a ~3s buffered snapshot (NOT a live stream) — inspect calls via the call_logs Postgres table (railway run --service Postgres + public proxy URL), never log-tailing.

## 2026-06-16 — Fix "Vicki says she'll check, then goes silent" (promise-and-stall)

Audited today's 9 calls. Found the recurring "doesn't speak / stops talking" symptom = **filler-then-idle**: LLM emits a filler ("já verifico isso para si") with `action:"none"` and the turn ends with no tool call → dead air until the 90s watchdog hangs up (calls 11 Vânia confirm, earlier Maria #9 reschedule). Confirm/reschedule paths were already patched (31b8c6c / 60cd27f via deterministic `autoSpeak`), but there was **no general guardrail** — any agent could still stall.

Fix (committed + pushed to main):
- `agents/sharedPrompt.js` — global CONTRATO rule: filler that promises a check ⇒ `action` MUST be the matching tool in the same JSON, never `none`.
- `aiLogic.js finalize()` — server-side net: on appointments/router/booking, if `action:none` + speak matches the filler-promise regex + not already chaining + not a synthetic turn → blank the filler and `autoSpeak` to re-run the agent (which injects "Chama IMEDIATAMENTE get_appointments"). Loop-guarded by `!isSyntheticTurn`.

Verified earlier "state stuck after error" claim is **stale** — callHandler catch (1380–1389) already resets `processingTurn`/`isSpeaking`. "Two Vickis" is the patience filler overlapping, already mitigated by `stopFillerIfPlaying()`; not touched.

**Still open / to watch:** call 17 (booking → one turn → silence) looked like caller hangup or endpointing drop, not a logic stall — left alone pending logs. Call 10 cancelled an appt with **Dr. Hugo Almeida** (medicId 25) who is supposed to be hard-excluded — verify the exclusion covers the cancel/get_appointments path.

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
