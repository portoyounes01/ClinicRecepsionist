// ============================================================
// VICKI VOICE GYM — Synthetic patient brain + voice
//
// nextPatientUtterance(): an LLM plays a realistic caller in ONE fixed
//   language for the whole call (no mid-call switching). Terse, may change
//   their mind, give vague dates, get impatient. Emits [DONE] when the goal
//   is met or they give up.
// synthesize(): ElevenLabs TTS -> linear PCM 8kHz (pcm_8000) so it can be
//   streamed into Vicki's pipeline via the Telnyx client.
// ============================================================

const OpenAI = require('openai').default;
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Patient should sound different from Vicki — use a separate voice if provided.
const PATIENT_VOICE_ID = process.env.PATIENT_VOICE_ID || process.env.ELEVENLABS_VOICE_ID;

const PERSONA_MODEL = process.env.GYM_PERSONA_MODEL || 'gpt-4o-mini';

function buildPersonaPrompt(spec) {
  const langName = spec.language === 'pt' ? 'European Portuguese (PT-PT)' : 'English';
  return [
    `You are role-playing a PATIENT phoning a dental clinic (Instituto Vilas Boas, Loulé, Portugal).`,
    `You are NOT an assistant. You are the caller. Speak ONLY in ${langName} for the entire call — never switch language.`,
    ``,
    `YOUR GOAL: ${spec.goal}`,
    spec.hiddenConstraints ? `YOUR CONSTRAINTS (reveal only if asked): ${spec.hiddenConstraints}` : '',
    `YOUR PERSONALITY: ${spec.personality || 'ordinary, polite'}`,
    spec.quirks?.length ? `QUIRKS: ${spec.quirks.join('; ')}` : '',
    ``,
    `HOW TO BEHAVE:`,
    `- Talk like a real person on the phone: short, natural, one thought at a time.`,
    `- Do NOT be over-helpful or list things like an AI. React to what Vicki actually says.`,
    `- You may hesitate ("uh", "hmm"), change your mind, or be vague about dates/times.`,
    `- Answer Vicki's questions; don't volunteer everything at once.`,
    `- When your goal is achieved (e.g. appointment booked/confirmed/cancelled, or you got your answer),`,
    `  say a brief natural goodbye and then output [DONE] on its own.`,
    `- If you get frustrated or it's clearly going nowhere after several tries, wrap up and output [DONE].`,
    ``,
    `OUTPUT: reply with ONLY your next spoken line (no quotes, no name prefix). If you are finished,`,
    `give the goodbye line then [DONE] on a new line.`,
  ].filter(Boolean).join('\n');
}

function transcriptToMessages(transcript) {
  // Patient = assistant turns (it's "us"); Vicki = user turns (what we respond to).
  return transcript.map(t => ({
    role: t.role === 'patient' ? 'assistant' : 'user',
    content: t.text,
  }));
}

// Returns { text, done }
async function nextPatientUtterance(spec, transcript) {
  const messages = [
    { role: 'system', content: buildPersonaPrompt(spec) },
    ...transcriptToMessages(transcript),
  ];
  // If Vicki hasn't spoken yet, nudge the patient to open the call.
  if (!transcript.length) {
    messages.push({ role: 'user', content: '(The clinic line just connected. Say your opening line.)' });
  }

  const res = await openai.chat.completions.create({
    model: PERSONA_MODEL,
    temperature: 0.8,
    max_tokens: 120,
    messages,
  });

  let text = (res.choices[0].message.content || '').trim();
  const done = /\[DONE\]/i.test(text);
  text = text.replace(/\[DONE\]/ig, '').trim();
  return { text, done };
}

// text -> linear PCM 8kHz Buffer
async function synthesize(text, lang) {
  // NOTE: SDK v2.x expects camelCase keys — snake_case is silently ignored
  // and the API falls back to MP3 (which breaks the 8kHz PCM pipeline).
  const stream = await elevenlabs.textToSpeech.stream(PATIENT_VOICE_ID, {
    text,
    modelId: 'eleven_flash_v2_5',
    outputFormat: 'pcm_8000',
    optimizeStreamingLatency: 4,
    voiceSettings: { stability: 0.5, similarityBoost: 0.8 },
  });
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

module.exports = { nextPatientUtterance, synthesize, PATIENT_VOICE_ID };
