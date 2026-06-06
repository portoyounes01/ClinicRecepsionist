// ============================================================
// VICKI VOICE GYM — Single voice conversation orchestrator
//
// Drives ONE scenario against a LOCAL dry-run Vicki server over the media
// WebSocket. The synthetic patient (persona) speaks via TTS; Vicki replies
// through her real STT->brain->TTS pipeline. Captures transcript, stereo
// recording, latency timeline, and backend side-effects.
//
// Calls run sequentially: the fixture is set on the server (HTTP) before
// each call, so the global dry-run provider is correct for this call.
// ============================================================

const http = require('http');
const { TelnyxClient } = require('./telnyxClient');
const { Recorder, playLive } = require('./recorder');
const { Timeline } = require('./timeline');
const persona = require('./persona');

function postJson(baseUrl, path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b ? JSON.parse(b) : {})); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function getJson(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b ? JSON.parse(b) : {}));
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Short 880Hz "ding" (mono PCM16 8kHz) played at call start in live mode.
function beepTone(ms = 350, freq = 880) {
  const n = Math.round((ms / 1000) * 8000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400) * Math.min(1, (n - i) / 400); // fade in/out
    buf.writeInt16LE(Math.round(8000 * env * Math.sin(2 * Math.PI * freq * i / 8000)), i * 2);
  }
  return buf;
}

// Wait for Vicki to finish her turn: collect vicki_text until a quiet window
// passes with no new text and the last utterance's playback is done.
function collectVickiTurn(client, { settleMs = 900, maxWaitMs = 30000 }) {
  return new Promise((resolve) => {
    const parts = [];
    let settleTimer = null;
    let lastDone = false;
    const finish = () => {
      cleanup();
      resolve(parts.join(' ').trim());
    };
    const arm = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (lastDone) finish(); }, settleMs);
    };
    const onText = (t) => { if (t) parts.push(t); lastDone = false; };
    const onDone = () => { lastDone = true; arm(); };
    const onClose = () => finish();
    function cleanup() {
      client.off('vickiText', onText); client.off('vickiTurnDone', onDone); client.off('close', onClose);
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    }
    const hardTimer = setTimeout(finish, maxWaitMs);
    client.on('vickiText', onText);
    client.on('vickiTurnDone', onDone);
    client.on('close', onClose);
  });
}

async function runConversation(scenario, opts = {}) {
  const baseUrl = opts.baseUrl || `http://localhost:${process.env.PORT || 3000}`;
  const wsUrl = (opts.wsUrl || baseUrl.replace(/^http/, 'ws')) + '/media';
  const live = !!opts.live;
  const maxTurns = opts.maxTurns || 12;

  // 1) set the fixture for this call
  await postJson(baseUrl, '/gym/fixture', scenario.fixture || {});

  // 2) connect as Telnyx
  const client = new TelnyxClient({
    url: wsUrl,
    callerNumber: scenario.callerNumber,
    speedFactor: opts.speedFactor || 1,
    simulatePlayback: !live, // live: human hears locally, skip phone-playback sim
  });
  const recorder = new Recorder();
  const timeline = new Timeline();
  const transcript = [];
  const vickiChunks = [];     // Vicki PCM16 for the voice judge
  const printLine = (role, text) => {
    const tag = role === 'patient' ? '\x1b[36mPatient\x1b[0m' : '\x1b[35mVicki\x1b[0m';
    console.log(`   ${tag}: ${text}`);
  };
  // Record the turn in the transcript. In text-only live (printTranscript) we
  // print here; in audio-live mode we print right before the audio plays so the
  // line you read matches the voice you hear (and turns never overlap).
  const say = (role, text) => {
    transcript.push({ role, text });
    if (opts.printTranscript && !live) printLine(role, text);
  };

  client.on('patientAudio', (pcm, t) => recorder.addPatient(pcm, t));
  client.on('vickiAudio', (pcm, t) => { recorder.addVicki(pcm, t); vickiChunks.push(pcm); timeline.vickiFirstAudio(t); });

  await client.start();

  // Audible call-start cue so you know a new call is beginning (live only).
  if (live) {
    console.log(`\n\x1b[1m📞 CALL START — ${scenario.id} (${scenario.persona.language})\x1b[0m`);
    await playLive(beepTone());
  }

  // 3) Vicki greets first (triggered by 'start'). Audio streamed in during
  //    collectVickiTurn is in vickiChunks; in live mode we print + play it now.
  let vickiSay = await collectVickiTurn(client, {});
  if (vickiSay) {
    say('vicki', vickiSay);
    timeline.vickiDone(client.now());
    if (live) { printLine('vicki', vickiSay); await playLive(Buffer.concat(vickiChunks)); }
  }

  // 4) alternate turns — strictly sequential in live mode so audio never overlaps
  for (let turn = 0; turn < maxTurns; turn++) {
    const { text: patientText, done } = await persona.nextPatientUtterance(scenario.persona, transcript);
    if (patientText) {
      say('patient', patientText);
      const pcm = await persona.synthesize(patientText, scenario.persona.language); // synth FIRST
      vickiChunks.length = 0; // reset Vicki buffer for this response
      if (live) printLine('patient', patientText);             // print exactly as audio starts
      const localPlay = live ? playLive(pcm) : null;           // hear it locally
      await client.sendUtterance(pcm);                         // stream to Vicki (~realtime)
      if (localPlay) await localPlay;                          // finish before Vicki replies
      timeline.patientSpoke(client.now());
    }
    if (done) break;

    vickiSay = await collectVickiTurn(client, {});
    if (vickiSay) {
      say('vicki', vickiSay);
      timeline.vickiDone(client.now());
      if (live) { printLine('vicki', vickiSay); await playLive(Buffer.concat(vickiChunks)); }
    } else {
      break; // Vicki went silent / hung up
    }
    if (client.closed) break;
  }

  // 5) collect side-effects + finalize
  let sideEffects = {};
  try { sideEffects = await getJson(baseUrl, '/gym/sideEffects'); } catch (_) {}
  client.hangup();
  await sleep(150);

  const vickiPcm16 = Buffer.concat(recorder.vicki.map(c => c.pcm16));

  return { scenario, transcript, sideEffects, timeline: timeline.summary(), recorder, vickiPcm16 };
}

module.exports = { runConversation };
