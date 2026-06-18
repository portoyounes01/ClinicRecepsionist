// ============================================================
// VICKI AI — Telegram Bot (Manager Control Panel)
//
// Features:
//  • /start /status /report /pending commands
//  • Free-text — GPT understands EVERYTHING you write
//  • Inline ✅/❌ buttons for approvals
//  • Auto-applies fixes + git push → Railway redeploys
// ============================================================

const TelegramBot = require('node-telegram-bot-api');
const OpenAI      = require('openai').default;
const fs          = require('fs');
const path        = require('path');
const { execSync } = require('child_process');

const DATA_DIR    = path.join(__dirname, '../data');
const PENDING_FILE = path.join(DATA_DIR, 'pending_approvals.json');
const LOG_FILE     = path.join(DATA_DIR, 'call_log.jsonl');
const ALLOWLIST_FILE = path.join(DATA_DIR, 'telegram_allowlist.json');
const ROOT_DIR     = path.join(__dirname, '../..');

// Secret join code: anyone who sends /start<JOIN_SECRET> is added to the allowlist.
// Override in Railway via TELEGRAM_JOIN_SECRET.
const JOIN_SECRET = process.env.TELEGRAM_JOIN_SECRET || '923124786';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let bot = null;

// ─── Pending approvals store ──────────────────────────────────────────────────
function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function savePending(items) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(items, null, 2));
  } catch (e) { console.error('[Telegram] savePending error:', e.message); }
}

// ─── Allowlist store (who can use & receive Vicki updates) ────────────────────
// Always seeded with the original manager from TELEGRAM_CHAT_ID. Members added
// via the /start<JOIN_SECRET> code persist here.
function loadAllowlist() {
  const ids = new Set();
  const seed = process.env.TELEGRAM_CHAT_ID;
  if (seed) ids.add(String(seed));
  try {
    if (fs.existsSync(ALLOWLIST_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'));
      if (Array.isArray(arr)) arr.forEach(id => ids.add(String(id)));
    }
  } catch (e) { console.error('[Telegram] loadAllowlist error:', e.message); }
  return ids;
}

function isAllowed(chatId) {
  return loadAllowlist().has(String(chatId));
}

// Returns true if newly added, false if already present.
function addToAllowlist(chatId) {
  const ids = loadAllowlist();
  if (ids.has(String(chatId))) return false;
  ids.add(String(chatId));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ALLOWLIST_FILE, JSON.stringify([...ids], null, 2));
  } catch (e) { console.error('[Telegram] addToAllowlist error:', e.message); }
  return true;
}

// ─── Send a fix request with ✅/❌ buttons ────────────────────────────────────
function sendApprovalRequest(targetChatId, item) {
  if (!bot) return;
  const text =
    `🔧 *Suggested Fix* [${item.id}]\n\n` +
    `*Problem:* ${item.problem}\n\n` +
    `*Fix:* ${item.description}\n\n` +
    `*File:* \`${item.filePath || 'N/A'}\`\n` +
    `*Risk:* ${item.risk || 'Low'} | *Impact:* ${item.expectedImpact || 'Better responses'}`;

  bot.sendMessage(targetChatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Apply it', callback_data: `approve:${item.id}` },
        { text: '❌ Skip',     callback_data: `reject:${item.id}` },
      ]]
    }
  });
}

// ─── Status report ───────────────────────────────────────────────────────────
function sendStatus(targetChatId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    let todayCalls = [];

    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      todayCalls = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(l => l && l.date === today);
    }

    const booked      = todayCalls.filter(c => c.outcome === 'booked').length;
    const transferred = todayCalls.filter(c => c.transferredToHuman).length;
    const confused    = todayCalls.filter(c => c.flags?.includes('patient_confused')).length;
    const pending     = loadPending();

    bot.sendMessage(targetChatId,
      `📊 *Vicki Status — ${today}*\n\n` +
      `📞 Calls today: *${todayCalls.length}*\n` +
      `✅ Booked: *${booked}*\n` +
      `👤 Transferred to human: *${transferred}*\n` +
      `😕 Patient confused: *${confused}*\n\n` +
      `⏳ Pending approvals: *${pending.length}*\n\n` +
      (pending.length ? `_Use /pending to review them_` : `_All clear!_`),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    bot.sendMessage(targetChatId, `❌ Error reading stats: ${e.message}`);
  }
}

