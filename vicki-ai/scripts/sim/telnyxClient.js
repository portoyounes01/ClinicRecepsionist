// ============================================================
// VICKI VOICE GYM — Telnyx-emulating media client
//
// A WebSocket client that talks to Vicki's /media endpoint exactly like
// Telnyx does: connected -> start -> media frames -> mark echo -> stop.
// Models an always-on phone line: a 200ms frame pump streams the
// patient's speech when talking and silence when idle, so Vicki's
// Soniox STT + endpointing behave like a real call.
//
// Emits (EventEmitter):
//   'open'                         ws connected & start sent
//   'vickiText'  (text)            ground-truth of what Vicki said (dry-run side channel)
//   'vickiAudio' (pcm16, tMs)      Vicki's audio chunk (linear PCM 8kHz) for recording
//   'patientAudio' (pcm16, tMs)    the patient frame we sent (for recording)
//   'vickiTurnDone' (markName)     Vicki finished an utterance (after simulated playback + mark echo)
//   'clear'                        Vicki cleared/interrupted her audio (barge-in)
//   'close'
// ============================================================

const WebSocket = require('ws');
const EventEmitter = require('events');
const { pcm16ToAlaw } = require('./codec');

const FRAME_BYTES = 1600;          // A-law: 1600 samples = 200ms @ 8kHz
const FRAME_MS    = 200;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xD5); // 0xD5 = A-law silence (decodes ~0)

class TelnyxClient extends EventEmitter {
  constructor({ url, callerNumber, callSid, speedFactor = 1, startDelayMs = 800, simulatePlayback = true }) {
    super();
    this.url = url;
    this.callerNumber = callerNumber;
    this.callSid = callSid || `sim-${callerNumber}`;
    this.speedFactor = speedFactor;
    this.startDelayMs = startDelayMs;
    this.simulatePlayback = simulatePlayback; // false in live mode (human hears locally)
    this.ws = null;
    this.t0 = null;                 // wall-clock start (ms)
    this.frameQueue = [];           // pending patient speech frames (A-law)
    this.pump = null;
    this._drainResolve = null;
    this.vickiBytesSinceMark = 0;   // Vicki PCM bytes accumulated for current utterance
    this.closed = false;
  }

  now() { return Date.now() - this.t0; }

  start() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {
        this.t0 = Date.now();
        this.ws.send(JSON.stringify({ event: 'connected' }));
        // Delay 'start' so the server finishes per-call setup and registers its
        // WS message handler first (otherwise 'start' is dropped — ws doesn't buffer).
        setTimeout(() => {
          if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
          this.ws.send(JSON.stringify({
            event: 'start',
            streamSid: this.callSid,
            start: {
              call_control_id: this.callSid,
              from: this.callerNumber,
              customParameters: { callerNumber: this.callerNumber },
            },
          }));
          this._startPump();
          this.emit('open');
          resolve();
        }, this.startDelayMs);
      });
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('close', () => { this.closed = true; this._stopPump(); this.emit('close'); });
      this.ws.on('error', (e) => { if (!this.closed) reject(e); });
    });
  }

  _startPump() {
    if (this.pump) return;
    this.pump = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      let frame = this.frameQueue.shift();
      const isSpeech = !!frame;
      if (!frame) frame = SILENCE_FRAME;
      this.ws.send(JSON.stringify({ event: 'media', media: { payload: frame.toString('base64') } }));
      // record the patient channel (decode not needed; emit silence as zeros)
      if (isSpeech) {
        // emit the linear16 we originally enqueued alongside (stored on frame)
        this.emit('patientAudio', frame._pcm16 || Buffer.alloc(FRAME_BYTES * 2), this.now());
      } else {
        this.emit('patientAudio', Buffer.alloc(FRAME_BYTES * 2), this.now());
      }
      if (this.frameQueue.length === 0 && this._drainResolve) {
        const r = this._drainResolve; this._drainResolve = null; r();
      }
    }, Math.max(20, Math.round(FRAME_MS / this.speedFactor)));
  }

  _stopPump() { if (this.pump) { clearInterval(this.pump); this.pump = null; } }

  // Send the patient's spoken utterance (linear16 PCM 8kHz). Resolves when
  // the last speech frame has been streamed; then ~800ms of silence trails so
  // Vicki's endpointing fires (the idle pump provides it).
  sendUtterance(pcm16) {
    const alaw = pcm16ToAlaw(pcm16);
    for (let i = 0; i < alaw.length; i += FRAME_BYTES) {
      const slice = alaw.slice(i, i + FRAME_BYTES);
      const frame = slice.length === FRAME_BYTES ? slice : Buffer.concat([slice, SILENCE_FRAME.slice(slice.length)]);
      // attach the matching linear16 for recording
      frame._pcm16 = pcm16.slice(i * 2, i * 2 + FRAME_BYTES * 2);
      this.frameQueue.push(frame);
    }
    return new Promise((resolve) => { this._drainResolve = resolve; });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    switch (msg.event) {
      case 'media':
        if (msg.media?.payload) {
          const pcm = Buffer.from(msg.media.payload, 'base64'); // Vicki = linear PCM16 8kHz
          this.vickiBytesSinceMark += pcm.length;
          this.emit('vickiAudio', pcm, this.now());
        }
        break;
      case 'vicki_text':
        this.emit('vickiText', msg.text || '');
        break;
      case 'mark':
        this._handleMark(msg.mark?.name);
        break;
      case 'clear':
        this.vickiBytesSinceMark = 0;
        this.emit('clear');
        break;
    }
  }

  // Simulate playback of the audio received since the last mark, then echo the
  // mark back so Vicki's playbackDoneHandlers fires (like real Telnyx).
  _handleMark(name) {
    const bytes = this.vickiBytesSinceMark;
    this.vickiBytesSinceMark = 0;
    // In live mode the human hears Vicki via local playback, so we don't also
    // simulate phone-playback time here (that would add dead air + double timing).
    const playMs = Math.min(20000, Math.round((bytes / 16000) * 1000)); // PCM16 8kHz = 16000 B/s
    const wait = this.simulatePlayback ? Math.max(0, Math.round(playMs / this.speedFactor)) : 60;
    setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && name) {
        this.ws.send(JSON.stringify({ event: 'mark', mark: { name } }));
      }
      this.emit('vickiTurnDone', name);
    }, wait);
  }

  hangup() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: 'stop' }));
      }
    } catch (_) {}
    this._stopPump();
    try { this.ws?.close(); } catch (_) {}
  }
}

module.exports = { TelnyxClient };
