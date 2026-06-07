# WhatsApp Templates to submit to Meta (task 1.4)

Submit in **Meta Business Manager → WhatsApp Manager → Message templates**. Variable order and buttons below match the code exactly ([reminder.js](../../vicki-ai/src/lifecycle/reminder.js), [reviews.js](../../vicki-ai/src/lifecycle/reviews.js), [recare.js](../../vicki-ai/src/lifecycle/recare.js)) — **do not reorder the variables**. `{{1}}` is always the patient's **first name**.

General settings (all three):
- **Category:** Utility (see ⚠️ on recare).
- **Languages:** add **BOTH Portuguese (pt_PT) AND English (en)** under the same template name. The code auto-picks `en` for English-speaking patients, `pt_PT` otherwise.
- **Buttons:**
  - **Quick reply** = a tappable reply (our code sets the action; you type the text).
  - **Call phone number** = a Call-to-action that **dials the clinic** when tapped. Static — you set its label + the clinic phone in Meta; the code sends nothing for it.
  - Meta rule: list quick-reply button(s) **before** the call button. Max 1 phone button.
- Greeting: the **reminder** sends every morning at **07:30**, so it uses **"Bom dia"**. Review/recare can send any time, so they use **"Olá"**.

### 👉 Buttons to add (quick reference)
| Template | Button 1 | Button 2 |
|---|---|---|
| `appointment_reminder` | **Quick reply** — `Confirmar` / `Confirm` | **Call phone number** — `Reagendar` / `Reschedule` → clinic phone |
| `review_request` | *(none)* | — |
| `review_reminder` | *(none)* | — |
| `recare_reminder` | **Quick reply** — `Marcar` / `Book` | — |

---

## 1. `appointment_reminder`  (Utility)
Variables: `{{1}}` first name · `{{2}}` clinic · `{{3}}` date (weekday + day + month) · `{{4}}` time · `{{5}}` address

**Portuguese (pt_PT):**
```
Bom dia *{{1}}*,

Este é um lembrete de *48 horas* da sua consulta na {{2}}:

📅 Data: *{{3}}*
🕐 Hora: *{{4}}*
📍 Local: {{5}}

Para confirmar, toque em *Confirmar*. Para reagendar ou cancelar, toque em *Reagendar* para falar com a nossa equipa.

Se não recebermos resposta, o nosso assistente virtual poderá ligar-lhe *24 horas* antes da consulta para confirmar.

Estamos aqui para ajudar a manter o seu *sorriso com confiança!* 🦷
```

**English (en):**
```
Good morning *{{1}}*,

This is a *48-hour* reminder of your appointment at {{2}}:

📅 Date: *{{3}}*
🕐 Time: *{{4}}*
📍 Location: {{5}}

To confirm, tap *Confirm*. To reschedule or cancel, tap *Reschedule* to talk to our team.

If we don't hear from you, our virtual assistant may call you *24 hours* before your appointment to confirm.

We're here to help keep your *smile confident!* 🦷
```

**Buttons:** 1) Quick reply `Confirmar`/`Confirm`  2) Call phone number `Reagendar`/`Reschedule` → clinic phone (E.164).
**Samples:** {{1}}=`Valter` · {{2}}=`Instituto Vilas Boas` · {{3}}=`quarta-feira, 08 de junho` · {{4}}=`15:30` · {{5}}=`Avenida 25 de Abril, 8100-508 Loulé, Algarve`

---

## 2. `review_request`  (Utility)
Variables: `{{1}}` first name · `{{2}}` clinic · `{{3}}` review link · no buttons

**Portuguese (pt_PT):**
```
Olá *{{1}}*! 😊

Foi um prazer cuidar de si — {{2}}! Esperamos que tenha saído com um sorriso ainda mais bonito. 🦷

A sua opinião ajuda outras pessoas a escolher o seu cuidado dentário com confiança — e significa muito para a nossa equipa. Demora menos de 1 minuto:
👉 {{3}}

Muito obrigada! 💙
```

**English (en):**
```
Hi *{{1}}*! 😊

It was a pleasure taking care of you — {{2}}! We hope you left with an even brighter smile. 🦷

Your feedback helps others choose their dental care with confidence — and it means a lot to our team. It takes less than a minute:
👉 {{3}}

Thank you so much! 💙
```

**Samples:** {{1}}=`Valter` · {{2}}=`Instituto Vilas Boas` · {{3}}=`https://<your-host>/review/ab12cd34`

---

## 2b. `review_reminder`  (Utility) — the review follow-up
Sent as the 2 review nudges (next-day + 1 week) if the patient hasn't reviewed yet. Softer than the first ask.
Variables: `{{1}}` first name · `{{2}}` clinic · `{{3}}` review link · no buttons

**Portuguese (pt_PT):**
```
Olá *{{1}}*! 🦷

Ainda vai a tempo! A sua opinião sobre a sua visita ajuda outras pessoas e significa muito para nós. Demora menos de 1 minuto:
👉 {{3}}

Com carinho, equipa {{2}} 💙
```

**English (en):**
```
Hi *{{1}}*! 🦷

There's still time! Your feedback on your visit helps others and means a lot to us. It takes less than a minute:
👉 {{3}}

Warm wishes, the {{2}} team 💙
```

**Samples:** {{1}}=`Valter` · {{2}}=`Instituto Vilas Boas` · {{3}}=`https://<your-host>/review/ab12cd34`

---

## 3. `recare_reminder`  (Utility — ⚠️ may be classed as Marketing)
Variables: `{{1}}` first name · `{{2}}` clinic · button: Quick reply `Marcar`/`Book`
> Also reused for **reactivation** (dormant patients) unless `WHATSAPP_TEMPLATE_REACTIVATION` is set.

**Portuguese (pt_PT):**
```
Olá *{{1}}*,

Já passou algum tempo desde a sua última visita — {{2}}. 🦷

Para manter o seu sorriso saudável, recomendamos uma consulta de rotina.

Toque em *Marcar* e a nossa equipa ajuda a agendar.

Estamos aqui para ajudar a manter o seu *sorriso com confiança!*
```

**English (en):**
```
Hello *{{1}}*,

It's been a while since your last visit — {{2}}. 🦷

To keep your smile healthy, we recommend a routine check-up.

Tap *Book* and our team will help you schedule.

We're here to help keep your *smile confident!*
```

**Sample:** {{1}}=`Valter` · {{2}}=`Instituto Vilas Boas`

⚠️ Meta may classify recare/reactivation as **Marketing** (re-engagement). If rejected as Utility, resubmit as Marketing — same content.

---

## After approval
If Meta forces different template names, override via env: `WHATSAPP_TEMPLATE_REMINDER`, `WHATSAPP_TEMPLATE_REVIEW`, `WHATSAPP_TEMPLATE_REVIEW_NUDGE`, `WHATSAPP_TEMPLATE_RECARE`, `WHATSAPP_TEMPLATE_REACTIVATION` (set in task 1.5).
