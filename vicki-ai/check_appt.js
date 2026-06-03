require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);

async function run() {
  // 1. Authenticate
  const auth = await axios.post(`${BASE_URL}/Authentication`, {
    username: process.env.NEWSOFT_USERNAME,
    password: process.env.NEWSOFT_PASSWORD,
  });
  const token = auth.data.token;
  const headers = { Authorization: `Bearer ${token}` };

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  console.log(`\nChecking appointments for: ${tomorrowStr}\n`);

  // 2. Check appointments for Younes (patientId: 57125)
  const start = `${tomorrowStr}T00:00:00.000`;
  const end   = `${tomorrowStr}T23:59:59.000`;

  const appts = await axios.get(`${BASE_URL}/appointments`, {
    headers,
    params: {
      ClinicNif: CLINIC_NIF,
      ClinicId: CLINIC_ID,
      CostCenterId: COST_CENTER_ID,
      PatientId: 57125,
      DateBegin: start,
      DateEnd: end,
      IncludeScheduledAppointments: true,
      IncludeConfirmedAppointments: true,
    },
  });

  const data = appts.data;
  if (!data || data.length === 0) {
    console.log('❌ No appointments found for Younes tomorrow.');
    return;
  }

  console.log(`✅ Found ${data.length} appointment(s) for Younes tomorrow:\n`);
  data.forEach((a, i) => {
    const isNadine = String(a.medicId) === '13' || (a.medicName || '').toLowerCase().includes('nadine');
    const is1145 = (a.appointmentTime || '').includes('11:45');
    console.log(`Appointment ${i + 1}:`);
    console.log(`  Doctor   : ${a.medicName} (ID: ${a.medicId})`);
    console.log(`  Date     : ${a.appointmentDate}`);
    console.log(`  Time     : ${a.appointmentTime}`);
    console.log(`  Motive   : ${a.motive || a.motiveName}`);
    console.log(`  Status   : ${a.appointmentStatusDescription}`);
    console.log(`  ➤ Dr. Nadine at 11:45? ${isNadine && is1145 ? '✅ YES!' : '❌ No'}`);
    console.log();
  });
}

run().catch(e => {
  console.error('Error:', e.response?.data || e.message);
});
