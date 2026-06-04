// ============================================================
// VICKI AI — Call Handler  (v6 — Soniox pt-PT)
// ============================================================

const WebSocket = require('ws');
const { ElevenLabsClient }    = require('@elevenlabs/elevenlabs-js');
const { processTurn, generateCallSummary } = require('./aiLogic');
const cache         = require('./newsoftCache');
const newsoft       = require('./newsoftApi');
const { getPatientMemory, updateAfterCall, logCallOutcome } = require('./patientMemory');
const telegram      = require('./telegramBot');


// Soniox real-time WebSocket endpoint
const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
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

function lookupBridgeFor(userText, currentAgent, pendingSlots) {
  if (currentAgent !== 'booking' || !pendingSlots?.length) return null;
  const text = (userText || '').toLowerCase();
  const isLookupFollowup =
    /\b(before|earlier|sooner|closer|another date|different date|anyone|any doctor|first available)\b/.test(text);
  if (!isLookupFollowup) return null;
  return "Let me check that for you.";
}

function normalizePhoneForMatch(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (digits.startsWith('351') && digits.length === 12) return digits.slice(3);
  return digits;
}

function forceUnknownCaller(callerNumber) {
  const target = normalizePhoneForMatch(callerNumber);
  if (!target) return false;
  return (process.env.FORCE_UNKNOWN_CALLER_NUMBERS || '')
    .split(',')
    .map(normalizePhoneForMatch)
    .filter(Boolean)
    .some(n => n === target);
}

function suppressEarlySpeak(text, currentAgent, pendingSlots) {
  if (currentAgent !== 'booking' || pendingSlots?.length) return false;
  return /\bwhich one\b.*\b(morning|afternoon)\b|\bmorning or (?:the )?afternoon\b/i.test(text || '');
}

function clearTelnyxAudio(telnyxWs, reason = '') {
  if (telnyxWs?.readyState !== 1) return;
  telnyxWs.send(JSON.stringify({ event: 'clear' }));
  console.log(`[TTS] Telnyx clear sent${reason ? ` (${reason})` : ''}`);
}

function playbackFallbackMs(bytesSent) {
  // ElevenLabs pcm_8000 is 8kHz, 16-bit PCM: about 16KB per second of playback.
  const estimatedMs = Math.ceil((bytesSent / 16000) * 1000);
  return Math.min(120000, Math.max(2500, estimatedMs + 3000));
}

