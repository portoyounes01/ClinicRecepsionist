// ============================================================
// VICKI AI — Main Server
// Handles Telnyx webhooks and WebSocket audio streams
// ============================================================

require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { handleCallStream } = require('./callHandler');

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

  // Start the stream + keep-alive loop via redirect
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${wsUrl}">
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
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="10"/>
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
  // Pre-load token + doctors + motives from cache
  await warmUp();

  // Start Telegram manager bot
  startBot();

  // Schedule nightly improvement agent (runs at 2am)
  scheduleNightly();
});
