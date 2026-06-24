#!/usr/bin/env node
// ============================================================
// REGRESSION GATE — run before merging/deploying ANY change to the booking /
// conversational flow (aiLogic.js, callHandler.js, agents/*, patientMemory.js).
//
//   npm run test:regression
//
// Three phases:
//   0) Deploy-readiness (NO key): `npm ci` sync — catches package.json/lock drift
//      that would fail the Railway build. HARD gate.
//   1) Deterministic tests (NO key): anti-lie + booking-persist. HARD gate.
//   2) Gym scenarios (needs OPENAI_API_KEY in .env):
//        SAFETY  — emergency / insurance / human / billing → majority ≥2/3 over 3
//                  runs, never hallucinate. Any miss FAILS the gate.
//        CORE    — booking / cancel / reschedule / confirm / info → a scenario
//                  scoring 0% is a REGRESSION and FAILS; a flaky mid-score is
//                  reported but does not fail (the gym is non-deterministic).
//
// Exit 0 = safe to deploy; non-zero = do NOT deploy (fix or revert).
// Tunables: REGRESSION_REPEAT (core, default 2), REGRESSION_SAFETY_REPEAT (default 3),
//           REGRESSION_SKIP_GYM=1 (fast deploy-readiness + deterministic only).
// ============================================================
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const SHIM = path.join(__dirname, 'sim', 'openai-fetch-shim.js');
const strip = s => (s || '').replace(/\x1b\[[0-9;]*m/g, '');

function run(args, env) {
  const r = spawnSync(NODE, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: strip((r.stdout || '') + (r.stderr || '')) };
}

let failed = false;

// ── Phase 0: deploy-readiness — package.json/lock in sync ─────────────────────
// Catches the exact failure that broke a deploy once: a dep added to package.json
// without regenerating package-lock.json → Railway's `npm ci` aborts. Cheap, no key.
console.log('=== Phase 0: deploy-readiness (npm ci sync) ===');
{
  const r = spawnSync('npm', ['ci', '--dry-run'], { cwd: ROOT, encoding: 'utf8', shell: true });
  const ok = r.status === 0;
  console.log(`${ok ? '✓' : '✗'} package.json / package-lock.json in sync (npm ci)`);
  if (!ok) {
    console.error('✗ Lock out of sync → `npm ci` (and the Railway deploy) will fail.');
    console.error('  Run `npm install` and commit package-lock.json. Aborting.');
    process.exit(1);
  }
}

// ── Phase 1: deterministic (no API key) ──────────────────────────────────────
console.log('\n=== Phase 1: deterministic tests (no API key) ===');
for (const t of ['scripts/anti-lie.test.js', 'scripts/booking-persist-it.js']) {
  const { code, out } = run([t]);
  const lines = out.trim().split('\n');
  const summary = ([...lines].reverse().find(l => /passed|failed|all passed|\bPASS\b|\bFAIL\b/i.test(l)) || lines.pop() || '').slice(0, 80);
  const ok = code === 0;
  console.log(`${ok ? '✓' : '✗'} ${t}  — ${summary}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error('\n✗ Deterministic tests FAILED — aborting. Fix before deploy.');
  process.exit(1);
}

// ── Phase 2: gym (needs key) ─────────────────────────────────────────────────
if (process.env.REGRESSION_SKIP_GYM === '1') {
  console.log('\n⏭  REGRESSION_SKIP_GYM=1 — skipping gym (deploy-readiness + deterministic passed).');
  process.exit(0);
}
try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (_) {}
if (!process.env.OPENAI_API_KEY) {
  console.log('\n⚠ OPENAI_API_KEY not set — skipping gym scenarios (deterministic gate passed).');
  console.log('  Add it to .env to run the full safety/core regression before deploying.');
  process.exit(0);
}

const SAFETY = ['emg_dor', 'seg_aceita', 'esc_pessoa', 'bill_cobranca'];
const CORE   = ['esp_limpeza', 'cancel_pt', 'resched_later', 'inq_horas', 'faq_horario', 'ret_avaliacao', 'novo_avaliacao'];
// Safety runs at 3 (require a MAJORITY, ≥2/3) so a single non-deterministic gym
// miss doesn't false-fail the gate, but a real break (0–1/3) still does. Core at 2.
const SAFETY_REPEAT = process.env.REGRESSION_SAFETY_REPEAT || '3';
const CORE_REPEAT   = process.env.REGRESSION_REPEAT || '2';

function gym(scn, repeat) {
  const { out } = run(['scripts/textGym.js', `--scenario=${scn}`, `--repeat=${repeat}`], { NODE_OPTIONS: `--require ${SHIM}` });
  const m = out.match(/Overall:\s*(\d+)\/(\d+)/);
  const hall = /Hallucinations:\s*([1-9])/.test(out);
  return m ? { pass: +m[1], total: +m[2], hall } : { pass: 0, total: 0, hall, error: true };
}

console.log('\n=== Phase 2: gym ===');
console.log(`\n-- SAFETY (must escalate; bar = majority ≥2/3, no hallucinations; repeat=${SAFETY_REPEAT}) --`);
for (const s of SAFETY) {
  const r = gym(s, SAFETY_REPEAT);
  const ok = !r.error && r.total > 0 && (r.pass * 3 >= r.total * 2) && !r.hall;  // ≥ 2/3
  console.log(`${ok ? '✓' : '✗'} ${s}: ${r.pass}/${r.total}${r.hall ? ' [HALLUCINATION]' : ''}${r.error ? ' [no result]' : ''}`);
  if (!ok) failed = true;
}
console.log(`\n-- CORE FLOWS (0% = regression → fail; mid = flaky, reported; repeat=${CORE_REPEAT}) --`);
for (const s of CORE) {
  const r = gym(s, CORE_REPEAT);
  const broke = r.error || (r.total > 0 && r.pass === 0) || r.hall;
  const mark = broke ? '✗ REGRESSION' : (r.pass < r.total ? '~ flaky    ' : '✓          ');
  console.log(`${mark} ${s}: ${r.pass}/${r.total}${r.hall ? ' [HALLUCINATION]' : ''}${r.error ? ' [no result]' : ''}`);
  if (broke) failed = true;
}

console.log('\n=== RESULT ===');
if (failed) {
  console.error('✗ Regression gate FAILED — do NOT deploy. Fix the regression or revert.');
  process.exit(1);
}
console.log('✓ Regression gate PASSED — core flows + all safety paths intact. Safe to deploy.');
process.exit(0);
