// ============================================================
// VICKI VOICE GYM — Voice judge (audio-capable model)
//
// Listens to Vicki's actual audio and reports tone/emotion/awkward-pause
// observations that text can't capture. Complements the text judge.
//
// Uses an audio-input model (OpenAI gpt-4o-audio-preview by default).
// [ASSUMPTION — verify before relying on it: model name/audio API shape.]
// Gracefully degrades to null if the model/audio input is unavailable, so
// the gym still runs on transcript + timing alone.
// ============================================================

const OpenAI = require('openai').default;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VOICE_JUDGE_MODEL = process.env.GYM_VOICE_JUDGE_MODEL || 'gpt-4o-audio-preview';
const SAMPLE_RATE = 8000;

// wrap mono PCM16 8kHz as a base64 WAV
function pcmToWavBase64(pcm16) {
  const dataBytes = pcm16.length;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  pcm16.copy(buf, 44);
  return buf.toString('base64');
}

const SYSTEM = `You are a voice/tone QA reviewer for an AI dental receptionist (Vicki). You will hear
Vicki's spoken audio from a call. Judge ONLY how she SOUNDS, not the words' correctness.
Reply ONLY with valid JSON:
{
  "tone": 1-5,            // 1 cold/robotic, 5 warm/natural
  "warmth": 1-5,
  "soundedRobotic": true|false,
  "awkwardPauses": true|false,
  "interruptedCaller": true|false,
  "emotionMismatch": true|false,   // e.g. cheerful while caller is in pain
  "whatSoundedOff": ""             // concise, empty if fine
}`;

// vickiPcm16: mono linear PCM16 8kHz Buffer of Vicki's audio for the call
async function gradeVoice({ vickiPcm16 }) {
  if (!vickiPcm16 || vickiPcm16.length < SAMPLE_RATE) return null; // <0.5s — nothing to judge
  try {
    const res = await openai.chat.completions.create({
      model: VOICE_JUDGE_MODEL,
      modalities: ['text'],
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: [
          { type: 'text', text: 'Here is Vicki\'s audio from the call. Judge how she sounds.' },
          { type: 'input_audio', input_audio: { data: pcmToWavBase64(vickiPcm16), format: 'wav' } },
        ] },
      ],
    });
    const txt = res.choices[0].message.content || '{}';
    const m = txt.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn(`[VoiceJudge] skipped (${e.message})`);
    return null;
  }
}

module.exports = { gradeVoice };
