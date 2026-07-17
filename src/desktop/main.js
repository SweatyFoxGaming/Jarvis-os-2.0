import { app, BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverProcess = null;
let mainWindow = null;
const PORT = 3000;

// Start the local offline JARVIS backend server
function startServer() {
    console.log('Launching JARVIS local cognitive core...');
    
    // Spawn the node server using standard node entry point
    const serverPath = path.join(__dirname, '..', 'server.js');
    
    serverProcess = spawn('node', [serverPath], {
        env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: PORT.toString()
        },
        stdio: 'inherit'
    });

    serverProcess.on('error', (err) => {
        console.error('Failed to launch cognitive server process:', err);
    });

    serverProcess.on('exit', (code) => {
        console.log(`Cognitive server process exited with code ${code}`);
    });
}

// Check if the local offline server is ready to accept connections
function checkServerReady(callback) {
    const client = new net.Socket();
    const tryConnect = () => {
        client.connect({ port: PORT, host: '127.0.0.1' }, () => {
            client.destroy();
            callback(true);
        });
    };

    client.on('error', () => {
        setTimeout(tryConnect, 200);
    });

    tryConnect();
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'JARVIS OS',
        backgroundColor: '#04060f',
        show: false, // Don't show until ready
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    // Load custom splash loading indicator
    mainWindow.loadURL(`data:text/html;charset=utf-8,
        <html>
            <head>
                <style>
                    body {
                        background-color: %2304060f;
                        color: %2338bdf8;
                        font-family: monospace;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                        overflow: hidden;
                    }
                    .spinner {
                        border: 3px solid rgba(56, 189, 248, 0.1);
                        width: 50px;
                        height: 50px;
                        border-radius: 50%;
                        border-left-color: %2338bdf8;
                        animation: spin 1s linear infinite;
                        margin-bottom: 20px;
                    }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    .tag { letter-spacing: 0.3em; font-size: 11px; text-transform: uppercase; margin-top: 10px; opacity: 0.7; }
                </style>
            </head>
            <body>
                <div class="spinner"></div>
                <div>INITIALIZING COGNITIVE INTERFACE...</div>
                <div class="tag">Phoenix Offline Kernel</div>
            </body>
        </html>
    `);

    mainWindow.show();

    // Check when server is ready, then load the actual local site
    checkServerReady((ready) => {
        if (ready && mainWindow) {
            mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
            mainWindow.webContents.on('did-fail-load', () => {
                // Retry if failed
                setTimeout(() => {
                    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
                }, 500);
            });
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('ready', () => {
    startServer();
    createWindow();
});

app.on('window-all-closed', () => {
    // Kill the local server process before exiting the app
    if (serverProcess) {
        console.log('Shutting down local cognitive core...');
        serverProcess.kill();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
