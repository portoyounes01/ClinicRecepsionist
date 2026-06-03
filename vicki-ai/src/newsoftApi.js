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
const LOULE_DOCTOR_IDS = new Set([1, 3, 11, 13, 25, 33, 36, 39]);

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function clinicParams() {
  return { ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID };
}

// ─────────────────────────────────────────────
// PATIENT: Look up patient by phone number
// ─────────────────────────────────────────────
async function getPatientByPhone(phoneNumber) {
  const token = await cache.getToken();

  const formats = [
    phoneNumber,
    phoneNumber.replace('+351', ''),
    phoneNumber.replace('+', ''),
    '00' + phoneNumber.replace('+', ''),
  ];

  for (const fmt of formats) {
    try {
      console.log(`[Newsoft] Trying phone format: ${fmt}`);
      const res = await axios.get(`${BASE_URL}/patient`, {
        headers: authHeader(token),
        params:  { ...clinicParams(), PatientPhoneNumber: fmt },
      });
      if (res.data && (res.data.patientId || (Array.isArray(res.data) && res.data.length > 0))) {
        const patient = Array.isArray(res.data) ? res.data[0] : res.data;
        console.log(`[Newsoft] Patient found with format "${fmt}":`, patient.patientName);
        return patient;
      }
    } catch (err) {
      console.error(`[Newsoft] Format ${fmt} failed:`, err.response?.data || err.message);
    }
  }

  console.log('[Newsoft] No patient found for any phone format');
  return null;
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

module.exports = {
  getPatientByPhone,
  getDoctors:             cache.getDoctors,   // re-export from cache
  getMotives:             cache.getMotives,   // re-export from cache
  getAvailableSlots,
  getPatientAppointments,
  bookAppointment,
  cancelAppointment,
};
