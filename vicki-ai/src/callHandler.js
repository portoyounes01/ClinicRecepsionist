// ============================================================
// VICKI AI — Call Handler  (v5 — stable Deepgram)
// ============================================================

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { ElevenLabsClient } = require('@elevenlabs/elevenlabs-js');
const { processTurn } = require('./aiLogic');
const cache          = require('./newsoftCache');
const newsoft = require('./newsoftApi');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
const elevenlabs     = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

const CLINIC_INFO = {
  name:     process.env.CLINIC_NAME,
  location: process.env.CLINIC_LOCATION,
  address:  process.env.CLINIC_ADDRESS,
  phone:    process.env.CLINIC_PHONE,
  mobile:   process.env.CLINIC_PHONE_MOBILE,
  email:    process.env.CLINIC_EMAIL,
  hours:    process.env.CLINIC_HOURS,
};

// ─────────────────────────────────────────────
// SPEAK — stream ElevenLabs audio to Telnyx
// ─────────────────────────────────────────────
async function speak(text, telnyxWs, onDone, getAbort) {
  if (!text?.trim() || telnyxWs.readyState !== 1) { if (onDone) onDone(); return; }

  console.log(`[TTS] Vicki says: "${text}"`);
  let aborted = false;
  if (getAbort) getAbort(() => { aborted = true; });

  try {
    const audioStream = await elevenlabs.textToSpeech.stream(
      process.env.ELEVENLABS_VOICE_ID,
      {
        text,
        model_id:                   'eleven_turbo_v2_5',
        output_format:              'pcm_8000',
        optimize_streaming_latency:  3,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }
    );

    // Buffer PCM chunks — sending each tiny chunk separately causes choppy audio.
    // Accumulate into 1600-byte blocks (~200ms at 8kHz) before sending to Telnyx.
    const CHUNK_SIZE = 1600;
    let buffer = Buffer.alloc(0);

    const flush = () => {
      if (buffer.length === 0 || aborted || telnyxWs.readyState !== 1) return;
      telnyxWs.send(JSON.stringify({ event: 'media', media: { payload: buffer.toString('base64') } }));
      buffer = Buffer.alloc(0);
    };

    for await (const chunk of audioStream) {
      if (aborted || telnyxWs.readyState !== 1) break;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, buf]);
      while (buffer.length >= CHUNK_SIZE) {
        const send = buffer.slice(0, CHUNK_SIZE);
        buffer = buffer.slice(CHUNK_SIZE);
        if (!aborted && telnyxWs.readyState === 1) {
          telnyxWs.send(JSON.stringify({ event: 'media', media: { payload: send.toString('base64') } }));
        }
      }
    }
    // Flush remaining bytes at end of stream
    flush();

    if (!aborted) {
      telnyxWs.send(JSON.stringify({ event: 'mark', mark: { name: 'vicki_done_speaking' } }));
      console.log('[TTS] Audio sent');
    } else {
      console.log('[TTS] Interrupted');
    }
  } catch (err) {
    if (!aborted) console.error('[TTS] Error:', err.message);
  }

  if (onDone) onDone();
}

// ─────────────────────────────────────────────
// PCMA → Linear16 converter
// ─────────────────────────────────────────────
function alawToLinear(b) {
  b ^= 0x55;
  const sign = b & 0x80, exp = (b & 0x70) >> 4, mant = b & 0x0F;
  let s = exp === 0 ? (mant << 4) + 8 : ((mant + 16) << (exp + 3)) - (16 << 4);
  return sign === 0 ? -s : s;
}
function pcmaToLinear16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(alawToLinear(buf[i]), i * 2);
  return out;
}

