# Always-On Desktop Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app auto-launches at login with no visible window and survives a crash without needing the user to log out/in again.

**Architecture:** Two small changes to `desktop-electron/main.js`: (1) a `--hidden` CLI flag, forwarded through `launch.sh`, that skips showing the window on launch; (2) a `systemd --user` unit that supervises the same launch path with `Restart=on-failure`, written the same "only if missing" way the existing `.desktop` autostart entry already is. Both build on `2026-07-19-desktop-os-integration-design.md`'s already-shipped autostart/tray/single-instance-lock system — but per the 2026-07-20 correction on Tasks 2 and 3 below, the systemd unit ends up **replacing** the XDG autostart entry as the login-launch mechanism wherever systemd --user is available, rather than running alongside it; autostart remains only as the fallback when systemd isn't available.

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

- [ ] **Step 1: Split the single shared `.desktop` template into two, and make the autostart entry conditional on systemd being unavailable**

> **Correction (2026-07-20):** this step originally had `ensureOsIntegration()` write the autostart `.desktop` entry unconditionally, in addition to the systemd unit from Task 3. Live testing after both landed found a real bug in that design: this machine's `systemd-xdg-autostart-generator` independently wraps the autostart `.desktop` file into its own transient systemd unit, so writing both meant two systemd-adjacent launchers racing `requestSingleInstanceLock()` at every login, with no guarantee `jarvis-os.service` specifically ended up supervising the surviving instance — undermining the whole point of adding it. The fix, described below, makes systemd the sole login-launcher whenever it's available, and only falls back to XDG autostart when it isn't. `docs/superpowers/plans/` is a durable record, so this note stays rather than being silently edited away — but the code block below reflects the corrected design, not what originally shipped.

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

  const menuEntryFile = path.join(os.homedir(), '.local', 'share', 'applications', 'jarvis-os.desktop');
  try {
    if (!fs.existsSync(menuEntryFile)) {
      fs.mkdirSync(path.dirname(menuEntryFile), { recursive: true });
      fs.writeFileSync(menuEntryFile, menuEntry, { mode: 0o644 });
    }
  } catch (err) {
    console.error(`Could not write ${menuEntryFile}:`, err.message);
  }

  const autostartFile = path.join(os.homedir(), '.config', 'autostart', 'jarvis-os.desktop');
  const systemdOwnsLogin = ensureSystemdService();

  if (systemdOwnsLogin) {
    // systemd now owns login-launch + crash supervision. Remove a stale
    // autostart entry (from an older build, or a pre-fix run) so it can't
    // recreate the two-launcher race this design avoids.
    try {
      if (fs.existsSync(autostartFile)) {
        fs.unlinkSync(autostartFile);
        console.log(`[main] Removed ${autostartFile}: jarvis-os.service now owns login-launch and crash supervision, so a separate XDG autostart entry would just race it again.`);
      }
    } catch (err) {
      console.error(`Could not remove stale ${autostartFile}:`, err.message);
    }
  } else {
    // Fallback path: systemd --user isn't available, so XDG autostart is
    // the only login-launch mechanism available. Passes --hidden so a
    // login-triggered launch (see Task 1) doesn't show a window before the
    // user asks to see it — this is the ONLY difference from menuEntry above.
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

    try {
      if (!fs.existsSync(autostartFile)) {
        fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
        fs.writeFileSync(autostartFile, autostartEntry, { mode: 0o644 });
      }
    } catch (err) {
      console.error(`Could not write ${autostartFile}:`, err.message);
    }
  }
}
```

Note the call to `ensureSystemdService()` — implemented in Task 3, and now returning `true`/`false` so `ensureOsIntegration()` can decide whether systemd owns login-launch. Leave that call in place now; Task 3 defines the function it calls.

- [ ] **Step 2: Verify existing `.desktop` files are never clobbered, and that the autostart entry is written only when systemd isn't available**

Run: `cat ~/.local/share/applications/jarvis-os.desktop` (if it already exists from a prior run, its content should be untouched — confirm no `--hidden` is present).
To test a genuinely fresh write, temporarily move existing files aside first:
```bash
mv ~/.local/share/applications/jarvis-os.desktop /tmp/jarvis-menu.desktop.bak 2>/dev/null || true
mv ~/.config/autostart/jarvis-os.desktop /tmp/jarvis-autostart.desktop.bak 2>/dev/null || true
```
Run: `cd desktop-electron && ./launch.sh --hidden` (then quit via tray).
Expected on this machine (systemd --user available): `cat ~/.local/share/applications/jarvis-os.desktop` has no `--hidden` in its `Exec=` line; `~/.config/autostart/jarvis-os.desktop` does **not** exist (systemd owns login-launch, so it's never written — and is actively removed if a stale copy is found instead).

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
- Produces: `ensureSystemdService()` — called once from `ensureOsIntegration()` (Task 2), returns `true`/`false` (installed vs. unavailable/failed) so the caller can decide whether to fall back to XDG autostart; no other module depends on it.

- [ ] **Step 1: Add the `child_process` import**

At the top of `desktop-electron/main.js`, alongside the other `require`s:

```js
const { execSync } = require('child_process');
```

- [ ] **Step 2: Implement `ensureSystemdService()`**

> **Correction (2026-07-20):** the code block below now differs from what originally shipped in two ways, both fixes from the same live-testing round noted in Task 2's correction: (1) the function returns `true`/`false` (installed-or-already-present vs. unavailable/failed) so `ensureOsIntegration()` (Task 2) can decide whether systemd owns login-launch instead of the XDG autostart entry; (2) it runs `systemctl --user enable` alone, **not** `enable --now`. This function only ever executes from inside the app's own `whenReady()` — i.e. an instance is already running — so `--now` guaranteed the newly-installed unit immediately raced the very process installing it. `enable` alone arms the unit for the *next* login or crash instead, which means on a fresh install the systemd-supervised instance only becomes "the" instance starting from then — that's expected, not a bug.

Add this function right after `ensureOsIntegration()`:

```js
// Real crash-restart supervision AND (per ensureOsIntegration above) the
// sole at-login launcher whenever systemd --user is available — replacing
// the XDG autostart entry rather than running alongside it, to avoid two
// independent launchers racing requestSingleInstanceLock() at login.
//
// Returns true if jarvis-os.service is installed (already, or just now)
// and can be trusted to own login-launch; false if systemd --user isn't
// available or installation failed, in which case the caller falls back
// to XDG autostart.
function ensureSystemdService() {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'jarvis-os.service');
  if (fs.existsSync(unitPath)) return true;

  try {
    execSync('systemctl --user --version', { stdio: 'ignore' });
  } catch {
    console.log('[main] systemd --user not available; falling back to XDG autostart only.');
    return false;
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
    // Deliberately `enable` only, NOT `enable --now` — see the correction
    // note above this code block for why.
    execSync('systemctl --user enable jarvis-os.service', { stdio: 'ignore' });
    console.log('[main] Installed and enabled jarvis-os.service (systemd --user); will take effect at next login or crash restart, not immediately.');
    return true;
  } catch (err) {
    console.error('[main] Could not install systemd user service:', err.message);
    return false;
  }
}
```

- [ ] **Step 3: Verify the unit gets written and enabled (but not started) on first run**

```bash
rm -f ~/.config/systemd/user/jarvis-os.service
systemctl --user disable jarvis-os.service 2>/dev/null || true
cd desktop-electron && ./launch.sh --hidden
sleep 2
```
Run: `systemctl --user is-enabled jarvis-os.service` and `systemctl --user is-active jarvis-os.service`.
Expected: `is-enabled` prints `enabled`; `is-active` prints something other than `active` (e.g. `inactive`) — the unit is armed for next login/crash but was deliberately not started now (`enable`, not `enable --now`), since an instance is already running and starting a second one would race it. `cat ~/.config/systemd/user/jarvis-os.service` shows `Restart=on-failure` and `ExecStart=".../launch.sh" --hidden`.

- [ ] **Step 4: Verify real crash-restart supervision**

Since Step 3 leaves the unit enabled-but-inactive rather than running, crash-restart supervision only actually engages once systemd has started the unit itself (next login, or after a manual `systemctl --user start jarvis-os.service`). To verify the behavior directly: `systemctl --user start jarvis-os.service`, wait a couple seconds, then run `pkill -9 -f "electron . --hidden"`.
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

**Type consistency:** `START_HIDDEN` (Task 1) is read only inside `createWindow()` (same file, module scope) — no cross-file signature to keep consistent. `ensureSystemdService()` (Task 3) is called from `ensureOsIntegration()` (Task 2) with no arguments; per the 2026-07-20 correction it now returns a boolean that `ensureOsIntegration()` uses to decide whether to write or remove the XDG autostart entry — consistent between both tasks.
