// ============================================================
// VICKI AI — Improvement Agent
//
// Runs nightly at 2am. Reads call_log.jsonl, finds patterns,
// sends improvement suggestions to Telegram for approval.
// Cost: ~$0.02/night (gpt-4o-mini on compressed logs)
// ============================================================

const OpenAI = require('openai').default;
const fs     = require('fs');
const path   = require('path');

const DATA_DIR      = path.join(__dirname, '../data');
const LOG_FILE      = path.join(DATA_DIR, 'call_log.jsonl');
const LAST_RUN_FILE = path.join(DATA_DIR, 'agent_last_run.json');
const PENDING_FILE  = path.join(DATA_DIR, 'pending_approvals.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getLastRun() {
  try {
    if (fs.existsSync(LAST_RUN_FILE)) return JSON.parse(fs.readFileSync(LAST_RUN_FILE, 'utf8'));
  } catch (e) {}
  return { lastRun: null };
}

function saveLastRun() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LAST_RUN_FILE, JSON.stringify({ lastRun: new Date().toISOString() }));
}

function loadNewLogs(since) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(l => l && (!since || new Date(l.ts) > new Date(since)));
}

// ─── Main analysis ────────────────────────────────────────────────────────────
async function runAnalysis(isScheduled = true) {
  const { notify, sendApprovalRequest } = require('./telegramBot');

  console.log('[Agent] Starting improvement analysis...');

  const { lastRun } = getLastRun();
  const logs = loadNewLogs(lastRun);

  if (!logs.length) {
    if (!isScheduled) notify('📊 No new calls to analyse since the last run.');
    console.log('[Agent] No new logs — nothing to analyse');
    return;
  }

  const total       = logs.length;
  const booked      = logs.filter(l => l.outcome === 'booked').length;
  const transferred = logs.filter(l => l.transferredToHuman).length;
  const confused    = logs.filter(l => l.flags?.includes('patient_confused')).length;
  const noSlots     = logs.filter(l => l.flags?.includes('no_slots_found')).length;
  const abandoned   = logs.filter(l => l.outcome === 'abandoned').length;

  // Compact log summary (saves tokens)
  const logSummary = logs.map(l =>
    `[${l.date}] outcome=${l.outcome} intent=${l.intent} unclear=${l.unclearTurns} ` +
    `flags=[${(l.flags || []).join(',')}] summary="${l.summary}"`
  ).join('\n');

  try {
    const res = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0,
      max_tokens:  700,
      messages: [
        {
          role:    'system',
          content:
            `You analyse call logs for Vicki, an AI voice receptionist at a dental clinic (Portugal).\n` +
            `Find the TOP 1-2 most impactful, safe improvements. Be very specific.\n\n` +
            `The system prompt files are in src/agents/ (routerAgent.js, bookingAgent.js, infoAgent.js, appointmentsAgent.js).\n` +
            `Only suggest text/phrase changes — never logic or code structure changes.\n\n` +
            `Reply ONLY with valid JSON:\n` +
            `{\n` +
            `  "summary": "1-2 sentence overview of the period",\n` +
            `  "suggestions": [\n` +
            `    {\n` +
            `      "id": "fix_<timestamp>_1",\n` +
            `      "problem": "specific problem observed",\n` +
            `      "description": "exact change to make",\n` +
            `      "filePath": "src/agents/bookingAgent.js",\n` +
            `      "oldContent": "exact current text in the file",\n` +
            `      "newContent": "exact replacement text",\n` +
            `      "risk": "Low",\n` +
            `      "expectedImpact": "what will improve"\n` +
            `    }\n` +
            `  ]\n` +
            `}`,
        },
        {
          role:    'user',
          content: `${total} calls since last analysis:\n\n${logSummary}`,
        },
      ],
    });

    const raw      = res.choices[0].message.content.trim();
    const analysis = JSON.parse(raw);
    const ts       = Date.now();

    // Add unique IDs with timestamp
    if (analysis.suggestions) {
      analysis.suggestions = analysis.suggestions.map((s, i) => ({
        ...s,
        id: `fix_${ts}_${i + 1}`,
      }));
    }

    // 1. Send nightly report to Telegram
    notify(
      `🌙 *Vicki Nightly Report*\n\n` +
      `📞 *${total}* new calls analysed\n` +
      `✅ Booked: *${booked}* | 👤 Transferred: *${transferred}*\n` +
      `😕 Confused: *${confused}* | 🚫 No slots: *${noSlots}* | 📴 Abandoned: *${abandoned}*\n\n` +
      `📝 ${analysis.summary}`
    );

    // 2. Send each suggestion for approval (with 1s delay between them)
    if (analysis.suggestions?.length) {
      const chatId = process.env.TELEGRAM_CHAT_ID;
      analysis.suggestions.forEach((s, i) => {
        setTimeout(() => sendApprovalRequest(chatId, s), (i + 1) * 1500);
      });

      // Save to pending approvals
      let existing = [];
      try { existing = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch {}
      fs.writeFileSync(PENDING_FILE, JSON.stringify([...existing, ...analysis.suggestions], null, 2));
    } else {
      setTimeout(() => notify('✅ No issues found — Vicki is performing well!'), 1500);
    }

    saveLastRun();
    console.log(`[Agent] Analysis complete — ${analysis.suggestions?.length || 0} suggestion(s) sent`);

  } catch (e) {
    console.error('[Agent] Analysis error:', e.message);
    const { notify: tgNotify } = require('./telegramBot');
    tgNotify(`❌ Nightly analysis failed: ${e.message}`);
  }
}

// ─── Schedule nightly at 2am ──────────────────────────────────────────────────
function scheduleNightly() {
  function msUntil2am() {
    const now    = new Date();
    const next2am = new Date(now);
    next2am.setHours(2, 0, 0, 0);
    if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
    return next2am - now;
  }

  const ms = msUntil2am();
  const hours = Math.round(ms / 3600000);
  console.log(`[Agent] Nightly analysis scheduled — first run in ${hours}h (2am)`);

  setTimeout(() => {
    runAnalysis(true);
    // Repeat every 24h
    setInterval(() => runAnalysis(true), 24 * 60 * 60 * 1000);
  }, ms);
}

module.exports = { runAnalysis, scheduleNightly };
