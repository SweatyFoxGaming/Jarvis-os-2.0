# Ambient Orb Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orb the dominant, near-only visual element on both the Electron/web dashboard and the EWW desktop HUD, conveying state through color/motion rather than text or persistent panels, with settings/nav/conversation-history hidden by default.

**Architecture:** Extends the existing `NeuralOrb` canvas system (`src/interaction/static/index.html`) with two new states and a layered "heartbeat + sparks" CSS treatment around the canvas (following the same sibling-DOM-element pattern the existing AR-ring frame already uses). Restructures the main screen's default visibility (reveal-on-hover nav, ephemeral conversation card, ambient corner readouts). Separately rebuilds the EWW HUD (`config/eww/eww.yuck`/`.scss`) as a simplified GTK-CSS sibling of the same visual language, with a real window-stacking behavior change.

**Tech Stack:** Vanilla JS/CSS/HTML (dashboard), Canvas 2D (`NeuralOrb`), yuck/SCSS (eww), no new dependencies.

## Global Constraints

- The real orb (`NeuralOrb`) is a rotating 3D-projected neuron sphere with real, clickable vault-note points (bigger, pink-halo'd, `hitTest`-driven click-to-open) — **this stays.** The new "alive" treatment (heartbeat ping, sparks, state colors) layers around it as additional CSS-animated sibling DOM elements, not a replacement of the canvas rendering. Confirmed with the project owner: keep the neurons.
- `STATE_CONFIG` currently has `idle` / `active` / `speaking` — `active` is used for camera-sensor-active framing (AR-ring/corner-bracket treatment) and is orthogonal to the new `listening`/`thinking` states being added; do not repurpose or remove it.
- GTK-CSS (what eww's SCSS compiles to) has no `conic-gradient` and no `backdrop-filter` — the EWW orb is an accepted simplified sibling of the web orb, not a pixel port. Use `radial-gradient` + scale/opacity animation for its equivalent effect.
- No new runtime dependencies (npm packages, system packages) for either surface.
- Every task that touches `src/interaction/static/index.html` must NOT touch the file's `<style>` block's existing selectors destructively — add new CSS, don't restructure what's already there beyond what each task explicitly calls for.
- This file has no automated test harness for its own JS/CSS beyond what already exists in `tests/index.test.ts` (which tests backend routes, not frontend rendering) — verification is via a real live browser check (Playwright: navigate, snapshot, screenshot-equivalent inspection) at the end of each task that changes visible behavior, not a fabricated "looks fine" claim.

---

## Task 1: Extend `NeuralOrb` with `listening`/`thinking` states and real signal wiring

**Files:**
- Modify: `src/interaction/static/index.html` (the `NeuralOrb` IIFE, `STATE_CONFIG` object)

**Interfaces:**
- Produces: `STATE_CONFIG.listening` and `STATE_CONFIG.thinking` entries, callable via the existing `NeuralOrb.setState(scene, state)`.

- [ ] **Step 1: Read `NeuralOrb`'s full IIFE (`const NeuralOrb = (() => { ... })();`) and the real call sites of `NeuralOrb.setState`, `isSpeakingNow`, and the `isThinking`/`status` local variable completely before changing anything.** Grep for `NeuralOrb.setState(` and `isSpeakingNow` and `isThinking` across the file to find every real call site — do not guess line numbers, they may have shifted.

- [ ] **Step 2: Add the two new state entries**

In `STATE_CONFIG` (currently `{ idle: {...}, active: {...}, speaking: {...} }`), add:

```javascript
listening: { speed: 0.4, pinkMix: 0.4, brightness: 1.35 },
thinking: { speed: 0.55, pinkMix: 0.7, brightness: 1.2, hueShift: 40 },
```

`thinking`'s `hueShift: 40` is a new config field `draw()` doesn't currently read — add support for it in `draw()`: where `core` and `glow` gradients are built (the two `createRadialGradient` calls using `corePink`/`rgba(30,100,220,...)` colors), if `cfg.hueShift` is set, shift the core gradient's color toward violet (e.g. blend the `255,120,220` core color and the `30,100,220` glow color proportionally toward a violet like `170,110,255` based on `cfg.hueShift`). Keep this simple — a linear interpolation between the existing color and a violet target is enough; don't build a full HSL conversion pipeline for one field. Verify the `idle`/`active`/`speaking` states render unchanged (no `hueShift` field, so the blend is a no-op for them).

- [ ] **Step 3: Wire `listening` to a real signal**

Find the browser-`SpeechRecognition` start/end handlers and the recorded-clip (`/api/voice-input`) recording-start/stop handlers (both exist per the click-to-talk work — grep for `SpeechRecognition` and `runServerSideRecorder` or equivalent). Add `NeuralOrb.setState(focalOrbScene, 'listening')` when recording/recognition starts, and revert to the existing idle/active logic (call `updateSensorStatusLabel()`, which already picks the right state) when it ends. `focalOrbScene` (or whatever the real registered scene variable is named — confirm via Step 1) is the home-screen orb's scene object.

- [ ] **Step 4: Wire `thinking` to the real in-flight-request signal**

Find where the existing `isThinking` concept is set/read (Step 1). Add `NeuralOrb.setState(focalOrbScene, 'thinking')` at the point a chat/tool-call request is dispatched, and revert via `updateSensorStatusLabel()` when the response arrives (matching however the existing `isThinking`-driven UI already transitions back). Do not build a second parallel state tracker — reuse the existing signal's real transition points.

- [ ] **Step 5: Live verification**

Start the dev server if not already running (`docker compose logs -f api` to confirm it's up, or use the already-running live container). Using Playwright (`browser_navigate` to `http://localhost:3000`, `browser_snapshot`), trigger a real chat send and confirm no console errors appear (`browser_console_messages`) and the page doesn't crash. A full visual "does it look violet during thinking" check is manual/human — Playwright's accessibility snapshot won't show color; note in your report that this specific visual claim needs a human look, don't fabricate a pass.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add listening/thinking orb states, wire real signal sources"
```

---

## Task 2: Heartbeat ping + drifting sparks layered around the orb

**Files:**
- Modify: `src/interaction/static/index.html` (`<style>` block, and the DOM structure around `#quantum-eye`/`#quantum-eye-container`)

**Interfaces:**
- Consumes: Task 1's states (the ping/sparks must recolor based on the current orb state).
- Produces: `.orb-ping`, `.orb-spark` CSS classes and their DOM elements, always-visible (unlike the camera-gated `.orb-ar-frame`).

- [ ] **Step 1: Read the existing `.orb-ar-frame`/`.orb-ar-ring`/`.orb-ar-arc`/`.orb-corner` CSS and their DOM placement (siblings inside `#quantum-eye-container`, gated by `.orb-frame-active`) completely — this is the established pattern to follow, not invent a new one.**

- [ ] **Step 2: Add the ping + spark CSS**, in the same `<style>` block, near the existing orb-related rules:

```css
/* Heartbeat ping + drifting sparks — always visible (unlike .orb-ar-frame,
   which only shows in camera mode), giving the orb a sense of being alive
   even at idle. Recolors based on #quantum-eye-container's data-orb-state
   attribute (set alongside NeuralOrb.setState — see Task 1/2 JS wiring). */
.orb-ping {
    position: absolute;
    inset: -10px;
    border-radius: 50%;
    border: 1px solid rgba(80, 200, 255, 0.5);
    pointer-events: none;
    animation: orb-ping-pulse 3.2s cubic-bezier(0.2, 0.6, 0.4, 1) infinite;
}
.orb-ping.orb-ping-delay {
    animation-delay: 1.6s;
}
@keyframes orb-ping-pulse {
    0% { transform: scale(0.85); opacity: 0.5; }
    100% { transform: scale(1.35); opacity: 0; }
}
#quantum-eye-container[data-orb-state="thinking"] .orb-ping {
    border-color: rgba(180, 130, 255, 0.5);
}

.orb-spark {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: rgba(180, 225, 255, 0.9);
    box-shadow: 0 0 6px rgba(120, 200, 255, 0.9);
    pointer-events: none;
}
.orb-spark.orb-spark-1 { animation: orb-spark-orbit-1 9s linear infinite; }
.orb-spark.orb-spark-2 { animation: orb-spark-orbit-2 7s linear infinite; }
.orb-spark.orb-spark-3 { animation: orb-spark-orbit-3 11s linear infinite; }
@keyframes orb-spark-orbit-1 { from { transform: rotate(0deg) translateX(var(--orb-spark-radius, 60px)) rotate(0deg); } to { transform: rotate(360deg) translateX(var(--orb-spark-radius, 60px)) rotate(-360deg); } }
@keyframes orb-spark-orbit-2 { from { transform: rotate(120deg) translateX(var(--orb-spark-radius, 60px)) rotate(-120deg); } to { transform: rotate(480deg) translateX(var(--orb-spark-radius, 60px)) rotate(-480deg); } }
@keyframes orb-spark-orbit-3 { from { transform: rotate(240deg) translateX(var(--orb-spark-radius, 60px)) rotate(-240deg); } to { transform: rotate(600deg) translateX(var(--orb-spark-radius, 60px)) rotate(-600deg); } }
@media (prefers-reduced-motion: reduce) {
    .orb-ping, .orb-spark { animation: none; opacity: 0; }
}
```

Adjust `--orb-spark-radius` per usage site if the orb's real rendered radius differs meaningfully between the home screen and any other place it's used — check whether `#quantum-eye` is reused elsewhere (grep for `quantum-eye`) before assuming this is the only place these elements get added.

- [ ] **Step 3: Add the DOM elements** as siblings inside `#quantum-eye-container`, alongside the existing `.orb-ar-frame` sibling elements found in Step 1:

```html
<div class="orb-ping"></div>
<div class="orb-ping orb-ping-delay"></div>
<div class="orb-spark orb-spark-1"></div>
<div class="orb-spark orb-spark-2"></div>
<div class="orb-spark orb-spark-3"></div>
```

- [ ] **Step 4: Wire the `data-orb-state` attribute**

`NeuralOrb.setState` already sets `scene.canvas.dataset.orbState = scene.state` on the canvas element itself (confirmed in Task 1's Step 1 read) — but the new CSS above targets `#quantum-eye-container[data-orb-state="..."]`, the *container*, not the canvas, so plain CSS sibling selectors can react without needing `:has()`. Add one line at the same call site(s) `NeuralOrb.setState` is called for the home-screen orb (or inside `updateSensorStatusLabel()`/wherever is the single funnel point — prefer wiring it in one shared place over duplicating it at every call site) to also set `document.getElementById('quantum-eye-container').dataset.orbState = <state>`.

- [ ] **Step 5: Live verification**

Playwright navigate + snapshot to confirm no console errors from the new DOM/CSS. Take a full-page screenshot via `browser_take_screenshot` and note in your report that a human needs to actually look at it for the visual "does it feel alive" claim — do not claim you visually verified something you structurally cannot see the rendered result of.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add always-visible heartbeat ping and drifting sparks around the orb"
```

---

## Task 3: Reveal-on-hover nav (hide sidebar/header/tabs by default)

**Files:**
- Modify: `src/interaction/static/index.html`

- [ ] **Step 1: Read the current sidebar (`<nav>`), header (`<banner>`/stats bar), and their exact DOM structure and existing CSS classes completely.** These are NOT being deleted — only their default visibility changes.

- [ ] **Step 2: Implement the reveal mechanism**

Add a thin (e.g. 8px tall) invisible hover-trigger strip pinned to the very top of the window, and wrap the sidebar/header in a container that's translated off-screen (`transform: translateX(-100%)` for the sidebar, `translateY(-100%)` for the header) by default, sliding into view on `:hover` of the trigger strip OR while the sidebar/header container itself is hovered (so moving the mouse INTO the revealed nav doesn't immediately hide it again). Use a CSS-only `:hover` + `transition` approach if the current layout allows it cleanly; fall back to a small JS mouseenter/mouseleave-with-delay handler only if pure CSS proves awkward given the real existing layout — check the real structure first (Step 1) before deciding which approach fits without a larger restructure.

- [ ] **Step 3: Confirm nothing that currently depends on the sidebar/header being always-rendered (not just always-visible) breaks** — e.g. if any JS reads `getBoundingClientRect()` or similar layout-dependent values from sidebar/header elements assuming they're always in-flow at their normal position, moving them off-screen via `transform` (which doesn't remove them from layout) should be safe, but verify by grepping for `getBoundingClientRect\(\)` calls near sidebar/header-related code.

- [ ] **Step 4: Live verification**

Playwright: navigate, take a snapshot with the mouse not hovering the top edge (confirm sidebar/nav buttons are NOT in the visible accessible tree's expected interactive state — or if `transform` keeps them accessible-tree-present but visually hidden, note that limitation honestly), then simulate a hover near the top edge (`browser_hover` if available, or move mouse via `browser_run_code_unsafe` if needed) and confirm the nav becomes visible.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: hide sidebar/header nav by default, reveal on hovering the top edge"
```

---

## Task 4: Ephemeral conversation card

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: the existing message-send function and reply-received/`speakText`-finished signals (Task 1's Step 1 grep already located these).

- [ ] **Step 1: Read the existing conversation-panel DOM (`Conversation` / `Decision trace` section from the current layout) and the message-send function completely.**

- [ ] **Step 2: Build the new ephemeral card**

Add a new `.orb-convo-card` element (positioned below the orb, using the existing `.holo-panel`/`.glass-panel` class for visual consistency — do not invent new glass-panel CSS, reuse what exists), hidden by default (`opacity: 0`, `pointer-events: none`, a `transition`). On message send: populate it with the user's message + a "..." placeholder for Jarvis's reply, set it visible. On reply received (text arrives and/or `speakText`'s audio finishes — use the real completion signal from Task 1's Step 1 grep of `isSpeakingNow`/`currentAudioEl.onended`): update the card with the real reply text, then after a fixed delay (~4-6s after speaking ends, or immediately after text-only reply has been visible ~6s if TTS is off), fade it back out. Starting a new message before the delay elapses cancels the pending fade-out and immediately shows the new exchange.

- [ ] **Step 3: Confirm the existing full-history "Conversation" panel still exists and still works** — it just isn't part of the default view (it lives behind Task 3's reveal-nav, or wherever else in the restructured layout it now belongs; use your judgment on the cleanest placement given the real resulting layout, and document where you put it in your report).

- [ ] **Step 4: Live verification**

Playwright: navigate, send a real message via the input box, snapshot before/after to confirm the card appears with real content (not a stub), wait, snapshot again to confirm it fades back out. Check console for errors throughout.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add ephemeral conversation card, replacing the persistent chat panel"
```

---

## Task 5: Ambient corner readouts + remove idle quote + orb-dominant hero layout

**Files:**
- Modify: `src/interaction/static/index.html`

- [ ] **Step 1: Read the current hero/home-screen layout (the `#quantum-eye` orb container, the "Sensors standby" text, the idle-quote paragraph, the quick-action buttons, the "ALIGN SYSTEM WITH HUMAN PREFERENCES" progress element) completely.**

- [ ] **Step 2: Remove the idle-quote paragraph** (the element rendering the random out-of-context sentence under "Sensors standby") from the default view. If it's driven by a poller/fetch call that has no other consumer, leave the fetch logic in place (don't break a working feature's data layer) — just stop rendering it into the DOM, and note in your report whether the fetch call becomes fully dead code worth flagging for a future cleanup (don't remove it yourself in this task — out of scope).

- [ ] **Step 3: Resize/reposition the orb to be the hero-scale dominant element** — significantly larger than its current size, centered in the available viewport space, per the approved mockup (the orb takes up most of the vertical space, with the input box below it and the ambient corners at the window's actual corners, not clustered near the orb).

- [ ] **Step 4: Add the three ambient corner readouts**, low-opacity (matching the approved mockup's near-invisible treatment — e.g. `opacity: 0.35-0.45`, small monospace text):
  - Top-left: a live clock (update every second via `setInterval`, format simply e.g. `HH:MM`).
  - Top-right: the existing ONLINE/OFFLINE_MODE indicator's real current value (reuse the existing state/polling logic that already drives the header's current ONLINE/OFFLINE_MODE button — do not add a second parallel poller for the same data).
  - Bottom-left: a pending-items count — aggregate `data.notifications.filter(n => !n.read).length` (the existing unread-notifications computation, Task 1's Step 1 grep already located it) with any `awaiting_consult`-status items from the existing command/build-request polling (reuse the existing `pendingCount`-style computation pattern found near the `command-pending-badge`/`mcp-servers-badge` code) into one combined number, e.g. `"3 pending"`. If reliably combining both sources cleanly proves awkward given the real code shape, using just the unread-notifications count alone is an acceptable, documented simplification — note the deviation in your report rather than forcing a fragile merge.

- [ ] **Step 5: Live verification**

Playwright: navigate, snapshot, confirm the clock/online-state/pending-count elements render with real (not placeholder) values, confirm no console errors, confirm the old idle-quote text is genuinely gone.

- [ ] **Step 6: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: orb-dominant hero layout with ambient corner readouts, remove idle quote widget"
```

---

## Task 6: Rebuild the EWW HUD — orb-only visual, larger size, desktop-layer stacking

**Files:**
- Modify: `config/eww/eww.yuck`
- Modify: `config/eww/eww.scss`

**Interfaces:**
- Consumes: `jarvis_badge` (existing eww var, already pushed by `eww-bridge.ts` — repurposed as the orb-state driver instead of a colored dot).

- [ ] **Step 1: Read the current `eww.yuck`/`eww.scss` completely (already short, ~89 lines total) and confirm exactly which real values `jarvis_badge` takes (grep `eww-bridge.ts`'s `eww update jarvis_badge=...` call sites) before changing the yuck file's variable usage.**

- [ ] **Step 2: Rewrite `eww.yuck`** — remove `jarvis_status`/`jarvis_thought`/`jarvis_task`/`jarvis_notes` widgets and the `hud-header`/`hud-section` structure entirely; replace with a pure orb widget driven by `jarvis_badge`:

```lisp
; config/eww/eww.yuck
;
; Orb-only HUD — no text panel. jarvis_badge (already pushed by
; eww-bridge.ts) drives which orb-state class is applied via badge-class
; below; jarvis_status/jarvis_thought/jarvis_task/jarvis_notes are no
; longer rendered (kept as unused defvars only if eww-bridge.ts still
; pushes them — see Task 7 for whether that plumbing gets simplified too).

(defvar jarvis_badge "idle")

(defwidget orb []
  (box :class "orb-stage"
    (box :class "orb-ping orb-badge-${jarvis_badge}")
    (box :class "orb-ping orb-ping-delay orb-badge-${jarvis_badge}")
    (box :class "orb-core orb-badge-${jarvis_badge}")))

(defwindow jarvis-hud
  :monitor 0
  :geometry (geometry :x "16px" :y "16px" :width "160px" :height "160px" :anchor "top right")
  :stacking "bg"
  :windowtype "dock"
  :wm-ignore false
  (orb))
```

Verify `:stacking "bg"` is a real supported value for the installed eww version before treating this as final — run `eww --version` and check `eww open --help`/eww's own documentation for the actual supported `:stacking` values (`"fg"`/`"bg"` are documented in modern eww, but confirm against what's actually installed rather than assuming). If `"bg"` isn't supported, the fallback is changing `:windowtype` from `"dock"` to `"desktop"`, which achieves the same "not always on top" goal via a different mechanism — pick whichever the installed version actually supports and document which one you used and why in your report.

- [ ] **Step 3: Rewrite `eww.scss`** with the GTK-CSS-compatible orb treatment:

```scss
// config/eww/eww.scss
// Orb-only HUD, GTK-CSS compatible (no conic-gradient, no
// backdrop-filter — both unsupported here, see the design spec's note on
// this). radial-gradient + a scale/opacity breathing animation is the
// closest achievable equivalent to the web orb's richer treatment.
* {
  all: unset;
}

.orb-stage {
  min-width: 160px;
  min-height: 160px;
}

.orb-core {
  min-width: 92px;
  min-height: 92px;
  border-radius: 9999px;
  background-image: radial-gradient(circle at 35% 30%, rgba(160,230,255,0.95), rgba(60,160,255,0.5) 45%, rgba(60,160,255,0.0) 72%);
}

.orb-ping {
  min-width: 92px;
  min-height: 92px;
  border-radius: 9999px;
  border: 1px solid rgba(80,200,255,0.5);
}

.orb-badge-thinking.orb-core {
  background-image: radial-gradient(circle at 35% 30%, rgba(220,190,255,0.95), rgba(150,90,255,0.5) 45%, rgba(150,90,255,0.0) 72%);
}
.orb-badge-thinking.orb-ping {
  border-color: rgba(180,130,255,0.5);
}
.orb-badge-executing.orb-core, .orb-badge-error.orb-core {
  background-image: radial-gradient(circle at 35% 30%, rgba(255,190,190,0.95), rgba(255,90,90,0.5) 45%, rgba(255,90,90,0.0) 72%);
}
```

GTK-CSS's animation support is real but more limited than browser CSS — if `@keyframes`-driven scale/opacity animation on a GTK widget doesn't render smoothly (test this directly, don't assume), a simpler fallback is a static (non-animated) glow that still recolors per `jarvis_badge`, which is a legitimate, documented scope reduction given eww's real constraints — note in your report whether animation worked or you fell back to static.

- [ ] **Step 4: Live verification**

Deploy via `bash scripts/deploy-hud.sh` (as done earlier this session), then check `systemctl --user status jarvis-hud-eww.service` and `journalctl --user -u jarvis-hud-eww.service --since "1 minute ago"` for real errors (not just "it started"). Confirm the window doesn't sit on top of an actively-focused application window (open some other window, check visually or via `wmctrl`/`xdotool` if available whether the HUD is now behind/level with it rather than always in front) — a human visual confirmation of "no longer overlaying on top of everything" is the real bar here, note clearly if you could only partially verify this programmatically.

- [ ] **Step 5: Commit**

```bash
git add config/eww/eww.yuck config/eww/eww.scss
git commit -m "feat: rebuild EWW HUD as an orb-only widget, desktop-layer stacking"
```

---

## Task 7: Final sweep — verify eww-bridge.ts plumbing, full regression check

- [ ] **Step 1: Read `src/ipc/eww-bridge.ts` completely.** Decide whether its `jarvis_status`/`jarvis_thought`/`jarvis_task`/`jarvis_notes` push calls (if they still exist) are now genuinely dead (nothing in the new `eww.yuck` renders them) and worth simplifying, or whether leaving them as harmless unused pushes is fine for now. Per the design spec: "don't do it speculatively" — only simplify the bridge if leaving the dead pushes in creates a real problem (e.g. wasted event-bus traffic, confusing future-maintainer surface); if it's genuinely inert and harmless, leaving it and noting it in your report is acceptable, not everything needs to be trimmed in the same task.

- [ ] **Step 2: Full regression check on the web dashboard.** Run `npx tsc --noEmit` (should be unaffected — no TS files changed by this plan, but confirm) and the full TS suite (`npx tsx --env-file=.env tests/index.test.ts`, exporting standard env vars) to confirm nothing backend-related regressed (this plan touches only frontend files, so the pass count should be identical to the last known state before this plan started — cite that exact baseline count in your report and confirm it matches).

- [ ] **Step 3: Full live walkthrough.** Using Playwright: navigate to the dashboard, verify the orb is now the dominant element, verify nav is hidden until hover, send a real message and verify the ephemeral conversation card behavior, verify the ambient corners show real values, verify no console errors anywhere in the flow. This is the completion gate — a plan this visual is not "done" on `tsc`/test-suite-green alone.

- [ ] **Step 4: EWW final check.** Confirm `jarvis-hud-eww.service`/`jarvis-hud.service` are both active and logging cleanly (no repeating errors) after the Task 6 redeploy.

- [ ] **Step 5: Commit** any final fixes from this sweep, or state plainly in your report if nothing needed fixing.
