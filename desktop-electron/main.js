const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const path = require('path');

const SERVER_URL = 'http://localhost:3000';
const HEALTH_URL = 'http://localhost:3000/health';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30000;

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

async function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#04060f',
    title: 'Jarvis OS',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
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

  await win.loadFile(path.join(__dirname, 'loading.html'));

  const ready = await waitForServer(win);
  if (ready) {
    await win.loadURL(SERVER_URL);
  } else {
    await win.webContents.executeJavaScript(
      "document.getElementById('waiting').style.display='none'; document.getElementById('error').style.display='block';"
    );
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
