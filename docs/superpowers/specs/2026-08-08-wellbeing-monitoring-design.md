# Proactive Wellbeing Monitoring

## Goal

Give Jarvis the Baymax-style function identified in this session's sci-fi-AI capability audit: notice real, evidence-grounded signs that a user might be overworking or stressed, and check in — not fabricated concern, never guessed, always tied to actual observed patterns.

## Why

Jarvis already monitors its own health (`shadow-verifier.ts`) and models each user's tone (`rapport.ts`), but nothing monitors the *user's* wellbeing. This is the second, previously-identified gap from the "core functions" sci-fi comparison, closing it alongside rapport modeling.

## Architecture

Two real, already-recorded data sources, no new tracking invented from scratch:

1. **Late-hour activity pattern** — `conversation_history` (existing table, `session-repo.ts`) already has real per-message timestamps. A new query counts how many of a user's messages in the last 7 days fell in a late-night/early-morning UTC hour band (23:00–06:00) versus total messages in that window — a rough, honestly-labeled heuristic (no per-user timezone is stored anywhere in this codebase, so this can't be more precise than UTC-bucket without inventing new tracking, and this spec explicitly does not do that).
2. **Recent rapport signals** — `rapport_signals` (already built) already stores real, LLM-extracted tone descriptors per user. A wellbeing check scans the most recent descriptors for genuinely stress-indicating language (a small, explicit keyword list — "stressed," "overwhelmed," "exhausted," "burnt out," "frustrated," etc.) — this doesn't run a new LLM call; it's a plain scan over data that was *already* honestly extracted by `rapport.ts`, so no new fabrication risk is introduced.

If either signal crosses a real threshold, and enough time has passed since the last check-in for this user (a new `wellbeing_checkins` table, one row per user, tracks this — avoiding a check-in every single day even if the pattern persists), a scheduled job (`startWellbeingCheckJob` in `scheduler.ts`, mirroring `startSelfReflectionJob`'s exact structure: `usersRepo.listUsernames()`, per-user try/catch isolation, `pushNotification`) pushes one honest, evidence-citing notification and records the check-in.

## Components

| File | Responsibility |
|---|---|
| `src/kernel/state/migrations/0XX_wellbeing_checkins.ts` | Create — `wellbeing_checkins` table (one row per user, `last_checkin_at`) |
| `src/kernel/state/wellbeing-repo.ts` | Create — `getLateHourActivityRatio(username, days=7)` (queries `conversation_history` directly), `getLastCheckinAt(username)`, `recordCheckin(username)` |
| `src/self/wellbeing.ts` | Create — `assessWellbeingSignal(username): Promise<string \| null>` — combines both real signals, returns a genuine evidence-citing check-in message or `null` if nothing warrants one |
| `src/kernel/scheduler.ts` | Modify — add `startWellbeingCheckJob`, mirroring `startSelfReflectionJob`'s structure exactly |
| `src/server.ts` | Modify — wire the new job into startup, alongside the other scheduled jobs |

## Data Flow

Scheduled job (daily, matching `startSelfReflectionJob`'s cadence) → for each known user → `assessWellbeingSignal(username)` → reads `getLateHourActivityRatio` + recent `rapport_signals` → if a real threshold is crossed AND `getLastCheckinAt` shows enough time has passed (or no prior check-in) → returns an honest message citing the actual observed pattern → `pushNotification` + `recordCheckin`.

## Error Handling

- Both data sources degrade cleanly (matching every repo in this codebase) — a Postgres failure means "no signal," never a crash or a fabricated check-in.
- Per-user isolation in the scheduled job (one user's failure doesn't block another's), matching `startSelfReflectionJob`'s exact existing pattern.
- The message itself must cite the real pattern observed (e.g., "I've noticed you've been messaging quite late several nights this week") — never a generic, unfounded "you seem stressed."

## Testing

- `wellbeing-repo.ts`: unit tests for the late-hour ratio calculation against known synthetic timestamps, degrade-cleanly-when-Postgres-down.
- `wellbeing.ts`: `assessWellbeingSignal` tested with injected fake repo functions (DI, matching this session's established pattern) — asserts a genuine signal (high late-hour ratio, or stress keywords in recent rapport) produces a real, evidence-citing message; asserts normal patterns return `null`; asserts a recent check-in suppresses a new one even with a real signal present.

## Out of Scope

- Any UI visualization of wellbeing signals.
- Per-user timezone tracking (would make the late-hour heuristic accurate, but is new infrastructure beyond this phase's scope).
- Any action beyond a single conversational notification — no calendar changes, no automated "blocking" of late-night usage, nothing paternalistic beyond noticing and asking.
