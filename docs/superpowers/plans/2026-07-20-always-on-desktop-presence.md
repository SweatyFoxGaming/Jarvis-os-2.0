# Always-On Desktop Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app auto-launches at login with no visible window and survives a crash without needing the user to log out/in again.

**Architecture:** Two small, additive changes to `desktop-electron/main.js`: (1) a `--hidden` CLI flag, forwarded through `launch.sh`, that skips showing the window on launch; (2) a `systemd --user` unit that supervises the same launch path with `Restart=on-failure`, written the same "only if missing" way the existing `.desktop` autostart entry already is. Neither replaces anything that exists today — both are additive to `2026-07-19-desktop-os-integration-design.md`'s already-shipped autostart/tray/single-instance-lock system.

**Tech Stack:** Electron (existing), Bash, systemd user units (Linux-only, matching this repo's existing XDG-only scope).

## Global Constraints

- This machine is Linux — no Windows/macOS autostart mechanism is in scope (matches the prior spec's own stated scope).
- Never overwrite a `.desktop` file or systemd unit that already exists — only write on first run, exactly like the existing two `.desktop` files.
- If `systemd --user` isn't available, log a clear one-line message and continue — never a hard failure that blocks the rest of `ensureOsIntegration()`.
- `desktop-electron/` has no automated test framework today (no `test` script in `package.json`, no Electron test runner). The prior OS-integration spec's own Testing section verifies this exact module manually (launch, check tray, log out/in). This plan follows that same established convention rather than introducing new test tooling disproportionate to the feature — every step below still has an exact command and exact expected output, just run live instead of under a test runner.
- `scripts/install-desktop.sh` is a separate, unrelated legacy launcher (pywebview/Chrome-app-mode) that predates and doesn't reference `desktop-electron/` at all — do not touch it as part of this plan.

---

### Task 1: `--hidden` flag support in `launch.sh` and `main.js`

**Files:**
- Modify: `desktop-electron/launch.sh`
- Modify: `desktop-electron/main.js:104-116` (`createWindow`)

**Interfaces:**
- Produces: a module-level `const START_HIDDEN = process.argv.includes('--hidden');` in `main.js`, read by `createWindow()`.

- [ ] **Step 1: Forward CLI args through `launch.sh`**

Current content of `desktop-electron/launch.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
exec ./node_modules/.bin/electron .
```

Change the final line to forward any arguments `launch.sh` itself was called with:
```bash
exec ./node_modules/.bin/electron . "$@"
```

- [ ] **Step 2: Verify args reach `process.argv` inside Electron**

Run: `cd desktop-electron && ./launch.sh --hidden &`
Then in another terminal: `pgrep -af electron | grep -- --hidden`
Expected: a running electron process whose command line includes `--hidden`. Kill it afterward: `pkill -f "electron . --hidden"`.

- [ ] **Step 3: Read the flag and stop the window from ever flashing visible**

In `desktop-electron/main.js`, near the other top-level `const`s (after `let isQuitting = false;`), add:

```js
// Set by the autostart .desktop entry / systemd unit (see ensureOsIntegration
// below) so a login-triggered launch doesn't pop a window in front of the
// user before they've asked to see it. The app-menu entry passes no flag,
// so double-clicking the icon still opens visibly exactly as before.
const START_HIDDEN = process.argv.includes('--hidden');
```

In `createWindow()`, add `show: false` to the `BrowserWindow` constructor options and show it explicitly once content is ready to paint (this also removes the pre-existing blank-window flash on a *normal* launch, as a side effect):

```js
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#04060f',
    title: 'Jarvis OS',
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
  });

  // ... rest of createWindow() (permission handlers, close handler,
  // loadFile/waitForServer/loadURL) stays exactly as it is today — none of
  // it depends on whether the window is currently shown.
```

- [ ] **Step 4: Verify hidden launch shows no window but the tray still works**

Run: `cd desktop-electron && ./launch.sh --hidden`
Expected: no window appears; the tray icon appears within a few seconds (once `app.whenReady()` resolves and `createTray()` runs). Click "Show Jarvis" in the tray menu.
Expected: the window now appears, fully loaded (not blank) — confirming it was rendering in the background the whole time, not delayed.

- [ ] **Step 5: Verify a normal (non-hidden) launch is unaffected**

Run: `cd desktop-electron && ./launch.sh`
Expected: the window appears exactly as before (same size, same content), just without a blank-white flash before the dashboard paints.

- [ ] **Step 6: Commit**

```bash
git add desktop-electron/launch.sh desktop-electron/main.js
git commit -m "feat: add --hidden launch mode, load window without a visible flash"
```

---

### Task 2: Autostart entry passes `--hidden`; app-menu entry doesn't

**Files:**
- Modify: `desktop-electron/main.js:70-102` (`ensureOsIntegration`)

**Interfaces:**
- Consumes: `LAUNCH_SCRIPT` (existing constant, `desktop-electron/main.js:13`), `START_HIDDEN` (Task 1).
- Produces: no new exports — this only changes file contents written to disk.

- [ ] **Step 1: Split the single shared `.desktop` template into two**

Current `ensureOsIntegration()` writes the *same* `desktopEntry` content to both the app-menu path and the autostart path. Replace the whole function body:

```js
function ensureOsIntegration() {
  const menuEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Jarvis OS',
    'Comment=Jarvis OS desktop console',
    `Exec="${LAUNCH_SCRIPT}"`,
    `Icon=${ICON_PATH}`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n');

  // Passes --hidden so a login-triggered launch (see Task 1) doesn't show a
  // window before the user asks to see it — this is the ONLY difference
  // from menuEntry above.
  const autostartEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Jarvis OS',
    'Comment=Jarvis OS desktop console',
    `Exec="${LAUNCH_SCRIPT}" --hidden`,
    `Icon=${ICON_PATH}`,
    'Terminal=false',
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');

  const targets = [
    { file: path.join(os.homedir(), '.local', 'share', 'applications', 'jarvis-os.desktop'), content: menuEntry },
    { file: path.join(os.homedir(), '.config', 'autostart', 'jarvis-os.desktop'), content: autostartEntry },
  ];

  for (const { file, content } of targets) {
    try {
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode: 0o644 });
    } catch (err) {
      console.error(`Could not write ${file}:`, err.message);
    }
  }

  ensureSystemdService();
}
```

Note the call to `ensureSystemdService()` at the end — implemented in Task 3. Leave that call in place now; Task 3 defines the function it calls.

- [ ] **Step 2: Verify existing `.desktop` files are never clobbered**

Run: `cat ~/.local/share/applications/jarvis-os.desktop` (if it already exists from a prior run, its content should be untouched — confirm no `--hidden` is present).
To test a genuinely fresh write, temporarily move existing files aside first:
```bash
mv ~/.local/share/applications/jarvis-os.desktop /tmp/jarvis-menu.desktop.bak 2>/dev/null || true
mv ~/.config/autostart/jarvis-os.desktop /tmp/jarvis-autostart.desktop.bak 2>/dev/null || true
```
Run: `cd desktop-electron && ./launch.sh --hidden` (then quit via tray).
Expected: `cat ~/.local/share/applications/jarvis-os.desktop` has no `--hidden` in its `Exec=` line; `cat ~/.config/autostart/jarvis-os.desktop` does.

- [ ] **Step 3: Commit**

```bash
git add desktop-electron/main.js
git commit -m "feat: autostart entry launches hidden, app-menu entry launches visible"
```

---

### Task 3: `systemd --user` service for crash-restart supervision

**Files:**
- Modify: `desktop-electron/main.js` (add `ensureSystemdService()`, add `child_process` import)

**Interfaces:**
- Consumes: `LAUNCH_SCRIPT` (existing constant).
- Produces: `ensureSystemdService()` — called once from `ensureOsIntegration()` (Task 2), no return value, no other module depends on it.

- [ ] **Step 1: Add the `child_process` import**

At the top of `desktop-electron/main.js`, alongside the other `require`s:

```js
const { execSync } = require('child_process');
```

- [ ] **Step 2: Implement `ensureSystemdService()`**

Add this function right after `ensureOsIntegration()`:

```js
// Real crash-restart supervision, complementing (not replacing) the XDG
// autostart entry above. Autostart only fires once, at login — if this
// process ever crashes afterward, nothing brings it back until the next
// login without this. requestSingleInstanceLock() above already makes it
// harmless for both this unit AND the XDG autostart entry to independently
// try to launch at login (the second attempt just hands off to the first
// and exits) — so this is additive, not a replacement.
function ensureSystemdService() {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'jarvis-os.service');
  if (fs.existsSync(unitPath)) return;

  try {
    execSync('systemctl --user --version', { stdio: 'ignore' });
  } catch {
    console.log('[main] systemd --user not available; relying on XDG autostart only.');
    return;
  }

  const unit = [
    '[Unit]',
    'Description=Jarvis OS Desktop',
    'After=graphical-session.target',
    '',
    '[Service]',
    `ExecStart="${LAUNCH_SCRIPT}" --hidden`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=graphical-session.target',
    '',
  ].join('\n');

  try {
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unitPath, unit, { mode: 0o644 });
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable --now jarvis-os.service', { stdio: 'ignore' });
    console.log('[main] Installed and started jarvis-os.service (systemd --user).');
  } catch (err) {
    console.error('[main] Could not install systemd user service:', err.message);
  }
}
```

- [ ] **Step 3: Verify the unit gets written and enabled on first run**

```bash
rm -f ~/.config/systemd/user/jarvis-os.service
systemctl --user disable jarvis-os.service 2>/dev/null || true
cd desktop-electron && ./launch.sh --hidden
sleep 2
```
Run: `systemctl --user status jarvis-os.service --no-pager`
Expected: `Active: active (running)`, and `cat ~/.config/systemd/user/jarvis-os.service` shows `Restart=on-failure` and `ExecStart=".../launch.sh" --hidden`.

- [ ] **Step 4: Verify real crash-restart supervision**

Run: `pkill -9 -f "electron . --hidden"`
Wait 10 seconds, then run: `systemctl --user status jarvis-os.service --no-pager`
Expected: the service shows `Active: active (running)` again with a recent start time — systemd relaunched it within `RestartSec=5` of the crash, without any manual login/relaunch.

- [ ] **Step 5: Verify graceful no-op when systemd is unavailable**

This can't be tested on a systemd-based distro without uninstalling systemd (out of scope to actually do). Instead, verify the code path directly:
Run: `node -e "try { require('child_process').execSync('systemctl --user --version', {stdio:'ignore'}) } catch { console.log('would fall back cleanly') }"`
Expected: on this machine (systemd present), this prints nothing (the try succeeds) — confirming the check itself works; the `catch` branch is exercised by code inspection (Step 2's code) rather than a live no-systemd environment, which this repo doesn't have available to test against.

- [ ] **Step 6: Commit**

```bash
git add desktop-electron/main.js
git commit -m "feat: supervise the desktop app with a systemd --user service"
```

---

## Self-Review

**Spec coverage:** Task 1 covers the design doc's "no window flash on autostart launch" gap. Task 2 covers "the autostart .desktop file's Exec= line passes --hidden; the app-menu entry's does not." Task 3 covers "a systemd --user unit... adds Restart=on-failure" and the systemd-unavailable fallback. All three design-doc requirements for this subsystem are covered.

**Placeholder scan:** No TBD/TODO; every step has exact code or an exact command with expected output.

**Type consistency:** `START_HIDDEN` (Task 1) is read only inside `createWindow()` (same file, module scope) — no cross-file signature to keep consistent. `ensureSystemdService()` (Task 3) is called from `ensureOsIntegration()` (Task 2) with no arguments and no return value used — consistent between both tasks.
