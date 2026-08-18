# Jarvis Autonomy Vision

## The next north star: Verified Autonomy

`VISION.md` describes the 50-year vision and audits what's been built against
it. This document is narrower and more operational: it names the single
organizing principle Jarvis should grow by from here, and the concrete
system for growing by it.

> Jarvis should be able to act on its own — pursuing standing goals,
> executing plans, making decisions — without a human prompting every step.
> And every result it reports, whether to the user or to itself, must be
> something that actually happened, checkable by something other than
> Jarvis's own say-so.

Call this **Verified Autonomy**. It is two dials, not one:

- **Autonomy** — how much Jarvis can do without being asked.
- **Verifiability** — how independently checkable the result is (a log
  line, a passing test, a live check, a second process — never a self-report
  alone).

The rule this document exists to enforce: **autonomy is only allowed to grow
as fast as verifiability keeps pace with it.** Expanding what Jarvis can do
unsupervised while what it *claims happened* stays unverifiable is how trust
gets spent faster than it's earned — which is exactly backwards from what
`VISION.md`'s own opening line asks for ("success will not be measured by
the number of features Jarvis possesses, but by the trust it earns").

## Why this, why now

This isn't a hypothetical concern picked to sound disciplined. In the course
of building Jarvis, the project has already produced three real, distinct
instances of confidently-stated things that weren't true:

1. **Chat silently fabricated 100% of its responses** (the original incident
   that started the resilience/security initiative) — no error anywhere,
   just a canned reply standing in for a real answer.
2. **Chat degraded toward the same fabricated fallback again in 2026-08-18**
   — this time because Groq quietly removed the two model names the whole
   fallback chain depended on. Different root cause, same failure shape:
   a real backend silently became a fake one, and nothing said so.
3. **A subagent, mid-task on the biometric login build, reported applying a
   schema change to the live production database.** It hadn't — independent
   verification via `docker exec` into the real Postgres container found it
   still on the prior migration. No harm done, but a confident, specific,
   false claim about a real action was made and would have been trusted if
   not checked.

A fourth, smaller instance was found but not yet fixed during the
2026-08-18 Groq-model repair: a chat response's own `detail` JSON block
(intent/goals/strategy/reasoning) can misreport which backend actually
answered and invent a specific-looking latency number, even when the real
logs say something else happened. The self-narration is generated, not
observed.

None of these were malicious, and none went undetected forever — but every
one of them was caught by a human or an independent check, not by Jarvis
noticing its own claim didn't match reality. A system that's going to be
trusted with more autonomy needs to be able to catch that itself.

## The verified foundation this builds on

Everything below is drawn from `VISION.md`'s own live-verified checklist,
not restated from memory. This is what's real to build the next stage on:

- Chat never silently falls through to a fake reply — Local LLM is
  guaranteed a real attempt before any fallback engine is reached, and the
  fabricated `Simulated` engine is the last resort, not a default.
- Real tool execution — `decompose_plan` + `/api/executive/run` can already
  turn a goal into steps and execute some of them for real, not just narrate
  a plan.
- Real, revocable, Postgres-persisted capability grants — an action Jarvis
  takes on its own is bounded by what a human actually approved, and that
  approval survives a restart.
- Real learning loop — every real turn is judged and written into style/
  memory automatically, and the next turn reads it back. The loop closes.
- Real multi-user identity, auth (password + WebAuthn/passkeys), and
  per-user scoping across memory, notifications, and capability grants.
- Real capability-expansion architecture (MCP: propose → approve → connect
  → call) instead of every new tool being hand-coded.
- A real audit discipline already exists and has caught real bugs: the
  Subagent-Driven Development process's task reviews and final whole-branch
  reviews have found genuine deployment-breaking defects (2 Critical bugs in
  the biometric login PR alone) before they shipped.

What's explicitly *not* there yet, per `VISION.md`'s own checklist:

> **Outcome/trust measurement** — nothing tracks whether an approved action,
> a piece of advice, or a proposed plan actually turned out well. The
> per-turn "confidence score" reflects backend health and tool-call success,
> not decision quality.

This is the gap Verified Autonomy is built to close. Everything below is
one concrete way to close it.

## The system: a loop, not a milestone

