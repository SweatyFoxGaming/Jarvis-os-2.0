const { contextBridge, ipcRenderer } = require('electron');

// The ONLY thing exposed to the loaded page — a one-way "please show a
// native notification" call. No other main-process API is reachable from
// the page, keeping contextIsolation/nodeIntegration exactly as strict as
// before this was added.
contextBridge.exposeInMainWorld('jarvisDesktop', {
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
