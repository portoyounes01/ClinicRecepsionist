// ============================================================
// VICKI AI — Doctor Specialties (Loulé)
// ============================================================
// Maps dental specialties to the REAL Newsoft medicIds of the
// doctors who perform them. Built from a reconciliation against
// the live Newsoft cache on 2026-06-05 and confirmed by the user.
//
// ANTI-HALLUCINATION (per CLAUDE.md):
//   - Keyed by medicId, NEVER by name. Names drift; medicIds don't.
//   - Only Loulé-bookable doctors (LOULE_DOCTOR_IDS) appear here.
//   - Doctors in the user's spec list that do NOT exist in Newsoft
//     (Dr. Carlos Mestre, Dra. Sara Norte) are intentionally EXCLUDED.
//   - Dra. Catarina Espada (34) exists in Newsoft but is NOT in the
//     Loulé bookable set, so she is excluded too.
//   - "Dr. Hermes Cardona" in the spec = "Dr. Hermes" (medicId 11),
//     confirmed by the user.
//
// TODO: verify this map whenever the Newsoft roster changes.
//       validateSpecialties() runs at startup and logs any medicId
//       here that is missing from the live cache.
// ============================================================

// Specialty definitions. `doctors` holds medicIds (numbers only).
const SPECIALTIES = [
  {
    id: 'cleaning_whitening',
    pt: 'Limpeza / Branqueamento',
    en: 'Dental Cleaning / Teeth Whitening',
    doctors: [13, 36, 11], // Nadine, Beatriz Café, Hermes
  },
  {
    id: 'implants',
    pt: 'Implantes',
    en: 'Dental Implants',
    doctors: [1, 11], // Carla Vilas Boas, Hermes
  },
  {
    id: 'endodontics',
    pt: 'Endodontia',
    en: 'Endodontics / Root Canal Treatment',
    doctors: [11], // Hermes
  },
  {
    id: 'orthodontics_aligners',
    pt: 'Ortodontia / Alinhadores',
    en: 'Orthodontics / Dental Aligners',
    doctors: [3, 33, 13], // Carolina Alcântara, Silvia, Nadine
  },
  {
    id: 'restorations',
    pt: 'Restaurações',
    en: 'Dental Restorations / Tooth Cavities',
    doctors: [11], // Hermes
  },
  {
    id: 'prosthesis',
    pt: 'Próteses dentárias',
    en: 'Dental Prosthesis',
    doctors: [11], // Hermes
  },
  {
    id: 'extractions',
    pt: 'Exodontia',
    en: 'Dental Extraction',
    doctors: [1, 11], // Carla Vilas Boas, Hermes
  },
  {
    id: 'crowns_veneers',
    pt: 'Coroas / Facetas',
    en: 'Dental Crowns / Dental Veneers',
    doctors: [1], // Carla Vilas Boas
  },
];

// Keyword → specialtyId. Deterministic, server-side resolution only.
// The LLM may SUGGEST a specialty; this map VALIDATES it. We never
// invent a specialty that isn't in SPECIALTIES.
// Keywords are matched against accent-stripped, lowercased text.
const SPECIALTY_KEYWORDS = {
  cleaning_whitening: [
    // pt
    'limpeza', 'branqueamento', 'destartarizacao', 'higiene oral', 'higiene',
    // en
    'cleaning', 'whitening', 'whiten', 'scale and polish', 'hygiene',
  ],
  implants: [
    // pt
    'implante', 'implantes',
    // en
    'implant', 'implants',
  ],
  endodontics: [
    // pt
    'endodontia', 'desvitalizacao', 'tratamento de canal', 'canal', 'nervo',
    // en
    'endodontic', 'root canal', 'root-canal',
  ],
  orthodontics_aligners: [
    // pt
    'ortodontia', 'alinhador', 'alinhadores', 'aparelho', 'aparelhos', 'invisalign',
    // en
    'orthodontic', 'aligner', 'aligners', 'braces', 'invisalign',
  ],
  restorations: [
    // pt
    'restauracao', 'restauracoes', 'carie', 'caries', 'chumbo', 'obturacao',
    // en
    'restoration', 'restorations', 'cavity', 'cavities', 'filling', 'fillings',
  ],
  prosthesis: [
    // pt
    'protese', 'proteses', 'dentadura', 'dentaduras',
    // en
    'prosthesis', 'prosthetic', 'denture', 'dentures',
  ],
  extractions: [
    // pt
    'exodontia', 'extracao', 'extracoes', 'arrancar', 'tirar o dente', 'tirar dente',
    // en
    'extraction', 'extractions', 'pull a tooth', 'pull tooth', 'remove a tooth', 'remove tooth',
  ],
  crowns_veneers: [
    // pt
    'coroa', 'coroas', 'faceta', 'facetas',
    // en
    'crown', 'crowns', 'veneer', 'veneers',
  ],
};