// ─── Apply a fix: write file + git push → Railway redeploys ──────────────────
async function applyFix(item, targetChatId) {
  const pending = loadPending();
  try {
    if (item.filePath && item.oldContent && item.newContent) {
      const fullPath = path.join(__dirname, '..', item.filePath.replace(/^src\//, ''));
      const current  = fs.readFileSync(fullPath, 'utf8');

      if (!current.includes(item.oldContent)) {
        bot.sendMessage(targetChatId,
          `⚠️ Could not apply — the target text was not found in \`${item.filePath}\`.\n` +
          `The file may have already changed. Please review manually.`,
          { parse_mode: 'Markdown' }
        );
        savePending(pending.filter(i => i.id !== item.id));
        return;
      }

      const updated = current.replace(item.oldContent, item.newContent);
      fs.writeFileSync(fullPath, updated);
    }

    // git commit + push → Railway auto-redeploys
    execSync(`git -C "${ROOT_DIR}" add -A`,                                         { stdio: 'pipe' });
    execSync(`git -C "${ROOT_DIR}" commit -m "fix(agent): ${item.description}"`,   { stdio: 'pipe' });
    execSync(`git -C "${ROOT_DIR}" push origin main`,                               { stdio: 'pipe' });

    savePending(pending.filter(i => i.id !== item.id));

    bot.sendMessage(targetChatId,
      `✅ *Fix Applied!*\n\n_${item.description}_\n\n` +
      `Vicki is redeploying — live in ~30 seconds 🚀`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('[Telegram] applyFix error:', e.message);
    bot.sendMessage(targetChatId, `❌ Failed to apply: ${e.message}`);
  }
}

// ─── Handle free-text messages via GPT ───────────────────────────────────────
async function handleFreeText(msg) {
  const targetChatId = msg.chat.id;
  const text = msg.text;

  bot.sendChatAction(targetChatId, 'typing');

  const pending = loadPending();
  const pendingCtx = pending.length
    ? `Pending approvals:\n${pending.map((p, i) => `${i + 1}. [${p.id}] ${p.description}`).join('\n')}`
    : 'No pending approvals.';

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.1,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            `You control Vicki AI, a dental clinic voice receptionist. The clinic manager is messaging you.\n\n` +
            `${pendingCtx}\n\n` +
            `Reply ONLY with valid JSON:\n` +
            `{\n` +
            `  "action": "approve_all"|"approve_one"|"reject_all"|"reject_one"|"status"|"report"|"reply",\n` +
            `  "targetId": "<id if approve_one or reject_one, else null>",\n` +
            `  "reply": "<your friendly reply to the manager>"\n` +
            `}`,
        },
        { role: 'user', content: text },
      ],
    });

    const raw    = res.choices[0].message.content.trim()
                      .replace(/^```json\s*/i, '')
                      .replace(/^```\s*/i, '')
                      .replace(/\s*```$/i, '');
    const parsed = JSON.parse(raw);

    switch (parsed.action) {
      case 'approve_all': {
        if (!pending.length) { bot.sendMessage(targetChatId, '✅ Nothing pending to apply.'); break; }
        bot.sendMessage(targetChatId, `⚙️ Applying ${pending.length} fix(es)...`);
        for (const item of pending) await applyFix(item, targetChatId);
        break;
      }
      case 'approve_one': {
        const item = pending.find(p => p.id === parsed.targetId) || pending[0];
        if (!item) { bot.sendMessage(targetChatId, '✅ Nothing pending.'); break; }
        bot.sendMessage(targetChatId, `⚙️ Applying: ${item.description}`);
        await applyFix(item, targetChatId);
        break;
      }
      case 'reject_all': {
        savePending([]);
        bot.sendMessage(targetChatId, `❌ Skipped all ${pending.length} suggestion(s).`);
        break;
      }
      case 'reject_one': {
        const item = pending.find(p => p.id === parsed.targetId) || pending[0];
        if (!item) { bot.sendMessage(targetChatId, '✅ Nothing to skip.'); break; }
        savePending(pending.filter(p => p.id !== item.id));
        bot.sendMessage(targetChatId, `❌ Skipped: ${item.description}`);
        break;
      }
      case 'status':
        sendStatus(targetChatId);
        break;
      case 'report':
        bot.sendMessage(targetChatId, '🔍 Running analysis on recent calls...');
        require('./improvementAgent').runAnalysis(false).catch(e =>
          bot.sendMessage(targetChatId, `❌ ${e.message}`)
        );
        break;
      default:
        bot.sendMessage(targetChatId, parsed.reply || "I didn't understand — try /status, /report, or /pending");
    }
  } catch (e) {
    console.error('[Telegram] GPT handler error:', e.message);
    bot.sendMessage(targetChatId, `❌ Error: ${e.message}`);
  }
}

// ─── Start the bot ────────────────────────────────────────────────────────────
function start() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] No bot token set — bot disabled');
    return null;
  }

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  console.log('[Telegram] Bot started ✅');

  // Set the Menu commands (shows "Menu" button in Telegram chat bar)
  bot.setMyCommands([
    { command: 'status',  description: '📊 Today\'s call stats' },
    { command: 'today',   description: '📈 Resumo de hoje (concluídas)' },
    { command: 'month',   description: '🗓 Resumo do mês' },
    { command: 'report',  description: '🔍 Run analysis now' },
    { command: 'pending', description: '⏳ Review pending fixes' },
    { command: 'start',   description: '👋 Welcome & help' },
  ]).then(() => console.log('[Telegram] Command menu set ✅'))
    .catch(e  => console.error('[Telegram] setMyCommands error:', e.message));

  // Security — ignore messages from chats not on the allowlist
  const guard = (msg) => {
    if (!isAllowed(msg.chat.id)) {
      console.log(`[Telegram] Ignored message from unknown chat ${msg.chat.id}`);
      return false;
    }
    return true;
  };

  // /start — plain greeting for members; /start<JOIN_SECRET> grants access.
  bot.onText(/\/start(?:\s+|@\w+\s+)?(\S+)?/, (msg, match) => {
    const arg = (match && match[1] ? match[1] : '').trim();

    // Join-code path: works even for chats not yet on the allowlist.
    if (arg && arg === JOIN_SECRET) {
      const added = addToAllowlist(msg.chat.id);
      bot.sendMessage(msg.chat.id,
        added
          ? `✅ *Access granted!*\n\nYou're now connected to Vicki. You'll receive every report, alert, and approval request.\n\nTry /status to see today's stats.`
          : `✅ You already have access. Try /status.`,
        { parse_mode: 'Markdown' }
      );
      console.log(`[Telegram] Chat ${msg.chat.id} joined via code (${added ? 'new' : 'existing'})`);
      return;
    }

    // A wrong code from a non-member is rejected.
    if (!isAllowed(msg.chat.id)) {
      if (arg) {
        bot.sendMessage(msg.chat.id, `❌ Invalid access code.`);
        console.log(`[Telegram] Bad join code from chat ${msg.chat.id}`);
      } else {
        console.log(`[Telegram] Ignored /start from unknown chat ${msg.chat.id}`);
      }
      return;
    }

    bot.sendMessage(msg.chat.id,
      `👋 *Hi! I'm your Vicki AI Manager.*\n\n` +
      `I watch every call, find problems, and ask your approval before changing anything.\n\n` +
      `*Commands:*\n` +
      `/status — today's stats\n` +
      `/report — run analysis now\n` +
      `/pending — review pending fixes\n\n` +
      `Or just write to me naturally — I understand everything 🧠`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/status/, (msg)  => { if (!guard(msg)) return; sendStatus(msg.chat.id); });

  // New stats digests (use the corrected "completed" = booked+cancelled+confirmed+info)
  bot.onText(/\/today/, async (msg) => {
    if (!guard(msg)) return;
    try { const text = await require('./statsDigest').buildDigest('today'); bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }); }
    catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
  });
  bot.onText(/\/month/, async (msg) => {
    if (!guard(msg)) return;
    try { const text = await require('./statsDigest').buildDigest('thisMonth'); bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }); }
    catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
  });

  bot.onText(/\/report/, (msg)  => {
    if (!guard(msg)) return;
    bot.sendMessage(msg.chat.id, '🔍 Running analysis on recent calls...');
    require('./improvementAgent').runAnalysis(false)
      .catch(e => bot.sendMessage(msg.chat.id, `❌ ${e.message}`));
  });

  bot.onText(/\/pending/, (msg) => {
    if (!guard(msg)) return;
    const items = loadPending();
    if (!items.length) { bot.sendMessage(msg.chat.id, '✅ No pending approvals — all clear!'); return; }
    items.forEach(item => sendApprovalRequest(msg.chat.id, item));
  });

  // Inline button callbacks
  bot.on('callback_query', async (query) => {
    const [action, id] = query.data.split(':');
    const items = loadPending();
    const item  = items.find(i => i.id === id);

    if (!item) { bot.answerCallbackQuery(query.id, { text: 'Already handled!' }); return; }

    if (action === 'approve') {
      bot.answerCallbackQuery(query.id, { text: '✅ Applying...' });
      bot.editMessageText(
        `✅ *Applying fix...*\n\n_${item.description}_`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      await applyFix(item, query.message.chat.id);
    } else {
      bot.answerCallbackQuery(query.id, { text: '❌ Skipped' });
      bot.editMessageText(
        `❌ *Skipped*\n\n_${item.description}_`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      savePending(items.filter(i => i.id !== id));
    }
  });

  // Free-text handler — GPT understands everything
  bot.on('message', (msg) => {
    if (!guard(msg)) return;
    if (msg.text?.startsWith('/')) return;
    if (!msg.text) return;
    handleFreeText(msg);
  });

  bot.on('polling_error', (err) => console.error('[Telegram] Polling error:', err.message));

  return bot;
}

// ─── Broadcast a notification to every allowed chat ──────────────────────────
function notify(text, options = {}) {
  const ids = [...loadAllowlist()];
  if (!bot || !ids.length) return Promise.resolve();  // always return a Promise
  return Promise.all(ids.map(chatId =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options }).catch(e =>
      console.error(`[Telegram] notify error (${chatId}):`, e.message)
    )
  ));
}

module.exports = {
  start, notify, sendApprovalRequest, sendStatus,
  loadPending, savePending, loadAllowlist,
};
