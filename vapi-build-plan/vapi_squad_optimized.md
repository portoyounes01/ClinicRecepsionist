# VAPI Squad — Fully Optimized Clinical AI Receptionist
**Version:** 3.0 — All schemas confirmed. Zero unknowns.
**API:** `https://apicore.newsoftds.pt/api/v1`

---

## How the AI Works (Call Flow)

```
📞 Patient calls
        ↓
[VAPI fires assistant-request webhook → n8n #0]
        ↓
  n8n: GET /patient?PatientPhoneNumber={callerPhone}
        ↓
    ┌─────────────────────────────────┐
    │ Found → personalized greeting   │
    │ Not found → unknown caller msg  │
    └─────────────────────────────────┘
        ↓
[Agent A — RECEPTIONIST starts speaking]
  Greets by name → asks intent → routes:

  "quero marcar consulta"  → Agent B (SCHEDULER)
  "quero cancelar"         → Agent B (SCHEDULER)  
  "tenho consulta marcada" → Agent B (SCHEDULER)
  "dr. Silva por favor"    → transfer to doctor's extension
  "horário / quando abre"  → answers from cached clinic hours
  "fatura / orçamento"     → Agent C (BILLING)
  "outro assunto"          → human receptionist transfer
```

---

## Pre-Call Setup (One-Time, Cached in n8n Variables)

Before going live, call these once and store results as n8n global variables:

```
GET /clinics/costcenter → cache opening hours (injected in every agent prompt)
GET /clinics/motives    → cache motive list (specialty catalog)
GET /appointments/status-code → cache status codes + integer values for AI patch
GET /appointments/types → cache appointment types
```

---

## Squad Configuration (VAPI)

```json
{
  "squad": {
    "name": "Receção Clínica AI",
    "members": [
      { "assistantId": "AGENT_A_RECEPTIONIST" },
      { "assistantId": "AGENT_B_SCHEDULER" },
      { "assistantId": "AGENT_C_BILLING" }
    ]
  }
}
```

---

## Agent A — RECEPTIONIST (Entry Point)

**Persona:** Warm, calm, professional clinical receptionist  
**Language:** Portuguese (Portugal)

### System Prompt Template
```
Você é a rececionista virtual da {{clinicName}}.
Idioma: Português de Portugal. Seja calorosa, profissional e concisa.

## Contexto do Paciente (pré-carregado)
Nome: {{firstName}} {{lastName}}
ID Interno: {{patientId}} [NUNCA dizer ao paciente]
Telefone: {{phone}}
Médico habitual: {{patientMedicName}}
{{#if nextAppt}}Próxima consulta: {{nextApptDate}} às {{nextApptTime}} com {{nextApptDoctor}}{{/if}}

## Horário da Clínica
Manhã: {{clinicHourMorningOpen}} – {{clinicHourMorningClose}}
Tarde: {{clinicHourAfternoonOpen}} – {{clinicHourAfternoonClose}}
Telefone: {{clinicPhoneNumber}}

## O que pode fazer
- Responder horários e informações gerais (responde DIRETAMENTE, sem ferramentas)
- Marcar, cancelar ou consultar agendamentos → transfere para SCHEDULER
- Verificar se um médico está disponível hoje → use a ferramenta check_doctor_today
- Transferir para médico específico → use transfer_to_doctor
- Faturação e orçamentos → transfere para BILLING

## Regras
1. Nunca invente informação — use as ferramentas
2. Nunca diga o PatientId ao paciente
3. Horários: responde diretamente dos dados acima (sem chamar API)
4. Se não souber responder: "Vou encaminhar para a receção, aguarde um momento"
5. Se paciente não está no sistema: "O número não está registado. Pode ligar de outro número ou contactar a receção: {{clinicPhoneNumber}}"
```

### Agent A Tools (4)

