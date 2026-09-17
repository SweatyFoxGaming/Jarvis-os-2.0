# Orbis-Inspired Neural Theme — Design Spec

## Context

The user shared `orbis` — a separate personal-AI-assistant project of theirs with a complete
Galaxy S25 phone theme (`orbis-s25-theme-preview.html`): a deep-navy/black backdrop, cyan
(`#50D2FF`) + pink (`#FF78DC`) glowing accents, frosted-glass panels, and a rotating wireframe
"neuron sphere" (a particle-and-wireframe globe with a pink core glow) as the living-intelligence
centerpiece. They asked to bring this look into Jarvis's own dashboard (`src/interaction/static/index.html`).

This is a real design reversal, not an accent tweak: the dashboard's current panel style was a
deliberate move *away* from a similar "heavy-blur holographic" look toward a calmer, muted
blue-gray flat-card style (see the `.holo-panel` comment in `index.html`). The user explicitly
wants the full aesthetic package back, plus more: the orb should visualize their real Obsidian
vault (notes as points, backlinks as connections, clickable), not just decorate.

Three approaches for the animated centerpiece were considered — a live `three.js`/WebGL sphere was
explicitly tried and rejected once real project history surfaced a concrete reason not to: this
codebase's Electron desktop app disables GPU hardware acceleration outright (`7c1f40a`) after a
live GPU-process crash on this machine's hardware (an old Kepler-generation NVIDIA card running the
`nouveau` driver). A continuously-animating WebGL particle sphere — especially one running as a
persistent background layer — is exactly the sustained GPU-shaped workload that fix exists to avoid.
The final direction ports the Orbis reference's own **canvas 2D** renderer instead: proven,
dependency-free, and guaranteed compatible with hardware acceleration disabled.

## Architecture

### Palette (`tailwind.index.config.js`)

| Token | Current | New |
|---|---|---|
| `bg` | `#050608` | `#01040c` |
| `surface` | `#0B0D12` | `#050b18` |
| `card` | `#12141B` | `#0b1830` |
| `primary` / `accent` | `#8FB8E8` | `#50D2FF` |
| `secondary` | `#767C8C` | `#7fa8cc` |
| `glow` *(new token)* | — | `#FF78DC` — orb core / speaking state / mic accent only |
| `success` / `warning` / `danger` | unchanged | unchanged (explicit user decision — semantic clarity over palette purity) |
| `text` | `#EDEFF3` | unchanged |

Every usage is via Tailwind utility classes already applied throughout `index.html`
(`text-secondary`, `border-primary`, `bg-primary`, etc. — 250+ call sites) — the palette swap is a
config-only change, no markup edits.

`.holo-panel`/`.glass-panel` (and `.holo-lift`, `.holo-divider`, `.holo-text-glow`) go back to a
frosted-glass treatment: navy gradient fill (`rgba(11,24,48,.55)`), a cyan-tinted border,
`backdrop-filter: blur(14px)`, and a soft cyan glow shadow — reversing the "calm, flat" comment on
purpose, per explicit user direction. The two static `.glow-accent` ambient blur blobs are removed
(both the CSS class and their two `<div>`s in the body) — the new animated background canvas takes
over that ambient-depth role, and keeping both would visually compete.

### Shared neural-orb renderer

One JS function, ported from Orbis's own `brainPoints`/`proj`/`drawScene` (a sphere-shaped particle
field + wireframe lat/long lines + pink core glow, slowly rotating), parameterized by
`{ dim, neuronCount, cy, R, rotateSpeed, interactive }`. Two instances share **one**
`requestAnimationFrame` loop (Orbis's own file already does this exact multi-canvas-one-loop
pattern — ported as-is rather than re-invented):

- **Ambient background canvas** — fixed, full-viewport, dim (~0.35), non-interactive, procedurally
  random points (no real data). Persists across every tab, sits behind `#app`
  (`position: fixed; inset: 0; z-index: 0`). This is pure decoration.
- **Focal Home canvas** — replaces the current `.jarvis-orb` CSS-only glow inside the existing
  160×160 `#quantum-eye` container. Bright (dim ~1), interactive, and **data-bound to the real
  vault** (see below) instead of random points.

### Live vault graph (focal orb only)

The ambient background orb stays decorative — only the focal Home orb becomes a real visualization,
to keep hit-testing and data-fetching scoped to the one place it's actually useful.

- **New route**: `GET /api/system/vault/graph` (`vault.read`, same gate as the existing vault
  routes) → `{ notes: VaultNoteRow[], links: { from_path, to_path_raw }[] }`. Notes capped to the
  ~150 most-recently-synced (`ORDER BY last_synced_at DESC LIMIT 150`), avoiding both an
  overcrowded sphere and unbounded query cost on a large vault. Requires one new
  `vault-repo.ts` function, `listAllLinks(limit)`, alongside the existing per-note `getBacklinks` —
  a bulk fetch is needed here specifically to avoid an N+1 backlink lookup per note when drawing
  connections.
