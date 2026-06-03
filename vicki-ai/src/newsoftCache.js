// ============================================================
// VICKI AI — Newsoft Persistent Cache
//
// Stores token, doctors and motives in data/newsoft_cache.json
// so the server survives restarts without re-authenticating or
// re-fetching static clinic data.
//
// TTLs:
//   token   — refreshed when within 5 minutes of Newsoft expiry
//   doctors — refreshed every 24 hours
//   motives — refreshed every 24 hours
//
// To force a full refresh: delete data/newsoft_cache.json
// ============================================================

const fs   = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_FILE  = path.join(__dirname, '..', 'data', 'newsoft_cache.json');
const DOCTOR_TTL  = 24 * 60 * 60 * 1000; // 24 hours in ms
const MOTIVE_TTL  = 24 * 60 * 60 * 1000;

const BASE_URL     = process.env.NEWSOFT_BASE_URL;
const CLINIC_NIF   = process.env.NEWSOFT_CLINIC_NIF;
const CLINIC_ID    = parseInt(process.env.NEWSOFT_CLINIC_ID);
const COST_CENTER_ID = parseInt(process.env.NEWSOFT_COST_CENTER_ID);

// ─── In-memory copy (read from file on first access) ────────
let _cache = null;

function _load() {
  if (_cache) return; // already loaded this session
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log('[Cache] Loaded from disk:', CACHE_FILE);
    } else {
      _cache = {};
      console.log('[Cache] No cache file found — will build on first use');
    }
  } catch (err) {
    console.error('[Cache] Failed to read cache file:', err.message);
    _cache = {};
  }
}

function _save() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[Cache] Failed to write cache file:', err.message);
  }
}

function _authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function _clinicParams() {
  return { ClinicNif: CLINIC_NIF, ClinicId: CLINIC_ID, CostCenterId: COST_CENTER_ID };
}

// ─────────────────────────────────────────────
// TOKEN — persisted, refreshed near expiry
// ─────────────────────────────────────────────
async function getToken() {
  _load();
  const now = Math.floor(Date.now() / 1000);
  if (_cache.token && _cache.tokenExpiresAt && _cache.tokenExpiresAt > now + 300) {
    return _cache.token; // still valid for >5 minutes
  }

  console.log('[Cache] Token missing or near expiry — refreshing from Newsoft...');
  const res = await axios.post(`${BASE_URL}/Authentication`, {
    username: process.env.NEWSOFT_USERNAME,
    password: process.env.NEWSOFT_PASSWORD,
  });

  _cache.token          = res.data.token;
  _cache.tokenExpiresAt = res.data.expiresAt; // Unix timestamp in seconds
  _save();
  console.log('[Cache] Token refreshed. Expires:', new Date(_cache.tokenExpiresAt * 1000).toISOString());
  return _cache.token;
}

// ─────────────────────────────────────────────
// DOCTORS — cached 24h, filtered to real doctors
// ─────────────────────────────────────────────
async function getDoctors() {
  _load();
  const now = Date.now();
  const age = now - (_cache.doctorsCachedAt || 0);

  if (_cache.doctors && age < DOCTOR_TTL) {
    return _cache.doctors; // still fresh
  }

  console.log('[Cache] Doctors stale or missing — fetching from Newsoft...');
  const token = await getToken();
  const res   = await axios.get(`${BASE_URL}/medics`, {
    headers: _authHeader(token),
    params:  _clinicParams(),
  });

  const all = res.data || [];
  const doctors = all.filter(m => {
    const name = (m.medicName || '').toLowerCase();
    return !name.includes('atendimento') && !name.includes('agenda');
  });

  _cache.doctors        = doctors;
  _cache.doctorsCachedAt = now;
  _save();
  console.log(`[Cache] Doctors updated: ${doctors.length} doctors saved`);
  return doctors;
}

// ─────────────────────────────────────────────
// MOTIVES — cached 24h
// ─────────────────────────────────────────────
async function getMotives() {
  _load();
  const now = Date.now();
  const age = now - (_cache.motivesCachedAt || 0);

  if (_cache.motives && age < MOTIVE_TTL) {
    return _cache.motives; // still fresh
  }

  console.log('[Cache] Motives stale or missing — fetching from Newsoft...');
  const token = await getToken();
  const res   = await axios.get(`${BASE_URL}/clinics/motives`, {
    headers: _authHeader(token),
    params:  _clinicParams(),
  });

  const motives = (res.data || []).filter(m => m.allowAppointment);
  _cache.motives        = motives;
  _cache.motivesCachedAt = now;
  _save();
  console.log(`[Cache] Motives updated: ${motives.length} motives saved`);
  return motives;
}

// ─────────────────────────────────────────────
// WARM UP — call at server start to pre-load
// everything before the first call comes in
// ─────────────────────────────────────────────
async function warmUp() {
  console.log('[Cache] Warming up...');
  try {
    await Promise.all([getDoctors(), getMotives()]);
    console.log('[Cache] ✅ Warm-up complete — ready to receive calls');
  } catch (err) {
    console.error('[Cache] Warm-up failed:', err.message);
  }
}

module.exports = { getToken, getDoctors, getMotives, warmUp };
