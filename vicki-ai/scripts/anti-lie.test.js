// ============================================================
// anti-lie.test.js — unit tests for the false-booking guard.
//
// Locks the call #54 regression: Vicki must NOT tell a caller "marcada/booked"
// unless a REAL Newsoft appointmentId (or verified confirm) backs it — and an
// `actionFired === 'book_appointment'` flag alone is NOT proof.
//
// Run: node scripts/anti-lie.test.js   (exits non-zero on any failure)
// ============================================================
process.env.VICKI_DRY_RUN = process.env.VICKI_DRY_RUN || '1';
// Dummy creds so modules that instantiate SDK clients at load don't throw — this
// test never makes a network call (it only exercises the pure guard function).
process.env.OPENAI_API_KEY     = process.env.OPENAI_API_KEY     || 'test-key';
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'test-key';

const { sanitizeFalseClaim } = require('../src/callHandler');

let pass = 0, fail = 0;
function check(name, actual, expect) {
  const ok = expect === 'suppressed' ? (actual != null) : (actual == null);
  if (ok) { pass++; }
  else { fail++; console.error(`✗ ${name}\n    got: ${JSON.stringify(actual)} — wanted: ${expect}`); }
}

const PT_BOOKED = 'A sua consulta está marcada para quinta-feira, dia 2 de julho, às catorze horas.';
const EN_BOOKED = 'Your appointment is booked for Thursday.';
const PT_CANCEL = 'A sua consulta foi cancelada.';

// 1. The exact #54 case: LLM says "marcada" on a turn with no action → suppress.
check('booked claim, no proof', sanitizeFalseClaim(PT_BOOKED, null, 'pt', undefined), 'suppressed');

// 2. KEY regression: actionFired='book_appointment' but NO real id → still suppress.
check('booked claim, attempted-but-no-id', sanitizeFalseClaim(PT_BOOKED, 'book_appointment', 'pt', { appointmentId: null }), 'suppressed');

// 3. Real Newsoft id present → allowed.
check('booked claim, real id', sanitizeFalseClaim(PT_BOOKED, 'book_appointment', 'pt', { appointmentId: 'SIM_1' }), 'allowed');

// 4. Verified booking (no actionFired this turn) → allowed.
check('booked claim, verified', sanitizeFalseClaim(PT_BOOKED, null, 'pt', { bookingVerified: true }), 'allowed');

// 5. English variant, no proof → suppress.
check('en booked claim, no proof', sanitizeFalseClaim(EN_BOOKED, null, 'en', undefined), 'suppressed');

// 6. Confirm claim backed by a real confirm action → allowed.
check('confirmed claim, confirm action', sanitizeFalseClaim('A sua consulta está confirmada.', 'confirm_appointment', 'pt', undefined), 'allowed');

// 7. Cancel claim with no cancel action → suppress.
check('cancel claim, no action', sanitizeFalseClaim(PT_CANCEL, null, 'pt', undefined), 'suppressed');

// 8. Cancel claim backed by a real cancel action → allowed.
check('cancel claim, cancel action', sanitizeFalseClaim(PT_CANCEL, 'cancel_appointment', 'pt', undefined), 'allowed');

// 9. Innocent line → never touched.
check('innocent line', sanitizeFalseClaim('Em que posso ajudar?', null, 'pt', undefined), 'allowed');

console.log(`\nanti-lie: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
