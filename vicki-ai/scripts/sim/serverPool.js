// ============================================================
// VICKI VOICE GYM — Dry-run server pool
//
// Spawns K local Vicki servers in VICKI_DRY_RUN mode (no real bookings).
// Each server handles one call at a time (its fixture is swapped per call),
// so K servers = K concurrent calls. acquire()/release() hand out free
// servers; the gym dispatches the work-list across them.
// ============================================================

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: 'localhost', port, path: '/health', timeout: 1500 }, (res) => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

class ServerPool {
  constructor({ size = 10, basePort = 3100, quiet = true } = {}) {
    this.size = size;
    this.basePort = basePort;
    this.quiet = quiet;
    this.servers = [];       // { port, baseUrl, wsUrl, child, busy }
    this._waiters = [];
  }

  async start() {
    const serverPath = path.join(__dirname, '../../src/server.js');
    for (let i = 0; i < this.size; i++) {
      const port = this.basePort + i;
      const child = spawn(process.execPath, [serverPath], {
        // VICKI_FAKE_NOW: weekday mid-morning so clinic-open behaviour is tested
        // deterministically (overridable; dry-run only).
        env: { VICKI_FAKE_NOW: '2026-06-08T10:00:00', ...process.env, VICKI_DRY_RUN: '1', PORT: String(port) },
        stdio: this.quiet ? 'ignore' : 'inherit',
      });
      this.servers.push({ port, baseUrl: `http://localhost:${port}`, wsUrl: `ws://localhost:${port}`, child, busy: false });
    }
    // wait for all healthy (up to ~30s)
    const deadline = Date.now() + 30000;
    for (const s of this.servers) {
      let ok = false;
      while (Date.now() < deadline) { if (await health(s.port)) { ok = true; break; } await sleep(400); }
      if (!ok) { await this.stop(); throw new Error(`Pool server on port ${s.port} failed to start`); }
    }
    return this;
  }

  acquire() {
    const free = this.servers.find(s => !s.busy);
    if (free) { free.busy = true; return Promise.resolve(free); }
    return new Promise(resolve => this._waiters.push(resolve));
  }

  release(server) {
    const waiter = this._waiters.shift();
    if (waiter) { waiter(server); return; }   // hand directly to next waiter (stays busy)
    server.busy = false;
  }

  // Run an async task with a server, auto-releasing.
  async withServer(fn) {
    const s = await this.acquire();
    try { return await fn(s); }
    finally { this.release(s); }
  }

  async stop() {
    for (const s of this.servers) { try { s.child.kill(); } catch (_) {} }
    this.servers = [];
  }
}

module.exports = { ServerPool };
