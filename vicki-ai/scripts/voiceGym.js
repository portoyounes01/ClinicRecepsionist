// ============================================================
// VICKI VOICE GYM — parallel voice-to-voice stress suite
//
// Synthetic patients (real TTS voices, ~70% European Portuguese) hold full
// voice calls with a POOL of local dry-run Vickis — K calls at once. Every
// call is recorded to a stereo WAV; transcripts + outcomes are graded; a
// drift report flags scenarios whose outcome changes across repeats. No
// phone, no real bookings (mocked).
//
// Usage:
//   node scripts/voiceGym.js                                  all scenarios, 10 concurrent
//   node scripts/voiceGym.js --concurrency=10 --repeat=3      300 calls (100x3) across 10 servers
//   node scripts/voiceGym.js --category=specialty
//   node scripts/voiceGym.js --scenario=esp_canal
//   node scripts/voiceGym.js --live-sample=1                  play 1 random call on your speakers
//   node scripts/voiceGym.js --voice-judge                    also run the audio tone judge on all
//   node scripts/voiceGym.js --gate --baseline=data/gym_baseline_voice.json
// ============================================================

require('dotenv').config();

const path = require('path');
const { ServerPool } = require('./sim/serverPool');
const { runConversation } = require('./sim/runConversation');
const { gradeText } = require('./sim/judge');
const { gradeVoice } = require('./sim/voiceJudge');
const { getScenarios } = require('./sim/scenarios');
const { printReport, saveResults, gate, C } = require('./sim/report');
const { printDrift } = require('./sim/drift');

const args = process.argv.slice(2);
const getArg = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const hasFlag = (k) => args.includes(`--${k}`);

const CONCURRENCY = parseInt(getArg('concurrency', '10'));
const REPEAT      = parseInt(getArg('repeat', '1'));
const BASE_PORT   = parseInt(getArg('base-port', '3100'));
const VOICE_JUDGE_ALL = hasFlag('voice-judge');
let LIVE_SAMPLE   = parseInt(getArg('live-sample', hasFlag('live') ? '1' : '0'));

function shuffleIdx(n) { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = ((i * 2654435761) % (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function main() {
  if (!process.env.OPENAI_API_KEY || !process.env.ELEVENLABS_API_KEY) {
    console.error(`${C.red}OPENAI_API_KEY and ELEVENLABS_API_KEY are required.${C.reset}`); process.exit(1);
  }

  const scenarios = getScenarios({ category: getArg('category'), id: getArg('scenario') });
  // work-list: scenario × repeat
  const work = [];
  for (const s of scenarios) for (let r = 0; r < REPEAT; r++) work.push({ scenario: s, run: r });
  if (LIVE_SAMPLE > work.length) LIVE_SAMPLE = work.length;
  // Live samples prefer European Portuguese (the clinic's main language) so you
  // hear pt-PT calls; fall back to any language if not enough pt items.
  const order = shuffleIdx(work.length)
    .sort((a, b) => (work[a].scenario.persona.language === 'pt' ? 0 : 1) - (work[b].scenario.persona.language === 'pt' ? 0 : 1));
  const liveSet = new Set(order.slice(0, LIVE_SAMPLE));
  work.forEach((w, i) => { w.live = liveSet.has(i); });

  const poolSize = Math.min(CONCURRENCY, work.length);
  console.log(`${C.cyan}Voice gym: ${scenarios.length} scenario(s) × ${REPEAT} = ${work.length} call(s), ${poolSize} concurrent${LIVE_SAMPLE ? `, ${LIVE_SAMPLE} live` : ''}${C.reset}`);

  const pool = new ServerPool({ size: poolSize, basePort: BASE_PORT });
  console.log(`${C.dim}Starting ${poolSize} dry-run servers…${C.reset}`);
  await pool.start();
  console.log(`${C.green}Pool ready.${C.reset}`);

  const callsDir = path.join(__dirname, '../data/gym_calls');
  const results = [];
  let done = 0;

  const runOne = async (item) => {
    const sc = item.scenario;
    const label = REPEAT > 1 ? `${sc.id}#${item.run + 1}` : sc.id;
    try {
      const out = await pool.withServer((srv) =>
        runConversation(sc, { baseUrl: srv.baseUrl, wsUrl: srv.wsUrl, live: item.live }));
      const wav = path.join(callsDir, `${label}.wav`);
      out.recorder.writeWav(wav);
      const verdict = await gradeText(out);
      let voice = null;
      if (VOICE_JUDGE_ALL || item.live) voice = await gradeVoice({ vickiPcm16: out.vickiPcm16 });
      results.push({ scenario: sc, run: item.run, transcript: out.transcript, sideEffects: out.sideEffects, timeline: out.timeline, verdict, voice, wav });
      done++;
      const ic = verdict.passed ? `${C.green}✓` : `${C.red}✗`;
      console.log(`  ${ic}${C.reset} ${String(done).padStart(3)}/${work.length} ${label}${verdict.hallucination?.found ? ` ${C.red}[HALLUC]${C.reset}` : ''}`);
    } catch (e) {
      results.push({ scenario: sc, run: item.run, transcript: [], verdict: { passed: false, whatWentWrong: e.message } });
      done++;
      console.log(`  ${C.red}✗ ${done}/${work.length} ${label} ERROR ${e.message}${C.reset}`);
    }
  };

  // Live samples first (sequential, so audio never overlaps), then headless concurrently.
  const liveItems = work.filter(w => w.live);
  const headless = work.filter(w => !w.live);
  for (const it of liveItems) await runOne(it);
  await Promise.all(headless.map(runOne)); // acquire() bounds concurrency to pool size

  await pool.stop();

  results.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  printReport(results, { title: `VOICE GYM (${work.length} calls)` });
  printDrift(results);
  const outDir = path.join(__dirname, '../data/gym_transcripts');
  console.log(`${C.dim}results: ${saveResults(results, outDir, 'voice')}${C.reset}`);
  console.log(`${C.dim}recordings: ${path.relative(process.cwd(), callsDir)}/${C.reset}`);

  const halluc = results.filter(r => r.verdict?.hallucination?.found).length;
  console.log(`${halluc ? C.red : C.green}${C.bold}Hallucinations: ${halluc}${C.reset}`);

  if (hasFlag('gate')) {
    const g = gate(results, path.join(__dirname, '..', getArg('baseline', 'data/gym_baseline_voice.json')), parseInt(getArg('tolerance', '0')));
    process.exit(g.pass && halluc === 0 ? 0 : 1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
