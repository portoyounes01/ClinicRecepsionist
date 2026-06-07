// ============================================================
// VICKI AI — Newsoft API Connector
// All interactions with the clinic's Newsoft API go here.
// Token, doctors and motives come from newsoftCache.js.
// ============================================================

const axios = require('axios');
const cache = require('./newsoftCache');

const BASE_URL       = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF     = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID      = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);

// Only real doctors at Loulé — excludes reception/admin entries like 'Atendimento Margarida'
// NOTE: Dra. Aline Marodin (32, aesthetic medicine) is NOT here — she only works
// at the Quarteira clinic, so she is never offered/booked on this Loulé line.
const LOULE_DOCTOR_IDS = new Set([1, 3, 11, 13, 25, 33, 36, 39]);

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function clinicParams() {
  return { ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID };
}

function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (digits.startsWith('351') && digits.length === 12) return digits.slice(3);
  return digits || null;
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

async function getPatientByParams(params, label = 'lookup') {
  const token = await cache.getToken();
  const res = await axios.get(`${BASE_URL}/patient`, {
    headers: authHeader(token),
    params:  { ...clinicParams(), ...compactObject(params) },
  });
  if (!res.data || (Array.isArray(res.data) && res.data.length === 0)) return null;
  const patient = Array.isArray(res.data) ? res.data[0] : res.data;
  if (patient?.patientId) {
    console.log(`[Newsoft] Patient found by ${label}:`, patient.patientName);
    return patient;
  }
  return null;
}

// ─────────────────────────────────────────────
// PATIENT: Look up patient by phone number
// ─────────────────────────────────────────────
async function getPatientByPhone(phoneNumber) {
  const formats = [
    phoneNumber,
    phoneNumber.replace('+351', ''),
    phoneNumber.replace('+', ''),
    '00' + phoneNumber.replace('+', ''),
    normalizePhoneNumber(phoneNumber),
  ];

  for (const fmt of [...new Set(formats.filter(Boolean))]) {
    try {
      console.log(`[Newsoft] Trying phone format: ${fmt}`);
      const patient = await getPatientByParams({ PatientPhoneNumber: fmt }, `phone format "${fmt}"`);
      if (patient) return patient;
    } catch (err) {
      console.error(`[Newsoft] Format ${fmt} failed:`, err.response?.data || err.message);
    }
  }

  console.log('[Newsoft] No patient found for any phone format');
  return null;
}

async function getPatientByIdentity({ patientEmail, patientNif }) {
  if (patientNif) {
    try {
      const patient = await getPatientByParams({ PatientNIF: patientNif }, 'NIF');
      if (patient) return patient;
    } catch (err) {
      console.error('[Newsoft] NIF lookup failed:', err.response?.data || err.message);
    }
  }

  if (patientEmail) {
    try {
      const patient = await getPatientByParams({ PatientEmail: patientEmail }, 'email');
      if (patient) return patient;
    } catch (err) {
      console.error('[Newsoft] Email lookup failed:', err.response?.data || err.message);
    }
  }

  return null;
}

async function getPatientById(patientId) {
  if (!patientId) return null;
  try {
    return await getPatientByParams({ PatientId: patientId }, `id ${patientId}`);
  } catch (err) {
    console.error('[Newsoft] PatientId lookup failed:', err.response?.data || err.message);
    return null;
  }
}

