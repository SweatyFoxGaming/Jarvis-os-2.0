const { app, BrowserWindow, session, Tray, Menu, globalShortcut, Notification, ipcMain, nativeImage, desktopCapturer } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const SERVER_URL = 'http://localhost:3000';
const HEALTH_URL = 'http://localhost:3000/health';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30000;
const HOTKEY = 'CommandOrControl+Alt+J';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const LAUNCH_SCRIPT = path.join(__dirname, 'launch.sh');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Set by the autostart .desktop entry / systemd unit (see ensureOsIntegration
// below) so a login-triggered launch doesn't pop a window in front of the
// user before they've asked to see it. The app-menu entry passes no flag,
// so double-clicking the icon still opens visibly exactly as before.
const START_HIDDEN = process.argv.includes('--hidden');

// Without this, closing the window (which hides it into the tray rather
// than quitting — see the 'close' handler below) combined with launching
// the app again later (double-clicking the desktop icon, a hotkey, a fresh
// `launch.sh` run) spawns a completely separate second process tree instead
// of reusing the one already running hidden. Live-observed this exact
// failure mode: four separate Electron instances accumulated over a few
// hours of testing, and the oldest one — still alive, still holding the
// camera open from an earlier successful getUserMedia call — caused every
// later instance's own camera request to fail with NotReadableError
// ("already in use"), which had nothing to do with permissions or hardware
// and everything to do with this app fighting itself over the same device.
// requestSingleInstanceLock() makes a second launch attempt hand off to the
// already-running instance (see 'second-instance' below) and exit instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// This machine's GPU (an old Kepler-generation card, running the open-source
// nouveau driver since the proprietary NVIDIA driver dropped support for it)
// has flaky 3D acceleration — live-observed a real GPU process crash
// ("nouveau: kernel rejected pushbuf: No such device", exit_code=139).
// Electron auto-respawns the GPU process and the app keeps working, but
// there's no real need for hardware acceleration on what's just a dashboard
// UI, so trading it for stability outright is the better default here.
app.disableHardwareAcceleration();

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => {
      res.resume(); // drain, we only care that it responded at all
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(win) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await checkServerReady()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

// Writes the per-user app-menu .desktop entry (only if missing — never
// overwrites, so a user's own edits survive every future launch), then
// arranges for at-login launch. That launch mechanism is EITHER the
// systemd --user unit below OR, only as a fallback when systemd --user
// isn't available, the XDG autostart .desktop entry — never both. Live
// testing found that this machine's systemd-xdg-autostart-generator
// independently wraps an autostart .desktop file into its OWN transient
// systemd unit, so having both meant two systemd-adjacent launchers racing
// requestSingleInstanceLock() at every login with no guarantee that
// jarvis-os.service specifically ended up supervising the surviving
// instance — defeating the point of adding it (reliable crash-restart).
// Making systemd the sole login-launcher when it's available removes that
// race entirely. No sudo/system install involved anywhere here; every
// target path is per-user and always writable.
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
    // systemd now owns login-launch + crash supervision. Leaving a stale
    // XDG autostart entry around (from an older build of this code, or a
    // pre-fix run) would recreate the exact two-launcher race this fix
    // removes, so clean it up if present.
    try {
      if (fs.existsSync(autostartFile)) {
        fs.unlinkSync(autostartFile);
        console.log(`[main] Removed ${autostartFile}: jarvis-os.service now owns login-launch and crash supervision, so a separate XDG autostart entry would just race it again.`);
      }
    } catch (err) {
      console.error(`Could not remove stale ${autostartFile}:`, err.message);
    }
  } else {
    // Fallback path: systemd --user isn't available on this machine, so
    // XDG autostart is the only login-launch mechanism we have. Passes
    // --hidden so a login-triggered launch (see Task 1) doesn't show a
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

// Real crash-restart supervision AND (per ensureOsIntegration above) the
// sole at-login launcher whenever systemd --user is available — replacing
// the XDG autostart entry rather than running alongside it, to avoid two
// independent launchers racing requestSingleInstanceLock() at login (see
// the comment above ensureOsIntegration for the full failure mode this
// avoids).
//
// Returns true if jarvis-os.service is installed (either already, or
// installed just now) and can therefore be trusted to own login-launch;
// false if systemd --user isn't available or installation failed, in
// which case the caller falls back to XDG autostart.
function ensureSystemdService() {
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, 'jarvis-os.service');
  const unitFileExists = fs.existsSync(unitPath);

  if (unitFileExists) {
    // The unit file existing on disk isn't proof it's actually wired up to
    // fire at next login — a prior run could have written the file but then
    // thrown on the `enable` call below (transient systemctl error,
    // permissions blip, etc.), or something out-of-band could have disabled
    // it since (e.g. a manual `systemctl --user disable` that leaves the
    // file in place). Only trust "file exists" as "systemd owns
    // login-launch" if it's genuinely enabled right now; otherwise fall
    // through and retry enabling it below without rewriting the file.
    try {
      execSync('systemctl --user is-enabled jarvis-os.service', { stdio: 'ignore' });
      return true;
    } catch {
      console.log('[main] jarvis-os.service unit file exists but is not enabled; retrying enable instead of trusting the stale file.');
    }
  }

  try {
    execSync('systemctl --user --version', { stdio: 'ignore' });
  } catch {
    console.log('[main] systemd --user not available; falling back to XDG autostart only.');
    return false;
  }

  if (!unitFileExists) {
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
    } catch (err) {
      console.error('[main] Could not install systemd user service:', err.message);
      return false;
    }
  }

  try {
    // Deliberately `enable` only, NOT `enable --now`: this function only ever
    // runs from inside the app's own whenReady() — i.e. an instance is
    // already running — so `--now` would immediately start a second instance
    // racing the one currently installing the unit, the exact kind of race
    // this design is meant to eliminate. `enable` arms the unit for the next
    // login or crash instead; the systemd-supervised instance only becomes
    // "the" instance starting from then.
    execSync('systemctl --user enable jarvis-os.service', { stdio: 'ignore' });
    console.log('[main] Installed and enabled jarvis-os.service (systemd --user); will take effect at next login or crash restart, not immediately.');
    return true;
  } catch (err) {
    console.error('[main] Could not enable systemd user service:', err.message);
    return false;
  }
}

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

  // Auto-grant microphone/camera to our own locally-hosted dashboard — this
  // window only ever navigates within SERVER_URL, so there's no other origin
  // to accidentally hand permissions to. This is the actual point of wrapping
  // the dashboard in a dedicated window: a fresh embedded webview has no
  // browser-profile history of a denied/blocked mic permission to get stuck on.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const requestingUrl = webContents.getURL();
    if (requestingUrl.startsWith(SERVER_URL) && (permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture')) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // setPermissionRequestHandler above covers the async permission prompt
  // getUserMedia() triggers, but Electron also runs a separate SYNCHRONOUS
  // check for the same permission types (e.g. from navigator.permissions
  // .query(), and on some Chromium versions as a precondition before the
  // async request handler is even consulted) — Electron's own security
  // guidance is to set both together. Leaving this unset was a real gap:
  // it could deny camera/mic before the request handler above ever got a
  // chance to grant it, surfacing as a generic "Visual sensor connection
  // failed" / "Microphone access denied" in the dashboard regardless of
  // what the request handler said.
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return requestingOrigin.startsWith(SERVER_URL) && (permission === 'media' || permission === 'audioCapture' || permission === 'videoCapture');
  });

  // Closing the window (the X button) hides it instead of quitting, so the
  // app keeps running in the tray — the standard tray-app pattern. Only the
  // tray's own "Quit" item (or the hotkey-driven equivalent) actually exits.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  await mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  const ready = await waitForServer(mainWindow);
  if (ready) {
    await mainWindow.loadURL(SERVER_URL);
  } else {
    await mainWindow.webContents.executeJavaScript(
      "document.getElementById('waiting').style.display='none'; document.getElementById('error').style.display='block';"
    );
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH));
  tray.setToolTip('Jarvis OS');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Jarvis', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
}

