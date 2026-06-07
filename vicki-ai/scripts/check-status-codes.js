// READ-ONLY diagnostic for ROADMAP task 1.3.
// Fetches the live Newsoft appointment status-code catalog so we know the
// real "confirmed" code (and what the other codes mean). Makes only GET
// calls — never writes/confirms/cancels anything.
require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);

async function run() {
  const auth = await axios.post(`${BASE_URL}/Authentication`, {
    username: process.env.NEWSOFT_USERNAME,
    password: process.env.NEWSOFT_PASSWORD,
  });
  const headers = { Authorization: `Bearer ${auth.data.token}` };
  const params = { ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID };

  console.log('\n=== GET /appointments/status-code (catalog) ===');
  try {
    const res = await axios.get(`${BASE_URL}/appointments/status-code`, { headers, params });
    console.log(JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.log('status-code catalog FAILED:', e.response?.status, JSON.stringify(e.response?.data || e.message));
  }
}

run().catch(e => console.error('Error:', e.response?.status, e.response?.data || e.message));
