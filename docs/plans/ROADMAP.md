# Vicki — Master Roadmap

> **North star:** make Vicki a real AI that handles *everything* for the clinic — answers every call, and manages the whole patient lifecycle around it (reminders, confirmations, reviews, recare, win-backs), then scales to many clinics.

This is the single source of truth. Big blocks (EPICS) are ordered top to bottom. Inside each epic, mini-tasks run **1, 2, 3…** in order. Detailed specs live in the linked plan files.

**Legend:** ✅ done · 🔵 in progress · ⏳ blocked/waiting · ⬜ to do

---

## 🟢 DO NOW (while we wait for Meta approval)

The WhatsApp number is submitted to Meta and **pending approval** (Epic 1, task 2). That blocks *sending* WhatsApp, but **none of these** — knock them out in parallel:

- ~~**1.1** Provision Railway Postgres → set `DATABASE_URL`~~ ✅ **done 2026-06-07**
- **1.3** Verify the Newsoft confirm endpoint + status-code meanings
- **1.4** Draft & submit the 3 WhatsApp templates to Meta for review (approval also takes days)
- **1.5** Set the remaining env vars (`PUBLIC_BASE_URL`, `GOOGLE_REVIEW_URL`, `DASHBOARD_KEY`, Telnyx outbound)
- **EPIC 3** voice bug-fixes (no Meta dependency at all)
- **EPIC 2** dashboard metrics (can build now, just shows zeros until data flows)

---

## EPIC 1 — Launch Super Vicki (the Lifecycle Engine) 🔵

Turn on the additive layer: WhatsApp reminders → confirmations → outbound confirm-call fallback → post-visit reviews → recare → reactivation. **Code is built and tested; this epic is about turning it on safely.**
📄 Full spec: [in-progress/lifecycle-engine-super-vicki.md](in-progress/lifecycle-engine-super-vicki.md) · Setup: `vicki-ai/LIFECYCLE_SETUP.md`

| # | Mini-task | Status | Notes |
|---|-----------|--------|-------|
| 1.1 | Provision Railway Postgres, set `DATABASE_URL` (schema auto-applies on boot) | ✅ | **Done 2026-06-07** — Postgres already existed; wired `DATABASE_URL=${{Postgres.DATABASE_URL}}` on `ClinicRecepsionist`; dashboard reports `enabled:true`, tables migrated |
| 1.2 | **WhatsApp number approval in Meta** | ⏳ | **Number submitted — waiting on Meta.** This is the gate. |
| 1.3 | Verify Newsoft confirm endpoint + status codes (C/I/E meanings; remind only on blank status) | ⬜ | The #1 correctness risk — see plan "Open questions" |
| 1.4 | Approve 3 utility templates in Meta: `appointment_reminder`, `review_request`, `recare_reminder` | ⬜ | Submit early — Meta review takes days |
| 1.5 | Set env: `WHATSAPP_*` creds, `PUBLIC_BASE_URL`, `GOOGLE_REVIEW_URL`, `DASHBOARD_KEY`, `TELNYX_APP_ID`, `TELNYX_OUTBOUND_NUMBER` | ⬜ | Full list in LIFECYCLE_SETUP.md. ⚠️ `DASHBOARD_KEY` still defaults to `vicki-dash` — set a real one (dashboard is currently public) |
| 1.6 | Configure Meta webhook → `/whatsapp/webhook`, subscribe to `messages`, verify signature passes | ⬜ | Needs 1.2 done |
| 1.7 | E2E test: reminder → tap Confirm → Newsoft write-back; replay webhook → no double-write (idempotent) | ⬜ | Use Meta test number to your own WhatsApp |
| 1.8 | E2E test: no reply → outbound confirm call (Telnyx) → write-back; SMS fallback if Telnyx unset | ⬜ | |
| 1.9 | E2E test: review flow — 5★ → Google w/ comment copied; 2★ → apology + receptionist alert, NOT Google | ⬜ | |
| 1.10 | Turn on recare (6mo) + reactivation (12mo, capped 50/sweep) daily sweeps | ⬜ | |
| 1.11 | **Go live** + watch the dashboard for the first real reminders/confirmations | ⬜ | Acceptance: real confirmation recorded end-to-end |

---

## EPIC 2 — Finish the Owner Dashboard ⬜

The dashboard v1 is already built ([vicki-ai/src/dashboard/index.js](../../vicki-ai/src/dashboard/index.js)): reminders, confirmations (WhatsApp vs call), reviews, ratings, jobs. Round it out for the clinic owner.

| # | Mini-task | Status |
|---|-----------|--------|
| 2.1 | Add **no-shows recovered** metric | ⬜ |
| 2.2 | Add **recare / reactivation pipeline** metrics (due, sent, re-booked) | ⬜ |
| 2.3 | Low-rating alert feed (recent <4★ with comments) | ⬜ |
| 2.4 | Date-range filter (last 7 / 30 / 90 days) | ⬜ |

---

## EPIC 3 — Harden Vicki v1 (the live voice agent) ⬜

No Meta dependency — can run anytime. Closes out the remaining bugs from the 2026-06-05 call audit.

| # | Mini-task | Status |
|---|-----------|--------|
| 3.1 | Fix slot-search window collapse at the 28-day horizon — 📄 [todo/fix-search-window-collapse.md](todo/fix-search-window-collapse.md) | ⬜ |
| 3.2 | Latency pass — bring p50 first-audio back under target (was spiking ~5s) | ⬜ |
| 3.3 | Barge-in tuning — confirm the over-aggressive cut-off is fully resolved | ⬜ |
| 3.4 | Language threading — guarantee EN caller stays EN across greeting/slots/fillers | ⬜ |
| 3.5 | Script/routing/cleaning/audio fixes — 📄 [done/fix-script-routing-cleaning-audio.md](done/fix-script-routing-cleaning-audio.md) | ✅ |

---

## EPIC 4 — Self-Improving SDR & Outbound ⬜

The bigger vision: Vicki not just answering, but proactively driving bookings and learning from her own calls.
📄 [todo/self-improving-sdr.md](todo/self-improving-sdr.md)

| # | Mini-task | Status |
|---|-----------|--------|
| 4.1 | Nightly call-audit loop → auto-flag failures, propose script/routing tweaks | ⬜ |
| 4.2 | Outbound booking campaigns (beyond confirmations) | ⬜ |
| 4.3 | A/B test prompts on a traffic slice, measure task-completion | ⬜ |

---

## EPIC 5 — Productize / Multi-Clinic ⬜

Make it sellable to many dental clinics (the registry + DB are already multi-tenant-ready).

| # | Mini-task | Status |
|---|-----------|--------|
| 5.1 | Onboard a 2nd clinic (new registry entry + env, no schema change) | ⬜ |
| 5.2 | Inbound number → clinic routing | ⬜ |
| 5.3 | Per-clinic dashboard auth | ⬜ |
| 5.4 | Self-serve onboarding flow | ⬜ |

---

## Dependency map (the short version)

```
Meta number approval (1.2) ─┐
WhatsApp templates  (1.4) ──┼─► WhatsApp send works ─► Epic 1 go-live (1.11) ─► Epic 2 real data
Postgres            (1.1) ──┘
Newsoft verify      (1.3) ─────► confirmations write back correctly

Epic 3 (voice fixes) ── independent, run anytime
Epic 4, Epic 5 ──────── after Epic 1 is live and stable
```

**Right now:** everything in **🟢 DO NOW** above is unblocked. The only true wait is Meta approving the number + templates.
