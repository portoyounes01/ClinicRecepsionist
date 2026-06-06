// ============================================================
// VICKI VOICE GYM — Per-call timeline / latency metrics
//
// The orchestrator marks turn boundaries; this computes the "how she
// listens and reacts" numbers Claude reads: response latency (time from
// the patient finishing to Vicki's first audio), dead-air, barge-ins,
// and turns-to-resolve.
// ============================================================

class Timeline {
  constructor() {
    this.events = [];   // {t, type, meta}
    this.turns = [];    // {patientEndMs, vickiFirstAudioMs, vickiDoneMs, latencyMs}
    this._pendingTurn = null;
  }

  mark(type, meta = {}) {
    this.events.push({ t: Date.now(), type, meta });
  }

  patientSpoke(tMs)  { this._pendingTurn = { patientEndMs: tMs }; this.mark('patient_end', { tMs }); }
  vickiFirstAudio(tMs) {
    if (this._pendingTurn && this._pendingTurn.vickiFirstAudioMs == null) {
      this._pendingTurn.vickiFirstAudioMs = tMs;
      this._pendingTurn.latencyMs = tMs - this._pendingTurn.patientEndMs;
    }
    this.mark('vicki_first_audio', { tMs });
  }
  vickiDone(tMs) {
    if (this._pendingTurn) {
      this._pendingTurn.vickiDoneMs = tMs;
      this.turns.push(this._pendingTurn);
      this._pendingTurn = null;
    }
    this.mark('vicki_done', { tMs });
  }
  bargeIn() { this.mark('barge_in'); }

  summary() {
    const lats = this.turns.map(t => t.latencyMs).filter(n => Number.isFinite(n) && n >= 0);
    const sorted = [...lats].sort((a, b) => a - b);
    const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
    return {
      turns: this.turns.length,
      latencyMs: {
        p50: pct(0.5),
        p95: pct(0.95),
        max: sorted.length ? sorted[sorted.length - 1] : null,
        avg: lats.length ? Math.round(lats.reduce((s, n) => s + n, 0) / lats.length) : null,
      },
      bargeIns: this.events.filter(e => e.type === 'barge_in').length,
    };
  }
}

module.exports = { Timeline };
