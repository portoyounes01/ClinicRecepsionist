// ============================================================
// VICKI STRESS TEST — 100 patient inputs, parallel execution
// Tests routing accuracy, forbidden content, and response quality.
//
// Usage:  node scripts/stress-test.js
//         node scripts/stress-test.js --concurrency=20
// ============================================================

require('dotenv').config();
const { processTurn } = require('../src/aiLogic');

const args        = process.argv.slice(2);
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '10');

// ── Colours ──────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m',
};

// ── Fake clinic data ──────────────────────────────────────────
const CLINIC_INFO = {
  name: 'Instituto Vilas Boas', location: 'Loulé',
  address: 'Rua Principal, Loulé', phone: '+351289060008',
  hours: 'Monday to Friday 9am–7pm',
};
const PATIENT = { patientId: 57125, patientName: 'Younes Habibi', patientMedicName: 'Dr. Hermes' };
const DOCTORS = [
  { medicId: 11, medicShortName: 'Dr. Hermes' },
  { medicId:  1, medicShortName: 'Drª Carla Vilas Boas' },
  { medicId: 13, medicShortName: 'Drª Nadine' },
  { medicId: 25, medicShortName: 'Dr. Hugo Almeida' },
  { medicId: 39, medicShortName: 'Dr. Miguel Plácido' },
  { medicId: 33, medicShortName: 'Dra Silvia' },
];
const MOTIVES = [
  { motiveId: 1, motiveName: 'Consulta de Rotina' },
  { motiveId: 2, motiveName: 'Limpeza' },
  { motiveId: 3, motiveName: 'Urgência' },
];

