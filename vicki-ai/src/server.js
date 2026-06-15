// ============================================================
// VICKI AI — Main Server
// Handles Telnyx webhooks and WebSocket audio streams
// ============================================================

require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { handleCallStream } = require('./callHandler');

// ─────────────────────────────────────────────
// Crash safety net — one unhandled rejection/exception in a single call
// must NOT take down the whole server and drop every other live call.
// We log it loudly and keep serving. (A previous 2nd-call cancel crash
// killed the container because nothing caught the async error.)
// ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection (kept alive):',
    reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (kept alive):', err && err.stack ? err.stack : err);
});

// Shared sets — checked on every keep-alive ping
const hangupCalls   = new Set(); // callSid → respond with <Hangup/>
const transferCalls = new Map(); // callSid → phone number to dial

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// Silence WAV generator — keeps Telnyx call alive
// ─────────────────────────────────────────────
function buildSilenceWav(seconds = 5) {
  const sampleRate = 8000;
  const numSamples = sampleRate * seconds;
  const buf = Buffer.alloc(44 + numSamples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);         // 8-bit
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples, 40);
  buf.fill(0x80, 44);               // 0x80 = silence in 8-bit PCM
  return buf;
}
const SILENCE_WAV = buildSilenceWav(5);

// ─────────────────────────────────────────────
// Ring tone WAV — 1s 440Hz tone + 2s silence (one ring cycle = 3s)
// Served at /ring.wav and played twice before answering
// ─────────────────────────────────────────────
function buildRingWav() {
  const sampleRate  = 8000;
  const toneSamples = sampleRate * 1;   // 1s ring
  const gapSamples  = sampleRate * 2;   // 2s silence
  const numSamples  = toneSamples + gapSamples; // 3s total = 1 ring cycle
  const buf = Buffer.alloc(44 + numSamples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);            // 8-bit
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples, 40);
  // 440Hz sine wave for the tone portion (8-bit unsigned, centre 0x80)
  for (let i = 0; i < toneSamples; i++) {
    buf[44 + i] = Math.round(0x80 + 60 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
  }
  // Silence for the gap portion
  buf.fill(0x80, 44 + toneSamples, 44 + numSamples);
  return buf;
}
const RING_WAV = buildRingWav();

