# Self-Health Watchdog — Design Spec

## Problem

Jarvis has real, working observability (`ObservationPlatform`'s telemetry/metrics/audit log, a Postgres-checking `/health` endpoint) but nothing that ever *acts* on what it observes. Two real incidents this session proved this isn't theoretical: the EWW desktop HUD silently ran weeks-stale JavaScript (an old adapter instead of the current bridge) until a human happened to check, and the live production API crash-looped on a bad `POSTGRES_HOST` config until a human happened to read container logs. `/health` would have reported `database: "down"` the whole time — nothing was polling it. Nothing anywhere compares a running companion process's code against the real repo state, so the stale-HUD class of bug is structurally undetectable today.

## Goal

Jarvis periodically checks its own operational health — core dependencies reachable, companion processes running current code — and proactively notifies a human when something's wrong, the same way it already does for wellbeing/briefings, instead of silently drifting until someone happens to look.

## Design, confirmed with the project owner before implementation

### Architecture

One new scheduled job, `self-health-check`, registered via the existing `scheduler.registerJob(name, intervalMs, fn)` pattern (the same mechanism already running 7 other jobs — email-watch, briefing, self-reflection, wellbeing, mcp-health-check, vault-sync, data-retention). Runs every 10 minutes. No new framework, no new registry — this is a straightforward extension of an already-proven pattern, matching `mcp-health-check`'s "poll something, track state, react on threshold" shape but adding the one thing it doesn't do: actually notify a human.

### What it checks

**1. Core dependency health.** Reuses the SAME logic `GET /health` already runs (Postgres reachability via `pingDatabase()`, Gemini key presence) — extract that logic into a plain function both the route handler and the new job call directly, rather than the job making an HTTP request to its own server. Add two new direct reachability checks, following the same "connect and confirm, don't shell out" style as the existing Postgres ping:
- Voice-daemon: attempt a raw connect to its Unix socket path (`VOICE_DAEMON_SOCKET` env var, same one `audio-client.ts` already uses) — a bare `net.createConnection` + immediate `destroy()` is enough to confirm it's listening, no protocol exchange needed.
- llama-cpp: a bounded-timeout HTTP request to its configured endpoint's health/root path.

Deliberately NOT added: Docker container health via `docker ps`/`docker inspect`. The `api` container has no Docker socket access today (only `jarvis-builder` does, by deliberate, existing design — it's the sole isolated Docker-socket holder in the stack, specifically so the container that handles untrusted chat input doesn't have that privilege). This watchdog checks reachability of what `api` can already see over the network/filesystem, not container orchestration state — extending Docker-socket access to `api` is out of scope and not recommended.

**2. Companion-process staleness.** The real fix for the "weeks-stale HUD" incident class. Two-sided:
- `scripts/deploy-hud.sh` is modified to capture the real git SHA at deploy time (`git -C "$REPO_DIR" rev-parse HEAD`) and write it to a small version file alongside the compiled bridge (e.g. `~/jarvis-hud/VERSION`).
- `src/ipc/eww-bridge.ts` reads that file once at its own startup and includes the SHA when it reports its status over the existing `/ws/events` connection (or a small dedicated status message — whichever fits the bridge's real existing message shape better, decide during implementation).
- The watchdog job compares the bridge's last-reported SHA against the api server's own real `git rev-parse HEAD` (the repo is already bind-mounted into the `api` container at `/app`, so this is a plain local git command, not a network call). A mismatch persisting past a grace period (to avoid false-positives during a deploy in progress) is a real, actionable staleness signal.
- If the bridge hasn't reported a SHA at all recently (e.g. it's not running, or predates this change), that's also worth surfacing — distinctly from "reported an old SHA," since the fix differs (start the service vs. redeploy it).

Electron's desktop app is explicitly OUT of scope for the staleness check in this first pass — it's launched via `launch.sh`/a systemd unit directly from the live repo checkout (not a separately-compiled artifact like the EWW bridge), so it doesn't have the same "silently running an old build" failure mode the HUD bridge does. Revisit only if a real staleness incident with Electron actually happens.

**3. Notification.** On any degraded check, call the existing `pushNotification(username, message, type)` — same pipe wellbeing/briefing/self-reflection already use (in-app + real Web Push). Message must name the SPECIFIC thing that's wrong ("voice-daemon unreachable," "EWW HUD running commit `abc1234`, 3 commits behind current," "Postgres unreachable") — not a generic "something's wrong, check logs." Cooldown-gated per check-type (mirroring wellbeing's `MIN_DAYS_BETWEEN_CHECKINS` pattern, but on a much shorter timescale appropriate for infrastructure — e.g. don't re-notify about the SAME still-broken check more than once per hour) so a persistent outage doesn't spam notifications every 10 minutes.

### Who gets notified

This job has no per-user context the way wellbeing/briefing do (it's system-wide, not about one user's activity) — notify the admin user (however the existing jobs resolve "the" user for system-level notifications; check the real convention, e.g. `email-watch`'s or `mcp-health-check`'s pattern, and match it rather than inventing a new one).

## Testing approach

Unlike the two GUI plans, this is backend TypeScript with real, testable logic — use this codebase's normal test suite conventions (`tests/index.test.ts`, `registerTest`), not live-browser verification. Test the health-check functions directly with injected fake dependencies (unreachable-Postgres, unreachable-socket, SHA-mismatch, SHA-match cases) — this codebase already has an established DI pattern for exactly this shape of test (see `wellbeing.ts`'s `WellbeingDeps` pattern). The deploy-hud.sh/eww-bridge.ts staleness-reporting side needs the same live-deployment verification convention the earlier EWW work used (real `bash scripts/deploy-hud.sh`, real `systemctl`/`journalctl` checks) since it's genuinely running on a real host service.

## Explicitly deferred / not in scope

- Docker container health via `docker ps`/socket access (deliberately rejected — see above).
- Electron staleness detection (different failure mode, not proven to be a real problem yet).
- A formal "operational constraints" registry parallel to `src/self/constraints.ts` — that file is explicitly a behavioral/safety-boundary registry; this feature doesn't need a new registry, just a job that checks and notifies, matching `mcp-health-check`'s existing precedent.
- Self-healing/auto-restart of anything found unhealthy — this watchdog notifies a human, it does not take corrective action itself (consistent with every other proactive job in this codebase, and with the human-approval-before-action philosophy already documented in `constraints.ts`).
