// ============================================================
// VICKI AUTO-TESTER
// Simulates real patient calls using GPT as the "patient AI".
// Tests the full conversation logic without needing a phone call.
//
// Usage:  node scripts/test-vicki.js
//         node scripts/test-vicki.js --scenario booking
//         node scripts/test-vicki.js --scenario emergency
//         node scripts/test-vicki.js --all
// ============================================================

require('dotenv').config();
const OpenAI = require('openai');
const { processTurn } = require('../src/aiLogic');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Colours for terminal output ──────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
};

function vicki(text)   { console.log(`${C.cyan}${C.bold}  Vicki   → ${C.reset}${C.cyan}"${text}"${C.reset}`); }
function patient(text) { console.log(`${C.green}${C.bold}  Patient → ${C.reset}${C.green}"${text}"${C.reset}`); }
function info(text)    { console.log(`${C.dim}           ${text}${C.reset}`); }
function header(text)  { console.log(`\n${C.yellow}${C.bold}${'═'.repeat(60)}${C.reset}\n${C.yellow}${C.bold}  ${text}${C.reset}\n${C.yellow}${C.bold}${'═'.repeat(60)}${C.reset}`); }
function pass(text)    { console.log(`${C.green}${C.bold}  ✅ PASS: ${C.reset}${text}`); }
function fail(text)    { console.log(`${C.red}${C.bold}  ❌ FAIL: ${C.reset}${text}`); }
function warn(text)    { console.log(`${C.magenta}${C.bold}  ⚠️  WARN: ${C.reset}${text}`); }

// ── Fake clinic + patient data ────────────────────────────────
const CLINIC_INFO = {
  name:     'Instituto Vilas Boas',
  location: 'Loulé',
  address:  'Rua Principal, Loulé',
  phone:    '+351289060008',
  mobile:   '+351912345678',
  email:    'loule@vilasboas.pt',
  hours:    'Monday to Friday 9am–7pm, Saturday 9am–1pm',
};

const KNOWN_PATIENT = {
  patientId:       57125,
  patientName:     'Younes Habibi',
  patientMedicName:'Dr. Hermes',
  phone:           '+351000000000',
};

const UNKNOWN_PATIENT = null; // unknown caller

// ── Fake doctors + motives (from cache) ──────────────────────
const CACHED_DOCTORS = [
  { name: 'Dr. Hermes',           id: 1001 },
  { name: 'Dra. Carla Vilas Boas',id: 1002 },
  { name: 'Dra. Nadine',          id: 1003 },
  { name: 'Dr. Hugo Almeida',     id: 1004 },
  { name: 'Dra. Carolina',        id: 1005 },
  { name: 'Dr. Miguel Plácido',   id: 1006 },
  { name: 'Dra. Silvia',          id: 1007 },
];

const CACHED_MOTIVES = [
  { motiveId: 1, motiveName: 'Consulta de Rotina' },
  { motiveId: 2, motiveName: 'Limpeza' },
  { motiveId: 3, motiveName: 'Urgência' },
];

