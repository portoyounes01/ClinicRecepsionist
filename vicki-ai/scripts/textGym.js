// ============================================================
// VICKI TEXT GYM — fast, in-process multi-turn regression
//
// Runs the scenario library as text conversations (persona LLM <-> the real
// processTurn brain) with Newsoft/SMS mocked in-process. No audio → cheap +
// fast, ideal for the improvement loop + the regression gate. Parallelized
// via child-process shards (the dry-run provider is a module singleton, so
// each shard runs in its own process).
//
//   node scripts/textGym.js                                    all, sequential
//   node scripts/textGym.js --repeat=3 --shards=8             100x3 in minutes
//   node scripts/textGym.js --category=adversarial
//   node scripts/textGym.js --scenario=esp_canal
//   node scripts/textGym.js --gate --baseline=data/gym_baseline_text.json
// ============================================================

require('dotenv').config();
process.env.VICKI_DRY_RUN = process.env.VICKI_DRY_RUN || '1';
// Weekday mid-morning so clinic-open behaviour is tested deterministically.
process.env.VICKI_FAKE_NOW = process.env.VICKI_FAKE_NOW || '2026-06-08T10:00:00';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getScenarios } = require('./sim/scenarios');
const { printReport, saveResults, gate, C } = require('./sim/report');
const { printDrift } = require('./sim/drift');

const args = process.argv.slice(2);
const getArg = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const hasFlag = (k) => args.includes(`--${k}`);

const REPEAT = parseInt(getArg('repeat', '1'));
const SHARDS = parseInt(getArg('shards', '1'));
const SHARD_INDEX = getArg('shard-index');   // present → child/worker mode
const TMP_DIR = path.join(__dirname, '../data/gym_transcripts');

const CLINIC_INFO = { name: 'Instituto Vilas Boas', location: 'Loulé', address: 'Loulé', phone: '+351289060010', hours: 'Monday to Friday 9am–7pm' };

function buildWork() {
  const scenarios = getScenarios({ category: getArg('category'), id: getArg('scenario') });
  const work = [];
  for (const s of scenarios) for (let r = 0; r < REPEAT; r++) work.push({ scenario: s, run: r });
  return work;
}

