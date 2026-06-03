# Newsoft Core Services — v1 API Complete Reference
**Source:** https://apicore.newsoftds.pt/swagger/v1/swagger.json  
**Scraped:** Live from Swagger UI — all schemas confirmed from Example Values  
**Base URL:** `https://apicore.newsoftds.pt`

---

## ⚠️ Global Rules (from API docs)
- All dates/times are **Portuguese local time, NO Z suffix** — never treat as UTC
- Token in header: `Authorization: Bearer {token}` (Bearer prefix optional)
- `expiresAt` = Unix timestamp in seconds — renew before it expires
- On `401` → re-authenticate immediately
- `IntervalDates` format for availabilities: `YYYY-MM-DD|YYYY-MM-DD` (pipe separator, confirmed)
- `DateBegin`/`DateEnd` for appointments: `YYYY-MM-DDTHH:mm:ss.000` format
- `appointmentStateByAI` in the AI patch is an **integer** (0, 1, 2... = status codes)

---

## 1. Authentication

### `POST /api/v1/Authentication`
**Purpose:** Authenticate and get JWT token  
**Auth required:** No (public endpoint)

**Request Body:**
```json
{
  "username": "sandboxapi_nsapi_266844693",
  "password": "ieN83R8ilgqPu6RCEsUFdg9H22OzfKG2wjSoSsnt@AqYKsntqJIF&Ux2$2O1"
}
```

**Response 200:**
```json
{
  "token": "string",
  "expiresAt": 1716000000,
  "clinics": [
    { "nif": "string", "ids": [1] }
  ],
  "sqlClock": "string"
}
```

> Note: `clinics` array tells you the NIF and clinic IDs this user has access to. Use `nif` as `ClinicNif` and `ids[0]` as `ClinicId` in all subsequent calls.

---

## 2. Clinic

### `GET /api/v1/clinics`
**Purpose:** List all clinic locations for a NIF

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |

**Response 200:**
```json
[
  { "clinicId": 1, "clinicLocation": "string" }
]
```

---

### `GET /api/v1/clinics/costcenter`
**Purpose:** Get details of a single cost center — **includes opening hours**

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |

**Response 200:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "clinicName": "string",
  "clinicStreetName": "string",
  "clinicZipCode": "string",
  "clinicPhoneNumber": "string",
  "clinicDescription": "string",
  "clinicHourMorningOpen": "string",
  "clinicHourMorningClose": "string",
  "clinicHourAfternoonOpen": "string",
  "clinicHourAfternoonClose": "string",
  "clinicEmail": "string",
  "clinicPrimaryColor": "string",
  "clinicSecondaryColor": "string"
}
```

> **AI USE:** Call this once at setup. Cache `clinicHourMorningOpen`, `clinicHourMorningClose`, `clinicHourAfternoonOpen`, `clinicHourAfternoonClose` — inject into every agent's system prompt. Do NOT call this during a conversation.

---

### `GET /api/v1/clinics/costcenters`
**Purpose:** List all cost centers

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |

**Response 200:**
```json
[
  {
    "clinicId": 1,
    "costCenterId": 1,
    "clinicNif": "266844693",
    "clinicName": "string",
    "clinicEmail": "string",
    "clinicAddress": "string",
    "clinicDescription": "string"
  }
]
```

---

### `GET /api/v1/clinics/motives`
**Purpose:** List consultation motives (specialties) available for booking

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |

**Response 200:**
```json
[
  {
    "motiveId": "7",
    "motiveName": "string",
    "order": "string",
    "active": "string",
    "allowAppointment": true,
    "motiveDuration": 0
  }
]
```

> **AI USE:** Use `motiveId` + `motiveName` when offering consultation types. Filter by `allowAppointment: true`.

---

### `GET /api/v1/clinics/subspecialities`
**Purpose:** List subspecialties linked to a motive

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |

**Response 200:**
```json
[
  {
    "subSpecialityId": 1,
    "subSpecialityCode": "string",
    "subSpecialityName": "string",
    "subSpecialityDuration": 0,
    "motiveID": "7"
  }
]
```

---

## 3. Patients

### `GET /api/v1/patient`
**Purpose:** Get patient summary by phone, email, NIF, or ID  
**Use for:** Pre-call patient identification

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| PatientNIF | string | optional | `213123123` |
| PatientEmail | string | optional | `patient@example.com` |
| PatientPhoneNumber | string | optional | `912345678` |
| PatientId | integer | optional | `1` |

**Response 200:** *(single object, not array)*
```json
{
  "patientId": 1,
  "patientEmail": "patient@example.com",
  "patientName": "Maria Silva",
  "patientShortName": "string",
  "patientBirthDate": "2026-05-18",
  "patientNif": "213123123",
  "patientGender": "string",
  "patientCivilStatus": "string",
  "patientRiskLevel": 0,
  "patientSubscribed": true,
  "patientInactivated": true,
  "patientPhoneNumber": "912345678",
  "patientPhoneNumber2": "string",
  "patientLocation": "string",
  "patientAddress": "string",
  "patientZipcode": "string",
  "patientCountry": "string",
  "patientType": "string",
  "patientMedicName": "string",
  "isSubscribed": true
}
```

---

### `GET /api/v1/patient/detailed`
**Purpose:** Extended patient record with health info, family, conventions

**Query Parameters:** Same as `GET /api/v1/patient`

**Response 200:** Same fields as above + extended fields:
```json
{
  "patientPhoneNumber3": "string",
  "patientPhoneNumber4": "string",
  "patientPhoneNumber5": "string",
  "patientPhoneNumber6": "string",
  "patientHealthNumber": "string",
  "patientConvention": "string",
  "patientConvention2": "string",
  "patientOccupation": "string",
  "patientImportantObs": "string",
  "patientDiscount": 0,
  "createdAt": "2026-03-20T16:45:00.000",
  "updatedAt": "2026-03-25T10:15:00.000",
  "patientFamily": [
    {
      "patientId": 1,
      "patientName": "Maria Silva",
      "patientBirthDate": "2026-05-18",
      "patientGender": "string"
    }
  ]
}
```

---

### `POST /api/v1/patient`
**Purpose:** Create or update a patient record

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "patientName": "Maria Silva",
  "patientEmail": "patient@example.com",
  "patientPhoneNumber": "912345678",
  "patientNif": "213123123",
  "patientLocation": "string",
  "patientAddress": "string",
  "patientZipCode": "string",
  "patientBirthDate": "2026-05-18",
  "patientGender": "string",
  "patientCountry": "string",
  "updatePatient": true
}
```