// ─────────────────────────────────────────────
// SPEAK — stream ElevenLabs audio to Telnyx
// ─────────────────────────────────────────────
async function speak(text, telnyxWs, onDone, getAbort, playbackControls = {}) {
  if (!text?.trim() || telnyxWs.readyState !== 1) { if (onDone) onDone(); return; }

  const ttsStart = Date.now();
  let streamReadyAt = null;
  let firstMediaAt = null;
  let bytesSent = 0;
  let unregisterPlaybackDone = null;
  let fallbackTimer = null;
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    if (unregisterPlaybackDone) {
      unregisterPlaybackDone();
      unregisterPlaybackDone = null;
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (onDone) onDone();
  };

  console.log(`[TTS] Vicki says: "${text}"`);
  let aborted = false;
  if (getAbort) {
    getAbort((reason = 'abort') => {
      if (aborted) return;
      aborted = true;
      clearTelnyxAudio(telnyxWs, reason);
      finish();
    });
  }

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
    streamReadyAt = Date.now();

    // Buffer PCM chunks — sending each tiny chunk separately causes choppy audio.
    // Accumulate into 1600-byte blocks (~200ms at 8kHz) before sending to Telnyx.
    const CHUNK_SIZE = 1600;
    let buffer = Buffer.alloc(0);

    const flush = () => {
      if (buffer.length === 0 || aborted || telnyxWs.readyState !== 1) return;
      const send = buffer;
      telnyxWs.send(JSON.stringify({ event: 'media', media: { payload: send.toString('base64') } }));
      if (!firstMediaAt) firstMediaAt = Date.now();
      bytesSent += send.length;
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
          if (!firstMediaAt) firstMediaAt = Date.now();
          bytesSent += send.length;
        }
      }
    }
    // Flush remaining bytes at end of stream
    flush();

    if (!aborted) {
      const markName = playbackControls.nextMarkName
        ? playbackControls.nextMarkName()
        : 'vicki_done_speaking';
      const fallbackMs = playbackFallbackMs(bytesSent);

      telnyxWs.send(JSON.stringify({ event: 'mark', mark: { name: markName } }));
      if (playbackControls.registerDone) {
        unregisterPlaybackDone = playbackControls.registerDone(markName, finish, fallbackMs);
      } else {
        fallbackTimer = setTimeout(finish, fallbackMs);
      }
      console.log(
        `[TTS] Audio sent | stream_ready_ms=${streamReadyAt ? streamReadyAt - ttsStart : 'none'} ` +
        `first_media_ms=${firstMediaAt ? firstMediaAt - ttsStart : 'none'} ` +
        `total_ms=${Date.now() - ttsStart} bytes=${bytesSent} mark=${markName} fallback_ms=${fallbackMs}`
      );
    } else {
      console.log(
        `[TTS] Interrupted | first_media_ms=${firstMediaAt ? firstMediaAt - ttsStart : 'none'} ` +
        `total_ms=${Date.now() - ttsStart} bytes=${bytesSent}`
      );
      finish();
    }
  } catch (err) {
    if (!aborted) console.error('[TTS] Error:', err.message);
    finish();
  }
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
  let sonioxOpen          = false;
  let sonioxWs            = null;
  let pendingTranscript   = '';
  let lastInterimText     = '';   // latest Soniox interim — used to recover full sentence from rolling finals

  let processingTimer     = null;
  let pendingSlots        = [];
  let pendingAppts        = [];
  let lastOfferedDate     = null;   // date of last slot shown — next search skips past it
  let bookingReasonText   = null;
  let returnToAgent       = null;   // agent to resume after info/insurance detour
  let returnContext       = {};     // saved pendingSlots + bookingReason for resume

  const callStartTime     = Date.now();
  let lastSpeechTime      = Date.now(); // tracks last patient utterance
  let callEnding          = false;      // prevents double-hangup
  let loudPackets         = 0;          // consecutive loud audio packets (for audio barge-in)
  let speechSeq           = 0;
  const playbackDoneHandlers = new Map();

  const playbackControls = {
    nextMarkName: () => `vicki_done_speaking_${Date.now()}_${++speechSeq}`,
    registerDone: (markName, done, fallbackMs) => {
      let active = true;
      const timeout = setTimeout(() => {
        if (!active) return;
        active = false;
        playbackDoneHandlers.delete(markName);
        console.log(`[TTS] Playback done by fallback | mark=${markName} fallback_ms=${fallbackMs}`);
        done();
      }, fallbackMs);

      playbackDoneHandlers.set(markName, () => {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        playbackDoneHandlers.delete(markName);
        console.log(`[TTS] Playback mark received | mark=${markName}`);
        done();
      });

      return () => {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
        playbackDoneHandlers.delete(markName);
      };
    },
  };

  const speakToCaller = (text, onDone) =>
    speak(text, ws, onDone, (fn) => { currentAbort = fn; }, playbackControls);

  // ── Watchdog 1: Max call duration (15 min) ────────────────────────────────
  // If a call is still open after 15 min something went wrong — auto-hangup.
  const maxDurationWatchdog = setTimeout(() => {
    if (callEnding) return;
    callEnding = true;
    console.log('[Watchdog] Max duration reached (15 min) — auto-hangup');
    speakToCaller(
      "I'm so sorry, we've been connected for a while and I need to free the line. Please call us back if you need anything — goodbye!",
      () => {
        if (callSid) hangupCalls.add(callSid);
        try { ws.close(); } catch (_) {}
      }
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
      speakToCaller(
        "I haven't heard from you in a moment — I'll let you go. Feel free to call us back anytime. Goodbye!",
        () => {
          if (callSid) hangupCalls.add(callSid);
          try { ws.close(); } catch (_) {}
        }
      );
    }
  }, 15000); // check every 15 seconds



  // ── Build Soniox speech context from doctor names + dental vocabulary ──────
  // Soniox uses a "context" object to boost domain-specific accuracy.
  // Doctor names are pulled from cache so recognition is always up to date.
  let allDoctors = [];
  try { allDoctors = await cache.getDoctors(); } catch (_) {}
  const stripTitle = n => (n || '').replace(/^Dr[ªº]?\.?\s*/i, '').trim();
  const doctorNames = allDoctors.flatMap(d => [
    d.medicShortName ? stripTitle(d.medicShortName) : null,
    d.medicName      ? stripTitle(d.medicName)      : null,
  ]).filter(Boolean).filter(n => n.length > 2);

  const clinicTerms = [
    // Doctor names
    'Hermes', 'Nadine', 'Carla', 'Beatriz', 'Hugo', 'Miguel', 'Carolina', 'Sílvia', 'Fernando',
    // Clinic name
    'Vilas Boas', 'Instituto Vilas Boas',
    // Portuguese dental terms
    'consulta', 'marcação', 'cancelar', 'desmarcar', 'remarcar', 'limpeza', 'destartarização',
    'ortodontia', 'implante', 'obturação', 'extração', 'urgência', 'dor de dentes',
    'check-up', 'higiene oral', 'branqueamento', 'aparelho', 'gengivite',
    // Booking/time words
    'manhã', 'tarde', 'amanhã', 'próxima semana', 'segunda-feira', 'terça-feira',
    'quarta-feira', 'quinta-feira', 'sexta-feira',
    // English terms patients might use
    'appointment', 'cleaning', 'checkup', 'braces', 'filling', 'whitening',
  ];
  const contextWords = [...new Set([...doctorNames, ...clinicTerms])];
  console.log('[STT] Soniox context words:', contextWords.slice(0, 6).join(', '), '...');

  // ── Open Soniox WebSocket immediately ────────────────────────────────────────
  // Audio is queued locally until the connection opens.
  const sonioxAudioQueue = [];

  function openSoniox() {
    const ws = new WebSocket(SONIOX_WS_URL);
    sonioxWs = ws;

    ws.on('open', () => {
      sonioxOpen = true;
      console.log('[Soniox] Connection open');
      // Send config message first — field names per Soniox RT WebSocket API
      ws.send(JSON.stringify({
        api_key:                  process.env.SONIOX_API_KEY,
        model:                    'stt-rt-v4',        // Feb 2026 model — lowest endpoint latency
        audio_format:             'pcm_s16le',
        sample_rate:              8000,
        num_channels:             1,
        language_hints:           ['pt', 'en'],
        enable_interim_results:   true,
        enable_endpoint_detection: true,              // KEY: sends <end> token on silence → instant trigger
        max_endpoint_delay_ms:    800,                // max wait before forcing endpoint (500-3000ms)
        context: {
          entries: contextWords.map(w => ({ value: w })),
        },
      }));
      // Flush queued audio
      while (sonioxAudioQueue.length) ws.send(sonioxAudioQueue.shift());
    });

    ws.on('error', (err) => {
      console.error('[Soniox] WebSocket error:', err.message);
    });

    ws.on('close', (code, reason) => {
      sonioxOpen = false;
      console.log('[Soniox] Closed — code:', code, 'reason:', reason?.toString() || '(none)');
    });

    ws.on('message', handleSonioxMessage);
  }

  openSoniox();

  // ── Soniox transcript handler ─────────────────────────────────────────────
  async function handleSonioxMessage(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.error) {
      console.error('[Soniox] API error:', data.error, data.message || '');
      return;
    }

    // Soniox actual response schema:
    // { tokens: [{text, is_final, confidence, start_ms, end_ms}], final_audio_proc_ms, total_audio_proc_ms }
    // is_final is PER TOKEN — a message is "final" when ALL tokens have is_final=true
    // End of stream: { tokens: [], finished: true }

    if (data.finished) return;

    const tokens  = data.tokens || [];
    if (!tokens.length) return;

    // Check for endpoint detection token — Soniox sends text='<end>' when speech ends
    const endToken    = tokens.find(t => t.text === '<end>');
    const isFinal     = tokens.every(t => t.is_final === true);
    const speechTokens = tokens.filter(t => t.text !== '<end>');
    const text        = speechTokens.map(t => t.text).join('').trim();

    lastSpeechTime = Date.now();

    // ── Confidence filter ─────────────────────────────────────────────
    const confidence = speechTokens.length
      ? speechTokens.reduce((s, t) => s + (t.confidence ?? 1), 0) / speechTokens.length
      : 1;

    // ── Deduplicate and clean transcript ─────────────────────────────
    const transcript = (text || lastInterimText || '').replace(/\b(.{4,})\b(?:[.,!?]?\s+\1)+/gi, '$1');
    const wordCount  = transcript.split(/\s+/).filter(Boolean).length;

    // Update running buffer with longest seen text
    if (text && text.length > (lastInterimText || '').length) {
      lastInterimText = text;
      if (transcript !== pendingTranscript) {
        console.log(`[STT] interim: "${transcript}"`);
      }
      pendingTranscript = transcript;
    }

    // ── Barge-in: patient speaks 2+ words while Vicki talks ──────────
    if (isSpeaking && currentAbort && wordCount >= 2) {
      console.log('[Barge-in] Patient interrupted — stopping Vicki');
      clearTimeout(processingTimer); processingTimer = null;
      currentAbort('barge-in'); currentAbort = null; isSpeaking = false;
      lastInterimText = ''; pendingTranscript = '';
    }

    if (isSpeaking) return;

    // ── END TOKEN: fire AI immediately ───────────────────────────────
    // Soniox sends <end> when endpoint detection detects end-of-speech.
    // This is the fastest, most accurate trigger — no debounce needed.
    if (endToken && pendingTranscript) {
      clearTimeout(processingTimer);
      processingTimer = null;
      const userText    = pendingTranscript.trim();
      pendingTranscript = '';
      lastInterimText   = '';
      if (!userText || isSpeaking) return;
      isSpeaking = true;
      console.log(`[STT] ENDPOINT DETECTED → AI Processing: "${userText}"`);

      const speakNow = (text, onDone) => speakToCaller(text, onDone);

    try {
      let speakStarted    = false;
      let bridgeDone      = null;
      const bridgePromise = new Promise(r => { bridgeDone = r; });

      const immediateBridge = lookupBridgeFor(userText, currentAgent, pendingSlots);
      if (immediateBridge) {
        speakStarted = true;
        speakToCaller(immediateBridge, () => { isSpeaking = false; currentAbort = null; bridgeDone(); });
      }

      const onSpeakReady = (earlyText) => {
        if (!speakStarted && isSpeaking) {
          if (suppressEarlySpeak(earlyText, currentAgent, pendingSlots)) {
            console.log(`[TTS] Early speak suppressed before slots: "${earlyText}"`);
            return;
          }
          speakStarted = true;
          speakToCaller(earlyText, () => { isSpeaking = false; currentAbort = null; bridgeDone(); });
        }
      };

      // ── Second filler — fires only if API is slow (>2.5s) ──────────────
      // Plays a short patience phrase so the caller never hears dead air.
      // Cancels itself the moment processTurn returns. No agent involved.
      const PATIENCE_FILLERS = [
        "Só mais um momento...",
        "Já já...",
        "Quase pronto...",
      ];
      let patienceTimer = null;
      let patienceFired = false;
      patienceTimer = setTimeout(() => {
        if (!patienceFired && isSpeaking) {
          patienceFired = true;
          const filler = PATIENCE_FILLERS[Math.floor(Date.now() / 1000) % PATIENCE_FILLERS.length];
          console.log(`[TTS] Patience filler: "${filler}"`);
          speakToCaller(filler, () => {});
        }
      }, 3500); // raised from 2500 — avoids firing on normal 3-4s AI responses

      // ── History trimmer — keep max 24 messages, always preserve slot/appt context ──
      // Large histories slow the AI and increase hallucination risk.
      const MAX_HISTORY = 24;
      if (conversationHistory.length > MAX_HISTORY) {
        // Identify critical system messages to preserve (slots, appointments)
        const criticalKeywords = ['slotBase64=', '[ref:', 'Slots disponíveis', 'Consultas do paciente', 'RETOMA DA MARCAÇÃO'];
        const isCritical = m => m.role === 'system' && criticalKeywords.some(k => m.content?.includes(k));
        const critical   = conversationHistory.filter(isCritical);
        const rest       = conversationHistory.filter(m => !isCritical(m));
        const trimmed    = rest.slice(-(MAX_HISTORY - critical.length));
        conversationHistory = [...critical, ...trimmed];
        console.log(`[History] Trimmed to ${conversationHistory.length} messages`);
      }

      const result = await processTurn({
        history:        conversationHistory,
        patient,
        clinicInfo:     CLINIC_INFO,
        userText,
        cachedDoctors,
        cachedMotives,
        currentAgent,
        unclearTurns,
        onSpeakReady,
        pendingSlots,
        pendingAppts,
        patientMemory,
        lastOfferedDate,
        bookingReasonText,
        callerNumber,
        returnToAgent,
        returnContext,
      });
      clearTimeout(patienceTimer); // cancel filler if API was fast

      conversationHistory = result.history;
      if (result.currentAgent   !== undefined) currentAgent   = result.currentAgent;
      if (result.unclearTurns   !== undefined) unclearTurns   = result.unclearTurns;
      if (result.pendingSlots   && result.pendingSlots.length)  pendingSlots  = result.pendingSlots;
      if (result.pendingAppts   && result.pendingAppts.length)  pendingAppts  = result.pendingAppts;
      if (result.lastOfferedDate !== undefined) lastOfferedDate = result.lastOfferedDate;
      if (result.bookingReasonText !== undefined) bookingReasonText = result.bookingReasonText;
      // Resume context: when returning from info/emergency back to booking, restore slots
      if (result.returnToAgent) {
        returnToAgent  = result.returnToAgent;
        returnContext  = result.returnContext || {};
      }
      if (result.clearReturn) {
        returnToAgent  = null;
        returnContext  = {};
      }
      if (result.patient?.patientId) {
        patient = result.patient;
        patientMemory = getPatientMemory(patient.patientId);
        console.log(`[Newsoft] Active patient set: ${patient.patientName} (ID: ${patient.patientId})`);
      }

      // ── Speak the response ───────────────────────────────────────────
      if (result.actionFired && result.speak) {
        // check_slots: bridge was a loading phrase — abort it immediately and speak slots.
        // book/cancel: abort bridge and speak the API result.
        // Both cases: always stop whatever was playing and speak the real result.
        const isSlotResult = result.actionFired === 'check_slots';
        if (speakStarted && currentAbort) {
          currentAbort('action-result');
          currentAbort = null;
        }
        // For barge-in scenarios: bridgePromise may already be resolved.
        // Use race with a 300ms timeout so we never hang waiting for bridge.
        if (speakStarted) {
          await Promise.race([
            bridgePromise,
            new Promise(r => setTimeout(r, 300)),
          ]);
        }
        // Now speak the definitive API result (slots, booking/cancel confirmation, etc.)
        isSpeaking = true;
        await speakNow(result.speak, () => { isSpeaking = false; currentAbort = null; });
      } else if (result.action === 'transfer_to_human' && result.speak) {
        // TRANSFER: always abort the early AI speak and replay with the mandatory hold message.
        if (speakStarted && currentAbort) {
          currentAbort('transfer');
          currentAbort = null;
        }
        if (speakStarted) await bridgePromise;
        isSpeaking = true;
        await speakNow(result.speak, () => { isSpeaking = false; currentAbort = null; });
      } else if (result.speak && !speakStarted && isSpeaking) {
        // No API action, bridge didn't fire — speak result directly
        await speakNow(result.speak, () => { isSpeaking = false; currentAbort = null; });
      } else if (!speakStarted) {
        isSpeaking = false; currentAbort = null;
      }
      // speakStarted && !actionFired → onSpeakReady TTS handles cleanup

      // ── Persistent audit: Telegram notification on every booking/cancel ──
      // Railway logs vanish on redeploy — Telegram gives a permanent record.
      if (result.actionFired === 'book_appointment' && result.action !== 'transfer_to_human') {
        const ptName = patient?.patientName || 'Novo paciente';
        const msg = [
          '✅ *MARCAÇÃO CONFIRMADA*',
          `👤 Paciente: ${ptName} (ID: ${patient?.patientId || '?'})`,
          `📱 Tel: ${callerNumber || '?'}`,
          `🗣 Vicki disse: ${result.speak?.slice(0, 120) || '?'}`,
        ].join('\n');
        telegram.notify(msg).catch(() => {});
      }
      if (result.actionFired === 'cancel_appointment' && result.action !== 'transfer_to_human') {
        const ptName = patient?.patientName || 'Desconhecido';
        const msg = [
          '❌ *CONSULTA CANCELADA*',
          `👤 Paciente: ${ptName} (ID: ${patient?.patientId || '?'})`,
          `📱 Tel: ${callerNumber || '?'}`,
        ].join('\n');
        telegram.notify(msg).catch(() => {});
      }

      // ── AUTO-SPEAK: after silent inter-agent transfer, fire new agent immediately ──
      // Without this the new agent waits silently for patient to speak again.
      if (result.autoSpeak && !callEnding) {
        if (speakStarted) await bridgePromise;
        await new Promise(r => setTimeout(r, 150));
        console.log(`[Agent] autoSpeak: firing ${currentAgent} after transfer`);
        isSpeaking = true;
        let autoResult;
        try {
          autoResult = await processTurn({
            history:          conversationHistory,
            patient,
            clinicInfo:       CLINIC_INFO,
            userText:         '[continua]',
            cachedDoctors,
            cachedMotives,
            currentAgent,
            unclearTurns,
            onSpeakReady:     null,
            pendingSlots,
            pendingAppts,
            patientMemory,
            lastOfferedDate,
            bookingReasonText,
            callerNumber,
            returnToAgent,
            returnContext,
          });
        } catch (autoErr) {
          console.error('[Agent] autoSpeak error:', autoErr.message);
          isSpeaking = false;
          autoResult = null;
        }
        if (autoResult) {
          conversationHistory = autoResult.history;
          if (autoResult.currentAgent   !== undefined) currentAgent   = autoResult.currentAgent;
          if (autoResult.pendingSlots   && autoResult.pendingSlots.length)  pendingSlots  = autoResult.pendingSlots;
          if (autoResult.pendingAppts   && autoResult.pendingAppts.length)  pendingAppts  = autoResult.pendingAppts;
          if (autoResult.bookingReasonText !== undefined) bookingReasonText = autoResult.bookingReasonText;
          if (autoResult.lastOfferedDate !== undefined) lastOfferedDate = autoResult.lastOfferedDate;
          if (autoResult.returnToAgent) { returnToAgent = autoResult.returnToAgent; returnContext = autoResult.returnContext || {}; }
          if (autoResult.clearReturn)   { returnToAgent = null; returnContext = {}; }
          if (autoResult.patient?.patientId) { patient = autoResult.patient; }
          if (autoResult.speak) {
            await speakNow(autoResult.speak, () => { isSpeaking = false; currentAbort = null; });
          } else {
            isSpeaking = false; currentAbort = null;
          }
          // ── CRITICAL: if autoSpeak result itself wants transfer/hangup, execute it ──
          if (autoResult.action === 'transfer_to_human' && !callEnding) {
            callEnding = true;
            clearTimeout(maxDurationWatchdog);
            clearInterval(silenceWatchdog);
            const transferNumber = process.env.CLINIC_PHONE_MOBILE || '+351962432761';
            console.log(`[Call] autoSpeak → Transferring to human — ${transferNumber}`);
            if (callSid) transferCalls.set(callSid, transferNumber);
            setTimeout(() => { try { ws.close(); } catch (_) {} }, 500);
            return;
          }
          if (autoResult.action === 'hangup' && !callEnding) {
            callEnding = true;
            clearTimeout(maxDurationWatchdog);
            clearInterval(silenceWatchdog);
            const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
            generateCallSummary(conversationHistory, patient)
              .then(summary => {
                if (patient?.patientId) updateAfterCall(patient.patientId, { patientName: patient.patientName, summary: summary.summary, intent: summary.intent, language: summary.language, explicitDoctorPreference: summary.explicitDoctorPreference, explicitTimePreference: summary.explicitTimePreference });
                logCallOutcome({ patientId: patient?.patientId, patientName: patient?.patientName, callerNumber, outcome: summary.outcome, intent: summary.intent, transferredToHuman: false, unclearTurns, durationSeconds, summary: summary.summary, flags: summary.flags || [] });
              }).catch(e => console.error('[Memory] Save error:', e.message));
            let waited2 = 0;
            const doHangup2 = () => { if (!isSpeaking || waited2 > 6000) { try { ws.close(); } catch (_) {} } else { waited2 += 200; setTimeout(doHangup2, 200); } };
            doHangup2();
            return;
          }
        }
      }

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
    }  // end if (endToken)
  }  // end handleSonioxMessage




  // ── Telnyx WebSocket ──────────────────────
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.event) {

        case 'connected':
          console.log('[Telnyx] Connected');
          break;

        case 'start':
          // Telnyx sends call_control_id as the call identifier in TeXML streams
          callSid = msg.start?.call_control_id
                 || msg.start?.callSid
                 || msg.start?.call_sid
                 || msg.start?.CallSid
                 || msg.streamSid
                 || null;
          callerNumber = msg.start?.customParameters?.callerNumber
                      || msg.start?.from
                      || null;
          console.log(`[Call] Started. Caller: ${callerNumber} | SID: ${callSid}`);

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
              const forceUnknown = forceUnknownCaller(callerNumber);
              if (forceUnknown) {
                console.log(`[Newsoft] Forced unknown caller override active for ${callerNumber}`);
              }
              const [patientResult, doctors, motives] = await Promise.all([
                callerNumber && !forceUnknown ? newsoft.getPatientByPhone(callerNumber) : Promise.resolve(null),
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
                // Paciente recorrente — vai direto ao assunto, caloroso e pessoal
                greeting = `Olá ${firstName}! Que bom ouvir a sua voz — em que posso ajudar hoje?`;
              } else if (firstName) {
                // Primeiro contacto ou memória desconhecida
                greeting = `Olá ${firstName}! Sou a Vicki, a assistente virtual do Instituto Vilas Boas. Em que posso ajudar?`;
              } else {
                greeting = `Olá! Sou a Vicki, a assistente virtual do Instituto Vilas Boas. Em que posso ajudar?`;
              }

              isSpeaking = true;
              speakToCaller(greeting, () => { isSpeaking = false; currentAbort = null; });

            } catch (err) {
              console.error('[Startup] Error:', err.message);
              isSpeaking = true;
              speakToCaller(
                "Olá! Sou a Vicki, a assistente virtual do Instituto Vilas Boas. Em que posso ajudar?",
                () => { isSpeaking = false; currentAbort = null; }
              );
            }
          })();
          break;

        case 'media':
          if (msg.media?.payload) {
            const linear = pcmaToLinear16(Buffer.from(msg.media.payload, 'base64'));
            // NOTE: audio-level barge-in removed — phone echo triggers false positives.
            // Word-count barge-in (2+ words) handles interrupts reliably instead.
            if (sonioxOpen && sonioxWs?.readyState === WebSocket.OPEN) {
              sonioxWs.send(linear);
            } else {
              // Queue audio until Soniox connection is ready
              sonioxAudioQueue.push(linear);
            }
          }
          break;

        case 'mark':
          if (msg.mark?.name) {
            const done = playbackDoneHandlers.get(msg.mark.name);
            if (done) {
              done();
            } else if (msg.mark.name === 'vicki_done_speaking') {
              isSpeaking = false;
              currentAbort = null;
            } else {
              console.log(`[TTS] Untracked playback mark | mark=${msg.mark.name}`);
            }
          }
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
    try { if (sonioxWs) { sonioxWs.close(); sonioxWs = null; } } catch (_) {}
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
}

module.exports = { handleCallStream };
