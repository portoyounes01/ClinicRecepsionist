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

  const past   = new Date(); past.setFullYear(past.getFullYear() - 1);
  const future = new Date(); future.setDate(future.getDate() + 90);
  const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000';

  console.log('\n══════════════════════════════════════════════════');
  console.log('  RAW APPOINTMENTS — Patient 57125 (Younes)');
  console.log('══════════════════════════════════════════════════\n');

  const res = await axios.get(`${BASE_URL}/appointments`, {
    headers,
    params: {
      ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID,
      PatientId: 57125,
      DateBegin: fmt(past),
      DateEnd:   fmt(future),
      IncludeScheduledAppointments: true,
      IncludeConfirmedAppointments: true,
      IncludeCancelledAppointments: true,
    },
  });

  const all = res.data || [];
  console.log(`Total: ${all.length} appointment(s)\n`);
  all.forEach((a, i) => {
    console.log(`--- [${i+1}] ---`);
    console.log(JSON.stringify(a, null, 2));
  });
  console.log('\n══════════════════════════════════════════════════\n');
}

run().catch(e => console.error('Error:', e.response?.data || e.message));