**Tool A1: `check_doctor_today`**
```json
{
  "type": "function",
  "function": {
    "name": "check_doctor_today",
    "description": "Verifica se um médico específico está disponível hoje ou tem consultas. Use quando o paciente pergunta por um médico pelo nome ('o Dr. Silva está hoje?').",
    "parameters": {
      "type": "object",
      "properties": {
        "doctor_name": {
          "type": "string",
          "description": "Nome do médico mencionado pelo paciente"
        }
      },
      "required": ["doctor_name"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/check-doctor-today" }
}
```

n8n logic:
```
Extract doctor_name
→ AUTH_GetValidToken
→ GET /api/v1/medics ?ClinicNif=X&ClinicId=1&CostCenterId=1
→ Find medic where medicName contains doctor_name (case-insensitive)
→ If not found: return "Não encontrei nenhum médico com esse nome na nossa clínica."
→ If found: GET /api/v1/medics/availabilities
     ?IntervalDates=TODAY|TODAY&MedicId={medicId}
→ If has slots: "O Dr. {name} está disponível hoje. Quer que tente marcar uma consulta?"
→ If no slots: "O Dr. {name} não tem disponibilidade hoje. Quer verificar outro dia ou outro médico?"
```

---

**Tool A2: `transfer_to_doctor`**
```json
{
  "type": "function",
  "function": {
    "name": "transfer_to_doctor",
    "description": "Transfere a chamada para a extensão do médico quando o paciente quer falar diretamente com o médico.",
    "parameters": {
      "type": "object",
      "properties": {
        "doctor_name": {
          "type": "string",
          "description": "Nome do médico para transferir"
        }
      },
      "required": ["doctor_name"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/transfer-to-doctor" }
}
```

n8n logic:
```
→ Look up doctor in medics list
→ Return { "transfer_number": "+351XXXXXXXXX", "message": "A transferir para o Dr. {name}..." }
→ VAPI uses the number to transfer
```
> Note: You need to configure a phone number per doctor — store them in n8n as a lookup table.

---

**Tool A3: `transfer_to_scheduler`**
```json
{
  "type": "function",
  "function": {
    "name": "transfer_to_scheduler",
    "description": "Transfere para o agente de agendamento quando o paciente quer marcar, cancelar ou consultar consultas.",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  "destinations": [{ "type": "assistant", "assistantName": "SCHEDULER" }]
}
```

---

**Tool A4: `transfer_to_billing`**
```json
{
  "type": "function",
  "function": {
    "name": "transfer_to_billing",
    "description": "Transfere para o agente de faturação quando o paciente pergunta sobre faturas, orçamentos ou pagamentos.",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  "destinations": [{ "type": "assistant", "assistantName": "BILLING" }]
}
```

---

## Agent B — SCHEDULER

**Persona:** Efficient, patient, thorough scheduler  
**Key intelligence:** If calendar full → automatically tries same specialty with other doctors

### System Prompt Template
```
Você é o assistente de agendamento da {{clinicName}}.
Idioma: Português de Portugal.

## Contexto do Paciente
PatientId: {{patientId}} [INTERNO — nunca dizer]
Nome: {{firstName}}
Médico habitual: {{patientMedicName}}

## Fluxo de Marcação (seguir esta ordem)
1. Perceber o que precisa: tipo de consulta, preferência de médico, preferência de datas
2. Se mencionou médico específico → usar esse medicId diretamente
3. Caso contrário → chamar get_consultation_motives → perguntar tipo
4. Chamar get_available_slots para o médico preferido e datas pedidas
5. Se SEM disponibilidade → chamar get_alternative_doctors_same_specialty
6. Apresentar as opções em linguagem natural (não liste mais de 3 slots de uma vez)
7. CONFIRMAR em voz alta: data, hora, médico, tipo — paciente diz SIM
8. Chamar book_appointment
9. Confirmar ao paciente e dizer o appointmentId de forma amigável

## Fluxo de Cancelamento
1. Chamar get_patient_appointments
2. Ler opções ao paciente
3. Paciente confirma qual cancelar
4. Confirmar verbalmente os detalhes (data, hora, médico)
5. Chamar cancel_appointment

## Regras Absolutas
- Nunca marcar sem confirmação verbal explícita
- Nunca inventar slots — sempre chamar get_available_slots primeiro
- Se calendário cheio → tentar alternativas da mesma especialidade
- Datas da API são hora local PT — não converter
```

