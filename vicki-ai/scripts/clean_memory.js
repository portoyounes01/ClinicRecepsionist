const fs = require('fs');
const path = require('path');
const DATA_DIR = '/app/data';
const MEMORY_FILE = path.join(DATA_DIR, 'patient_memory.json');
const LOG_FILE = path.join(DATA_DIR, 'call_log.jsonl');

// Read and show memory
try {
  const mem = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  console.log('=== PATIENT MEMORY ===');
  console.log(JSON.stringify(mem, null, 2));

  // Clean: remove any mention of appointment times/doctors from summaries
  // These are facts that must come from API only
  let changed = false;
  for (const [id, data] of Object.entries(mem)) {
    if (data.lastCallSummary && /nadine|14h|14:00|silvia|11h|11:30|marcou.*consulta.*com/i.test(data.lastCallSummary)) {
      console.log(`\nCLEANING patient ${id} summary: "${data.lastCallSummary}"`);
      // Keep the intent but remove specific doctor/time claims
      data.lastCallSummary = data.lastCallSummary
        .replace(/com\s+a?\s*Dr[aª]?\s*\w+/gi, '')
        .replace(/às?\s+\d+h\d*/gi, '')
        .replace(/dia\s+\d+\s+de\s+\w+/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (data.callHistory) {
        data.callHistory = data.callHistory.map(c => ({
          ...c,
          summary: c.summary
            ?.replace(/com\s+a?\s*Dr[aª]?\s*\w+/gi, '')
            ?.replace(/às?\s+\d+h\d*/gi, '')
            ?.replace(/dia\s+\d+\s+de\s+\w+/gi, '')
            ?.replace(/\s{2,}/g, ' ')
            ?.trim()
        }));
      }
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
    console.log('\n✅ Memory cleaned and saved.');
    console.log('=== CLEANED MEMORY ===');
    console.log(JSON.stringify(mem, null, 2));
  } else {
    console.log('\n✅ Memory is clean — no fake appointment data found.');
  }
} catch (e) {
  console.log('Memory file not found or error:', e.message);
}

// Show call log
try {
  const log = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-10);
  console.log('\n=== LAST 10 CALL LOGS ===');
  log.forEach(l => { try { console.log(JSON.stringify(JSON.parse(l), null, 1)); } catch(_){} });
} catch (e) {
  console.log('Call log:', e.message);
}
