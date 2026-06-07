# Plan: "Vicki AI" — Self-Improving AI SDR for Portuguese Dental Clinics

## Context

You sell **Vicki AI** — an AI receptionist for dental clinics (books/reschedules/cancels,
answers on WhatsApp, branded SMS confirmations, builds the website, auto-writes SEO blogs to rank
the clinic in Portugal). The human receptionist only handles emergencies/approvals.

You want a **24/7 AI agent** (not a static email tool) that: finds PT dental clinics → finds the
right business email → writes a personalized email that lands in the inbox → **the AI itself reads
replies, follows up in context, and keeps the conversation going** → when a clinic is interested it
**books the demo directly into your GoHighLevel calendar** and drops them into your GHL pipeline →
and the system **keeps improving itself** (copy, timing, follow-up strategy, targeting).

Built in the **WAT framework**: Python **tools/** do deterministic work (scrape, verify, send,
book, learn), markdown **workflows/** are the SOPs, and a Claude-driven loop is the brain.

### Three findings that shaped this design
1. **Infrastructure beats copy.** Personal Gmail burns in ~30 days. We send from **2–3 dedicated,
   warmed domains via Instantly** (real warmup network + 24/7 sending).
2. **GoHighLevel is NOT for cold sending** — its "warmup" is just a send-cap, no engagement signals.
   GHL's *own* docs say: run cold outreach on Instantly/Smartlead, then migrate engaged leads into
   GHL. So **Instantly = cold sending; GHL = calendar + CRM + pipeline.** GHL API v2 gives us
   create-contact, opportunities/pipeline, and create-appointment endpoints (+ webhooks).
3. **Portugal (EU) is strict.** Law 41/2004 allows B2B cold email to **generic clinic addresses**
   (`geral@`, `info@`, `marcacoes@`) on an **opt-out** basis; emailing a **named individual**
   requires opt-in consent (CNPD fines this). **Decision: target generic clinic addresses only** —
   compliant *and* those inboxes are actively read. Every email carries sender identity, postal
   address, privacy-policy link, and unsubscribe; we keep a global suppression list + a one-page LIA.
   *(General info, not legal advice — a short check with a PT data-protection lawyer before scaling
   is wise.)*

---

## Architecture: the AI SDR loop

```
        ┌─────────────── DAILY PIPELINE (Windows Task Scheduler) ───────────────┐
        │ scrape PT clinics → find geral@ email → verify → suppression-check →   │
        │ AI writes personalized PT email (reads the Playbook) → send via Instantly│
        └───────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
        ┌──────────────── AI SDR BRAIN (runs continuously) ─────────────────────┐
        │ watch inbox (Instantly API) → Claude classifies each reply:           │
        │   • interested  → propose times from GHL free/busy → BOOK in GHL       │
        │                   → create GHL contact + opportunity (pipeline)         │
        │   • question    → Claude answers in context, continues thread          │
        │   • not now     → schedule a smart follow-up                            │
        │   • no reply    → AI-written contextual follow-up (not a template)      │
        │   • opt-out     → add to global suppression list, stop forever         │
        └───────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
        ┌──────────── SELF-IMPROVEMENT LOOP (weekly optimizer) ─────────────────┐
        │ analyze outcomes → update the Playbook: copy/angles, send timing,      │
        │ follow-up strategy, and targeting (bias sourcing to clinics that book) │
        └───────────────────────────────────────────────────────────────────────┘
```

### Autonomy — my recommendation: **"earns autonomy"**
Start in **draft-for-approval** (AI drafts every reply/follow-up; you one-click approve from a
simple review queue) for the first ~2 weeks. Once its drafts are consistently good, graduate to
**fully autonomous** replies + follow-ups. **Bookings** always auto-create in GHL (a calendar slot
you can decline) and notify you. This gives scale without an off-message AI reply hitting a real
prospect early on. You can flip the autonomy level with one setting.

---

## Recommended Stack

| Layer | Tool | Role |
|---|---|---|
| Lead sourcing | **Apify** Google-Maps/Dentist scraper | PT clinics: name, site, phone, email, rating, reviews |
| Email enrichment | Apify + our contact-page crawler | role-based emails (`geral@`/`info@`/`marcacoes@`) |
| Verification | **ZeroBounce** API (valid-only) | bounce rate <1% (>2% kills a domain) |
| AI brain | **Claude (Anthropic API)** `claude-sonnet-4-6` | writes PT copy, runs replies/follow-ups, books |
| Cold sending + warmup | **Instantly.ai** | dedicated warmed domains, 24/7, reply pull via API |
| Calendar + CRM + pipeline | **GoHighLevel** (API v2) | book appointments, contacts, opportunities |
| Learning state | local **SQLite** (`data/sdr.db`) | conversations + per-variant metrics |
| Scheduling | Windows Task Scheduler | runs daily sourcing pipeline + the SDR poll loop |

---

## What I'll build in this repo

```
tools/
  scrape_dental_clinics.py    # Apify → PT clinics → .tmp/leads_raw.json
  find_clinic_email.py        # crawl site → role-based email
  verify_emails.py            # ZeroBounce → valid only
  suppression_check.py        # drop opt-outs / suppression list
  generate_email.py           # Claude → personalized PT email (reads Playbook variant)
  send_via_instantly.py       # push approved emails into Instantly campaign
  monitor_replies.py          # pull new replies from Instantly API
  ai_sdr_reply.py             # Claude: classify reply → draft/send response or follow-up
  ghl_book_appointment.py     # GHL free/busy → create appointment
  ghl_sync_contact.py         # create/update GHL contact + opportunity (pipeline stage)
  optimize_playbook.py        # weekly: update copy/timing/follow-up/targeting from metrics
  run_pipeline.py             # orchestrates the daily sourcing→send run
  run_sdr_loop.py             # orchestrates the continuous reply/follow-up/booking loop
workflows/
  00_compliance.md  01_source_leads.md  02_enrich_and_verify.md  03_generate_copy.md
  04_send_and_warmup.md  05_ai_conversation_and_followup.md  06_booking_and_crm_ghl.md
  07_self_improvement.md  setup_sending_infrastructure.md
compliance/
  LIA.md  email_footer_PT.md  privacy_policy_PT.md
data/
  sdr.db                      # SQLite: conversations, variants, outcomes (not disposable)
  playbook.json               # current best copy angles, timing, follow-up cadence, targeting
.tmp/                         # disposable intermediates
```

**Copy strategy (research-backed):** native Portuguese, plain text, **under 80 words**, one link,
no images/attachments, one personalized opener per clinic (their Google rating / missing online
booking / after-hours missed calls → Vicki solves it), one soft CTA (10-min demo), compliant footer.

**Self-improvement (all four dimensions you chose):** every send/reply is tagged with its variant
(subject, angle, send time, follow-up step, clinic segment). `optimize_playbook.py` runs weekly,
reads `sdr.db`, and rewrites `playbook.json` to favor the highest reply/booking variants — and
biases `scrape_dental_clinics.py` toward the clinic segments (size/rating/region) that book most.

---

## Phased Implementation

**Phase 0 — Accounts & keys (you, ~1–2 h).** Signup checklist: Apify, ZeroBounce, Instantly,
Anthropic API, **GoHighLevel API v2 token + calendar/pipeline IDs**, and **register 2–3 sending
domains** (buy first — they need ~30 days aging + warmup). Keys → `.env`.

**Phase 1 — Sending infrastructure (background, 4–6 wks warmup).** SPF/DKIM/DMARC + custom
tracking domain per sending domain; start Instantly warmup; set up Google Postmaster Tools. Build
proceeds in parallel while domains warm.

**Phase 2 — Compliance scaffolding.** `00_compliance.md`, `compliance/` docs (LIA, PT footer,
privacy policy), `suppression_check.py`. Nothing sends without this.

**Phase 3 — Sourcing pipeline.** `scrape → find_email → verify → generate → send`, wired by
`run_pipeline.py`. Leads land in GHL as contacts.

**Phase 4 — AI SDR brain.** `monitor_replies → ai_sdr_reply → ghl_book_appointment → ghl_sync_contact`,
wired by `run_sdr_loop.py`, starting in **draft-for-approval** mode with a simple review queue.

**Phase 5 — Self-improvement.** `optimize_playbook.py` + `sdr.db` schema; weekly scheduled run.

**Phase 6 — Launch, monitor, graduate.** Small test batch + spam-score check first. Watch bounce
(<3%), spam complaints (<0.1%), reply/booking rate. As drafts prove out, flip the SDR to autonomous.
Fold every lesson back into the workflows (the WAT loop).

## Realistic timeline
- **System built & tested:** days, once accounts exist.
- **First safe high-volume sends:** after **~4–6 weeks** of domain warmup (non-negotiable). A small
  careful test batch can run sooner.

## What I need from you to start (Phase 0)
1. Approve this plan.
2. Choose **Instantly** (recommended) vs **Smartlead** for the cold-sending layer.
3. Sign up for the accounts above + buy 2–3 sending domains; paste keys into `.env`; give me your
   **GHL API token, calendar ID, and pipeline/stage IDs**.
4. Confirm your company name + postal address + privacy-policy URL (required in every email footer).

## Verification (how we'll know it works)
- Each tool runs standalone on a 5-clinic sample and prints valid JSON.
- `run_pipeline.py` produces verified, personalized, compliant leads as GHL contacts.
- A test send scores well on an inbox-placement/spam check before any real volume.
- End-to-end on a seeded test lead: receives email #1 → an **AI-written** follow-up after no reply →
  when the lead replies "interested," the AI proposes a time and a **real appointment appears in your
  GHL calendar** with the contact in your pipeline → an opt-out reply lands them on the suppression
  list and stops all sends.
- After a week of data, `optimize_playbook.py` updates `playbook.json` with the winning variants.