### Agent B Tools (7)

**Tool B1: `get_consultation_motives`**
```json
{
  "type": "function",
  "function": {
    "name": "get_consultation_motives",
    "description": "Lista os tipos de consulta disponíveis. Chamar quando o paciente quer marcar mas não especificou o tipo.",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  "server": { "url": "https://YOUR-N8N/webhook/get-motives" }
}
```

n8n:
```
→ AUTH_GetValidToken
→ GET /api/v1/clinics/motives ?ClinicNif=X&ClinicId=1&CostCenterId=1
→ Filter: allowAppointment == true
→ Return: "Temos disponível: 1. Medicina Geral (motiveId: 3), 2. Dentisteria (motiveId: 7)..."
```

---

**Tool B2: `get_available_slots`**
```json
{
  "type": "function",
  "function": {
    "name": "get_available_slots",
    "description": "Obtém os horários disponíveis para um médico e período de datas. Chamar SEMPRE antes de tentar marcar. Se o médico não tiver disponibilidade, chamar get_alternative_doctors_same_specialty.",
    "parameters": {
      "type": "object",
      "properties": {
        "medic_id": {
          "type": "integer",
          "description": "ID do médico. Se o paciente não especificou médico, use 0 para buscar todos os médicos da especialidade."
        },
        "motive_id": {
          "type": "integer",
          "description": "ID do motivo/especialidade"
        },
        "date_from": {
          "type": "string",
          "description": "Data de início no formato YYYY-MM-DD"
        },
        "date_to": {
          "type": "string",
          "description": "Data de fim no formato YYYY-MM-DD (máx 7 dias)"
        }
      },
      "required": ["motive_id", "date_from", "date_to"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/get-slots" }
}
```

n8n:
```
→ Extract motive_id, medic_id (optional), date_from, date_to
→ AUTH_GetValidToken
→ Build IntervalDates = date_from + "|" + date_to
→ GET /api/v1/medics/availabilities
     ?ClinicNif=X&ClinicId=1&CostCenterId=1
     &IntervalDates={interval}
     &MedicId={medic_id if provided}
     &MotiveId={motive_id}
→ If empty array:
    return { "available": false, "slots": [], "message": "Sem disponibilidade nesse período." }
→ If has results:
    → Store full slot objects (with appointmentSlotBase64RawData) in n8n execution data
    → Return formatted: "Segunda 19 Maio: 09:00 Dr. Silva, 10:30 Dr. Silva. Terça 20 Maio: 09:00 Dr. Costa..."
    → Include: { "available": true, "slots": [...full objects...] }
```

> **CRITICAL:** The `appointmentSlotBase64RawData` from each slot must be stored and passed to book_appointment. It encodes everything (doctor, time, room).

---

**Tool B3: `get_alternative_doctors_same_specialty`**
```json
{
  "type": "function",
  "function": {
    "name": "get_alternative_doctors_same_specialty",
    "description": "Quando o médico preferido não tem disponibilidade, busca outros médicos da mesma especialidade com horários livres. Chamar automaticamente se get_available_slots retornar vazio.",
    "parameters": {
      "type": "object",
      "properties": {
        "motive_id": {
          "type": "integer",
          "description": "ID da especialidade/motivo"
        },
        "date_from": {
          "type": "string",
          "description": "Data de início YYYY-MM-DD"
        },
        "date_to": {
          "type": "string",
          "description": "Data de fim YYYY-MM-DD"
        },
        "excluded_medic_id": {
          "type": "integer",
          "description": "ID do médico que já foi verificado e não tem disponibilidade"
        }
      },
      "required": ["motive_id", "date_from", "date_to"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/get-alternative-doctors" }
}
```