// ─────────────────────────────────────────────
// Half-ring WAV — just the 1s tone, no gap
// Played once as ring 3 so Vicki "picks up" mid-ring
// ─────────────────────────────────────────────
function buildHalfRingWav() {
  const sampleRate  = 8000;
  const numSamples  = sampleRate * 1; // 1s tone only
  const buf = Buffer.alloc(44 + numSamples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples, 40);
  for (let i = 0; i < numSamples; i++) {
    buf[44 + i] = Math.round(0x80 + 60 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
  }
  return buf;
}
const HALF_RING_WAV = buildHalfRingWav();

// ─────────────────────────────────────────────
// TELNYX WEBHOOK — Called when a call comes in
// ─────────────────────────────────────────────
app.post('/telnyx/inbound', (req, res) => {
  const callSid = req.body.CallSid || 'unknown';
  const from    = req.body.From    || 'unknown';
  const to      = req.body.To      || 'unknown';
  const status  = req.body.CallStatus || 'unknown';

  console.log(`[Telnyx] Inbound call | From: ${from} | To: ${to} | Status: ${status} | SID: ${callSid}`);
  console.log(`[Telnyx] Inbound raw body:`, JSON.stringify(req.body));

  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `wss://${host}/media`;
  const baseUrl = `https://${host}`;

  console.log(`[Telnyx] Streaming audio to: ${wsUrl}`);

  // Ring 1+2 full (6s), ring 3 tone-only (1s) → stream starts mid-ring like a human pickup
  // NOTE: do NOT use the inline <Record> TeXML verb here. It is blocking/terminal
  // — it takes over the call and waits for the recording to end, so execution never
  // reaches <Start><Stream> and Vicki goes silent. Recording is started instead via
  // the non-blocking Call Control API (record_start) once the media stream connects
  // — see startTelnyxRecording() in callHandler.js. Disable with CALL_RECORDING=off.

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="2">${baseUrl}/ring.wav</Play>
  <Play loop="1">${baseUrl}/half-ring.wav</Play>
  <Start>
    <Stream url="${wsUrl}" codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000">
      <Parameter name="callerNumber" value="${from}" />
    </Stream>
  </Start>
  <Pause length="12"/>
  <Redirect method="POST">${baseUrl}/telnyx/keep-alive</Redirect>
</Response>`);

});

// ─────────────────────────────────────────────
// KEEP-ALIVE — Called every 55s to hold the line
// ─────────────────────────────────────────────
app.post('/telnyx/keep-alive', (req, res) => {
  // Telnyx may send the call identifier under different names depending on API version
  const callSid = req.body.CallSid
               || req.body.call_control_id
               || req.body.callSid
               || req.body.CallControlId
               || null;
  const host    = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `https://${host}`;

  // Transfer — bridge the call to a human agent
  if (callSid && transferCalls.has(callSid)) {
    const dialNumber = transferCalls.get(callSid).replace(/\s+/g, '');
    transferCalls.delete(callSid);
    console.log(`[Telnyx] Keep-alive → TRANSFER ${callSid} to ${dialNumber}`);
    return res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${dialNumber}</Dial></Response>`
    );
  }

  // Hangup — AI signalled end of call
  if (callSid && hangupCalls.has(callSid)) {
    hangupCalls.delete(callSid);
    console.log(`[Telnyx] Keep-alive → HANGUP ${callSid}`);
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  console.log(`[Telnyx] Keep-alive → Extend session | SID: ${callSid || 'unknown'}`);
  console.log(`[Telnyx] Keep-alive raw body:`, JSON.stringify(req.body));
  // Short pause so a flagged hangup (hangupCalls) is honored within ~5s even if
  // the Call Control API hangup doesn't apply to this TeXML call.
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="5"/>
  <Redirect method="POST">${baseUrl}/telnyx/keep-alive</Redirect>
</Response>`);

});


// ─────────────────────────────────────────────
// INSTANT HANGUP — called by callHandler as soon
// as Vicki finishes her goodbye. Returns <Hangup/>
// immediately without waiting for keep-alive cycle.
// ─────────────────────────────────────────────
app.post('/telnyx/hangup-now', (req, res) => {
  const callSid = req.body.CallSid || req.body.call_control_id || req.body.callSid || 'unknown';
  console.log(`[Telnyx] Instant hangup | SID: ${callSid}`);
  hangupCalls.delete(callSid);
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
});

// ─────────────────────────────────────────────
// SILENCE WAV — Served as audio filler if needed
// ─────────────────────────────────────────────
app.get('/silence.wav', (req, res) => {
  res.set('Content-Type', 'audio/wav');
  res.send(SILENCE_WAV);
});

// ─────────────────────────────────────────────
// RING WAV — One ring cycle (1s tone + 2s gap)
// Played loop="2" in <Play> before answering = 2 rings (6s)
// ─────────────────────────────────────────────
app.get('/ring.wav', (req, res) => {
  res.set('Content-Type', 'audio/wav');
  res.send(RING_WAV);
});

// ─────────────────────────────────────────────
// HALF-RING WAV — 1s tone only, no gap
// Plays as ring 3 so Vicki answers mid-ring
// ─────────────────────────────────────────────
app.get('/half-ring.wav', (req, res) => {
  res.set('Content-Type', 'audio/wav');
  res.send(HALF_RING_WAV);
});

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Vicki AI', version: '1.0.0' });
});

// ─────────────────────────────────────────────
// ADMIN — Read + Clean patient memory
// GET /admin/memory?key=ADMIN_KEY          → view
// DELETE /admin/memory?key=ADMIN_KEY&id=752 → wipe one patient
// DELETE /admin/memory?key=ADMIN_KEY&all=1  → wipe all
// ─────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const MEMORY_FILE = path.join('/app/data', 'patient_memory.json');
const LOG_FILE    = path.join('/app/data', 'call_log.jsonl');

function loadMem() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveMem(data) {
  fs.mkdirSync('/app/data', { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

app.get('/admin/memory', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'vicki2025')) return res.status(403).json({ error: 'Forbidden' });
  const mem = loadMem();
  let log = [];
  try { log = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-20).map(l => JSON.parse(l)); } catch (_) {}
  res.json({ memory: mem, recentCalls: log });
});

app.delete('/admin/memory', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'vicki2025')) return res.status(403).json({ error: 'Forbidden' });
  const mem = loadMem();
  if (req.query.all === '1') {
    saveMem({});
    return res.json({ wiped: 'ALL', previous: mem });
  }
  if (req.query.id) {
    const id = String(req.query.id);
    const previous = mem[id];
    delete mem[id];
    saveMem(mem);
    return res.json({ wiped: id, previous });
  }
  res.status(400).json({ error: 'Provide ?id=PATIENT_ID or ?all=1' });
});

// PATCH /admin/memory?key=ADMIN_KEY&id=PATIENT_ID — merge fields into a patient record
app.patch('/admin/memory', (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'vicki2025')) return res.status(403).json({ error: 'Forbidden' });
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Provide ?id=PATIENT_ID' });
  const mem = loadMem();
  if (!mem[id]) return res.status(404).json({ error: `Patient ${id} not found` });
  Object.assign(mem[id], req.body);
  saveMem(mem);
  res.json({ updated: id, record: mem[id] });
});