async function createOrUpdatePatient({ patientName, phoneNumber, patientEmail, patientNif }) {
  const token = await cache.getToken();
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  const body = compactObject({
    clinicNif:          CLINIC_NIF,
    clinicId:           CLINIC_ID,
    costCenterId:       COST_CENTER_ID,
    patientName,
    patientEmail,
    patientPhoneNumber: normalizedPhone,
    patientNif,
    updatePatient:      true,
  });

  console.log('[Newsoft] createOrUpdatePatient body:', JSON.stringify({
    ...body,
    patientNif: body.patientNif ? '[set]' : undefined,
  }));

  const res = await axios.post(`${BASE_URL}/patient`, body, { headers: authHeader(token) });
  const patientId = Array.isArray(res.data) ? res.data[0]?.patientId : res.data?.patientId;
  const isNewPatient = Array.isArray(res.data) ? res.data[0]?.isNewPatient : res.data?.isNewPatient;
  if (!patientId) throw new Error(`Newsoft did not return patientId: ${JSON.stringify(res.data)}`);

  const patient = await getPatientById(patientId);
  return patient ? { ...patient, isNewPatient } : {
    patientId,
    patientName,
    patientEmail,
    patientNif,
    patientPhoneNumber: normalizedPhone,
    isNewPatient,
  };
}

// ─────────────────────────────────────────────
// AVAILABILITY: Get available slots for a doctor
// ─────────────────────────────────────────────
async function getAvailableSlots({ medicId, motiveId, dateFrom, dateTo }) {
  const token = await cache.getToken();

  const from = dateFrom.split('T')[0];
  const to   = dateTo.split('T')[0];
  const IntervalDates = `${from};${to}`;

  const params = {
    ...clinicParams(),
    IntervalDates,
    ...(medicId  && { MedicId: medicId }),
    ...(motiveId && { MotiveId: motiveId }),
  };

  console.log('[Newsoft] getAvailableSlots params:', JSON.stringify(params));

  try {
    const res = await axios.get(`${BASE_URL}/medics/availabilities`, {
      headers: authHeader(token),
      params,
    });
    const slots = res.data || [];
    // Filter out non-doctor entries (reception, admin, etc.) unless a specific medicId was requested
    return medicId
      ? slots
      : slots.filter(s => LOULE_DOCTOR_IDS.has(s.medicId));
  } catch (err) {
    console.error('[Newsoft] getAvailableSlots error:', JSON.stringify(err.response?.data));
    throw err;
  }
}

// ─────────────────────────────────────────────
// APPOINTMENTS: Get upcoming appointments
// ─────────────────────────────────────────────
async function getPatientAppointments(patientId) {
  const token = await cache.getToken();
  const today  = new Date();
  const future = new Date();
  future.setDate(future.getDate() + 90);

  const fmt = (d) => d.toISOString().split('T')[0] + 'T00:00:00.000';

  const res = await axios.get(`${BASE_URL}/appointments`, {
    headers: authHeader(token),
    params: {
      ...clinicParams(),
      PatientId: patientId,
      DateBegin: fmt(today),
      DateEnd:   fmt(future),
      IncludeScheduledAppointments: true,
      IncludeConfirmedAppointments: true,
    },
  });
  return res.data || [];
}

// ─────────────────────────────────────────────
// APPOINTMENTS: Get ALL clinic appointments in a date range (no patient
// filter). Used by the daily reminder sweep. Read-only.
// dateBegin/dateEnd are ISO datetime strings, e.g. '2026-06-08T00:00:00.000'.
// ─────────────────────────────────────────────
async function getAppointmentsByDateRange(dateBegin, dateEnd) {
  const token = await cache.getToken();
  const res = await axios.get(`${BASE_URL}/appointments`, {
    headers: authHeader(token),
    params: {
      ...clinicParams(),
      DateBegin: dateBegin,
      DateEnd:   dateEnd,
      IncludeScheduledAppointments: true,
      IncludeConfirmedAppointments: true,
    },
  });
  return res.data || [];
}

// ─────────────────────────────────────────────
// BOOK: Create a new appointment
// ─────────────────────────────────────────────
async function bookAppointment({ patientId, slotBase64, motiveName, observation }) {
  const token = await cache.getToken();
  const res = await axios.post(
    `${BASE_URL}/appointment`,
    {
      clinicNif:                   CLINIC_NIF,
      clinicId:                    CLINIC_ID,
      costCenterId:                COST_CENTER_ID,
      patientId,
      appointmentMotive:           motiveName,
      appointmentObservation:      observation || 'Marcação via AI Vicki',
      appointmentSlotBase64RawData: slotBase64,
      appointmentStatusCode:       '',
      incomingIp:                  '',
      externalCustomId:            '',
    },
    { headers: authHeader(token) }
  );
  return res.data;
}

