// ============================================================
// VICKI VOICE GYM — G.711 A-law codec
//
// Vicki's inbound audio is A-law 8kHz, decoded by alawToLinear in
// src/callHandler.js. To guarantee the synthetic patient's audio is
// decoded identically, we build a decode table from the SAME algorithm
// and encode by nearest-neighbour. Perfect round-trip by construction.
// ============================================================

// Mirror of alawToLinear in src/callHandler.js (must stay identical).
function alawToLinear(b) {
  b ^= 0x55;
  const sign = b & 0x80, exp = (b & 0x70) >> 4, mant = b & 0x0F;
  let s = exp === 0 ? (mant << 4) + 8 : ((mant + 16) << (exp + 3)) - (16 << 4);
  return sign === 0 ? -s : s;
}

// Decode table: byte -> linear16 value
const DECODE = new Int16Array(256);
for (let b = 0; b < 256; b++) DECODE[b] = alawToLinear(b);

// Build a sorted index for fast nearest-neighbour encode.
const SORTED = Array.from({ length: 256 }, (_, b) => ({ b, v: DECODE[b] }))
  .sort((a, z) => a.v - z.v);
const SORTED_VALS = SORTED.map(e => e.v);

// Encode one linear16 sample -> A-law byte (nearest decoded value).
function linearToAlaw(sample) {
  if (sample > 32767) sample = 32767;
  else if (sample < -32768) sample = -32768;
  // binary search in SORTED_VALS
  let lo = 0, hi = SORTED_VALS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (SORTED_VALS[mid] < sample) lo = mid + 1; else hi = mid;
  }
  // lo is first >= sample; compare with lo-1 for nearest
  let best = lo;
  if (lo > 0 && Math.abs(SORTED_VALS[lo - 1] - sample) <= Math.abs(SORTED_VALS[lo] - sample)) {
    best = lo - 1;
  }
  return SORTED[best].b;
}

// linear16 buffer (LE) -> A-law buffer
function pcm16ToAlaw(buf) {
  const n = Math.floor(buf.length / 2);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = linearToAlaw(buf.readInt16LE(i * 2));
  return out;
}

// A-law buffer -> linear16 buffer (LE) — used to decode Vicki audio if ever needed
function alawToPcm16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(DECODE[buf[i]], i * 2);
  return out;
}

module.exports = { linearToAlaw, alawToLinear, pcm16ToAlaw, alawToPcm16, DECODE };
