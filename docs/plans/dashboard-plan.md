# Vicki — Ultimate Dashboard Plan

> Single pane of glass: **everything Vicki does** — every WhatsApp/SMS/call she sends, every patient reply, confirmations, reviews, recare/reactivation, and voice-call outcomes. This doc is the build spec; when we build the dashboard we follow this.

## Context & goal

Today's dashboard ([src/dashboard/index.js](../../vicki-ai/src/dashboard/index.js)) shows only summary counts (reminders, confirmations, reviews, jobs). The clinic needs **full operational visibility**: who was messaged, what they replied, what's pending, which reviews came in, who's due for recare, and how the phone agent is performing — all filterable by date, with patient-level drill-down.

## Users & access (⚠️ PHI — do this right)

The dashboard shows patient names, phone numbers, and review comments = **PHI**. Requirements:
- Replace the `?key=` query param with a real **login** (per-clinic username + password / session cookie). The current `DASHBOARD_KEY` default (`vicki-dash`) is public — must be closed before this ships.
- HTTPS only; **mask phone numbers** to last 4 digits in lists (full number only on explicit drill-down + access log).
- **Access logging** (who viewed what, when) per HIPAA.
- Per-clinic scoping from day one (a clinic user sees only their clinic's data).

## Data sources

All in Postgres ([schema.sql](../../vicki-ai/src/db/schema.sql)) except voice calls:
- `appointments_tracked` — appointment, reminder_sent_at, confirm_status, confirm_channel, source.
- `messages` — **both directions** (`out` = Vicki sends; `in` = patient taps/replies) + `status` (sent/delivered/read/failed/received), `template_name`, `wa_message_id`, `payload`.
- `reviews` — rating, comment, completed, sent_to_google, receptionist_notified, nudge_count.
- `patients` — name, phone, language, last_visit, recare_due_date, opt-outs.
- `jobs` — type, run_at, status, attempts (scheduler queue).
- `clinics` — config.
- **Voice calls:** `data/call_log.jsonl` (append-only; outcome, intent, duration, language, flags, summary).

### Data gaps to fill FIRST (small, prerequisites)
1. **Link inbound messages to a patient.** Inbound rows ([routes.js](../../vicki-ai/src/lifecycle/routes.js#L74)) store only `wa_message_id`, `status`, `payload` — no `patient_id`/`clinic_id`. Add: resolve sender phone → patient and set `patient_id`/`clinic_id` so per-patient threads work.
2. **Store message body/snippet** for outbound (currently only `template_name`). Add a short rendered text snippet to `messages.payload` so the feed shows what was actually said.
3. **(Optional) Move call outcomes to a `calls` table** instead of JSONL, so the calls section is queryable/filterable (otherwise read+parse the JSONL).
4. Confirm `messages` has indexes on `(clinic_id, created_at)` and `(patient_id)` for the feed/threads.

## Dashboard sections

### A. Overview (KPI cards, date-range aware)
Reminders sent · confirmation rate · confirmed via WhatsApp vs call · cancellations · **no-shows prevented** (confirmed that would've lapsed) · reviews collected · avg rating · Google reviews driven · low-rating alerts · recare sent / re-booked · reactivation sent · messages out/in · delivery rate · **calls handled / booking rate / transfer rate / abandonment** · jobs pending/failed.

### B. Appointments & Confirmations (table)
Row per tracked appointment: patient (masked), date/time, doctor, reminder sent at, **confirm status** (pending/confirmed/cancelled), **channel** (WhatsApp/call), language, source. Filters: status, date range, doctor. This is the "did Vicki get it confirmed?" view.

### C. Messages / Conversations (the core "everything")
Two views over the `messages` table:
- **Live feed** — chronological: timestamp, patient (masked), channel (WhatsApp/SMS), **direction** (Vicki→ / →patient), type (reminder/review/recare/confirm/button-tap/text), status (sent→delivered→read / received / failed), snippet.
- **Per-patient thread** — click a patient → full back-and-forth (Vicki's reminder → patient's "Confirmar" tap → etc.), like a chat log. Exactly "confirmations from Vicki and from the patient."
Filters: channel, direction, type, status, date, search by name/phone.

### D. Reviews
List: date, patient (masked), **rating (1–5)**, comment, sent_to_google?, receptionist_notified?, nudge_count. Rating distribution chart. Highlight **low (<4★)** with comments + alert status. Link to the hosted review page.

### E. Recare & Reactivation pipeline
- **Due for recare**: patients with `recare_due_date <= today` and no upcoming appt — count + list, sent vs pending, re-booked.
- **Dormant (reactivation)**: `last_visit` > 12mo, sent (batch-capped), responses.
- Funnel: due → messaged → replied → re-booked.

### F. Voice calls (from call_log.jsonl / `calls` table)
Recent calls: time, caller (masked), **outcome** (booked/cancelled/info/transferred/abandoned), intent, duration, language, **flags** (no_slots_found, barge_in_heavy…), summary. KPIs: calls/day, booking rate, transfer rate, abandonment, avg duration, hallucination/issue flags. This is Vicki's phone performance — ties back to CLAUDE.md's KPIs.

### G. Jobs & system health
Scheduler: pending/running/failed jobs by type, **upcoming sends** (next 24h), failures with attempts/next-retry. Last run + result of: daily 07:30 reminder sweep, recare/reactivation sweeps, weekly backfill. WhatsApp template status + (if available) quality rating. DB/Newsoft/WhatsApp connectivity health.

### H. Patients (search/drill-down)
Search by name/phone → patient card: language, last_visit, recare due, opt-out flags, full message thread (section C), appointment history, reviews.

## Cross-cutting
- **Date-range filter** (Today / 7d / 30d / custom) applied across sections.
- **Auto-refresh** (existing 30s) + manual refresh; consider a small live feed.
- **CSV export** per section for the clinic's own reporting.
- **Opt-out management** — see/honor WhatsApp/SMS opt-outs; let staff toggle.
- **Multi-clinic** ready (clinic selector for the operator; clinic users locked to theirs).

## Technical approach (buildless, matches the codebase)
- Keep it **server-rendered + vanilla JS**, no build step (consistent with current `src/dashboard/index.js` and `src/reviewpage/`).
- Tabs for sections A–H; each backed by a small JSON endpoint:
  `/dashboard/api/{overview,appointments,messages,thread,reviews,recare,calls,jobs,patients}` — all date-range + clinic scoped, auth-guarded.
- Reuse the existing `db` query layer; read `call_log.jsonl` for section F (until a `calls` table exists).
- One shared HTML shell + CSS (dark theme already in place); progressive — ship section by section.

## Phased build order
1. **Auth + PHI hardening** (login, masking, access log) — gate everything.
2. **Prerequisites** (link inbound messages to patient; store outbound snippet; indexes).
3. **Overview KPIs** (extend current stats).
4. **Messages/Conversations** (feed + per-patient thread) — the highest-value "everything" view.
5. **Appointments & Confirmations** table.
6. **Reviews** + **Recare/Reactivation** pipeline.
7. **Voice calls** (read JSONL → later a `calls` table).
8. **Jobs/health**, **Patients search**, **CSV export**, **multi-clinic selector**.

## Verification
- Seed test rows (or use the `LIFECYCLE_TEST_NUMBERS` test data) → each section renders, counts reconcile with raw SQL.
- Confirm a real flow end-to-end appears: reminder sent (out) → "Confirmar" tap (in) → status confirmed → review request (out) → rating (in) all show in the patient thread.
- Verify auth blocks unauthenticated access and phones are masked; access log writes.
- Date-range filter changes every section consistently; CSV export matches the table.

## Open questions
- Auth: simple shared login now, or per-user accounts? (PHI suggests per-user + audit.)
- Keep voice calls in JSONL or migrate to a `calls` table for filtering? (recommend table once volume grows.)
- How much message **content** to store/show vs. just type (PHI minimization vs. usefulness).
