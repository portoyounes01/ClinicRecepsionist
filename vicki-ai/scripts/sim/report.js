// ============================================================
// VICKI VOICE GYM — Reporting + regression gate
// ============================================================

const fs = require('fs');
const path = require('path');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', blue: '\x1b[34m',
};

function summarize(results) {
  const total = results.length;
  const passed = results.filter(r => r.verdict?.passed).length;
  const byCat = {};
  for (const r of results) {
    const c = r.scenario.category;
    byCat[c] = byCat[c] || { total: 0, passed: 0 };
    byCat[c].total++;
    if (r.verdict?.passed) byCat[c].passed++;
  }
  return { total, passed, score: total ? Math.round((passed / total) * 100) : 0, byCat };
}

function printReport(results, { title = 'VICKI GYM' } = {}) {
  const s = summarize(results);
  console.log(`\n${C.blue}${C.bold}══ ${title} ══${C.reset}\n`);

  const failed = results.filter(r => !r.verdict?.passed);
  if (failed.length) {
    console.log(`${C.red}${C.bold}FAILURES:${C.reset}`);
    for (const r of failed) {
      const v = r.verdict || {};
      console.log(`  ${C.red}✗ ${r.scenario.id}${C.reset} (${r.scenario.category})`);
      if (v.whatWentWrong) console.log(`     ${C.dim}why:${C.reset} ${v.whatWentWrong}`);
      if (v.whatVickiShouldHaveSaid) console.log(`     ${C.dim}better:${C.reset} ${v.whatVickiShouldHaveSaid}`);
      if (v.hallucination?.found) console.log(`     ${C.red}HALLUCINATION:${C.reset} ${v.hallucination.details}`);
      if (v.priceLeak) console.log(`     ${C.red}PRICE LEAK${C.reset}`);
      if (r.voice?.whatSoundedOff) console.log(`     ${C.dim}voice:${C.reset} ${r.voice.whatSoundedOff}`);
      if (r.timeline?.latencyMs?.p95) console.log(`     ${C.dim}latency p95:${C.reset} ${r.timeline.latencyMs.p95}ms`);
    }
    console.log('');
  }

  console.log(`${C.bold}By category:${C.reset}`);
  for (const [cat, st] of Object.entries(s.byCat)) {
    const icon = st.passed === st.total ? `${C.green}✓` : `${C.yellow}⚠`;
    console.log(`  ${icon}${C.reset} ${cat.padEnd(14)} ${st.passed}/${st.total}`);
  }
  console.log(`\n${C.bold}Overall:${C.reset} ${C.green}${s.passed}${C.reset}/${s.total}  ${C.bold}Score: ${s.score}%${C.reset}\n`);
  return s;
}

function saveResults(results, dir, tag = 'gym') {
  fs.mkdirSync(dir, { recursive: true });
  // strip heavy buffers before serializing
  const slim = results.map(r => ({
    id: r.scenario.id, category: r.scenario.category,
    transcript: r.transcript, verdict: r.verdict, voice: r.voice,
    timeline: r.timeline, sideEffects: r.sideEffects, wav: r.wav,
  }));
  const file = path.join(dir, `${tag}_results.jsonl`);
  fs.writeFileSync(file, slim.map(o => JSON.stringify(o)).join('\n'));
  return file;
}

// Regression gate: fail if score drops below baseline minus tolerance.
function gate(results, baselinePath, tolerance = 0) {
  const s = summarize(results);
  let baseline = null;
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch (_) {}
  if (!baseline) {
    console.log(`${C.yellow}No baseline at ${baselinePath} — writing current score (${s.score}%) as baseline.${C.reset}`);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({ score: s.score, byCat: s.byCat }, null, 2));
    return { pass: true, score: s.score, baseline: s.score };
  }
  const pass = s.score >= baseline.score - tolerance;
  const color = pass ? C.green : C.red;
  console.log(`${color}${C.bold}GATE: ${s.score}% vs baseline ${baseline.score}% → ${pass ? 'PASS' : 'FAIL'}${C.reset}`);
  return { pass, score: s.score, baseline: baseline.score };
}

module.exports = { summarize, printReport, saveResults, gate, C };
