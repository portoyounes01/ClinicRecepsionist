// ============================================================
// VICKI AI — Orchestrator
//
// Routes each patient turn to the correct specialist agent.
// One OpenAI call per turn (no second call — results formatted
// programmatically by formatActionResponse).
//
// Agent lifecycle per call:
//   router → booking | appointments | info | emergency | human
// ============================================================

const OpenAI = require('openai').default;
const newsoft = require('./newsoftApi');
const { buildMemoryContext } = require('./patientMemory');
const { sendBookingConfirmation, sendCancellationConfirmation } = require('./smsService');

const { inferSpecialtyFromText, doctorsForSpecialty, getSpecialty } = require('./data/specialties');

const routerAgent       = require('./agents/routerAgent');
const bookingAgent      = require('./agents/bookingAgent');
const appointmentsAgent = require('./agents/appointmentsAgent');
const infoAgent         = require('./agents/infoAgent');
const emergencyAgent    = require('./agents/emergencyAgent');

const https   = require('https');
const openai  = new OpenAI({
  apiKey:     process.env.OPENAI_API_KEY,
  httpAgent:  new https.Agent({ keepAlive: true }),
});

// ── Slot result cache (60s TTL) ────────────────────────────────────────────
// Avoids re-hitting Newsoft when patient asks follow-up slot questions within
// the same call ("what about the afternoon?", "any other times?").
const _slotCache = new Map();
function _slotCacheKey(medicId, motiveId, dateFrom, dateTo) {
  return `${medicId || '*'}|${motiveId || '*'}|${dateFrom}|${dateTo}`;
}
function _slotCacheGet(key) {
  const entry = _slotCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 60000) { _slotCache.delete(key); return null; }
  return entry.value;
}
function _slotCacheSet(key, value) {
  _slotCache.set(key, { value, ts: Date.now() });
  if (_slotCache.size > 50) {
    const oldest = [..._slotCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _slotCache.delete(oldest[0]);
  }
}
const { LOULE_DOCTOR_IDS } = bookingAgent;
const LIVE_AGENT_MODEL = 'gpt-5.4-mini';

// ─────────────────────────────────────────────
// TRANSFER SPEAK — mandatory hold message
// Called before EVERY transfer_to_human.
// Varies naturally so it never sounds scripted.
// ─────────────────────────────────────────────
function transferSpeak(patient, languageState = 'pt') {
  const firstName = patient?.patientName?.split(' ')[0];
  const name = firstName ? `, ${firstName}` : '';
  if (languageState === 'en') {
    const phrases = [
      `Of course${name} - I'll connect you with our team now.`,
      `No problem${name} - one moment while I connect you with our team.`,
      `Absolutely${name} - I'll connect you with someone from our team who can help.`,
    ];
    return phrases[Math.floor(Date.now() / 1000) % phrases.length];
  }

  const phrases = [
    `Um momento${name} — vou ligá-lo/a com um membro da nossa equipa que terá todo o gosto em ajudar.`,
    `Claro${name} — só um instante enquanto o/a transfiro para um colega nosso que pode tratar disto.`,
    `Com certeza${name} — um momento enquanto o/a passo para alguém da nossa equipa que cuida disto agora mesmo.`,
  ];
  return phrases[Math.floor(Date.now() / 1000) % phrases.length];
}

// ─────────────────────────────────────────────
// BUILD TRANSFER CONTEXT — injected as a silent
// system message when one agent hands off to another.
// The receiving agent reads it naturally and continues
// without the patient knowing anything happened.
// ─────────────────────────────────────────────
function buildTransferContext(fromAgent, userText, history, bookingReasonText, pendingSlots) {
  const agentLabels = {
    booking:      'Booking Agent (scheduling new appointments)',
    appointments: 'Appointments Agent (managing existing appointments)',
    info:         'Info Agent (clinic information and pricing)',
    emergency:    'Emergency Agent (urgent dental cases)',
    router:       'Router',
  };

  // Last 4 meaningful exchanges
  const recent = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-8)
    .map(m => {
      if (m.role === 'user') return `Patient: ${m.content}`;
      try { const p = JSON.parse(m.content); return p.speak ? `Vicki: ${p.speak}` : null; }
      catch { return null; }
    })
    .filter(Boolean)
    .join('\n');

  const parts = [
    `[SILENT TRANSFER CONTEXT — do NOT mention this to the patient]`,
    `Transferred from: ${agentLabels[fromAgent] || fromAgent}`,
    `Patient's last message: "${userText}"`,
  ];
  if (bookingReasonText) parts.push(`In-progress booking reason: "${bookingReasonText}"`);
  if (pendingSlots?.length) {
    const slotSummary = pendingSlots
      .map(s => `${s.displayDate || s.date} ${s.displayTime || s.time} with ${s.medicName}`)
      .join(', ');
    parts.push(`Slots already offered: ${slotSummary}`);
  }
  parts.push(`Recent conversation:\n${recent}`);
  parts.push(`Continue naturally from here. Use this context to be helpful. Do not say "as I mentioned" or reference the transfer.`);
  return parts.join('\n');
}

