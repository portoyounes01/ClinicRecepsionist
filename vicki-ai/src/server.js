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
  const callSid = req.body.CallSid;
  const host    = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `https://${host}`;

  // Transfer — bridge the call to a human agent
  if (callSid && transferCalls.has(callSid)) {
    const dialNumber = transferCalls.get(callSid).replace(/\s+/g, '');
    transferCalls.delete(callSid);
    console.log(`[Telnyx] Transferring call ${callSid} to ${dialNumber}`);
    return res.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${dialNumber}</Dial></Response>`
    );
  }

  // Hangup — AI signalled end of call
  if (callSid && hangupCalls.has(callSid)) {
    hangupCalls.delete(callSid);
    console.log(`[Telnyx] Hanging up call ${callSid}`);
    return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  console.log('[Telnyx] Keep-alive ping — extending call');
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="12"/>
  <Redirect method="POST">${baseUrl}/telnyx/keep-alive</Redirect>
</Response>`);

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

  handleCallStream(ws, req, hangupCalls);
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
