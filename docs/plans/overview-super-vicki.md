# Vicki — What We're Doing & The "Super Vicki" Plan

> Reference / orientation doc. "Super Vicki" = the **Lifecycle Engine**.

---

## Context

Vicki is a custom AI voice receptionist for **Instituto Vilas Boas** dental clinic (Loulé, Portugal), running in production on Railway and speaking European Portuguese (pt-PT). It is hand-built (not Vapi/Retell) on a real-time pipeline:

```
Caller → Telnyx (PCMU 8kHz) → Soniox STT (pt-PT) → OpenAI LLM (5-agent router)
       → ElevenLabs TTS → caller
```

Clinic data (patients, slots, booking) comes live from the **Newsoft DS API**. The phone agent handles inbound booking, cancellations, appointment lookup, emergency triage, FAQ, and human transfer.

There are **two parallel work-streams**: (1) fixing the live voice agent "v1", and (2) shipping **Super Vicki** — the additive Lifecycle Engine.

> Note: CLAUDE.md describes the LLM as Claude Sonnet 4.6, but the code currently runs OpenAI — a doc/code discrepancy worth reconciling later.

---

## Super Vicki = the Lifecycle Engine

An **additive, self-disabling** layer: if `DATABASE_URL` is unset the whole thing stays off and the live phone line is unaffected. Five automated outbound touchpoints:

1. **WhatsApp reminders** — 48h before, Confirmar/Cancelar buttons (Meta Cloud API v21.0). Only for blank-status appointments.
2. **Outbound confirmation calls** — 24h before, only if no WhatsApp reply. Telnyx + SMS fallback, writes outcome back to Newsoft.
3. **Post-visit reviews** — ~2h after. ≥4 stars → Google, <4 → private apology + staff alert. Nudges at 24h & 7 days.
4. **Recare** — "time for a checkup" at 6 months. Never auto-books.
5. **Reactivation** — "we miss you" for 12+ month dormant patients. Capped at 50/sweep, 180-day cooldown, opt-out respected.

**Built on:** Postgres (6 tables), a DB-backed job scheduler (claim-with-lock, retries, idempotent), the `src/lifecycle/` modules, `src/integrations/whatsapp.js`, `src/outbound/voiceConfirm.js`, and a multi-tenant clinic registry. Wired into `server.js` via `bootLifecycle()`.

**Status:** Built, 18 tests passing, **NOT yet live.**

**Before go-live:** verify Newsoft confirm endpoint + status codes, test Google-review UX, provision `DATABASE_URL` + approved WhatsApp templates + `PUBLIC_BASE_URL`/`GOOGLE_REVIEW_URL`/`DASHBOARD_KEY`. (Later: 2nd-clinic routing.)

Full plan: [in-progress/lifecycle-engine-super-vicki.md](in-progress/lifecycle-engine-super-vicki.md). Setup guide: `vicki-ai/LIFECYCLE_SETUP.md`.

---

## Parallel: fixing Vicki v1

6 bugs from the 2026-06-05 audit: date-range bug, hallucinated "no slots", language thrash, over-aggressive barge-in, latency spikes (~5s), emergency↔info ping-pong. Several already fixed in recent commits — see [done/fix-script-routing-cleaning-audio.md](done/fix-script-routing-cleaning-audio.md) and the open [todo/fix-search-window-collapse.md](todo/fix-search-window-collapse.md).

---

## Summary

| Track | What | Status |
|-------|------|--------|
| **Vicki v1** | Live inbound pt-PT voice receptionist | In production, bug-fixing |
| **Super Vicki (Lifecycle Engine)** | Reminders, confirm calls, reviews, recare, reactivation | Built + tested, awaiting verification + go-live |
| **vapi-build-plan/** | Exploratory VAPI rebuild | Reference only |
