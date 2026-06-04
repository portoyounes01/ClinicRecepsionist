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
    `Please hold for just a moment${name} — I'm connecting you with one of our team members who will be happy to assist you.`,
    `Of course${name} — please hold on just a second while I transfer you to one of our colleagues who can help you with that.`,
    `Absolutely${name} — just one moment please while I put you through to someone from our team who can take care of this for you.`,
  ];
  return phrases[Math.floor(Date.now() / 1000) % phrases.length];
}

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
  const ordinal = d => {
    const v = d % 100;
    if (v >= 11 && v <= 13) return `${d}th`;
    return `${d}${ ['th','st','nd','rd'][d % 10] || 'th' }`;
  };
  const monthName = date.toLocaleDateString('en-GB', { month: 'long' });

  let dayName;
  if      (diffDays === 0) dayName = 'today';
  else if (diffDays === 1) dayName = 'tomorrow';
  else if (diffDays <= 6)  dayName = `this ${weekday}`;
  else {
    // 7+ days — ALWAYS include the actual date, never just "next Monday"
    dayName = `${weekday} the ${ordinal(date.getDate())} of ${monthName}`;
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

  if (action === 'none' && askedDoctorPreference && isAffirmationOnly(userText) && motiveId) {
    return {
      action: 'check_slots',
      speak: "Perfect — I'll check the first available appointment for you.",
      params: { ...params, motiveId, reasonText },
    };
  }

  const asksForUnseenSlotChoice = /\bwhich one\b.*\b(morning|afternoon)\b|\bmorning or (?:the )?afternoon\b/i.test(speak || '');
  if (action === 'none' && asksForUnseenSlotChoice) {
    if (motiveId) {
      return {
        action: 'check_slots',
        speak: "Let me check the available times for you.",
        params: { ...params, motiveId, reasonText },
      };
    }
    return {
      action: 'none',
      speak: "Could you tell me the reason for the appointment first?",
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
      speak: "I can book that for you — could I take your full name for the patient file?",
    };
  }

  if (!patientPhoneNumber && !patientEmail && !patientNif) {
    return {
      needsPatientDetails: true,
      missing: 'patientPhoneNumber',
      speak: "I can book that for you — could I take your phone number for the patient file?",
    };
  }

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
            speak: "I don't see anything earlier than that right now. The last slot I offered is still the earliest I can find. Would you like that one?",
            action: 'none',
          };
        }
        return {
          speak: "I'm sorry, there are no free slots with that doctor in the next 4 weeks. Would you like me to check a different doctor?",
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
      if (actionResult.needsPatientDetails) {
        return {
          speak: actionResult.speak || "I can book that for you — could I take your full name for the patient file?",
          action: 'none',
        };
      }
      if (actionResult.error || !actionResult.appointmentId) {
        return {
          speak: "I'm sorry, I wasn't able to complete that booking in our system. Please hold for just a moment — I'm connecting you with one of our team members who will sort this out for you right away.",
          action: 'transfer_to_human',
        };
      }
      return {
        speak: `Perfect — you're all booked! We'll see you then. Is there anything else I can help you with?`,
        action: 'none',
      };

    case 'cancel_appointment':
      if (!actionResult.cancelled) {
        return {
          speak: `I'm sorry, I wasn't able to cancel that in our system. Please hold for just a moment — I'm putting you through to one of our team members who will take care of this for you.`,
          action: 'transfer_to_human',
        };
      }
      return {
        speak: `Done, that's cancelled. I know things come up — would you like me to find you another slot so you don't lose your place?`,
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
async function executeAction(action, params, patient, callerNumber) {
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

      if (searchDirection === 'earlier') {
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

      // ── Smart slot picking ───────────────────────────────────────────────
      // Goal: ONE date, ONE doctor, offer morning + afternoon on that same day.
      // Priority: find a doctor who has BOTH morning and afternoon on the earliest day.
      // Fallback: any doctor with at least one slot on the earliest day.

      // Group raw slots by date (ISO date string)
      const byDate = {};
      for (const s of raw) {
        const d = s.appointmentDateBegin?.split('T')[0];
        if (d) { if (!byDate[d]) byDate[d] = []; byDate[d].push(s); }
      }
      const sortedDates = Object.keys(byDate).sort();

      let pickedMorning = null, pickedAfternoon = null;

      for (const date of sortedDates) {
        const daySlots = byDate[date];

        // Group by doctor within this day
        const byDoc = {};
        for (const s of daySlots) {
          const id = s.medicId || s.medicShortName || s.medicName;
          if (!byDoc[id]) byDoc[id] = [];
          byDoc[id].push(s);
        }

        // Try to find a doctor with BOTH morning AND afternoon
        for (const docSlots of Object.values(byDoc)) {
          const m = docSlots.find(s => parseInt(s.appointmentDateBegin?.split('T')[1] || '0') < 13);
          const a = docSlots.find(s => parseInt(s.appointmentDateBegin?.split('T')[1] || '0') >= 13);
          if (m && a) { pickedMorning = m; pickedAfternoon = a; break; }
        }
        if (pickedMorning && pickedAfternoon) break;

        // Fallback: any doctor with at least one slot on this day
        for (const docSlots of Object.values(byDoc)) {
          const m = docSlots.find(s => parseInt(s.appointmentDateBegin?.split('T')[1] || '0') < 13);
          const a = docSlots.find(s => parseInt(s.appointmentDateBegin?.split('T')[1] || '0') >= 13);
          if (m || a) { pickedMorning = m || null; pickedAfternoon = a || null; break; }
        }
        if (pickedMorning || pickedAfternoon) break;
      }

      const slots = [pickedMorning, pickedAfternoon].filter(Boolean).map(toSlot);
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
          display: `${t.dayName} at ${t.timeStr} in the ${t.period} with ${a.medicName || a.medicShortName}`,
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

      // Prefer server-side pendingSlots lookup to avoid AI copying truncated slotBase64
      let resolvedBase64 = params.slotBase64;
      if (params._pendingSlots && params._pendingSlots.length > 0) {
        const chosen = params._pendingSlots.find(s => s.period === params.chosenPeriod)
          || params._pendingSlots.find(s => s.slotBase64?.startsWith(params.slotBase64?.slice(0, 10)))
          || params._pendingSlots[0];
        if (chosen) resolvedBase64 = chosen.slotBase64;
      }
      console.log(`[Booking] Reason for observation: ${params._bookingReasonText || '(none)'}`);
      const booked = await newsoft.bookAppointment({
        patientId:   patientForBooking.patientId,
        slotBase64:  resolvedBase64,
        motiveName:  params.motiveName || 'Consulta',
        observation: bookingObservation(params._bookingReasonText),
      });
      return {
        appointmentId: booked[0]?.appointmentId,
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
  lastOfferedDate = null,   // date of last slot offered — skip past it on next search
  bookingReasonText = null,
  callerNumber = null,
}) {
  history.push({ role: 'user', content: userText });

  const systemPrompt = getAgentPrompt(currentAgent, patient, clinicInfo, cachedDoctors, cachedMotives, patientMemory);

  const modelStart = Date.now();
  let firstChunkAt = null;
  let speakReadyAt = null;
  let finishReason = null;

  console.log(`[AI] OpenAI request | model=${LIVE_AGENT_MODEL} agent=${currentAgent} history=${history.length}`);

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
    parsed = JSON.parse(fullText);
  } catch (err) {
    console.error(
      `[AI] JSON parse failed | model=${LIVE_AGENT_MODEL} agent=${currentAgent} ` +
      `error=${err.message} raw=${JSON.stringify(fullText.slice(0, 500))}`
    );
    parsed = { speak: "Sorry, I didn't quite catch that — could you say it again?", action: 'none', intent: null };
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

  if (action === 'transfer_to_booking') {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
    return { speak, action: 'none', history, currentAgent: 'booking', bookingReasonText: updatedBookingReasonText };
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
      const actionResult = await executeAction(action, enrichedParams, patient, callerNumber);
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
      const errSpeak = `I'm really sorry about that — I wasn't able to complete that in our system. ${tSpeak}`;
      history.push({ role: 'assistant', content: JSON.stringify({ speak: errSpeak, action: 'transfer_to_human' }) });
      return { speak: errSpeak, action: 'transfer_to_human', history, currentAgent: 'human', bookingReasonText: updatedBookingReasonText };
    }
  } else {
    history.push({ role: 'assistant', content: JSON.stringify(parsed) });
  }

  return { speak, action, history, currentAgent: nextAgent, bookingReasonText: updatedBookingReasonText };
}

module.exports = { processTurn, generateCallSummary };
