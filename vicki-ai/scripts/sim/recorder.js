// ============================================================
// VICKI VOICE GYM — Stereo recorder + best-effort live playback
//
// Collects patient (L) and Vicki (R) PCM16 8kHz chunks tagged with
// wall-clock offsets, then writes a time-aligned stereo WAV you can replay.
// Live: plays each utterance right after it's spoken via the OS player
// (best-effort, no native deps). Replay (the WAV) is the guarantee.
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SAMPLE_RATE = 8000;

class Recorder {
  constructor() {
    this.patient = []; // {tMs, pcm16}
    this.vicki = [];   // {tMs, pcm16}
  }

  addPatient(pcm16, tMs) { this.patient.push({ tMs, pcm16 }); }
  addVicki(pcm16, tMs)   { this.vicki.push({ tMs, pcm16 }); }

  _renderChannel(chunks, totalSamples) {
    const out = new Int16Array(totalSamples);
    for (const { tMs, pcm16 } of chunks) {
      const start = Math.round((tMs / 1000) * SAMPLE_RATE);
      const n = Math.floor(pcm16.length / 2);
      for (let i = 0; i < n; i++) {
        const idx = start + i;
        if (idx < 0 || idx >= totalSamples) continue;
        let v = out[idx] + pcm16.readInt16LE(i * 2);   // mix overlaps
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        out[idx] = v;
      }
    }
    return out;
  }

  _totalSamples() {
    const end = (chunks) => chunks.reduce((m, c) => {
      const e = Math.round((c.tMs / 1000) * SAMPLE_RATE) + Math.floor(c.pcm16.length / 2);
      return Math.max(m, e);
    }, 0);
    return Math.max(end(this.patient), end(this.vicki), 1);
  }

  writeWav(filePath) {
    const total = this._totalSamples();
    const L = this._renderChannel(this.patient, total);
    const R = this._renderChannel(this.vicki, total);

    const dataBytes = total * 2 /*channels*/ * 2 /*bytes*/;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);                 // PCM
    buf.writeUInt16LE(2, 22);                 // stereo
    buf.writeUInt32LE(SAMPLE_RATE, 24);
    buf.writeUInt32LE(SAMPLE_RATE * 2 * 2, 28); // byte rate
    buf.writeUInt16LE(4, 32);                 // block align
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataBytes, 40);
    let off = 44;
    for (let i = 0; i < total; i++) {
      buf.writeInt16LE(L[i], off); off += 2;
      buf.writeInt16LE(R[i], off); off += 2;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
    return filePath;
  }
}

// ── best-effort live playback of a mono PCM16 8kHz buffer ──────────────────
function monoPcmToWav(pcm16) {
  const dataBytes = pcm16.length;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  pcm16.copy(buf, 44);
  return buf;
}

let _liveSeq = 0;
// Plays a mono PCM16 buffer and resolves when playback finishes, so callers
// can await it to keep the live conversation sequential (no overlapping audio).
function playLive(pcm16) {
  return new Promise((resolve) => {
    try {
      if (!pcm16 || pcm16.length < 320) return resolve();
      const tmp = path.join(os.tmpdir(), `vicki_live_${process.pid}_${_liveSeq++}.wav`);
      fs.writeFileSync(tmp, monoPcmToWav(pcm16));
      let proc;
      if (process.platform === 'win32') {
        proc = spawn('powershell', ['-NoProfile', '-c', `(New-Object Media.SoundPlayer '${tmp}').PlaySync()`], { stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        proc = spawn('afplay', [tmp], { stdio: 'ignore' });
      } else {
        proc = spawn('aplay', [tmp], { stdio: 'ignore' });
      }
      proc.on('close', () => { try { fs.unlinkSync(tmp); } catch (_) {} resolve(); });
      proc.on('error', () => resolve()); // player missing → skip silently
    } catch (_) { resolve(); /* live is best-effort */ }
  });
}

module.exports = { Recorder, playLive };
