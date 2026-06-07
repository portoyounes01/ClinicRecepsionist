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

1. **Submit the 3 WhatsApp templates** to Meta (task 1.4) — review takes days, start early.
2. When Meta approves the number → set `WHATSAPP_*` + remaining env vars + a real `DASHBOARD_KEY`, **push the 1.3a fix in the same redeploy** (task 1.5), then run the E2E tests (1.6–1.9).

---

## LOG

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