// ── Test scenarios ────────────────────────────────────────────
const SCENARIOS = {

  booking: {
    name: '📅 Book an appointment (known patient)',
    patient: KNOWN_PATIENT,
    patientPersona: `You are a patient calling a dental clinic. Your name is Younes.
You want to book a routine checkup. You are flexible with doctor and time.
Do NOT say "thank you" or "goodbye" until AFTER a slot has been offered to you and you have confirmed it.
If Vicki says she will check slots, wait — your next line should be something like "Sure, I'll wait" or ask what doctor is available.
When Vicki offers you specific times, say "Yes please, that works for me."
Keep responses to 1-2 short sentences.`,
    maxTurns: 8,
    successChecks: ['booking', 'check_slots'],
  },

  emergency: {
    name: '🚨 Dental emergency (unknown caller)',
    patient: UNKNOWN_PATIENT,
    patientPersona: `You are a patient in pain calling a dental clinic urgently.
You have severe toothache that started last night, you can't sleep.
You are anxious and in pain. You want to be seen TODAY.
Keep responses SHORT — 1-2 sentences max.`,
    maxTurns: 6,
    successChecks: ['emergency'],
  },

  info_hours: {
    name: 'ℹ️  Asking clinic hours + pricing (should NOT give price)',
    patient: UNKNOWN_PATIENT,
    patientPersona: `You are a potential new patient calling a dental clinic.
First ask what the clinic opening hours are.
Then ask how much a routine cleaning costs.
Keep responses SHORT — 1 sentence max.`,
    maxTurns: 5,
    successChecks: ['info'],
    mustNotContain: ['€', 'euro', 'cost is', 'price is', 'costs'],
  },

  appointments_cancel: {
    name: '📋 Cancel an existing appointment (known patient)',
    patient: KNOWN_PATIENT,
    patientPersona: `You are a patient who needs to cancel your upcoming appointment.
You have an appointment this week but something came up.
Be polite and brief. Confirm cancellation when offered.`,
    maxTurns: 6,
    successChecks: ['appointments'],
  },

  confused_patient: {
    name: '😕 Confused patient (tests router fallback)',
    patient: KNOWN_PATIENT,
    patientPersona: `You are an elderly confused patient calling the clinic.
Your first message is just "Hello?". Then say "I'm not sure...".
Then slowly clarify you want to know if Dr. Carla is working on Friday.
Be vague and slow to get to the point.`,
    maxTurns: 6,
    successChecks: ['info'],
  },

  reschedule: {
    name: '🔄 Reschedule appointment',
    patient: KNOWN_PATIENT,
    patientPersona: `You are a patient who wants to move your appointment to a different day.
You have an appointment Thursday but want Friday instead.
Be cooperative and confirm when the change is made.`,
    maxTurns: 7,
    successChecks: ['appointments'],
  },

  human_transfer: {
    name: '👤 Wants to speak to a human',
    patient: KNOWN_PATIENT,
    patientPersona: `You are a patient who has a billing dispute.
You say you were charged incorrectly on your last visit.
You insist on speaking to a real person, not a bot.`,
    maxTurns: 4,
    successChecks: ['human'],
  },
};

// ── GPT patient response generator ───────────────────────────
async function getPatientResponse(patientPersona, conversationHistory) {
  // Build a clean conversation history from Vicki's spoken text only
  const messages = [
    { role: 'system', content: patientPersona + '\n\nIMPORTANT: You are the PATIENT only. Reply as yourself, the patient. Do NOT write receptionist lines. Do NOT use ** formatting. Keep it to 1-2 short sentences like a real phone call.' },
    ...conversationHistory
      .filter(m => m.role === 'assistant')
      .map(m => {
        let text = m.content;
        try { text = JSON.parse(m.content).speak || text; } catch {}
        return { role: 'user', content: text }; // Vicki's lines become the "user" from patient's perspective
      }),
  ];

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    max_tokens: 60,
    temperature: 0.7,
  });

  return res.choices[0].message.content.trim();
}

// ── Extract spoken text from history entry ────────────────────
function extractSpeak(entry) {
  if (!entry) return '';
  try {
    const parsed = JSON.parse(entry.content);
    return parsed.speak || entry.content;
  } catch {
    return entry.content || '';
  }
}