// ── worker: run a slice in-process ──────────────────────────────────────────
async function runWorker() {
  const { processTurn } = require('../src/aiLogic');
  const newsoft = require('../src/newsoftApi');
  const { makeProvider } = require('./sim/newsoftFixtures');
  const persona = require('./sim/persona');
  const { gradeText } = require('./sim/judge');

  const MAX_TURNS = parseInt(getArg('maxTurns', '12'));
  const shardIdx = SHARD_INDEX !== undefined ? parseInt(SHARD_INDEX) : 0;
  const work = buildWork().filter((_, i) => SHARDS <= 1 || i % SHARDS === shardIdx);

  const applyState = (st, r) => {
    if (r.history !== undefined) st.history = r.history;
    if (r.languageState !== undefined) st.languageState = r.languageState;
    if (r.currentAgent !== undefined) st.currentAgent = r.currentAgent;
    if (r.unclearTurns !== undefined) st.unclearTurns = r.unclearTurns;
    if (r.pendingSlots && r.pendingSlots.length) st.pendingSlots = r.pendingSlots;
    if (r.pendingAppts !== undefined) st.pendingAppts = r.pendingAppts;
    if (r.lastOfferedDate !== undefined) st.lastOfferedDate = r.lastOfferedDate;
    if (r.bookingReasonText !== undefined) st.bookingReasonText = r.bookingReasonText;
    if (r.rebookContext !== undefined) st.rebookContext = r.rebookContext;
    if (r.returnToAgent) { st.returnToAgent = r.returnToAgent; st.returnContext = r.returnContext || {}; }
    if (r.clearReturn) { st.returnToAgent = null; st.returnContext = {}; }
    if (r.patient?.patientId) st.patient = r.patient;
  };

  async function runScenario(scenario) {
    const provider = makeProvider(scenario.fixture || {});
    newsoft.__setDryRunProvider(provider);
    const patient = await provider.getPatientByPhone(scenario.callerNumber);
    const cachedDoctors = await provider.getDoctors();
    const cachedMotives = await provider.getMotives();
    const st = { history: [], currentAgent: 'router', unclearTurns: 0, pendingSlots: [], pendingAppts: [], lastOfferedDate: null, bookingReasonText: null, rebookContext: null, returnToAgent: null, returnContext: {}, languageState: 'unknown', patient: patient || null };
    const transcript = [];
    const brain = (userText) => processTurn({ history: st.history, patient: st.patient, clinicInfo: CLINIC_INFO, userText, cachedDoctors, cachedMotives, currentAgent: st.currentAgent, unclearTurns: st.unclearTurns, onSpeakReady: null, pendingSlots: st.pendingSlots, pendingAppts: st.pendingAppts, patientMemory: null, lastOfferedDate: st.lastOfferedDate, bookingReasonText: st.bookingReasonText, rebookContext: st.rebookContext, callerNumber: scenario.callerNumber, returnToAgent: st.returnToAgent, returnContext: st.returnContext, languageState: st.languageState });

    for (let t = 0; t < MAX_TURNS; t++) {
      const { text, done } = await persona.nextPatientUtterance(scenario.persona, transcript);
      if (text) transcript.push({ role: 'patient', text });
      if (!text && done) break;
      let result = await brain(text || '[continua]');
      applyState(st, result);
      if (result.speak) transcript.push({ role: 'vicki', text: result.speak });
      let guard = 0;
      while (result.autoSpeak && guard++ < 3) { result = await brain('[continua]'); applyState(st, result); if (result.speak) transcript.push({ role: 'vicki', text: result.speak }); }
      if (result.action === 'transfer_to_human' || result.action === 'hangup') break;
      if (done) break;
    }
    return { scenario, transcript, sideEffects: provider.__sideEffects };
  }

  const results = [];
  for (const item of work) {
    try {
      const run = await runScenario(item.scenario);
      const verdict = await gradeText(run);
      results.push({ scenario: { id: item.scenario.id, category: item.scenario.category }, run: item.run, transcript: run.transcript, sideEffects: run.sideEffects, verdict });
      if (SHARDS <= 1) console.log(`  ${verdict.passed ? C.green + '✓' : C.red + '✗'}${C.reset} ${item.scenario.id}${verdict.hallucination?.found ? ` ${C.red}[HALLUC]${C.reset}` : ''}`);
    } catch (e) {
      results.push({ scenario: { id: item.scenario.id, category: item.scenario.category }, run: item.run, transcript: [], verdict: { passed: false, whatWentWrong: e.message } });
    }
  }

  if (SHARD_INDEX !== undefined) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(TMP_DIR, `_text_shard_${shardIdx}.jsonl`), results.map(o => JSON.stringify(o)).join('\n'));
  }
  return results;
}

// ── parent: spawn shards, merge ─────────────────────────────────────────────
function spawnShard(i) {
  return new Promise((resolve, reject) => {
    const childArgs = ['scripts/textGym.js', `--shard-index=${i}`, `--shards=${SHARDS}`, `--repeat=${REPEAT}`];
    if (getArg('category')) childArgs.push(`--category=${getArg('category')}`);
    if (getArg('scenario')) childArgs.push(`--scenario=${getArg('scenario')}`);
    const child = spawn(process.execPath, childArgs, { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`shard ${i} exited ${code}`)));
  });
}

async function main() {
  // worker mode
  if (SHARD_INDEX !== undefined) { await runWorker(); return; }

  const work = buildWork();
  console.log(`${C.cyan}Text gym: ${work.length} run(s)${SHARDS > 1 ? ` across ${SHARDS} shards` : ''}${C.reset}`);

  let results;
  if (SHARDS > 1) {
    await Promise.all([...Array(SHARDS).keys()].map(spawnShard));
    results = [];
    for (let i = 0; i < SHARDS; i++) {
      const f = path.join(TMP_DIR, `_text_shard_${i}.jsonl`);
      try { results.push(...fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))); fs.unlinkSync(f); } catch (_) {}
    }
  } else {
    results = await runWorker();
  }

  results.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  printReport(results, { title: `TEXT GYM (${results.length} runs)` });
  printDrift(results);
  console.log(`${C.dim}results: ${saveResults(results, TMP_DIR, 'text')}${C.reset}`);
  const halluc = results.filter(r => r.verdict?.hallucination?.found).length;
  console.log(`${halluc ? C.red : C.green}${C.bold}Hallucinations: ${halluc}${C.reset}`);

  if (hasFlag('gate')) {
    const g = gate(results, path.join(__dirname, '..', getArg('baseline', 'data/gym_baseline_text.json')), parseInt(getArg('tolerance', '0')));
    process.exit(g.pass && halluc === 0 ? 0 : 1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
