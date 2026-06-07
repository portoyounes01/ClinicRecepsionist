# Plan: Fix Vicki — Script, Intent Routing, Cleaning Doctor, Audio Cutting

## Context
Valter (native pt-PT, the clinic owner) tested Vicki and reported 4 problems. Logs confirm each with a concrete root cause. Goal: make Vicki speak his exact reviewed pt-PT wording, route booking correctly, prioritise the right cleaning doctors, and stop the "Sorry I didn't catch that" audio-cutting loop.

Decisions from the user:
- **Replace ALL spoken PT strings** to match his reviewed file verbatim (not just accent fixes).
- **Keep canned phrases hardcoded** (no LLM rewording) so they're spoken exactly.
- **Cleaning priority:** Dra. Nadine → Dra. Beatriz Café → Hermes/others (backup only).

---

## Issue 1 — Replace spoken script with Valter's reviewed wording
**Where:** hardcoded PT strings in [src/aiLogic.js](vicki-ai/src/aiLogic.js) and [src/callHandler.js](vicki-ai/src/callHandler.js). Full line map is known (from exploration).

Apply his reviewed text category-by-category. Key changes:
- **Greetings** — `callHandler.js:1226` remove "**hoje**": `...que bom ouvir a sua voz. Em que posso ajudar?` (he deleted "hoje").
- **Services/FAQ** — `aiLogic.js:1558` → his new text: `As nossas consultas de medicina dentária incluem implantes, coroas, facetas, ortodontia, alinhadores invisíveis, branqueamento dentário, endodontia, cirurgia oral, odontopediatria e higiene oral. Também realizamos consultas de estética facial, osteopatia e podologia.`
- **Slot offers** (`aiLogic.js:764-788`), **booking confirm** (`859`), **cancellations** (`873-898`), **transfers** (`72-74, 841, 891, 1600, 2109`), **no-slots** (`719-743`), **info hours/contact/english** (`1525,1549,1567`), **fillers** (`callHandler.js:808` → `Só mais um momento... / Já está quase... / Quase pronto...`), **reprompts** (`callHandler.js:737`), **router acks** (`1646,1657,1665,1675`), **farewell** (`1627`) — all set to his reviewed strings (see his file §1–§15).
- **Accent fixes** he flagged: `telemóvel, português, inglês, dentária, invisíveis, Também, estética, já`.
- **Silence-timeout goodbye** already has a PT version at `callHandler.js:568` (`Parece que ficámos sem ligação...`) — keep/align to his tone.
- **Clitics** `o/a`, `-lo/a` → his reworded gender-neutral phrasings (already partly done; finish remaining).

---

