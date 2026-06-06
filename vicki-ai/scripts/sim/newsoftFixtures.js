// ============================================================
// VICKI VOICE GYM — Newsoft fixture provider
//
// Drop-in replacement for the real Newsoft API used only when
// VICKI_DRY_RUN is set. Registered via newsoftApi.__setDryRunProvider().
// Generates deterministic, realistic data per scenario so the gym never
// touches the real clinic system (no real bookings / cancellations).
//
// Uses the REAL doctor roster + motives from data/newsoft_cache.json so
// medicIds, names and specialties match production exactly.
// ============================================================

const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../../data/newsoft_cache.json');

let _cache = { doctors: [], motives: [] };
try {
  _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (e) {
  console.warn('[Fixtures] could not read newsoft_cache.json — using minimal fallback roster');
  _cache = {
    doctors: [
      { medicId: 1,  medicShortName: 'Drª Carla Vilas Boas', medicName: 'Carla Maria Santos Vilas Boas' },
      { medicId: 11, medicShortName: 'Dr. Hermes',           medicName: 'Hermes' },
      { medicId: 13, medicShortName: 'Drª Nadine',           medicName: 'Nadine' },
      { medicId: 36, medicShortName: 'Beatriz Cafe',         medicName: 'Beatriz Cafe' },
    ],
    motives: [
      { motiveId: 'ACH', motiveName: 'Avaliação/ Check-up' },
      { motiveId: 'ON',  motiveName: 'Outros/Não tenho a certeza' },
      { motiveId: 'UR',  motiveName: 'Urgência (Dentes Partidos, Dor, Etc)' },
    ],
  };
}

const LOULE_DOCTOR_IDS = [1, 3, 11, 13, 25, 33, 36, 39];
const LOULE_DOCTORS = _cache.doctors.filter(d => LOULE_DOCTOR_IDS.includes(d.medicId));

// ── date helpers (no Date.now reliance for the date math beyond "today") ──
function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function isWeekend(d) { const g = d.getDay(); return g === 0 || g === 6; }

// Build a fake but decodable slot token so bookAppointment can echo details back.
function makeSlotToken(medicId, dateBegin) {
  return Buffer.from(JSON.stringify({ medicId, dateBegin })).toString('base64');
}

const MORNING_TIMES   = ['09:00', '10:30', '11:30'];
const AFTERNOON_TIMES = ['14:00', '15:30', '16:30'];

function slotObj(doc, dateStr, time) {
  const dateBegin = `${dateStr}T${time}:00`;
  return {
    medicId:                       doc.medicId,
    medicShortName:                doc.medicShortName,
    medicName:                     doc.medicName,
    appointmentDateBegin:          dateBegin,
    appointmentSlotBase64RawData:  makeSlotToken(doc.medicId, dateBegin),
    appointmentEnglishMessage:     `${dateStr} ${time} with ${doc.medicShortName}`,
  };
}

// ── the provider factory ────────────────────────────────────────────────
// config:
//   patient: patient object returned by phone lookup (or null = unknown caller)
//   slotMode: 'plenty' | 'morningOnly' | 'afternoonOnly' | 'singleDay' | 'empty'
//   urgentHasSlots: bool — whether motiveId 'UR' returns any near-term slot
//   existingAppointments: raw appointment array for getPatientAppointments
//   doctorIds: optional subset of medicIds to offer (defaults to all Loulé)
function makeProvider(config = {}) {
  const {
    patient = null,
    slotMode = 'plenty',
    urgentHasSlots = false,
    existingAppointments = [],
    doctorIds = null,
  } = config;

  // mutable side-effect log the harness can inspect after a call
  const sideEffects = { booked: [], cancelled: [], createdPatients: [] };

  function offerableDoctors(requestedMedicId) {
    const allow = doctorIds || LOULE_DOCTOR_IDS;
    if (requestedMedicId != null) {
      const id = parseInt(requestedMedicId, 10);
      // Respect the scenario's doctorIds even for a specific request — so a
      // doctor the scenario excludes (e.g. "Hermes has no slot") truly has none.
      return LOULE_DOCTORS.filter(d => d.medicId === id && allow.includes(d.medicId));
    }
    return LOULE_DOCTORS.filter(d => allow.includes(d.medicId));
  }

  function generateSlots({ medicId, motiveId, dateFrom, dateTo }) {
    if (slotMode === 'empty') return [];
    if (motiveId === 'UR' && !urgentHasSlots) return [];

    const docs = offerableDoctors(medicId);
    if (!docs.length) return [];

    const start = new Date(`${(dateFrom || isoDate(new Date())).split('T')[0]}T00:00:00`);
    const end   = new Date(`${(dateTo   || isoDate(addDays(new Date(), 21))).split('T')[0]}T00:00:00`);

    let times;
    if (slotMode === 'morningOnly')        times = MORNING_TIMES;
    else if (slotMode === 'afternoonOnly') times = AFTERNOON_TIMES;
    else                                   times = [MORNING_TIMES[0], AFTERNOON_TIMES[0]];

    const out = [];
    let dayCount = 0;
    const maxDays = slotMode === 'singleDay' ? 1 : 6;
    for (let d = new Date(start); d <= end && dayCount < maxDays; d = addDays(d, 1)) {
      if (isWeekend(d)) continue;
      const dateStr = isoDate(d);
      for (const doc of docs) {
        for (const t of times) out.push(slotObj(doc, dateStr, t));
      }
      dayCount++;
    }
    return out;
  }

  return {
    // ── lookups ──
    async getPatientByPhone(/* phoneNumber */) { return patient; },
    async getPatientByIdentity()               { return patient; },
    async getDoctors()                         { return LOULE_DOCTORS; },
    async getMotives()                         { return _cache.motives; },

    // ── availability ──
    async getAvailableSlots(params)            { return generateSlots(params); },
    async getPatientAppointments(/* id */)     { return existingAppointments; },

    // ── mutations (logged, never real) ──
    async createOrUpdatePatient(p) {
      const created = {
        patientId:   patient?.patientId || 90000 + sideEffects.createdPatients.length,
        patientName: p.patientName,
        patientPhoneNumber: p.phoneNumber,
        isNewPatient: !patient,
      };
      sideEffects.createdPatients.push(created);
      return created;
    },
    async bookAppointment(b) {
      let detail = {};
      try { detail = JSON.parse(Buffer.from(b.slotBase64, 'base64').toString('utf8')); } catch (_) {}
      const appt = { appointmentId: `SIM_${sideEffects.booked.length + 1}`, ...b, ...detail };
      sideEffects.booked.push(appt);
      return [{ appointmentId: appt.appointmentId }];
    },
    async cancelAppointment(c) {
      sideEffects.cancelled.push(c);
      return { appointmentCanceled: true };
    },

    // ── test introspection ──
    __sideEffects: sideEffects,
  };
}

module.exports = { makeProvider, LOULE_DOCTORS, LOULE_DOCTOR_IDS, makeSlotToken };
