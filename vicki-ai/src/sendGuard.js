// ============================================================
// VICKI AI — Lifecycle Send Guard (test safety gate)
//
// While LIFECYCLE_TEST_NUMBERS is set (comma-separated phone numbers),
// the lifecycle engine will ONLY send WhatsApp / confirm-calls / review
// SMS to those numbers. Every other recipient is skipped and logged.
// Leave LIFECYCLE_TEST_NUMBERS empty to go fully live.
//
// This protects real patients during testing. It does NOT touch the
// inbound booking-confirmation SMS (that is the live voice flow).
// ============================================================

function digits(p) { return String(p || '').replace(/\D/g, ''); }

function testNumbers() {
  return (process.env.LIFECYCLE_TEST_NUMBERS || '')
    .split(',').map(s => digits(s)).filter(Boolean);
}

/** True if we may send to this number (always true when no allow-list is set). */
function isAllowed(phone) {
  const list = testNumbers();
  if (!list.length) return true;               // no allow-list -> normal sends
  const d = digits(phone);
  if (!d) return false;
  // suffix match so +351XXXXXXXXX / 351XXXXXXXXX / local 9XXXXXXXX all compare equal
  return list.some(n => d.endsWith(n) || n.endsWith(d));
}

/** isAllowed + a PHI-safe log line when blocked. Returns the boolean. */
function guard(phone, label) {
  if (isAllowed(phone)) return true;
  const d = digits(phone);
  const masked = d ? `***${d.slice(-4)}` : '(none)';
  console.log(`[SendGuard] BLOCKED ${label || 'send'} to ${masked} — not in LIFECYCLE_TEST_NUMBERS`);
  return false;
}

module.exports = { isAllowed, guard, testNumbers };