// ── Run a single scenario ─────────────────────────────────────
async function runScenario(key, scenario) {
  header(`SCENARIO: ${scenario.name}`);

  let history      = [];
  let currentAgent = 'router';
  let unclearTurns = 0;
  let turnCount    = 0;
  const agentsSeen = new Set();
  const actionsSeen = new Set();
  const warnings   = [];

  // First patient utterance — GPT generates opening line
  let patientText = await getPatientResponse(scenario.patientPersona, []);
  patient(patientText);

  while (turnCount < scenario.maxTurns) {
    turnCount++;

    let result;
    try {
      result = await processTurn({
        history,
        patient:      scenario.patient,
        clinicInfo:   CLINIC_INFO,
        userText:     patientText,
        cachedDoctors: CACHED_DOCTORS,
        cachedMotives: CACHED_MOTIVES,
        currentAgent,
        unclearTurns,
      });
    } catch (err) {
      fail(`processTurn threw: ${err.message}`);
      break;
    }

    history      = result.history;
    currentAgent = result.currentAgent || currentAgent;
    unclearTurns = result.unclearTurns ?? unclearTurns;

    if (result.currentAgent) agentsSeen.add(result.currentAgent);
    // Track both direct actions and internal actions (check_slots etc. return action='none')
    const fired = result.actionFired || result.action;
    if (fired && fired !== 'none') actionsSeen.add(fired);

    info(`[Agent:${currentAgent}] action=${result.actionFired || result.action || 'none'}`);
    vicki(result.speak || '(no response)');

    // Check mustNotContain
    if (scenario.mustNotContain) {
      for (const forbidden of scenario.mustNotContain) {
        if (result.speak?.toLowerCase().includes(forbidden.toLowerCase())) {
          warn(`Response contained forbidden phrase: "${forbidden}"`);
          warnings.push(forbidden);
        }
      }
    }

    // End conditions
    if (result.action === 'transfer_to_human') {
      info('→ Transferred to human. Stopping.');
      break;
    }
    if (result.speak?.toLowerCase().includes('confirm') && turnCount >= 3) {
      // Looks like something was confirmed — let patient respond once more then stop
    }

    // Generate next patient response
    const vickyHistory = result.history;
    patientText = await getPatientResponse(scenario.patientPersona, vickyHistory);
    patient(patientText);

    // Stop if patient signals a REAL goodbye (not just mid-call pleasantries)
    if (/\b(goodbye|bye|see you|that'?s all|take care|hang(ing)? up)\b/i.test(patientText)) {
      info('→ Patient ended the call.');
      break;
    }
  }

  // ── Results ──────────────────────────────────────────────────
  console.log('');
  console.log(`${C.bold}  Results:${C.reset}`);
  info(`Turns taken   : ${turnCount}`);
  info(`Agents visited: ${[...agentsSeen].join(' → ') || 'router only'}`);
  info(`Actions fired : ${[...actionsSeen].join(', ') || 'none'}`);

  let passed = true;

  for (const check of (scenario.successChecks || [])) {
    const agentMatch  = [...agentsSeen].includes(check);
    const actionMatch = [...actionsSeen].includes(check);
    if (agentMatch || actionMatch) {
      pass(`Reached "${check}" (${agentMatch ? 'agent' : 'action'})`);
    } else {
      fail(`Never reached "${check}"`);
      passed = false;
    }
  }

  if (warnings.length > 0) {
    fail(`Spoke forbidden content: ${warnings.join(', ')}`);
    passed = false;
  }

  if (turnCount >= scenario.maxTurns) {
    warn(`Hit max turns (${scenario.maxTurns}) — may not have resolved`);
  }

  return passed;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const args     = process.argv.slice(2);
  const runAll   = args.includes('--all');
  const specific = args.find(a => a.startsWith('--scenario=') || !a.startsWith('--'));
  const scenarioKey = specific?.replace('--scenario=', '');

  console.log(`\n${C.bold}${C.blue}╔══════════════════════════════════════════╗`);
  console.log(`║       VICKI AI — AUTOMATED TESTER       ║`);
  console.log(`╚══════════════════════════════════════════╝${C.reset}`);
  console.log(`  GPT-powered patient simulation\n`);

  const toRun = runAll
    ? Object.keys(SCENARIOS)
    : scenarioKey && SCENARIOS[scenarioKey]
      ? [scenarioKey]
      : Object.keys(SCENARIOS).slice(0, 1); // default: first scenario

  if (!runAll && scenarioKey && !SCENARIOS[scenarioKey]) {
    console.log(`\nUnknown scenario: "${scenarioKey}"`);
    console.log(`Available: ${Object.keys(SCENARIOS).join(', ')}\n`);
    process.exit(1);
  }

  const results = {};
  for (const key of toRun) {
    results[key] = await runScenario(key, SCENARIOS[key]);
    await new Promise(r => setTimeout(r, 500)); // small pause between scenarios
  }

  if (toRun.length > 1) {
    header('FINAL RESULTS');
    let passCount = 0;
    for (const [key, passed] of Object.entries(results)) {
      if (passed) { pass(SCENARIOS[key].name); passCount++; }
      else        { fail(SCENARIOS[key].name); }
    }
    console.log(`\n${C.bold}  Score: ${passCount}/${toRun.length} scenarios passed${C.reset}\n`);
  }
}

main().catch(err => {
  console.error(`\n${C.red}Fatal error:${C.reset}`, err.message);
  process.exit(1);
});