// ─────────────────────────────────────────────
// CALL RECORDING WEBHOOK — Telnyx posts here when a recording is ready
// ─────────────────────────────────────────────
// Telnyx <Record> recordingStatusCallback payload (TeXML, Twilio-compatible):
//   RecordingUrl, RecordingSid, RecordingStatus, CallSid, RecordingDuration
// We match CallSid → call_logs.telnyx_call_sid, store the URL, and send the
// recording link to Telegram as a follow-up to the per-call summary message.
app.post('/telnyx/recording', async (req, res) => {
  res.sendStatus(200); // ack immediately — never make Telnyx wait or retry
  try {
    const b = req.body || {};
    const callSid      = b.CallSid || b.call_control_id || b.call_sid || null;
    const recordingUrl = b.RecordingUrl || b.recording_url ||
                         (b.public_recording_urls && (b.public_recording_urls.mp3 || b.public_recording_urls.wav)) || null;
    const status       = b.RecordingStatus || b.status || 'completed';
    console.log(`[Telnyx] Recording webhook | CallSid: ${callSid} | status: ${status} | url: ${recordingUrl ? 'yes' : 'no'}`);
    if (!callSid || !recordingUrl) return;

    const { attachRecordingUrl } = require('./patientMemory');
    const row = await attachRecordingUrl(callSid, recordingUrl);

    const telegram = require('./telegramBot');
    const base = process.env.PUBLIC_BASE_URL || '';
    const key  = process.env.ADMIN_KEY || 'vicki2025';
    const transcriptLink = (row?.id && base)
      ? `${base.replace(/\/$/, '')}/calls/${row.id}?key=${encodeURIComponent(key)}`
      : null;
    const msg = [
      `🎧 *Gravação pronta* — ${row?.patient_name || 'Desconhecido'} (${row?.caller_number || '?'})`,
      `▶️ [Ouvir gravação](${recordingUrl})`,
      transcriptLink ? `📄 [Ver transcrição](${transcriptLink})` : null,
    ].filter(Boolean).join('\n');
    telegram.notify(msg, { disable_web_page_preview: true }).catch(() => {});
  } catch (e) {
    console.error('[Telnyx] Recording webhook error:', e.message);
  }
});

// ─────────────────────────────────────────────
// CALL TRANSCRIPT VIEW — GET /calls/:id?key=ADMIN_KEY
// ─────────────────────────────────────────────
// Read-only HTML page rendering one call: outcome, summary, recording player,
// and the full transcript. Gated by the shared ADMIN_KEY in the query string.
app.get('/calls/:id', async (req, res) => {
  if (req.query.key !== (process.env.ADMIN_KEY || 'vicki2025')) return res.status(403).send('Forbidden');
  const db = require('./db');
  if (!db.isEnabled()) return res.status(503).send('Database disabled');
  let row;
  try {
    row = await db.one(`SELECT * FROM call_logs WHERE id=$1`, [req.params.id]);
  } catch (e) { return res.status(500).send('DB error: ' + e.message); }
  if (!row) return res.status(404).send('Call not found');

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const transcript = Array.isArray(row.transcript) ? row.transcript : [];
  const turns = transcript
    .filter(m => m && m.content && (m.role === 'user' || m.role === 'assistant'))
    .map(m => {
      const who   = m.role === 'user' ? 'Paciente' : 'Vicki';
      const cls   = m.role === 'user' ? 'user' : 'vicki';
      return `<div class="turn ${cls}"><span class="who">${who}</span><div class="bubble">${esc(m.content)}</div></div>`;
    }).join('\n');

  const recording = row.recording_url
    ? `<audio controls preload="none" src="${esc(row.recording_url)}" style="width:100%;margin:12px 0"></audio>
       <p><a href="${esc(row.recording_url)}">Descarregar gravação</a></p>`
    : `<p style="color:#888">Gravação ainda não disponível (ou desativada).</p>`;

  res.type('html').send(`<!doctype html><html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chamada ${esc(row.id)} — ${esc(row.patient_name)}</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:20px;color:#1a1a1a;background:#fafafa}
  h1{font-size:20px;margin:0 0 4px} .meta{color:#555;font-size:14px;margin-bottom:8px}
  .card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:16px;margin-bottom:16px}
  .turn{margin:10px 0;display:flex;flex-direction:column}
  .turn.user{align-items:flex-start}.turn.vicki{align-items:flex-end}
  .who{font-size:11px;color:#888;margin-bottom:2px}
  .bubble{padding:9px 13px;border-radius:14px;max-width:80%;white-space:pre-wrap;line-height:1.4}
  .user .bubble{background:#eef1f4}.vicki .bubble{background:#1366ff;color:#fff}
  .tag{display:inline-block;background:#eef1f4;border-radius:6px;padding:2px 8px;font-size:13px;margin-right:6px}
</style></head><body>
  <h1>${esc(row.patient_name)} — ${esc(row.caller_number)}</h1>
  <div class="meta">${esc(row.created_at)} · ${esc(row.duration_seconds || 0)}s · ${esc(row.language || '?')}</div>
  <div class="card">
    <span class="tag">Resultado: ${esc(row.outcome || '?')}</span>
    <span class="tag">Intenção: ${esc(row.intent || '?')}</span>
    ${row.action_fired ? `<span class="tag">Ação: ${esc(row.action_fired)}</span>` : ''}
    ${row.transferred_to_human ? `<span class="tag">→ Humano</span>` : ''}
    ${row.summary ? `<p>${esc(row.summary)}</p>` : ''}
    ${recording}
  </div>
  <div class="card">
    <h1 style="font-size:16px">Transcrição</h1>
    ${turns || '<p style="color:#888">Sem turnos de conversa.</p>'}
  </div>
</body></html>`);
});



