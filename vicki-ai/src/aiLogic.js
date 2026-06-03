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

const routerAgent       = require('./agents/routerAgent');
const bookingAgent      = require('./agents/bookingAgent');
const appointmentsAgent = require('./agents/appointmentsAgent');
const infoAgent         = require('./agents/infoAgent');
const emergencyAgent    = require('./agents/emergencyAgent');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { LOULE_DOCTOR_IDS } = bookingAgent;

// ─────────────────────────────────────────────
// HUMAN DATE/TIME FORMATTER
// "2026-06-03T14:45:00" → "next Tuesday at quarter to three in the afternoon"
// ─────────────────────────────────────────────
function humanSlot(isoString) {
  const date    = new Date(isoString);
  const now     = new Date();
  const today   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const slotDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((slotDay - today) / 86400000);

  const weekday = date.toLocaleDateString('en-GB', { weekday: 'long' });
  let dayName;
  if      (diffDays === 0)              dayName = 'today';
  else if (diffDays === 1)              dayName = 'tomorrow';
  else if (diffDays < 7)               dayName = `this ${weekday}`;
  else if (diffDays < 14)              dayName = `next ${weekday}`;
  else {
    // 2+ weeks away — use actual date to avoid ambiguity ("Tuesday the 16th")
    const day = date.getDate();
    const suffix = day === 1 || day === 21 || day === 31 ? 'st'
                 : day === 2 || day === 22 ? 'nd'
                 : day === 3 || day === 23 ? 'rd' : 'th';
    dayName = `${weekday} the ${day}${suffix}`;
  }

  const h   = date.getHours();
  const m   = date.getMinutes();
  const period = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  // 12h numeric format with am/pm — ElevenLabs reads '11:30am' naturally,
  // avoids '17:00' being spoken as 'seventeen hundred'
  const h12 = h % 12 || 12;
  const timeStr = m === 0
    ? `${h12}${h < 12 ? 'am' : 'pm'}`
    : `${h12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;

  return { dayName, timeStr, period };
}

// Format a slot for speech: just the time + period, no day
function slotTime(isoString) {
  const t = humanSlot(isoString);
  return `${t.timeStr} in the ${t.period}`;
}
// Day label only
function slotDay(isoString) {
  return humanSlot(isoString).dayName;
}

// ─────────────────────────────────────────────
// PROGRAMMATIC RESPONSE FORMATTER
// Converts raw Newsoft API data into spoken text.
// Eliminates the second OpenAI call — saves ~1.5s per action.
// ─────────────────────────────────────────────
function formatActionResponse(action, actionResult) {
  switch (action) {

    case 'check_slots': {
      const slots = actionResult.slots || [];
      if (!slots.length) {
        return {
          speak: "I'm sorry, there are no free slots with that doctor in the next 6 weeks. Would you like me to check a different doctor?",
          action: 'none',
        };
      }

      const morning   = slots.find(s => s.period === 'morning');
      const afternoon = slots.find(s => s.period !== 'morning');
      const options   = [morning, afternoon].filter(Boolean);

      let speak;
      if (options.length === 1) {
        const s = options[0];
        const t = humanSlot(s.date + 'T' + s.time);
        speak = `I've got ${t.dayName} at ${t.timeStr} with ${s.medicName} — does that work for you?`;
      } else {
        const [am, pm] = options;
        const amT = humanSlot(am.date + 'T' + am.time);
        const pmT = humanSlot(pm.date + 'T' + pm.time);
        const day = amT.dayName === pmT.dayName ? amT.dayName : `${amT.dayName} or ${pmT.dayName}`;

        if (am.medicName === pm.medicName) {
          // Same doctor — don't repeat name twice
          speak = `I've got ${day} with ${am.medicName} — ${amT.timeStr} in the morning or ${pmT.timeStr} in the afternoon. Which works better for you?`;
        } else {
          speak = `I've got ${day} — ${amT.timeStr} with ${am.medicName}, or ${pmT.timeStr} with ${pm.medicName}. Which works better for you?`;
        }
      }

      return {
        speak,
        action: 'none',
        pendingSlots: slots,
        // Store FULL slotBase64 so AI can copy it correctly — no truncation
        _slotsContext: options.map((s, i) =>
          `Option ${i+1} (${s.period}): ${humanSlot(s.date+'T'+s.time).dayName} at ${humanSlot(s.date+'T'+s.time).timeStr} in the ${s.period} with ${s.medicName}\nslotBase64=${s.slotBase64}`
        ).join('\n\n'),
      };
    }

    case 'get_appointments': {
      const appts = actionResult.appointments || [];
      if (!appts.length) {
        return { speak: "You don't have any upcoming appointments with us at the moment.", action: 'none' };
      }
      const a = appts[0];
      const more = appts.length > 1 ? ` You have ${appts.length} appointments in total.` : '';
      return {
        speak: `Your next appointment is ${a.display}.${more} Is there anything you'd like to do with it?`,
        action: 'none',
        pendingAppointments: appts,
        // Store appointmentIds in history so AI can reference them for cancel
        _appointmentsContext: appts.map((ap, i) =>
          `Appointment ${i+1}: ${ap.display} [ref:${ap.appointmentId}]`
        ).join('\n'),
      };
    }

    case 'book_appointment':
      return {
        speak: `Perfect — you're all booked! We'll see you then. Is there anything else I can help you with?`,
        action: 'none',
      };

    case 'cancel_appointment':
      if (!actionResult.cancelled) {
        return {
          speak: `I'm sorry, I wasn't able to cancel that appointment. Please call us directly and we'll sort it out for you.`,
          action: 'none',
        };
      }
      return {
        speak: `Done — that's cancelled. Would you like me to find you a new slot?`,
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
async function executeAction(action, params, patient) {
  switch (action) {

    case 'check_slots': {
      const today    = new Date().toISOString().split('T')[0];
      const maxDate  = new Date(Date.now() + 28 * 86400000).toISOString().split('T')[0]; // 28 days — Newsoft API caps at 30
      // Sanitize motiveId — guard against string "undefined" or "null"
      const rawMotive = params.motiveId;
      const motiveId  = rawMotive && rawMotive !== 'undefined' && rawMotive !== 'null'
        ? rawMotive : null;
      const medicId   = params.medicId && params.medicId !== 'undefined' && params.medicId !== 'null'
        ? params.medicId : null;
      const raw = await newsoft.getAvailableSlots({
        medicId,
        motiveId,
        dateFrom: today,
        dateTo:   maxDate,
      });
      if (!raw.length) return { slots: [] };

      // Pick exactly 1 morning (before 13:00) and 1 afternoon/evening (≥13:00)
      // so Vicki always offers just 2 clear choices, never a long list
      const toSlot = s => ({
        slotBase64: s.appointmentSlotBase64RawData,
        medicName:  s.medicShortName || s.medicName,
        date:       s.appointmentDateBegin?.split('T')[0],
        time:       s.appointmentDateBegin?.split('T')[1]?.slice(0, 5),
        display:    s.appointmentEnglishMessage,
        period:     (() => { const h = parseInt(s.appointmentDateBegin?.split('T')[1] || '0'); return h < 13 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; })(),
      });

      const morning   = raw.find(s => parseInt(s.appointmentDateBegin?.split('T')[1] || '0') < 13);
      const afternoon = raw.find(s => parseInt(s.appointmentDateBegin?.split('T')[1] || '0') >= 13);
      const slots = [morning, afternoon].filter(Boolean).map(toSlot);
      return { slots: slots.length ? slots : [toSlot(raw[0])] };
    }

    case 'get_appointments': {
      if (!patient) return { appointments: [] };
      const raw = await newsoft.getPatientAppointments(patient.patientId);
      if (!raw.length) return { appointments: [] };
      const appointments = raw.map(a => {
        const iso = a.appointmentDateBegin || (a.appointmentDate + 'T' + (a.appointmentTime || '00:00'));
        const t   = humanSlot(iso);
        return {
          appointmentId: a.appointmentId,
          display: `${t.dayName} at ${t.timeStr} in the ${t.period} with ${a.medicName || a.medicShortName}`,
          doctor:  a.medicName || a.medicShortName,
          date:    a.appointmentDateBegin || a.appointmentDate,
        };
      });
      return { appointments };
    }

    case 'book_appointment': {
      if (!patient) return { error: 'No patient on file — cannot book.' };
      // Prefer server-side pendingSlots lookup to avoid AI copying truncated slotBase64
      let resolvedBase64 = params.slotBase64;
      if (params._pendingSlots && params._pendingSlots.length > 0) {
        const chosen = params._pendingSlots.find(s => s.period === params.chosenPeriod)
          || params._pendingSlots.find(s => s.slotBase64?.startsWith(params.slotBase64?.slice(0, 10)))
          || params._pendingSlots[0];
        if (chosen) resolvedBase64 = chosen.slotBase64;
      }
      const booked = await newsoft.bookAppointment({
        patientId:   patient.patientId,
        slotBase64:  resolvedBase64,
        motiveName:  params.motiveName || 'Consulta',
        observation: 'Marcação via Vicki AI',
      });
      return { appointmentId: booked[0]?.appointmentId };
    }

    case 'cancel_appointment': {
      // Resolve real appointmentId server-side from pendingAppts — never trust AI-provided ID
      let resolvedId = params.appointmentId;
      if (params._pendingAppts && params._pendingAppts.length > 0) {
        const match = params._pendingAppts.find(a => String(a.appointmentId) === String(params.appointmentId))
          || params._pendingAppts[0]; // default to first if only one
        if (match) resolvedId = match.appointmentId;
      }
      const result = await newsoft.cancelAppointment({
        appointmentId: resolvedId,
        reason: params.reason || 'Cancelada pelo paciente via Vicki AI',
      });
      if (!result?.appointmentCanceled) {
        return { cancelled: false, error: 'Newsoft did not confirm cancellation' };
      }
      return { cancelled: true };
    }

    default:
      return null;
  }
}

// ─────────────────────────────────────────────
// AGENT PROMPT SELECTOR
// Returns the system prompt for the active agent.
// ─────────────────────────────────────────────
function getAgentPrompt(agentName, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory) {
  const louleDoctors  = cachedDoctors.filter(d => LOULE_DOCTOR_IDS.includes(d.medicId));
  const memoryContext = buildMemoryContext(patientMemory);

  switch (agentName) {
    case 'router':       return routerAgent.buildPrompt(patient, clinicInfo, memoryContext);
    case 'booking':      return bookingAgent.buildPrompt(patient, clinicInfo, louleDoctors, cachedMotives, memoryContext);
    case 'appointments': return appointmentsAgent.buildPrompt(patient, clinicInfo, memoryContext);
    case 'info':         return infoAgent.buildPrompt(patient, clinicInfo, memoryContext);
    case 'emergency':    return emergencyAgent.buildPrompt(patient, clinicInfo, memoryContext);
    default:             return routerAgent.buildPrompt(patient, clinicInfo, memoryContext);
  }
}

// ─────────────────────────────────────────────
// GENERATE CALL SUMMARY — runs after hangup
// Uses gpt-4o-mini (cheap + fast) to extract:
//   summary, language, preferredDoctor, preferredTime
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

    const res = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0,
      max_tokens:  200,
      messages: [
        {
          role:    'system',
          content: `Summarise this dental clinic call in 1 sentence. Extract preferences.
Reply ONLY with valid JSON — no markdown:
{
  "summary": "One sentence describing what happened",
  "language": "en" or "pt",
  "intent": "booking" | "appointments" | "info" | "emergency" | "general",
  "preferredDoctor": { "id": <medicId number>, "name": "Dr. Name" } or null,
  "preferredTime": "morning" | "afternoon" or null
}`,
        },
        { role: 'user', content: convo || 'Short call, no meaningful content.' },
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
  pendingAppts   = [],
  patientMemory  = null,   // loaded once at call start — used to personalise all agents
}) {
  history.push({ role: 'user', content: userText });

  const systemPrompt = getAgentPrompt(currentAgent, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory);

  // ── Stream GPT response — extract speak ASAP, start TTS before GPT finishes ──
  const stream = await openai.chat.completions.create({
    model:       'gpt-4o',
    messages:    [{ role: 'system', content: systemPrompt }, ...history],
    temperature: 0.3,
    max_tokens:  300,
    stream:      true,
  });

  let fullText     = '';
  let speakFired   = false;

  for await (const chunk of stream) {
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
        if (earlySpeak && onSpeakReady) onSpeakReady(earlySpeak);
      }
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(fullText);
  } catch {
    parsed = { speak: "Sorry, I didn't quite catch that — could you say it again?", action: 'none', intent: null };
  }

  let { speak, action = 'none', params = {}, intent } = parsed;
  let nextAgent = currentAgent;

  console.log(`[Agent:${currentAgent}] intent="${intent}" action="${action}" speak="${speak?.slice(0, 60)}..."`);

  // ── 1. ROUTER / HUMAN: classify intent and switch to specialist ───
  // Runs for 'router' AND 'human' — so if human transfer happens but
  // patient keeps talking, we can still route them to the right agent.
  if (currentAgent === 'router' || currentAgent === 'human') {
    const intentMap = { booking: 'booking', appointments: 'appointments', info: 'info', emergency: 'emergency', human: 'human' };

    // Patient said goodbye at the very start — hang up gracefully
    if (intent === 'goodbye') {
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });
      return { speak, action: 'hangup', history, currentAgent: 'router', unclearTurns: 0 };
    }

    if (intent && intent !== 'unclear' && intentMap[intent]) {
      nextAgent = intentMap[intent];
      console.log(`[Agent] Switching: ${currentAgent} → ${nextAgent}`);
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });

      if (nextAgent === 'human') {
        return {
          speak: speak || "Of course — let me connect you with our team right away. One moment please.",
          action: 'transfer_to_human',
          history,
          currentAgent: 'human',
          unclearTurns: 0,
        };
      }

      return { speak, action: 'none', history, currentAgent: nextAgent, unclearTurns: 0 };
    }

    // Intent still unclear — transfer to human after 3 tries (avoids infinite loop)
    const newUnclearTurns = unclearTurns + 1;
    if (newUnclearTurns >= 3) {
      console.log('[Agent] Stuck after 3 unclear turns — transferring to human');
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });
      const firstName = patient?.patientName?.split(' ')[0];
      const fallbackSpeak = firstName
        ? `Sorry ${firstName}, let me connect you with one of our team members who can help you directly — one moment please.`
        : `Let me connect you with one of our team who can help you directly — one moment please.`;
      return { speak: fallbackSpeak, action: 'transfer_to_human', history, currentAgent: 'human', unclearTurns: 0 };
    }

    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return { speak, action: 'none', history, currentAgent: 'router', unclearTurns: newUnclearTurns };
  }

  // ── 2. TRANSFER ACTIONS ───────────────────────────────────
  if (action === 'transfer_to_human') {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return {
      speak: speak || "Let me connect you with our team right away — please hold.",
      action: 'transfer_to_human',
      history,
      currentAgent: 'human',
    };
  }

  if (action === 'transfer_to_booking') {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return { speak, action: 'none', history, currentAgent: 'booking' };
  }

  if (action === 'hangup') {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return { speak, action: 'hangup', history, currentAgent };
  }

  // ── 3. API ACTIONS — execute + format programmatically ────
  if (action && action !== 'none') {
    try {
      // Inject server-side state into params so executeAction can resolve real IDs
      const enrichedParams = action === 'book_appointment'
        ? { ...params, _pendingSlots: pendingSlots }
        : action === 'cancel_appointment'
          ? { ...params, _pendingAppts: pendingAppts }
          : params;
      const actionResult = await executeAction(action, enrichedParams, patient);
      if (actionResult) {
        const formatted = formatActionResponse(action, actionResult);
        if (formatted) {
          history.push({ role: 'assistant', content: JSON.stringify(parsed) });
          // If slots were returned, inject a system context message so the
          // booking agent knows ALL options without re-calling check_slots
          if (formatted._slotsContext) {
            history.push({ role: 'system', content: `Available slots found:\n${formatted._slotsContext}\n\nUse the correct slotBase64 when the patient confirms a specific option.` });
          }
          if (formatted._appointmentsContext) {
            history.push({ role: 'system', content: `Patient appointments:\n${formatted._appointmentsContext}\n\nUse the [ref:ID] values server-side only for cancel_appointment. Never reveal IDs to the patient.` });
          }
          history.push({ role: 'assistant', content: JSON.stringify({ speak: formatted.speak, action: 'none', params: {} }) });
          return {
            speak:           formatted.speak,
            action:          'none',
            actionFired:     action,
            history,
            currentAgent:    nextAgent,
            pendingSlots:    formatted.pendingSlots,
            pendingAppts:    formatted.pendingAppointments,
          };
        }
      }
    } catch (err) {
      console.error(`[Agent:${currentAgent}] Action error:`, err.message);
      // Stay in current agent — don't transfer to human just because the API failed
      // Give a helpful spoken message so the patient knows what happened
      const errSpeak = currentAgent === 'booking'
        ? "I'm sorry, I had a problem reaching the scheduling system. Could you try saying the doctor's name and reason again?"
        : "I'm having a small technical issue — please hold a moment and I'll try again.";
      history.push({ role: 'assistant', content: JSON.stringify({ speak: errSpeak, action: 'none' }) });
      return { speak: errSpeak, action: 'none', history, currentAgent };
    }
  } else {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
  }

  return { speak, action, history, currentAgent: nextAgent };
}

module.exports = { processTurn, generateCallSummary };