**Response 200:**
```json
{
  "isNewPatient": true,
  "patientId": 1
}
```

---

### `GET /api/v1/patients`
**Purpose:** List patients with filters (for search/sync)

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| PatientPhoneFilter | string | optional | `912345678` |
| PatientEmailFilter | string | optional | `patient@example.com` |
| PatientNifFilter | string | optional | `213123123` |
| Page | integer | optional | `1` |
| PageSize | integer | optional | `20` |

**Response 200:** Array of patient summary objects (same as `GET /patient`)

---

### `GET /api/v1/patients/by-birthday-date`
**Purpose:** Find patients by birthday (for campaigns / outbound calls)

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| Month | integer | optional | `5` |
| Day | integer | optional | `19` |

---

## 4. Medics (Doctors)

### `GET /api/v1/medics`
**Purpose:** List available doctors (optionally by specialty/motive)

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| MotiveId | integer | optional | `7` |
| SpecialityId | integer | optional | `1` |

**Response 200:**
```json
[
  {
    "medicId": 1,
    "medicShortName": "string",
    "medicName": "string",
    "specialityId": 1,
    "specialityName": "string",
    "subSpecialityName": "string",
    "subSpecialityOnlineName": "string"
  }
]
```

---

### `GET /api/v1/medics/availabilities`
**Purpose:** Get free appointment slots for a doctor and date range  
**⚠️ CONFIRMED: `IntervalDates` format = `YYYY-MM-DD|YYYY-MM-DD` (pipe separator)**

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| IntervalDates | string | ✅ | `2026-05-19|2026-05-25` |
| MedicId | integer | optional | `1` |
| MotiveId | integer | optional | `7` |
| Detailed | boolean | optional | `true` |

**Response 200:**
```json
[
  {
    "medicId": 1,
    "medicName": "string",
    "medicShortName": "string",
    "medicOnlineName": "string",
    "appointmentRoom": "Gabinete 2",
    "appointmentDateBegin": "2026-05-19T09:00:00.000",
    "appointmentDateEnd": "2026-05-19T09:30:00.000",
    "clinicId": 1,
    "costCenterId": 1,
    "specialityId": 1,
    "appointmentPortugueseMessage": "string",
    "appointmentEnglishMessage": "string",
    "appointmentHour": 9,
    "appointmentDuration": 30,
    "appointmentSlotBase64RawData": "string"
  }
]
```