n8n:
```
→ GET /api/v1/medics ?MotiveId={motive_id}
→ Filter out excluded_medic_id
→ For each remaining medic (max 3):
    GET /api/v1/medics/availabilities ?MedicId={id}&IntervalDates={dates}&MotiveId={motive_id}
    → If has slots → add to results
→ Return: "O Dr. {preferred} não tem disponibilidade, mas temos:
   - Dr. Costa: Segunda às 10:00, Terça às 09:30
   - Dra. Mendes: Quarta às 11:00
   Quer marcar com um destes?"
→ Store slot objects for booking
```

---

**Tool B4: `get_patient_appointments`**
```json
{
  "type": "function",
  "function": {
    "name": "get_patient_appointments",
    "description": "Lista as consultas agendadas do paciente. Usar quando o paciente pergunta as suas consultas ou antes de cancelar.",
    "parameters": {
      "type": "object",
      "properties": {
        "patient_id": {
          "type": "integer",
          "description": "ID do paciente (vem do contexto da chamada)"
        }
      },
      "required": ["patient_id"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/get-appointments" }
}
```

n8n:
```
→ AUTH_GetValidToken
→ GET /api/v1/appointments
     ?ClinicNif=X&ClinicId=1&CostCenterId=1
     &PatientId={patient_id}
     &DateBegin={today}T00:00:00.000
     &DateEnd={today+90days}T23:59:59.000
     &IncludeScheduledAppointments=true
     &IncludeConfirmedAppointments=true
→ Format: list { appointmentId, date, time, doctor, motive, status }
→ If empty: "Não tem consultas agendadas nos próximos 90 dias."
```

---

**Tool B5: `book_appointment`**
```json
{
  "type": "function",
  "function": {
    "name": "book_appointment",
    "description": "Marca uma consulta. APENAS chamar depois de confirmar verbalmente com o paciente: data, hora, médico e tipo. O paciente deve dizer SIM explicitamente.",
    "parameters": {
      "type": "object",
      "properties": {
        "patient_id": {
          "type": "integer",
          "description": "ID do paciente"
        },
        "slot_base64": {
          "type": "string",
          "description": "O appointmentSlotBase64RawData do slot escolhido (obtido de get_available_slots)"
        },
        "motive_name": {
          "type": "string",
          "description": "Nome do motivo/tipo de consulta para o appointmentMotive"
        },
        "observation": {
          "type": "string",
          "description": "Observação opcional para a marcação"
        }
      },
      "required": ["patient_id", "slot_base64", "motive_name"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/book-appointment" }
}
```

n8n:
```
→ AUTH_GetValidToken
→ POST /api/v1/appointment
     Body: {
       "clinicNif": "X",
       "clinicId": 1,
       "costCenterId": 1,
       "patientId": patient_id,
       "appointmentMotive": motive_name,
       "appointmentObservation": observation OR "Marcação via AI",
       "appointmentSlotBase64RawData": slot_base64,
       "appointmentStatusCode": "",
       "incomingIp": "",
       "externalCustomId": ""
     }
→ Returns: [{ "appointmentId": "1250" }]
→ PATCH /api/v1/ai/appointment/status-code-ai
     Body: {
       "clinicNif": "X",
       "clinicId": 1,
       "costCenterId": 1,
       "appointmentId": 1250,
       "appointmentStateByAI": {CONFIRMED_STATUS_INT}
     }
→ Return: "Consulta marcada com sucesso! O seu número de marcação é 1250."
→ On error: "Não foi possível marcar. Por favor contacte a receção: {clinicPhoneNumber}"
```

---

**Tool B6: `cancel_appointment`**
```json
{
  "type": "function",
  "function": {
    "name": "cancel_appointment",
    "description": "Cancela uma consulta específica. APENAS chamar depois de ler os detalhes ao paciente e receber confirmação verbal explícita de cancelamento.",
    "parameters": {
      "type": "object",
      "properties": {
        "appointment_id": {
          "type": "integer",
          "description": "ID da consulta a cancelar (obtido de get_patient_appointments)"
        },
        "reason": {
          "type": "string",
          "description": "Motivo do cancelamento mencionado pelo paciente (opcional)"
        }
      },
      "required": ["appointment_id"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/cancel-appointment" }
}
```

