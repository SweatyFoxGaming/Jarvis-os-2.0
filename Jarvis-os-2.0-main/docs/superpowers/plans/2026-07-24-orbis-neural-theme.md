# Orbis-Inspired Neural Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Jarvis dashboard to the Orbis reference's deep-navy/cyan/pink frosted-glass look, and replace the current static "presence orb" with a rotating neural-sphere visualization — an ambient decorative version behind every tab, and a bright, state-reactive, click-to-open-your-vault version on the Home tab.

**Architecture:** A palette swap in `tailwind.index.config.js` (zero markup changes, every panel already uses these tokens) plus a re-themed `.holo-panel`/`.glass-panel` CSS block; a single shared canvas-2D "neural orb" renderer module ported directly from the Orbis reference file's own `brainPoints`/`proj`/`drawScene` functions, instantiated twice (ambient background, focal Home orb) under one `requestAnimationFrame` loop; a new backend route bulk-fetching the vault's notes+links so the focal orb can place real notes as points and real backlinks as connections; click-to-open wiring reusing the existing Vault panel's `openVaultNote`.

**Tech Stack:** Vanilla JS + Canvas 2D (no new frontend dependency — WebGL/`three.js` was explicitly ruled out, see spec), Tailwind (precompiled, no CDN/JIT), Express (`src/server.ts`), `src/kernel/state/vault-repo.ts`.

## Global Constraints

- No new frontend dependency — Canvas 2D only, ported from the Orbis reference's own math. WebGL/`three.js` was explicitly considered and rejected because this codebase's Electron desktop app disables GPU hardware acceleration after a real prior crash (`7c1f40a`) on this hardware.
- `success`/`warning`/`danger` colors are unchanged — only `bg`/`surface`/`card`/`primary`/`accent`/`secondary` shift, plus one new `glow` (pink) token.
- The ambient background orb is always decorative and non-interactive — it is never data-bound and never gets a click handler. Only the focal Home orb is vault-data-bound.
- Both orb canvases are driven by exactly one shared `requestAnimationFrame` loop, not two independent loops.
- Both orbs pause (skip drawing) when the existing `sleepModeActive` flag is true, or when `document.hidden` is true.
- Neuron counts are fixed constants, never scaled to viewport size.
- The vault graph endpoint caps notes at the 150 most-recently-synced — both to bound the visualization and to bound query cost.
- No hover tooltips/previews on note-points, and no real-time/push updates to the graph — data loads once when the Home tab becomes active, matching the existing load-on-tab-entry pattern already used for the Vault and Projects panels.
- `npm test` (`tsx tests/index.test.ts`) and `npx tsc --noEmit` must stay green after every task.
- Path identifiers for vault notes travel as they already do in the existing Vault panel (query parameter / JS string, never a route segment) — this plan does not change that contract.

---

### Task 1: Palette swap

**Files:**
- Modify: `tailwind.index.config.js`
- Modify: `src/interaction/static/index.html:31-42` (`.glass-panel`/`.holo-panel`, `.holo-lift:hover`), `:59-67` (`.holo-divider`, `.holo-text-glow`)
- Modify: `src/interaction/static/css/tailwind-index.css` (regenerated, not hand-edited)

**Interfaces:**
- Produces: new Tailwind color tokens `bg`, `surface`, `card`, `primary`, `accent`, `secondary` (updated values) and `glow` (new) — consumed directly by existing utility classes throughout `index.html` (`bg-bg`, `text-secondary`, `border-primary`, `bg-primary`, etc.) with zero markup changes, and by Task 3's orb-core color choices.

This task only touches color values and generated CSS — no HTML structure changes yet (the `.glow-accent` blobs are removed in Task 2, alongside the canvas that replaces their role).

- [ ] **Step 1: Update the Tailwind color tokens**

Read the current file first, then replace the `colors` block in `tailwind.index.config.js`:

```js
module.exports = {
  content: ["./src/interaction/static/index.html"],
  theme: {
    extend: {
      colors: {
        bg: '#01040c',
        surface: '#050b18',
        card: '#0b1830',
        glass: '#0d0f15',
        primary: '#50D2FF',
        accent: '#50D2FF',
        glow: '#FF78DC',
        success: '#5FBF8F',
        warning: '#D9A85C',
        danger: '#D97A7A',
        text: '#EDEFF3',
        secondary: '#7fa8cc',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
};
```

- [ ] **Step 2: Re-theme the panel CSS in `index.html`**

In `src/interaction/static/index.html`, replace this block (currently lines 27-42):

```css
        /* Calm panel language — a quiet, flat card instead of the previous
           heavy-blur holographic glass. Class names kept as-is (.holo-panel
           etc. are used throughout this file) so every existing panel picks
           up the new look automatically without a markup rewrite. */
        .glass-panel, .holo-panel {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.06);
            box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02) inset, 0 8px 24px rgba(0, 0, 0, 0.35);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s ease, background 0.3s ease;
        }

        .holo-lift:hover {
            transform: translateY(-2px);
            border-color: rgba(143, 184, 232, 0.22);
            background: rgba(255, 255, 255, 0.03);
        }
```

with:

