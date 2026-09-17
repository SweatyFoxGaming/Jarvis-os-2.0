# OS-level presence, on-demand screen vision, and a display panel

## Goal

Three related but independent additions, all approved by the project owner
after clarifying questions (see conversation log for the full Q&A):

1. **Always-on presence** — the desktop app auto-launches at login, hidden,
   and never needs to be manually reopened. Builds directly on
   `2026-07-19-desktop-os-integration-design.md` (autostart `.desktop` files,
   tray, single-instance lock already exist) rather than replacing it.
2. **On-demand screen vision** — Jarvis can look at what's on screen when
   it's actually relevant to the conversation, gated the same way GitHub/
   email access already is (explicit, revocable capability grant). Not
   continuous — the owner explicitly chose on-demand over an always-on
   screen feed given the much bigger privacy surface a screen has versus a
   webcam.
3. **Display panel** — a dedicated area in the dashboard that Jarvis can
   render into (images, code/markdown, simple charts, embedded web pages)
   whenever a reply has something better shown than said.

None of these are "kernel-level" in the literal sense (no kernel module,
no ring-0 code) — that phrase was clarified up front to mean deeper OS
presence and control via ordinary user-space OS APIs, which is what all
three of these are.

## 1. Always-on presence

### Approach

Harden what already exists rather than rebuild it — the current autostart
`.desktop` entry, tray icon, and single-instance lock stay exactly as they
are. Two concrete gaps close this out:

- **No window flash on autostart launch.** Today the window always shows
  immediately on launch (documented as current behavior in the prior spec).
  A `--hidden` flag distinguishes an autostart-triggered launch from a
  user double-clicking the app: the autostart `.desktop` file's `Exec=`
  line passes `--hidden`; the app-menu entry's does not. `createWindow()`
  checks `process.argv.includes('--hidden')` and, if set, skips showing the
  window (and skips the loading-screen flash entirely) — the tray icon
  still appears immediately, and clicking "Show Jarvis" works exactly as it
  does today.
- **Real crash-restart supervision.** XDG autostart only fires once, at
  login — if the Electron process ever crashes, nothing brings it back
  until the next login. A `systemd --user` unit
  (`~/.config/systemd/user/jarvis-os.service`) supervising the same
  `launch.sh` entry point (with `--hidden`) adds `Restart=on-failure`,
  giving the app the same kind of self-healing the Docker backend already
  has via `restart: unless-stopped`. This *complements* the existing
  autostart entry rather than replacing it — `ensureOsIntegration()` writes
  the systemd unit the same "only if missing" way it already writes the
  `.desktop` files, and runs `systemctl --user enable --now` once. If
  systemd isn't available (some minimal distros), this step logs a clear
  warning and falls back to XDG-autostart-only — never a hard failure.

### Rejected alternative

Rebuilding as a true system service with a thin separate UI client (fully
decoupling "the brain" from the Electron window). Rejected because the
browser-side mic/camera capture that already exists can only run inside a
real renderer process — a headless backend service buys nothing for the
actual ambient-listening feature, at the cost of a real rewrite.

## 2. On-demand screen vision (`view_screen`)

### The real constraint this design has to account for

Every existing tool (GitHub, email, TTS, calendar, `decompose_plan`)
executes entirely inside `server.ts` because the backend has direct network
access to those services. Screen capture is different: **only the
Electron renderer/main process can see the user's screen** — the Node
backend, running inside a Docker container, has no access to the host
display at all. So `view_screen` can't be "just another case in the
`executeTool` switch" the way the others are; it genuinely needs a
round trip to the connected client mid-conversation. Calling this out
explicitly now, rather than discovering it mid-implementation.

### Mechanism

- `view_screen` is declared in `TOOL_DECLARATIONS` and gated by the same
  capability-grant system as GitHub/email (default-deny, admin-revocable) —
  screen content is at least as sensitive as either of those.