## Issue 2 — "implants" booking gets stuck on the services list  ⭐ root cause
**Where:** [aiLogic.js:1554](vicki-ai/src/aiLogic.js#L1554) — `clinicInfoAnswer()` runs BEFORE the router and its `asksServices` regex matches the word `implantes`/`implants`. So "Quero marcar implantes com a Dra. Carla" is answered with the generic services FAQ, every turn → infinite loop.

**Fix:** add a **booking-intent guard** so `clinicInfoAnswer` returns null when the utterance shows intent to book. Before the `asksServices` check (and ideally at the top of `clinicInfoAnswer`), detect booking verbs and bail out:
```js
const wantsToBook = /\b(marcar|agendar|marca[cç][aã]o|quero|queria|gostaria|preciso|vir|consulta com|com a? d(ra|r|outor)|book|schedule|appointment|i want|i'd like)\b/.test(text);
if (wantsToBook) return null; // let the router send this to BOOKING
```
This lets the existing booking path (specialty inference `implants → doctors [1,11]`, doctor "Carla" → medicId 1) run as designed. Pure services questions ("o que fazem?", "do you do implants?") still hit the FAQ because they lack booking verbs.

## Issue 3 — `intent="undefined"` in logs (cosmetic, but fix)
**Where:** specialist agents (booking/info/appointments/emergency) don't return an `intent` field, so the log at [aiLogic.js:2224](vicki-ai/src/aiLogic.js) prints `undefined`. **Fix:** default it in the log line — `intent || currentAgent` (or `'(specialist)'`) so logs are readable. No behavioural change.

---

## Issue 4 — Cleanings always booked with Dr. Hermes  ⭐ root cause
**Where:** [aiLogic.js:1193-1226](vicki-ai/src/aiLogic.js#L1193) — the 4 doctor-pick passes iterate `Object.values(byDoc)`. With numeric medicId keys `{11,13,36}`, JS reorders them numerically → **11 (Hermes) is visited first**, beating Nadine (13)/Beatriz (36).

**Fix:** iterate in **specialty priority order** (`specialtyDocs`, which is `[13, 36, 11]` for cleaning) instead of `Object.values`. For each of the 4 passes:
```js
const orderedDocs = (specialtyDocs && specialtyDocs.length)
  ? specialtyDocs.map(id => byDoc[id]).filter(Boolean)
  : Object.values(byDoc);
for (const doc of orderedDocs) { ... }
```
This makes Nadine→Beatriz→Hermes the pick order for cleanings, and is a no-op when no specialty filter applies. Confirm `specialtyDocs` is in scope at this block (set at the `[Specialty] pool filter` step ~line 1077).

---

## Issue 5 — "Sorry I didn't catch that" loop + audio cutting  ⭐ root cause
Three coupled problems in [src/callHandler.js](vicki-ai/src/callHandler.js):

1. **Unhandled throw** — `runTurn(candidate)` at line 768 is called without `.catch()`. If `processTurn` throws, the turn dies silently (now only logged by the global net). **Fix:** `runTurn(candidate).catch(e => { console.error('[Turn] failed:', e.stack); ... })` and inside, ensure a single safe error reprompt.

2. **Concurrent speak() = audio cut** — reprompt (line 737), patience filler (line ~816), and error reprompt (line ~1145) can all call `speakToCaller` overlapping. **Fix:** guard the patience filler so it does NOT fire if `!processingTurn` or if a reprompt already started this turn (check a `repromptedThisTurn`/`speakStarted` flag), and make the error handler not speak if something is already speaking.

3. **"What?/Sorry?" feedback loop** — short low-confidence phrases at line 733 trigger the reprompt; the caller's reaction re-triggers it. **Fix:** add a small cooldown — don't fire the low-confidence reprompt twice in a row within N ms / consecutive turns; after 2 consecutive misses, either stay silent or escalate, instead of looping.

---

## Files to modify
- [vicki-ai/src/aiLogic.js](vicki-ai/src/aiLogic.js) — script strings (Issue 1), booking guard (Issue 2), intent log (Issue 3), doctor pick order (Issue 4)
- [vicki-ai/src/callHandler.js](vicki-ai/src/callHandler.js) — greeting/filler/reprompt strings (Issue 1), runTurn catch + filler/reprompt serialization + cooldown (Issue 5)
- Reference data (read-only, no change): [vicki-ai/src/data/specialties.js](vicki-ai/src/data/specialties.js)

## Verification
1. `node --check` both edited files; load aiLogic with a dummy env to confirm no syntax error.
2. **Unit-style checks (no phone needed):**
   - `clinicInfoAnswer("quero marcar implantes com a Dra Carla")` → returns `null` (routes to booking); `clinicInfoAnswer("o que fazem?")` → returns services text.
   - Doctor-pick: feed a cleaning slot set containing Hermes(11)+Nadine(13) both-period → assert chosen doctor is Nadine(13).
3. **Live call test** (Valter): place a real call —
   - Greeting has **no "hoje"**.
   - "Quero marcar uma limpeza" → offered with **Nadine or Beatriz**, not Hermes.
   - "Quero implantes com a Dra. Carla" → goes to **booking**, not the services list.
   - Mumble a short word → at most **one** "Desculpe, não percebi bem", no overlap/cut, no loop.
4. Pull `railway logs` after the call; confirm no `[FATAL]`/`[Turn] failed`, readable `intent=`, and `[Specialty]` pick favors 13/36.
5. Commit + push per change (Railway auto-deploys).

---

# Robustness layers (added — Valter is stress-testing, so harden routing)

These sit ON TOP of the 5 fixes. The 5 fixes remove the known bugs; these two layers reduce future drift/looping when a tester pushes hard.

## Layer A — Per-call conversation memory / intent state
**Why:** logs show `intent="undefined"` every turn — intent is never tracked, so Vicki can "forget" what the call is about and loop. `processTurn` already threads rich per-call state ([aiLogic.js:1764](vicki-ai/src/aiLogic.js#L1764): pendingSlots, pendingAppts, bookingReasonText, returnToAgent, returnContext…). Extend that, don't rebuild.

**What:** add a `callState` object carried through `processTurn` ↔ `callHandler` (same pattern as existing params) holding:
```
{ intent, specialty, specialtyId, chosenDoctorId, stage, reasonText, lastSlotsOffered, confirmationPending }
```
- Set it deterministically when known (specialty from `inferSpecialtyFromText`, doctor from the existing doctor-match, stage from action taken).
- Inject a 1-line grounded summary of `callState` into the LLM context each turn ("CONTEXTO DA CHAMADA: quer marcar; especialidade=implantes; médico=Doutora Carla; falta=confirmação") so the model never loses the thread.
- Persisted in [callHandler.js](vicki-ai/src/callHandler.js) call scope (like `pendingSlots`), echoed back from `processTurn` results.

## Layer B — Deterministic booking-resolver tool (grounding, anti-hallucination)
**Why:** routing from regex (`asksServices`) is what broke implants. Replace guesswork with a grounded resolver so the AI gets facts, not vibes.

**What:** a server-side function (and exposed as a tool the booking agent can call) `resolveBooking(text, cachedDoctors)` that reuses existing utilities:
- `inferSpecialtyFromText` → specialtyId ([specialties.js:160](vicki-ai/src/data/specialties.js#L160))
- `doctorsForSpecialty` → ranked medicIds in **priority order** ([specialties.js:175](vicki-ai/src/data/specialties.js#L175))
- the existing doctor-name matcher → explicit doctor if named
- returns `{ specialtyId, label, rankedDoctorIds, namedDoctorId, needsReason }`
This is the single source of truth for "what is being booked + who can do it", consumed by both the booking flow and `callState`. No new data, no RAG — pure functions over existing structured data → cannot hallucinate.

## Per-specialty tools — explicitly NOT doing (documented decision)
**Question raised:** should each specialty get its own tool (e.g. `check_implants`, `check_cleaning`) holding its doctors + availability, and should every new question get its own tool?

**Decision: NO — keep one parameterized tool, specialty as a parameter.** Confirmed against the code:
- The system uses a **JSON-action pattern**, not OpenAI function-calling tools — agents return `{action, params}` ([aiLogic.js:911 executeAction](vicki-ai/src/aiLogic.js#L911); agent schemas in `src/agents/*.js`). "Adding a tool" = new action case + teaching every agent prompt + tests.
- **`check_slots` already takes specialty as a parameter**: it infers `specialtyId` from the caller's words, looks up that specialty's doctors from [specialties.js](vicki-ai/src/data/specialties.js), filters availability to them, and ranks by priority ([aiLogic.js:924-960, 1072-1089](vicki-ai/src/aiLogic.js#L1072)). This already IS the "right doctors + availability per specialty" behaviour.
- Adding a specialty today = **one line of data** in `SPECIALTIES`. Per-specialty tools would turn that into code+prompt+test edits in N places.
- ~9 near-identical tools would **lower** tool-calling accuracy (more wrong-tool picks) — the opposite of what's wanted while the agent is being stress-tested.

**Rule:** a separate tool/path is justified ONLY when the *workflow* differs, not when only the doctor list differs. The one real exception — **aesthetic medicine** (books at the Quarteira clinic, different flow) — is already branched separately ([aiLogic.js:937](vicki-ai/src/aiLogic.js#L937)).

**This is exactly Layer B (booking-resolver):** make specialty→doctor resolution explicit/grounded over the existing data, not 9 tools. No new architecture needed.

## RAG — explicitly NOT doing (documented decision)
Clinic data (doctors, specialties, slots, hours) is **small and structured** — tools/lookups answer it exactly. RAG (vector search) is for large unstructured text (policy PDFs, big FAQ). Adding it here would *increase* hallucination risk (retrieving a wrong chunk) for data a tool returns precisely. Revisit only if a large document-based knowledge base is added later. (User confirmed: no big text KB.)

---

## Sequencing (recommended)
1. **Phase 1 — the 5 fixes** (script, implants guard, intent log, cleaning order, loop/cutting). Ship + Valter tests. These alone resolve every reported bug.
2. **Phase 2 — Layer A (call memory)** then **Layer B (resolver tool)**. Ship after Phase 1 is verified so we can attribute improvements.

## Notes / not doing
- Not switching the LLM provider (stays gpt-5.4-mini) — out of scope; canned phrases are hardcoded so wording is exact regardless.
- Not lowering temperature (user chose hardcoding over temperature change).
- Not adding RAG (structured data; would add risk — see above).
