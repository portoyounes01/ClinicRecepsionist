// ============================================================
// VICKI AI — Patient Memory + Call Log
//
// PHILOSOPHY:
//   • Store ONLY facts the patient explicitly stated — never infer
//   • Memory is for WARMTH only — never to pre-fill booking details
//   • Every call gets logged for weekly human review and improvement
//
// Files (Railway Volume /app/data/):
//   patient_memory.json  — per-patient verified facts
//   call_log.jsonl       — append-only outcome log (1 line per call)
// ============================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../data');
const MEMORY_FILE = path.join(DATA_DIR, 'patient_memory.json');
const LOG_FILE    = path.join(DATA_DIR, 'call_log.jsonl');

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (e) { console.error('[Memory] Read error:', e.message); }
  return {};
}

function saveAll(data) {
  try {
    ensureDir();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[Memory] Write error:', e.message); }
}

// ─── Patient Memory ───────────────────────────────────────────────────────────

/** Load memory for one patient — null if first-time caller */
function getPatientMemory(patientId) {
  if (!patientId) return null;
  return loadAll()[String(patientId)] || null;
}

/**
 * Save memory after a call ends.
 *
 * RULES — only update a preference field if the patient EXPLICITLY stated it.
 * Pass null for fields that were not explicitly stated — they will NOT overwrite.
 *
 * @param {string|number} patientId
 * @param {object} data
 * @param {string}  data.patientName
 * @param {string}  data.summary          - 1-sentence factual summary of the call
 * @param {string}  data.intent           - booking | appointments | info | emergency | general
 * @param {string|null} data.language     - 'en' | 'pt' — only if clearly established
 * @param {object|null} data.explicitDoctorPreference  - { id, name } ONLY if patient said "I prefer..."
 * @param {string|null} data.explicitTimePreference    - 'morning'|'afternoon' ONLY if patient said so
 */
function sanitizeSummary(summary) {
  if (!summary) return 'Chamada concluída.';
  // NEVER store doctor names, specific times, or appointment dates in memory.
  // These facts must ALWAYS come from the API — never from AI memory.
  // Keeping them causes hallucinations in future calls.
  return summary
    // Remove "com Dr(ª) X" patterns
    .replace(/\bcom\s+a?\s*Dr[aª]?\.?\s+\w+/gi, '')
    // Remove time references like "às 14h", "às 14:00", "às 11h30"
    .replace(/\bàs?\s+\d{1,2}[h:]\d{0,2}/gi, '')
    // Remove date references like "dia 12 de junho", "segunda-feira dia 5"
    .replace(/\b(dia\s+\d{1,2}(\s+de\s+\w+)?|\w+-feira(\s+dia\s+\d{1,2})?)/gi, '')
    // Remove appointment ID references
    .replace(/\bID\s*[:=]?\s*\d+/gi, '')
    // Remove specific slot/date info
    .replace(/\b(manhã|tarde)\s+de\s+\w+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Chamada concluída.';
}

function updateAfterCall(patientId, {
  patientName,
  summary,
  intent,
  language,
  explicitDoctorPreference,
  explicitTimePreference,
}) {
  if (!patientId) return;
  const all      = loadAll();
  const existing = all[String(patientId)] || { callHistory: [], totalCalls: 0 };

  // Sanitize before storing — never keep appointment specifics
  const cleanSummary = sanitizeSummary(summary);

  const record = {
    date:    new Date().toISOString().split('T')[0],
    summary: cleanSummary,
    intent:  intent  || 'general',
  };

  const history = [record, ...(existing.callHistory || [])].slice(0, 10);

  const updated = {
    ...existing,
    patientName:     patientName || existing.patientName,
    totalCalls:      (existing.totalCalls || 0) + 1,
    lastCallDate:    new Date().toISOString(),
    lastCallSummary: cleanSummary,
    callHistory:     history,
  };

  // Language: update only if clearly established this call
  if (language) updated.language = language;

  // Preferences: ONLY update if patient EXPLICITLY stated them this call
  if (explicitDoctorPreference) updated.explicitDoctorPreference = explicitDoctorPreference;
  if (explicitTimePreference)   updated.explicitTimePreference   = explicitTimePreference;

  all[String(patientId)] = updated;
  saveAll(all);
  console.log(`[Memory] Saved patient ${patientId} — "${cleanSummary?.slice(0, 80)}"`);
}

/**
 * Build a warmth-only memory block for agent prompts.
 *
 * ⚠️  This context is for making the patient feel REMEMBERED — not for
 *     pre-filling booking details or skipping questions.
 */
function buildMemoryContext(memory) {
  if (!memory) return null;

  const lines = [];
  lines.push(`⚠️  USE THIS FOR WARMTH ONLY — never pre-fill or assume what the patient wants today. Always ask.`);

  if (memory.totalCalls > 0) {
    const daysSince = memory.lastCallDate
      ? Math.floor((Date.now() - new Date(memory.lastCallDate)) / 86400000)
      : null;
    const when = daysSince === 0 ? 'earlier today'
               : daysSince === 1 ? 'yesterday'
               : daysSince != null ? `${daysSince} days ago` : 'previously';
    lines.push(`• Returning patient — ${memory.totalCalls} previous call(s). Last call: ${when}.`);
  }

  if (memory.language) {
    const label = memory.language === 'pt' ? 'European Portuguese (PT-PT)' : 'English';
    lines.push(`• Established language: ${label}.`);
  }

  if (memory.lastCallSummary) {
    lines.push(`• Last call: ${memory.lastCallSummary}`);
  }

  // Show explicitly stated preferences (patient said them — safe to mention)
  if (memory.explicitDoctorPreference) {
    lines.push(`• Patient explicitly said they prefer ${memory.explicitDoctorPreference.name} — you may mention this warmly as a question: "Would you like to go with ${memory.explicitDoctorPreference.name} again?"`);
  }
  if (memory.explicitTimePreference) {
    lines.push(`• Patient explicitly said they prefer ${memory.explicitTimePreference} appointments — you may ask "Still prefer the ${memory.explicitTimePreference}?"`);
  }

  // Older call history (up to 2 more)
  const older = (memory.callHistory || []).slice(1, 3);
  older.forEach(c => {
    if (c.summary) lines.push(`• Earlier (${c.date}): ${c.summary}`);
  });

  return lines.join('\n');
}

// ─── Call Outcome Log ─────────────────────────────────────────────────────────

/**
 * Append one call outcome to the JSONL log file.
 * Used for weekly review — spot patterns, fix prompts.
 *
 * @param {object} entry
 */
function logCallOutcome(entry) {
  try {
    ensureDir();
    const line = JSON.stringify({
      ts:              new Date().toISOString(),
      date:            new Date().toISOString().split('T')[0],
      patientId:       entry.patientId    || null,
      patientName:     entry.patientName  || 'Unknown',
      callerNumber:    entry.callerNumber || null,
      outcome:         entry.outcome,       // 'booked' | 'cancelled' | 'info' | 'transferred' | 'abandoned'
      intent:          entry.intent        || 'general',
      transferredToHuman: entry.transferredToHuman || false,
      unclearTurns:    entry.unclearTurns  || 0,
      durationSeconds: entry.durationSeconds || null,
      summary:         entry.summary       || null,
      flags:           entry.flags         || [],  // e.g. ['no_slots_found', 'barge_in_heavy']
    }) + '\n';
    fs.appendFileSync(LOG_FILE, line);
    console.log(`[Log] Call outcome recorded: ${entry.outcome}`);
  } catch (e) {
    console.error('[Log] Write error:', e.message);
  }
}

module.exports = { getPatientMemory, updateAfterCall, buildMemoryContext, logCallOutcome };
