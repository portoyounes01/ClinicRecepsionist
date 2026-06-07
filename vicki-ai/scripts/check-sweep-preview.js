// READ-ONLY: preview what the daily reminder sweep WOULD queue for today+N.
// No DB writes, no messages. Prints counts + non-PHI samples only.
require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);
const DAYS_AHEAD = parseInt(process.env.REMINDER_DAYS_AHEAD || '2', 10);
const DOCTOR_IDS = new Set((process.env.LOULE_DOCTOR_IDS || '1,3,11,13,25,33,36,39')
  .split(',').map(s => parseInt(s.trim(), 10)));
const REMINDABLE = new Set(['', 'Z']);
const elig = (s) => REMINDABLE.has(String(s == null ? '' : s).trim().toUpperCase());

async function run() {
  const auth = await axios.post(`${BASE_URL}/Authentication`, {
    username: process.env.NEWSOFT_USERNAME, password: process.env.NEWSOFT_PASSWORD,
  });
  const headers = { Authorization: `Bearer ${auth.data.token}` };
  const t = new Date(); t.setDate(t.getDate() + DAYS_AHEAD);
  const day = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;

  const res = await axios.get(`${BASE_URL}/appointments`, {
    headers, params: {
      ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID,
      DateBegin: `${day}T00:00:00.000`, DateEnd: `${day}T23:59:59.000`,
      IncludeScheduledAppointments: true, IncludeConfirmedAppointments: true,
    },
  });
  const appts = res.data || [];
  let queue = 0, noDoctor = 0, noPhone = 0, notEligible = 0;
  const samples = [];
  for (const a of appts) {
    const phone = a.patientPhoneNumber || a.patientPhoneNumber2;
    if (DOCTOR_IDS.size && !DOCTOR_IDS.has(Number(a.medicId))) { noDoctor++; continue; }
    if (!phone || !a.appointmentId || !a.patientId) { noPhone++; continue; }
    if (!elig(a.appointmentStatusCode)) { notEligible++; continue; }
    queue++;
    if (samples.length < 8) samples.push(`  ${a.appointmentDateBeginLocal}  ${a.medicName}  status="${a.appointmentStatusCode}"  hasPhone=${!!phone}`);
  }
  console.log(`Target day (today+${DAYS_AHEAD}): ${day}`);
  console.log(`Fetched: ${appts.length}`);
  console.log(`WOULD REMIND: ${queue}`);
  console.log(`Skipped — not a known doctor: ${noDoctor}, no phone/ids: ${noPhone}, status not eligible: ${notEligible}`);
  console.log('\nSamples (non-PHI):');
  console.log(samples.join('\n') || '  (none)');
}
run().catch(e => console.error('Error:', e.response?.status, e.response?.data || e.message));
