# Vicki — Fix: Search Window Collapses When Patient Exhausts 28-Day Slot Horizon

## Context

**Production bug observed in call logs (June 6 2026).** A patient calling from `+351923124786` wanted orthodontics. After rejecting the first offer (June 12 with Dra. Carolina), Vicki searched for another time and found July 3. The patient rejected that too ("I'm not available that day"). Vicki searched for "another day" and got `IntervalDates: 2026-07-04;2026-07-04` — a single-day window — which returned 0 slots. Then when the patient accepted trying other doctors, Vicki cycled through Sílvia and Nadine but still searched `2026-07-04;2026-07-04` each time, finding nothing. Patient gave up.

**Root cause — two related bugs in `src/aiLogic.js` lines 861–911:**

1. **Window collapse:** `maxDate = today + 28 = June 6 + 28 = July 4`. When the patient rejected July 3, the "later" branch set `dateFrom = addDaysIso(lastOfferedDate, 1) = July 4`. `dateTo` was already `maxDate = July 4`. So `dateFrom == dateTo` — a 0-day window. All searches return 0 slots.

2. **Rotation doesn't rescue it:** The `rotateDoctors` branch (lines 901–903) is currently a no-op — it "keeps the current window." But by this point the window is already `July 4..July 4`. Even when rotation fires correctly (it does at the LLM level — Vicki correctly tries MedicId 33, then 13), every doctor searches the same collapsed 1-day window.

Additionally, `rotateDoctors` requires `_pendingSlots` to contain the previous doctor — but the July 4 search returned 0 slots, so `_pendingSlots` was cleared, making `lastOfferedDoc = null` and `rotateDoctors = false`. The rotation branch never even fires for Sílvia/Nadine; the `_lastOfferedDate` branch fires instead and re-collapses the window to `July 4`.

---

## Fix — two targeted changes in `src/aiLogic.js`

### Change 1 — Safety guard after all window branches (line ~911)

After the priority `if/else if` chain that sets `dateFrom`/`dateTo`, add a guard that prevents the window from ever collapsing to 0 days when the patient didn't ask for an exact date:

```javascript
// Safety: when repeated rejections advance dateFrom past dateTo (exhausted
// the 28-day horizon), extend the window another 4 weeks so the patient
// doesn't hit a dead end. Never applies to exact-date or urgent searches.
if (!pref?.exact && !isUrgent && dateFrom >= dateTo) {
  dateTo = addDaysIso(dateFrom, 28);
}
```

Insert this **after** line 911 (the end of the `else if (aiDateFrom)` branch) and **before** line 913 (`const periodPref`). This is the broadest fix — it catches both the same-doctor "another day" exhaustion and the rotation case where `_pendingSlots` was empty.

### Change 2 — Rotation branch should reset to today, not keep collapsed window (lines 901–903)

When `rotateDoctors` does fire (pending slots intact), change the no-op to actually reset `dateFrom` to today and extend `dateTo` to a 2-month horizon, so we find the new doctor's **earliest** slot, not just their slot inside the leftover window:

```javascript
} else if (rotateDoctors) {
  dateFrom = today;                    // find the new doctor's true earliest slot
  dateTo   = addDaysIso(today, 56);   // 2-month horizon for rotation
}
```

---

## File to change

- [vicki-ai/src/aiLogic.js](vicki-ai/src/aiLogic.js) — lines 901–903 (rotation branch) and after line 911 (new safety guard)

No other files need to change. The prompt, specialties map, and gym are unaffected.

---

## Verification

1. Reproduce in text gym: a scenario where patient rejects 4–5 times pushing past 28 days → confirm Vicki now offers slots instead of saying "I couldn't find openings."
2. Check rotation still works: cleaning → reject Hermes → "check another doctor" → Nadine offered (not same-day July 4 collapse).
3. Run `npm run test:textgym` — overall score must stay ≥ 79% (no regression), specialty 8/8, hallucinations 0.
4. Push to main (Railway auto-deploys). Test manually with a real call — patient rejects several times → Vicki should keep finding slots across doctors.
