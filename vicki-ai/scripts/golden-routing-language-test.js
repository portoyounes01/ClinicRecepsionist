// ============================================================
// Fast golden tests for deterministic routing + PT-first language state.
// ============================================================

require('dotenv').config();
const assert = require('assert');
const { processTurn } = require('../src/aiLogic');

const CLINIC_INFO = {
  name: 'Instituto Vilas Boas',
  location: 'Loule',
  address: 'Avenida 25 de Abril, Loule',
  phone: '+351289422269',
  mobile: '+351962432761',
  email: 'geral@institutovilasboas.pt',
  hours: 'Monday to Friday 09:00-19:30',
};

const PATIENT = {
  patientId: 57125,
  patientName: 'Younes Habibi',
  patientMedicName: 'Dr. Hermes',
};

const DOCTORS = [
  { medicId: 11, medicShortName: 'Dr. Hermes' },
  { medicId: 33, medicShortName: 'Dra. Silvia' },
  { medicId: 1, medicShortName: 'Dra. Carla Vilas Boas' },
];

const forbiddenBrazilian = [
  /\bvoce\b/i,
  /\bvocê\b/i,
  /\btudo bem\?/i,
  /\boi\b/i,
  /\btchau\b/i,
  /\ba gente\b/i,
  /\bpra\b/i,
  /\bne\b/i,
  /\bné\b/i,
];

const cases = [
  { input: 'I need to see a doctor', expectedAgent: 'booking', language: 'en' },
  { input: 'Can I come in this week?', expectedAgent: 'booking', language: 'en' },
  { input: 'Is Dr. Hermes available this week?', expectedAgent: 'booking', language: 'en' },
  { input: 'Can Silvia see me on Friday?', expectedAgent: 'booking', language: 'en' },
  { input: 'Do you speak English?', expectedAgent: 'info', language: 'en', mustContain: 'english' },
  { input: 'Transfer me to reception please', expectedAgent: 'human', language: 'en', action: 'transfer_to_human', mustContain: 'team' },
  { input: 'Queria marcar uma consulta', expectedAgent: 'booking', language: 'pt' },
  { input: 'Tenho muita dor de dentes', expectedAgent: 'emergency', language: 'pt' },
  { input: 'Quanto custa uma limpeza?', expectedAgent: 'info', language: 'pt' },
  { input: 'Tenho alguma consulta marcada?', expectedAgent: 'appointments', language: 'pt' },
  { input: 'Eu queria saber se ja tenho uma consulta agendada', expectedAgent: 'appointments', language: 'pt' },
];

async function runCase(test) {
  const result = await processTurn({
    history: [],
    patient: PATIENT,
    clinicInfo: CLINIC_INFO,
    userText: test.input,
    cachedDoctors: DOCTORS,
    currentAgent: 'router',
    unclearTurns: 0,
    languageState: 'unknown',
  });

  assert.strictEqual(result.currentAgent, test.expectedAgent, `${test.input}: expected agent ${test.expectedAgent}, got ${result.currentAgent}`);
  assert.strictEqual(result.languageState, test.language, `${test.input}: expected language ${test.language}, got ${result.languageState}`);
  if (test.action) assert.strictEqual(result.action, test.action, `${test.input}: expected action ${test.action}, got ${result.action}`);
  if (test.mustContain) assert.match((result.speak || '').toLowerCase(), new RegExp(test.mustContain), `${test.input}: missing "${test.mustContain}" in "${result.speak}"`);

  const forbidden = forbiddenBrazilian.find(pattern => pattern.test(result.speak || ''));
  assert.ok(!forbidden, `${test.input}: used forbidden Brazilian Portuguese term "${forbidden}" in "${result.speak}"`);
}

(async () => {
  for (const test of cases) {
    await runCase(test);
  }
  console.log(`Golden routing/language tests passed: ${cases.length}/${cases.length}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
