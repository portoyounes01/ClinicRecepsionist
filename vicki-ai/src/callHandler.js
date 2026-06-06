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

// Accumulate every slot shown this call (dedup by token) so an "another day"
// search never re-offers one the patient already saw — prevents the rotation
// from ping-ponging between the same two slots.
function accumulateOffered(offered, justShown) {
  const seen = new Set((offered || []).map(s => s.slotBase64));
  const out = (offered || []).slice();
  for (const s of justShown || []) {
    if (s && s.slotBase64 && !seen.has(s.slotBase64)) { seen.add(s.slotBase64); out.push(s); }
  }
  return out.slice(-30); // cap memory
}

// ── Cartesia TTS (low-latency alternative to ElevenLabs) ─────────────────────
// Streams Sonic via the SSE endpoint and yields raw PCMU 8kHz Buffers.
// Enabled by TTS_PROVIDER=cartesia. Needs CARTESIA_API_KEY + CARTESIA_VOICE_ID.
// Docs: https://docs.cartesia.ai/api-reference/tts  (Cartesia-Version 2025-04-16)
async function* cartesiaPcmStream(text, language = 'pt') {
  const ttsLanguage = language === 'en' ? 'en' : 'pt';
  const res = await fetch('https://api.cartesia.ai/tts/sse', {
    method: 'POST',
    headers: {
      'X-API-Key':        process.env.CARTESIA_API_KEY,
      'Cartesia-Version': '2025-04-16',
      'Content-Type':     'application/json',
    },
    body: JSON.stringify({
      model_id:      process.env.CARTESIA_MODEL_ID || 'sonic-3.5',
      transcript:    text,
      voice:         { mode: 'id', id: process.env.CARTESIA_VOICE_ID },
      language:      ttsLanguage,
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    }),
  });
  if (!res.ok || !res.body) {
    let detail = ''; try { detail = await res.text(); } catch (_) {}
    throw new Error(`Cartesia TTS ${res.status}: ${detail.slice(0, 200)}`);
  }
  // Parse the SSE stream: lines "data: {json}", each with base64 PCM in .data.
  const decoder = new TextDecoder();
  let sse = '';
  for await (const part of res.body) {
    sse += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = sse.indexOf('\n')) !== -1) {
      const line = sse.slice(0, nl).trim();
      sse = sse.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let msg; try { msg = JSON.parse(payload); } catch (_) { continue; }
      if (msg.type === 'chunk' && msg.data) yield Buffer.from(msg.data, 'base64');
      else if (msg.type === 'error') throw new Error(`Cartesia: ${msg.message || 'stream error'}`);
    }
  }
}

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

function suppressUnsafeEarlySpeak(text) {
  const value = text || '';
  return /(\best[aá]\s+(tudo\s+)?(marcad|confirmad|tratad|feito|pronto)\b|\bbooked\b|\bconfirmed\b|\bcancelled\b|\bcanceled\b|\bconsulta\s+(marcada|cancelada)\b)/i
    .test(value);
}

// ── Turn-taking config ──────────────────────────────────────────────────────
// While Vicki is speaking the mic is CLOSED — anything heard during her turn is
// discarded, so she finishes her full utterance and never answers things said over
// her. She opens to listen again only after her last word has played.
// BARGE_IN_MODE:
//   'off'  (default) — never interrupt; mic stays closed until she finishes.
//   'full'           — allow a hard interruption on sustained, non-backchannel speech.
// VOICE NOTE: this directly changes when Vicki stops talking on the phone.
const BARGE_IN_MODE      = (process.env.BARGE_IN_MODE || 'off').toLowerCase();
const BARGE_IN_MIN_WORDS = Math.max(1, parseInt(process.env.BARGE_IN_MIN_WORDS || '4', 10));

