// ============================================================
// VICKI AI — Language resolver for lifecycle messages
//
// Newsoft has no language field, so we decide PT vs EN like this:
//   1. If we already KNOW the language (e.g. detected on a voice call
//      and stored on the patient row) -> use it.
//   2. Otherwise infer from the phone's country code:
//        +351 / local PT number  -> 'pt'
//        any other country code   -> 'en'  (Algarve has many expats)
//   3. Unknown/empty -> 'pt' (clinic default).
//
// Decided at SEND time so a known language always wins and nothing
// needs migrating. Returns 'en' or 'pt'.
// ============================================================

function digits(p) { return String(p || '').replace(/\D/g, ''); }

function pickLang(knownLang, phone) {
  if (knownLang === 'en' || knownLang === 'pt') return knownLang;

  let d = digits(phone);
  if (d.startsWith('00')) d = d.slice(2);          // 00351... -> 351...
  if (!d) return 'pt';

  if (d.startsWith('351')) return 'pt';            // Portugal country code
  if (d.length === 9 && (d[0] === '9' || d[0] === '2')) return 'pt'; // local PT mobile/landline

  return 'en';                                     // foreign country code -> English
}

/** WhatsApp template language code ('pt_PT' | 'en'). */
function waLang(knownLang, phone) {
  return pickLang(knownLang, phone) === 'en' ? 'en' : 'pt_PT';
}

module.exports = { pickLang, waLang };
