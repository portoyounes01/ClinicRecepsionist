# VAPI Clinic AI Squad — Build Plan
Last updated: 2026-05-19

## 📁 Files in This Folder

### 1. `newsoft_v1_api_reference.md`
Complete Newsoft v1 API reference — scraped live from https://apicore.newsoftds.pt/
- Every endpoint (26 total)
- All request body schemas with exact field names
- All response schemas with real example values
- Key rules (date formats, token usage, etc.)

### 2. `vapi_squad_optimized.md`
Full VAPI Squad build plan — fully optimized AI receptionist
- 3 inbound agents: RECEPTIONIST, SCHEDULER, BILLING
- 1 outbound agent: REMINDER BOT
- 14 tools with complete VAPI JSON definitions
- All n8n workflow logic (step by step)
- Build order (15 steps)

---

## 🔑 Critical Things to Know

| Thing | Value |
|-------|-------|
| API base URL | `https://apicore.newsoftds.pt/api/v1` |
| IntervalDates format | `YYYY-MM-DD\|YYYY-MM-DD` (pipe) |
| Book appointment | Use `appointmentSlotBase64RawData` from availabilities |
| AI status update | `appointmentStateByAI` is an **integer** |
| GET /patient | Returns single object (not array) |
| Date format | `YYYY-MM-DDTHH:mm:ss.000` (no Z, local PT time) |

---

## 🏗️ Build Order (n8n + VAPI)

```
Step 1  → AUTH_GetValidToken sub-workflow
Step 2  → Cache clinic hours, motives, status codes (one-time)
Step 3  → Workflow #0: Pre-call dynamic builder
Step 4  → Configure VAPI Squad (3 agents)
Step 5  → Tool: get_consultation_motives
Step 6  → Tool: get_available_slots
Step 7  → Tool: get_patient_appointments
Step 8  → Tool: get_alternative_doctors_same_specialty
Step 9  → Tool: check_doctor_today
Step 10 → Tool: book_appointment
Step 11 → Tool: cancel_appointment
Step 12 → Tool: update_appointment_status_ai
Step 13 → Tool: get_patient_billing
Step 14 → Agent D: Reminder Bot (outbound)
Step 15 → End-to-end test
```

---

## ✅ What I Still Need From You

- [ ] Newsoft username
- [ ] Newsoft password
- [ ] ClinicNif
- [ ] n8n instance URL
- [ ] VAPI account + phone number
- [ ] Doctor names + transfer phone numbers
- [ ] Clinic name