// Pure acknowledgements/backchannels — the caller saying one of these alone is NOT a
// real interruption; only consulted when BARGE_IN_MODE='full'.
const BACKCHANNEL_RE = /^(sim|ok|okay|okey|t[aá]|certo|claro|pois|exato|exacto|isso|uh|uhh|hum+|hmm+|ah|aha|ah[aã]|yeah|yep|yes|right|sure|mm|mhm|uh-huh)[\s.,!?]*$/i;
function isBackchannel(text) {
  return BACKCHANNEL_RE.test((text || '').trim());
}

// ── Smart endpointing ────────────────────────────────────────────────────────
// Soniox fires <end> after a short silence. If the caller is just pausing to think,
// that silence can cut them off and Vicki answers/repeats prematurely. So when the
// phrase LOOKS unfinished (ends on a connector/preposition/filler), we wait a brief
// grace for them to continue; complete-sounding phrases still fire instantly (speed).
const ENDPOINT_GRACE_MS = Math.max(0, parseInt(process.env.ENDPOINT_GRACE_MS || '700', 10));
const INITIAL_RING_DELAY_MS = Math.max(0, parseInt(process.env.INITIAL_RING_DELAY_MS || '4000', 10));

const _norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Words that, when they are the LAST word spoken, signal "I'm not done yet."
const DANGLING_WORDS = new Set([
  // PT connectors / prepositions / articles
  'e','ou','mas','que','de','do','da','dos','das','no','na','nos','nas','para','pra','por','com','sem',
  'a','o','os','as','um','uma','uns','umas','em','ao','aos','se','quando','onde','porque','entao','tipo','assim','minha','meu','meus','minhas',
  // EN connectors / prepositions / articles
  'and','or','but','that','of','to','for','with','without','an','the','in','on','at','my','your','its',
  'is','it','so','like','because','when','where','i','we','a',
]);
// Trailing fillers (any language) → also "not done"
const TRAILING_FILLER_RE = /\b(uh+|um+|eh+|er+|hmm+|hum+|well|so)$/;

function looksIncomplete(text) {
  const t = _norm(text);
  if (!t) return true;
  if (TRAILING_FILLER_RE.test(t)) return true;
  const words = t.split(' ');
  const last  = words[words.length - 1].replace(/[.,!?;:]+$/, '');
  return DANGLING_WORDS.has(last);
}

// Merge a freshly-finalized segment into the running turn, tolerant of whether
// Soniox sends a cumulative interim or resets to a new segment after <end>.
function mergeTurn(prev, seg) {
  const p = (prev || '').trim(), s = (seg || '').trim();
  if (!p) return s;
  if (!s) return p;
  if (s.startsWith(p) || s.includes(p)) return s;  // cumulative — seg already contains prev
  if (p.endsWith(s)) return p;                     // duplicate tail
  return `${p} ${s}`;                              // new segment — append
}

function clearTelnyxAudio(telnyxWs, reason = '') {
  if (telnyxWs?.readyState !== 1) return;
  telnyxWs.send(JSON.stringify({ event: 'clear' }));
  console.log(`[TTS] Telnyx clear sent${reason ? ` (${reason})` : ''}`);
}

function playbackFallbackMs(bytesSent) {
  // PCMU is 8-bit 8kHz: about 8KB per second of playback.
  const estimatedMs = Math.ceil((bytesSent / 8000) * 1000);
  return Math.min(120000, Math.max(2500, estimatedMs + 3000));
}

function sanitizeSpeechText(text) {
  return String(text || '')
    .replace(/\b(Dr|Dra)\./gi, '$1')
    .replace(/\b(Doutor|Doutora)\.(?=\s|$)/gi, '$1')
    .replace(/\b([A-Za-zÀ-ÿ]+)-lo\/a\b/gi, '$1-lo ou $1-la')
    .replace(/\b([A-Za-zÀ-ÿ]+)-la\/o\b/gi, '$1-la ou $1-lo')
    .replace(/([A-Za-zÀ-ÿ])\/([A-Za-zÀ-ÿ])/g, '$1 ou $2')
    // Only convert DASHES used as punctuation (em/en dash, or a hyphen padded by
    // spaces) into a comma pause. NEVER touch word-internal hyphens — those join
    // real words like "quinta-feira" (Thursday) and clitics like "Esperamo-lo".
    .replace(/\s*[—–]\s*|\s+-\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,+/g, ',')
    .trim();
}