// ─────────────────────────────────────────────
// HANDLE CALL
// ─────────────────────────────────────────────
async function handleCallStream(ws, req, hangupCalls = new Set()) {
  let callerNumber        = null;
  let callSid             = null;   // Telnyx CallSid — used to trigger hangup
  let patient             = null;
  let cachedDoctors       = [];
  let cachedMotives       = [];
  let conversationHistory = [];
  let currentAgent        = 'router';
  let unclearTurns        = 0;
  let isSpeaking          = false;
  let currentAbort        = null;
  let deepgramOpen        = false;
  let pendingTranscript   = '';   // accumulates rapid FINAL chunks
  let processingTimer     = null; // debounce timer before sending to AI
  let pendingSlots        = [];   // slots from last check_slots — real slotBase64 values
  let pendingAppts        = [];   // appointments from last get_appointments — real appointmentId values

  // ── Create Deepgram immediately — gives it time to open before first media ──
  // The SDK queues audio internally while connecting, so no readyState check needed.
  // ── Build keyword list from global cache (pre-loaded at warm-up) — boosts
  // recognition of doctor names so "Hermas" → "Hermes", "Carla" is heard correctly
  let allDoctors = [];
  try { allDoctors = await cache.getDoctors(); } catch (_) {}
  const doctorKeywords = allDoctors.flatMap(d => {
    const names = [];
    const stripTitle = n => (n || '').replace(/^Dr[ªº]?\.?\s*/i, '').trim();
    if (d.medicShortName) names.push(`${stripTitle(d.medicShortName)}:8`);
    if (d.medicName)      names.push(`${stripTitle(d.medicName)}:6`);
    return names.filter(n => n.length > 3);
  });
  // Also boost common clinic terms
  const clinicKeywords = ['appointment', 'checkup', 'cleaning', 'Hermes', 'Nadine', 'Carla', 'Vilas', 'Boas', 'Beatriz', 'Hugo', 'Miguel', 'Carolina', 'Silvia', 'Fernando',
    // Portuguese dental/booking terms
    'consulta', 'marcação', 'cancelar', 'desmarcar', 'limpeza', 'dor', 'urgência',
    'dentista', 'ortodontia', 'implante', 'obturação', 'extração',
    'manhã', 'tarde', 'amanhã', 'semana', 'segunda', 'terça', 'quarta', 'quinta', 'sexta',
  ].map(w => `${w}:5`);
  const allKeywords    = [...new Set([...doctorKeywords, ...clinicKeywords])];
  console.log('[STT] Keyword boost active:', allKeywords.slice(0, 6).join(', '), '...');

  const deepgramLive = deepgramClient.listen.live({
    model:            'nova-2',       // nova-2 has confirmed multilingual support
    language:         'multi',        // EN + PT auto-detection
    smart_format:     true,
    interim_results:  true,
    endpointing:      800,
    utterance_end_ms: 1000,
    encoding:         'linear16',
    sample_rate:      8000,
    // keywords removed — not compatible with language:multi in nova-2
    filler_words:     false,
  });

  deepgramLive.on(LiveTranscriptionEvents.Open, () => {
    deepgramOpen = true;
    console.log('[Deepgram] Connection open');
  });

  deepgramLive.on(LiveTranscriptionEvents.Error, (err) =>
    console.error('[Deepgram] Error:', err?.message || JSON.stringify(err)));

  deepgramLive.on(LiveTranscriptionEvents.Close, (ev) => {
    deepgramOpen = false;
    console.log('[Deepgram] Closed — code:', ev?.code, 'reason:', ev?.reason || '(none)');
  });

  // ── Transcript handler ──
  deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt        = data.channel?.alternatives?.[0];
    const raw        = alt?.transcript?.trim();
    const confidence = alt?.confidence ?? 1;
    const isFinal    = data.is_final;
    if (!raw) return;

    // ── Confidence filter — skip near-noise transcripts ──────────────
    if (isFinal && confidence < 0.40) {
      console.log(`[STT] Low-confidence (${confidence.toFixed(2)}) skipped: "${raw}"`);
      return;
    }

    // ── Transcript cleanup ────────────────────────────────────────────
    // 1. Deduplicate repeated sentences: "No. No. No. No." → "No."
    //    (happens when barge-in fires mid-repetition)
    // 2. Map common Deepgram mishears for Portuguese-accented English
    const MISHEAR_MAP = {
      'hermas': 'Hermes', 'hermos': 'Hermes', 'hermès': 'Hermes',
      'acarla': 'Carla',  'a carla': 'Carla',
      'i saved': 'I said', 'i safe': 'I said',
    };
    let transcript = raw
      // remove duplicate adjacent sentences
      .replace(/\b(.{4,})\b(?:[.,!?]?\s+\1)+/gi, '$1')
      // mishear substitutions (whole-word)
      .replace(/\b(hermas|hermos|herm[eè]s|acarla|a carla|i saved|i safe)\b/gi,
        m => MISHEAR_MAP[m.toLowerCase()] || m);

    const wordCount = transcript.split(/\s+/).filter(Boolean).length;
    console.log(`[STT] ${isFinal ? 'FINAL' : 'interim'}: "${transcript}"${confidence < 0.75 && isFinal ? ` (conf:${confidence.toFixed(2)})` : ''}`);

    // Barge-in: 3+ words while Vicki speaks
    if (isSpeaking && currentAbort && wordCount >= 3) {
      console.log('[Barge-in] Stopping Vicki');
      clearTimeout(processingTimer); processingTimer = null;
      currentAbort(); currentAbort = null; isSpeaking = false;
      pendingTranscript = '';
    }

    if (!isFinal) return;

    // While Vicki is speaking, ignore FINAL transcripts (only barge-in above)
    if (isSpeaking) return;

    // Accumulate this FINAL into the pending buffer
    pendingTranscript += (pendingTranscript ? ' ' : '') + transcript;

    // Debounce: wait 400ms for more speech before sending to AI.
    // This merges split utterances like "No. It's for" + "cleaning."
    clearTimeout(processingTimer);
    processingTimer = setTimeout(async () => {
      const userText = pendingTranscript.trim();
      pendingTranscript = '';
      processingTimer = null;
      if (!userText || isSpeaking) return;
    isSpeaking = true;
    console.log(`[AI] Processing: "${userText}"`);

    const speakNow = (text, onDone) =>
      speak(text, ws, onDone, (fn) => { currentAbort = fn; });

    try {
      let speakStarted    = false;
      let bridgeDone      = null;
      const bridgePromise = new Promise(r => { bridgeDone = r; });

      const onSpeakReady = (earlyText) => {
        if (!speakStarted && isSpeaking) {
          speakStarted = true;
          speak(earlyText, ws,
            () => { isSpeaking = false; currentAbort = null; bridgeDone(); },
            (fn) => { currentAbort = fn; }
          );
        }
      };

      const result = await processTurn({
        history:      conversationHistory,
        patient,
        clinicInfo:   CLINIC_INFO,
        userText,
        cachedDoctors,
        cachedMotives,
        currentAgent,
        unclearTurns,
        onSpeakReady,
        pendingSlots,
        pendingAppts,
      });

      conversationHistory = result.history;
      if (result.currentAgent  !== undefined) currentAgent  = result.currentAgent;
      if (result.unclearTurns  !== undefined) unclearTurns  = result.unclearTurns;
      if (result.pendingSlots  && result.pendingSlots.length)  pendingSlots  = result.pendingSlots;
      if (result.pendingAppts  && result.pendingAppts.length)  pendingAppts  = result.pendingAppts;

      // ── Speak the response ───────────────────────────────────────────
      if (result.actionFired && result.speak) {
        // For result actions (book/cancel): the AI bridge phrase IS the completion message.
        // Aborting it and speaking only the formatActionResponse avoids double-speak.
        // For check_slots: bridge phrase is a loading message — let it finish first.
        const isResultAction = ['book_appointment', 'cancel_appointment'].includes(result.actionFired);
        if (speakStarted && isResultAction && currentAbort) {
          currentAbort(); // abort bridge — bridgeDone() fires in finally, resolving bridgePromise
          currentAbort = null;
        }
        if (speakStarted) await bridgePromise;
        // Now speak the definitive API result (slots, booking/cancel confirmation, etc.)
        isSpeaking = true;
        await speakNow(result.speak, () => { isSpeaking = false; currentAbort = null; });
      } else if (result.speak && !speakStarted && isSpeaking) {
        // No API action, bridge didn't fire — speak result directly
        await speakNow(result.speak, () => { isSpeaking = false; currentAbort = null; });
      } else if (!speakStarted) {
        isSpeaking = false; currentAbort = null;
      }
      // speakStarted && !actionFired → onSpeakReady TTS handles cleanup

      if (result.action === 'transfer_to_human') {
        console.log('[Call] Transferring to human');
      }

      if (result.action === 'hangup') {
        console.log('[Call] AI requested hangup — closing stream');
        // Farewell was already spoken via onSpeakReady / speakNow above.
        // Wait a moment for TTS to finish, then close WS and flag keep-alive.
        setTimeout(() => {
          if (callSid) hangupCalls.add(callSid);
          try { ws.close(); } catch (_) {}
        }, 1500);
      }

    } catch (err) {
      console.error('[AI] Error:', err.message);
      await speakNow('Sorry, could you repeat that?', () => { isSpeaking = false; currentAbort = null; });
      isSpeaking = false;
    }
    }, 400); // end debounce timer
  });

  // ── Telnyx WebSocket ──────────────────────
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.event) {

        case 'connected':
          console.log('[Telnyx] Connected');
          break;

        case 'start':
          callSid      = msg.start?.callSid || null;
          callerNumber = msg.start?.customParameters?.callerNumber || msg.start?.from || null;
          console.log(`[Call] Started. Caller: ${callerNumber} | SID: ${callSid}`);

          // ── Look up patient name BEFORE speaking ─────────────────────────────────
          // Race: lookup vs 2-second ring delay.
          // Caller hears natural ringing while we fetch their name.
          // If lookup finishes first, we still wait the full 2s for natural feel.
          // Then Vicki greets by name in ONE message — no 'one moment please'.
          // ──────────────────────────────────────────────────────────────────
          (async () => {
            try {
              const ringDelay   = new Promise(r => setTimeout(r, 2000));
              const lookupAll   = Promise.all([
                callerNumber ? newsoft.getPatientByPhone(callerNumber) : Promise.resolve(null),
                newsoft.getDoctors(),
                newsoft.getMotives(),
              ]);

              // Wait for BOTH the ring delay AND the lookup to finish
              const [[patientResult, doctors, motives]] = await Promise.all([
                lookupAll,
                ringDelay,
              ]);

              patient = patientResult; cachedDoctors = doctors; cachedMotives = motives;

              console.log(patient
                ? `[Newsoft] Patient: ${patient.patientName} (ID: ${patient.patientId})`
                : '[Newsoft] Unknown caller');
              console.log(`[Newsoft] ${cachedDoctors.length} doctors, ${cachedMotives.length} motives`);

              const firstName = patient?.patientName?.split(' ')[0];
              const greeting  = firstName
                ? `Hi ${firstName}! I'm Vicki, Instituto Vilas Boas's virtual assistant. How can I help you today?`
                : `Hello! I'm Vicki, Instituto Vilas Boas's virtual assistant. How can I help you today?`;

              isSpeaking = true;
              speak(greeting, ws, () => { isSpeaking = false; }, (fn) => { currentAbort = fn; });

            } catch (err) {
              console.error('[Startup] Error:', err.message);
              isSpeaking = true;
              speak(
                "Hello! I'm Vicki, Instituto Vilas Boas's virtual assistant. How can I help you today?",
                ws, () => { isSpeaking = false; }, (fn) => { currentAbort = fn; }
              );
            }
          })();
          break;

        case 'media':
          // Send audio to Deepgram always — SDK queues if not yet open.
          // Continuous audio prevents the 1006 idle-timeout closure.
          if (msg.media?.payload && deepgramOpen) {
            deepgramLive.send(pcmaToLinear16(Buffer.from(msg.media.payload, 'base64')));
          }
          break;

        case 'mark':
          if (msg.mark?.name === 'vicki_done_speaking') isSpeaking = false;
          break;

        case 'stop':
          console.log('[Call] Stopped');
          break;
      }
    } catch (err) {
      console.error('[WS] Parse error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[Call] Closed');
    try { deepgramLive.requestClose(); } catch (_) {}
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
}

module.exports = { handleCallStream };
