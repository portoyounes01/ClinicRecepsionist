# WhatsApp Templates to submit to Meta (task 1.4)

Submit these in **Meta Business Manager → WhatsApp Manager → Message templates**. Variable order and buttons below match exactly what the code sends ([reminder.js](../../vicki-ai/src/lifecycle/reminder.js), [reviews.js](../../vicki-ai/src/lifecycle/reviews.js), [recare.js](../../vicki-ai/src/lifecycle/recare.js)) — **do not reorder the variables.**

General settings for all three:
- **Category:** Utility (see ⚠️ note on recare).
- **Languages:** add **BOTH Portuguese (pt_PT) AND English (en)** for every template (same template name, two language versions). The code auto-picks `en` for English-speaking patients, `pt_PT` otherwise.
- **Buttons:** two kinds are used below —
  - **Quick reply** = a tappable reply; our code sets the tap action. You only type the button text.
  - **Call phone number** (a Call-to-action button) = when tapped it **dials the clinic directly**. It's static — you enter the label + the clinic phone number in Meta, and the code sends nothing for it.
  - Meta rule: quick-reply buttons must be listed **before** call buttons. Max 1 phone button per template.

### 👉 What buttons to add (quick reference)
| Template | Button 1 | Button 2 |
|---|---|---|
| `appointment_reminder` | **Quick reply** — `Confirmar` / `Confirm` | **Call phone number** — `Remarcar/Cancelar` / `Reschedule/Cancel` → clinic phone |
| `review_request` | *(none)* | — |
| `recare_reminder` | **Quick reply** — `Marcar` / `Book` | — |

---

## 1. `appointment_reminder`  (Utility)
Variables: `{{1}}` = clinic name · `{{2}}` = date (e.g. 09/06/2026) · `{{3}}` = time (e.g. 14:30)
Buttons (in this order):
1. **Quick reply** — text: `Confirmar` (pt) / `Confirm` (en) → confirms the appointment in Newsoft.
2. **Call phone number** — text: `Remarcar/Cancelar` (pt) / `Reschedule/Cancel` (en) · phone: the clinic number (E.164, e.g. `+351 289 …`). Tapping dials the clinic so a human handles the reschedule/cancel. We never auto-cancel from a tap.

**Portuguese (pt_PT) body:**
```
Olá! 🦷

Lembrete de consulta — {{1}}.

Tem uma marcação para {{2}} às {{3}}.

Confirme a sua presença abaixo. Para remarcar ou cancelar, ligue-nos através do botão. Obrigada!
```

**English (en) body:**
```
Hello! 🦷

Appointment reminder — {{1}}.

You have a booking on {{2}} at {{3}}.

Please confirm below. To reschedule or cancel, call us using the button. Thank you!
```

**Sample values for Meta:** {{1}}=`Instituto Vilas Boas` · {{2}}=`09/06/2026` · {{3}}=`14:30`

---

## 2. `review_request`  (Utility)
Variables: `{{1}}` = clinic name · `{{2}}` = review link
Buttons: none (link is in the body)

**Portuguese (pt_PT) body:**
```
Olá! 🦷 Obrigada pela sua visita — {{1}}.

A sua opinião conta muito para nós. Pode partilhá-la aqui (demora menos de 1 minuto): {{2}}

Até breve!
```

**English (en) body:**
```
Hello! 🦷 Thank you for visiting {{1}}.

Your feedback means a lot to us. You can share it here (less than a minute): {{2}}

See you soon!
```

**Sample values for Meta:** {{1}}=`Instituto Vilas Boas` · {{2}}=`https://<your-host>/review/ab12cd34`

---

## 3. `recare_reminder`  (Utility — ⚠️ may be classed as Marketing)
Variables: `{{1}}` = clinic name
Buttons: **Quick reply** — `Marcar` (pt) / `Book` (en). (Tapping replies with how to book; it does not auto-book — booking goes through the voice line.)
> Also reused for **reactivation** (dormant patients) unless you set a separate `WHATSAPP_TEMPLATE_REACTIVATION`.

**Portuguese (pt_PT) body:**
```
Olá! 🦷

Já passou algum tempo desde a sua última visita — {{1}}.

Para manter o seu sorriso saudável, recomendamos uma consulta de rotina.

Toque em Marcar e a nossa equipa ajuda a agendar.
```

**English (en) body:**
```
Hello! 🦷

It's been a while since your last visit — {{1}}.

To keep your smile healthy, we recommend a routine check-up.

Tap Book and our team will help you schedule.
```
Buttons (en): **Book**

**Sample value for Meta:** {{1}}=`Instituto Vilas Boas`

⚠️ **Note:** Meta may classify recare/reactivation as **Marketing** (it's re-engagement, not transactional). If it's rejected as Utility, resubmit under **Marketing** — functionally identical, just different billing + opt-out rules.

---

## After approval
The default template **names** above match the code. If Meta forces different names, override via env:
`WHATSAPP_TEMPLATE_REMINDER`, `WHATSAPP_TEMPLATE_REVIEW`, `WHATSAPP_TEMPLATE_RECARE`, `WHATSAPP_TEMPLATE_REACTIVATION` (set these in task 1.5).
