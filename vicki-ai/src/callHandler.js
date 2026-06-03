// ============================================================
// VICKI AI — Call Handler  (v5 — stable Deepgram)
// ============================================================

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { ElevenLabsClient }    = require('@elevenlabs/elevenlabs-js');
const { processTurn, generateCallSummary } = require('./aiLogic');
const cache         = require('./newsoftCache');
const newsoft       = require('./newsoftApi');
const { getPatientMemory, updateAfterCall, logCallOutcome } = require('./patientMemory');

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
async function handleCallStream(ws, req, hangupCalls = new Set(), transferCalls = new Map()) {
  let callerNumber        = null;
  let callSid             = null;
  let patient             = null;
  let patientMemory       = null;
  let cachedDoctors       = [];
  let cachedMotives       = [];
  let conversationHistory = [];
  let currentAgent        = 'router';
  let unclearTurns        = 0;
  let isSpeaking          = false;
  let currentAbort        = null;
  let deepgramOpen        = false;
  let pendingTranscript   = '';
  let processingTimer     = null;
  let pendingSlots        = [];
  let pendingAppts        = [];
  const callStartTime     = Date.now();
  let lastSpeechTime      = Date.now(); // tracks last patient utterance
  let callEnding          = false;      // prevents double-hangup
  let loudPackets         = 0;          // consecutive loud audio packets (for audio barge-in)

  // ── Watchdog 1: Max call duration (15 min) ────────────────────────────────
  // If a call is still open after 15 min something went wrong — auto-hangup.
  const maxDurationWatchdog = setTimeout(() => {
    if (callEnding) return;
    callEnding = true;
    console.log('[Watchdog] Max duration reached (15 min) — auto-hangup');
    speak(
      "I'm so sorry, we've been connected for a while and I need to free the line. Please call us back if you need anything — goodbye!",
      ws, () => {
        if (callSid) hangupCalls.add(callSid);
        try { ws.close(); } catch (_) {}
      }, (fn) => { currentAbort = fn; }
    );
  }, 15 * 60 * 1000); // 15 minutes

  // ── Watchdog 2: Silence detector (90s no speech → goodbye) ───────────────
  // If patient goes silent for 90s, Vicki says goodbye and ends the call.
  const silenceWatchdog = setInterval(() => {
    if (callEnding || isSpeaking) return;
    const silenceSec = Math.round((Date.now() - lastSpeechTime) / 1000);
    if (silenceSec >= 90) {
      callEnding = true;
      clearInterval(silenceWatchdog);
      console.log(`[Watchdog] ${silenceSec}s silence — ending call`);
      speak(
        "I haven't heard from you in a moment — I'll let you go. Feel free to call us back anytime. Goodbye!",
        ws, () => {
          if (callSid) hangupCalls.add(callSid);
          try { ws.close(); } catch (_) {}
        }, (fn) => { currentAbort = fn; }
      );
    }
  }, 15000); // check every 15 seconds



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
    model:            'nova-2',
    language:         'multi',        // EN + PT auto-detection
    smart_format:     true,
    interim_results:  true,
    endpointing:      300,            // ⚡ was 800ms — cuts response delay by ~500ms
    utterance_end_ms: 500,            // ⚡ was 1000ms
    encoding:         'linear16',
    sample_rate:      8000,
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
  // Update silence timer on every transcript
  deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt        = data.channel?.alternatives?.[0];
    const raw        = alt?.transcript?.trim();
    const confidence = alt?.confidence ?? 1;
    const isFinal    = data.is_final;
    if (!raw) return;
    if (isFinal) lastSpeechTime = Date.now(); // reset silence watchdog

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

    // Barge-in: patient says 2+ words while Vicki speaks → stop her
    // 2 words avoids false triggers from noise/echo, still catches "no", "wait", "stop"
    if (isSpeaking && currentAbort && wordCount >= 2) {
      console.log('[Barge-in] Patient interrupted — stopping Vicki');
      clearTimeout(processingTimer); processingTimer = null;
      currentAbort(); currentAbort = null; isSpeaking = false;
      pendingTranscript = '';
    }

    if (!isFinal) return;

    // While Vicki is speaking, ignore FINAL transcripts (only barge-in above)
    if (isSpeaking) return;

    // Accumulate this FINAL into the pending buffer
    pendingTranscript += (pendingTranscript ? ' ' : '') + transcript;

    // ⚡ Debounce: wait 150ms (was 400ms) — still merges fast split utterances
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
        patientMemory,
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
        if (callEnding) return;
        callEnding = true;
        clearTimeout(maxDurationWatchdog);
        clearInterval(silenceWatchdog);
        const transferNumber = process.env.CLINIC_PHONE_MOBILE || '+351962432761';
        console.log(`[Call] Transferring to human — ${transferNumber}`);
        // Add to transfer set — next keep-alive (within 12s) will dial the number
        if (callSid) transferCalls.set(callSid, transferNumber);
        // Close WebSocket — Telnyx handles the bridge from here
        setTimeout(() => { try { ws.close(); } catch (_) {} }, 500);
      }

      if (result.action === 'hangup') {
        if (callEnding) return; // already ending
        callEnding = true;
        clearTimeout(maxDurationWatchdog);
        clearInterval(silenceWatchdog);
        console.log('[Call] AI requested hangup — closing stream');

        // Farewell already spoken. Save memory + log call async (don’t block hangup).
        const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
        generateCallSummary(conversationHistory, patient)
          .then(summary => {
            // 1. Update patient memory (only explicitly stated preferences)
            if (patient?.patientId) {
              updateAfterCall(patient.patientId, {
                patientName:              patient.patientName,
                summary:                  summary.summary,
                intent:                   summary.intent,
                language:                 summary.language,
                explicitDoctorPreference: summary.explicitDoctorPreference,
                explicitTimePreference:   summary.explicitTimePreference,
              });
            }
            // 2. Log call outcome for weekly review
            logCallOutcome({
              patientId:          patient?.patientId  || null,
              patientName:        patient?.patientName || 'Unknown',
              callerNumber,
              outcome:            summary.outcome,
              intent:             summary.intent,
              transferredToHuman: currentAgent === 'human',
              unclearTurns,
              durationSeconds,
              summary:            summary.summary,
              flags:              summary.flags || [],
            });
          })
          .catch(e => console.error('[Memory] Save error:', e.message));

        // Wait for Vicki to finish speaking, then close.
        // Polls every 200ms — max 6s wait — then hangs up.
        let waited = 0;
        const doHangup = () => {
          if (isSpeaking && waited < 6000) {
            waited += 200;
            setTimeout(doHangup, 200);
            return;
          }
          // Small buffer so last TTS audio finishes playing on the patient's end
          setTimeout(() => {
            if (callSid) {
              hangupCalls.add(callSid);
              console.log(`[Call] Added ${callSid} to hangupCalls — will end on next keep-alive`);
            } else {
              console.warn('[Call] callSid is null — cannot signal Telnyx hangup via keep-alive');
            }
            try { ws.close(); } catch (_) {}
          }, 600);
        };
        doHangup();
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
          // Try all known Telnyx field names for the call ID
          callSid = msg.start?.callSid
                 || msg.start?.call_sid
                 || msg.start?.CallSid
                 || msg.streamSid
                 || null;
          callerNumber = msg.start?.customParameters?.callerNumber || msg.start?.from || null;
          console.log(`[Call] Started. Caller: ${callerNumber} | SID: ${callSid}`);
          console.log(`[Call] start payload keys: ${Object.keys(msg.start || {}).join(', ')}`);

          // ── Look up patient name BEFORE speaking ─────────────────────────────────
          // Race: lookup vs 2-second ring delay.
          // Caller hears natural ringing while we fetch their name.
          // If lookup finishes first, we still wait the full 2s for natural feel.
          // Then Vicki greets by name in ONE message — no 'one moment please'.
          // ──────────────────────────────────────────────────────────────────
          (async () => {
            try {
              // Lookup patient + doctors in parallel, greet as soon as data is ready
              // No artificial delay — answer immediately
              const [patientResult, doctors, motives] = await Promise.all([
                callerNumber ? newsoft.getPatientByPhone(callerNumber) : Promise.resolve(null),
                newsoft.getDoctors(),
                newsoft.getMotives(),
              ]);

              patient = patientResult; cachedDoctors = doctors; cachedMotives = motives;

              // Load patient memory (null if first-time caller)
              if (patient?.patientId) {
                patientMemory = getPatientMemory(patient.patientId);
                if (patientMemory) {
                  console.log(`[Memory] Loaded for patient ${patient.patientId} — ${patientMemory.totalCalls} previous call(s)`);
                }
              }

              console.log(patient
                ? `[Newsoft] Patient: ${patient.patientName} (ID: ${patient.patientId})`
                : '[Newsoft] Unknown caller');
              console.log(`[Newsoft] ${cachedDoctors.length} doctors, ${cachedMotives.length} motives`);

              const firstName = patient?.patientName?.split(' ')[0];
              let greeting;
              if (firstName && patientMemory?.totalCalls > 0) {
                // Returning patient — skip intro, go warm and personal
                greeting = `Hi ${firstName}! Great to hear from you again — how can I help today?`;
              } else if (firstName) {
                // First time or unknown memory
                greeting = `Hi ${firstName}! I'm Vicki, Instituto Vilas Boas's virtual assistant. How can I help you today?`;
              } else {
                greeting = `Hello! I'm Vicki, Instituto Vilas Boas's virtual assistant. How can I help you today?`;
              }

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
          if (msg.media?.payload && deepgramOpen) {
            const linear = pcmaToLinear16(Buffer.from(msg.media.payload, 'base64'));
            // NOTE: audio-level barge-in removed — phone echo triggers false positives.
            // Word-count barge-in (2+ words) handles interrupts reliably instead.
            deepgramLive.send(linear);
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
    clearTimeout(maxDurationWatchdog);
    clearInterval(silenceWatchdog);
    try { deepgramLive.requestClose(); } catch (_) {}
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
}

module.exports = { handleCallStream };