```css
        /* Frosted-glass panel language, restored on purpose — see
           docs/superpowers/specs/2026-07-24-orbis-neural-theme-design.md.
           Class names kept as-is (.holo-panel etc. are used throughout this
           file) so every existing panel picks up the new look automatically
           without a markup rewrite. */
        .glass-panel, .holo-panel {
            background: linear-gradient(180deg, rgba(11, 24, 48, 0.55), rgba(5, 11, 24, 0.55));
            border: 1px solid rgba(80, 200, 255, 0.28);
            backdrop-filter: blur(14px);
            box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 24px rgba(50, 150, 255, 0.05);
            transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s ease, background 0.3s ease;
        }

        .holo-lift:hover {
            transform: translateY(-2px);
            border-color: rgba(80, 200, 255, 0.45);
            background: linear-gradient(180deg, rgba(14, 30, 58, 0.6), rgba(6, 14, 30, 0.6));
        }
```

Then replace this block (currently lines 58-67):

```css
        /* Faint luminous rule used in place of a solid divider inside panels. */
        .holo-divider {
            border-color: transparent;
            background-image: linear-gradient(to right, transparent, rgba(143, 184, 232, 0.16), transparent);
            height: 1px;
        }

        .holo-text-glow {
            text-shadow: 0 0 16px rgba(143, 184, 232, 0.35);
        }
```

with:

```css
        /* Faint luminous rule used in place of a solid divider inside panels. */
        .holo-divider {
            border-color: transparent;
            background-image: linear-gradient(to right, transparent, rgba(80, 200, 255, 0.3), transparent);
            height: 1px;
        }

        .holo-text-glow {
            text-shadow: 0 0 16px rgba(80, 200, 255, 0.45);
        }
```

Leave `@keyframes drift`, `.glow-accent`, `@keyframes hologram-float`/`.hologram-float`, the presence-orb block (`@keyframes orb-breathe`/`.jarvis-orb`), and `#mind-graph` untouched for now — Tasks 2 and 3 handle those.

- [ ] **Step 3: Rebuild the precompiled CSS**

Run: `npm run build:css`
Expected: exits 0, regenerates `src/interaction/static/css/tailwind-index.css` (and the admin build) with no errors.

- [ ] **Step 4: Run the test suite and typecheck**

Run: `npm test`
Expected: unchanged pass count (this task touches no `.ts` file).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify the new palette renders**

