# Front-Desk Self-Learning — Lesson Candidates (review-gated)

**Date:** 2026-08-03 · **Evidence:** 84 simulated trial calls (12 personas × baseline + 2 prompt variants, n=36 per variant for the head-to-head) · **Harness:** `/opt/realtor-agent/trials/run-trials.mjs` · **Raw runs:** `/opt/realtor-agent/trials/history/`

Per the learning-promotion rule, these are **proposals only**. Nothing is applied to production until Ray approves. Each candidate has far more than the required two consistent examples.

---

## L-001 — Capture as soon as identity is confirmed (RECOMMENDED)

**Finding:** With the production prompt ("capture near the end of the call"), only **4/30** legitimate trial calls produced a CRM capture. Callers consistently hang up immediately after the recap — the "end of the call" never announces itself, so the lead is lost.

**Evidence (n=36 per variant):**

| Metric | baseline (production) | capture-early |
|---|---|---|
| Overall pass | 6/36 (17%) | **11/36 (31%)** |
| Legit lead captured | 4/30 (13%) | **7/30 (23%)** |
| Spam/declined-call overcapture | 4/6 (67%) | **2/6 (33%)** |

**Proposed prompt change** (one paragraph in the CRM HANDOFF TOOL section of `src/voice/front-desk.ts`):

> ~~For every legitimate non-spam call, use capture_front_desk_lead exactly once near the end of the call after confirming the caller's name and best callback number.~~
>
> For every legitimate non-spam call, call capture_front_desk_lead exactly once AS SOON AS you have confirmed the caller's name and best callback number — even mid-conversation. Do not wait for the end of the call: callers hang up without warning, and an uncaptured lead is a lost lead. After the tool confirms success, recap briefly and close warmly.

**Status:** awaiting Ray's approval. After approval: edit `front-desk.ts`, run `node trials/run-trials.mjs --variant baseline --repeat 3` to confirm, then run `scripts/vapi/sync-front-desk-agent.vapi.mjs` to push to Vapi.

---

## L-002 — Never announce the save before the tool call (needs more evidence)

**Finding:** In multiple transcripts Ali says "Let me get this to Ray right now" and the caller hangs up on that sentence; the promised tool call never happens. The `capture-then-speak` variant testing this fix regressed overall (4/12) and **overcaptured spam 1/6→1**, so the wording is not yet right. Next experiment: combine capture-early with "call first, speak after" phrased as a sequencing rule rather than a prohibition.

## L-003 — Spam / declined-contact overcapture (needs more evidence)

**Finding:** The baseline captured leads in 4/6 spam or explicitly-declined trials (SEO spammer captured 3/3 times; one info-only caller captured after saying "no thanks"). Both variants reduced but did not eliminate this. Next experiment: add an explicit line — "Never capture callers classified as spam, and never capture a caller who declined to share their name or number."

## Harness notes

- Caller-side model (`claude-haiku`) occasionally emits empty turns; the harness retries once, then treats it as a hangup (`caller_hangup_silence` flag).
- Interleaved concurrent logs are unreliable for per-trial mapping; always read `trials/history/run-*.json` / `latest-report.md`.
- Rough cost: a 36-trial batch runs ~5 minutes at concurrency 4 using prompt caching; assistant model is the production `claude-sonnet-5`.