n8n:
```
→ AUTH_GetValidToken
→ DELETE /api/v1/appointment
     ?ClinicNif=X&ClinicId=1&CostCenterId=1
     &AppointmentId={appointment_id}
     &AppointmentObservation={reason OR "Cancelada pelo paciente via AI"}
→ Returns: { "appointmentCanceled": true }
→ Return: "A sua consulta foi cancelada com sucesso."
→ On error: "Não foi possível cancelar. Por favor contacte a receção."
```

---

**Tool B7: `update_appointment_status_ai`**
```json
{
  "type": "function",
  "function": {
    "name": "update_appointment_status_ai",
    "description": "Atualiza o estado de uma consulta via fluxo de IA. Usar após confirmação de presença durante chamadas de lembrete.",
    "parameters": {
      "type": "object",
      "properties": {
        "appointment_id": {
          "type": "integer",
          "description": "ID da consulta"
        },
        "appointment_state_by_ai": {
          "type": "integer",
          "description": "Estado numérico (obter do catálogo /appointments/status-code)"
        }
      },
      "required": ["appointment_id", "appointment_state_by_ai"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/update-status-ai" }
}
```

n8n:
```
→ AUTH_GetValidToken
→ PATCH /api/v1/ai/appointment/status-code-ai
     Body: {
       "clinicNif": "X",
       "clinicId": 1,
       "costCenterId": 1,
       "appointmentId": appointment_id,
       "appointmentStateByAI": appointment_state_by_ai
     }
→ Return success/error
```

---

## Agent C — BILLING

**Persona:** Calm, factual financial assistant

### System Prompt
```
Você é o assistente de faturação da {{clinicName}}.
Idioma: Português de Portugal.

PatientId: {{patientId}} [INTERNO]
Nome: {{firstName}}

## Regras
- Apenas reporte o que a API devolve — nunca invente valores
- Se o paciente contesta um valor: "Para questões de faturação presencial, pode contactar a receção: {{clinicPhoneNumber}}"
- Nunca peça dados de cartão ou pagamento
```

### Agent C Tools (1)

**Tool C1: `get_patient_billing`**
```json
{
  "type": "function",
  "function": {
    "name": "get_patient_billing",
    "description": "Obtém os orçamentos e histórico de faturação do paciente.",
    "parameters": {
      "type": "object",
      "properties": {
        "patient_id": {
          "type": "integer",
          "description": "ID do paciente"
        }
      },
      "required": ["patient_id"]
    }
  },
  "server": { "url": "https://YOUR-N8N/webhook/get-billing" }
}
```

n8n:
```
→ AUTH_GetValidToken
→ GET /api/v1/quotes
     ?ClinicNif=X&ClinicId=1&CostCenterId=1&PatientId={patient_id}
→ Format: list of quotes with title, total, status, date
→ For each quote: list line items (treatment, quantity, value)
→ Return readable summary
```

---

## Agent D — REMINDER BOT (Outbound Only)

**Triggered by:** n8n scheduled workflow — not inbound calls

**Setup in n8n:** Cron job → GET /appointments/by-date for tomorrow → for each appointment → VAPI outbound call

### System Prompt
```
Está a ligar em nome da {{clinicName}} para confirmar uma consulta.
Idioma: Português de Portugal. Chamada máximo 2 minutos.

## Consulta a Confirmar
Data: {{apptDate}}
Hora: {{apptTime}}
Médico: {{doctorName}}
Tipo: {{apptType}}

## Guião
1. "Boa tarde, falo com {{firstName}}?"
2. "Ligo da {{clinicName}} para confirmar a sua consulta de {{apptType}} amanhã, {{apptDate}} às {{apptTime}} com {{doctorName}}."
3. "Confirma a sua presença?"
   - SIM → chamar update_appointment_status_ai (confirmed) → "Obrigado! Até amanhã."
   - NÃO → "Deseja cancelar a consulta?" → se sim → chamar cancel_appointment
   - SEM RESPOSTA / INCERTO → não cancelar → desligar educadamente

## Regras
- Não discutir outros assuntos
- Nunca cancelar sem confirmação explícita
```

