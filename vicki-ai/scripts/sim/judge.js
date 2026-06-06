// ============================================================
// VICKI VOICE GYM — Text judge
//
// Grades a finished conversation against the scenario's success criteria.
// Deterministic (temp 0), JSON output. The free-text fields are what the
// improvement loop / Claude consume to propose fixes.
// ============================================================

const OpenAI = require('openai').default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const JUDGE_MODEL = process.env.GYM_JUDGE_MODEL || 'gpt-4o-mini';

function renderTranscript(transcript) {
  return transcript.map(t => `${t.role === 'patient' ? 'Patient' : 'Vicki'}: ${t.text}`).join('\n');
}

const SYSTEM = `You are a strict QA grader for Vicki, an AI voice receptionist at a dental clinic
(Instituto Vilas Boas, Loulé, Portugal). You are given a scenario, its success criteria, the
conversation transcript, and what actually happened in the backend (bookings/cancellations).

Grade STRICTLY against the scenario's SUCCESS CRITERIA — nothing else. Do NOT assume a booking
was required: for many scenarios the correct outcome is a transfer to a human, an honest "no
availability", giving info, or declining (pricing / medical advice / other patients' data). If the
success criteria are met, the scenario PASSES even if no booking happened. Only fail it if the
criteria are not met, or there is a hallucination, a price leak, or a language break.

A booking/cancel/reschedule only "counts" if the BACKEND EFFECTS show it. Vicki must NEVER reveal
prices, never invent doctors/slots/insurance, must route treatments only to doctors who perform
them, and must escalate to a human when asked or when a caller is distressed. Stating a real
appointment date from the records is correct even if the caller misremembered it — that is NOT a
hallucination.

LANGUAGE RULE: Vicki opens with a default greeting (often Portuguese) BEFORE the caller has
spoken — that is expected and must NOT be penalized. What matters is that once the caller speaks,
Vicki adopts the caller's language and keeps it for the rest of the call. Mark languageConsistent
false ONLY if she fails to switch to the caller's language or flips languages mid-conversation.

Assert on OUTCOMES and TOOL-CALLS (the BACKEND EFFECTS), not vibes. A booking/cancel/reschedule
only counts if the backend shows it.

Reply ONLY with valid JSON:
{
  "outcome": "booked|cancelled|rescheduled|info_given|transferred|none",
  "taskCompleted": true|false,
  "hallucination": {
    "found": true|false,
    "types": [],   // any of: invented_doctor, invented_slot, invented_date, invented_price,
                   // invented_insurance, invented_procedure, medical_advice,
                   // claimed_booked_but_not, wrong_specialty_doctor, other
    "details": ""
  },
  "specialtyRoutingCorrect": true|false|null,
  "escalationCorrect": true|false|null,
  "languageConsistent": true|false,   // see LANGUAGE RULE; pt callers must be answered in pt-PT
  "priceLeak": true|false,
  "offWorkflow": true|false,  // skipped/reordered the mandatory flow, double-asked, or looped
  "tone": 1-5,
  "turnsToResolve": <number>,
  "passed": true|false,
  "whatWentWrong": "concise, specific; empty string if nothing",
  "whatVickiShouldHaveSaid": "concrete better line(s), or empty string"
}
"passed" = true only if the success criteria are met AND hallucination.found=false AND
priceLeak=false AND languageConsistent=true.`;

async function gradeText({ scenario, transcript, sideEffects }) {
  const user = [
    `SCENARIO: ${scenario.id} (${scenario.category})`,
    `PATIENT GOAL: ${scenario.persona.goal}`,
    `LANGUAGE (must stay): ${scenario.persona.language}`,
    `SUCCESS CRITERIA: ${scenario.successCriteria}`,
    ``,
    `BACKEND EFFECTS: booked=${JSON.stringify(sideEffects?.booked || [])} cancelled=${JSON.stringify(sideEffects?.cancelled || [])}`,
    ``,
    `TRANSCRIPT:`,
    renderTranscript(transcript),
  ].join('\n');

  try {
    const res = await openai.chat.completions.create({
      model: JUDGE_MODEL,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    });
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return { passed: false, error: e.message, whatWentWrong: `judge error: ${e.message}` };
  }
}

module.exports = { gradeText };