// Strip accents + lowercase for robust matching.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const _byId = new Map(SPECIALTIES.map(s => [s.id, s]));

function getSpecialty(id) {
  return _byId.get(id) || null;
}

// Resolve a patient's free text to a specialtyId (or null). Deterministic.
// Returns the FIRST specialty whose keyword appears in the text.
function inferSpecialtyFromText(text) {
  const t = normalize(text);
  if (!t) return null;
  for (const spec of SPECIALTIES) {
    const kws = SPECIALTY_KEYWORDS[spec.id] || [];
    for (const kw of kws) {
      if (t.includes(normalize(kw))) return spec.id;
    }
  }
  return null;
}

// medicIds that can perform a given specialty, intersected with the
// supplied set of currently-bookable medicIds (e.g. LOULE_DOCTOR_IDS).
// Returns [] if the specialty is unknown or no bookable doctor matches.
function doctorsForSpecialty(specialtyId, bookableIds) {
  const spec = _byId.get(specialtyId);
  if (!spec) return [];
  const allow = bookableIds
    ? (bookableIds instanceof Set ? bookableIds : new Set(bookableIds))
    : null;
  return spec.doctors.filter(id => !allow || allow.has(id));
}

// Startup guard: warn loudly if any medicId in the map is missing from
// the live cache (doctor removed/renamed in Newsoft). Never throws —
// we don't want to crash the server, but we MUST surface drift.
function validateSpecialties(cachedDoctors = []) {
  const liveIds = new Set((cachedDoctors || []).map(d => d.medicId));
  const missing = [];
  for (const spec of SPECIALTIES) {
    for (const id of spec.doctors) {
      if (!liveIds.has(id)) missing.push({ specialty: spec.id, medicId: id });
    }
  }
  if (missing.length) {
    console.warn(
      `[Specialties] ⚠️ ${missing.length} medicId(s) in the specialty map are NOT in the live Newsoft cache:`,
      JSON.stringify(missing)
    );
  } else {
    console.log(`[Specialties] ✅ All ${SPECIALTIES.length} specialties map to live medicIds.`);
  }
  return missing;
}

// Build a human/LLM-facing description of specialties + their doctors,
// in the caller's language, using ONLY bookable doctors that exist in
// the live cache. Used to inject grounded data into the booking prompt.
// Expand "Dra."/"Dr." abbreviations to full words so the TTS speaks "Doutora"
// / "Doutor" instead of spelling out the letters "D-R-A".
function expandTitle(name = '') {
  return String(name || '')
    .replace(/\bDr\.?\s*ª\b/gi, 'Doutora')
    .replace(/\bDr\.?\s*a\.?\b/gi, 'Doutora')
    .replace(/\bDra\.?\b/gi, 'Doutora')
    .replace(/\bDr\.?\b/gi, 'Doutor')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSpecialtyPromptBlock(cachedDoctors = [], bookableIds, lang = 'pt') {
  const en = lang === 'en';
  const nameById = new Map((cachedDoctors || []).map(d => [d.medicId, expandTitle(d.medicShortName || d.medicName)]));
  const allow = bookableIds
    ? (bookableIds instanceof Set ? bookableIds : new Set(bookableIds))
    : null;
  const lines = [];
  for (const spec of SPECIALTIES) {
    const docs = spec.doctors
      .filter(id => (!allow || allow.has(id)) && nameById.has(id))
      .map(id => `${nameById.get(id)} (medicId:${id})`);
    if (!docs.length) continue; // never list a specialty with no real doctor
    const label = en ? spec.en : spec.pt;
    lines.push(`- ${label}: ${docs.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = {
  SPECIALTIES,
  SPECIALTY_KEYWORDS,
  getSpecialty,
  inferSpecialtyFromText,
  doctorsForSpecialty,
  validateSpecialties,
  buildSpecialtyPromptBlock,
  normalize,
};
