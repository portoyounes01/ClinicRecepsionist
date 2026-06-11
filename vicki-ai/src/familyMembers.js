// ============================================================
// VICKI AI — Family Members registry
//
// A caller can book for a family member (son/daughter/spouse). Newsoft supports
// MULTIPLE patient files on one phone, BUT its phone lookup returns only the
// PRIMARY patient — it will not give the family members back. So we remember
// them ourselves, keyed by the CALLER's Newsoft patientId:
//
//   { "752": [ { firstName, fullName, patientId, relation, createdAt } ] }
//
// First time: we create a real Newsoft file for the family member and store the
// returned patientId here. Next time the caller says "book for <firstName>", we
// reuse that id and book under the family member's own chart.
//
// ANTI-HALLUCINATION: we only ever store a name the CALLER explicitly said (and
// Vicki read back for confirmation). We never infer/guess a family member.
//
// File: /app/data/family_members.json  (Railway volume — survives deploys)
// ============================================================

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const FILE     = path.join(DATA_DIR, 'family_members.json');

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadAll() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) { console.error('[Family] Read error:', e.message); }
  return {};
}

function saveAll(data) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[Family] Write error:', e.message); }
}

function normFirst(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)[0] || '';
}

/** All remembered family members for this caller (empty array if none). */
function getFamilyMembers(callerPatientId) {
  if (!callerPatientId) return [];
  return loadAll()[String(callerPatientId)] || [];
}

/**
 * Find a remembered family member by a spoken first name (fuzzy on first token).
 * Returns the stored { firstName, fullName, patientId, relation } or null.
 */
function findFamilyMember(callerPatientId, spokenName) {
  const want = normFirst(spokenName);
  if (!want) return null;
  return getFamilyMembers(callerPatientId)
    .find(m => normFirst(m.firstName) === want || normFirst(m.fullName) === want) || null;
}

/**
 * Remember a family member under the caller. Idempotent on (caller, firstName):
 * updates the existing entry instead of duplicating.
 */
function rememberFamilyMember(callerPatientId, { firstName, fullName, patientId, relation, birthDate }) {
  if (!callerPatientId || !patientId) return;
  const all  = loadAll();
  const key  = String(callerPatientId);
  const list = all[key] || [];
  const want = normFirst(firstName || fullName);
  const idx  = list.findIndex(m => normFirst(m.firstName) === want);
  const entry = {
    firstName: firstName || (fullName || '').split(/\s+/)[0],
    fullName:  fullName || firstName,
    patientId,
    relation:  relation || null,
    birthDate: birthDate || (idx >= 0 ? list[idx].birthDate : null) || null,
    createdAt: new Date().toISOString(),
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  all[key] = list;
  saveAll(all);
  console.log(`[Family] Remembered "${entry.fullName}" (id:${patientId}) under caller ${callerPatientId}`);
}

module.exports = { getFamilyMembers, findFamilyMember, rememberFamilyMember };