// ─────────────────────────────────────────────
// HUMAN DATE/TIME FORMATTER
// "2026-06-03T14:45:00" → "next Tuesday at quarter to three in the afternoon"
// ─────────────────────────────────────────────
function spokenDoctorName(name = '') {
  return String(name || '')
    .replace(/\bDr\.?\s*ª\b/gi, 'Doutora')
    .replace(/\bDr\.?\s*a\.?\b/gi, 'Doutora')
    .replace(/\bDra\.?\b/gi, 'Doutora')
    .replace(/\bDr\.?\b/gi, 'Doutor')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePeriodValue(value = '') {
  const text = normalizeForIntent(value);
  if (!text) return null;
  if (/\b(manha|morning|a\.?m\.?)\b/.test(text)) return 'manhã';
  if (/\b(tarde|afternoon|evening|fim do dia|final do dia|noite|p\.?m\.?)\b/.test(text)) return 'tarde';
  return null;
}

function inferLatestExplicitPeriodFromUser(history = [], params = {}) {
  const sources = [];
  if (params.chosenPeriod) sources.push({ text: params.chosenPeriod, source: 'params.chosenPeriod' });
  if (params.chosenTime) sources.push({ text: params.chosenTime, source: 'params.chosenTime' });
  for (const m of (history || []).filter(m => m.role === 'user').slice(-8)) {
    sources.push({ text: m.content || '', source: 'user' });
  }

  let latest = null;
  for (const item of sources) {
    const text = normalizeForIntent(item.text);
    if (!text) continue;
    let period = normalizePeriodValue(text);
    const timeMatches = [...text.matchAll(/\b(\d{1,2})(?:h|:)(\d{2})?\b/g)];
    if (timeMatches.length) {
      const last = timeMatches[timeMatches.length - 1];
      const hh = parseInt(last[1], 10);
      if (hh >= 13 || hh <= 7) period = 'tarde';
      else if (hh >= 8 && hh < 13) period = 'manhã';
    }
    if (period) latest = { period, source: item.source, text: item.text };
  }
  return latest;
}

function inferLatestExplicitSlotOrdinal(history = [], params = {}) {
  const sources = [];
  for (const key of ['chosenSlotIndex', 'slotIndex', 'choiceIndex', 'choice']) {
    if (params[key] !== undefined && params[key] !== null) {
      sources.push({ text: String(params[key]), source: `params.${key}` });
    }
  }
  for (const m of (history || []).filter(m => m.role === 'user').slice(-8)) {
    sources.push({ text: m.content || '', source: 'user' });
  }

  let latest = null;
  for (const item of sources) {
    const text = normalizeForIntent(item.text);
    if (!text) continue;
    let index = null;

    if (/^\d+$/.test(text)) index = parseInt(text, 10) - 1;
    if (/\b(primeir[ao]|1(?:st)?|numero um|opcao um|slot um|first(?: one)?|first option)\b/.test(text)) index = 0;
    if (/\b(segund[ao]|2(?:nd)?|numero dois|opcao dois|slot dois|second(?: one)?|second option|the second|a segunda|o segundo)\b/.test(text)) index = 1;
    if (/\b(terceir[ao]|3(?:rd)?|numero tres|opcao tres|slot tres|third(?: one)?|third option)\b/.test(text)) index = 2;
    if (/\b(ultim[ao]|last(?: one)?|last option)\b/.test(text)) index = -1;

    const numeric = text.match(/\b(?:opcao|slot|numero|option|choice)\s*(\d+)\b/);
    if (numeric) index = parseInt(numeric[1], 10) - 1;

    if (index !== null) latest = { index, source: item.source, text: item.text };
  }
  return latest;
}

function humanSlot(isoString, lang = 'pt') {
  // IMPORTANT: Newsoft returns local Lisbon time (e.g. '2026-06-18T14:00:00') with NO timezone suffix.
  // Using new Date() would treat it as UTC and add +1h offset. Parse manually to avoid this.
  const [datePart, timePart] = isoString.split('T');
  const [year, month, day]   = datePart.split('-').map(Number);
  const [hh, mm]             = (timePart || '00:00').split(':').map(Number);
  const en = lang === 'en';

  // Build a local Date just for weekday/month name (day-of-week)
  const date     = new Date(year, month - 1, day);
  const now      = new Date();
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((date - today) / 86400000);

  const locale    = en ? 'en-US' : 'pt-PT';
  const weekday   = date.toLocaleDateString(locale, { weekday: 'long' });
  const monthName = date.toLocaleDateString(locale, { month: 'long' });

  let dayName;
  if (en) {
    if      (diffDays === 0) dayName = 'today';
    else if (diffDays === 1) dayName = 'tomorrow';
    else if (diffDays <= 6)  dayName = `this ${weekday}`;
    else                     dayName = `${weekday}, ${monthName} ${day}`;
  } else {
    if      (diffDays === 0) dayName = 'hoje';
    else if (diffDays === 1) dayName = 'amanhã';
    else if (diffDays <= 6)  dayName = `esta ${weekday}`;
    else                     dayName = `${weekday}, dia ${day} de ${monthName}`;
  }

  // period stays in Portuguese — it is used for slot filtering/matching internally.
  const period  = hh < 12 ? 'manhã' : hh < 18 ? 'tarde' : 'noite';
  let timeStr;
  if (en) {
    const h12  = (hh % 12) === 0 ? 12 : hh % 12;
    const ampm = hh < 12 ? 'am' : 'pm';
    timeStr = mm === 0 ? `${h12} ${ampm}` : `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
  } else {
    timeStr = mm === 0
      ? `${String(hh).padStart(2, '0')}h`
      : `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}`;
  }

  return { dayName, timeStr, period };
}

// Format a slot for speech: just the time + period, no day
function slotTime(isoString) {
  const t = humanSlot(isoString);
  return `às ${t.timeStr} da ${t.period}`;
}
// Day label only
function slotDay(isoString) {
  return humanSlot(isoString).dayName;
}

function addDaysIso(dateString, days) {
  // Parse as UTC (note the 'Z') so the arithmetic is timezone-independent.
  // Parsing "...T00:00:00" without the Z uses LOCAL midnight, which on any
  // host east of UTC (e.g. UTC+1) shifts the instant into the previous day —
  // then toISOString() truncates back, so addDaysIso(d, 1) could return d.
  // That silently broke "search a later day" (re-offered the rejected slot).
  return new Date(new Date(dateString + 'T00:00:00Z').getTime() + days * 86400000)
    .toISOString()
    .split('T')[0];
}

function inferSlotSearchDirection(userText) {
  const text = (userText || '').toLowerCase();
  if (/\b(before|earlier|sooner|closer)\b/.test(text)) return 'earlier';
  return 'later';
}

// Did the patient name a specific doctor in this utterance? Used so an "another
// day" re-search only spans the whole specialty when they're doctor-agnostic;
// if they explicitly asked for Dr X, we keep searching Dr X.
function patientNamedDoctor(userText, cachedDoctors) {
  if (!userText || !Array.isArray(cachedDoctors)) return false;
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const t = norm(userText);
  if (/\b(dr[aª]?\.?|doutor[a]?)\b/.test(t)) return true;
  return cachedDoctors.some(d => {
    const first = norm(d.medicShortName || d.medicName).split(/\s+/).filter(p => p.length >= 4 && !/^dr/.test(p))[0];
    return first && t.includes(first);
  });
}

function explicitBeforeDateTo(userText, referenceDate) {
  const text = (userText || '').toLowerCase();
  if (!/\bbefore\b/.test(text)) return null;

  const words = {
    one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4,
    five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8,
    nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12,
    twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14,
    fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17,
    seventeenth: 17, eighteen: 18, eighteenth: 18, nineteen: 19, nineteenth: 19,
    twenty: 20, twentieth: 20, 'twenty one': 21, 'twenty first': 21,
    'twenty two': 22, 'twenty second': 22, 'twenty three': 23, 'twenty third': 23,
    'twenty four': 24, 'twenty fourth': 24, 'twenty five': 25, 'twenty fifth': 25,
    'twenty six': 26, 'twenty sixth': 26, 'twenty seven': 27, 'twenty seventh': 27,
    'twenty eight': 28, 'twenty eighth': 28, 'twenty nine': 29, 'twenty ninth': 29,
    thirty: 30, thirtieth: 30, 'thirty one': 31, 'thirty first': 31,
  };

  let day = null;
  const numeric = text.match(/\bbefore\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (numeric) {
    day = parseInt(numeric[1], 10);
  } else {
    const match = Object.keys(words)
      .sort((a, b) => b.length - a.length)
      .find(w => new RegExp(`\\bbefore\\s+(?:the\\s+)?${w}\\b`).test(text));
    if (match) day = words[match];
  }

  if (!day || day < 1 || day > 31) return null;

  const ref = new Date((referenceDate || new Date().toISOString().split('T')[0]) + 'T00:00:00');
  const target = new Date(ref.getFullYear(), ref.getMonth(), day);
  if (Number.isNaN(target.getTime())) return null;
  // Format with LOCAL components — target.toISOString() would shift the calendar
  // day by the UTC offset before handing it to addDaysIso.
  const targetIso = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  return addDaysIso(targetIso, -1);
}

// ── Resolve a caller's spoken date/time into a concrete search window ─────────
// The LLM is unreliable at date math (it once turned "próximo mês" into today and
// found zero slots, losing the booking), so we resolve relative expressions
// deterministically, server-side, from the caller's actual words.
// Returns { dateFrom, dateTo, exact, period } — any field may be null.
//   exact=true  → caller named a specific day; search ONLY that day.
//   exact=false → a window (or null) to search across.
function resolveDatePreference(userText, todayIso) {
  const text  = normalizeForIntent(userText || '');
  const today = new Date(todayIso + 'T00:00:00');
  // Format using LOCAL components — NEVER toISOString(), which shifts the calendar
  // day by the UTC offset (same reason humanSlot parses Lisbon time manually).
  const iso     = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  let period = null;
  if (/\b(manha|morning)\b/.test(text)) period = 'manhã';
  else if (/\b(tarde|afternoon|evening|after lunch)\b/.test(text)) period = 'tarde';

  const out = (from, to, exact) => ({
    dateFrom: from ? iso(from) : null,
    dateTo:   to   ? iso(to)   : null,
    exact:    !!exact,
    period,
  });

  if (!text || text === 'continua') return out(null, null, false);

  // ── Exact single-day expressions ──────────────────────────────────────────
  if (/\b(hoje|today)\b/.test(text)) return out(today, today, true);
  if (/\b(depois de amanha|day after tomorrow)\b/.test(text)) return out(addDays(today, 2), addDays(today, 2), true);
  if (/\b(amanha|tomorrow)\b/.test(text)) return out(addDays(today, 1), addDays(today, 1), true);

  // Weekday name → next occurrence (exact day)
  const weekdays = [
    ['domingo|sunday', 0], ['segunda|monday', 1], ['terca|tuesday', 2],
    ['quarta|wednesday', 3], ['quinta|thursday', 4], ['sexta|friday', 5], ['sabado|saturday', 6],
  ];
  for (const [re, dow] of weekdays) {
    if (new RegExp(`\\b(${re})`).test(text)) {
      let delta = (dow - today.getDay() + 7) % 7;
      if (delta === 0) delta = 7; // "on Monday" means the next Monday, not today
      const d = addDays(today, delta);
      return out(d, d, true);
    }
  }

  // "dia 22", "no dia 22", "22 de junho", "22nd of June"
  const months = {
    janeiro:0, fevereiro:1, marco:2, abril:3, maio:4, junho:5, julho:6, agosto:7, setembro:8, outubro:9, novembro:10, dezembro:11,
    january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11,
  };
  const dayMatch = text.match(/\b(?:dia|no dia|day)\s+(\d{1,2})\b/)
    || text.match(/\b(\d{1,2})\s+de\s+([a-z]+)/)
    || text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([a-z]+)/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    const monthName = dayMatch[2];
    let monthIdx = today.getMonth();
    if (monthName && months[monthName] !== undefined) monthIdx = months[monthName];
    if (day >= 1 && day <= 31) {
      let target = new Date(today.getFullYear(), monthIdx, day);
      if (target < today) {
        target = monthName
          ? new Date(today.getFullYear() + 1, monthIdx, day)
          : new Date(today.getFullYear(), monthIdx + 1, day);
      }
      if (!Number.isNaN(target.getTime())) return out(target, target, true);
    }
  }

  // ── Relative windows (not exact) ──────────────────────────────────────────
  if (/\b(proximo mes|next month|mes que vem)\b/.test(text)) {
    const from = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const to   = new Date(today.getFullYear(), today.getMonth() + 2, 0); // last day of next month
    return out(from, to, false);
  }
  if (/\b(proxima semana|next week|semana que vem)\b/.test(text)) {
    const toNextMon = ((8 - today.getDay()) % 7) || 7;
    const from = addDays(today, toNextMon);
    return out(from, addDays(from, 6), false);
  }
  if (/\b(esta semana|this week)\b/.test(text)) {
    const toSun = (7 - today.getDay()) % 7;
    return out(today, addDays(today, toSun || 6), false);
  }
  if (/\b(o mais cedo|mais cedo possivel|primeira vaga|primeiro disponivel|primeira disponivel|assim que possivel|asap|earliest|first available|quando houver)\b/.test(text)) {
    return out(today, addDays(today, 28), false);
  }

  return out(null, null, false); // caller didn't specify a date
}

function normalizeBookingReasonText(value) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) return null;
  if (/^(yes|yeah|ok|okay|sure|please|book it|confirm|go ahead)$/i.test(cleaned)) return null;
  return cleaned.length > 180 ? cleaned.slice(0, 177).trim() + '...' : cleaned;
}

function inferBookingReasonText(userText, params = {}, existing = null) {
  const explicit = normalizeBookingReasonText(
    params.reasonText || params.bookingReasonText || params.reasonForVisit
  );
  if (explicit) return explicit;

  const text = (userText || '').toLowerCase();
  const reasonPatterns = [
    ['teeth cleaning', /\bteeth cleaning\b/],
    ['scale and polish', /\bscale and polish\b/],
    ['cleaning', /\b(cleaning|clean|hygiene|scaling)\b/],
    ['check-up', /\b(check[- ]?up|checkup|routine visit)\b/],
    ['evaluation', /\b(evaluation|consultation|assessment)\b/],
    ['follow-up', /\b(follow[- ]?up)\b/],
    ['implant check', /\bimplant check\b/],
    ['braces check', /\bbraces check\b/],
    ['orthodontics', /\borthodontics?\b/],
    ['filling', /\b(fillings?|cavity)\b/],
    ['whitening', /\bwhitening\b/],
    ['veneer', /\bveneers?\b/],
    ['tooth pain', /\b(toothache|tooth pain|pain)\b/],
    ['broken tooth', /\b(broken tooth|tooth broke|chipped tooth)\b/],
    ['swelling', /\bswelling\b/],
    ['bleeding', /\bbleeding\b/],
    ['urgent appointment', /\b(urgent|emergency|can't wait)\b/],
  ];

  const matched = reasonPatterns.find(([, pattern]) => pattern.test(text));
  if (matched) return matched[0];

  const motiveName = normalizeBookingReasonText(params.motiveName);
  if (motiveName && !/^(consulta|avaliacao|avaliação|ach|on|ur)$/i.test(motiveName)) {
    return motiveName;
  }

  return existing;
}

function bookingObservation(reasonText) {
  const reason = normalizeBookingReasonText(reasonText);
  return reason
    ? `Marcação via Vicki AI. Motivo informado pelo paciente: ${reason}`
    : 'Marcação via Vicki AI';
}

function inferMotiveIdFromReasonText(reasonText) {
  const text = (reasonText || '').toLowerCase();
  if (!text) return null;
  if (/\b(pain|toothache|broken|swelling|bleeding|urgent|emergency|can't wait)\b/.test(text)) return 'UR';
  if (/\b(not sure|don't know|general enquiry|question)\b/.test(text)) return 'ON';
  return 'ACH';
}

function isAffirmationOnly(userText) {
  return /^(yes|yeah|yep|ok|okay|sure|please|yes please|go ahead|first available|no preference|doesn'?t matter)(?:\s+\1)*[.!?]*$/i
    .test((userText || '').trim());
}

function lastAssistantSpeak(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed.speak) return parsed.speak;
    } catch (_) {}
  }
  return '';
}

function applyBookingStateGuard({ currentAgent, action, speak, params, userText, pendingSlots, history, bookingReasonText }) {
  if (currentAgent !== 'booking' || pendingSlots?.length) return { action, speak, params };

  const previousSpeak = lastAssistantSpeak(history);
  const askedDoctorPreference = /\bpreferred doctor\b|\bfirst available\b/i.test(previousSpeak);
  const reasonText = params.reasonText || bookingReasonText;
  const motiveId = params.motiveId || inferMotiveIdFromReasonText(reasonText);

  // ── HARD BLOCK: check_slots requires a motiveId ─────────────────────────────
  // If the AI tries to search slots before knowing the reason, intercept it
  // and force Vicki to ask for the reason first. No exceptions.
  if (action === 'check_slots' && !motiveId) {
    console.warn('[Guard] check_slots blocked — no motiveId. Forcing reason question.');
    return {
      action: 'none',
      speak: speak?.toLowerCase().includes('motivo') || speak?.toLowerCase().includes('consulta')
        ? speak  // AI já perguntou — mantém
        : "Antes de verificar a disponibilidade, pode dizer-me o motivo da sua consulta?",
      params,
    };
  }

  // ── Se motiveId foi inferido do contexto, injeta nos params ────────
  if (action === 'check_slots' && motiveId && !params.motiveId) {
    console.log(`[Guard] motiveId injected from context: "${motiveId}" (reason: "${reasonText}")`);
    return { action, speak, params: { ...params, motiveId, reasonText } };
  }

  if (action === 'none' && askedDoctorPreference && isAffirmationOnly(userText) && motiveId) {
    return {
      action: 'check_slots',
      speak: "Perfeito — já verifico o primeiro slot disponível para si.",
      params: { ...params, motiveId, reasonText },
    };
  }

  const asksForUnseenSlotChoice = /\b(manhã|tarde|qual prefere|morning|afternoon)\b/i.test(speak || '');
  if (action === 'none' && asksForUnseenSlotChoice) {
    if (motiveId) {
      return {
        action: 'check_slots',
        speak: "Deixe-me verificar os horários disponíveis para si.",
        params: { ...params, motiveId, reasonText },
      };
    }
    return {
      action: 'none',
      speak: "Pode dizer-me primeiro o motivo da consulta?",
      params,
    };
  }

  return { action, speak, params };
}

function normalizePatientName(value) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned || cleaned.length < 2) return null;
  if (/^(yes|yeah|ok|okay|sure|please|book it|confirm|go ahead)$/i.test(cleaned)) return null;
  return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
}

function normalizePatientEmail(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.trim().match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function normalizePatientNif(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 10 ? digits : null;
}

async function resolvePatientForBooking({ patient, params, callerNumber }) {
  if (patient?.patientId) return { patient, created: false, resolvedExisting: true };

  const patientEmail = normalizePatientEmail(params.patientEmail || params.email);
  const patientNif = normalizePatientNif(params.patientNif || params.nif || params.patientNIF);
  const patientName = normalizePatientName(params.patientName || params.fullName || params.name);
  const patientPhoneNumber = params.patientPhoneNumber || params.phoneNumber || callerNumber;

  if (patientEmail || patientNif) {
    const existing = await newsoft.getPatientByIdentity({ patientEmail, patientNif });
    if (existing?.patientId) {
      console.log(`[Booking] Resolved existing patient ${existing.patientId} before booking`);
      return { patient: existing, created: false, resolvedExisting: true };
    }
  }

  if (!patientName) {
    return {
      needsPatientDetails: true,
      missing: 'patientName',
      speak: "Consigo marcar — pode dizer-me o seu nome completo?",
    };
  }

  // Phone number comes from caller ID automatically — never ask for it


  const createdPatient = await newsoft.createOrUpdatePatient({
    patientName,
    phoneNumber: patientPhoneNumber,
    patientEmail,
    patientNif,
  });

  console.log(`[Booking] ${createdPatient.isNewPatient ? 'Created' : 'Resolved'} patient for booking: ${createdPatient.patientId}`);
  return { patient: createdPatient, created: !!createdPatient.isNewPatient, resolvedExisting: !createdPatient.isNewPatient };
}

// ─────────────────────────────────────────────
// PROGRAMMATIC RESPONSE FORMATTER
// Converts raw Newsoft API data into spoken text.
// Eliminates the second OpenAI call — saves ~1.5s per action.
// ─────────────────────────────────────────────
function formatActionResponse(action, actionResult, lang = 'pt') {
  // VOICE NOTE: these strings are spoken directly to the caller (they bypass the LLM),
  // so they MUST match the caller's language — otherwise an English caller hears
  // Portuguese slot offers (a real bug seen in production).
  const en = lang === 'en';
  switch (action) {

    case 'check_slots': {
      const slots = actionResult.slots || [];
      if (!slots.length) {
        // Aesthetic medicine → handled only at the Quarteira clinic by Dra. Aline
        // Marodin. Inform honestly and let the team follow up; never book here.
        if (actionResult.aestheticExternal) {
          return {
            speak: en
              ? "Aesthetic treatments like Botox or fillers are done by Doutora Aline Marodin at our Quarteira clinic, not here in Loulé. I'll have our team follow up to arrange that for you. Is there anything else I can help with?"
              : "Os tratamentos de medicina estética, como Botox ou preenchimentos, são feitos pela Doutora Aline Marodin na nossa clínica de Quarteira, não aqui em Loulé. Vou pedir à equipa para entrar em contacto para agendar. Posso ajudar em mais alguma coisa?",
            action: 'none',
          };
        }
        // Emergency with no near-term opening → connect to a human immediately. Never minimize pain.
        if (actionResult.urgent) {
          return {
            speak: en
              ? "I'm so sorry you're in pain. I don't have an urgent opening in the next few days, so I'll connect you with our team right now to get you seen as soon as possible."
              : "Lamento muito que esteja com dores. Não tenho vaga urgente nos próximos dias, por isso vou ligá-lo/a já com a nossa equipa para o/a atendermos o quanto antes.",
            action: 'transfer_to_human',
          };
        }
        if (actionResult.searchDirection === 'earlier') {
          return {
            speak: en
              ? "I don't see anything earlier right now. The last slot I offered is still the soonest I can find. Would you like to keep it?"
              : "Neste momento não vejo nada mais cedo. O último slot que ofereci continua a ser o mais próximo que encontro. Quer ficar com esse?",
            action: 'none',
          };
        }
        // Honest message — never claim a window we did not actually search.
        if (actionResult.exact) {
          return {
            speak: en
              ? "There are no openings on that day. Would you like me to check another nearby day?"
              : "Não há vagas livres nesse dia. Quer que veja outro dia próximo?",
            action: 'none',
          };
        }
        if (actionResult.medicSpecified) {
          return {
            speak: en
              ? "I couldn't find openings with that doctor around then. Would you like me to check with another doctor?"
              : "Não encontrei vagas com esse médico nessa altura. Quer que veja com outro médico?",
            action: 'none',
          };
        }
        return {
          speak: en
            ? "I couldn't find any openings around then. Would you like me to look at another date?"
            : "Não encontrei vagas disponíveis nessa altura. Quer que procure noutra data?",
          action: 'none',
        };
      }

      // Split into morning (before 13h) and afternoon (13h+)
      const morningSlots   = slots.filter(s => s.period === 'manhã');
      const afternoonSlots = slots.filter(s => s.period !== 'manhã');
      const hs = iso => humanSlot(iso, lang);
      const withDoc = name => en ? ` with ${name}` : ` com ${name}`;

      let speak;
      const sameDoctor = slots.every(s => s.medicName === slots[0].medicName);

      if (morningSlots.length >= 1 && afternoonSlots.length >= 1) {
        // Has both morning and afternoon
        const am1 = hs(morningSlots[0].date + 'T' + morningSlots[0].time);
        const pm1 = hs(afternoonSlots[0].date + 'T' + afternoonSlots[0].time);
        if (sameDoctor) {
          speak = en
            ? `I have ${am1.dayName} — ${am1.timeStr} in the morning or ${pm1.timeStr} in the afternoon, both with ${slots[0].medicName}. Which would you prefer?`
            : `Tenho ${am1.dayName} — ${am1.timeStr} de manhã ou ${pm1.timeStr} de tarde, ambos com ${slots[0].medicName}. Qual prefere?`;
        } else {
          speak = en
            ? `I have ${am1.dayName} at ${am1.timeStr} with ${morningSlots[0].medicName}, or ${pm1.timeStr} in the afternoon with ${afternoonSlots[0].medicName}. Which would you prefer?`
            : `Tenho ${am1.dayName} às ${am1.timeStr} com ${morningSlots[0].medicName}, ou ${pm1.timeStr} de tarde com ${afternoonSlots[0].medicName}. Qual prefere?`;
        }
      } else if (morningSlots.length >= 2) {
        // Only morning, 2 options
        const [m1, m2] = morningSlots.map(s => hs(s.date + 'T' + s.time));
        speak = en
          ? `I have ${m1.dayName} at ${m1.timeStr} or ${m2.timeStr}, both in the morning${sameDoctor ? withDoc(slots[0].medicName) : ''}. Which would you prefer?`
          : `Tenho ${m1.dayName} às ${m1.timeStr} ou às ${m2.timeStr}, ambos de manhã${sameDoctor ? withDoc(slots[0].medicName) : ''}. Qual prefere?`;
      } else if (afternoonSlots.length >= 2) {
        // Only afternoon, 2 options
        const [p1, p2] = afternoonSlots.map(s => hs(s.date + 'T' + s.time));
        speak = en
          ? `I have ${p1.dayName} at ${p1.timeStr} or ${p2.timeStr}, both in the afternoon${sameDoctor ? withDoc(slots[0].medicName) : ''}. Which would you prefer?`
          : `Tenho ${p1.dayName} às ${p1.timeStr} ou às ${p2.timeStr}, ambos de tarde${sameDoctor ? withDoc(slots[0].medicName) : ''}. Qual prefere?`;
      } else {
        // Single slot
        const s = slots[0];
        const t = hs(s.date + 'T' + s.time);
        speak = en
          ? `I have an opening ${t.dayName} at ${t.timeStr} with ${s.medicName} — does that work for you?`
          : `Tenho vaga ${t.dayName} às ${t.timeStr} com ${s.medicName} — assim está bem para si?`;
      }

      return {
        speak,
        action: 'none',
        pendingSlots: slots,
        _slotsContext: slots.map((s, i) =>
          `Slot ${i+1} (${s.period}): ${humanSlot(s.date+'T'+s.time).dayName} às ${humanSlot(s.date+'T'+s.time).timeStr} da ${s.period} com ${s.medicName}\nslotBase64=${s.slotBase64}`
        ).join('\n\n'),
      };
    }


    case 'get_appointments': {
      const appts = actionResult.appointments || [];
      if (!appts.length) {
        return {
          speak: en
            ? "You don't have any appointments scheduled with us at the moment."
            : "Neste momento não tem nenhuma consulta agendada connosco.",
          action: 'none',
        };
      }
      const a = appts[0];
      const more = appts.length > 1
        ? (en ? ` You have ${appts.length} appointments in total.` : ` Tem ${appts.length} consultas no total.`)
        : '';
      return {
        speak: en
          ? `Your next appointment is ${a.display}.${more} Would you like to make any changes?`
          : `A sua próxima consulta é ${a.display}.${more} Deseja fazer alguma alteração?`,
        action: 'none',
        pendingAppointments: appts,
        _appointmentsContext: appts.map((ap, i) =>
          `Consulta ${i+1}: ${ap.display} [ref:${ap.appointmentId}]`
        ).join('\n'),
      };
    }

    case 'book_appointment':
      if (actionResult.needsPatientDetails) {
        return {
          speak: actionResult.speak || (en
            ? "I can book that — could you give me your full name for the patient file?"
            : "Consigo marcar — pode dizer-me o seu nome completo para o ficheiro do paciente?"),
          action: 'none',
        };
      }
      if (actionResult.error || !actionResult.appointmentId) {
        return {
          speak: en
            ? "I'm sorry, I couldn't complete the booking in our system. One moment — I'll connect you with a member of our team who can sort this out right away."
            : "Peço desculpa, não foi possível concluir a marcação no nosso sistema. Um momento — vou ligá-lo/a com um membro da nossa equipa que resolve isto imediatamente.",
          action: 'transfer_to_human',
        };
      }
      {
        // Use the ACTUAL booked slot details for confirmation — never trust AI's memory of what it offered.
        // Recompute the date/time label in the caller's language (stored labels are pt-PT).
        const bs = actionResult.bookedSlot;
        const t  = (bs && bs.date && bs.time) ? humanSlot(bs.date + 'T' + bs.time, lang) : null;
        const smsLineEn = actionResult.smsSent ? ` I've just sent you a confirmation by text.` : '';
        const smsLinePt = actionResult.smsSent ? ` Acabei de lhe enviar a confirmação por mensagem.` : '';
        let confirmSpeak;
        if (en) {
          confirmSpeak = (bs && t)
            ? `Perfect — you're all booked at Instituto Vilas Boas in Loulé! We'll see you ${t.dayName} at ${t.timeStr} with ${bs.medicName}.${smsLineEn} Is there anything else I can help with?`
            : `Perfect — you're all booked at Instituto Vilas Boas in Loulé!${smsLineEn} Is there anything else I can help with?`;
        } else {
          confirmSpeak = (bs && t)
            ? `Perfeito — está tudo marcado no Instituto Vilas Boas em Loulé! Esperamo-lo/a ${t.dayName} às ${t.timeStr} com ${bs.medicName}.${smsLinePt} Posso ajudar em mais alguma coisa?`
            : `Perfeito — está tudo marcado no Instituto Vilas Boas em Loulé!${smsLinePt} Posso ajudar em mais alguma coisa?`;
        }
        return { speak: confirmSpeak, action: 'none' };
      }


    case 'cancel_appointment':
      if (actionResult.cancelled && actionResult.remainingAppointments?.length) {
        const next = actionResult.remainingAppointments[0];
        const n = actionResult.remainingAppointments.length;
        return {
          speak: en
            ? `Done, that appointment is cancelled. You still have ${n} appointment${n > 1 ? 's' : ''} booked. Would you also like to cancel the next one, ${next.display}?`
            : `Pronto, essa consulta esta cancelada. Ainda tem ${n} consulta${n > 1 ? 's' : ''} marcada${n > 1 ? 's' : ''}. Quer cancelar tambem a proxima, ${next.display}?`,
          action: 'none',
          pendingAppointments: actionResult.remainingAppointments,
        };
      }
      if (actionResult.cancelled && actionResult.remainingAppointments) {
        return {
          speak: en
            ? `Done, it's cancelled. I don't see any other appointments booked. Is there anything else I can help with?`
            : `Pronto, esta cancelado. Nao vejo mais consultas marcadas. Posso ajudar em mais alguma coisa?`,
          action: 'none',
          pendingAppointments: [],
        };
      }
      if (!actionResult.cancelled) {
        return {
          speak: en
            ? `I'm sorry, I couldn't cancel it in our system. One moment — I'll connect you with someone from our team who can handle this for you.`
            : `Peço desculpa, não foi possível cancelar no nosso sistema. Um momento — vou ligá-lo/a com alguém da nossa equipa que trata disto para si.`,
          action: 'transfer_to_human',
        };
      }
      return {
        speak: en
          ? `Done, it's cancelled. I know things come up — would you like me to find another opening so you don't lose your place?`
          : `Pronto, está cancelado. Sei que às vezes surgem imprevistos — quer que encontre outra vaga para não perder o seu lugar?`,
        action: 'none',
      };

    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// NEWSOFT API EXECUTOR
// Runs the action chosen by the current agent.
// ─────────────────────────────────────────────
async function executeAction(action, params, patient, callerNumber, history = [], lang = 'pt') {
  switch (action) {

    case 'check_slots': {
      const today    = new Date().toISOString().split('T')[0];
      const maxDate  = new Date(Date.now() + 28 * 86400000).toISOString().split('T')[0];
      const searchDirection = params._slotSearchDirection || 'later';
      const rawMotive = params.motiveId;
      const motiveId  = rawMotive && rawMotive !== 'undefined' && rawMotive !== 'null'
        ? rawMotive : null;
      let medicId     = params.medicId && params.medicId !== 'undefined' && params.medicId !== 'null'
        ? params.medicId : null;

      // ── SPECIALTY ENFORCEMENT (server-side, anti-hallucination) ────────────
      // Resolve the requested specialty from the reason text deterministically.
      // The LLM may pick a medicId; we VERIFY that doctor actually performs the
      // specialty, and if no doctor was chosen we restrict the search pool to
      // the specialty's doctors. This is the layer the LLM cannot bypass.
      // Use the PERSISTED booking reason too — when the caller says "the fastest
      // time" without repeating "cleaning", reasonText is empty but the specialty
      // (e.g. cleaning) was established earlier, so the doctor filter must hold.
      const specialtyId = inferSpecialtyFromText(params.reasonText || params._bookingReasonText || params._reasonText || '');

      // Aesthetic medicine is ONLY done by Dra. Aline Marodin at the QUARTEIRA
      // clinic — never bookable on this Loulé line. Never search dental slots for
      // it (that would wrongly offer a dentist); hand off to the team instead.
      if (specialtyId === 'aesthetic_medicine') {
        return { slots: [], aestheticExternal: true };
      }

      let specialtyDocs = [];
      if (specialtyId) {
        specialtyDocs = doctorsForSpecialty(specialtyId, LOULE_DOCTOR_IDS);
        const numMedic = medicId != null ? parseInt(medicId, 10) : null;
        if (numMedic != null && specialtyDocs.length && !specialtyDocs.includes(numMedic)) {
          // LLM (or patient) picked a doctor who does NOT do this treatment.
          // Drop the bad medicId so we search the right doctors instead of
          // confidently offering a wrong one.
          console.warn(`[Specialty] medicId ${numMedic} does NOT perform "${specialtyId}". Dropping it; valid: ${JSON.stringify(specialtyDocs)}`);
          medicId = null;
          params._specialtyMismatch = { specialtyId, validDocs: specialtyDocs };
        }
        // If exactly one doctor does this specialty and none was chosen, lock to them.
        if (medicId == null && specialtyDocs.length === 1) {
          medicId = specialtyDocs[0];
          console.log(`[Specialty] "${specialtyId}" → single doctor; locking medicId ${medicId}`);
        }
        params._specialtyDocs = specialtyDocs;
        params._specialtyId   = specialtyId;
      }

      // ── "ANOTHER DAY" SPANS THE WHOLE SPECIALTY ────────────────────────────
      // On a re-search after the patient rejected an offer (_lastOfferedDate is
      // set), if they did NOT name a doctor this turn and the specialty has more
      // than one doctor, drop the locked doctor and search them all. Otherwise we
      // march one (possibly sparse) doctor week by week into the far future while
      // another specialty doctor is free much sooner — exactly what frustrated
      // the caller (Carolina only had Fridays; Silvia/Nadine were free in days).
      if (medicId != null && params._lastOfferedDate && specialtyDocs.length > 1 && !params._patientNamedDoctor) {
        console.log(`[Specialty] another-day re-search: unlocking medicId ${medicId} to span specialty "${specialtyId}" ${JSON.stringify(specialtyDocs)}`);
        medicId = null;
      }

      let dateFrom = today;
      let dateTo   = maxDate;

      // ── Date range logic ─────────────────────────────────────────────────
      // Source of truth is the caller's own words (resolved server-side in
      // resolveDatePreference), NOT the LLM's date math — it once collapsed
      // "próximo mês" to today and found nothing, losing the booking.
      // Priority:
      //   1. Caller named a specific day     → search ONLY that day (exact)
      //   2. Caller gave a relative window   → search that window (e.g. all of next month)
      //   3. "earlier" follow-up             → search before the last offered date
      //   4. "later" follow-up               → search after the last offered date
      //   5. LLM gave a bare date, no window → search a 4-week window from it
      //   6. Default                         → today .. +4 weeks
      const pref       = params._datePref || null;
      const aiDateFrom = params.dateFrom || params.date || null;

      // ── DOCTOR ROTATION on rejection ──────────────────────────────────────
      // If the caller is doctor-agnostic (no medicId) and is rejecting the
      // previous offer (a follow-up) without naming a new date, offer a
      // DIFFERENT specialty doctor's earliest slot instead of pushing the same
      // doctor's dates out. Single-doctor specialties lock medicId earlier, so
      // lastOfferedDoc stays null there and rotation never triggers.
      const lastOfferedDoc = (medicId == null
        && Array.isArray(params._pendingSlots) && params._pendingSlots[0]
        && params._pendingSlots[0].medicId != null)
        ? params._pendingSlots[0].medicId : null;
      const rotateDoctors = lastOfferedDoc != null
        && !(pref && pref.dateFrom) && !aiDateFrom && searchDirection !== 'earlier';

      if (pref && pref.exact && pref.dateFrom) {
        dateFrom = pref.dateFrom;
        dateTo   = pref.dateFrom;
      } else if (pref && pref.dateFrom) {
        dateFrom = pref.dateFrom;
        dateTo   = pref.dateTo || maxDate;
      } else if (searchDirection === 'earlier') {
        dateTo = params._explicitDateTo
          || (params._lastOfferedDate ? addDaysIso(params._lastOfferedDate, -1) : maxDate);
        if (dateTo < dateFrom) return { slots: [], searchDirection, dateFrom, dateTo, medicSpecified: !!medicId };
      } else if (rotateDoctors) {
        // Reset to today so we find the new doctor's true earliest slot, not
        // just their availability in the leftover window from the rejected doctor.
        dateFrom = today;
        dateTo   = maxDate;   // 28-day horizon — Newsoft rejects intervals > 30 days
      } else if (params._lastOfferedDate) {
        dateFrom = addDaysIso(params._lastOfferedDate, 1);
      } else if (aiDateFrom) {
        // LLM extracted a bare date but caller used no recognizable phrase —
        // treat it as a window start, never a single locked day.
        dateFrom = aiDateFrom;
        dateTo   = addDaysIso(aiDateFrom, 28);
      }

      // Safety: repeated rejections can advance dateFrom past dateTo when the
      // 28-day horizon is exhausted (e.g. last offer July 3 → dateFrom July 4,
      // but maxDate is also July 4 → zero-day window → 0 slots every time).
      // Extend by another 4 weeks so the patient never hits a dead end.
      // Never applied to exact-date requests or urgent triage.
      if (!pref?.exact && motiveId !== 'UR' && dateFrom >= dateTo) {
        dateTo = addDaysIso(dateFrom, 28);
      }

      // HARD CAP: Newsoft rejects any IntervalDates span over 30 days (HTTP 400).
      // Whatever the branches produced, never send a window wider than 28 days.
      if (addDaysIso(dateFrom, 28) < dateTo) {
        dateTo = addDaysIso(dateFrom, 28);
      }

      const periodPref = pref?.period || null;

      // ── Emergency triage ──────────────────────────────────────────────────
      // For urgent cases (motiveId UR) only consider genuinely near-term slots.
      // If none exist in the next few days we escalate to a human rather than
      // offering a slot a week out as if it were urgent (per clinic protocol).
      const isUrgent = motiveId === 'UR';
      if (isUrgent && !(pref && pref.exact)) {
        const urgentHorizon = addDaysIso(today, 3);
        if (dateFrom > urgentHorizon) dateFrom = today;
        if (dateTo   > urgentHorizon) dateTo   = urgentHorizon;
      }

      console.log(`[Newsoft] slot search window: ${dateFrom}..${dateTo}${periodPref ? ` period=${periodPref}` : ''}${pref?.exact ? ' (exact day)' : ''}${isUrgent ? ' [URGENT]' : ''}`);

      // Slot cache is bypassed under the dry-run gym so scenarios don't leak
      // cached slots to one another (it's a per-process global). Production keeps
      // the 60s cache for latency.
      const cacheKey = _slotCacheKey(medicId, motiveId, dateFrom, dateTo);
      let raw = process.env.VICKI_DRY_RUN ? null : _slotCacheGet(cacheKey);
      if (raw) {
        console.log(`[Newsoft] slot cache HIT: ${cacheKey} (${raw.length} slots)`);
      } else {
        raw = await newsoft.getAvailableSlots({ medicId, motiveId, dateFrom, dateTo });
        if (raw.length && !process.env.VICKI_DRY_RUN) _slotCacheSet(cacheKey, raw);
        console.log(`[Newsoft] slot cache MISS: fetched ${raw.length} slots`);
      }
      if (!raw.length) return { slots: [], searchDirection, dateFrom, dateTo, medicSpecified: !!medicId, exact: !!(pref && pref.exact), urgent: isUrgent };

      // ── SPECIALTY POOL FILTER (anti-hallucination) ─────────────────────────
      // When a specialty is known but no single doctor was locked, the API
      // returned ALL Loulé doctors' slots. Restrict to the specialty's doctors
      // so Vicki can never offer a doctor who doesn't perform the treatment.
      let pool = raw;
      if (specialtyDocs.length && medicId == null) {
        const allow = new Set(specialtyDocs);
        const filtered = pool.filter(s => allow.has(s.medicId));
        console.log(`[Specialty] "${specialtyId}" pool filter: ${pool.length} → ${filtered.length} (docs ${JSON.stringify(specialtyDocs)})`);
        pool = filtered;
        if (!pool.length) return { slots: [], searchDirection, dateFrom, dateTo, medicSpecified: false, exact: !!(pref && pref.exact), urgent: isUrgent, specialtyId, noSpecialtySlots: true };
      }

      // Doctor rotation: drop the just-rejected doctor so a different specialty
      // doctor surfaces. If no one else has slots in the window, keep the pool
      // (the same doctor's offer stands; repeated identical offers are caught by
      // the loop detector).
      if (rotateDoctors) {
        const others = pool.filter(s => s.medicId !== lastOfferedDoc);
        if (others.length) {
          console.log(`[Slots] rotation: excluding last-offered medicId ${lastOfferedDoc} → ${new Set(others.map(s => s.medicId)).size} other doctor(s)`);
          pool = others;
        }
      }

      // ── NEVER re-offer a just-rejected slot ────────────────────────────────
      // The patient asked for another time, so the slots we already showed
      // (in _pendingSlots) must not come back as "the earliest" — otherwise a
      // fuzzy date phrase that resets the window to today would re-offer the very
      // slot they declined. Match on the opaque slot token so it's exact. Keep
      // the pool if exclusion empties it (better to repeat than to wrongly claim
      // no availability).
      {
        const shown = [
          ...(Array.isArray(params._pendingSlots) ? params._pendingSlots : []),
          ...(Array.isArray(params._offeredSlots) ? params._offeredSlots : []),
        ];
        const rejected = new Set(shown.map(s => s.slotBase64).filter(Boolean));
        if (rejected.size) {
          const fresh = pool.filter(s => !rejected.has(s.appointmentSlotBase64RawData));
          if (fresh.length) {
            if (fresh.length !== pool.length) console.log(`[Slots] excluding ${pool.length - fresh.length} already-offered slot(s) so they aren't re-offered`);
            pool = fresh;
          }
        }
      }

      // Honor a stated period (manhã/tarde) when slots exist for it; otherwise show all.
      if (periodPref) {
        const filtered = raw.filter(s => {
          const h = parseInt(s.appointmentDateBegin?.split('T')[1] || '0', 10);
          return periodPref === 'manhã' ? h < 13 : h >= 13;
        });
        if (filtered.length) pool = filtered;
      }

      // Pick exactly 1 morning (before 13:00) and 1 afternoon/evening (≥13:00)
      // so Vicki always offers just 2 clear choices, never a long list
      const toSlot = s => {
        const iso = s.appointmentDateBegin;
        const h   = humanSlot(iso);
        return {
          slotBase64:  s.appointmentSlotBase64RawData,
          medicId:     s.medicId,   // kept so rotation can identify the offered doctor
          medicName:   spokenDoctorName(s.medicShortName || s.medicName),
          date:        iso?.split('T')[0],
          displayDate: h.dayName,   // pre-computed — AI MUST use verbatim
          time:        iso?.split('T')[1]?.slice(0, 5),
          displayTime: h.timeStr,   // pre-computed time label
          display:     s.appointmentEnglishMessage,
          period:      h.period,
        };
      };

      // ── Smart slot picking — goal: same day, up to 2 morning + 2 afternoon ──────
      // Priority: find a doctor with both periods. Fallback: any doctor on earliest day.
      // Returns at most 4 slots total so Vicki can offer real choice.

      const byDate = {};
      for (const s of pool) {
        const d = s.appointmentDateBegin?.split('T')[0];
        if (d) { if (!byDate[d]) byDate[d] = []; byDate[d].push(s); }
      }
      const sortedDates = Object.keys(byDate).sort();

      let pickedSlots = [];

      for (const date of sortedDates) {
        const daySlots = byDate[date];

        // Split by period
        const morningSlots   = daySlots.filter(s => {
          const h = parseInt(s.appointmentDateBegin?.split('T')[1] || '0');
          return h < 13;
        });
        const afternoonSlots = daySlots.filter(s => {
          const h = parseInt(s.appointmentDateBegin?.split('T')[1] || '0');
          return h >= 13;
        });

        // ── STRICT SAME-DOCTOR RULE ──────────────────────────────────────────
        // ALL returned slots MUST come from the same doctor.
        // Priority per day:
        //   1. Doctor with morning AND afternoon (ideal — gives patient a choice)
        //   2. Doctor with 2 morning slots (only morning available)
        //   3. Doctor with 2 afternoon slots (only afternoon available)
        //   4. Doctor with any single slot (last resort)
        // NEVER mix two different doctors.

        const byDoc = {};
        for (const s of daySlots) {
          const id = s.medicId || s.medicShortName || s.medicName;
          if (!byDoc[id]) byDoc[id] = { morning: [], afternoon: [] };
          const h = parseInt(s.appointmentDateBegin?.split('T')[1] || '0');
          if (h < 13) byDoc[id].morning.push(s);
          else        byDoc[id].afternoon.push(s);
        }

        let chosen = [];

        // Pass 1: prefer doctor with both morning AND afternoon
        for (const doc of Object.values(byDoc)) {
          if (doc.morning.length && doc.afternoon.length) {
            chosen = [doc.morning[0], doc.afternoon[0]];
            break;
          }
        }

        // Pass 2: doctor with 2 morning slots
        if (!chosen.length) {
          for (const doc of Object.values(byDoc)) {
            if (doc.morning.length >= 2) {
              chosen = doc.morning.slice(0, 2);
              break;
            }
          }
        }

        // Pass 3: doctor with 2 afternoon slots
        if (!chosen.length) {
          for (const doc of Object.values(byDoc)) {
            if (doc.afternoon.length >= 2) {
              chosen = doc.afternoon.slice(0, 2);
              break;
            }
          }
        }

        // Pass 4: any doctor with at least 1 slot (single option)
        if (!chosen.length) {
          for (const doc of Object.values(byDoc)) {
            const any = [...doc.morning, ...doc.afternoon];
            if (any.length) { chosen = [any[0]]; break; }
          }
        }

        if (chosen.length) { pickedSlots = chosen; break; }
      }

      if (!pickedSlots.length && pool.length) pickedSlots = [pool[0]];

      const slots = pickedSlots.map(toSlot);

      const lastOfferedDate = slots.length > 0
        ? slots.reduce((max, s) => s.date > max ? s.date : max, slots[0].date)
        : null;
      return { slots: slots.length ? slots : [toSlot(pool[0])], lastOfferedDate, searchDirection, dateFrom, dateTo };
    }

    case 'get_appointments': {
      if (!patient) return { appointments: [] };
      const raw = await newsoft.getPatientAppointments(patient.patientId);
      if (!raw.length) return { appointments: [] };
      const appointments = raw.map(a => {
        const iso = a.appointmentDateBegin || (a.appointmentDate + 'T' + (a.appointmentTime || '00:00'));
        const t   = humanSlot(iso, lang);
        const doctorName = spokenDoctorName(a.medicName || a.medicShortName);
        return {
          appointmentId: a.appointmentId,
          display: lang === 'en'
            ? `${t.dayName} at ${t.timeStr} with ${doctorName}`
            : `${t.dayName} às ${t.timeStr} da ${t.period} com ${doctorName}`,
          doctor:      doctorName,
          medicName:   doctorName,
          date:        iso?.split('T')[0],
          time:        iso?.split('T')[1]?.slice(0, 5),
          displayDate: t.dayName,
          displayTime: t.timeStr,
        };
      });
      for (const appt of appointments) {
        appt.display = spokenDoctorName(appt.display);
      }
      return { appointments };
    }

    case 'book_appointment': {
      const patientResolution = await resolvePatientForBooking({ patient, params, callerNumber });
      if (patientResolution.needsPatientDetails) return patientResolution;

      const patientForBooking = patientResolution.patient;
      if (!patientForBooking?.patientId) return { error: 'No patient on file — cannot book.' };

      // ── Resolve the correct slot server-side ──────────────────────────────────────
      // CRITICAL: AI sends chosenPeriod as 'morning'/'afternoon' (English) or 'manhã'/'tarde' (pt-PT).
      // Slots are stored with period 'manhã'/'tarde'. Normalize both sides before matching.
      let resolvedBase64 = params.slotBase64;
      let chosenSlot = null;
      if (params._pendingSlots && params._pendingSlots.length > 0) {
        const normPeriod = (p) => {
          const normalized = normalizePeriodValue(p);
          if (normalized) return normalized;
          if (!p) return null;
          const lp = p.toLowerCase();
          if (lp === 'morning'  || lp === 'manhã' || lp === 'manha') return 'manhã';
          if (lp === 'afternoon'|| lp === 'tarde' || lp === 'evening' || lp === 'night' || lp === 'fim do dia') return 'tarde';
          return lp;
        };
        const explicitPeriod = inferLatestExplicitPeriodFromUser(history, params);
        const explicitOrdinal = inferLatestExplicitSlotOrdinal(history, params);
        const wantedPeriod = explicitPeriod?.period || normPeriod(params.chosenPeriod);

        // Extract the specific time the patient explicitly requested (e.g. "14h45", "14:45", "9h30")
        // ONLY read from patient (user) messages — NOT from Vicki's slot-listing message,
        // which mentions multiple times and would cause false matches (e.g. "11h ou 14h" → picks 11h wrongly).
        const extractTime = (str) => {
          if (!str) return null;
          // Match formats: "14h45", "14:45", "14h", "9h30", "09:30"
          const m = String(str).match(/\b(\d{1,2})h(\d{2})?|(\d{1,2}):(\d{2})\b/);
          if (!m) return null;
          const hh = parseInt(m[1] || m[3]);
          const mm = parseInt(m[2] || m[4] || '0');
          return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
        };

        // Only use patient (user) messages for time extraction — Vicki's messages list multiple
        // times and would cause wrong matches (e.g. "Tenho 11h de manhã ou 14h de tarde" → "11:00")
        const patientTimeSource = [
          params.chosenTime,
          // Recent patient turns only (role=user, not assistant)
          ...(history || []).slice(-6).filter(m => m.role === 'user').map(m => m.content || ''),
        ].filter(Boolean).join(' ');

        let wantedTime = extractTime(params.chosenTime) || extractTime(patientTimeSource) || null;

        // If we have BOTH a wantedPeriod and a wantedTime, make sure they're consistent.
        // Example: patient said "a da tarde" (tarde), wantedTime extracted as "11:00" from context.
        // If wantedTime doesn't match any slot in wantedPeriod → discard wantedTime, trust period.
        if (wantedTime && wantedPeriod) {
          const timeMatchesPeriod = params._pendingSlots.some(s =>
            normPeriod(s.period) === wantedPeriod &&
            (s.time?.slice(0,5) === wantedTime || s.displayTime?.replace('h',':').replace(/(\d+):$/, '$10:00') === wantedTime)
          );
          if (!timeMatchesPeriod) {
            console.log(`[Booking] wantedTime ${wantedTime} has no match in period ${wantedPeriod} — discarding time, trusting period`);
            wantedTime = null;
          }
        }

        chosenSlot =
          // 1. Match by EXACT time within correct period (prevents 14:00 vs 14:45 confusion)
          (wantedTime && wantedPeriod && params._pendingSlots.find(s => {
            if (normPeriod(s.period) !== wantedPeriod) return false;
            const st = s.time?.slice(0,5);
            const dt = s.displayTime?.replace('h',':').replace(/(\d+):$/, '$10:00');
            return st === wantedTime || dt === wantedTime;
          })) ||
          // 2. Match by EXACT time alone (when no period conflict)
          (wantedTime && params._pendingSlots.find(s => {
            const st = s.time?.slice(0,5);
            const dt = s.displayTime?.replace('h',':').replace(/(\d+):$/, '$10:00');
            return st === wantedTime || dt === wantedTime;
          })) ||
          // 3. Match by period + time proximity (pick closest to wanted time within period)
          (wantedPeriod && wantedTime && (() => {
            const sameperiod = params._pendingSlots.filter(s => normPeriod(s.period) === wantedPeriod);
            if (!sameperiod.length) return null;
            const wH = parseInt(wantedTime.split(':')[0]);
            const wM = parseInt(wantedTime.split(':')[1]);
            const wMin = wH * 60 + wM;
            return sameperiod.sort((a, b) => {
              const [ah, am] = (a.time || '00:00').split(':').map(Number);
              const [bh, bm] = (b.time || '00:00').split(':').map(Number);
              return Math.abs(ah*60+am - wMin) - Math.abs(bh*60+bm - wMin);
            })[0];
          })()) ||
          // 4. Match by explicit ordinal choice ("second one", "a segunda", "option 2")
          (explicitOrdinal && (() => {
            const idx = explicitOrdinal.index < 0
              ? params._pendingSlots.length - 1
              : explicitOrdinal.index;
            return idx >= 0 && idx < params._pendingSlots.length
              ? params._pendingSlots[idx]
              : null;
          })()) ||
          // 5. Match by normalized period alone
          (wantedPeriod && params._pendingSlots.find(s => normPeriod(s.period) === wantedPeriod)) ||
          // 6. Match by partial slotBase64 prefix (AI may truncate)
          (params.slotBase64 && params._pendingSlots.find(s => s.slotBase64?.startsWith(params.slotBase64?.slice(0, 20)))) ||
          // 7. Match by medicName
          (params.medicName && params._pendingSlots.find(s => s.medicName?.toLowerCase().includes(params.medicName?.toLowerCase()))) ||
          // 8. Last resort: first slot only when caller gave no explicit slot signal.
          (!explicitPeriod && !explicitOrdinal && !wantedTime && params._pendingSlots[0]);


        if (chosenSlot) resolvedBase64 = chosenSlot.slotBase64;
        if ((explicitPeriod || explicitOrdinal || wantedTime) && !chosenSlot) {
          console.warn(`[Booking] Explicit slot choice did not match offered slots. period=${explicitPeriod?.period || '(none)'} ordinal=${explicitOrdinal ? explicitOrdinal.index : '(none)'} time=${wantedTime || '(none)'}. Refusing unsafe fallback.`);
          return { error: 'Requested period did not match offered slots' };
        }

        // AUDIT LOG — every booking decision is traceable
        console.log(`[Booking] Slot resolution:`);
        console.log(`  chosenPeriod (AI)  : ${params.chosenPeriod || '(none)'}`);
        console.log(`  explicitPeriod     : ${explicitPeriod ? `${explicitPeriod.period} from ${explicitPeriod.source}` : '(none)'}`);
        console.log(`  explicitOrdinal    : ${explicitOrdinal ? `${explicitOrdinal.index} from ${explicitOrdinal.source}` : '(none)'}`);
        console.log(`  wantedPeriod (norm): ${wantedPeriod || '(none)'}`);
        console.log(`  wantedTime         : ${wantedTime || '(none)'}`);
        console.log(`  slots available    : ${params._pendingSlots.map(s => `${s.period} ${s.medicName} ${s.time} (${s.displayTime})`).join(' | ')}`);
        console.log(`  chosen slot        : ${chosenSlot ? `${chosenSlot.period} ${chosenSlot.medicName} ${chosenSlot.time} (${chosenSlot.displayTime})` : 'NONE — fallback'}`);

      }

      console.log(`[Booking] Patient: ${patientForBooking.patientName} (${patientForBooking.patientId})`);
      console.log(`[Booking] Reason: ${params._bookingReasonText || '(none)'}`);
      const booked = await newsoft.bookAppointment({
        patientId:   patientForBooking.patientId,
        slotBase64:  resolvedBase64,
        motiveName:  params.motiveName || 'Consulta',
        observation: bookingObservation(params._bookingReasonText),
      });
      console.log(`[Booking] ✅ Confirmed appointmentId: ${booked[0]?.appointmentId}`);

      // Fire-and-forget SMS confirmation (don't block the call)
      const smsPhone = callerNumber || patientForBooking?.patientPhoneNumber;
      const smsSent = !!(chosenSlot && patientForBooking && smsPhone);
      if (smsSent) {
        sendBookingConfirmation({
          patientName: patientForBooking.patientName,
          phoneNumber: smsPhone,
          displayDate: chosenSlot.displayDate,
          displayTime: chosenSlot.displayTime,
          medicName:   chosenSlot.medicName,
          date:        chosenSlot.date,
          time:        chosenSlot.time,
          reasonText:  params._bookingReasonText || params.motiveName || '',
        }).catch(err => console.error('[SMS] Background send failed:', err.message));
      }

      return {
        appointmentId: booked[0]?.appointmentId,
        bookedSlot:    chosenSlot,   // passed back so confirmation speaks correct doctor/time
        smsSent,                     // so the spoken confirmation only claims a text if one went out
        patient: patientForBooking,
        patientCreated: patientResolution.created,
        patientResolvedExisting: patientResolution.resolvedExisting,
      };
    }

    case 'cancel_appointment': {
      // Resolve real appointmentId server-side from pendingAppts — never trust AI-provided ID
      let resolvedId = params.appointmentId;
      let cancelledAppt = null;
      if (params._pendingAppts && params._pendingAppts.length > 0) {
        const match = params._pendingAppts.find(a => String(a.appointmentId) === String(params.appointmentId))
          || params._pendingAppts[0]; // default to first if only one
        if (match) {
          resolvedId = match.appointmentId;
          cancelledAppt = match;
        }
      }
      const result = await newsoft.cancelAppointment({
        appointmentId: resolvedId,
        reason: params.reason || 'Cancelada pelo paciente via Vicki AI',
      });
      if (!result?.appointmentCanceled) {
        return { cancelled: false, error: 'Newsoft did not confirm cancellation' };
      }

      // Fire-and-forget SMS cancellation notification
      if (patient) {
        cancelledAppt = cancelledAppt || params._pendingAppts?.find(a => String(a.appointmentId) === String(resolvedId));
        sendCancellationConfirmation({
          patientName: patient.patientName,
          phoneNumber: callerNumber || patient.patientPhoneNumber,
          displayDate: cancelledAppt?.displayDate,
          displayTime: cancelledAppt?.displayTime,
          medicName:   cancelledAppt?.medicName || cancelledAppt?.doctor,
          date:        cancelledAppt?.date,
        }).catch(err => console.error('[SMS] Cancel SMS failed:', err.message));
      }

      const remainingAppointments = (params._pendingAppts || [])
        .filter(a => String(a.appointmentId) !== String(resolvedId));

      return { cancelled: true, cancelledAppointment: cancelledAppt, remainingAppointments };
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// AGENT PROMPT SELECTOR
// Returns the system prompt for the active agent.
// ─────────────────────────────────────────────
function normalizeForIntent(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCallerLanguage(userText = '', previous = 'unknown') {
  const text = normalizeForIntent(userText);
  if (!text || userText === '[continua]') return previous || 'unknown';

  const ptSignals = /\b(ola|bom dia|boa tarde|consulta|marcar|desmarcar|remarcar|obrigad[ao]|sim|nao|dor|dente|medico|doutor|doutora|seguro|preco|quanto custa|horario|morada|amanha|hoje)\b/.test(text);
  const enSignals = /\b(hello|hi|book|schedule|appointment|consultation|doctor|dentist|cleaning|cancel|reschedule|come in|available|see me|this week|next week|price|cost|insurance|speak english|do you speak|real person|talk to someone|speak to someone|human|reception|manager|urgent|urgently|thanks|thank you|goodbye|bye)\b/.test(text);

  if (enSignals && !ptSignals) return 'en';
  if (ptSignals && !enSignals) return 'pt';
  if (/\b(do you speak english|can you speak english|speak english)\b/.test(text)) return 'en';
  return previous || 'unknown';
}

function speakIn(languageState, pt, en) {
  return languageState === 'en' ? en : pt;
}

function deterministicTransferOverride(currentAgent, userText, languageState, patient) {
  if (!userText || userText === '[continua]') return null;
  const text = normalizeForIntent(userText);

  const emergency = /\b(severe|terrible|unbearable|emergency|urgent\w*|urgency|toothache|abscess|swelling|bleeding|knocked out|broke|broken tooth|acidente|urgente|urgencia|dor forte|muita dor|inchaco|sangramento|abcesso|dente partido)\b/.test(text);
  if (emergency && currentAgent !== 'emergency') {
    return {
      speak: speakIn(languageState, 'Lamento muito, vamos tratar disso imediatamente.', "I'm sorry to hear that, we'll deal with this right away."),
      action: 'transfer_to_emergency',
      currentAgent: 'emergency',
    };
  }

  const existingAppointment = /\b(tenho (alguma |uma |a )?consulta|consulta (marcada|agendada)|saber se tenho|verificar se tenho|ja tenho consulta|have an appointment|do i have an appointment|my appointment|next appointment)\b/.test(text);
  if (existingAppointment && currentAgent !== 'appointments') {
    return {
      speak: '',
      action: 'transfer_to_appointments',
      currentAgent: 'appointments',
    };
  }

  const human = /\b(real person|human|reception|receptionist|manager|complaint|billing|bill|overcharged|charged incorrectly|insurance|health plan|falar com alguem|pessoa real|rececao|gerente|reclamacao|faturacao|fatura|cobraram|seguro|subsistema|plano de saude)\b/.test(text);
  if (human && currentAgent !== 'human') {
    return {
      speak: speakIn(languageState, 'Claro, vou ligá-lo/a com a nossa equipa agora mesmo.', "Of course, I'll connect you with our team now."),
      action: 'transfer_to_human',
      currentAgent: 'human',
    };
  }

  const pricing = /\b(price|cost|charge|quote|how much|quanto custa|preco|custo|orcamento|honorarios)\b/.test(text);
  if (pricing && currentAgent !== 'info' && currentAgent !== 'emergency') {
    return {
      speak: speakIn(languageState, 'Boa pergunta, já lhe dou essa informação.', "Good question, I can help with that."),
      action: 'transfer_to_info',
      currentAgent: 'info',
    };
  }

  return null;
}

function deterministicRouterDecision(userText, languageState) {
  const text = normalizeForIntent(userText);
  if (!text) return null;

  if (/^(adeus|ate logo|ate ja|obrigad[ao]|era so isso|mais nada|foi tudo|bye|goodbye|thanks|thank you|that's all|nothing else)\b/.test(text)) {
    return {
      intent: 'goodbye',
      action: 'hangup',
      nextAgent: 'router',
      speak: speakIn(languageState, 'Muito obrigada por ligar para o Instituto Vilas Boas. Até logo!', 'Thank you for calling Instituto Vilas Boas. Goodbye!'),
    };
  }

  if (/\b(do you speak english|can you speak english|speak english|falam ingles|fala ingles)\b/.test(text)) {
    return {
      intent: 'info',
      action: 'none',
      nextAgent: 'info',
      speak: speakIn(languageState, 'Sim, a nossa equipa consegue ajudar em inglês. O que gostaria de saber?', 'Yes, our team can help in English. What would you like to know?'),
    };
  }

  const scheduleInfo = /\b(available on mondays?|available on tuesdays?|available on wednesdays?|available on thursdays?|available on fridays?|available on saturdays?|available on sundays?|dentist available today|doctor available today|medico disponivel hoje|dentista disponivel hoje|quando trabalha|que dias trabalha)\b/.test(text);
  if (scheduleInfo) {
    return {
      intent: 'info',
      action: 'none',
      nextAgent: 'info',
      speak: speakIn(languageState, 'Com todo o gosto, diga-me o que gostaria de saber.', 'Of course, what would you like to know?'),
    };
  }

  const booking = /\b(book|schedule|appointment|consultation|see a doctor|see the dentist|come in|available this week|available next week|can .* see me|marcar|agendar|consulta|ver um medico|vir esta semana|tem disponibilidade|pode ver-me)\b/.test(text);
  const existingAppointment = /\b(cancel|reschedule|postpone|change my appointment|move my appointment|push my appointment|have an appointment|my appointment tomorrow|what time .* appointment|forgot what time .* appointment|next appointment|do i have an appointment|confirm my appointment|cancelar|desmarcar|remarcar|mudar a consulta|a que horas e a minha consulta|tenho consulta|tenho alguma consulta|tenho uma consulta|consulta marcada|consulta agendada|saber se tenho|verificar se tenho|ja tenho consulta)\b/.test(text);
  if (existingAppointment) {
    return {
      intent: 'appointments',
      action: 'none',
      nextAgent: 'appointments',
      speak: speakIn(languageState, 'Claro, já verifico isso para si.', 'Of course, I can check that for you.'),
    };
  }
  if (booking) {
    return {
      intent: 'booking',
      action: 'none',
      nextAgent: 'booking',
      speak: speakIn(languageState, 'Claro, com todo o gosto. Qual é o motivo da consulta?', 'Of course, I can help with that. What is the reason for the appointment?'),
    };
  }

  const info = /\b(hours|opening|open|close|located|location|address|services|parking|weekend|saturday|doctor work|tell me about|horario|morada|onde ficam|servicos|estacionamento|sabado|fim de semana)\b/.test(text);
  if (info) {
    return {
      intent: 'info',
      action: 'none',
      nextAgent: 'info',
      speak: speakIn(languageState, 'Com todo o gosto, diga-me o que gostaria de saber.', 'Of course, what would you like to know?'),
    };
  }

  return null;
}

function getAgentPrompt(agentName, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory, languageState = 'unknown') {
  const louleDoctors  = cachedDoctors.filter(d => LOULE_DOCTOR_IDS.includes(d.medicId));
  const memoryContext = buildMemoryContext(patientMemory);

  switch (agentName) {
    case 'router':       return routerAgent.buildPrompt(patient, clinicInfo, memoryContext, languageState);
    case 'booking':      return bookingAgent.buildPrompt(patient, clinicInfo, louleDoctors, cachedMotives, memoryContext, languageState);
    case 'appointments': return appointmentsAgent.buildPrompt(patient, clinicInfo, memoryContext, languageState);
    case 'info':         return infoAgent.buildPrompt(patient, clinicInfo, memoryContext, languageState);
    case 'emergency':    return emergencyAgent.buildPrompt(patient, clinicInfo, memoryContext, languageState);
    default:             return routerAgent.buildPrompt(patient, clinicInfo, memoryContext, languageState);
  }
}

// ─────────────────────────────────────────────
// GENERATE CALL SUMMARY — runs after hangup
// Uses gpt-4o-mini (cheap + fast).
//
// STRICT RULE: only extract preferences the patient EXPLICITLY STATED.
// Never infer from which slot was booked or which doctor was available.
// ─────────────────────────────────────────────
async function generateCallSummary(history, patient) {
  try {
    const convo = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        if (m.role === 'user') return `Patient: ${m.content}`;
        try {
          const p = JSON.parse(m.content);
          return p.speak ? `Vicki: ${p.speak}` : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .join('\n');

    const summaryPrompt = [
      'You are analysing a dental clinic phone call transcript.',
      '',
      'Return ONLY valid JSON — no markdown, no explanation.',
      '',
      'STRICT RULES:',
      '- "explicitDoctorPreference": ONLY set if patient used words like "I prefer", "I always go to", "I want Dr. X". NOT just because they booked with that doctor.',
      '- "explicitTimePreference": ONLY set if patient said "I prefer mornings", "always in the afternoon", etc. NOT just because a morning slot was booked.',
      '- "language": "en" or "pt" based on what language the patient spoke.',
      '- "outcome": "booked" | "cancelled" | "info_given" | "transferred" | "no_action" | "abandoned"',
      '- "summary": one factual sentence. Do NOT mention preferences unless the patient explicitly stated them.',
      '- "flags": array of issues, e.g. ["no_slots_found","patient_confused","barge_in_heavy","language_switch","patient_declined_all_slots"] — empty array if none.',
      '',
      'JSON schema:',
      '{',
      '  "summary": "string",',
      '  "language": "en" | "pt",',
      '  "intent": "booking" | "appointments" | "info" | "emergency" | "general",',
      '  "outcome": "booked" | "cancelled" | "info_given" | "transferred" | "no_action" | "abandoned",',
      '  "explicitDoctorPreference": { "id": <number>, "name": "Dr. Name" } | null,',
      '  "explicitTimePreference": "morning" | "afternoon" | null,',
      '  "flags": []',
      '}',
    ].join('\n');

    const res = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0,
      max_tokens:  250,
      messages: [
        { role: 'system', content: summaryPrompt },
        { role: 'user',   content: convo || 'Very short call, no meaningful content.' },
      ],
    });

    const raw = res.choices[0].message.content.trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Memory] Summary error:', e.message);
    return { summary: 'Call completed.', language: null, intent: 'general', preferredDoctor: null, preferredTime: null };
  }
}

// ─────────────────────────────────────────────
// PROCESS TURN — Main entry point
// Called by callHandler.js on every patient utterance.
// ─────────────────────────────────────────────
async function processTurn({
  history,
  patient,
  clinicInfo,
  userText,
  cachedDoctors  = [],
  cachedMotives  = [],
  currentAgent   = 'router',
  unclearTurns   = 0,
  onSpeakReady   = null,
  pendingSlots   = [],
  offeredSlots   = [],   // every slot shown this call — never re-offer them on "another day"
  pendingAppts   = [],
  patientMemory  = null,
  lastOfferedDate = null,
  bookingReasonText = null,
  callerNumber = null,
  returnToAgent = null,   // agent to return to after a detour (e.g. info → booking)
  returnContext = {},     // saved state: { pendingSlots, bookingReasonText, lastOfferedDate }
  languageState = 'unknown',
}) {
  // ── Synthetic auto-speak trigger ─────────────────────────────────────────────
  // When userText === '[continua]' this is an internal trigger (not patient speech).
  // We inject a system instruction instead of polluting history with fake patient text.
  const isSyntheticTurn = userText === '[continua]';
  if (isSyntheticTurn) {
    // Different instruction per agent — appointments MUST call get_appointments first
    // to get real IDs before any cancel attempt
    const syntheticInstruction = currentAgent === 'appointments'
      ? `[INSTRUÇÃO INTERNA] Chama IMEDIATAMENTE get_appointments para carregar as consultas reais do paciente via API. ` +
        `Não uses dados de histórico — precisas dos appointmentIds reais para cancelar. ` +
        `Após receberes os resultados, apresenta ao paciente e pergunta o que quer fazer.`
      : `[INSTRUÇÃO INTERNA] Acabaste de ser activado como agente ${currentAgent}. ` +
        `Abre naturalmente: apresenta a informação relevante ou, se estás no contexto de marcação, ` +
        `oferece o slot que ficou pendente. Fala como se fosse a tua primeira frase neste turno.`;
    history.push({ role: 'system', content: syntheticInstruction });
  } else {
    history.push({ role: 'user', content: userText });
  }

  const nextLanguageState = detectCallerLanguage(userText, languageState);
  const finalize = (result) => ({ ...result, languageState: nextLanguageState });

  const transferOverride = deterministicTransferOverride(currentAgent, userText, nextLanguageState, patient);
  if (transferOverride) {
    const parsed = { speak: transferOverride.speak, action: transferOverride.action || 'none', intent: transferOverride.currentAgent, params: {} };
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });

    if (transferOverride.action === 'transfer_to_human') {
      const tSpeak = transferSpeak(patient, nextLanguageState);
      history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
      return finalize({
        speak: tSpeak,
        action: 'transfer_to_human',
        history,
        currentAgent: 'human',
        unclearTurns: 0,
        bookingReasonText,
      });
    }

    return finalize({
      speak: transferOverride.speak,
      action: 'none',
      history,
      currentAgent: transferOverride.currentAgent,
      unclearTurns: 0,
      bookingReasonText,
      autoSpeak: currentAgent !== transferOverride.currentAgent,
    });
  }

  if (currentAgent === 'router') {
    const routerDecision = deterministicRouterDecision(userText, nextLanguageState);
    if (routerDecision) {
      const parsed = {
        speak: routerDecision.speak,
        intent: routerDecision.intent,
        action: routerDecision.action || 'none',
        params: {},
      };
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });
      return finalize({
        speak: routerDecision.speak,
        action: routerDecision.action || 'none',
        history,
        currentAgent: routerDecision.nextAgent,
        unclearTurns: routerDecision.intent === 'unclear' ? unclearTurns + 1 : 0,
        bookingReasonText,
      });
    }
  }

  const systemPrompt = getAgentPrompt(currentAgent, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory, nextLanguageState);

  const modelStart = Date.now();
  let firstChunkAt = null;
  let speakReadyAt = null;
  let finishReason = null;

  console.log(`[AI] OpenAI request | model=${LIVE_AGENT_MODEL} agent=${currentAgent} history=${history.length}${isSyntheticTurn ? ' (autoSpeak)' : ''}`);


  // ── Stream GPT response — extract speak ASAP, start TTS before GPT finishes ──
  const stream = await openai.chat.completions.create({
    model:            LIVE_AGENT_MODEL,
    messages:         [{ role: 'system', content: systemPrompt }, ...history],
    temperature:      0.1,
    max_completion_tokens: 300,
    reasoning_effort: 'none',
    response_format:  { type: 'json_object' },
    stream:           true,
  });

  let fullText     = '';
  let speakFired   = false;

  for await (const chunk of stream) {
    if (!firstChunkAt) firstChunkAt = Date.now();
    finishReason = chunk.choices[0]?.finish_reason || finishReason;
    fullText += chunk.choices[0]?.delta?.content || '';

    // Extract speak field as soon as its closing quote appears in the stream
    if (!speakFired) {
      const m = fullText.match(/"speak"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
      if (m) {
        const earlySpeak = m[1]
          .replace(/\\n/g, ' ')
          .replace(/\\r/g, '')
          .replace(/\\t/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
        speakFired = true;
        speakReadyAt = Date.now();
        if (earlySpeak && onSpeakReady) onSpeakReady(earlySpeak);
      }
    }
  }

  const modelMs = Date.now() - modelStart;
  console.log(
    `[AI] OpenAI response | model=${LIVE_AGENT_MODEL} agent=${currentAgent} ` +
    `first_chunk_ms=${firstChunkAt ? firstChunkAt - modelStart : 'none'} ` +
    `speak_ready_ms=${speakReadyAt ? speakReadyAt - modelStart : 'none'} ` +
    `total_ms=${modelMs} finish=${finishReason || 'unknown'} chars=${fullText.length}`
  );

  let parsed;
  try {
    // Robust parser — AI sometimes returns two JSON objects concatenated (e.g. a reasoning step + final response).
    // Strategy: find all top-level JSON objects in the text, take the LAST complete one that has a 'speak' field.
    let jsonText = fullText.trim();

    // Try direct parse first (happy path)
    try {
      parsed = JSON.parse(jsonText);
    } catch (_) {
      // Extract all {...} top-level blocks and try each from last to first
      const blocks = [];
      let depth = 0, start = -1;
      for (let i = 0; i < jsonText.length; i++) {
        if (jsonText[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (jsonText[i] === '}') {
          depth--;
          if (depth === 0 && start !== -1) { blocks.push(jsonText.slice(start, i + 1)); start = -1; }
        }
      }
      // Parse all blocks that have an 'action' field, in order.
      const candidates = [];
      for (let i = 0; i < blocks.length; i++) {
        try {
          const c = JSON.parse(blocks[i]);
          if (c.action !== undefined) candidates.push({ idx: i, c });
        } catch (_) {}
      }
      if (!candidates.length) throw new Error('No valid JSON block with action found');

      // PREFER a block with a REAL action (not "none"/"hangup") — the LLM
      // sometimes appends a second "I can't do that / action: none" refusal
      // block AFTER the genuine action block. Taking the last block made Vicki
      // SAY she'd check slots (streamed from block 1) but then run block 2's
      // refusal — speaking one thing and doing another. Prefer the first
      // actionable block; fall back to the first block overall.
      const actionable = candidates.find(({ c }) => c.action && c.action !== 'none' && c.action !== 'hangup');
      const chosen = actionable || candidates[0];
      parsed = chosen.c;
      console.warn(`[AI] Double-JSON recovered — took block ${chosen.idx + 1} of ${blocks.length} (action=${parsed.action})`);
    }
  } catch (err) {
    console.error(
      `[AI] JSON parse failed | model=${LIVE_AGENT_MODEL} agent=${currentAgent} ` +
      `error=${err.message} raw=${JSON.stringify(fullText.slice(0, 500))}`
    );
    parsed = { speak: "Desculpe, não percebi bem — pode repetir?", action: 'none', intent: null };
  }

  let { speak, action = 'none', params = {}, intent } = parsed;
  let nextAgent = currentAgent;
  const updatedBookingReasonText = inferBookingReasonText(userText, params, bookingReasonText);
  const guarded = applyBookingStateGuard({
    currentAgent,
    action,
    speak,
    params,
    userText,
    pendingSlots,
    history,
    bookingReasonText: updatedBookingReasonText,
  });
  ({ action, speak, params } = guarded);
  parsed.action = action;
  parsed.speak = speak;
  parsed.params = params;

  // ── SMART GUARD: doctor fuzzy match — resolve mispronounced names on first try ──
  // "Carla de Lisboas" → Carla Vilas Boas, "Doutor Hermes" → Dr. Hermes, etc.
  // Fires BEFORE loop detector so the patient doesn't have to repeat themselves.
  if (
    currentAgent === 'booking' &&
    action === 'none' &&
    !pendingSlots?.length &&
    cachedDoctors?.length &&
    userText
  ) {
    // Normalize: strip accents, lowercase
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    const patientNorm = norm(userText);

    // Only try if patient seems to be naming a doctor (contains "dr", "doutor", or a known first name)
    const mentionsDoctor = /\b(dr[aª]?\.?|doutor[a]?)\b/i.test(userText) || cachedDoctors.some(d => {
      const firstName = norm(d.medicShortName || d.medicName).split(/\s+/).filter(p => p.length >= 4 && !/^dr[aª]?\.?$/.test(p))[0];
      return firstName && patientNorm.includes(firstName);
    });

    if (mentionsDoctor) {
      // Score each doctor by how many name parts match the patient text
      const candidates = cachedDoctors.map(doc => {
        const names = [doc.medicShortName, doc.medicName].filter(Boolean);
        let score = 0;
        let matchedParts = [];
        for (const name of names) {
          const parts = norm(name).split(/\s+/).filter(p => p.length >= 3 && !/^dr[aª]?\.?$/.test(p));
          for (const part of parts) {
            if (part.length >= 4 && patientNorm.includes(part)) {
              score += part.length; // longer matches = higher confidence
              matchedParts.push(part);
            }
          }
        }
        return { doc, score, matchedParts: [...new Set(matchedParts)] };
      }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);

      if (candidates.length === 1 || (candidates.length > 1 && candidates[0].score > candidates[1].score)) {
        // Confident single match
        const best = candidates[0];

        // Don't bulldoze a QUESTION into a slot search. If the LLM already named
        // this doctor AND is asking the patient something (e.g. "...only Dr.
        // Hermes. Would you like me to check his availability?"), it's seeking
        // confirmation — the patient merely mentioned the name in a question,
        // they did NOT commit to booking. Forcing check_slots here skips the
        // patient's choice of doctor / soonest-appointment preference.
        const llmSpeakNorm = norm(speak);
        const llmAlreadyHandling = /\?/.test(speak || '')
          && best.matchedParts.some(p => llmSpeakNorm.includes(p));

        if (llmAlreadyHandling) {
          console.log(`[Guard] DOCTOR MATCH skipped — LLM already named ${best.doc.medicShortName} and is awaiting the patient's confirmation.`);
        } else {
        console.log(`[Guard] DOCTOR MATCH — "${userText}" → ${best.doc.medicShortName} (id:${best.doc.medicId}) [matched: ${best.matchedParts.join(', ')}]`);

        // ── SPECIALTY CHECK: does this doctor actually do the requested treatment? ──
        const reasonForSpec = updatedBookingReasonText || params.reasonText || '';
        const specId = inferSpecialtyFromText(reasonForSpec);
        const specDocs = specId ? doctorsForSpecialty(specId, LOULE_DOCTOR_IDS) : [];
        const en = languageState === 'en';

        if (specId && specDocs.length && !specDocs.includes(best.doc.medicId)) {
          // Named doctor doesn't perform this treatment — be honest, offer the right ones.
          const spec = getSpecialty(specId);
          const specLabel = spec ? (en ? spec.en : spec.pt) : '';
          const rightNames = specDocs
            .map(id => cachedDoctors.find(d => d.medicId === id))
            .filter(Boolean)
            .map(d => spokenDoctorName(d.medicShortName || d.medicName));
          const list = rightNames.length === 1
            ? rightNames[0]
            : rightNames.slice(0, -1).join(', ') + (en ? ' or ' : ' ou ') + rightNames.slice(-1);
          console.warn(`[Specialty] Named doctor ${best.doc.medicId} does not do "${specId}". Offering: ${JSON.stringify(specDocs)}`);
          action = 'none';
          speak = en
            ? `For ${specLabel.toLowerCase()}, that's handled by ${list}. Would you like me to check their availability?`
            : `Para ${specLabel.toLowerCase()}, quem trata disso é ${list}. Quer que veja a disponibilidade?`;
          params = { ...params, motiveId: params.motiveId, reasonText: reasonForSpec };
        } else {
          action = 'check_slots';
          speak = `Claro, com ${spokenDoctorName(best.doc.medicShortName || best.doc.medicName)} - um momento, ja verifico a disponibilidade.`;
          params = {
            ...params,
            medicId: best.doc.medicId,
            motiveId: params.motiveId || 'ACH',
            reasonText: updatedBookingReasonText || params.reasonText,
          };
        }
        parsed.action = action;
        parsed.speak = speak;
        parsed.params = params;
        }
      }
    }
  }

  // ── HARD GUARD: loop detection → transfer to human after 3 repeats ──────────
  // If Vicki repeats the exact same message 3+ times, she's stuck and can't
  // understand the patient. Transfer the call instead of looping forever.
  if (action === 'none' && speak) {
    const speakNorm = (speak || '').trim().toLowerCase().slice(0, 80);
    const recentAssistant = (history || []).slice(-8)
      .filter(m => m.role === 'assistant')
      .map(m => {
        try {
          const p = JSON.parse(m.content);
          return (p.speak || '').trim().toLowerCase().slice(0, 80);
        } catch (_) { return ''; }
      })
      .filter(Boolean);

    const repeatCount = recentAssistant.filter(s => s === speakNorm).length;
    if (repeatCount >= 2) {  // current + 2 in history = 3 total
      console.log(`[Guard] LOOP DETECTED — Vicki repeated "${speakNorm.slice(0, 50)}..." ${repeatCount + 1} times. Transferring to human.`);
      action = 'transfer_to_human';
      speak = 'Peço desculpa — parece que não estou a conseguir ajudá-lo/a como deve ser. Vou passá-lo/a para um colega que poderá ajudar melhor.';
      parsed.action = action;
      parsed.speak = speak;
    }
  }

  // ── HARD GUARD: force book_appointment if AI skipped the API call ────────────
  // Catches ALL cases where AI confirmed booking but never called book_appointment:
  //   - action='none'   → AI spoke "Está tudo tratado!" without booking
  //   - action='hangup' → AI hung up after "Sim." without ever booking (this bug!)
  // If pendingSlots + known patient + patient confirmed → MUST book before anything else.
  if (
    currentAgent === 'booking' &&
    (action === 'none' || action === 'hangup') &&
    pendingSlots?.length > 0 &&
    patient?.patientId
  ) {
    const textLower  = (userText || '').toLowerCase();
    const isConfirmText  = /^(sim|ok|okay|claro|pode|por favor|confirmo|exato|certo|quero|vamos|vai|avança|marca|marque)\b/i.test(textLower);
    const isConfirmSpeak = /est[aá]\s*(tudo|marcad|feito|confirm|tratad|pronto)/i.test(speak || '');

    // ── SAFETY GATES — never auto-book unless the patient is actually confirming
    // the offered slot. These prevent the worst possible bug: booking a real
    // appointment (+ SMS) that the patient never agreed to.
    //  1. They rejected it / asked for another time / asked a question
    //     ("no", "another day", "are you sure?", "with Dr X?").
    //  2. Vicki herself is asking for more info (a date/time/name) — in that case
    //     a bare "ok" is answering her question, NOT confirming a booking.
    // We also no longer treat "two capitalised words" as a confirmation — that
    // matched doctor names (e.g. "Sylvia Suarez") and booked on a question.
    const isRejectionOrQuestion = /\?/.test(userText || '')
      || /\b(n[aã]o|nao|nope|not|don'?t|didn'?t|another|other|different|instead|outr[oa]|later|earlier|sooner|busy|ocupad|cancel|wait|are you sure|sure\?|change|mud[ae])\b/i.test(textLower);
    const vickiAskingForInfo = /\?/.test(speak || '')
      && /((what|which|que|qual|when|quando)[^?]{0,25}(day|dia|date|data|time|hora|name|nome))|need[^?]{0,15}(date|day|name)|preciso[^?]{0,15}(data|dia|nome)/i.test(speak || '');

    if ((isConfirmText || isConfirmSpeak) && !isRejectionOrQuestion && !vickiAskingForInfo) {
      // Infer chosenPeriod from recent conversation (last 6 turns) so we book the RIGHT slot.
      // Patient said "tarde" / "14h" / "afternoon" → tarde. "manhã" / "10h" / "morning" → manhã.
      const latestPeriod = inferLatestExplicitPeriodFromUser(history, params);
      let inferredPeriod = latestPeriod?.period || params.chosenPeriod || null;
      if (!inferredPeriod) {
        const recentText = history.slice(-6)
          .filter(m => m.role === 'user')
          .map(m => m.content || '')
          .join(' ')
          .toLowerCase();
        const recentAll = history.slice(-6).map(m => m.content || '').join(' ').toLowerCase();
        const isTarde = /\btarde\b|\bafternoon\b|\b1[4-9]h|\b1[4-9]:\d\d/.test(recentText + ' ' + recentAll);
        const isManha = /\bmanh[aã]\b|\bmorning\b|\b[89]h|\b1[0-2]h|\b[89]:\d\d|\b1[0-2]:\d\d/.test(recentText + ' ' + recentAll);
        if (isTarde && !isManha) inferredPeriod = 'tarde';
        else if (isManha && !isTarde) inferredPeriod = 'manhã';
        // If both found, prefer what patient said most recently
        else if (isTarde) inferredPeriod = 'tarde';
      }

      console.log(`[Guard] FORCE book_appointment — action was "${action}", slots pending, patient confirmed. ID: ${patient.patientId}, inferredPeriod: ${inferredPeriod || '(unknown)'}`);
      action = 'book_appointment';
      params = { ...params, _pendingSlots: pendingSlots, _bookingReasonText: updatedBookingReasonText };
      if (inferredPeriod) params.chosenPeriod = inferredPeriod;
      parsed.action = action;
      parsed.params = params;
      // If AI was hanging up mid-booking, give a neutral bridge while we process
      if (/adeus|até logo|obrigad/i.test(speak || '')) {
        speak = 'Um momento — a confirmar a sua marcação.';
        parsed.speak = speak;
      }
    }
  }

  // ── HARD GUARD: appointments agent MUST call get_appointments before speaking any data ──
  // This prevents the AI from hallucinating appointment info from call memory.
  // Rule: if appointments agent tries to speak (action=none) but we have no real API data
  // yet (pendingAppts is empty), force get_appointments first.
  if (
    currentAgent === 'appointments' &&
    action === 'none' &&
    !isSyntheticTurn &&
    pendingAppts?.length === 0
  ) {
    // Check if get_appointments has already been called in this session (look in history)
    const apptFetched = history.some(m => {
      try {
        const p = JSON.parse(m.content);
        return p.action === 'get_appointments';
      } catch (_) { return false; }
    });

    if (!apptFetched) {
      console.warn('[Guard] Appointments agent tried to speak without loading data — forcing get_appointments');
      action = 'get_appointments';
      speak  = 'Um momento — já verifico as suas consultas.';
      params = {};
      parsed.action = action;
      parsed.speak  = speak;
      parsed.params = params;
    }
  }

  console.log(`[Agent:${currentAgent}] intent="${intent}" action="${action}" speak="${speak?.slice(0, 60)}..."`);

  // ── 1. ROUTER / HUMAN: classify intent and switch to specialist ───
  // Runs for 'router' AND 'human' — so if human transfer happens but
  // patient keeps talking, we can still route them to the right agent.
  if (currentAgent === 'router' || currentAgent === 'human') {
    const intentMap = { booking: 'booking', appointments: 'appointments', info: 'info', emergency: 'emergency', human: 'human' };

    // Patient said goodbye at the very start — hang up gracefully
    if (intent === 'goodbye') {
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });
      return finalize({ speak, action: 'hangup', history, currentAgent: 'router', unclearTurns: 0, bookingReasonText: updatedBookingReasonText });
    }

    if (intent && intent !== 'unclear' && intentMap[intent]) {
      nextAgent = intentMap[intent];
      console.log(`[Agent] Switching: ${currentAgent} → ${nextAgent}`);
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });

      if (nextAgent === 'human') {
        const tSpeak = transferSpeak(patient, nextLanguageState);
        history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
        return finalize({
          speak: tSpeak,
          action: 'transfer_to_human',
          history,
          currentAgent: 'human',
          unclearTurns: 0,
          bookingReasonText: updatedBookingReasonText,
        });
      }

      // ── ROUTER COLLAPSE: instead of returning autoSpeak (2nd LLM call), run the
      // specialist agent immediately in the same turn. Saves ~800–1500ms per routed call.
      // The router's bridge phrase (speak) was already fired via onSpeakReady above;
      // we now immediately follow through with the specialist's first response.
      console.log(`[Agent] Router collapse: running ${nextAgent} inline (no 2nd LLM hop)`);
      const specialistPrompt = getAgentPrompt(nextAgent, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory, nextLanguageState);
      const specialistStart = Date.now();
      let sFirstChunkAt = null, sFullText = '', sSpeakFired = false, sFinishReason = null;

      const specialistStream = await openai.chat.completions.create({
        model:            LIVE_AGENT_MODEL,
        messages:         [{ role: 'system', content: specialistPrompt }, ...history],
        temperature:      0.1,
        max_completion_tokens: 300,
        reasoning_effort: 'none',
        response_format:  { type: 'json_object' },
        stream:           true,
      });

      for await (const chunk of specialistStream) {
        if (!sFirstChunkAt) sFirstChunkAt = Date.now();
        sFinishReason = chunk.choices[0]?.finish_reason || sFinishReason;
        sFullText += chunk.choices[0]?.delta?.content || '';
        if (!sSpeakFired) {
          const m = sFullText.match(/"speak"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
          if (m) {
            const earlySpeak = m[1].replace(/\\n/g,' ').replace(/\\r/g,'').replace(/\\t/g,' ').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
            sSpeakFired = true;
            if (earlySpeak && onSpeakReady) onSpeakReady(earlySpeak);
          }
        }
      }
      console.log(`[AI] Specialist inline | model=${LIVE_AGENT_MODEL} agent=${nextAgent} first_chunk_ms=${sFirstChunkAt ? sFirstChunkAt - specialistStart : 'none'} total_ms=${Date.now() - specialistStart}`);

      let sParsed;
      try { sParsed = JSON.parse(sFullText.trim()); }
      catch (_) { sParsed = { speak: speak || "Como posso ajudar?", action: 'none', params: {} }; }

      const sSpeak  = sParsed.speak  || speak;
      const sAction = sParsed.action || 'none';
      const sParams = sParsed.params || {};
      const sUpdatedReason = inferBookingReasonText(userText, sParams, updatedBookingReasonText);

      const sGuarded = applyBookingStateGuard({ currentAgent: nextAgent, action: sAction, speak: sSpeak, params: sParams, userText, pendingSlots, history, bookingReasonText: sUpdatedReason });

      history.push({ role: 'assistant', content: JSON.stringify({ speak: sGuarded.speak, action: sGuarded.action, params: sGuarded.params }) });

      // Handle API actions from specialist
      if (sGuarded.action && sGuarded.action !== 'none' && sGuarded.action !== 'hangup') {
        try {
          const enrichedSParams = sGuarded.action === 'check_slots'
            ? { ...sGuarded.params, _lastOfferedDate: lastOfferedDate, _slotSearchDirection: 'later', _datePref: resolveDatePreference(userText, new Date().toISOString().split('T')[0]), _bookingReasonText: sUpdatedReason, _pendingSlots: pendingSlots }
            : sGuarded.action === 'book_appointment'
              ? { ...sGuarded.params, _pendingSlots: pendingSlots, _bookingReasonText: sUpdatedReason }
              : sGuarded.action === 'cancel_appointment'
                ? { ...sGuarded.params, _pendingAppts: pendingAppts }
                : sGuarded.params;
          const sActionResult = await executeAction(sGuarded.action, enrichedSParams, patient, callerNumber, history, nextLanguageState);
          if (sActionResult) {
            const sFormatted = formatActionResponse(sGuarded.action, sActionResult, nextLanguageState);
            if (sFormatted) {
              if (sFormatted._slotsContext) history.push({ role: 'system', content: `Slots disponíveis encontrados:\n${sFormatted._slotsContext}\n\nUsa o slotBase64 correto quando o paciente confirmar.` });
              if (sFormatted._appointmentsContext) history.push({ role: 'system', content: `Consultas do paciente:\n${sFormatted._appointmentsContext}` });
              history.push({ role: 'assistant', content: JSON.stringify({ speak: sFormatted.speak, action: sFormatted.action || 'none', params: {} }) });
              return { ...finalize({ speak: sFormatted.speak, action: sFormatted.action || 'none', history, currentAgent: nextAgent, unclearTurns: 0, bookingReasonText: sUpdatedReason }), actionFired: sGuarded.action, pendingSlots: sFormatted.pendingSlots, pendingAppts: sFormatted.pendingAppointments, lastOfferedDate: sActionResult.lastOfferedDate ?? lastOfferedDate, patient: sActionResult.patient };
            }
          }
        } catch (sErr) {
          console.error(`[Agent:${nextAgent}] Inline action error:`, sErr.message);
        }
      }

      return finalize({ speak: sGuarded.speak, action: sGuarded.action, history, currentAgent: nextAgent, unclearTurns: 0, bookingReasonText: sUpdatedReason });
    }

    // Intent still unclear — transfer to human after 5 tries (avoids infinite loop)
    const newUnclearTurns = unclearTurns + 1;
    if (newUnclearTurns >= 5) {
      console.log('[Agent] Stuck after 5 unclear turns — transferring to human');
      const tSpeak = transferSpeak(patient, nextLanguageState);
      history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
      return finalize({ speak: tSpeak, action: 'transfer_to_human', history, currentAgent: 'human', unclearTurns: 0, bookingReasonText: updatedBookingReasonText });
    }

    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return finalize({ speak, action: 'none', history, currentAgent: 'router', unclearTurns: newUnclearTurns, bookingReasonText: updatedBookingReasonText });
  }

  // ── 2. TRANSFER ACTIONS ───────────────────────────────────
  if (action === 'transfer_to_human') {
    const tSpeak = transferSpeak(patient, nextLanguageState);
    history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
    return finalize({
      speak: tSpeak,
      action: 'transfer_to_human',
      history,
      currentAgent: 'human',
      bookingReasonText: updatedBookingReasonText,
    });
  }

  // ── Silent inter-agent transfers ──────────────────────────────────────
  // Any agent can hand off to any other agent. A hidden context summary
  // is injected into history so the receiving agent continues naturally.
  const AGENT_TRANSFER_MAP = {
    'transfer_to_booking':      'booking',
    'transfer_to_info':         'info',
    'transfer_to_appointments': 'appointments',
    'transfer_to_emergency':    'emergency',
  };
  if (AGENT_TRANSFER_MAP[action]) {
    const targetAgent = AGENT_TRANSFER_MAP[action];
    const ctx = buildTransferContext(currentAgent, userText, history, updatedBookingReasonText, pendingSlots);
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    history.push({ role: 'system', content: ctx });
    console.log(`[Agent] Silent transfer: ${currentAgent} → ${targetAgent}`);

    // ── SAVE return context when leaving booking mid-flow ──────────────────────────────
    // When booking asks about price or insurance and transfers to info/human,
    // we save returnToAgent='booking' so after the detour we can resume
    // with all the slot/reason context intact.
    let newReturnToAgent = returnToAgent;
    let newReturnContext = returnContext;
    if (currentAgent === 'booking' && (targetAgent === 'info' || targetAgent === 'human')) {
      newReturnToAgent = 'booking';
      newReturnContext = {
        pendingSlots:     pendingSlots,
        bookingReasonText: updatedBookingReasonText,
        lastOfferedDate:  lastOfferedDate,
      };
      console.log(`[Agent] Saved return context: will resume booking after ${targetAgent} detour`);
    }

    // ── RESTORE saved context when returning to booking ──────────────────────────────
    // Info agent told the patient about pricing and now transfers back to booking.
    // We restore the saved slots/reason so booking can offer them immediately.
    let restoredSlots = pendingSlots;
    let restoredReason = updatedBookingReasonText;
    let restoredLastDate = lastOfferedDate;
    let clearReturn = false;
    if (targetAgent === 'booking' && returnToAgent === 'booking' && returnContext) {
      restoredSlots     = returnContext.pendingSlots     || pendingSlots;
      restoredReason    = returnContext.bookingReasonText || updatedBookingReasonText;
      restoredLastDate  = returnContext.lastOfferedDate  || lastOfferedDate;
      clearReturn = true;
      // Inject a system message reminding the booking agent of the open slot offer
      if (restoredSlots?.length) {
        const slotSummary = restoredSlots
          .map(s => `${s.displayDate || s.date} às ${s.displayTime || s.time} com ${s.medicName}`)
          .join(', ');
        history.push({ role: 'system', content:
          `[RETOMA DA MARCAÇÃO] O paciente estava a marcar uma consulta. ` +
          `Slots já oferecidos: ${slotSummary}. ` +
          `Motivo: ${restoredReason || 'não especificado'}. ` +
          `Retoma naturalmente sem mencionar a transferência — pergunta qual slot prefere.`
        });
      }
      console.log(`[Agent] Restored booking context with ${restoredSlots?.length || 0} slots`);
    }

    return {
      speak: '',
      action: 'none',
      history,
      currentAgent:     targetAgent,
      bookingReasonText: restoredReason,
      pendingSlots:     restoredSlots,
      lastOfferedDate:  restoredLastDate,
      returnToAgent:    clearReturn ? null : newReturnToAgent,
      returnContext:    clearReturn ? {}   : newReturnContext,
      clearReturn,
      autoSpeak: true,   // ← tells callHandler to immediately fire the new agent without waiting for patient
    };
  }

  if (action === 'hangup') {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return finalize({ speak, action: 'hangup', history, currentAgent, bookingReasonText: updatedBookingReasonText });
  }

  // ── 3. API ACTIONS — execute + format programmatically ────
  if (action && action !== 'none') {
    try {
      // Inject server-side state into params so executeAction can resolve real IDs
      const enrichedParams = action === 'book_appointment'
        ? { ...params, _pendingSlots: pendingSlots, _bookingReasonText: updatedBookingReasonText }
        : action === 'cancel_appointment'
          ? { ...params, _pendingAppts: pendingAppts }
          : action === 'check_slots'
            ? {
                ...params,
                _lastOfferedDate: lastOfferedDate,
                _slotSearchDirection: params.searchDirection || inferSlotSearchDirection(userText),
                _explicitDateTo: explicitBeforeDateTo(userText, lastOfferedDate),
                _datePref: resolveDatePreference(userText, new Date().toISOString().split('T')[0]),
                _bookingReasonText: updatedBookingReasonText,
                _pendingSlots: pendingSlots,   // for doctor rotation on rejection
                _offeredSlots: offeredSlots,   // never re-offer any slot shown earlier this call
                _patientNamedDoctor: patientNamedDoctor(userText, cachedDoctors),
              }
            : params;
      const actionResult = await executeAction(action, enrichedParams, patient, callerNumber, history, nextLanguageState);
      if (actionResult) {
        const formatted = formatActionResponse(action, actionResult, nextLanguageState);
        if (formatted) {
          history.push({ role: 'assistant', content: JSON.stringify(parsed) });
          // If slots were returned, inject a system context message so the
          // booking agent knows ALL options without re-calling check_slots
          if (formatted._slotsContext) {
            history.push({ role: 'system', content: `Slots disponíveis encontrados:\n${formatted._slotsContext}\n\nUsa o slotBase64 correto quando o paciente confirmar uma opção.` });
          }
          if (formatted._appointmentsContext) {
            history.push({ role: 'system', content: `Consultas do paciente:\n${formatted._appointmentsContext}\n\nUsa os valores [ref:ID] apenas server-side para cancel_appointment. NUNCA reveles IDs ao paciente.` });
          }
          history.push({ role: 'assistant', content: JSON.stringify({ speak: formatted.speak, action: formatted.action || 'none', params: {} }) });
          return finalize({
            speak:           formatted.speak,
            action:          formatted.action || 'none',
            actionFired:     action,
            history,
            currentAgent:    nextAgent,
            pendingSlots:    formatted.pendingSlots,
            pendingAppts:    formatted.pendingAppointments,
            lastOfferedDate: actionResult.lastOfferedDate ?? lastOfferedDate,
            bookingReasonText: updatedBookingReasonText,
            patient:         actionResult.patient,
          });
        }
      }
    } catch (err) {
      console.error(`[Agent:${currentAgent}] Action error:`, err.message);
      // On any API/booking error → transfer to human with a warm apology
      const tSpeak = transferSpeak(patient, nextLanguageState);
      const errSpeak = `Peço desculpa — não foi possível concluir a operação no nosso sistema. ${tSpeak}`;
      history.push({ role: 'assistant', content: JSON.stringify({ speak: errSpeak, action: 'transfer_to_human' }) });
      return finalize({ speak: errSpeak, action: 'transfer_to_human', history, currentAgent: 'human', bookingReasonText: updatedBookingReasonText });
    }
  } else {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
  }

  return finalize({ speak, action, history, currentAgent: nextAgent, bookingReasonText: updatedBookingReasonText });
}

module.exports = { processTurn, generateCallSummary, resolveDatePreference };
