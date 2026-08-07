# GUI Redesign: Sci-Fi Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply four concrete, real (non-decorative) sci-fi GUI patterns to the existing production dashboard (`src/interaction/static/index.html`), grounded in a real audit of the current markup/JS: LCARS-derived color-coded sidebar taxonomy, a JARVIS/EDITH-derived AR ring + corner-bracket frame around the presence orb (gated on real camera-active state), reactivating the existing-but-currently-orphaned KITT-derived audio waveform scanner, and TARS-derived personality sliders that write to a real, persisted, behavior-affecting setting — not a cosmetic control.

**Architecture:** Tasks 1-3 are additive frontend-only changes to `index.html` (markup + CSS + small JS hooks into existing state), verified visually via Playwright screenshots against the live dev server rather than only unit tests, per this codebase's frontend-verification convention. Tasks 4-5 add a small vertical slice (DB migration → repo → route → system-prompt read → UI) for personality settings, following the exact existing pattern in `src/kernel/state/system-settings-repo.ts` / `src/interaction/routes/settings-routes.ts` rather than inventing a new persistence mechanism.

## Global Constraints

- No task in this plan touches `NeuralOrb`'s canvas rendering code (`draw()`, `register()`, `setState()` in `index.html`'s inline script) — new visual elements are CSS/HTML siblings layered around the canvas, never inside it.
- New orb-adjacent elements (AR ring, corner brackets) must live inside `#quantum-eye-container` (or its `.hologram-float` child) as siblings of `#quantum-eye`, NOT children of `#quantum-eye` itself — `#quantum-eye` has `overflow-hidden` (a circular mask) that would clip anything placed inside it, exactly as documented by the existing dev comment near the video PiP element.
- Task 3 must NOT create a second `AnalyserNode`/`getUserMedia` call — it reuses the existing `analyser`/`dataArray`/`visualizerActive` state and the existing `animateWaveform()` rAF loop (`index.html:2248-2278`), which already reads real mic levels but currently drives zero elements (`querySelectorAll('.wave-bar')` matches nothing in the current markup).
- Personality settings (Tasks 4-5) must follow the existing `system_settings` singleton-row pattern (`src/kernel/state/system-settings-repo.ts`, `src/kernel/state/migrations/003_system_settings.ts`, `src/interaction/routes/settings-routes.ts`) — extend that table/repo/route, do not create a new table or a JSON-file-based store.
- Every frontend task's "done" verification includes a real Playwright screenshot of the live dev server (not just "the code looks right") — this codebase's own convention for UI changes (see this session's earlier GUI audit, which screenshotted the live page before proposing changes).
- Sliders must be functionally real: their persisted values must be read into actual system-prompt construction (`src/self/identity.ts` and/or `src/interaction/live-voice.ts`, wherever the current hardcoded persona text lives), not merely stored and displayed back.

---

### Task 1: LCARS-derived sidebar module color coding

**Files:**
- Modify: `src/interaction/static/index.html` (sidebar `<nav>`, lines ~113-166; existing inline `<style>` block near the top of `<head>`)

**Interfaces:**
- Consumes: nothing new — pure markup/CSS addition to the existing 7 uniform `nav-btn` elements (`nav-home`, `nav-projects`, `nav-vault`, `nav-calendar`, `nav-knowledge`, `nav-operations`, `nav-settings`).
- Produces: each `nav-btn` gains a `data-module="<name>"` attribute; a new CSS block defines one accent custom property per module (`--mod-core`, `--mod-ops`, `--mod-knowledge`, `--mod-vault`, `--mod-calendar`) and a small left-edge accent indicator per `[data-module]` value, visible on the active item at minimum (hover/active state), not a full re-theme of every icon.

- [ ] **Step 1: Read the current sidebar markup and active-state styling**

Read `src/interaction/static/index.html` lines 113-166 (the `<nav>` block) and find `switchTab()` in the inline script to see exactly how the "active" class/state is currently applied to a `nav-btn` (grep for `switchTab` and read its body) — your new per-module accent must layer onto whatever that function already does, not replace it.

- [ ] **Step 2: Add the CSS tokens**

In the existing `<style>` block (near the `.glass-panel`/`.holo-panel` rules already in the file), add:

```css
:root {
    --mod-core: #50c8ff;
    --mod-ops: #ffb454;
    --mod-knowledge: #b98cff;
    --mod-vault: #5ee6b0;
    --mod-calendar: #ff8a8a;
}
.nav-btn[data-module] {
    position: relative;
}
.nav-btn[data-module].active::before,
.nav-btn[data-module]:hover::before {
    content: "";
    position: absolute;
    left: -8px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 60%;
    border-radius: 2px;
    background: var(--mod-color, var(--mod-core));
}
.nav-btn[data-module="projects"] { --mod-color: var(--mod-core); }
.nav-btn[data-module="vault"] { --mod-color: var(--mod-vault); }
.nav-btn[data-module="calendar"] { --mod-color: var(--mod-calendar); }
.nav-btn[data-module="knowledge"] { --mod-color: var(--mod-knowledge); }
.nav-btn[data-module="operations"] { --mod-color: var(--mod-ops); }
```

(Adjust selector specificity/exact class names only if Step 1 finds the real "active" class differs from a plain `.active` — use what's actually there.)

- [ ] **Step 3: Add `data-module` to each nav button**

Add `data-module="home"` / `"projects"` / `"vault"` / `"calendar"` / `"knowledge"` / `"operations"` / `"settings"` to the 7 respective `nav-btn` elements found in Step 1 — one attribute added per element, nothing else about them changes.

- [ ] **Step 4: Visual verification**

Start the dev server if not already running (`npx tsx --env-file=.env src/server.ts`, exporting `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value> OAUTH_TOKEN_ENCRYPTION_KEY=<real value>` from `.env` first if not already running — check `ps aux | grep tsx.*server.ts` before starting a duplicate). Use the Playwright MCP tools (`browser_navigate` to `http://localhost:3000/`, `browser_take_screenshot`) to capture the sidebar with at least 2 different nav items in their active/hover state, and visually confirm the accent color appears and differs per module. Read the screenshot back and describe what you see in your report — don't just claim it works.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add LCARS-derived per-module accent coloring to the sidebar nav"
```

---

### Task 2: AR ring + corner-bracket frame around the presence orb

**Files:**
- Modify: `src/interaction/static/index.html` (orb markup near lines 213-224, inline `<style>` block, `updateSensorStatusLabel()` near lines 1207-1222)

**Interfaces:**
- Consumes: the existing `cameraStream` module-level variable (truthy while a camera/vision stream is live — set in `toggleCameraSensor()`, read at multiple existing call sites including inside `updateSensorStatusLabel()`).
- Produces: a new sibling markup block inside `#quantum-eye-container` (NOT inside `#quantum-eye`) containing a dashed rotating outer ring, an accented rotating arc segment, and 4 corner-bracket `<div>`s; a new CSS class (e.g. `.orb-frame-active`) toggled on the container by `updateSensorStatusLabel()` exactly where it already reads `cameraStream`, so the frame appears/disappears in sync with real sight-mode state rather than a separate toggle path.

- [ ] **Step 1: Read the exact current orb markup and `updateSensorStatusLabel`**

Read `index.html` lines ~205-230 for the exact current markup (container id, class names, the `.hologram-float` wrapper, `#quantum-eye`'s `overflow-hidden`) and lines ~1207-1222 for exactly how `updateSensorStatusLabel()` currently branches on `cameraStream` — you'll add one line there, not restructure it.

- [ ] **Step 2: Add the CSS**

Add to the existing `<style>` block:

```css
.orb-ar-frame {
    position: absolute;
    inset: -22px;
    border-radius: 50%;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.4s ease;
}
#quantum-eye-container.orb-frame-active .orb-ar-frame {
    opacity: 1;
}
.orb-ar-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px dashed rgba(80, 200, 255, 0.22);
    animation: orb-ring-spin 60s linear infinite;
}
.orb-ar-arc {
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: rgba(80, 200, 255, 0.75);
    border-right-color: rgba(80, 200, 255, 0.75);
    animation: orb-ring-spin 6s linear infinite;
}
@keyframes orb-ring-spin { to { transform: rotate(360deg); } }
.orb-corner {
    position: absolute;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(80, 200, 255, 0.85);
    opacity: 0;
    transition: opacity 0.4s ease;
}
#quantum-eye-container.orb-frame-active .orb-corner { opacity: 1; }
.orb-corner.tl { top: -8px; left: -8px; border-right: none; border-bottom: none; border-radius: 4px 0 0 0; }
.orb-corner.tr { top: -8px; right: -8px; border-left: none; border-bottom: none; border-radius: 0 4px 0 0; }
.orb-corner.bl { bottom: -8px; left: -8px; border-right: none; border-top: none; border-radius: 0 0 0 4px; }
.orb-corner.br { bottom: -8px; right: -8px; border-left: none; border-top: none; border-radius: 0 0 4px 0; }
@media (prefers-reduced-motion: reduce) {
    .orb-ar-ring, .orb-ar-arc { animation: none; }
}
```

- [ ] **Step 3: Add the markup**

Inside `#quantum-eye-container`, as a sibling of `.hologram-float` (or inside `.hologram-float` but still a sibling of `#quantum-eye` — match whichever level Step 1 shows is outside the `overflow-hidden` boundary), add:

```html
<div class="orb-ar-frame">
    <div class="orb-ar-ring"></div>
    <div class="orb-ar-arc"></div>
    <div class="orb-corner tl"></div>
    <div class="orb-corner tr"></div>
    <div class="orb-corner bl"></div>
    <div class="orb-corner br"></div>
</div>
```

- [ ] **Step 4: Wire the toggle into `updateSensorStatusLabel()`**

At the exact point in `updateSensorStatusLabel()` where it already does `orb.classList.add/remove('orb-active')` based on `cameraStream` (per Step 1's findings), add the matching toggle on the container:

```js
document.getElementById('quantum-eye-container')?.classList.toggle('orb-frame-active', !!cameraStream);
```

- [ ] **Step 5: Visual verification**

Using Playwright against the live dev server: screenshot the orb with the camera sensor OFF (frame should be invisible/opacity 0) and, if a real camera can be granted in this sandbox's headless browser (check — it may not, in which case call `toggleCameraSensor()` or set `cameraStream` via the console / trigger the code path directly and re-render, documenting that a real camera grant wasn't available and this is the best achievable verification), with it toggled on (frame visible, rotating ring, corner brackets present). Read both screenshots back and describe what you see.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add a JARVIS/EDITH-derived AR ring and corner-bracket frame around the orb, gated on real camera state"
```

---

### Task 3: Reactivate the orphaned KITT-derived waveform scanner

**Files:**
- Modify: `src/interaction/static/index.html` (near the mic toggle button; exact location found by reading the file — search for where the camera/mic sensor toggle buttons are rendered, likely near line ~200-230 alongside the orb)

**Interfaces:**
- Consumes: the ALREADY-EXISTING `animateWaveform()` function (`index.html:2248-2278`) which already runs every frame via `requestAnimationFrame`, already reads real mic levels via `analyser`/`dataArray`/`visualizerActive` when active, and already does `document.querySelectorAll('.wave-bar')` — currently matching zero elements. This task adds ONLY the missing `.wave-bar` markup; it does not touch `animateWaveform()`, `analyser`, `dataArray`, or any `getUserMedia`/`AudioContext` code.
- Produces: 8 `<div class="wave-bar">` elements positioned near the mic toggle button, styled minimally (width/border-radius only — `animateWaveform()` already sets `height`/`backgroundColor` inline per frame).

- [ ] **Step 1: Find the mic toggle button's exact markup**

Read the area of `index.html` around the camera/mic sensor buttons (search for `toggleCameraSensor` and `toggleMicrophoneSensor` onclick handlers in the markup, not just their JS definitions) to find where to place the new bars visually adjacent to the mic button.

- [ ] **Step 2: Add minimal CSS for the bars**

```css
.wave-bar-row {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 24px;
}
.wave-bar {
    width: 3px;
    min-height: 2px;
    border-radius: 2px;
    background: rgba(56, 189, 248, 0.35);
    transition: height 0.05s linear;
}
```

- [ ] **Step 3: Add the markup**

```html
<div class="wave-bar-row" aria-hidden="true">
    <div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div>
    <div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div>
</div>
```

- [ ] **Step 4: Verify `animateWaveform()` picks them up with no other changes**

Re-read `index.html:2248-2278` after this markup change and confirm the existing logic requires no modification — `querySelectorAll('.wave-bar')` will now return these 8 elements and the existing per-frame branches (`isSpeaking`/`visualizerActive`/`isThinking`/idle) already set `height`/`backgroundColor` on each. If for any reason the existing function needs a small adjustment to work correctly with real elements now present (e.g. it assumed a different bar count or CSS unit), make the minimal fix and document exactly why in your report — do not silently rewrite `animateWaveform()`'s logic.

- [ ] **Step 5: Visual verification**

Screenshot via Playwright: idle state (bars should show the existing idle sine-wave animation per the current code's `else` branch — confirm they're visibly moving/varying across two screenshots taken a moment apart, or note if headless screenshot timing can't capture animation and instead confirm via reading computed `style.height` on a `.wave-bar` element at two different times through `browser_evaluate` if needed). Read the screenshot(s) and describe what you see.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add the wave-bar elements the existing audio-reactive scanner logic has been silently missing"
```

---

### Task 4: Personality settings — backend persistence + system-prompt wiring

**Files:**
- Create: `src/kernel/state/migrations/004_personality_settings.ts`
- Modify: `src/kernel/state/system-settings-repo.ts`
- Modify: `src/interaction/routes/settings-routes.ts`
- Modify: `src/self/identity.ts` (wherever the hardcoded persona text currently lives — read the file first to find the exact spot, referenced earlier in this session as `identity.ts:134`, but re-verify the current line since other work may have shifted it)
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: the exact existing pattern in `system-settings-repo.ts` (`SystemSettingsRow`, `SystemSettingsUpdate`, `getSystemSettings()`, `updateSystemSettings()`, the `COALESCE`-based partial `UPDATE` against the singleton `system_settings` table) and `settings-routes.ts`'s existing `GET/POST /api/settings` handlers (gated by `validateApiKey` + `requireCapability("settings.write")`).
- Produces: three new nullable/defaulted columns on `system_settings` — `personality_formality` (integer 0-100, default 50), `personality_humor` (integer 0-100, default 30), `personality_verbosity` (integer 0-100, default 50); the existing `SystemSettingsRow`/`SystemSettingsUpdate` interfaces gain these 3 fields; `GET/POST /api/settings` read/write them through the exact same partial-update idiom as the 5 existing fields; a new exported function `buildPersonalityPromptFragment(settings: {personality_formality: number; personality_humor: number; personality_verbosity: number}): string` in `identity.ts` that turns the 3 numbers into natural-language guidance appended to the system prompt (e.g. "Lean informal and brief" vs. "Maintain a formal, thorough register" — write real, distinct phrasing at low/mid/high for each dimension, not a single generic template), consumed at the exact point `buildIdentityContext` (or wherever the hardcoded persona string is built) currently hardcodes tone.

- [ ] **Step 1: Read the existing pattern completely before touching it**

Read `src/kernel/state/system-settings-repo.ts` in full, `src/kernel/state/migrations/003_system_settings.ts` in full, the relevant handlers in `src/interaction/routes/settings-routes.ts`, and `src/self/identity.ts`'s current persona-string construction. Confirm the exact current line numbers and exact current field list before writing any new code.

- [ ] **Step 2: Write the migration**

Create `004_personality_settings.ts` following `003_system_settings.ts`'s exact structure/export shape (read it first — match id format, up-migration shape, any down-migration convention this codebase uses). Add:

```sql
ALTER TABLE system_settings ADD COLUMN personality_formality INTEGER NOT NULL DEFAULT 50;
ALTER TABLE system_settings ADD COLUMN personality_humor INTEGER NOT NULL DEFAULT 30;
ALTER TABLE system_settings ADD COLUMN personality_verbosity INTEGER NOT NULL DEFAULT 50;
```

(Adjust to this codebase's actual migration-authoring convention — e.g. if migrations use a query-builder rather than raw SQL, match that instead.)

- [ ] **Step 3: Extend the repo**

Add the 3 fields to `SystemSettingsRow` and `SystemSettingsUpdate`, and extend `updateSystemSettings()`'s `COALESCE` clause to include them, following the exact same pattern as the 5 existing fields.

- [ ] **Step 4: Extend the routes**

Add the 3 fields to `GET /api/settings`'s response shape and `POST /api/settings`'s accepted-fields/validation (validate each is an integer 0-100 if this codebase's existing settings validation has a precedent for range-checking a numeric field — if not, add a minimal explicit check here since these values directly become prompt text and an out-of-range value would degrade a real LLM call, not just display wrong).

- [ ] **Step 5: Write `buildPersonalityPromptFragment` and wire it in**

Add this function to `identity.ts` with real, distinct phrasing per rough band (e.g. low/mid/high) for each of the 3 dimensions — write actual sentences, not a templated `"formality: {value}"` string (an LLM system prompt needs natural-language guidance, not a raw number, to actually shift behavior). Call it at the exact point the current hardcoded persona string is assembled, appending its output rather than replacing the whole persona (the base "Jarvis" identity/voice stays; these 3 dials adjust register/length/humor within it).

- [ ] **Step 6: Write tests**

Match `tests/index.test.ts`'s real `registerTest` convention. Test: `buildPersonalityPromptFragment` produces distinctly different, non-empty text for a low-formality/high-humor input vs. a high-formality/low-humor input (assert the two outputs are not equal — don't assert exact wording, since that's presentation detail, but do assert they differ and both contain no placeholder text). Test: `updateSystemSettings` persists and `getSystemSettings` reads back all 3 new fields correctly (matching the existing test pattern for the 5 original fields, if one exists — reuse it as a template).

- [ ] **Step 7: Run the full suite**

Export `POSTGRES_HOST=localhost POSTGRES_USER=jarvis_user POSTGRES_DB=jarvis INTERNAL_API_KEY=<real value from .env> OAUTH_TOKEN_ENCRYPTION_KEY=<real value from .env>` first. Run `npx tsc --noEmit && npm test`.

- [ ] **Step 8: Commit**

```bash
git add src/kernel/state/migrations/004_personality_settings.ts src/kernel/state/system-settings-repo.ts src/interaction/routes/settings-routes.ts src/self/identity.ts tests/index.test.ts
git commit -m "feat: add persisted personality settings (formality/humor/verbosity) wired into the real system prompt"
```

---

### Task 5: Personality sliders UI

**Files:**
- Modify: `src/interaction/static/index.html` (the existing Settings tab/panel — find it by reading the file's settings-related markup and the existing settings-save fetch call around line ~4109-4127)

**Interfaces:**
- Consumes: `GET/POST /api/settings` (now returning/accepting `personality_formality`/`personality_humor`/`personality_verbosity` per Task 4), the existing `authFetch`/`CURRENT_API_KEY` pattern, the existing settings-save `addNotification(...)` success/warning/danger convention.
- Produces: 3 new range-slider controls in the existing Settings panel, matching this file's real existing form-control styling (read what's already there for the other 5 settings fields and match it, don't invent a new control style), wired to load current values on settings-panel open and save on the existing save button's existing click handler (extending the request body, not adding a second save button/flow).

- [ ] **Step 1: Read the existing Settings panel markup and save flow completely**

Read the Settings tab's current markup and the exact save handler (~line 4109-4127 per this session's earlier audit, re-verify) before adding anything — match its structure exactly.

- [ ] **Step 2: Add the 3 sliders**

Add 3 `<input type="range" min="0" max="100">` controls with labels ("Formality", "Humor", "Verbosity"), styled to match the existing settings form's existing input styling (read and reuse existing classes, don't write new ad hoc styles unless the file has no reusable pattern for a range input specifically — in which case add minimal styling consistent with the file's existing accent color).

- [ ] **Step 3: Wire load-on-open and save**

Find wherever the Settings panel currently fetches/populates its existing 5 fields on open, and add the 3 new fields to that same fetch/populate call. Find the existing save handler and add the 3 new values to its existing `POST /api/settings` body — do not create a second fetch call or a second save button.

- [ ] **Step 4: Visual verification**

Playwright screenshot of the Settings panel showing all 3 sliders alongside the existing settings fields, at a plausible mid-range value. If feasible without excessive complexity, also verify via `browser_evaluate` or a manual interaction that moving a slider and clicking save results in a real `POST /api/settings` network call containing the new fields (check via Playwright's network inspection tools if available, or by reading the JS to confirm the wiring is correct if a live network-call check proves impractical in this sandbox — document which verification method was actually used).

- [ ] **Step 5: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add personality sliders to the Settings panel, wired to the persisted setting"
```

---

## Final check

- [ ] Run `npx tsc --noEmit && npm test` end to end.
- [ ] Confirm `NeuralOrb`'s canvas rendering code (`draw`/`register`/`setState`) is byte-for-byte unmodified across the whole plan's diff.
- [ ] Confirm no task added a second `AnalyserNode`/`getUserMedia` call — `grep -c "createAnalyser\|getUserMedia" index.html` before and after this plan's diff should show the same count.
- [ ] Confirm the personality sliders' values genuinely reach `identity.ts`'s system-prompt construction — trace one value end-to-end from a `POST /api/settings` call through to `buildPersonalityPromptFragment`'s output, don't just confirm each layer exists in isolation.
- [ ] Take one final full-page Playwright screenshot of the redesigned dashboard and confirm, by looking at it, that all 4 patterns (sidebar coloring, orb frame when camera active, waveform bars, settings sliders) are visually present and don't visually collide with each other or existing UI elements.
