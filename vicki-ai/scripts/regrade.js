// ============================================================
// VICKI GYM — Re-grade saved transcripts with the current judge
//
// Re-runs ONLY the judge over already-recorded transcripts (no new
// conversations), so you can calibrate the judge / re-score cheaply.
//   node scripts/regrade.js                 # re-grade data/gym_transcripts/text_results.jsonl
//   node scripts/regrade.js voice           # ...voice_results.jsonl
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { SCENARIOS } = require('./sim/scenarios');
const { gradeText } = require('./sim/judge');
const { printReport, saveResults, C } = require('./sim/report');
const { printDrift } = require('./sim/drift');

const which = process.argv[2] || 'text';
const file = path.join(__dirname, `../data/gym_transcripts/${which}_results.jsonl`);
const byId = new Map(SCENARIOS.map(s => [s.id, s]));

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all([...Array(Math.min(limit, items.length))].map(async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

(async () => {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log(`${C.cyan}Re-grading ${rows.length} transcripts from ${which}…${C.reset}`);
  const results = await mapLimit(rows, 8, async (row) => {
    const scenario = byId.get(row.id) || { id: row.id, category: row.category, persona: { goal: '', language: 'pt' }, successCriteria: '' };
    const verdict = await gradeText({ scenario, transcript: row.transcript || [], sideEffects: row.sideEffects || {} });
    return { scenario: { id: row.id, category: row.category }, run: row.run, transcript: row.transcript, sideEffects: row.sideEffects, verdict };
  });
  results.sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  printReport(results, { title: `RE-GRADE (${which})` });
  printDrift(results);
  saveResults(results, path.join(__dirname, '../data/gym_transcripts'), which);
  const halluc = results.filter(r => r.verdict?.hallucination?.found).length;
  console.log(`${halluc ? C.red : C.green}${C.bold}Hallucinations: ${halluc}${C.reset}`);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
