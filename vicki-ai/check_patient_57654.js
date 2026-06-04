require('dotenv').config();
const axios = require('axios');

const BASE_URL       = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF     = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID      = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);

async function run() {
  const auth = await axios.post(`${BASE_URL}/Authentication`, {
    username: process.env.NEWSOFT_USERNAME,
    password: process.env.NEWSOFT_PASSWORD,
  });
  const token = auth.data.token;
  const headers = { Authorization: `Bearer ${token}` };

  console.log('\n══════════════════════════════════════════════════');
  console.log('  PATIENT LOOKUP — ID: 57654');
  console.log('══════════════════════════════════════════════════\n');

  // 1. Get patient info
  let patient = null;
  try {
    const res = await axios.get(`${BASE_URL}/patient`, {
      headers,
      params: { ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID, PatientId: 57654 },
    });
    const data = res.data;
    patient = Array.isArray(data) ? data[0] : data;
    if (patient?.patientId) {
      console.log('✅ Patient found:\n');
      console.log('RAW PATIENT DATA:');
      console.log(JSON.stringify(patient, null, 2));
    } else {
      console.log('❌ No patient found with ID 57654');
      console.log('Raw response:', JSON.stringify(data, null, 2));
      return;
    }
  } catch (e) {
    console.log(`❌ Patient lookup failed: ${e.response?.status} — ${JSON.stringify(e.response?.data) || e.message}`);
    return;
  }

  // 2. Get ALL appointments (wide date range, dump raw)
  console.log('\n──────────────────────────────────────────────────');
  console.log('  APPOINTMENTS (past 1 year + next 90 days)');
  console.log('──────────────────────────────────────────────────\n');

  const past   = new Date(); past.setFullYear(past.getFullYear() - 1);
  const future = new Date(); future.setDate(future.getDate() + 90);
  const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000';

  try {
    const res = await axios.get(`${BASE_URL}/appointments`, {
      headers,
      params: {
        ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID,
        PatientId: 57654,
        DateBegin: fmt(past),
        DateEnd:   fmt(future),
        IncludeScheduledAppointments: true,
        IncludeConfirmedAppointments: true,
        IncludeCancelledAppointments: true,
      },
    });

    const all = res.data || [];
    console.log(`Total appointments returned: ${all.length}\n`);

    if (all.length === 0) {
      console.log('📅 No appointments found for this patient.');
    } else {
      console.log('RAW APPOINTMENTS DATA:');
      console.log(JSON.stringify(all, null, 2));
    }
  } catch (e) {
    console.log(`❌ Appointments query failed: ${e.response?.status} — ${JSON.stringify(e.response?.data) || e.message}`);
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

run().catch(e => {
  console.error('❌ Fatal:', e.response?.data || e.message);
});