> **⚠️ CRITICAL:** `appointmentSlotBase64RawData` is required in `POST /appointment` body. Copy it exactly from the slot the patient selected. This is how you book a specific slot.

---

## 5. Appointments

### `GET /api/v1/appointments`
**Purpose:** List appointments for a patient or clinic in a date range

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| DateBegin | string(datetime) | ✅ | `2026-05-19T00:00:00.000` |
| DateEnd | string(datetime) | ✅ | `2026-08-19T23:59:59.000` |
| PatientId | integer | optional | `1` |
| IncludeScheduledAppointments | boolean | optional | `true` |
| IncludeConfirmedAppointments | boolean | optional | `true` |
| IncludeCancelledAppointments | boolean | optional | `false` |
| MedicId | integer | optional | `1` |
| MotiveID | string | optional | `"7"` |

**Response 200:**
```json
[
  {
    "appointmentId": 1250,
    "appointmentDateBegin": "2026-05-19T09:00:00.000",
    "appointmentDateEnd": "2026-05-19T09:30:00.000",
    "medicId": 1,
    "medicName": "string",
    "patientId": 1,
    "patientName": "Maria Silva",
    "patientPhoneNumber": "912345678",
    "appointmentObservation": "string",
    "appointmentStatusCode": "string",
    "appointmentDescriptionStatus": "string",
    "appointmentDuration": 30,
    "appointmentRoom": "Gabinete 2",
    "appointmentMotive": "string",
    "costCenterId": 1,
    "costCenterName": "string",
    "createdAt": "2026-03-20T16:45:00.000",
    "updatedAt": "2026-03-25T10:15:00.000"
  }
]
```

---

### `POST /api/v1/appointment`
**Purpose:** Create (book) a new appointment  
**⚠️ CONFIRMED SCHEMA — field names were previously unknown**

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "patientId": 1,
  "appointmentObservation": "Marcação via AI",
  "appointmentStatusCode": "string",
  "incomingIp": "string",
  "appointmentMotive": "string",
  "appointmentSlotBase64RawData": "<<copy from availabilities response>>",
  "externalCustomId": "1"
}
```

**Response 200:**
```json
[
  { "appointmentId": "1250" }
]
```

> **HOW TO BOOK:** Get the slot from `GET /medics/availabilities`. Copy `appointmentSlotBase64RawData` exactly. Combine with `patientId` and send. The slot encodes doctor, date, time, and room.

---

### `DELETE /api/v1/appointment`
**Purpose:** Cancel an appointment

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| AppointmentId | string | ✅ | `1250` |
| AppointmentObservation | string | optional | `"Cancelada pelo paciente via AI"` |

**Response 200:**
```json
{ "appointmentCanceled": true }
```

---

### `PUT /api/v1/appointment/status-code`
**Purpose:** Update appointment status (standard, non-AI)

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "appointmentId": 1250,
  "appointmentStatusCode": "string",
  "observation": "string"
}
```

**Response 200:**
```json
{ "status": "string", "message": "string" }
```

---