---

## n8n Workflow #0 — Dynamic Pre-Call Builder

```
[Webhook Trigger] (VAPI fires assistant-request)
  → Extract callerPhone = body.message.call.customer.number
  → AUTH_GetValidToken
  → HTTP GET /api/v1/patient
       ?ClinicNif=X&ClinicId=1&CostCenterId=1
       &PatientPhoneNumber={callerPhone}
  → [IF] response has patientId?
      YES:
        → Extract: patientId, patientName, patientMedicName
        → Split patientName → firstName
        → HTTP GET /api/v1/appointments
             ?PatientId={patientId}&DateBegin={today}&DateEnd={+90days}
             &IncludeScheduledAppointments=true&IncludeConfirmedAppointments=true
        → Extract first upcoming: nextApptDate, nextApptTime, nextApptDoctor
        → Build personalized firstMessage:
             "Boa tarde {{firstName}}! Em que posso ajudar hoje?"
        → Build personalized systemPrompt (inject patient context + clinic hours)
      NO:
        → Build unknown-caller systemPrompt + firstMessage
  → [Build JSON] full squad + agent A config
  → [Respond to Webhook]
```

---

## Complete Tool Summary

| Agent | Tool | API Called | Purpose |
|-------|------|-----------|---------|
| A | `check_doctor_today` | GET /medics + GET /medics/availabilities | Is Dr. X here today? |
| A | `transfer_to_doctor` | local lookup | Transfer call to doctor |
| A | `transfer_to_scheduler` | VAPI transfer | Route to Agent B |
| A | `transfer_to_billing` | VAPI transfer | Route to Agent C |
| B | `get_consultation_motives` | GET /clinics/motives | List specialties |
| B | `get_available_slots` | GET /medics/availabilities | Find free slots |
| B | `get_alternative_doctors_same_specialty` | GET /medics + GET /medics/availabilities | If calendar full → try others |
| B | `get_patient_appointments` | GET /appointments | List upcoming appointments |
| B | `book_appointment` | POST /appointment + PATCH /ai/status | Book slot |
| B | `cancel_appointment` | DELETE /appointment | Cancel appointment |
| B | `update_appointment_status_ai` | PATCH /ai/status | Update status |
| C | `get_patient_billing` | GET /quotes | Billing info |
| D | `update_appointment_status_ai` | PATCH /ai/status | Reminder confirm/cancel |
| D | `cancel_appointment` | DELETE /appointment | Reminder cancel |

**Total tools: 14** | **Total n8n workflows: 11** (+ 1 AUTH sub-workflow)

---

## Build Order

```
Step 1  → AUTH_GetValidToken sub-workflow (verify with real credentials)
Step 2  → One-time setup: cache clinic hours, motives, status codes
Step 3  → Workflow #0: Dynamic pre-call builder (test with real phone numbers)
Step 4  → Configure VAPI Squad (create 3 agents + link transfers)
Step 5  → Tool: get_consultation_motives
Step 6  → Tool: get_available_slots (test IntervalDates = pipe format ✅ confirmed)
Step 7  → Tool: get_patient_appointments (safe read-only test)
Step 8  → Tool: get_alternative_doctors_same_specialty
Step 9  → Tool: check_doctor_today
Step 10 → Tool: book_appointment (test with sandbox patient!)
Step 11 → Tool: cancel_appointment (test with sandbox appointment!)
Step 12 → Tool: update_appointment_status_ai (get real integer from status catalog)
Step 13 → Tool: get_patient_billing
Step 14 → Agent D: Reminder Bot + outbound n8n scheduler
Step 15 → End-to-end test call (full booking flow)
```

---

## What You Need to Provide

| Item | Status |
|------|--------|
| Newsoft username + password | ❓ |
| ClinicNif (e.g., `266844693`) | ❓ |
| ClinicId + CostCenterId (usually = `1`) | ❓ |
| n8n instance URL | ❓ |
| VAPI account + inbound phone number | ❓ |
| Doctor extensions/transfer numbers | ❓ |
| Clinic name for prompts | ❓ |
