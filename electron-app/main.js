'use strict';

/**
 * @file src/main/main.js
 * @description Proceso principal de Electron.
 *
 * Secuencia de Inicialización Segura:
 *   1. registerHandlers(ipcMain, app) -> Registra canales IPC antes de la ventana.
 *   2. createWindow()                  -> Crea y muestra la BrowserWindow inmediatamente.
 *   3. ensureYtDlp(app)                -> Descarga/valida yt-dlp y emite eventos de estado en tiempo real.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const { ensureYtDlp, sanitizePath } = require('./ytdlp-manager.js');
const { registerHandlers }          = require('./ipc-download-handler.js');

// ─── Ajustes de Rendimiento y Virtualización ──────────────────────────────────

// Previene bloqueos en entornos headless, Docker y GPU virtuales
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ─── Ventana Principal ────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'logo.png')
    : path.join(__dirname, '..', '..', 'assets', 'logo.png');

  const preloadPath = path.join(__dirname, '..', 'preload.js');
  const indexHtml   = path.join(__dirname, '..', 'renderer', 'index.html');

  mainWindow = new BrowserWindow({
    width:           1100,
    height:          700,
    minWidth:        800,
    minHeight:       560,
    icon:            iconPath,
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration:             false,
      contextIsolation:            true,
      sandbox:                     true,
      webSecurity:                 true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop:          false,
      preload:                     preloadPath,
    },
  });

  // Bloquear navegación no autorizada fuera de la app
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl);
      if (parsedUrl.protocol !== 'file:') {
        event.preventDefault();
        console.warn('[security] Navegación bloqueada a protocolo externo:', parsedUrl.protocol);
      }
    } catch {
      event.preventDefault();
    }
  });

  // Control estricto de apertura de ventanas externas
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        shell.openExternal(url).catch(err => {
          console.warn('[security] Error al abrir enlace en navegador:', err.message);
        });
      }
    } catch {
      console.warn('[security] URL inválida detectada en setWindowOpenHandler');
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(indexHtml);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[main] Error al cargar renderer: code=${code} desc=${desc}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Proceso renderer finalizado de forma inesperada:', details.reason);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Ciclo de Vida de la Aplicación ──────────────────────────────────────────

app.whenReady().then(async () => {
  console.log('[main] app.whenReady() START');
  console.log('[main] userData:', app.getPath('userData'));
  console.log('[main] downloads:', app.getPath('downloads'));

  // 1. Registrar handlers IPC antes de crear la ventana
  registerHandlers(ipcMain, app);
  console.log('[main] Handlers IPC registrados correctamente.');

  // 2. Crear y renderizar la interfaz de usuario
  createWindow();
  console.log('[main] Ventana principal creada.');

  // 3. Inicializar motor yt-dlp y dependencias de forma asíncrona tolerante a fallos
  ensureYtDlp(app)
    .then((resolvedPath) => {
      console.log('[main] yt-dlp inicializado y verificado OK en:', resolvedPath);
    })
    .catch((err) => {
      console.error('[main] ensureYtDlp reportó error de inicialización:', err.message);
      console.log('[main] La aplicación continuará activa permitiendo reintentar desde la UI.');
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