app.whenReady().then(async () => {
  ensureOsIntegration();
  await createWindow();
  createTray();
  globalShortcut.register(HOTKEY, showWindow);
});

// Only shown to a native OS notification if the window isn't focused — if
// it is, the in-page toast (addNotification in index.html) is already
// visible, so a native popup on top of it would just be a duplicate.
ipcMain.on('notify', (event, { title, body }) => {
  if (mainWindow && mainWindow.isFocused()) return;
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON_PATH }).show();
});

// One still image, not a stream — matches the explicit on-demand-only
// design decision (see docs/superpowers/specs/2026-07-20-...design.md).
ipcMain.handle('capture-screen', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    if (!sources.length) return null;
    // toJPEG returns a Buffer; strip to base64 only, matching the
    // no-data-URL-prefix convention captureCameraFrame() already uses
    // client-side for camera frames.
    return sources[0].thumbnail.toJPEG(80).toString('base64');
  } catch (err) {
    console.error('[main] Screen capture failed:', err.message);
    return null;
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Fires in the already-running instance when a second launch attempt is
// made (see requestSingleInstanceLock() above, which makes that second
// attempt exit immediately instead of proceeding) — bring the existing
// window forward instead of silently doing nothing, so a user who launches
// the app again because they couldn't find its hidden tray icon still gets
// a visible result.
app.on('second-instance', () => {
  showWindow();
});

app.on('window-all-closed', () => {
  // Normally unreachable — the window hides rather than closes — but kept
  // as a safety net in case something force-destroys it outside our control.
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
});
