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
  console.log('  APPOINTMENT LOOKUP — ID: 57654');
  console.log('══════════════════════════════════════════════════\n');

  // Try fetching by AppointmentId directly
  try {
    const res = await axios.get(`${BASE_URL}/appointment`, {
      headers,
      params: {
        ClinicNif: CLINIC_NIF,
        ClinicId: CLINIC_ID,
        CostCenterId: COST_CENTER_ID,
        AppointmentId: 57654,
      },
    });
    const data = res.data;
    if (!data || (Array.isArray(data) && data.length === 0)) {
      console.log('❌ No appointment found with ID 57654 via /appointment endpoint.');
    } else {
      const list = Array.isArray(data) ? data : [data];
      list.forEach((a, i) => {
        console.log(`[${i+1}] Appointment ID : ${a.appointmentId}`);
        console.log(`     Patient        : ${a.patientName} (ID: ${a.patientId})`);
        console.log(`     Doctor         : ${a.medicName} (ID: ${a.medicId})`);
        console.log(`     Date           : ${a.appointmentDate}`);
        console.log(`     Time           : ${a.appointmentTime}`);
        console.log(`     Motive         : ${a.motive || a.motiveName || '(none)'}`);
        console.log(`     Status         : ${a.appointmentStatusDescription}`);
        console.log(`     Observation    : ${a.appointmentObservation || '(none)'}`);
        console.log('');
      });
      return;
    }
  } catch (e) {
    console.log(`⚠️  /appointment endpoint failed: ${e.response?.data?.message || e.message}`);
  }

  // Fallback: search appointments for patientId 57125 over a wide range and filter
  console.log('\n🔄 Fallback: searching patient 57125 appointments over past year + next 90 days...\n');
  try {
    const past = new Date(); past.setFullYear(past.getFullYear() - 1);
    const future = new Date(); future.setDate(future.getDate() + 90);
    const fmt = d => d.toISOString().split('T')[0] + 'T00:00:00.000';

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
    console.log(`Total appointments returned for patient 57125: ${all.length}`);
    const match = all.find(a => String(a.appointmentId) === '57654');
    if (match) {
      console.log('\n✅ Found appointment 57654:\n');
      console.log(`   Patient   : ${match.patientName} (ID: ${match.patientId})`);
      console.log(`   Doctor    : ${match.medicName} (ID: ${match.medicId})`);
      console.log(`   Date      : ${match.appointmentDate}`);
      console.log(`   Time      : ${match.appointmentTime}`);
      console.log(`   Motive    : ${match.motive || match.motiveName || '(none)'}`);
      console.log(`   Status    : ${match.appointmentStatusDescription}`);
      console.log(`   Observation: ${match.appointmentObservation || '(none)'}`);
    } else {
      console.log('❌ Appointment ID 57654 not found in patient 57125\'s records.');
      console.log('\n📋 All appointment IDs found:');
      all.forEach(a => console.log(`   - ${a.appointmentId} | ${a.appointmentDate} ${a.appointmentTime} | ${a.medicName} | ${a.appointmentStatusDescription}`));
    }
  } catch (e) {
    console.log(`⚠️  Fallback query failed: ${e.response?.data?.message || e.message}`);
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

run().catch(e => {
  console.error('❌ Fatal:', e.response?.data || e.message);
});