- When Gemini calls it, `executeTool` can't produce a result immediately.
  Instead it emits a new SSE frame on the in-flight `/api/chat` stream
  (same mechanism the existing `detail: ` trace frame already uses) telling
  the client "capture and resubmit," and the current turn ends with a short
  narrated placeholder ("Let me take a look...").
- The client (`index.html`) recognizes this frame type, immediately
  captures one screenshot via a new Electron main-process capability
  (`desktopCapturer.getSources` with a full-screen `thumbnailSize`, exposed
  through `preload.js` the same way `notify` already is — a single still
  image, not a video stream, since this is on-demand, not continuous), and
  automatically resubmits the original message to `/api/chat` with the
  screenshot attached via the **same `image` field camera frames already
  use** — no new request shape, no new server-side code path for consuming
  it. The second pass has real screen context and Gemini finishes its
  answer normally.
- Outside the desktop app (a plain browser tab, no Electron main process),
  `desktopCapturer` doesn't exist. The client detects this and the tool
  degrades to a clear, honest message ("screen viewing is only available in
  the desktop app") rather than a silent failure or a fabricated answer.

## 3. Display panel (`display_content`)

### Mechanism

Unlike `view_screen`, this tool has no client-round-trip problem — the
server already has (or generates) whatever it wants to show, so execution
is synchronous and entirely server-side:

- `display_content(type, title, content)` added to `TOOL_DECLARATIONS`,
  where `type` is one of `image | code | chart | webpage`. Gemini calls it
  whenever a reply has something genuinely better shown than said — this
  was the owner's explicit choice over requiring an explicit "show me"
  every time.
- `executeTool("display_content", ...)` does no external work — it
  packages the directive and it rides the existing SSE stream as a new
  `display: {...}` frame (parallel to the existing `detail: ` frame), which
  `index.html` picks up.
- Not gated by the capability-grant system, unlike `view_screen`/GitHub/
  email — it has no real-world side effect or access to anything private
  beyond what the conversation itself already contains.
- **Client side**: a new panel in the dashboard, hidden until the first
  `display:` frame arrives, with a small per-type renderer:
  - `image` → `<img>` (data URL or same-origin/allowed URL)
  - `code` → syntax-highlighted block (reusing the `unpkg.com` CSP
    allowance already in place for `cytoscape`, same pattern)
  - `chart` → simple structured `{labels, values}` data rendered via
    Canvas, no new heavy dependency
  - `webpage` → `<iframe>`. Honest caveat, stated directly to the owner
    already and repeated here: many real sites (Google, GitHub, etc.)
    block being framed at all via their own headers — Jarvis's own CSP
    can't work around that. A load-timeout fallback shows "this site
    doesn't allow embedding — [open in new tab]" instead of a silently
    blank panel.
  - Unknown/malformed `type` → a clear inline error in the panel, not a
    blank or broken state.
- A dismiss control (×) hides the panel and returns to full-width chat;
  the next `display:` frame reopens it.

## Testing

- **Always-on**: log out/in (or reboot) and confirm the app auto-launches
  with no visible window and the tray icon present; `kill -9` the process
  and confirm systemd relaunches it within a few seconds; confirm the
  app-menu entry (no `--hidden`) still opens visibly as before.
- **`view_screen`**: live-verified only — a real screenshot round trip
  can't be meaningfully simulated in an automated test. Manually confirm:
  a screen-relevant question triggers a capture-and-resubmit, the panel/
  chat reflects real screen content, and the plain-browser-tab fallback
  message appears when tested outside Electron.
- **`display_content`**: automatable via Playwright — trigger each content
  type (including a deliberately malformed one, and a webpage URL known to
  block framing) and confirm the panel renders/falls back correctly for
  each, plus confirm dismiss works.

## Out of scope (this pass)

- Full mouse/keyboard control or window management — the owner explicitly
  scoped the first "deeper control" increment to screen visibility only.
- Continuous/ambient screen capture — explicitly ruled out in favor of
  on-demand, given the privacy surface difference from the camera.
- A separate always-on-top popup window for the display panel — the owner
  chose an in-dashboard panel over a floating window.
