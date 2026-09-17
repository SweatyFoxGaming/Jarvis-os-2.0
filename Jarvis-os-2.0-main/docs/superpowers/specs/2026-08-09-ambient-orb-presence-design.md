# Ambient Orb Presence — Design Spec

## Problem

Two of Jarvis's three surfaces don't feel like "Jarvis is here": the EWW desktop HUD is a plain dark text panel (status dot + three labeled sections, no visual identity, currently always-on-top over every window), and the Electron/web dashboard's main screen — despite having genuinely sophisticated CSS underneath (glass-panel language, a live canvas orb, LCARS-derived accents, a KITT-style waveform) — opens into a dense, chrome-heavy layout (persistent sidebar, header stats, a chat panel, quick-action buttons, an idle "quote" widget) that reads as a dashboard, not a presence. Real sci-fi AI interfaces (JARVIS, Samantha, Cortana) share a pattern: an ambient, largely wordless visual core that conveys state through motion and color, with everything else hidden until actually needed.

## Goal

Make the orb the dominant, near-only visual element on both surfaces, conveying state (idle/listening/thinking/speaking) primarily through color and motion rather than text or persistent panels, with all secondary UI (settings, nav, conversation history) hidden by default and revealed only on deliberate interaction.

## Scope

Two independent surfaces, same visual language, different implementation constraints:
1. **Electron/web dashboard** (`src/interaction/static/index.html`) — main screen restructure.
2. **EWW desktop HUD** (`config/eww/eww.yuck`, `config/eww/eww.scss`, `deploy/jarvis-hud-eww.service`) — visual rebuild + a real window-behavior change.

Out of scope: the Electron app's other screens (tray menu, settings panel contents themselves — only their *visibility* changes, not their internals), any change to the actual STT/TTS/voice-daemon pipeline, any change to `desktop-electron/main.js`'s server-connection logic beyond what's needed to load the new screen.

## Design, confirmed via visual review

### 1. Orb visual language (shared by both surfaces)

The orb is not a static glow — it has visible internal motion at all times:
- Two counter-rotating internal gradients (one radial "core" glow, one conic "energy sweep") plus a slow hue drift, so it reads as something churning inside rather than a flat painted circle.
- A soft "ping" ring expanding outward and fading every ~1.6s even at idle (staggered second ping for continuous rhythm) — a heartbeat, so it's never perfectly still even doing nothing.
- 2-3 small sparks drifting in independent slow circular orbits around the orb.
- A thin dashed ring (idle) tightening into a faster solid arc during active states.

Four states, each with a genuinely different rhythm/color, not just "the same animation faster":

| State | Ring/arc speed | Core animation speed | Color shift | Status word (web only) |
|---|---|---|---|---|
| `idle` | slow (8s), low opacity | slow (3.2s breathe / 9s hue) | baseline cyan-blue | none |
| `listening` | fast (1.4s) | faster (1.1s / 3s), brighter glow | baseline cyan-blue, brighter | "Listening" |
| `thinking` | fastest (0.9s) | baseline speed | shifts toward violet (core gradient + ping ring recolor) | "Thinking" |
| `speaking` | fastest (0.6s) | fastest (0.5s / 2s) | baseline cyan-blue, brightest | "Speaking" |

This is a real extension of the existing `NeuralOrb` canvas system (`src/interaction/static/index.html`, `STATE_CONFIG` object and `setState(scene, state)`), which currently only has `idle` / `active` / `speaking` entries. Add `listening` and `thinking` entries; `active` stays for camera-sensor-active framing (the existing AR-ring/corner-bracket treatment), which is orthogonal to this state machine, not replaced by it.

