// ─────────────────────────────────────────────
// check_phone.js
// Queries Newsoft for ALL records linked to +351923124786
// and lists any upcoming appointments for each.
// Usage: node check_phone.js
// ─────────────────────────────────────────────
require('dotenv').config();
const axios = require('axios');

const BASE_URL       = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF     = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID      = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);

const TARGET_PHONE_RAW = '923124786'; // stripped, no country code
const ALL_FORMATS = [
  '923124786',
  '+351923124786',
  '351923124786',
  '00351923124786',
];

async function authenticate() {
  const res = await axios.post(`${BASE_URL}/Authentication`, {
    username: process.env.NEWSOFT_USERNAME,
    password: process.env.NEWSOFT_PASSWORD,
  });
  return res.data.token;
}

async function queryPatient(token, params) {
  try {
    const res = await axios.get(`${BASE_URL}/patient`, {
      headers: { Authorization: `Bearer ${token}` },
      params:  { ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID, ...params },
    });
    if (!res.data) return [];
    return Array.isArray(res.data) ? res.data : [res.data];
  } catch (e) {
    console.log(`  ⚠️  Query failed (${JSON.stringify(params)}): ${e.response?.data?.message || e.message}`);
    return [];
  }
}

async function getAppointments(token, patientId) {
  const today  = new Date();
  const future = new Date();
  future.setDate(future.getDate() + 90);
  const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000';

  try {
    const res = await axios.get(`${BASE_URL}/appointments`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID,
        PatientId: patientId,
        DateBegin: fmt(today),
        DateEnd:   fmt(future),
        IncludeScheduledAppointments: true,
        IncludeConfirmedAppointments: true,
      },
    });
    return res.data || [];
  } catch (e) {
    console.log(`  ⚠️  Appointments query failed: ${e.response?.data?.message || e.message}`);
    return [];
  }
}

async function run() {
  console.log('\n══════════════════════════════════════════════════');
  console.log(`  PHONE LOOKUP: +351 ${TARGET_PHONE_RAW}`);
  console.log('══════════════════════════════════════════════════\n');

  const token = await authenticate();
  console.log('✅ Authenticated\n');

  // ── Step 1: Try every phone format, collect all unique patient IDs ──
  const allPatients = new Map(); // patientId → patient object

  for (const fmt of ALL_FORMATS) {
    console.log(`🔎 Trying format: ${fmt}`);
    const results = await queryPatient(token, { PatientPhoneNumber: fmt });
    for (const p of results) {
      if (p?.patientId && !allPatients.has(p.patientId)) {
        allPatients.set(p.patientId, p);
        console.log(`   → Found patient: ${p.patientName} (ID: ${p.patientId})`);
      } else if (p?.patientId) {
        console.log(`   → Duplicate: ${p.patientName} (ID: ${p.patientId}) — already seen`);
      }
    }
    if (results.length === 0) console.log('   → No match');
  }

  console.log(`\n──────────────────────────────────────────────────`);
  console.log(`  Total unique patients found: ${allPatients.size}`);
  console.log(`──────────────────────────────────────────────────\n`);

  if (allPatients.size === 0) {
    console.log('❌ No patient records found for this phone number.\n');
    return;
  }

  // ── Step 2: For each patient, fetch upcoming appointments ──
  for (const [id, p] of allPatients) {
    console.log(`\n👤 Patient: ${p.patientName}`);
    console.log(`   ID       : ${p.patientId}`);
    console.log(`   Phone    : ${p.patientPhoneNumber || '(not returned)'}`);
    console.log(`   Email    : ${p.patientEmail || '(not returned)'}`);

    const appts = await getAppointments(token, id);

    if (appts.length === 0) {
      console.log('   📅 No upcoming appointments (next 90 days)');
    } else {
      console.log(`   📅 ${appts.length} upcoming appointment(s):`);
      appts.forEach((a, i) => {
        console.log(`\n   [${i + 1}] Date   : ${a.appointmentDate}`);
        console.log(`        Time   : ${a.appointmentTime}`);
        console.log(`        Doctor : ${a.medicName} (ID: ${a.medicId})`);
        console.log(`        Motive : ${a.motive || a.motiveName || '(none)'}`);
        console.log(`        Status : ${a.appointmentStatusDescription}`);
        console.log(`        Appt ID: ${a.appointmentId}`);
      });
    }
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

run().catch(e => {
  console.error('\n❌ Fatal error:', e.response?.data || e.message);
  process.exit(1);
});
