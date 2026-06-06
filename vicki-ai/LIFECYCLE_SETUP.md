# Vicki — Patient Lifecycle Engine (Setup)

The lifecycle engine (WhatsApp reminders/confirmations, outbound confirm calls,
reviews, recare, reactivation, dashboard) is an **additive layer**. The inbound
voice receptionist is unchanged and keeps working with or without this enabled.

> **Self-disabling:** if `DATABASE_URL` is unset, the engine stays off and the
> inbound flow is completely unaffected. Set `DATABASE_URL` to turn it on.

## 1. Provision Postgres
Add the **Railway Postgres** plugin. Railway injects `DATABASE_URL`. The schema
([src/db/schema.sql](src/db/schema.sql)) auto-applies on boot (idempotent).

For local dev against a non-SSL Postgres, set `PGSSL=disable`.

## 2. WhatsApp Business Cloud API (direct Meta)
Create a Meta App + WhatsApp Business Account + verified phone number, then set:

```
WHATSAPP_PHONE_NUMBER_ID=         # from WhatsApp > API Setup
WHATSAPP_WABA_ID=
WHATSAPP_TOKEN=                   # permanent system-user token
WHATSAPP_APP_SECRET=             # App Settings > Basic — used to verify webhook signature
WHATSAPP_VERIFY_TOKEN=           # any random string; also paste in Meta webhook config
WHATSAPP_GRAPH_VERSION=v21.0     # optional
```

**Webhook config in Meta:** callback URL `https://<your-host>/whatsapp/webhook`,
verify token = `WHATSAPP_VERIFY_TOKEN`. Subscribe to the `messages` field.

**Approve these utility templates** (names overridable via env), each with the
listed body variables and quick-reply buttons:

| Purpose | Default name | Body vars | Buttons |
|---|---|---|---|
| Reminder | `appointment_reminder` | `{{1}}` clinic, `{{2}}` date, `{{3}}` time | Confirmar / Cancelar |
| Review   | `review_request`       | `{{1}}` clinic, `{{2}}` link | (none) |
| Recare   | `recare_reminder`      | `{{1}}` clinic | Marcar |

Override names with `WHATSAPP_TEMPLATE_REMINDER`, `WHATSAPP_TEMPLATE_REVIEW`,
`WHATSAPP_TEMPLATE_RECARE`, `WHATSAPP_TEMPLATE_REACTIVATION`.

## 3. Public base URL (for the review page)
```
PUBLIC_BASE_URL=https://<your-host>      # used to build /review/<token> links
GOOGLE_REVIEW_URL=https://g.page/r/.../review   # clinic's "write a review" link
```

## 4. Outbound confirm calls (Telnyx Call Control)
Reuses the existing Telnyx account. Add:
```
TELNYX_APP_ID=                   # Voice API Application (connection) id
TELNYX_OUTBOUND_NUMBER=+351...   # E.164 caller id for outbound calls
```
If unset, the confirm-call step falls back to an SMS confirm request (no patient
is ever silently dropped).

## 5. Dashboard
```
DASHBOARD_KEY=<random>           # GET /dashboard?key=...   (separate from ADMIN_KEY)
```

## 6. Timing / behavior (all optional, sensible defaults)
```
REMINDER_LEAD_HOURS=48           # send reminder this long before the appt
CONFIRM_CALL_LEAD_HOURS=24       # if no WA reply, call this long before
REVIEW_DELAY_HOURS=2             # review request this long after the appt
RECARE_INTERVAL_MONTHS=6
REACTIVATION_DORMANT_MONTHS=12
REACTIVATION_COOLDOWN_DAYS=180
REACTIVATION_BATCH=50            # cap per daily sweep (protects WA quality rating)
SCHEDULER_POLL_MS=60000
NEWSOFT_CONFIRMED_STATUS_CODE=C  # TODO: verify the real "confirmed" code with Newsoft
```

## ⚠️ Verify before going live
- **Newsoft confirm write-back** — `confirmAppointment()` posts to
  `/appointment/confirm` with `NEWSOFT_CONFIRMED_STATUS_CODE`. Confirm the real
  endpoint + status code against live Newsoft. See [src/newsoftApi.js](src/newsoftApi.js).
- **Status letters** — we remind ONLY on blank `appointmentStatusCode`. Confirm
  that C/I/E (and any others) really mean cancelled / not-coming / etc.
- **Google review prefill** — we copy the comment to the clipboard and open the
  Google review URL; verify the UX on a real device.

## Tests
```
node scripts/lifecycle-it.js     # in-memory Postgres integration test (needs: npm i -D pg-mem)
npm run test:golden              # inbound routing/language — must still pass
npm run test:textgym             # inbound booking flow — must still pass
```