**State wiring — real signals, not new ones invented:**
- `speaking`: already tracked via `isSpeakingNow` (set in `speakText()`/its sibling around line 1844-1889).
- `listening`: wire to real mic-active moments — `SpeechRecognition.onstart`/`onend` for the browser-recognition path, or the recording-indicator state for the `/api/voice-input` recorded-clip path (both already exist per the click-to-talk fallback built in `whisper.ts`/`tts.ts`'s Task 7/8 work).
- `thinking`: wire to the existing in-flight-request tracking (the codebase already has an `isThinking`/`status` concept around line 1956-1973 — reuse that signal to also drive `NeuralOrb.setState(scene, 'thinking')`, don't build a second parallel state tracker).

### 2. Electron/web dashboard main screen

- Sidebar, header stats (CPU/Memory/Latency/ONLINE-OFFLINE toggle/Sleep), the six nav tabs (Home/Projects/Vault/Calendar/Knowledge/Operations/Settings), and the admin-panel link are all removed from the *default* view — not deleted, moved behind a reveal gesture: **hovering the top edge of the window** briefly reveals a thin nav strip; moving the pointer away lets it recede. (If this trigger feels wrong once built, it's a small, isolated change — not load-bearing for anything else in this spec.)
- Default view: the orb, centered, large (hero-scale — the current `#quantum-eye`/`.hologram-float` orb container, resized and repositioned to dominate the screen rather than sitting as one element among several), plus a single minimal text input pinned near the bottom (`Ask Jarvis anything...`), low-opacity until focused.
- Three near-invisible corner readouts, low-opacity (matching the "C" mockup): clock (top-left), connection state — reusing the existing ONLINE/OFFLINE_MODE indicator's real value, not a new signal (top-right), and a pending-items count (bottom-left) — aggregate real existing signals: unread notifications (`data.notifications.filter(n => !n.read)`, already computed around line 2934) + any `awaiting_consult`-status build requests (the badge concept already exists around line 2485/2961 for a different UI, reuse the same status check).
- **Conversation card**: new component. On sending a message, the orb shrinks slightly and drifts up; a glass card (matching the existing `.holo-panel`/`.glass-panel` treatment) fades in below it showing the current exchange (your message + Jarvis's reply) only — not a scrolling history. It dissolves a few seconds after Jarvis's reply finishes (speaking audio ends, or text-only reply has been visible for a fixed delay), or immediately if a new message is sent before it dissolves. The full conversation history still exists in the data layer (session/Postgres, unaffected by this spec) — only its *default visibility* changes; the reveal gesture's nav strip can still open a real "Conversation" view showing full history for anyone who wants it.
- The existing idle "quote" widget (the random out-of-context sentence currently shown under "Sensors standby") is removed from the default view — it undercuts the "ambient presence" feel and doesn't fit anywhere in the new minimal layout. (If there's a real feature intent behind it — e.g. it was meant to surface autonomous-objective progress — that intent isn't lost, it just doesn't belong on the default screen; flag during implementation if this turns out to be load-bearing for something else.)

### 3. EWW desktop HUD

- Visual: the orb only (no `hud-status`/`hud-thought`/`hud-task`/`hud-note` text sections at all) — a simplified sibling of the web orb, since GTK-CSS (what eww's SCSS compiles to) doesn't support `conic-gradient` or `backdrop-filter`. Achievable in GTK-CSS: `radial-gradient` core glow, the breathing scale animation, a second growing/fading circle for the heartbeat ping. Not achievable 1:1: the counter-rotating conic energy-sweep layer and the glass blur — approximate with a secondary radial-gradient layer at a different animation phase instead, close enough to read as the same design language.
- Size: larger than today's implicit footprint — a genuine desktop presence (~140-160px, up from the current 280×280 *window* which was mostly empty padding around a small text panel — the orb itself should now fill most of that space).
- **Window behavior change**: `:stacking "fg"` (today — always-on-top over every window) → `:stacking "bg"` (desktop layer — sits with/below regular windows, never blocks what you're actually working in). Verify eww's real supported `:stacking` values for the installed version before assuming `"bg"` is exactly right — if it isn't, the closest equivalent (e.g. `:windowtype "desktop"` instead of `"dock"`) achieves the same "not overlaying on top of everything" goal.
- `jarvis_badge`/`jarvis_status`/`jarvis_thought`/`jarvis_task`/`jarvis_notes` — the existing eww vars driven by `eww-bridge.ts` — get consolidated down to whatever's needed to drive the orb's state (badge/status effectively become the orb's color-state; thought/task/notes are dropped from the visual entirely, matching "no text ever" from the visual review). `eww-bridge.ts`'s event-bus subscriptions can stay as-is if they still map cleanly to an orb-state derivation; only the *rendering* (yuck/scss) needs to change, not necessarily the bridge's data plumbing — confirm during implementation whether any bridge-side simplification is also warranted, but don't do it speculatively.

## Testing approach

This is almost entirely CSS/animation/layout work with no meaningful unit-testable logic beyond the state-mapping functions (`NeuralOrb.setState` call sites, the reveal-gesture trigger, the conversation-card show/dissolve timing). Verification is real, not fabricated:
- For the state-wiring logic itself (which real signal drives which orb state): can be tested via existing patterns in this codebase's test suite if the mapping is extracted into a plain function; if it's inline DOM-manipulation glue (matching this file's existing style), verify via a live browser check (Playwright navigate + snapshot, as already used earlier in this session) rather than forcing an awkward unit test.
- For the EWW side: a live `eww open jarvis-hud` check plus `systemctl --user status`/`journalctl` log check (as already done earlier this session) — eww has no automated test harness in this codebase.
- No automated test can verify "does it look alive" — that's confirmed by the human, same as the visual-review process that produced this spec.

## Explicitly deferred / not in scope

- Redesigning the settings/nav screens' own internal content (only their visibility changes).
- Any change to voice-daemon/STT/TTS behavior.
- Porting the EWW orb to be pixel-identical to the web orb (explicitly accepted as a simplified sibling, per the GTK-CSS constraint above).
- Making the "reveal gesture" configurable/multiple options — one default (hover top edge) ships; revisit only if it feels wrong in practice.