With the stack running (or a local `npm start` against a scratch Postgres, same pattern as the Vault panel's own manual verification), load the dashboard and confirm via browser devtools or a quick `getComputedStyle` check that `.holo-panel` now renders the navy/cyan frosted-glass look, not the old flat gray. A background color spot-check is enough here — Task 2's full visual pass covers the rest.

- [ ] **Step 6: Commit**

```bash
git add tailwind.index.config.js src/interaction/static/index.html src/interaction/static/css/tailwind-index.css src/interaction/static/css/tailwind-admin.css
git commit -m "feat: swap dashboard palette to Orbis-inspired navy/cyan/pink"
```

---

### Task 2: Shared neural-orb renderer + ambient background canvas

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Produces: a global `NeuralOrb` object with `NeuralOrb.register(canvas, opts)`, `NeuralOrb.setState(scene, state)`, `NeuralOrb.setNeurons(scene, neurons, links)`, `NeuralOrb.hitTest(scene, clientX, clientY)`, `NeuralOrb.randomNeurons(count)`, `NeuralOrb.fibonacciSpherePoint(i, n)`, `NeuralOrb.hashString(str)` — Task 3 registers the focal Home scene with this, Task 5 calls `setNeurons`/`hitTest`/`fibonacciSpherePoint`/`hashString` on it.
- Consumes: the existing `sleepModeActive` variable (declared later in the same script, at `triggerLocalSleep`'s definition — safe to reference before its textual declaration since the reference only happens inside an async `frame()` callback that runs after the whole script has finished its first synchronous pass).

This task adds the renderer and the ambient (non-interactive, non-data-bound) background instance only. The `.glow-accent` blobs it replaces are removed here, in the same task that introduces their replacement.

- [ ] **Step 1: Remove the two `.glow-accent` divs and their CSS**

In `src/interaction/static/index.html`, remove these two lines (currently around line 111-112, right after the `<body ...>` opening tag):

```html
<div class="absolute top-24 left-1/4 glow-accent"></div>
<div class="absolute bottom-12 right-1/4 glow-accent"></div>
```

And remove this CSS block from the `<style>` section (currently lines 44-56):

```css
        @keyframes drift {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(2%, -3%) scale(1.03); }
        }
        .glow-accent {
            position: absolute;
            width: 520px;
            height: 520px;
            background: radial-gradient(circle, rgba(143, 184, 232, 0.05) 0%, transparent 65%);
            pointer-events: none;
            filter: blur(70px);
            animation: drift 26s ease-in-out infinite;
        }
```

- [ ] **Step 2: Add the ambient background canvas to the body**

In `src/interaction/static/index.html`, right where the two removed `<div class="glow-accent">` lines were (immediately after `<body ...>`, before `<div id="app" ...>`), add:

```html
<canvas id="neural-bg-canvas" class="fixed inset-0 w-full h-full" style="z-index: 0; pointer-events: none;"></canvas>
```

- [ ] **Step 3: Add the `NeuralOrb` module**

In `src/interaction/static/index.html`, inside the main `<script>` block, right after `let cy;` (currently line 706), add:

```javascript

    // ---------- Neural Orb (ambient background + focal Home orb) ----------
    // Ported from the Orbis theme reference the user shared
    // (orbis-s25-theme-preview.html) — a rotating wireframe sphere of
    // particle "neurons" with a pink core glow. Both canvases this drives
    // share ONE requestAnimationFrame loop (matching the reference file's
    // own multi-canvas architecture), not two independent timers.
    // See docs/superpowers/specs/2026-07-24-orbis-neural-theme-design.md.
    const NeuralOrb = (() => {
        // Small, dependency-free string hash (FNV-1a) — used to give a
        // vault note a stable, deterministic sphere slot derived from its
        // path, so it doesn't jump to a new position every time the graph
        // reloads.
        function hashString(str) {
            let h = 2166136261;
            for (let i = 0; i < str.length; i++) {
                h ^= str.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return h >>> 0;
        }

        // Evenly-spaced points on a unit sphere via a fibonacci lattice.
        function fibonacciSpherePoint(i, n) {
            const offset = 2 / n;
            const increment = Math.PI * (3 - Math.sqrt(5));
            const y = ((i * offset) - 1) + (offset / 2);
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const phi = (i % n) * increment;
            return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r };
        }

        function randomNeurons(count) {
            const pts = [];
            for (let i = 0; i < count; i++) {
                const { x, y, z } = fibonacciSpherePoint(i + Math.random(), count);
                pts.push({ x, y, z, ph: Math.random() * 6.28, sp: 0.5 + Math.random() * 1.5, note: null });
            }
            return pts;
        }

        function project(x, y, z, rot, cx, cy, R) {
            const cr = Math.cos(rot), sr = Math.sin(rot);
            const X = x * cr - z * sr, Z = x * sr + z * cr;
            const Y = y * Math.cos(0.3) - Z * Math.sin(0.3);
            return [cx + X * R, cy + Y * R, (Z + 1.6) / 3.2];
        }

        const STATE_CONFIG = {
            idle: { speed: 0.2, pinkMix: 0.35, brightness: 1 },
            active: { speed: 0.32, pinkMix: 0.55, brightness: 1.25 },
            speaking: { speed: 0.5, pinkMix: 0.85, brightness: 1.6 },
        };

        const scenes = [];
        let t = 0;
        let last = null;

        function shouldPause() {
            return (typeof sleepModeActive !== "undefined" && sleepModeActive) || document.hidden;
        }

        function draw(scene, dt) {
            const c = scene.canvas;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            if (Math.round(c.width) !== Math.round(c.clientWidth * dpr)) {
                c.width = c.clientWidth * dpr;
                c.height = c.clientHeight * dpr;
                scene.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
            const g = scene.ctx, W = c.clientWidth, H = c.clientHeight;
            const cfg = STATE_CONFIG[scene.state] || STATE_CONFIG.idle;
            scene.rot += dt * cfg.speed;
            const cx = W / 2, cy = H * scene.cy, R = Math.min(W, H) * scene.R;
            const dim = scene.dim * cfg.brightness;

            const bg = g.createLinearGradient(0, 0, 0, H);
            bg.addColorStop(0, "#020714"); bg.addColorStop(0.45, "#071328"); bg.addColorStop(1, "#01040c");
            g.fillStyle = bg; g.fillRect(0, 0, W, H);

            const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.7);
            glow.addColorStop(0.4, `rgba(30,100,220,${0.22 * dim})`); glow.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, R * 1.7, 0, 6.29); g.fill();

            g.strokeStyle = `rgba(90,190,255,${0.2 * dim})`; g.lineWidth = 1;
            for (const lat of [-60, -30, 0, 30, 60]) {
                const la = lat * Math.PI / 180, r = Math.cos(la), y = Math.sin(la);
                g.beginPath();
                for (let k = 0; k <= 40; k++) {
                    const a = 6.283 * k / 40;
                    const [x, yy] = project(r * Math.cos(a), y, r * Math.sin(a), scene.rot, cx, cy, R);
                    k ? g.lineTo(x, yy) : g.moveTo(x, yy);
                }
                g.stroke();
            }

            const corePink = 0.3 + cfg.pinkMix * 0.5;
            const core = g.createRadialGradient(cx, cy - R * 0.06, 0, cx, cy - R * 0.06, R * 0.5);
            core.addColorStop(0, `rgba(255,120,220,${corePink * dim})`); core.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = core; g.beginPath(); g.arc(cx, cy - R * 0.06, R * 0.5, 0, 6.29); g.fill();

            scene.projected = [];
            for (const n of scene.neurons) {
                const [x, y, d] = project(n.x, n.y, n.z, scene.rot, cx, cy, R * 0.98);
                const fire = 0.5 + 0.5 * Math.sin(t * n.sp + n.ph);
                const sz = (0.5 + 1.6 * d) * (1 + 0.6 * fire);
                g.fillStyle = n.note
                    ? `rgba(255,140,225,${(80 + 160 * d) / 255 * dim})`
                    : `rgba(110,215,255,${(60 + 180 * d) / 255 * dim})`;
                g.beginPath(); g.arc(x, y, sz, 0, 6.29); g.fill();
                if (n.note) scene.projected.push({ x, y, note: n.note });
            }

            if (scene.links.length) {
                g.strokeStyle = `rgba(255,150,220,${0.3 * dim})`;
                g.lineWidth = 1;
                for (const [a, b] of scene.links) {
                    const [ax, ay] = project(a.x, a.y, a.z, scene.rot, cx, cy, R * 0.98);
                    const [bx, by] = project(b.x, b.y, b.z, scene.rot, cx, cy, R * 0.98);
                    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
                }
            }
        }

        function frame(now) {
            if (last === null) last = now;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            if (!shouldPause()) {
                t += dt;
                scenes.forEach(s => draw(s, dt));
            }
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        function register(canvas, opts) {
            const scene = {
                canvas,
                ctx: canvas.getContext("2d"),
                rot: Math.random() * 6,
                neurons: randomNeurons(opts.neuronCount),
                links: [],
                dim: opts.dim,
                R: opts.R,
                cy: opts.cy,
                state: "idle",
                projected: [],
            };
            scenes.push(scene);
            return scene;
        }

        function setState(scene, state) {
            scene.state = STATE_CONFIG[state] ? state : "idle";
            scene.canvas.dataset.orbState = scene.state;
        }

        function setNeurons(scene, neurons, links) {
            scene.neurons = neurons;
            scene.links = links || [];
        }

        function hitTest(scene, clientX, clientY) {
            const rect = scene.canvas.getBoundingClientRect();
            const x = clientX - rect.left, y = clientY - rect.top;
            let closest = null, closestDist = 16;
            for (const p of scene.projected) {
                const dist = Math.hypot(p.x - x, p.y - y);
                if (dist < closestDist) { closest = p.note; closestDist = dist; }
            }
            return closest;
        }

        return { register, setState, setNeurons, hitTest, randomNeurons, fibonacciSpherePoint, hashString };
    })();
```

- [ ] **Step 4: Register the ambient background scene**

In `src/interaction/static/index.html`, inside the `window.addEventListener('DOMContentLoaded', () => { ... })` handler (currently starting at line 3733), as the first line in the callback (right before `initCytoscape();`), add:

```javascript
        NeuralOrb.register(document.getElementById('neural-bg-canvas'), { neuronCount: 300, dim: 0.35, R: 0.42, cy: 0.5 });
```

- [ ] **Step 5: Run the test suite and typecheck**

Run: `npm test`
Expected: unchanged pass count (this task touches no `.ts` file).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manually verify the ambient orb**

With the stack running:
1. Load the dashboard — confirm a dim, slowly rotating wireframe sphere with cyan neuron points and a soft pink core glow is visible behind the panels on Home.
2. Switch to another tab (e.g. Vault, Projects) — confirm the same background sphere is still visible and still rotating behind that tab's panels too (proving it persists across tab switches, not recreated per view).
3. Click "CORES_SLEEP" in the header — capture two screenshots ~1s apart and confirm the sphere's rotation has stopped (frozen, not advancing). Click "CORES_WAKE" — confirm it resumes rotating.

- [ ] **Step 7: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: add the shared neural-orb renderer + ambient background canvas"
```

---

### Task 3: Focal Home orb — replace the presence orb, add state reactivity, remove the legacy eye behaviors

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: `NeuralOrb.register`, `NeuralOrb.setState`, `NeuralOrb.hitTest` (from Task 2).
- Produces: a top-level `focalOrbScene` variable and an `openVaultNoteFromOrb(path)` function — Task 5 calls `NeuralOrb.setNeurons(focalOrbScene, ...)` to populate it with real vault data; `openVaultNoteFromOrb` is fully wired here but stays unreachable (no neuron ever has `.note` set) until Task 5 populates real note data.

The existing `#quantum-eye` "eye" metaphor (cursor-tracking iris, random blink) doesn't fit a neural-sphere visual and is removed as part of swapping what's rendered inside the same container — this is a direct, necessary consequence of this task, not unrelated cleanup. The container IDs themselves (`quantum-eye`, `quantum-eye-container`, `eye-camera`) are kept as-is, matching this codebase's established convention of keeping element IDs stable while swapping what's rendered inside them (see the "Calm panel language" precedent already in this file).

- [ ] **Step 1: Add the focal canvas inside `#quantum-eye`, before the camera video**

In `src/interaction/static/index.html`, this block currently reads (around line 232-236):

```html
                    <div class="relative w-40 h-40 flex items-center justify-center" id="quantum-eye-container">
                        <div id="quantum-eye" class="jarvis-orb relative w-full h-full flex items-center justify-center overflow-hidden">
                            <video id="eye-camera" autoplay muted playsinline class="hidden absolute inset-0 w-full h-full object-cover rounded-full opacity-70 pointer-events-none scale-110"></video>
                            <div id="quantum-iris" class="relative w-3 h-3 rounded-full bg-primary/70 transition-transform duration-150 ease-out z-10" id="quantum-iris"></div>
                        </div>
                    </div>
```

Replace it with:

```html
                    <div class="relative w-40 h-40 flex items-center justify-center" id="quantum-eye-container">
                        <div id="quantum-eye" class="jarvis-orb relative w-full h-full flex items-center justify-center overflow-hidden cursor-pointer">
                            <canvas id="quantum-eye-canvas" class="absolute inset-0 w-full h-full"></canvas>
                            <video id="eye-camera" autoplay muted playsinline class="hidden absolute inset-0 w-full h-full object-cover rounded-full opacity-70 pointer-events-none scale-110"></video>
                        </div>
                    </div>
```

(This removes `#quantum-iris` — its cursor-tracking behavior is removed in Step 3 below.)

- [ ] **Step 2: Re-theme `.jarvis-orb` — shape only, canvas now supplies the glow**

In `src/interaction/static/index.html`, this block currently reads (around lines 84-103):

```css
        /* The presence orb — the app's one focal visual, replacing the old
           "quantum eye". A slow breathing glow reads as alive/idle without
           being distracting; active/speaking states are driven by adding
           .orb-active (see updateSensorStatusLabel / speakText) rather than
           a separate element, so there's only ever one orb to keep in sync. */
        @keyframes orb-breathe {
            0%, 100% { box-shadow: 0 0 40px 6px rgba(143, 184, 232, 0.18), inset 0 0 30px rgba(143, 184, 232, 0.08); }
            50% { box-shadow: 0 0 60px 10px rgba(143, 184, 232, 0.28), inset 0 0 40px rgba(143, 184, 232, 0.14); }
        }
        .jarvis-orb {
            border-radius: 9999px;
            border: 1.5px solid rgba(143, 184, 232, 0.55);
            background: radial-gradient(circle at 50% 40%, rgba(143, 184, 232, 0.08), rgba(5, 6, 8, 0.9) 70%);
            animation: orb-breathe 5s ease-in-out infinite;
            transition: border-color 0.4s ease;
        }
        .jarvis-orb.orb-active {
            border-color: rgba(143, 184, 232, 0.9);
            animation: orb-breathe 1.6s ease-in-out infinite;
        }
```

Replace it with:

```css
        /* The presence orb — the app's one focal visual. Now a live canvas
           (see NeuralOrb / focalOrbScene) supplies the glow and motion;
           this class only supplies the circular shape and a reactive
           border tint (see updateSensorStatusLabel / speakText for what
           drives .orb-active). */
        .jarvis-orb {
            border-radius: 9999px;
            border: 1.5px solid rgba(80, 200, 255, 0.55);
            transition: border-color 0.4s ease;
        }
        .jarvis-orb.orb-active {
            border-color: rgba(255, 120, 220, 0.75);
        }
```

- [ ] **Step 3: Remove the cursor-tracking iris and random-blink behaviors**

In `src/interaction/static/index.html`, remove this entire block (currently around lines 1862-1896):

```javascript
    // 3. CURSOR-TRACKING QUANTUM EYE & SPECTRUM
    document.addEventListener('mousemove', (e) => {
        if (cameraStream && cameraTrackerActive) return;
        const eyeContainer = document.getElementById('quantum-eye-container');
        if (!eyeContainer) return;
        const rect = eyeContainer.getBoundingClientRect();
        const eyeX = rect.left + rect.width / 2;
        const eyeY = rect.top + rect.height / 2;
        
        const deltaX = e.clientX - eyeX;
        const deltaY = e.clientY - eyeY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        
        const maxMove = 7; 
        const angle = Math.atan2(deltaY, deltaX);
        const moveX = Math.min(maxMove, distance / 22) * Math.cos(angle);
        const moveY = Math.min(maxMove, distance / 22) * Math.sin(angle);
        
        const iris = document.getElementById('quantum-iris');
        if (iris) {
            iris.style.transform = `translate(${moveX}px, ${moveY}px)`;
        }
    });

    function randomBlink() {
        const eye = document.getElementById('quantum-eye');
        if (eye) {
            eye.style.transform = 'scaleY(0.03)';
            setTimeout(() => {
                eye.style.transform = 'scaleY(1)';
            }, 140);
        }
        setTimeout(randomBlink, 4500 + Math.random() * 5000);
    }
    setTimeout(randomBlink, 3000);
```

Replace it with the focal scene registration and its click handler:

```javascript
    // ---------- Focal Home orb: registration, click-to-open, state wiring ----------
    const focalOrbScene = NeuralOrb.register(document.getElementById('quantum-eye-canvas'), { neuronCount: 420, dim: 1, R: 0.9, cy: 0.5 });

    // Reusable: opens a specific vault note from an orb click. Unreachable
    // until Task 5 populates focalOrbScene's neurons with real notes (no
    // neuron has `.note` set before then), but fully correct and wired now.
    function openVaultNoteFromOrb(path) {
        switchTab('vault');
        openVaultNote(encodeURIComponent(path));
    }

    document.getElementById('quantum-eye').addEventListener('click', (e) => {
        const note = NeuralOrb.hitTest(focalOrbScene, e.clientX, e.clientY);
        if (note) {
            openVaultNoteFromOrb(note);
        } else {
            switchTab('vault');
        }
    });
```

- [ ] **Step 4: Remove the remaining iris references — real camera motion-tracking still moved it too**

`#quantum-iris` had two more consumers beyond the mousemove listener removed in Step 3: `stopCameraMotionTracking()` (resets the iris position) and `trackMotionFrame()` (the *real* camera-frame motion-diff tracker — not the cosmetic mousemove one — moves the iris toward detected motion). Both are otherwise-harmless-but-now-dead once the element is gone (each is `if (iris) {...}`-guarded), but leaving them is dead code this task directly causes, not unrelated cleanup.

In `src/interaction/static/index.html`, this function currently reads (around lines 1015-1022):

```javascript
    function stopCameraMotionTracking() {
        cameraTrackerActive = false;
        prevFrameData = null;
        const iris = document.getElementById('quantum-iris');
        if (iris) {
            iris.style.transform = 'translate(0px, 0px)';
        }
    }
```

Replace it with:

```javascript
    function stopCameraMotionTracking() {
        cameraTrackerActive = false;
        prevFrameData = null;
    }
```

Next, in `trackMotionFrame()`, this block currently reads (around lines 1502-1519 — keep `maybeSendAmbientNudge(count);`, remove only the `if (count > 8) { ... }` block after it, which exists solely to move the now-removed iris):

```javascript
                    maybeSendAmbientNudge(count);

                    if (count > 8) {
                        const avgX = sumX / count;
                        const avgY = sumY / count;

                        // Mirrored map to translation coordinate space (-12px to 12px range)
                        const targetX = -((avgX / 32) * 24 - 12);
                        const targetY = ((avgY / 32) * 24 - 12);

                        trackingLerpX += (targetX - trackingLerpX) * 0.12;
                        trackingLerpY += (targetY - trackingLerpY) * 0.12;

                        const iris = document.getElementById('quantum-iris');
                        if (iris) {
                            iris.style.transform = `translate(${trackingLerpX}px, ${trackingLerpY}px)`;
                        }
                    }
```

Replace it with just:

```javascript
                    maybeSendAmbientNudge(count);
```

Finally, remove the now-unused lerp state — `trackingLerpX`/`trackingLerpY` had no other consumer besides the block just removed. This currently reads (around lines 846-848):

```javascript
    let cameraTrackerActive = false;
    let trackingLerpX = 0;
    let trackingLerpY = 0;
```

Replace it with:

```javascript
    let cameraTrackerActive = false;
```

- [ ] **Step 5: Wire state reactivity into `updateSensorStatusLabel`**

In `src/interaction/static/index.html`, this function currently reads (lines 895-910):

```javascript
    function updateSensorStatusLabel() {
        const label = document.getElementById('sensor-status-label');
        const orb = document.getElementById('quantum-eye');
        let active = [];
        if (cameraStream) active.push("sight");
        if (micEnabled) active.push("hearing");
        if (speechEnabled) active.push("voice");

        if (active.length > 0) {
            if (label) { label.textContent = "Active: " + active.join(", "); label.className = "text-[11px] text-primary uppercase tracking-[0.2em]"; }
            if (orb) orb.classList.add('orb-active');
        } else {
            if (label) { label.textContent = "Sensors standby"; label.className = "text-[11px] text-secondary uppercase tracking-[0.2em]"; }
            if (orb) orb.classList.remove('orb-active');
        }
    }
```

Replace it with (adding the `NeuralOrb.setState` calls, keeping everything else identical):

```javascript
    function updateSensorStatusLabel() {
        const label = document.getElementById('sensor-status-label');
        const orb = document.getElementById('quantum-eye');
        let active = [];
        if (cameraStream) active.push("sight");
        if (micEnabled) active.push("hearing");
        if (speechEnabled) active.push("voice");

        if (active.length > 0) {
            if (label) { label.textContent = "Active: " + active.join(", "); label.className = "text-[11px] text-primary uppercase tracking-[0.2em]"; }
            if (orb) orb.classList.add('orb-active');
            NeuralOrb.setState(focalOrbScene, isSpeakingNow ? 'speaking' : 'active');
        } else {
            if (label) { label.textContent = "Sensors standby"; label.className = "text-[11px] text-secondary uppercase tracking-[0.2em]"; }
            if (orb) orb.classList.remove('orb-active');
            NeuralOrb.setState(focalOrbScene, isSpeakingNow ? 'speaking' : 'idle');
        }
    }
```

- [ ] **Step 6: Wire the "speaking" state into `speakText`**

In `src/interaction/static/index.html`, this section of `speakText` currently reads (lines 1852-1858):

```javascript
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            currentAudioEl = new Audio(url);
            isSpeakingNow = true;
            currentAudioEl.onended = () => { isSpeakingNow = false; URL.revokeObjectURL(url); };
            currentAudioEl.onerror = () => { isSpeakingNow = false; };
            await currentAudioEl.play();
```

Replace it with:

```javascript
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            currentAudioEl = new Audio(url);
            isSpeakingNow = true;
            updateSensorStatusLabel();
            currentAudioEl.onended = () => { isSpeakingNow = false; URL.revokeObjectURL(url); updateSensorStatusLabel(); };
            currentAudioEl.onerror = () => { isSpeakingNow = false; updateSensorStatusLabel(); };
            await currentAudioEl.play();
```

(Calling `updateSensorStatusLabel()` again — rather than duplicating the active-vs-idle decision here — keeps "what idle vs. active means" defined in exactly one place.)

- [ ] **Step 7: Run the test suite and typecheck**

Run: `npm test`
Expected: unchanged pass count (this task touches no `.ts` file).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Manually verify the focal orb**

With the stack running:
1. Load the dashboard on the Home tab — confirm a bright rotating neural sphere renders inside the small circular orb (not the old plain glow), and that `#quantum-iris` no longer exists in the DOM.
2. Toggle the camera or mic sensor on — confirm `document.getElementById('quantum-eye-canvas').dataset.orbState` becomes `"active"`, and the orb visibly brightens/speeds up slightly. Toggle back off — confirm it returns to `"idle"`.
3. Trigger spoken output (toggle "spoken replies" on and send a chat message, or call `speakText` directly from devtools) — confirm `orbState` becomes `"speaking"` while audio plays, and reverts afterward.
4. Click the orb — confirm it switches to the Vault tab (no notes are wired in yet, so every click currently falls through to the "click elsewhere" behavior — this is expected until Task 5).
5. Toggle the camera sensor on and move in front of the camera — confirm no console errors from `trackMotionFrame`/`stopCameraMotionTracking` (the removed iris references), and that `maybeSendAmbientNudge`-driven behavior (ambient nudges after stillness/motion) still works as before.

- [ ] **Step 9: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: replace the presence orb with the focal neural orb, add state reactivity"
```

---

### Task 4: Backend — bulk vault graph endpoint

**Files:**
- Modify: `src/kernel/state/vault-repo.ts`
- Modify: `src/server.ts`
- Test: `tests/index.test.ts`

**Interfaces:**
- Consumes: existing `getPool` (from `db.ts`), the existing `vault_notes`/`vault_links` schema — no schema change.
- Produces: `vaultRepo.listNotes(limit?: number): Promise<VaultNoteRow[]>` (extended with an optional cap, existing no-arg callers unaffected), `vaultRepo.listAllLinks(noteLimit: number): Promise<{ from_path: string; to_path: string }[]>` (new — resolves each link's raw wikilink target to a real note path by basename, exactly like the existing `getBacklinks` does per-note, just generalized to all notes at once), and `GET /api/system/vault/graph` (`vault.read`) → `{ notes: VaultNoteRow[], links: { from_path: string; to_path: string }[] }` — Task 5's frontend calls this directly.

- [ ] **Step 1: Add an optional cap to `listNotes`**

In `src/kernel/state/vault-repo.ts`, this function currently reads:

```typescript
export async function listNotes(): Promise<VaultNoteRow[]> {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM vault_notes ORDER BY last_synced_at DESC`);
    return rows;
  } catch {
    return [];
  }
}
```

Replace it with:

```typescript
export async function listNotes(limit?: number): Promise<VaultNoteRow[]> {
  try {
    const db = getPool();
    const { rows } = limit
      ? await db.query(`SELECT * FROM vault_notes ORDER BY last_synced_at DESC LIMIT $1`, [limit])
      : await db.query(`SELECT * FROM vault_notes ORDER BY last_synced_at DESC`);
    return rows;
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Add `listAllLinks`**

In `src/kernel/state/vault-repo.ts`, add this function after `getBacklinks` (at the end of the file):

```typescript
// Bulk counterpart to getBacklinks — used by the neural-orb vault
// visualization to draw connections between note-points without an N+1
// per-note backlink lookup. Resolves each link's raw wikilink target
// (to_path_raw, e.g. "note-b") to a real note path (e.g. "note-b.md") by
// basename, exactly like getBacklinks already does for a single target —
// generalized here to every note in the capped set at once. A link is
// only returned if BOTH its source and resolved target are within the
// capped note set, since the orb never renders a point for a note outside
// that set.
export async function listAllLinks(noteLimit: number): Promise<{ from_path: string; to_path: string }[]> {
  try {
    const db = getPool();
    const { rows: noteRows } = await db.query(
      `SELECT path FROM vault_notes ORDER BY last_synced_at DESC LIMIT $1`,
      [noteLimit]
    );
    const paths: string[] = noteRows.map((r: { path: string }) => r.path);
    if (paths.length === 0) return [];

    const basenameOf = (p: string) => (p.split("/").pop() || p).replace(/\.md$/, "").toLowerCase();
    const basenameToPath = new Map(paths.map((p: string) => [basenameOf(p), p]));

    const { rows: linkRows } = await db.query(
      `SELECT from_path, to_path_raw FROM vault_links WHERE from_path = ANY($1)`,
      [paths]
    );

    const resolved: { from_path: string; to_path: string }[] = [];
    for (const row of linkRows) {
      const target = row.to_path_raw.replace(/#.*$/, "").trim();
      const targetBasename = basenameOf(target);
      const toPath = basenameToPath.get(targetBasename);
      if (toPath) resolved.push({ from_path: row.from_path, to_path: toPath });
    }
    return resolved;
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Add the `GET /api/system/vault/graph` route**

In `src/server.ts`, add this route immediately after the existing `POST /api/system/vault/note` route's closing `});` (find it with `grep -n "vault_note_written_via_dashboard" src/server.ts` — the route ends a few lines below that):

```typescript
app.get("/api/system/vault/graph", validateApiKey, async (req: any, res: any) => {
  if (!permissions.hasGrant(req.username, "vault.read")) {
    return res.status(403).json({ error: 'Missing capability grant "vault.read"' });
  }
  const GRAPH_NOTE_LIMIT = 150;
  const [notes, links] = await Promise.all([
    vaultRepo.listNotes(GRAPH_NOTE_LIMIT),
    vaultRepo.listAllLinks(GRAPH_NOTE_LIMIT),
  ]);
  res.json({ notes, links });
});
```

- [ ] **Step 4: Add a test for `listAllLinks`'s degrade-clean behavior**

In `tests/index.test.ts`, update the vault-repo import (currently `import { upsertNote, listNotes, searchNotes, getBacklinks } from "../src/kernel/state/vault-repo.js";`) to also import `listAllLinks`:

```typescript
import { upsertNote, listNotes, searchNotes, getBacklinks, listAllLinks } from "../src/kernel/state/vault-repo.js";
```

Then add this test right after the existing `"getBacklinks degrades cleanly when Postgres isn't reachable"` test:

```typescript
registerTest("Vault", "listAllLinks degrades cleanly when Postgres isn't reachable", async () => {
  const result = await listAllLinks(150);
  if (!Array.isArray(result) || result.length !== 0) {
    throw new Error(`Vault: expected an empty array with no DB, got: ${JSON.stringify(result)}`);
  }
});
```

- [ ] **Step 5: Run the test suite and typecheck**

Run: `npm test`
Expected: one more test than before this task (the new `listAllLinks` test), all passing.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manually verify the route against a real running instance**

Following the same manual-verification pattern used for the existing vault routes (a scratch Postgres + a configured `OBSIDIAN_VAULT_DIR`, not the live production stack):

```bash
curl -s -H "x-api-key: $INTERNAL_API_KEY" "http://localhost:PORT/api/system/vault/graph"
```

Expected: `{"notes":[...],"links":[...]}`, with `links` entries whose `from_path`/`to_path` both appear as a `path` in `notes` (confirming the basename-resolution join worked), and `notes.length` capped at 150 even against a larger vault.

- [ ] **Step 7: Commit**

```bash
git add src/kernel/state/vault-repo.ts src/server.ts tests/index.test.ts
git commit -m "feat: add a bulk vault graph endpoint (notes + resolved links)"
```

---

### Task 5: Wire real vault data into the focal orb

**Files:**
- Modify: `src/interaction/static/index.html`

**Interfaces:**
- Consumes: `GET /api/system/vault/graph` (Task 4), `NeuralOrb.setNeurons`, `NeuralOrb.randomNeurons`, `NeuralOrb.fibonacciSpherePoint`, `NeuralOrb.hashString` (Task 2), `focalOrbScene`, `openVaultNoteFromOrb` (Task 3), `CURRENT_API_KEY`, `authFetch` (existing).
- Produces: `loadOrbVaultGraph()` — called from `switchTab` on Home-tab entry, no other task depends on it; this is the final task in this plan.

- [ ] **Step 1: Add `loadOrbVaultGraph`**

In `src/interaction/static/index.html`, add this function right after `openVaultNoteFromOrb` (defined in Task 3):

```javascript
    const ORB_SLOT_COUNT = 480;

    async function loadOrbVaultGraph() {
        if (!CURRENT_API_KEY) {
            NeuralOrb.setNeurons(focalOrbScene, NeuralOrb.randomNeurons(420), []);
            return;
        }
        try {
            const res = await authFetch('/api/system/vault/graph', { headers: { 'X-API-Key': CURRENT_API_KEY } });
            if (!res.ok) { NeuralOrb.setNeurons(focalOrbScene, NeuralOrb.randomNeurons(420), []); return; }
            const data = await res.json();
            const notes = data.notes || [];
            if (notes.length === 0) {
                NeuralOrb.setNeurons(focalOrbScene, NeuralOrb.randomNeurons(420), []);
                return;
            }

            const neuronsByPath = new Map();
            const neurons = notes.map(n => {
                const slot = NeuralOrb.hashString(n.path) % ORB_SLOT_COUNT;
                const { x, y, z } = NeuralOrb.fibonacciSpherePoint(slot, ORB_SLOT_COUNT);
                const neuron = { x, y, z, ph: Math.random() * 6.28, sp: 0.5 + Math.random() * 1.5, note: n.path };
                neuronsByPath.set(n.path, neuron);
                return neuron;
            });

            const links = (data.links || [])
                .map(l => {
                    const a = neuronsByPath.get(l.from_path);
                    const b = neuronsByPath.get(l.to_path);
                    return (a && b) ? [a, b] : null;
                })
                .filter(Boolean);

            NeuralOrb.setNeurons(focalOrbScene, neurons, links);
        } catch {
            NeuralOrb.setNeurons(focalOrbScene, NeuralOrb.randomNeurons(420), []);
        }
    }
```

- [ ] **Step 2: Load it on Home-tab entry**

In `src/interaction/static/index.html`, `switchTab` currently ends with (lines 2109-2114):

```javascript
        if (tabId === 'workspace') refreshWorkspaceSnapshot();
        if (tabId === 'memory') loadPendingMemories();
        if (tabId === 'learning') loadLearningDashboard();
        if (tabId === 'settings') { loadSystemSettings(); updatePushStatusUI(); }
        if (tabId === 'calendar') loadCalendarEvents();
        if (tabId === 'vault') loadVaultNotes();
    }
```

Add a `home` case:

```javascript
        if (tabId === 'workspace') refreshWorkspaceSnapshot();
        if (tabId === 'memory') loadPendingMemories();
        if (tabId === 'learning') loadLearningDashboard();
        if (tabId === 'settings') { loadSystemSettings(); updatePushStatusUI(); }
        if (tabId === 'calendar') loadCalendarEvents();
        if (tabId === 'vault') loadVaultNotes();
        if (tabId === 'home') loadOrbVaultGraph();
    }
```

(`switchTab('home')` already runs once on `DOMContentLoaded` — see line 3766 — so this also covers the initial page load, not just later tab switches.)

- [ ] **Step 3: Run the test suite and typecheck**

Run: `npm test`
Expected: unchanged pass count (this task touches no `.ts` file).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify the live graph, end to end**

With the stack running and at least two vault notes linked by a real `[[wikilink]]` (reuse the same fixture setup as the Vault panel's own manual verification, or write two linked notes via the Vault tab first):

1. Load the Home tab — open devtools and confirm `focalOrbScene.neurons.some(n => n.note)` is true (real note data loaded, not the random fallback).
2. Confirm `focalOrbScene.links.length > 0` if the fixture notes are linked.
3. In devtools, read `focalOrbScene.projected[0]` for its `{x, y}` and simulate a click at that exact canvas-relative position (`document.getElementById('quantum-eye').dispatchEvent(new MouseEvent('click', { clientX: <canvas rect left + x>, clientY: <canvas rect top + y>, bubbles: true }))`) — confirm it switches to the Vault tab with that specific note open (`currentVaultNotePath` matches `focalOrbScene.projected[0].note`).
4. Click somewhere on the orb away from any projected point — confirm it switches to the Vault tab's list view without a specific note selected.
5. Log out (clear `CURRENT_API_KEY`) or point at an unconfigured vault — confirm the orb falls back to the generic decorative sphere rather than rendering empty or broken.

- [ ] **Step 5: Commit**

```bash
git add src/interaction/static/index.html
git commit -m "feat: wire the real vault graph into the focal orb (live notes, links, click-to-open)"
```

---

## Final Verification

- `npm test` — full suite green (108 tests: 107 existing + the new `listAllLinks` test), no regressions.
- `npx tsc --noEmit` — no errors.
- All manual verification steps across Tasks 1-5 pass against a real running stack: palette renders, ambient orb persists across tabs and pauses on sleep, focal orb reacts to sensor/speaking state and no longer has the old iris/blink behavior, the graph endpoint returns capped+resolved data, and clicking a real note-point on the Home orb opens that exact note in the Vault tab.