// ─────────────────────────────────────────────
// CONFIRM: Mark an appointment as confirmed by the patient.
// ADDITIVE — used only by the lifecycle engine (WhatsApp/voice confirm).
// Does not change any existing behavior above.
//
// Verified 2026-06-07 against the live Newsoft status-code catalog
// (GET /appointments/status-code): the "confirmed" code is "C" = "Confirmada".
// The standard status-update endpoint is PUT /appointment/status-code with a
// string appointmentStatusCode (the old POST /appointment/confirm does not
// exist). Code stays configurable via NEWSOFT_CONFIRMED_STATUS_CODE.
// ─────────────────────────────────────────────
async function confirmAppointment({ appointmentId, channel }) {
  const token = await cache.getToken();
  const statusCode = process.env.NEWSOFT_CONFIRMED_STATUS_CODE || 'C';
  const res = await axios.put(
    `${BASE_URL}/appointment/status-code`,
    {
      clinicNif:             CLINIC_NIF,
      clinicId:              CLINIC_ID,
      costCenterId:          COST_CENTER_ID,
      appointmentId,
      appointmentStatusCode: statusCode,
      observation:           `Confirmada pelo paciente via Vicki (${channel || 'whatsapp'})`,
    },
    { headers: authHeader(token) }
  );
  return res.data;
}

// ─────────────────────────────────────────────
// CANCEL: Cancel an appointment
// ─────────────────────────────────────────────
async function cancelAppointment({ appointmentId, reason }) {
  const token = await cache.getToken();
  const res = await axios.delete(`${BASE_URL}/appointment`, {
    headers: authHeader(token),
    params: {
      ...clinicParams(),
      AppointmentId:          appointmentId,
      AppointmentObservation: reason || 'Cancelada pelo paciente via AI Vicki',
    },
  });
  return res.data;
}

// ─────────────────────────────────────────────
// DRY-RUN HOOK (offline simulation / voice gym)
// When VICKI_DRY_RUN is set and a provider is registered, calls are
// delegated to the provider instead of hitting the real Newsoft API —
// so the training gym never creates/cancels real appointments.
// Production path is byte-for-byte unchanged when the flag is off.
// ─────────────────────────────────────────────
let _dryProvider = null;
function __setDryRunProvider(provider) { _dryProvider = provider; }
const _dryOn = () => !!process.env.VICKI_DRY_RUN;

function dryWrap(name, realFn) {
  return async (...args) => {
    if (_dryOn() && _dryProvider && typeof _dryProvider[name] === 'function') {
      console.log(`[Newsoft] DRY_RUN ${name}`);
      return _dryProvider[name](...args);
    }
    return realFn(...args);
  };
}

module.exports = {
  getPatientByPhone:      dryWrap('getPatientByPhone', getPatientByPhone),
  getPatientByIdentity:   dryWrap('getPatientByIdentity', getPatientByIdentity),
  createOrUpdatePatient:  dryWrap('createOrUpdatePatient', createOrUpdatePatient),
  getDoctors:             dryWrap('getDoctors', cache.getDoctors),   // re-export from cache
  getMotives:             dryWrap('getMotives', cache.getMotives),   // re-export from cache
  getAvailableSlots:      dryWrap('getAvailableSlots', getAvailableSlots),
  getPatientAppointments: dryWrap('getPatientAppointments', getPatientAppointments),
  getAppointmentsByDateRange: dryWrap('getAppointmentsByDateRange', getAppointmentsByDateRange),
  bookAppointment:        dryWrap('bookAppointment', bookAppointment),
  cancelAppointment:      dryWrap('cancelAppointment', cancelAppointment),
  confirmAppointment:     dryWrap('confirmAppointment', confirmAppointment),
  __setDryRunProvider,
};