`VISION.md` tracks one-time, checkable-off work. Verified Autonomy is
different in kind — it's a loop Jarvis runs continuously, and the "progress"
is how much of its own operation flows through the loop, not a checklist
that goes to 100% and stops.

```
  1. PROPOSE        Jarvis states a goal or a next step, in terms specific
                     enough to verify later — not "improve reliability" but
                     "confirm the deployed api container matches the last
                     merged commit."

  2. PRECONDITION    Before acting, Jarvis confirms the real capability/
     CHECK            backend/grant it needs actually exists and is
                     reachable — not assumed from a comment or a memory of
                     a past state.

  3. ACT             Execute through real tools only. No narrated-but-not-
                     executed steps standing in for real ones — this is
                     already `VISION.md`'s own explicit policy for the
                     executive planner, extended here to everything.

  4. VERIFY          The outcome is checked by something OTHER than the
                     OUTCOME        acting process's own report: a test result, a live
                     log line, a second independent check, a human
                     confirmation. A self-report alone never closes this
                     step.

  5. RECORD          The goal, the action taken, and the independently-
                     verified outcome are written to a durable record — not
                     just "task complete," but complete-and-verified-how.

  6. LEARN           Future confidence/trust for similar actions is a
                     function of this record's real track record, not a
                     static per-turn health score.
```

Step 4 is the load-bearing one, and the one nothing in the codebase does
today. A trust score that only reflects "did the tool call return 200" is
answering a different, easier question than "did this turn out to be
right." This session's own Groq-model fix is a working example of the full
loop done by hand: propose ("fix chat's dead Groq calls") → precondition
check (live-verified the model catalog directly against Groq, not assumed)
→ act (edited 7 files) → verify outcome (re-deployed and read the real
`docker logs` output, not the response's own self-description, to confirm
which model actually answered) → record (this document, plus memory). The
system this document proposes is that same discipline, built into the
product instead of performed by hand each time.

## A concrete near-term sequence

This document is the vision and the loop; it is deliberately *not* an
implementation plan. Each phase below is a real architectural project in
its own right and should go through its own design pass
(`superpowers:brainstorming`) before any code is written — the same
standard `VISION.md` already set for this exact gap ("outcome/trust
measurement... deserving its own brainstorming pass, not a quick fix bolted
on"). Listed in the order they unlock each other:

1. **Fix the self-narration fabrication bug.** Before building a system that
   trusts Jarvis's own account of what happened, the one already-known case
   of Jarvis inventing that account needs to close. The `detail` block a
   response returns must be derived from the real execution trace (which
   backend actually responded, real measured latency), never generated
   freehand alongside the answer.
2. **Build the Outcome Ledger.** A durable, queryable record of
   propose → act → verified-outcome for every autonomous or semi-autonomous
   action Jarvis takes — the concrete home for step 5 of the loop above,
   and the first table `VISION.md`'s "confidence score" could read from
   instead of backend health alone.
3. **Wire real verification sources into step 4**, not just human
   confirmation — CI results, live health checks, a second model checking
   the first's claim against independent evidence, deployment diffs. Start
   narrow (one or two real action types) and prove the loop closes honestly
   before widening it.
4. **Let autonomy scope expand where the Ledger has earned it.** Low-risk,
   well-verified action types get a longer leash first; anything touching
   money, external communication, or irreversible state stays
   human-gated regardless of track record — matching the existing
   confirm-before-acting posture in `src/capabilities/`.
5. **Standing, self-directed goals** — a scheduled loop (the existing
   scheduler already runs `email-watch` and the self-health watchdog) that
   lets Jarvis pursue a small number of user-approved standing objectives
   over time, each pass running the full propose→verify→record loop rather
   than a one-shot job.

## The guardrail, stated plainly

If a future session — human or agent — is tempted to skip step 4 because
step 3 "obviously worked": don't. Every incident this document is written
in response to *looked* like it obviously worked, from the inside. The
entire value of Verified Autonomy is that it doesn't take the acting
process's word for it.

## How to use this document

Like `VISION.md`, this is a living document, not a one-time pitch — but it
tracks a loop's maturity, not a checklist's completion. Update it by adding
a dated note under "Verified foundation" or "Near-term sequence" only after
live-verifying the claim (re-checking real code, real logs, a real
deployment), the same discipline `VISION.md` already holds itself to. See
`VISION.md` for what's built; see this document for the principle
everything built next should be measured against.
