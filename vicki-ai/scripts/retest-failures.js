require('dotenv').config();
const { processTurn } = require('../src/aiLogic');

const CLINIC_INFO = { name: 'Instituto Vilas Boas', location: 'Loule', hours: 'Mon-Fri 9am-7pm' };
const PATIENT = { patientId: 57125, patientName: 'Younes Habibi', patientMedicName: 'Dr. Hermes' };
const DOCTORS = [
  { medicId: 11, medicShortName: 'Dr. Hermes' },
  { medicId:  1, medicShortName: 'Dra Carla Vilas Boas' },
  { medicId: 33, medicShortName: 'Dra Silvia' },
];
const MOTIVES = [{ motiveId: 1, motiveName: 'Consulta de Rotina' }];

const RETESTS = [
  { id:  3, input: 'I need to see a doctor',              expected: 'booking' },
  { id: 13, input: 'Can I come in this week?',            expected: 'booking' },
  { id: 18, input: 'Is Dr. Hermes available this week?',  expected: 'booking' },
  { id: 22, input: 'Can Silvia see me on Friday?',        expected: 'booking' },
  { id: 59, input: 'Do you speak English?',               expected: 'info'    },
];

async function run() {
  let passed = 0;
  for (const t of RETESTS) {
    const r = await processTurn({
      history: [], patient: PATIENT, clinicInfo: CLINIC_INFO,
      userText: t.input, cachedDoctors: DOCTORS, cachedMotives: MOTIVES,
      currentAgent: 'router', unclearTurns: 0,
    });
    const got = r.currentAgent || 'router';
    const ok  = got === t.expected;
    if (ok) passed++;
    console.log((ok ? 'PASS' : 'FAIL') + '  #' + t.id + ' "' + t.input + '" → expected=' + t.expected + ' got=' + got);
    console.log('       Vicki: "' + (r.speak || '').slice(0, 90) + '"');
  }
  console.log('\nResult: ' + passed + '/' + RETESTS.length + ' fixed');
}
run().catch(console.error);
