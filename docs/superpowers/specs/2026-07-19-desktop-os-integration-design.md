# Desktop app OS integration

## Goal

The existing Electron shell (`desktop-electron/`) wraps the locally-running
dashboard in a real window, but has to be launched manually every time and
has no presence in the OS beyond that window. This adds: auto-start on
login, an app-menu/taskbar entry, a system tray icon, a global hotkey, and
native OS notifications — without requiring root/sudo and without giving up
on the app while it's still under active development.

## Approach

Per-user XDG integration, not a system package install:

- The app writes standard `.desktop` files into `~/.local/share/applications`
  (app menu / taskbar entry) and `~/.config/autostart` (login autostart) the
  first time it runs — only if missing, so a user's own edits are never
  clobbered on a later run.
- `Exec=` in both files points at a small stable `desktop-electron/launch.sh`
  wrapper (absolute path, resolved at write-time), not today's exact command
  — so the desktop entry keeps working across future code changes without
  regeneration.

Rejected alternatives: building/installing the `.deb` via `electron-builder`
+ `sudo dpkg -i` (real package-manager integration, but needs sudo and a
rebuild-and-reinstall cycle after every source change — bad fit for an app
still being iterated on); dropping Electron for a browser "app mode" +
systemd user service (throws away the mic/camera permission handling already
solved in `main.js`, and loses real tray/native-notification support).

## Components

**`desktop-electron/launch.sh`** (new) — resolves its own directory, `cd`s
into it, runs `electron .`. This is what every `.desktop` file's `Exec=`
points at, so it survives the repo being updated without needing to be
rewritten.

**`desktop-electron/main.js`** (modified):
- `ensureOsIntegration()`, called once at startup: writes the two
  `.desktop` files (autostart + app menu) if they don't already exist.
  Content is generated from a template with `Exec=/abs/path/launch.sh`,
  `Icon=/abs/path/icon.png`, `Name=Jarvis OS`, `Categories=Utility;`.
- `Tray` icon with a context menu (Show, Quit). Clicking the tray icon
  toggles the window's visibility.
- Window `close` event is intercepted: `event.preventDefault(); win.hide()`
  instead of quitting, so the app keeps running in the tray. A module-level
  `isQuitting` flag (set true only by the tray's Quit action) lets the real
  quit path skip this and close normally.
- `globalShortcut.register('CommandOrControl+Alt+J', ...)` shows/focuses the
  window (registered after `app.whenReady()`, unregistered on `will-quit`).
- Window opens immediately on launch (not hidden to tray), matching current
  behavior — the tray only matters for what happens after the first close.

**`desktop-electron/preload.js`** (new) — `contextBridge.exposeInMainWorld`
exposing exactly one function, `window.jarvisDesktop.notify(title, body)`,
which sends an IPC message to main. Keeps `contextIsolation: true` /
`nodeIntegration: false` as they are today; no other main-process API is
exposed to the page.

**`main.js` IPC handler** — on receiving a `notify` message, creates and
shows an Electron `Notification` **only if `win.isFocused()` is false** —
if the window is focused, the existing in-page toast (`addNotification` in
`index.html`) is already visible, so a native popup on top of it would be
redundant.

**`src/static/index.html`** (small addition) — wherever `addNotification(...)`
is already called (briefing updates, pending command proposals, security
findings, feature-request status changes — all existing call sites, no new
polling/detection logic), also call
`window.jarvisDesktop?.notify(title, message)` if that bridge exists (i.e.
running inside the Electron shell; a no-op in a plain browser tab).

**Icon** — none exists yet (`package.json`'s `build.linux` has no `icon`
field). A simple generated PNG matching the holographic UI's accent color
(`#A78BFA`), sized for both the tray (16/32px) and the app/taskbar icon
(256px), added under `desktop-electron/assets/`.

## Out of scope

- Building/installing the actual `.deb`/AppImage package (approach B, not
  chosen).
- Any change to what data is fetched or how often — this only adds a native
  notification alongside toasts that already exist today.
- Windows/macOS-specific autostart mechanisms — this machine is Linux, and
  XDG `.desktop` files aren't portable to those platforms; out of scope
  until/unless this app needs to run somewhere else.

## Testing

- Launch `launch.sh` directly, confirm the window opens immediately, confirm
  both `.desktop` files get created on first run and are left untouched on a
  second run.
- Confirm closing the window leaves the process running (check `docker`-style
  process list / tray icon still present) and the tray's Show re-opens it.
- Confirm `Ctrl+Alt+J` toggles the window from another application.
- Trigger a real backend event that already calls `addNotification` (e.g.
  propose a test command) and confirm a native OS notification appears only
  when the Electron window isn't focused.
- Log out/in (or restart the desktop session) to confirm autostart actually
  fires — the one piece that can't be verified by just running the app
  manually.