// ─────────────────────────────────────────────
// SPEAK — stream ElevenLabs audio to Telnyx
// ─────────────────────────────────────────────
function isFinalFarewell(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (/[?]\s*$/.test(raw) || /\b(anything else|help with anything else|how else can i help|mais alguma coisa|posso ajudar|ajudar em mais alguma coisa|precisa de mais alguma coisa)\b/.test(normalized)) {
    return false;
  }

  return /\b(goodbye|bye|have a good day|have a nice day|take care|thank you for calling|thanks for calling|thank you|thanks|ate logo|ate ja|adeus|obrigado|obrigada|tenha um bom dia|tenha uma boa tarde|resto de bom dia|resto de boa tarde)\s*[.!]*$/.test(normalized);
}

async function speak(text, telnyxWs, onDone, getAbort, playbackControls = {}) {
  if (!text?.trim() || telnyxWs.readyState !== 1) { if (onDone) onDone(); return; }

  const spokenText = sanitizeSpeechText(text);
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

  console.log(`[TTS] Vicki says: "${spokenText}"`);
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
    // TTS provider is swappable via TTS_PROVIDER. Both emit raw PCMU 8kHz, matching
    // the TeXML bidirectional RTP stream in server.js.
    const isCartesia = (process.env.TTS_PROVIDER || 'elevenlabs').toLowerCase() === 'cartesia';
    const ttsLanguage = playbackControls.language === 'en' ? 'en' : 'pt';
    const audioStream = isCartesia
      ? cartesiaPcmStream(spokenText, ttsLanguage)
      : await elevenlabs.textToSpeech.stream(
          process.env.ELEVENLABS_VOICE_ID,
          {
            text: spokenText,
            model_id:                   'eleven_flash_v2_5',
            output_format:              'ulaw_8000',
            optimize_streaming_latency:  4,
            voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          }
        );
    streamReadyAt = Date.now();

    // Buffer into 100ms PCMU frames. Telnyx accepts 20ms-30s RTP payload chunks,
    // but pacing prevents bursty TTS streams from overrunning call playback.
    const CHUNK_SIZE = 800;
    let buffer = Buffer.alloc(0);

    const flush = () => {
      if (buffer.length === 0 || aborted || telnyxWs.readyState !== 1) return;
      const send = buffer;
      telnyxWs.send(JSON.stringify({ event: 'media', media: { payload: send.toString('base64') } }));
      if (!firstMediaAt) firstMediaAt = Date.now();
      bytesSent += send.length;
      buffer = Buffer.alloc(0);
    };

    const paceMs = 95;
    const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
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
          if (paceMs) await sleep(paceMs);
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
// G.711 → Linear16 converters
// ─────────────────────────────────────────────
function alawToLinear(b) {
  b ^= 0x55;
  const sign = b & 0x80, exp = (b & 0x70) >> 4, mant = b & 0x0F;
  let s = exp === 0 ? (mant << 4) + 8 : ((mant + 16) << (exp + 3)) - (16 << 4);
  return sign === 0 ? -s : s;
}

function mulawToLinear(b) {
  b = ~b & 0xFF;
  const sign = b & 0x80;
  const exp = (b >> 4) & 0x07;
  const mant = b & 0x0F;
  let s = ((mant << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

function pcmaToLinear16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(alawToLinear(buf[i]), i * 2);
  return out;
}

function pcmuToLinear16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(mulawToLinear(buf[i]), i * 2);
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
  let processingTurn      = false;
  let sonioxWs            = null;
  let telnyxMediaEncoding = 'PCMU';
  let pendingTranscript   = '';
  let lastInterimText     = '';   // latest Soniox interim — used to recover full sentence from rolling finals

  let processingTimer     = null;
  let pendingSlots        = [];
  let offeredSlots        = [];     // EVERY slot shown this call — so "another day" never re-offers one
  let pendingAppts        = [];
  let lastOfferedDate     = null;   // date of last slot shown — next search skips past it
  let bookingReasonText   = null;
  let returnToAgent       = null;   // agent to resume after info/insurance detour
  let returnContext       = {};     // saved pendingSlots + bookingReason for resume
  let languageState       = 'unknown';

  // ── Smart endpointing state ───────────────────────────────────────────────
  let turnBuffer          = '';     // accumulates the caller's words across thinking pauses
  let endpointGraceTimer  = null;   // pending grace wait when a phrase sounds unfinished

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
    speak(text, ws, onDone, (fn) => { currentAbort = fn; }, {
      ...playbackControls,
      language: languageState === 'en' ? 'en' : 'pt',
    });

  const finishCallAfterAudio = (reason = 'final-farewell') => {
    if (callEnding) return true;
    callEnding = true;
    clearTimeout(maxDurationWatchdog);
    clearInterval(silenceWatchdog);
    console.log(`[Call] Ending after ${reason}`);

    const durationSeconds = Math.round((Date.now() - callStartTime) / 1000);
    generateCallSummary(conversationHistory, patient)
      .then(summary => {
        if (patient?.patientId) {
          const spokenLang = (languageState === 'en' || languageState === 'pt') ? languageState : summary.language;
          updateAfterCall(patient.patientId, {
            patientName:              patient.patientName,
            summary:                  summary.summary,
            intent:                   summary.intent,
            language:                 spokenLang,
            explicitDoctorPreference: summary.explicitDoctorPreference,
            explicitTimePreference:   summary.explicitTimePreference,
          });
        }
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

    let waited = 0;
    const doHangup = () => {
      if (isSpeaking && waited < 8000) {
        waited += 200;
        setTimeout(doHangup, 200);
        return;
      }
      setTimeout(() => {
        console.log('[Call] Final audio finished — triggering instant hangup');
        if (callSid) {
          const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : `http://localhost:${process.env.PORT || 3000}`;
          const body = `CallSid=${encodeURIComponent(callSid)}`;
          try {
            const url = new URL(`${baseUrl}/telnyx/hangup-now`);
            const reqOpts = {
              hostname: url.hostname,
              port:     url.port || (url.protocol === 'https:' ? 443 : 80),
              path:     url.pathname,
              method:   'POST',
              headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
            };
            const mod = url.protocol === 'https:' ? require('https') : require('http');
            const hreq = mod.request(reqOpts, hres => {
              console.log(`[Call] hangup-now response: ${hres.statusCode}`);
            });
            hreq.on('error', e => console.error('[Call] hangup-now request error:', e.message));
            hreq.write(body);
            hreq.end();
          } catch (e) {
            console.error('[Call] hangup-now URL error:', e.message);
            hangupCalls.add(callSid);
          }
        }
        try { ws.close(); } catch (_) {}
      }, 400);
    };
    doHangup();
    return true;
  };

  // ── Watchdog 1: Max call duration (15 min) ────────────────────────────────
  // If a call is still open after 15 min something went wrong — auto-hangup.
  const maxDurationWatchdog = setTimeout(() => {
    if (callEnding) return;
    callEnding = true;
    console.log('[Watchdog] Max duration reached (15 min) — auto-hangup');
    speakToCaller(
      "Pedimos desculpa — a chamada está a demorar muito e preciso de libertar a linha. Por favor ligue novamente se precisar de ajuda — até logo!",
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
        max_endpoint_delay_ms:    500,                // max wait before forcing endpoint (500-3000ms)
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

    // ── MIC CLOSED while Vicki is speaking or thinking ───────────────────────
    // Everything heard during her turn is discarded so she finishes her full
    // utterance and never answers things said over her. The buffer is kept empty
    // so nothing from her turn leaks into the next one. She re-opens to listen
    // only after her last word has played (isSpeaking flips false on the TTS mark).
    if (isSpeaking || processingTurn) {
      // Optional hard interruption — only if explicitly enabled via BARGE_IN_MODE='full'.
      if (BARGE_IN_MODE === 'full' && isSpeaking && !processingTurn && currentAbort
          && wordCount >= BARGE_IN_MIN_WORDS && !isBackchannel(transcript)) {
        console.log('[Barge-in] Patient interrupted — stopping Vicki');
        clearTimeout(processingTimer); processingTimer = null;
        currentAbort('barge-in'); currentAbort = null; isSpeaking = false;
      }
      lastInterimText = ''; pendingTranscript = ''; turnBuffer = '';
      if (endpointGraceTimer) { clearTimeout(endpointGraceTimer); endpointGraceTimer = null; }
      return;
    }

    // ── Vicki is silent — accumulate the caller's words ──────────────────────
    if (text && text.length > (lastInterimText || '').length) {
      lastInterimText = text;
      if (transcript !== pendingTranscript) {
        console.log(`[STT] interim: "${transcript}"`);
      }
      pendingTranscript = transcript;
      // Caller resumed talking during a grace wait → cancel it; a new <end> will follow.
      if (endpointGraceTimer) {
        clearTimeout(endpointGraceTimer); endpointGraceTimer = null;
        console.log('[STT] caller resumed — endpoint grace cancelled');
      }
    }

    // ── END TOKEN: decide whether the turn is really finished ─────────────────
    // Soniox sends <end> after a short silence. Fire immediately when the phrase
    // sounds complete; wait a brief grace when it sounds unfinished (thinking pause).
    if (endToken && (pendingTranscript || turnBuffer)) {
      clearTimeout(processingTimer); processingTimer = null;
      turnBuffer = mergeTurn(turnBuffer, pendingTranscript);
      pendingTranscript = '';
      lastInterimText   = '';
      const candidate = turnBuffer.trim();
      if (!candidate) return;

      // Low confidence + very short → ask to repeat (unchanged behavior).
      if (confidence < 0.55 && wordCount <= 4) {
        console.log(`[STT] Low confidence (${confidence.toFixed(2)}) — asking caller to repeat: "${candidate}"`);
        turnBuffer = '';
        isSpeaking = true;
        speakToCaller(languageState === 'en' ? 'Sorry, I didn\'t quite catch that. Could you repeat, please?' : 'Desculpe, não percebi bem. Pode repetir, por favor?', () => { isSpeaking = false; currentAbort = null; });
        return;
      }

      // Short phrases (≤3 words) get a little extra grace even if they look
      // complete — "sim" / "ok" / "tarde" alone sometimes precede more words
      // ("sim, de tarde"). Kept at 1.0× (not 1.5×) so common confirmations like
      // "yes"/"okay" don't add ~500ms of dead air before Vicki responds.
      const candidateWords = candidate.split(/\s+/).filter(Boolean).length;
      const shortPhraseGrace = candidateWords <= 3 ? ENDPOINT_GRACE_MS : 0;

      if (looksIncomplete(candidate) || shortPhraseGrace > 0) {
        const graceMs = looksIncomplete(candidate) ? ENDPOINT_GRACE_MS : shortPhraseGrace;
        console.log(`[STT] Waiting ${graceMs}ms before firing (${looksIncomplete(candidate) ? 'incomplete phrase' : `short phrase ${candidateWords}w`}): "${candidate}"`);
        clearTimeout(endpointGraceTimer);
        endpointGraceTimer = setTimeout(() => {
          endpointGraceTimer = null;
          if (isSpeaking || processingTurn) { turnBuffer = ''; return; }
          const finalText = turnBuffer.trim();
          turnBuffer = ''; pendingTranscript = ''; lastInterimText = '';
          if (!finalText) return;
          console.log(`[STT] Grace elapsed → AI Processing: "${finalText}"`);
          runTurn(finalText);
        }, graceMs);
        return;
      }

      // Sounds complete → fire now (no added latency).
      clearTimeout(endpointGraceTimer); endpointGraceTimer = null;
      turnBuffer = '';
      console.log(`[STT] ENDPOINT DETECTED → AI Processing: "${candidate}"`);
      runTurn(candidate);
    }
  }  // end handleSonioxMessage

  // ── runTurn: execute one full conversation turn (LLM → action → speech) ──────
  // Called on endpoint detection, or deferred by the flush watchdog after Vicki
  // finishes a protected message so she always answers what the caller said.
  async function runTurn(userText) {
      isSpeaking = true;
      processingTurn = true;

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
          if (suppressEarlySpeak(earlyText, currentAgent, pendingSlots) || suppressUnsafeEarlySpeak(earlyText) || /\btransfer|\btransfir|\bpass(?:ar|o|a)\b|\bequipa de\b|\bbooking team\b|\bconsultas\b.*\bteam\b/i.test(earlyText || '')) {
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
      const PATIENCE_FILLERS = languageState === 'en'
        ? ["Just one moment...", "Almost there...", "One second..."]
        : ["Só mais um momento...", "Já já...", "Quase pronto..."];
      let patienceTimer = null;
      let patienceFired = false;
      patienceTimer = setTimeout(() => {
        if (!patienceFired && isSpeaking) {
          patienceFired = true;
          const filler = PATIENCE_FILLERS[Math.floor(Date.now() / 1000) % PATIENCE_FILLERS.length];
          console.log(`[TTS] Patience filler: "${filler}"`);
          speakToCaller(filler, () => {});
        }
      }, 2500); // fire sooner so callers don't sit in dead air on slow first-token (2-3s) responses

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
        offeredSlots,
        pendingAppts,
        patientMemory,
        lastOfferedDate,
        bookingReasonText,
        callerNumber,
        returnToAgent,
        returnContext,
        languageState,
      });
      clearTimeout(patienceTimer); // cancel filler if API was fast

      conversationHistory = result.history;
      if (result.languageState !== undefined) languageState = result.languageState;
      if (result.currentAgent   !== undefined) currentAgent   = result.currentAgent;
      if (result.unclearTurns   !== undefined) unclearTurns   = result.unclearTurns;
      if (result.pendingSlots   && result.pendingSlots.length)  { pendingSlots  = result.pendingSlots; offeredSlots = accumulateOffered(offeredSlots, result.pendingSlots); }
      if (result.pendingAppts   !== undefined) pendingAppts  = result.pendingAppts;
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
      if (!callEnding && result.action !== 'hangup' && result.speak && isFinalFarewell(result.speak)) {
        finishCallAfterAudio('final farewell phrase');
        return;
      }

      if (result.autoSpeak && !callEnding) {
        if (speakStarted && currentAbort) {
          currentAbort('silent-agent-transfer');
          currentAbort = null;
        }
        if (speakStarted) {
          await Promise.race([
            bridgePromise,
            new Promise(r => setTimeout(r, 300)),
          ]);
        }
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
            offeredSlots,
            pendingAppts,
            patientMemory,
            lastOfferedDate,
            bookingReasonText,
            callerNumber,
            returnToAgent,
            returnContext,
            languageState,
          });
        } catch (autoErr) {
          console.error('[Agent] autoSpeak error:', autoErr.message);
          isSpeaking = false;
          autoResult = null;
        }
        if (autoResult) {
          conversationHistory = autoResult.history;
          if (autoResult.languageState !== undefined) languageState = autoResult.languageState;
          if (autoResult.currentAgent   !== undefined) currentAgent   = autoResult.currentAgent;
          if (autoResult.pendingSlots   && autoResult.pendingSlots.length)  { pendingSlots  = autoResult.pendingSlots; offeredSlots = accumulateOffered(offeredSlots, autoResult.pendingSlots); }
          if (autoResult.pendingAppts   !== undefined) pendingAppts  = autoResult.pendingAppts;
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
          if (!callEnding && autoResult.action !== 'hangup' && autoResult.speak && isFinalFarewell(autoResult.speak)) {
            finishCallAfterAudio('auto final farewell phrase');
            return;
          }
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
                // Persist the language the caller ACTUALLY spoke this call (live
                // detection) over the LLM summary's guess — the guess kept
                // overwriting an established 'en' back to 'pt'.
                const spokenLang = (languageState === 'en' || languageState === 'pt') ? languageState : summary.language;
                if (patient?.patientId) updateAfterCall(patient.patientId, { patientName: patient.patientName, summary: summary.summary, intent: summary.intent, language: spokenLang, explicitDoctorPreference: summary.explicitDoctorPreference, explicitTimePreference: summary.explicitTimePreference });
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
              // Prefer the language actually spoken this call over the summary guess.
              const spokenLang = (languageState === 'en' || languageState === 'pt') ? languageState : summary.language;
              updateAfterCall(patient.patientId, {
                patientName:              patient.patientName,
                summary:                  summary.summary,
                intent:                   summary.intent,
                language:                 spokenLang,
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

        // Wait for Vicki to finish her goodbye, then hang up immediately.
        // Polls every 200ms until TTS mark fires (isSpeaking → false), max 8s.
        // Then calls /telnyx/hangup-now directly — no keep-alive wait.
        const http = require('http');
        let waited = 0;
        const doHangup = () => {
          if (isSpeaking && waited < 8000) {
            waited += 200;
            setTimeout(doHangup, 200);
            return;
          }
          // Small buffer so the last audio byte reaches the patient's speaker
          setTimeout(() => {
            console.log(`[Call] Goodbye finished — triggering instant hangup`);
            // Fire /telnyx/hangup-now so Telnyx ends the call immediately
            if (callSid) {
              const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : `http://localhost:${process.env.PORT || 3000}`;
              const body = `CallSid=${encodeURIComponent(callSid)}`;
              try {
                const url = new URL(`${baseUrl}/telnyx/hangup-now`);
                const reqOpts = {
                  hostname: url.hostname,
                  port:     url.port || (url.protocol === 'https:' ? 443 : 80),
                  path:     url.pathname,
                  method:   'POST',
                  headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
                };
                const mod = url.protocol === 'https:' ? require('https') : require('http');
                const hreq = mod.request(reqOpts, hres => {
                  console.log(`[Call] hangup-now response: ${hres.statusCode}`);
                });
                hreq.on('error', e => console.error('[Call] hangup-now request error:', e.message));
                hreq.write(body);
                hreq.end();
              } catch (e) {
                console.error('[Call] hangup-now URL error:', e.message);
                hangupCalls.add(callSid); // fallback to keep-alive
              }
            }
            try { ws.close(); } catch (_) {}
          }, 400);
        };
        doHangup();
      }
      processingTurn = false;
    } catch (err) {
      console.error('[AI] Error:', err.message, err.stack);
      processingTurn = false;
      await speakNow(languageState === 'en' ? 'Sorry, I didn\'t quite catch that — could you repeat?' : 'Desculpe, não percebi bem — pode repetir?', () => { isSpeaking = false; currentAbort = null; });
      isSpeaking = false;
    }
  }  // end runTurn




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
          telnyxMediaEncoding = String(msg.start?.media_format?.encoding || 'PCMU').toUpperCase();
          console.log(`[Telnyx] Media format: ${telnyxMediaEncoding} ${msg.start?.media_format?.sample_rate || 8000}Hz`);
          console.log(`[Call] Started. Caller: ${callerNumber} | SID: ${callSid}`);

          // ── Look up patient name BEFORE speaking ─────────────────────────────────
          // Race: lookup vs initial ring delay.
          // Caller hears natural ringing while we fetch their name.
          // If lookup finishes first, we still wait the configured delay for natural feel.
          // Then Vicki greets by name in ONE message — no 'one moment please'.
          // ──────────────────────────────────────────────────────────────────
          (async () => {
            const startupStartedAt = Date.now();
            try {
              // Lookup patient + doctors in parallel while the caller hears ringing.
              const ringDelay = new Promise(r => setTimeout(r, INITIAL_RING_DELAY_MS));
              const forceUnknown = forceUnknownCaller(callerNumber);
              if (forceUnknown) {
                console.log(`[Newsoft] Forced unknown caller override active for ${callerNumber}`);
              }
              const [patientResult, doctors, motives] = await Promise.all([
                callerNumber && !forceUnknown ? newsoft.getPatientByPhone(callerNumber) : Promise.resolve(null),
                newsoft.getDoctors(),
                newsoft.getMotives(),
                ringDelay,
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
              // If we already established this caller speaks English, greet in English and
              // seed languageState so action results/fillers start in the right language.
              const greetEn = patientMemory?.language === 'en';
              if (greetEn) languageState = 'en';
              let greeting;
              if (firstName && patientMemory?.totalCalls > 0) {
                // Returning patient — go straight to the point, warm and personal
                greeting = greetEn
                  ? `Hi ${firstName}! You've reached Instituto Vilas Boas in Loulé — lovely to hear from you. How can I help today?`
                  : `Olá ${firstName}! Ligou para o Instituto Vilas Boas em Loulé — que bom ouvir a sua voz. Em que posso ajudar hoje?`;
              } else if (firstName) {
                greeting = greetEn
                  ? `Hi ${firstName}! I'm Vicki, the virtual assistant at Instituto Vilas Boas in Loulé. How can I help?`
                  : `Olá ${firstName}! Sou a Vicki, a assistente virtual do Instituto Vilas Boas em Loulé. Em que posso ajudar?`;
              } else {
                greeting = greetEn
                  ? `Hello! I'm Vicki, the virtual assistant at Instituto Vilas Boas in Loulé. How can I help?`
                  : `Olá! Sou a Vicki, a assistente virtual do Instituto Vilas Boas em Loulé. Em que posso ajudar?`;
              }

              isSpeaking = true;
              speakToCaller(greeting, () => { isSpeaking = false; currentAbort = null; });

            } catch (err) {
              console.error('[Startup] Error:', err.message);
              const remainingDelay = Math.max(0, INITIAL_RING_DELAY_MS - (Date.now() - startupStartedAt));
              if (remainingDelay) await new Promise(r => setTimeout(r, remainingDelay));
              isSpeaking = true;
              speakToCaller(
                "Olá! Sou a Vicki, a assistente virtual do Instituto Vilas Boas em Loulé. Em que posso ajudar?",
                () => { isSpeaking = false; currentAbort = null; }
              );
            }
          })();
          break;

        case 'media':
          if (msg.media?.payload) {
            const encoded = Buffer.from(msg.media.payload, 'base64');
            const linear = telnyxMediaEncoding === 'PCMA'
              ? pcmaToLinear16(encoded)
              : pcmuToLinear16(encoded);
            // NOTE: audio-level barge-in removed — phone echo triggers false positives.
            // Turn-taking is handled in handleSonioxMessage via BARGE_IN_MODE (see top of file):
            // word-count + backchannel filtering, with protected messages finishing uninterrupted.
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
    if (endpointGraceTimer) { clearTimeout(endpointGraceTimer); endpointGraceTimer = null; }
    try { if (sonioxWs) { sonioxWs.close(); sonioxWs = null; } } catch (_) {}
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
}

module.exports = { handleCallStream };