- **Deterministic placement**: each note's sphere position is derived from a hash of its vault path
  (a small pure-JS string hash, no dependency), indexed into a fixed fibonacci-lattice point set —
  not re-randomized per render. A note should land in roughly the same spot across reloads so it
  stays findable, not jump around every refresh.
- **Real connections**: a faint arc is drawn between two note-points only when a real backlink
  connects them (from the `links` array) and both endpoints are present in the currently-rendered
  (capped) note set.
- **Click-to-open**: after each frame, the last-projected screen-space `{x, y}` for every rendered
  note-point is cached. A click within ~16px of a cached point opens that note (switches to the
  Vault tab and calls the existing `openVaultNote(path)`); a click anywhere else on the orb switches
  to the Vault tab's list view.
- **Fallback**: if the vault isn't configured, has zero notes, or the dashboard session isn't
  authenticated yet, the focal orb quietly renders the same generic decorative sphere the ambient
  background uses — never an empty or broken-looking orb.
- **Refresh**: fetched once when the Home tab becomes active, matching the existing
  load-on-tab-entry pattern already used for the Vault and Projects panels — no push/live-update
  channel.

### State reactivity

A small `setOrbState('idle' | 'active' | 'speaking')`, called from the existing
`updateSensorStatusLabel()` (idle ↔ active, based on camera/mic/speech being enabled) and
`speakText()` (→ speaking while audio plays). Idle is cyan-dominant and slow; active brightens and
speeds up slightly; speaking brings the pink core forward and speeds up further. This applies to the
focal orb only — the ambient background orb is not state-reactive, it just runs.

### Performance & lifecycle

This is the dashboard's first continuously-animating canvas, so explicit lifecycle handling is part
of the design, not an afterthought:

- Both canvases pause (skip drawing, still schedule the next frame cheaply) when the existing
  `sleepModeActive` flag (the "CORES_SLEEP" toggle) is true, and when `document.hidden` — the
  latter mostly redundant with the browser's own background-tab rAF throttling, but explicit and
  cheap to check.
- Neuron counts are fixed, not scaled to viewport size — cost stays bounded on a large monitor.
- Canvas resolution follows `devicePixelRatio` capped at 2, resized lazily (checked once per frame
  against `clientWidth`, matching the reference implementation's own approach — no separate resize
  listener needed).

## Explicitly out of scope

- The GitHub token permission gap found while investigating "Jarvis errors when creating things"
  (fine-grained PAT missing write access on `git/refs`) — a real, separate, already-diagnosed issue,
  but it's a credential/permissions fix on GitHub's side, not a code change, and unrelated to this
  visual work. No task for it appears in this spec's implementation plan.
- Any change to `success`/`warning`/`danger` semantic colors — explicit user decision to keep them
  for clarity.
- Making the ambient background orb data-bound or clickable — stays purely decorative, everywhere.
- A "quick-peek popover" or simple tab-shortcut click behavior — superseded by the live
  knowledge-graph orb, which is the richer option the user chose.
- Any new frontend build step or dependency (e.g. `three.js`) — ruled out specifically because of
  the disabled-GPU-acceleration history in this codebase's desktop app.
- Real-time/push updates to the vault graph — refresh-on-tab-entry only.
- Hover previews/tooltips on note-points — click-to-open only; no hover state is introduced.

## Testing

- No automated test coverage exists for this dashboard's frontend HTML/JS (same precedent as the
  Vault panel) — verified manually: idle look, triggering active/speaking state, confirming pause
  under sleep-mode, confirming the ambient background persists correctly across tab switches,
  clicking a real note-point opens the right note, clicking empty orb space opens the Vault tab.
- The new `GET /api/system/vault/graph` route and `listAllLinks` follow the same manual
  HTTP-round-trip verification precedent as the three existing vault routes — `npm test`/`tsc` stay
  green throughout, no unit test added for the route itself.

## Decisions made during brainstorming

- **Full aesthetic package**, not just a palette or just the orb — explicit user choice.
- **Both an ambient background orb (all tabs) and a bright focal orb (Home)** — explicit user
  choice over a Home-only placement.
- **State-reactive focal orb** (idle/active/speaking) — explicit user choice over a purely ambient
  animation, to keep the orb meaningful rather than just pretty.
- **Semantic success/warning/danger colors kept as-is** — explicit user choice over full-palette
  unification, prioritizing at-a-glance clarity.
- **Canvas 2D over WebGL/three.js** — reversed from an initial "go with three.js" choice once the
  desktop app's disabled-GPU-acceleration history (a real prior crash, `7c1f40a`) surfaced; the user
  chose to avoid reintroducing that risk rather than accept it.
- **Live knowledge-graph orb over a simple tab-shortcut or popover** — explicit user choice; the
  orb becomes a real visualization of the vault, not just a click target, at the cost of
  meaningfully more implementation (a new backend route, deterministic placement, hit-testing).
- **Only the focal orb is vault-data-bound; the ambient background orb stays decorative** —
  controller's call, to keep data-fetching and click-handling scoped to the one place it's used,
  presented to the user for confirmation before writing this spec.
