// ============================================================
// VICKI AI — Patient Memory
//
// Persists per-patient preferences and call history across calls.
// Stored in /app/data/patient_memory.json (Railway Volume).
// ============================================================

const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '../data/patient_memory.json');

// ─── Load / Save ──────────────────────────────────────────────────────────────
function loadAll() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (e) { console.error('[Memory] Read error:', e.message); }
  return {};
}

function saveAll(data) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[Memory] Write error:', e.message); }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Load memory for one patient — returns null if first-time caller */
function getPatientMemory(patientId) {
  if (!patientId) return null;
  return loadAll()[String(patientId)] || null;
}

/** Save/update memory after a call ends */
function updateAfterCall(patientId, { patientName, summary, intent, language, preferredDoctor, preferredTime }) {
  if (!patientId) return;
  const all      = loadAll();
  const existing = all[String(patientId)] || { callHistory: [], totalCalls: 0 };

  const record = {
    date:    new Date().toISOString().split('T')[0],
    summary: summary || 'Call completed.',
    intent:  intent  || 'general',
  };

  const history = [record, ...(existing.callHistory || [])].slice(0, 10); // keep last 10 calls

  const updated = {
    ...existing,
    patientName:     patientName || existing.patientName,
    totalCalls:      (existing.totalCalls || 0) + 1,
    lastCallDate:    new Date().toISOString(),
    lastCallSummary: summary,
    callHistory:     history,
  };

  if (language)        updated.language        = language;
  if (preferredDoctor) updated.preferredDoctor = preferredDoctor;  // { id, name }
  if (preferredTime)   updated.preferredTime   = preferredTime;    // 'morning' | 'afternoon'

  all[String(patientId)] = updated;
  saveAll(all);
  console.log(`[Memory] Saved for patient ${patientId} — "${summary?.slice(0, 80)}"`);
}

/**
 * Format patient memory into a prompt-ready block for agent injection.
 * Returns null if no memory exists.
 */
function buildMemoryContext(memory) {
  if (!memory) return null;

  const lines = [];

  if (memory.totalCalls > 0) {
    const daysSince = memory.lastCallDate
      ? Math.floor((Date.now() - new Date(memory.lastCallDate)) / 86400000)
      : null;
    const when = daysSince === 0 ? 'earlier today'
               : daysSince === 1 ? 'yesterday'
               : daysSince != null ? `${daysSince} days ago` : 'before';
    lines.push(`• This patient has called ${memory.totalCalls} time(s). Last call: ${when}.`);
  }

  if (memory.language) {
    const langLabel = memory.language === 'pt' ? 'European Portuguese (PT-PT)' : 'English';
    lines.push(`• Known language: ${langLabel} — use this immediately, no need to detect.`);
  }

  if (memory.preferredDoctor) {
    lines.push(`• Preferred doctor: ${memory.preferredDoctor.name} (ID: ${memory.preferredDoctor.id}) — proactively suggest this doctor first.`);
  }

  if (memory.preferredTime) {
    lines.push(`• Preferred time of day: ${memory.preferredTime} — prioritise this when offering slots.`);
  }

  if (memory.lastCallSummary) {
    lines.push(`• Last call summary: ${memory.lastCallSummary}`);
  }

  // Show up to 2 older calls
  const older = (memory.callHistory || []).slice(1, 3);
  older.forEach(c => {
    if (c.summary) lines.push(`• Earlier (${c.date}): ${c.summary}`);
  });

  return lines.length ? lines.join('\n') : null;
}

module.exports = { getPatientMemory, updateAfterCall, buildMemoryContext };