// ─────────────────────────────────────────────
// HTTP SERVER + WEBSOCKET SERVER
// ─────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (ws, req) => {
  console.log('[WebSocket] New media stream connection established');

  // Ping every 20s to keep WebSocket alive through ngrok
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 20000);

  ws.on('close', () => clearInterval(pingInterval));
  ws.on('pong', () => {}); // acknowledge pong

  handleCallStream(ws, req, hangupCalls, transferCalls);
});

const { warmUp }         = require('./newsoftCache');
const { start: startBot } = require('./telegramBot');
const { scheduleNightly } = require('./improvementAgent');

server.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════╗
║      VICKI AI — Server Running        ║
║  Port: ${PORT}                            ║
║  Endpoint: POST /telnyx/inbound       ║
║  Keep-alive: POST /telnyx/keep-alive  ║
║  WebSocket: wss://YOUR-URL/media      ║
╚═══════════════════════════════════════╝
  `);
  // ── VOICE GYM (dry-run) mode ──────────────────────────────────────────────
  // No real Newsoft/SMS/Telegram. Fixtures are swapped per call by the gym
  // harness via the control endpoints below (calls run sequentially).
  if (process.env.VICKI_DRY_RUN) {
    console.log('[Gym] VICKI_DRY_RUN active — Newsoft/SMS mocked, Telegram/nightly disabled');
    const newsoft = require('./newsoftApi');
    const { makeProvider } = require('../scripts/sim/newsoftFixtures');
    const { validateSpecialties } = require('./data/specialties');

    let _gymProvider = makeProvider({});
    const PROVIDER_METHODS = ['getPatientByPhone', 'getPatientByIdentity', 'getDoctors',
      'getMotives', 'getAvailableSlots', 'getPatientAppointments', 'createOrUpdatePatient',
      'bookAppointment', 'cancelAppointment'];
    const wrapper = {};
    for (const m of PROVIDER_METHODS) wrapper[m] = (...a) => _gymProvider[m](...a);
    newsoft.__setDryRunProvider(wrapper);

    try { validateSpecialties(await wrapper.getDoctors()); } catch (e) { console.warn('[Specialties] skipped:', e.message); }

    // Pre-warm the doctor cache used for Soniox context so the per-call setup
    // is fast and the WS message handler registers before the gym's 'start'.
    try { await require('./newsoftCache').getDoctors(); console.log('[Gym] Soniox doctor cache warmed'); }
    catch (e) { console.warn('[Gym] cache warm skipped:', e.message); }

    app.post('/gym/fixture', (req, res) => {
      _gymProvider = makeProvider(req.body || {});
      console.log(`[Gym] fixture set: slotMode=${req.body?.slotMode} patient=${req.body?.patient?.patientName || 'new'}`);
      res.json({ ok: true });
    });
    app.get('/gym/sideEffects', (req, res) => res.json(_gymProvider.__sideEffects || {}));
    return; // skip warmUp / Telegram / nightly entirely
  }

  // Pre-load token + doctors + motives from cache
  await warmUp();

  // Validate specialty map against the live doctor roster (anti-hallucination).
  try {
    const { getDoctors } = require('./newsoftCache');
    const { validateSpecialties } = require('./data/specialties');
    const doctors = await getDoctors();
    validateSpecialties(doctors);
  } catch (e) {
    console.warn('[Specialties] validation skipped:', e.message);
  }

  // Start Telegram manager bot
  startBot();

  // Schedule nightly improvement agent (runs at 2am)
  scheduleNightly();

  // Boot the ADDITIVE patient-lifecycle engine (reminders / confirms /
  // reviews / recare). Self-disables if DATABASE_URL is unset — the
  // inbound voice flow above is completely unaffected either way.
  try {
    const { bootLifecycle } = require('./lifecycle/boot');
    await bootLifecycle(app);
  } catch (e) {
    console.error('[Lifecycle] Boot failed (inbound flow unaffected):', e.message);
  }
});
