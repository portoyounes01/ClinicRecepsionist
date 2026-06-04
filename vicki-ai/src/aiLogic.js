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
const { LOULE_DOCTOR_IDS } = bookingAgent;
const LIVE_AGENT_MODEL = 'gpt-5.4-mini';

// ─────────────────────────────────────────────
// TRANSFER SPEAK — mandatory hold message
// Called before EVERY transfer_to_human.
// Varies naturally so it never sounds scripted.
// ─────────────────────────────────────────────
function transferSpeak(patient) {
  const firstName = patient?.patientName?.split(' ')[0];
  const name = firstName ? `, ${firstName}` : '';
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
function humanSlot(isoString) {
  // IMPORTANT: Newsoft returns local Lisbon time (e.g. '2026-06-18T14:00:00') with NO timezone suffix.
  // Using new Date() would treat it as UTC and add +1h offset. Parse manually to avoid this.
  const [datePart, timePart] = isoString.split('T');
  const [year, month, day]   = datePart.split('-').map(Number);
  const [hh, mm]             = (timePart || '00:00').split(':').map(Number);

  // Build a local Date just for weekday/month name (day-of-week)
  const date     = new Date(year, month - 1, day);
  const now      = new Date();
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((date - today) / 86400000);

  const weekday   = date.toLocaleDateString('pt-PT', { weekday: 'long' });
  const monthName = date.toLocaleDateString('pt-PT', { month: 'long' });

  let dayName;
  if      (diffDays === 0) dayName = 'hoje';
  else if (diffDays === 1) dayName = 'amanhã';
  else if (diffDays <= 6)  dayName = `esta ${weekday}`;
  else                     dayName = `${weekday}, dia ${day} de ${monthName}`;

  const period  = hh < 12 ? 'manhã' : hh < 18 ? 'tarde' : 'noite';
  const timeStr = mm === 0
    ? `${String(hh).padStart(2,'0')}h`
    : `${String(hh).padStart(2,'0')}h${String(mm).padStart(2,'0')}`;

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
  return new Date(new Date(dateString + 'T00:00:00').getTime() + days * 86400000)
    .toISOString()
    .split('T')[0];
}

function inferSlotSearchDirection(userText) {
  const text = (userText || '').toLowerCase();
  if (/\b(before|earlier|sooner|closer)\b/.test(text)) return 'earlier';
  return 'later';
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
  return addDaysIso(target.toISOString().split('T')[0], -1);
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
function formatActionResponse(action, actionResult) {
  switch (action) {

    case 'check_slots': {
      const slots = actionResult.slots || [];
      if (!slots.length) {
        if (actionResult.searchDirection === 'earlier') {
          return {
            speak: "Neste momento não vejo nada mais cedo. O último slot que ofereci continua a ser o mais próximo que encontro. Quer ficar com esse?",
            action: 'none',
          };
        }
        return {
          speak: "Peço desculpa, não há vagas livres com esse médico nas próximas 4 semanas. Quer que verifique com outro médico?",
          action: 'none',
        };
      }

      // Split into morning (before 13h) and afternoon (13h+)
      const morningSlots   = slots.filter(s => s.period === 'manhã');
      const afternoonSlots = slots.filter(s => s.period !== 'manhã');

      let speak;
      const sameDoctor = slots.every(s => s.medicName === slots[0].medicName);
      const sameDay    = slots.every(s => s.date === slots[0].date);
      const dayLabel   = sameDay ? humanSlot(slots[0].date + 'T' + slots[0].time).dayName : null;

      if (morningSlots.length >= 1 && afternoonSlots.length >= 1) {
        // Has both morning and afternoon
        const am1 = humanSlot(morningSlots[0].date + 'T' + morningSlots[0].time);
        const pm1 = humanSlot(afternoonSlots[0].date + 'T' + afternoonSlots[0].time);
        if (sameDoctor) {
          speak = `Tenho ${am1.dayName} — ${am1.timeStr} de manhã ou ${pm1.timeStr} de tarde, ambos com ${slots[0].medicName}. Qual prefere?`;
        } else {
          speak = `Tenho ${am1.dayName} às ${am1.timeStr} com ${morningSlots[0].medicName}, ou ${pm1.timeStr} de tarde com ${afternoonSlots[0].medicName}. Qual prefere?`;
        }
      } else if (morningSlots.length >= 2) {
        // Only morning, 2 options
        const [m1, m2] = morningSlots.map(s => humanSlot(s.date + 'T' + s.time));
        speak = `Tenho ${m1.dayName} às ${m1.timeStr} ou às ${m2.timeStr}, ambos de manhã${sameDoctor ? ' com ' + slots[0].medicName : ''}. Qual prefere?`;
      } else if (afternoonSlots.length >= 2) {
        // Only afternoon, 2 options
        const [p1, p2] = afternoonSlots.map(s => humanSlot(s.date + 'T' + s.time));
        speak = `Tenho ${p1.dayName} às ${p1.timeStr} ou às ${p2.timeStr}, ambos de tarde${sameDoctor ? ' com ' + slots[0].medicName : ''}. Qual prefere?`;
      } else {
        // Single slot
        const s = slots[0];
        const t = humanSlot(s.date + 'T' + s.time);
        speak = `Tenho vaga ${t.dayName} às ${t.timeStr} com ${s.medicName} — assim está bem para si?`;
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
        return { speak: "Neste momento não tem nenhuma consulta agendada connosco.", action: 'none' };
      }
      const a = appts[0];
      const more = appts.length > 1 ? ` Tem ${appts.length} consultas no total.` : '';
      return {
        speak: `A sua próxima consulta é ${a.display}.${more} Deseja fazer alguma alteração?`,
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
          speak: actionResult.speak || "Consigo marcar — pode dizer-me o seu nome completo para o ficheiro do paciente?",
          action: 'none',
        };
      }
      if (actionResult.error || !actionResult.appointmentId) {
        return {
          speak: "Peço desculpa, não foi possível concluir a marcação no nosso sistema. Um momento — vou ligá-lo/a com um membro da nossa equipa que resolve isto imediatamente.",
          action: 'transfer_to_human',
        };
      }
      {
        // Use the ACTUAL booked slot details for confirmation — never trust AI's memory of what it offered
        const bs = actionResult.bookedSlot;
        const confirmSpeak = bs
          ? `Perfeito — está tudo marcado! Esperamo-lo/a ${bs.displayDate || bs.date} às ${bs.displayTime || bs.time} com ${bs.medicName}. Posso ajudar em mais alguma coisa?`
          : `Perfeito — está tudo marcado! Esperamo-lo/a com muito gosto. Posso ajudar em mais alguma coisa?`;
        return { speak: confirmSpeak, action: 'none' };
      }


    case 'cancel_appointment':
      if (!actionResult.cancelled) {
        return {
          speak: `Peço desculpa, não foi possível cancelar no nosso sistema. Um momento — vou ligá-lo/a com alguém da nossa equipa que trata disto para si.`,
          action: 'transfer_to_human',
        };
      }
      return {
        speak: `Pronto, está cancelado. Sei que às vezes surgem imprevistos — quer que encontre outra vaga para não perder o seu lugar?`,
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
async function executeAction(action, params, patient, callerNumber, history = []) {
  switch (action) {

    case 'check_slots': {
      const today    = new Date().toISOString().split('T')[0];
      const maxDate  = new Date(Date.now() + 28 * 86400000).toISOString().split('T')[0];
      const searchDirection = params._slotSearchDirection || 'later';
      const rawMotive = params.motiveId;
      const motiveId  = rawMotive && rawMotive !== 'undefined' && rawMotive !== 'null'
        ? rawMotive : null;
      const medicId   = params.medicId && params.medicId !== 'undefined' && params.medicId !== 'null'
        ? params.medicId : null;

      let dateFrom = today;
      let dateTo   = maxDate;

      // ── Date range logic ─────────────────────────────────────────────────
      // Priority:
      //   1. AI gave an explicit dateFrom (patient said "dia 22 de junho") → use it as start
      //   2. Earlier search → search before the last offered date
      //   3. Later search → start 1 day after last offered date
      //   4. Default → start from today
      const aiDateFrom = params.dateFrom || params.date || null; // AI-extracted explicit date

      if (aiDateFrom) {
        // Patient requested a specific date — use it as the start, search up to +14 days from it
        dateFrom = aiDateFrom;
        dateTo   = addDaysIso(aiDateFrom, 14);
      } else if (searchDirection === 'earlier') {
        dateTo = params._explicitDateTo
          || (params._lastOfferedDate ? addDaysIso(params._lastOfferedDate, -1) : maxDate);
        if (dateTo < dateFrom) return { slots: [], searchDirection, dateFrom, dateTo };
      } else if (params._lastOfferedDate) {
        dateFrom = addDaysIso(params._lastOfferedDate, 1);
      }

      const raw = await newsoft.getAvailableSlots({
        medicId,
        motiveId,
        dateFrom,
        dateTo,
      });
      if (!raw.length) return { slots: [], searchDirection, dateFrom, dateTo };

      // Pick exactly 1 morning (before 13:00) and 1 afternoon/evening (≥13:00)
      // so Vicki always offers just 2 clear choices, never a long list
      const toSlot = s => {
        const iso = s.appointmentDateBegin;
        const h   = humanSlot(iso);
        return {
          slotBase64:  s.appointmentSlotBase64RawData,
          medicName:   s.medicShortName || s.medicName,
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
      for (const s of raw) {
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

      if (!pickedSlots.length && raw.length) pickedSlots = [raw[0]];

      const slots = pickedSlots.map(toSlot);

      const lastOfferedDate = slots.length > 0
        ? slots.reduce((max, s) => s.date > max ? s.date : max, slots[0].date)
        : null;
      return { slots: slots.length ? slots : [toSlot(raw[0])], lastOfferedDate, searchDirection, dateFrom, dateTo };
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
          display: `${t.dayName} às ${t.timeStr} da ${t.period} com ${a.medicName || a.medicShortName}`,
          doctor:  a.medicName || a.medicShortName,
          date:    a.appointmentDateBegin || a.appointmentDate,
        };
      });
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
          if (!p) return null;
          const lp = p.toLowerCase();
          if (lp === 'morning'  || lp === 'manhã' || lp === 'manha') return 'manhã';
          if (lp === 'afternoon'|| lp === 'tarde')                    return 'tarde';
          return lp;
        };
        const wantedPeriod = normPeriod(params.chosenPeriod);

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
          // 4. Match by normalized period alone
          (wantedPeriod && params._pendingSlots.find(s => normPeriod(s.period) === wantedPeriod)) ||
          // 5. Match by partial slotBase64 prefix (AI may truncate)
          (params.slotBase64 && params._pendingSlots.find(s => s.slotBase64?.startsWith(params.slotBase64?.slice(0, 20)))) ||
          // 6. Match by medicName
          (params.medicName && params._pendingSlots.find(s => s.medicName?.toLowerCase().includes(params.medicName?.toLowerCase()))) ||
          // 7. Last resort: first slot
          params._pendingSlots[0];


        if (chosenSlot) resolvedBase64 = chosenSlot.slotBase64;

        // AUDIT LOG — every booking decision is traceable
        console.log(`[Booking] Slot resolution:`);
        console.log(`  chosenPeriod (AI)  : ${params.chosenPeriod || '(none)'}`);
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
      if (chosenSlot && patientForBooking) {
        const smsPhone = callerNumber || patientForBooking.patientPhoneNumber;
        sendBookingConfirmation({
          patientName: patientForBooking.patientName,
          phoneNumber: smsPhone,
          displayDate: chosenSlot.displayDate,
          displayTime: chosenSlot.displayTime,
          medicName:   chosenSlot.medicName,
          date:        chosenSlot.date,
          time:        chosenSlot.time,
        }).catch(err => console.error('[SMS] Background send failed:', err.message));
      }

      return {
        appointmentId: booked[0]?.appointmentId,
        bookedSlot:    chosenSlot,   // passed back so confirmation speaks correct doctor/time
        patient: patientForBooking,
        patientCreated: patientResolution.created,
        patientResolvedExisting: patientResolution.resolvedExisting,
      };
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

      // Fire-and-forget SMS cancellation notification
      if (patient) {
        const cancelledAppt = params._pendingAppts?.find(a => String(a.appointmentId) === String(resolvedId));
        sendCancellationConfirmation({
          patientName: patient.patientName,
          phoneNumber: callerNumber || patient.patientPhoneNumber,
          displayDate: cancelledAppt?.displayDate,
          displayTime: cancelledAppt?.displayTime,
          medicName:   cancelledAppt?.medicName || cancelledAppt?.medicShortName,
        }).catch(err => console.error('[SMS] Cancel SMS failed:', err.message));
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
  pendingAppts   = [],
  patientMemory  = null,
  lastOfferedDate = null,
  bookingReasonText = null,
  callerNumber = null,
  returnToAgent = null,   // agent to return to after a detour (e.g. info → booking)
  returnContext = {},     // saved state: { pendingSlots, bookingReasonText, lastOfferedDate }
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

  const systemPrompt = getAgentPrompt(currentAgent, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory);

  const modelStart = Date.now();
  let firstChunkAt = null;
  let speakReadyAt = null;
  let finishReason = null;

  console.log(`[AI] OpenAI request | model=${LIVE_AGENT_MODEL} agent=${currentAgent} history=${history.length}${isSyntheticTurn ? ' (autoSpeak)' : ''}`);


  // ── Stream GPT response — extract speak ASAP, start TTS before GPT finishes ──
  const stream = await openai.chat.completions.create({
    model:            LIVE_AGENT_MODEL,
    messages:         [{ role: 'system', content: systemPrompt }, ...history],
    temperature:      0.3,
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
      // Try each block from last to first — take the first that parses and has 'action'
      let found = null;
      for (let i = blocks.length - 1; i >= 0; i--) {
        try {
          const candidate = JSON.parse(blocks[i]);
          if (candidate.action !== undefined) { found = candidate; break; }
        } catch (_) {}
      }
      if (found) {
        parsed = found;
        console.warn(`[AI] Double-JSON recovered — took block ${blocks.length} of ${blocks.length}`);
      } else {
        throw new Error('No valid JSON block with action found');
      }
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
        console.log(`[Guard] DOCTOR MATCH — "${userText}" → ${best.doc.medicShortName} (id:${best.doc.medicId}) [matched: ${best.matchedParts.join(', ')}]`);
        action = 'check_slots';
        speak = `Claro, com ${best.doc.medicShortName} — um momento, já verifico a disponibilidade.`;
        params = {
          ...params,
          medicId: best.doc.medicId,
          motiveId: params.motiveId || 'ACH',
          reasonText: updatedBookingReasonText || params.reasonText,
        };
        parsed.action = action;
        parsed.speak = speak;
        parsed.params = params;
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
    const isNameResponse = /\b[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÇ][a-záéíóúâêîôûãõàç]{2,}(\s+[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÇ][a-záéíóúâêîôûãõàç]{2,})+\b/.test(userText || '');

    if (isConfirmText || isConfirmSpeak || isNameResponse) {
      // Infer chosenPeriod from recent conversation (last 6 turns) so we book the RIGHT slot.
      // Patient said "tarde" / "14h" / "afternoon" → tarde. "manhã" / "10h" / "morning" → manhã.
      let inferredPeriod = params.chosenPeriod || null;
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
      return { speak, action: 'hangup', history, currentAgent: 'router', unclearTurns: 0, bookingReasonText: updatedBookingReasonText };
    }

    if (intent && intent !== 'unclear' && intentMap[intent]) {
      nextAgent = intentMap[intent];
      console.log(`[Agent] Switching: ${currentAgent} → ${nextAgent}`);
      history.push({ role: 'assistant', content: JSON.stringify(parsed) });

      if (nextAgent === 'human') {
        const tSpeak = transferSpeak(patient);
        history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
        return {
          speak: tSpeak,
          action: 'transfer_to_human',
          history,
          currentAgent: 'human',
          unclearTurns: 0,
          bookingReasonText: updatedBookingReasonText,
        };
      }

      return { speak, action: 'none', history, currentAgent: nextAgent, unclearTurns: 0, bookingReasonText: updatedBookingReasonText };
    }

    // Intent still unclear — transfer to human after 5 tries (avoids infinite loop)
    const newUnclearTurns = unclearTurns + 1;
    if (newUnclearTurns >= 5) {
      console.log('[Agent] Stuck after 5 unclear turns — transferring to human');
      const tSpeak = transferSpeak(patient);
      history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
      return { speak: tSpeak, action: 'transfer_to_human', history, currentAgent: 'human', unclearTurns: 0, bookingReasonText: updatedBookingReasonText };
    }

    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return { speak, action: 'none', history, currentAgent: 'router', unclearTurns: newUnclearTurns, bookingReasonText: updatedBookingReasonText };
  }

  // ── 2. TRANSFER ACTIONS ───────────────────────────────────
  if (action === 'transfer_to_human') {
    const tSpeak = transferSpeak(patient);
    history.push({ role: 'assistant', content: JSON.stringify({ ...parsed, speak: tSpeak }) });
    return {
      speak: tSpeak,
      action: 'transfer_to_human',
      history,
      currentAgent: 'human',
      bookingReasonText: updatedBookingReasonText,
    };
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
      speak,
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
    return { speak, action: 'hangup', history, currentAgent, bookingReasonText: updatedBookingReasonText };
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
                _bookingReasonText: updatedBookingReasonText,
              }
            : params;
      const actionResult = await executeAction(action, enrichedParams, patient, callerNumber, history);
      if (actionResult) {
        const formatted = formatActionResponse(action, actionResult);
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
          return {
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
          };
        }
      }
    } catch (err) {
      console.error(`[Agent:${currentAgent}] Action error:`, err.message);
      // On any API/booking error → transfer to human with a warm apology
      const tSpeak = transferSpeak(patient);
      const errSpeak = `Peço desculpa — não foi possível concluir a operação no nosso sistema. ${tSpeak}`;
      history.push({ role: 'assistant', content: JSON.stringify({ speak: errSpeak, action: 'transfer_to_human' }) });
      return { speak: errSpeak, action: 'transfer_to_human', history, currentAgent: 'human', bookingReasonText: updatedBookingReasonText };
    }
  } else {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
  }

  return { speak, action, history, currentAgent: nextAgent, bookingReasonText: updatedBookingReasonText };
}

module.exports = { processTurn, generateCallSummary };