### `PATCH /api/v1/ai/appointment/status-code-ai`
**Purpose:** Update appointment status specifically for AI/automation flows  
**⚠️ CONFIRMED SCHEMA — `appointmentStateByAI` is an integer (not a string)**

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "appointmentId": 1250,
  "appointmentStateByAI": 0
}
```

**Response 200:**
```json
{ "status": "string", "message": "string" }
```

> **`appointmentStateByAI` values:** Must be fetched from `GET /appointments/status-code` once during setup. The integer codes map to status descriptions (confirmed, cancelled, etc.).

---

### `GET /api/v1/appointments/status-code`
**Purpose:** Get the catalog of all appointment status codes (run once, cache)

**Query Parameters:** ClinicNif, ClinicId, CostCenterId (all required)

**Response 200:**
```json
[
  {
    "appointmentStatusCode": "string",
    "appointmentStatusDescription": "string",
    "appointmentStatusColorCode": "string",
    "appointmentStatusFilters": ["string"]
  }
]
```

---

### `GET /api/v1/appointments/types`
**Purpose:** Get appointment type catalog (run once, cache)

**Query Parameters:** ClinicNif, ClinicId, CostCenterId (all required)

**Response 200:**
```json
[
  {
    "appointmentTypeId": 1,
    "appointmentTypeDescription": "string",
    "appointmentTypeDuration": 0,
    "appointmentTypeColor": "string",
    "appointmentTypeActive": true
  }
]
```

---

### `GET /api/v1/appointments/by-date`
**Purpose:** Quick lookup of all appointments on a specific date

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| Date | string(date) | optional | `2026-05-19` |

---

### `GET /api/v1/appointments/by-created-date`
**Purpose:** Incremental sync — appointments created in a window

**Query Parameters:** ClinicNif, ClinicId, CostCenterId, DateBegin, DateEnd (all required)

---

### `GET /api/v1/appointments/by-updated-date`
**Purpose:** Incremental sync — appointments changed since last poll

**Query Parameters:** ClinicNif, ClinicId, CostCenterId, DateBegin, DateEnd (all required)

---

### `GET /api/v1/appointments/by-deleted-date`
**Purpose:** Incremental sync — appointments cancelled/deleted in a window

**Query Parameters:** ClinicNif, ClinicId, CostCenterId, DateBegin, DateEnd (all required)

---

## 6. Quotes

### `GET /api/v1/quotes`
**Purpose:** Get patient clinical quotes and invoice lines

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| PatientId | integer | optional | `1` |
| Date | string(date) | optional | `2026-05-19` |

**Response 200:**
```json
[
  {
    "quoteId": 1,
    "quotePatientId": 1,
    "quoteDate": "2026-05-18T09:00:00.000",
    "quoteMedicId": 1,
    "quoteTotalValue": 0,
    "quoteIsApproved": true,
    "quoteDescription": "string",
    "quoteTitle": "string",
    "quoteStatusDescription": "string",
    "quoteLines": [
      {
        "quoteLineTreatmentName": "string",
        "quoteLineValue": 0,
        "quoteLineQuantity": 0
      }
    ]
  }
]
```

---

## 7. NSWebphone

### `GET /api/v1/webphone/calls`
**Purpose:** List call history (for logging AI calls into NS system)

**Query Parameters:**
| Param | Type | Required | Example |
|-------|------|----------|---------|
| ClinicNif | string | ✅ | `266844693` |
| ClinicId | integer | ✅ | `1` |
| CostCenterId | integer | ✅ | `1` |
| DateBegin | string(datetime) | ✅ | `2026-05-19T00:00:00.000` |
| DateEnd | string(datetime) | ✅ | `2026-05-19T23:59:59.000` |
| IsReturned | boolean | optional | `false` |
| IsResolved | boolean | optional | `false` |

---

## 8. GOContact

### `POST /api/v1/gocontact/opencontext`
**Purpose:** Create/update a call context in GOContact (CTI integration)

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "contactId": "1",
  "phone": "string",
  "eventType": "string",
  "user": "string",
  "additionalFields": "string"
}
```

---

## 9. DAN (Dental Audio Notes)

### `POST /api/v1/dan/document`
**Purpose:** Create/update a DAN clinical document

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "appointmentId": 1250,
  "patientId": 1,
  "type": 0,
  "text": "string",
  "patientUuid": "1",
  "practiceId": 1,
  "danType": "string",
  "patientName": "Maria Silva",
  "html": "string",
  "source": "string",
  "danAppointmentId": "1",
  "danItemId": "1"
}
```

---

## 10. Artificial Intelligence

### `PATCH /api/v1/ai/appointment/status-code-ai`
**Purpose:** AI-specific status update for appointments  
**Use this** instead of `PUT /appointment/status-code` for all AI-driven status changes

**Request Body:**
```json
{
  "clinicNif": "266844693",
  "clinicId": 1,
  "costCenterId": 1,
  "appointmentId": 1250,
  "appointmentStateByAI": 0
}
```

**Response 200:**
```json
{ "status": "string", "message": "string" }
```

---

## Key Booking Flow Summary

```
1. GET /clinics/motives               → get motiveId + motiveName
2. GET /medics ?MotiveId=X            → get medicId + medicName
3. GET /medics/availabilities         → get slots (IntervalDates=YYYY-MM-DD|YYYY-MM-DD)
                                        → save appointmentSlotBase64RawData from chosen slot
4. POST /appointment                  → book using patientId + appointmentSlotBase64RawData
                                        → returns appointmentId
5. PATCH /ai/appointment/status-code-ai → mark as confirmed (appointmentStateByAI = confirmed_code)
```

## Key Cancellation Flow

```
1. GET /appointments ?PatientId=X&DateBegin=today&DateEnd=+90days → list upcoming
2. Confirm with patient which appointmentId to cancel
3. DELETE /appointment ?AppointmentId=X&AppointmentObservation="Cancelada via AI"
```
