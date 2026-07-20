const { app, BrowserWindow, session, Tray, Menu, globalShortcut, Notification, ipcMain, nativeImage } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Writes the two per-user XDG .desktop files (app menu + autostart) if they
// don't already exist yet — never overwrites, so a user's own edits to
// either file survive every future launch. No sudo/system install involved;
// both target directories are per-user and always writable.
function ensureOsIntegration() {
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Jarvis OS',
    'Comment=Jarvis OS desktop console',
    `Exec="${LAUNCH_SCRIPT}"`,
    `Icon=${ICON_PATH}`,
    'Terminal=false',
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');

  const targets = [
    path.join(os.homedir(), '.local', 'share', 'applications', 'jarvis-os.desktop'),
    path.join(os.homedir(), '.config', 'autostart', 'jarvis-os.desktop'),
  ];

  for (const target of targets) {
    try {
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // .desktop entry files should NOT be executable themselves — only
      // launch.sh (the thing Exec= actually points at) needs that bit.
      // systemd-xdg-autostart-generator warns on every boot otherwise
      // ("marked executable, please remove executable permission bits").
      fs.writeFileSync(target, desktopEntry, { mode: 0o644 });
    } catch (err) {
      console.error(`Could not write ${target}:`, err.message);
    }
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
