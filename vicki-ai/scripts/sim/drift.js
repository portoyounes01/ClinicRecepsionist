// ============================================================
// VICKI VOICE GYM — Drift / consistency report
//
// Given results from running each scenario N times, flags scenarios that
// "drift": the outcome changes between runs, or any run hallucinates or
// goes off-workflow. Stable behaviour = same outcome every time, no
// hallucination, on-workflow.
// ============================================================

const { C } = require('./report');

function driftReport(results) {
  const byId = {};
  for (const r of results) {
    const sid = r.scenario.id;
    (byId[sid] = byId[sid] || []).push(r);
  }
  const groups = Object.entries(byId).map(([sid, runs]) => {
    const outcomes = [...new Set(runs.map(r => r.verdict?.outcome || 'unknown'))];
    const hallucinated = runs.some(r => r.verdict?.hallucination?.found);
    const offWorkflow = runs.some(r => r.verdict?.offWorkflow);
    const passes = runs.filter(r => r.verdict?.passed).length;
    const stable = outcomes.length === 1 && !hallucinated && !offWorkflow && passes === runs.length;
    return { id: sid, category: runs[0].scenario.category, runs: runs.length, outcomes, hallucinated, offWorkflow, passes, stable };
  });
  const unstable = groups.filter(g => !g.stable);
  return { groups, unstable, total: groups.length, stableCount: groups.length - unstable.length };
}

function printDrift(results) {
  const { groups, unstable, total, stableCount } = driftReport(results);
  if (groups.every(g => g.runs < 2)) return; // nothing repeated → no drift to show
  console.log(`\n${C.blue}${C.bold}══ DRIFT / CONSISTENCY ══${C.reset}\n`);
  if (unstable.length) {
    console.log(`${C.yellow}${C.bold}UNSTABLE (drifted):${C.reset}`);
    for (const g of unstable) {
      const why = [
        g.outcomes.length > 1 ? `outcomes vary [${g.outcomes.join(', ')}]` : null,
        g.hallucinated ? 'HALLUCINATED in a run' : null,
        g.offWorkflow ? 'off-workflow in a run' : null,
        g.passes < g.runs ? `${g.passes}/${g.runs} passed` : null,
      ].filter(Boolean).join('; ');
      console.log(`  ${C.yellow}~ ${g.id}${C.reset} (${g.category}) — ${why}`);
    }
    console.log('');
  }
  console.log(`${C.bold}Stable:${C.reset} ${C.green}${stableCount}${C.reset}/${total}  ` +
    `${C.bold}Drifted:${C.reset} ${unstable.length ? C.yellow : C.green}${unstable.length}${C.reset}\n`);
  return { total, stableCount, unstable: unstable.length };
}

module.exports = { driftReport, printDrift };