// ─────────────────────────────────────────────────────────────
// 100 TEST CASES
// Each: { input, expectedAgent, mustContain?, mustNotContain? }
// ─────────────────────────────────────────────────────────────
const TESTS = [
  // ── BOOKING (25 inputs) ────────────────────────────────────
  { id: 1,  input: 'I want to book an appointment',         expectedAgent: 'booking' },
  { id: 2,  input: 'Can I schedule a consultation?',        expectedAgent: 'booking' },
  { id: 3,  input: 'I need to see a doctor',                expectedAgent: 'booking' },
  { id: 4,  input: 'Make me an appointment please',         expectedAgent: 'booking' },
  { id: 5,  input: 'I would like to book with Dr. Hermes',  expectedAgent: 'booking' },
  { id: 6,  input: 'I need a cleaning appointment',         expectedAgent: 'booking' },
  { id: 7,  input: 'Can I get an appointment tomorrow?',    expectedAgent: 'booking' },
  { id: 8,  input: 'Schedule me something with Dr. Carla',  expectedAgent: 'booking' },
  { id: 9,  input: 'I want a checkup',                      expectedAgent: 'booking' },
  { id: 10, input: 'Book me in for next week please',       expectedAgent: 'booking' },
  { id: 11, input: 'I need a dental cleaning',              expectedAgent: 'booking' },
  { id: 12, input: 'Marcar consulta',                       expectedAgent: 'booking' },
  { id: 13, input: 'Can I come in this week?',              expectedAgent: 'booking' },
  { id: 14, input: 'I need an appointment as soon as possible', expectedAgent: 'booking' },
  { id: 15, input: "I'd like a routine checkup with Nadine", expectedAgent: 'booking' },
  { id: 16, input: 'Book an appointment for my daughter',   expectedAgent: 'booking' },
  { id: 17, input: 'I want to come in for a consultation',  expectedAgent: 'booking' },
  { id: 18, input: 'Is Dr. Hermes available this week?',    expectedAgent: 'booking' },
  { id: 19, input: 'I need to see the dentist urgently',    expectedAgent: 'emergency' },  // urgent → emergency
  { id: 20, input: 'Book me for a filling',                 expectedAgent: 'booking' },
  { id: 21, input: 'I want an appointment for a tooth extraction', expectedAgent: 'booking' },
  { id: 22, input: 'Can Silvia see me on Friday?',          expectedAgent: 'booking' },
  { id: 23, input: 'I need to schedule for next month',     expectedAgent: 'booking' },
  { id: 24, input: 'New patient, want to book',             expectedAgent: 'booking' },
  { id: 25, input: 'Can I book for a dental implant consult', expectedAgent: 'booking' },

  // ── APPOINTMENTS / MANAGE (20 inputs) ─────────────────────
  { id: 26, input: 'I want to cancel my appointment',       expectedAgent: 'appointments' },
  { id: 27, input: 'Can I reschedule my appointment?',      expectedAgent: 'appointments' },
  { id: 28, input: 'What time is my appointment?',          expectedAgent: 'appointments' },
  { id: 29, input: 'I have an appointment tomorrow',        expectedAgent: 'appointments' },
  { id: 30, input: 'I need to change my appointment',       expectedAgent: 'appointments' },
  { id: 31, input: 'Cancel my booking please',              expectedAgent: 'appointments' },
  { id: 32, input: 'I want to move my appointment to Friday', expectedAgent: 'appointments' },
  { id: 33, input: 'Do I have an appointment this week?',   expectedAgent: 'appointments' },
  { id: 34, input: 'I need to postpone my appointment',     expectedAgent: 'appointments' },
  { id: 35, input: 'I forgot what time my appointment is',  expectedAgent: 'appointments' },
  { id: 36, input: 'I want to cancel for next Tuesday',     expectedAgent: 'appointments' },
  { id: 37, input: 'Can you tell me when my next appointment is?', expectedAgent: 'appointments' },
  { id: 38, input: 'I want to push my appointment back a week', expectedAgent: 'appointments' },
  { id: 39, input: 'I need to confirm my appointment',      expectedAgent: 'appointments' },
  { id: 40, input: 'Reschedule my 3pm appointment',         expectedAgent: 'appointments' },
  { id: 41, input: 'I have to cancel — something came up',  expectedAgent: 'appointments' },
  { id: 42, input: 'Check my upcoming appointments',        expectedAgent: 'appointments' },
  { id: 43, input: 'I want to see my next appointment',     expectedAgent: 'appointments' },
  { id: 44, input: 'Cancel everything this week',           expectedAgent: 'appointments' },
  { id: 45, input: 'Can I switch from morning to afternoon?', expectedAgent: 'appointments' },

  // ── INFO (20 inputs) ──────────────────────────────────────
  { id: 46, input: 'What are your opening hours?',          expectedAgent: 'info' },
  { id: 47, input: 'Where are you located?',                expectedAgent: 'info' },
  { id: 48, input: 'What services do you offer?',           expectedAgent: 'info' },
  { id: 49, input: 'Do you do teeth whitening?',            expectedAgent: 'info' },
  { id: 50, input: 'Are you open on weekends?',             expectedAgent: 'info' },
  { id: 51, input: 'What is your phone number?',            expectedAgent: 'info' },
  { id: 52, input: 'Do you accept new patients?',           expectedAgent: 'info' },
  { id: 53, input: 'Which doctors do you have?',            expectedAgent: 'info' },
  { id: 54, input: 'When does Dr. Carla work?',             expectedAgent: 'info' },
  { id: 55, input: 'Do you do implants?',                   expectedAgent: 'info' },
  { id: 56, input: 'What time do you close?',               expectedAgent: 'info' },
  { id: 57, input: 'Do you have parking?',                  expectedAgent: 'info' },
  { id: 58, input: 'Is Dr. Hermes available on Mondays?',   expectedAgent: 'info' },
  { id: 59, input: 'Do you speak English?',                 expectedAgent: 'info' },
  { id: 60, input: 'What insurance do you accept?',         expectedAgent: 'info' },
  { id: 61, input: 'Do you treat children?',                expectedAgent: 'info' },
  { id: 62, input: 'Are you open on Saturday?',             expectedAgent: 'info' },
  { id: 63, input: 'What kind of treatments do you offer?', expectedAgent: 'info' },
  { id: 64, input: 'Is there a dentist available today?',   expectedAgent: 'info' },
  { id: 65, input: 'Tell me about the clinic',              expectedAgent: 'info' },

  // ── PRICING — must NEVER reveal price (20 inputs) ─────────
  { id: 66,  input: 'How much does a cleaning cost?',       expectedAgent: 'info', mustNotContain: ['€', 'euro', 'cost is', 'price is', 'costs', 'charge'] },
  { id: 67,  input: 'What is the price of a consultation?', expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs', 'price is'] },
  { id: 68,  input: 'How much for teeth whitening?',        expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 69,  input: 'What do you charge for implants?',     expectedAgent: 'info', mustNotContain: ['€', 'euro', 'charge', 'costs'] },
  { id: 70,  input: 'Give me a price for braces',           expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 71,  input: 'Is a checkup expensive?',              expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 72,  input: 'How much is a root canal?',            expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 73,  input: 'What are your prices?',                expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 74,  input: 'Do you have payment plans?',           expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 75,  input: 'How much is an X-ray?',                expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 76,  input: 'Is it free for children?',             expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 77,  input: 'How much for a filling?',              expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 78,  input: 'What is the cost of orthodontics?',    expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 79,  input: 'Do you accept health insurance?',      expectedAgent: 'info' },
  { id: 80,  input: 'How much does it cost to see a specialist?', expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 81,  input: 'Quanto custa uma consulta?',           expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 82,  input: 'Price for extraction please',          expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },
  { id: 83,  input: 'Do you have a price list?',            expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 84,  input: 'Can I get a quote for veneers?',       expectedAgent: 'info', mustNotContain: ['€', 'euro'] },
  { id: 85,  input: 'How much is a consultation with Dr. Hermes?', expectedAgent: 'info', mustNotContain: ['€', 'euro', 'costs'] },

  // ── EMERGENCY (8 inputs) ──────────────────────────────────
  { id: 86, input: 'I have a terrible toothache',           expectedAgent: 'emergency' },
  { id: 87, input: "My tooth broke and I'm in pain",       expectedAgent: 'emergency' },
  { id: 88, input: 'I have severe tooth pain',              expectedAgent: 'emergency' },
  { id: 89, input: 'I need emergency dental care',          expectedAgent: 'emergency' },
  { id: 90, input: 'My face is swelling',                   expectedAgent: 'emergency' },
  { id: 91, input: 'I knocked out a tooth in an accident',  expectedAgent: 'emergency' },
  { id: 92, input: 'I have a dental abscess I think',       expectedAgent: 'emergency' },
  { id: 93, input: 'There is bleeding in my mouth',         expectedAgent: 'emergency' },

  // ── HUMAN TRANSFER (7 inputs) ─────────────────────────────
  { id: 94,  input: 'I want to speak to a real person',     expectedAgent: 'human', mustContain: ['team', 'connect'] },
  { id: 95,  input: 'Let me talk to someone',               expectedAgent: 'human' },
  { id: 96,  input: 'I have a complaint',                   expectedAgent: 'human' },
  { id: 97,  input: 'I was overcharged on my last visit',   expectedAgent: 'human', mustNotContain: ['€', 'euro'] },
  { id: 98,  input: "I don't want to talk to a robot",     expectedAgent: 'human' },
  { id: 99,  input: 'I need to speak with the manager',     expectedAgent: 'human' },
  { id: 100, input: 'Transfer me to reception please',      expectedAgent: 'human' },
];

// ─────────────────────────────────────────────────────────────
// RUN A SINGLE TEST
// ─────────────────────────────────────────────────────────────
async function runTest(test) {
  const start = Date.now();

  try {
    const result = await processTurn({
      history:       [],
      patient:       PATIENT,
      clinicInfo:    CLINIC_INFO,
      userText:      test.input,
      cachedDoctors: DOCTORS,
      cachedMotives: MOTIVES,
      currentAgent:  'router',
      unclearTurns:  0,
    });

    const ms          = Date.now() - start;
    const agentReached = result.currentAgent || 'router';
    const speak        = result.speak || '';

    // Check expected agent
    const agentOk = agentReached === test.expectedAgent ||
      (test.expectedAgent === 'booking'      && agentReached === 'booking') ||
      (test.expectedAgent === 'appointments' && agentReached === 'appointments') ||
      (test.expectedAgent === 'info'         && (agentReached === 'info' || agentReached === 'human')) ||
      (test.expectedAgent === 'emergency'    && agentReached === 'emergency') ||
      (test.expectedAgent === 'human'        && agentReached === 'human');

    // Check mustNotContain
    const forbidden = (test.mustNotContain || []).find(w => speak.toLowerCase().includes(w.toLowerCase()));

    // Check mustContain
    const missing = (test.mustContain || []).find(w => !speak.toLowerCase().includes(w.toLowerCase()));

    const passed = agentOk && !forbidden && !missing;

    return {
      id:      test.id,
      input:   test.input,
      expected: test.expectedAgent,
      got:      agentReached,
      speak:    speak.slice(0, 80),
      ms,
      passed,
      reason: !agentOk    ? `wrong agent: expected ${test.expectedAgent}, got ${agentReached}`
            : forbidden   ? `forbidden word "${forbidden}" in response`
            : missing     ? `missing required word "${missing}"`
            : null,
    };
  } catch (err) {
    return {
      id: test.id, input: test.input, expected: test.expectedAgent,
      got: 'ERROR', passed: false, ms: Date.now() - start,
      reason: err.message,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// RUN ALL TESTS WITH CONCURRENCY CONTROL
// ─────────────────────────────────────────────────────────────
async function runAll() {
  console.log(`\n${C.blue}${C.bold}╔═══════════════════════════════════════════════════╗`);
  console.log(`║         VICKI STRESS TEST — 100 INPUTS           ║`);
  console.log(`╚═══════════════════════════════════════════════════╝${C.reset}`);
  console.log(`  Concurrency: ${CONCURRENCY}  |  Total: ${TESTS.length} tests\n`);

  const results = [];
  const queue   = [...TESTS];
  let done = 0;

  // Process in parallel batches
  async function worker() {
    while (queue.length > 0) {
      const test = queue.shift();
      if (!test) return;
      const r = await runTest(test);
      results.push(r);
      done++;
      const icon = r.passed ? `${C.green}✅${C.reset}` : `${C.red}❌${C.reset}`;
      process.stdout.write(`\r  ${icon} ${done}/${TESTS.length}  (${r.ms}ms) — #${r.id}: ${r.input.slice(0,45).padEnd(45)}    `);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, worker);
  await Promise.all(workers);

  process.stdout.write('\n\n');

  // ── Results ──────────────────────────────────────────────────
  results.sort((a, b) => a.id - b.id);
  const failed = results.filter(r => !r.passed);
  const passed = results.filter(r => r.passed);
  const avgMs  = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);

  if (failed.length > 0) {
    console.log(`${C.red}${C.bold}FAILURES:${C.reset}`);
    failed.forEach(r => {
      console.log(`  ${C.red}#${r.id}${C.reset} "${r.input}"`);
      console.log(`       Expected: ${r.expected}  Got: ${r.got}`);
      console.log(`       Reason: ${r.reason}`);
      console.log(`       Vicki said: "${r.speak}"`);
    });
    console.log('');
  }

  // Stats by category
  const cats = {
    booking:      { label: '📅 Booking',       ids: [1,25]  },
    appointments: { label: '📋 Appointments',  ids: [26,45] },
    info:         { label: 'ℹ️  Info',          ids: [46,65] },
    pricing:      { label: '💰 Pricing (no $)', ids: [66,85] },
    emergency:    { label: '🚨 Emergency',      ids: [86,93] },
    human:        { label: '👤 Human',          ids: [94,100]},
  };

  console.log(`${C.bold}Results by category:${C.reset}`);
  for (const [, cat] of Object.entries(cats)) {
    const catResults = results.filter(r => r.id >= cat.ids[0] && r.id <= cat.ids[1]);
    const catPassed  = catResults.filter(r => r.passed).length;
    const icon = catPassed === catResults.length ? C.green + '✅' : C.yellow + '⚠️ ';
    console.log(`  ${icon}${C.reset} ${cat.label.padEnd(25)} ${catPassed}/${catResults.length}`);
  }

  console.log(`\n${C.bold}Overall:${C.reset} ${C.green}${passed.length}${C.reset}/${TESTS.length} passed  |  Avg response: ${avgMs}ms`);
  console.log(`${C.bold}Score:${C.reset} ${Math.round(passed.length / TESTS.length * 100)}%\n`);
}

runAll().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
