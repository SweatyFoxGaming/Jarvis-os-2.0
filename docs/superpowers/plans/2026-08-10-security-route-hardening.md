# Security & Route Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two concrete security gaps a prior audit found — an unauthenticated, unrated LLM-proxy route and a hardcoded fallback API key — and make the key that replaces the hardcoded fallback a hard startup requirement instead of a silent default.

**Architecture:** `POST/GET /api/chat/stream` (`src/routes/streamRoute.ts`) currently bypasses every auth/rate-limit check `server.ts` applies to every other AI-facing route — it calls billed Gemini/Groq APIs directly with no cap. Fix: wire the same `validateApiKey` + `aiLimiter` middleware every other AI route already uses. Separately, `src/api.py`'s proxy layer falls back to a hardcoded legacy API key literal whenever `INTERNAL_API_KEY` is unset; fix: delete the literal and fail the gateway process fast at startup if the key is missing, mirroring the existing `ADMIN_API_KEY` fail-fast pattern in `src/kernel/auth-middleware.ts:21-29`.

**Scope note on "daemon startup" env-var assertions:** the fail-fast check in Task 2 belongs in `src/api.py` — the Python gateway process — not `daemon/voice_engine.py` (the STT/TTS voice daemon). Verified against the code: `daemon/models.py` and `daemon/voice_engine.py` read no API-key or secret env vars at all (grepped for `os.environ`/`API_KEY` — the only env var either file reads is `VOICE_DAEMON_SOCKET`, which already has a working default and isn't a secret). `src/api.py` is the only Python process gaining a newly-required secret as a result of this plan, so that's where the fail-fast check goes.

**Tech Stack:** TypeScript/Express (`src/server.ts`, `src/routes/streamRoute.ts`), Python/FastAPI (`src/api.py`), the repo's custom test runner (`tests/index.test.ts`, run via `npm test`).

## Global Constraints

- No new dependencies — every fix uses middleware/patterns already present in the codebase.
- `INTERNAL_API_KEY` becomes a **required** env var for `src/api.py` to start. `.env.example` already declares the key (currently blank); any real deployment must set it before this change ships, or the gateway process will refuse to start.
- Every HTTP-level regression test in `tests/index.test.ts` follows the existing `spawnTestServer`/`stopTestServer`/`TEST_ADMIN_API_KEY` convention (defined at `tests/index.test.ts:1704-1760`) — a dedicated port, never a reused one already claimed elsewhere in the file.
- `npm test` runs the entire `tests/index.test.ts` suite (no test-name filtering exists in this repo's tooling) — each verification step below means a full run, not a scoped one.

---

### Task 1: Require auth + rate limiting on `/api/chat/stream`

**Files:**
- Modify: `src/server.ts:166-167`
- Test: `tests/index.test.ts` (new `registerTest("HTTP Boundary", ...)` block, appended after the existing test at `tests/index.test.ts:1984-2024`)

**Interfaces:**
- Consumes: `validateApiKey` (already imported at `src/server.ts:30`, signature `(req, res, next) => Promise<void>`, returns 401 JSON on missing/invalid key — see `src/kernel/auth-middleware.ts:75-116`), `aiLimiter` (already constructed at `src/server.ts:157-164`, a `rateLimit(...)` instance keyed by `req.username || req.ip`, 20 requests/60s, responds `429` with `{ error: "Too many requests — please slow down." }` once exceeded), `spawnTestServer`/`stopTestServer`/`TEST_ADMIN_API_KEY` (`tests/index.test.ts:1704-1760`).
- Produces: no new exports — this task only adds middleware to an existing route registration.

- [ ] **Step 1: Write the failing test**

Append this block immediately after the existing test ending at `tests/index.test.ts:2024` (before the next `registerTest` call, if any, or at the end of the `HTTP Boundary` section):

```typescript
// /api/chat/stream (src/routes/streamRoute.ts) called real, billed Gemini/
// Groq APIs directly with no auth and no rate limit at all — anyone who
// could reach the host got an unmetered LLM proxy. This locks in that a
// request with no API key is rejected before handleChatStream ever runs a
// real (billed) provider call.
registerTest("HTTP Boundary", "POST /api/chat/stream requires an API key", async () => {
  const port = 3022;
  const child = await spawnTestServer(port, { INTERNAL_API_KEY: TEST_ADMIN_API_KEY });

  try {
    const noKey = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    if (noKey.status !== 401) {
      throw new Error(`HTTP Boundary: expected 401 with no API key on POST /api/chat/stream, got ${noKey.status}`);
    }

    const noKeyGet = await fetch(`http://127.0.0.1:${port}/api/chat/stream?prompt=hello`);
    if (noKeyGet.status !== 401) {
      throw new Error(`HTTP Boundary: expected 401 with no API key on GET /api/chat/stream, got ${noKeyGet.status}`);
    }
  } finally {
    await stopTestServer(child);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the new test reports `HTTP Boundary: expected 401 with no API key on POST /api/chat/stream, got 400` (the route currently reaches `handleChatStream`, which 400s on a missing/empty prompt shape or otherwise attempts a real provider call — either way, not the 401 an auth gate would produce).

- [ ] **Step 3: Add the middleware**

In `src/server.ts`, replace:

```typescript
app.post('/api/chat/stream', handleChatStream);
app.get('/api/chat/stream', handleChatStream);
```

(lines 166-167) with:

```typescript
app.post('/api/chat/stream', validateApiKey, aiLimiter, handleChatStream);
app.get('/api/chat/stream', validateApiKey, aiLimiter, handleChatStream);
```

`validateApiKey` and `aiLimiter` are both already in scope at this point in the file (`validateApiKey` imported at line 30; `aiLimiter` constructed at lines 157-164, directly above this registration) — no new imports needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — both assertions in the new test pass, and every pre-existing test in the file still passes (this route had no prior test coverage, so no existing test should have depended on it being open).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/index.test.ts
git commit -m "fix: require auth and rate limiting on /api/chat/stream"
```

---

### Task 2: Remove the hardcoded fallback API key and require `INTERNAL_API_KEY` at gateway startup

**Files:**
- Modify: `src/api.py:234-254` (`make_proxy_request`), `src/api.py:291-311` (`proxy_streaming_request`)
- Modify: `.env.example` (comment on the existing `INTERNAL_API_KEY=` line)

**Interfaces:**
- Consumes: none new — `os.environ`, already imported (`src/api.py:1`).
- Produces: a module-level `INTERNAL_API_KEY` constant in `src/api.py`, resolved once at import time, used by both proxy functions in place of their current per-call `os.environ.get(...)` + hardcoded-fallback logic.

- [ ] **Step 1: Add the fail-fast check and module-level constant**

In `src/api.py`, immediately after the existing logger setup (after line 44, `logger = logging.getLogger("jarvis-gateway")`), insert:

```python
# No literal fallback here on purpose — mirrors src/kernel/auth-middleware.ts's
# ADMIN_API_KEY fail-fast (that file's own comment explains why: a missing
# key must fail loudly at boot, not silently grant proxy access via a
# guessable/shared default). This constant replaces the hardcoded legacy key
# literal that used to live inline in make_proxy_request/proxy_streaming_request
# below whenever INTERNAL_API_KEY was unset in the environment.
INTERNAL_API_KEY = os.environ.get("INTERNAL_API_KEY")
if not INTERNAL_API_KEY:
    logger.error(
        "[Gateway] FATAL: INTERNAL_API_KEY is not set. Refusing to start with no way "
        "to authenticate proxy calls to the Express backend — set INTERNAL_API_KEY to "
        "a long random string in .env (it must match the value Express itself reads "
        "via src/kernel/auth-middleware.ts's ADMIN_API_KEY fallback)."
    )
    sys.exit(1)
```

`sys` is already imported at `src/api.py:2`; `os` at line 1.

- [ ] **Step 2: Remove the hardcoded fallback in `make_proxy_request`**

In `src/api.py`, replace (lines 244-254):

```python
    # Add INTERNAL_API_KEY to proxy headers, falling back to a hardcoded
    # legacy key if INTERNAL_API_KEY is unset in the environment. This ensures
    # internal background tasks and proxy calls consistently send a valid key.
    internal_api_key = os.environ.get("INTERNAL_API_KEY")
    legacy_api_key_fallback = "c44dcd566e20d12f361464fb83c3734e02c60dbfd8b4f75e9a98f24d63c24918" # Mirrors the constant in src/kernel/auth-middleware.ts
    
    if internal_api_key:
        proxy_headers["x-api-key"] = internal_api_key
    else:
        proxy_headers["x-api-key"] = legacy_api_key_fallback
        logger.info("[Gateway] INTERNAL_API_KEY is not set. Proxying with hardcoded legacy API key.")
```

with:

```python
    proxy_headers["x-api-key"] = INTERNAL_API_KEY
```

- [ ] **Step 3: Remove the identical fallback in `proxy_streaming_request`**

Apply the same replacement to the duplicate block at lines 301-311 (same six lines, same fix — `proxy_headers["x-api-key"] = INTERNAL_API_KEY`).

- [ ] **Step 4: Update `.env.example`'s comment**

The existing `.env.example:4` line (`INTERNAL_API_KEY=`) currently ships blank. Update the comment directly above it (or add one if none exists) to read:

```
# Required. The Python gateway (src/api.py) now fails to start if this is
# unset. Set to a long random string — the same value Express reads via
# src/kernel/auth-middleware.ts's ADMIN_API_KEY fallback.
INTERNAL_API_KEY=
```

- [ ] **Step 5: Verify by hand — start the gateway with the key unset**

Run: `INTERNAL_API_KEY= python3 src/api.py` (from the repo root, with a Python environment that has `fastapi`/`uvicorn` installed per `requirements.txt`)
Expected: the process logs the FATAL message from Step 1 and exits immediately with a non-zero code — it must not reach `uvicorn.run(...)`.

Run: `INTERNAL_API_KEY=some-long-random-test-value python3 src/api.py`
Expected: the process starts normally (logs proceed past the fail-fast check).

- [ ] **Step 6: Commit**

```bash
git add src/api.py .env.example
git commit -m "fix: remove hardcoded fallback API key, require INTERNAL_API_KEY at gateway startup"
```

---

### Task 3: Full-suite verification

**Files:** none (verification-only task)

**Interfaces:**
- Consumes: `npm test` (runs `tests/index.test.ts` in full, per `package.json`'s `"test"` script).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: every test passes, including both new/modified tests from Tasks 1-2 and every pre-existing test (in particular the other `HTTP Boundary` auth tests at `tests/index.test.ts:1825-1874` and `:1984-2024`, which exercise `validateApiKey`/capability-gating on unrelated routes and must be unaffected by this plan's changes).

- [ ] **Step 2: Confirm no other route was left unauthenticated by mistake**

Run: `grep -n "app\.\(post\|get\|put\|delete\)(" src/server.ts | grep -v "validateApiKey\|/health\|/ws/events"`
Expected: review the output by eye — every AI-facing or state-changing route should carry `validateApiKey` (public routes like `/health` and the small, deliberately-unauthenticated set documented in `src/interaction/routes/auth-routes.ts` are the only expected exceptions). This step is a manual audit checkpoint, not an automated assertion — record findings in the task's commit message or PR description if anything unexpected turns up, rather than silently proceeding.

This task has no commit of its own — it's a verification checkpoint after Tasks 1 and 2's commits.
