'use strict';

/**
 * @file main.js
 * @description Proceso principal de Electron (Main Process).
 *
 * Orden de arranque:
 *   1. ensureYtDlp(app)           — descarga o actualiza el binario yt-dlp
 *   2. registerDownloadHandlers() — registra canales IPC ANTES de crear la ventana
 *   3. spawn(backendPath)         — lanza el backend Python (FastAPI)
 *   4. waitForBackend()           — espera health-check en :8000
 *   5. createWindow()             — crea la BrowserWindow con preload.js
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const { spawn } = require('child_process');
const axios  = require('axios');

// Extensiones .js explícitas: garantizan la resolución dentro de app.asar en producción.
// Node.js dentro del .asar no siempre resuelve extensiones omitidas correctamente.
const { ensureYtDlp, sanitizePath } = require('./ytdlp-manager.js');
const { registerDownloadHandlers }  = require('./ipc-download-handler.js');

// ─── Estado global ────────────────────────────────────────────────────────────

/** @type {import('child_process').ChildProcess|null} */
let backendProcess = null;

// ─── Ajustes de arranque ──────────────────────────────────────────────────────

// Deshabilitar aceleración GPU en entornos Linux sin drivers OpenGL
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Espera a que el backend Python responda en la URL indicada.
 * @param {string}  url              - URL de health-check.
 * @param {number} [timeout=15000]   - Tiempo máximo en ms.
 * @returns {Promise<true>}
 * @throws {Error} Si el backend no responde en el tiempo límite.
 */
async function waitForBackend(url, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await axios.get(url, { timeout: 2000 });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Backend no respondió en ${timeout}ms: ${url}`);
}

/**
 * Resuelve la ruta al ejecutable del backend Python.
 * Contempla empaquetado (AppImage / NSIS) y modo desarrollo.
 * @returns {string}
 */
function resolveBackendPath() {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? path.join(process.resourcesPath, '..', 'backend', 'backend.exe')
      : path.join(__dirname, 'dist', 'backend', 'backend.exe');
  }
  // Linux / macOS / AppImage
  return app.isPackaged
    ? path.join(process.resourcesPath, '..', 'backend', 'backend')
    : path.join(__dirname, 'dist', 'backend', 'backend');
}

/**
 * Resuelve la ruta al directorio del frontend compilado.
 * @returns {string}
 */
function resolveFrontendPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, '..', 'frontend')
    : path.join(__dirname, 'dist', 'frontend');
}

/**
 * Crea la ventana principal del renderer.
 * El preload.js expone `window.ytdlp` al renderer vía contextBridge.
 */
function createWindow() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'logo.png')
    : path.join(__dirname, 'assets', 'logo.png');

  const win = new BrowserWindow({
    width:  1200,
    height: 800,
    icon:   iconPath,
    webPreferences: {
      nodeIntegration:             false,
      contextIsolation:            true,
      sandbox:                     true,
      webSecurity:                 true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop:          false,
      preload:                     path.join(__dirname, 'preload.js'),
    },
  });

  // Interceptar navegación no autorizada
  win.webContents.on('will-navigate', (event, navigationUrl) => {
    try {
      const parsedUrl = new URL(navigationUrl);
      if (parsedUrl.protocol !== 'file:') {
        event.preventDefault();
        console.warn('[security] Bloqueada navegación no autorizada a:', parsedUrl.protocol);
      }
    } catch {
      event.preventDefault();
    }
  });

  // Gestionar apertura de enlaces externos
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        shell.openExternal(url).catch(err => {
          console.warn('[security] Error abriendo URL externa:', err.message);
        });
      } else {
        console.warn('[security] Bloqueada apertura de protocolo inseguro:', parsed.protocol);
      }
    } catch {
      console.warn('[security] URL inválida en setWindowOpenHandler');
    }
    return { action: 'deny' };
  });

  const indexPath = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'frontend', 'index.html')
    : path.join(__dirname, 'dist', 'frontend', 'index.html');

  win.loadFile(indexPath);
}

// ─── Ciclo de vida ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const backendPath  = resolveBackendPath();
  const frontendPath = resolveFrontendPath();

  console.log('[main] Backend listo (iniciando)...');

  // ── 1. Asegurar binario yt-dlp ────────────────────────────────────────────
  try {
    const ytdlpPath = await ensureYtDlp(app);
    console.log('[main] yt-dlp listo:', sanitizePath(ytdlpPath));
  } catch (err) {
    console.error('[main] No se pudo inicializar yt-dlp:', err.message);
  }

  // ── 2. Registrar handlers IPC ANTES de crear la ventana ───────────────────
  // Es crítico que los handlers estén registrados antes de que el renderer
  // cargue el HTML y pueda invocar ipcRenderer.invoke().
  registerDownloadHandlers(ipcMain);

  // ── 3. Lanzar el backend Python ────────────────────────────────────────────
  backendProcess = spawn(backendPath, ['--frontend-path', frontendPath], {
    stdio:       ['ignore', 'pipe', 'pipe'],
    windowsHide: true,   // En Windows, evita una ventana de consola CMD
  });

  backendProcess.stdout.on('data', (d) => console.log(`[BACKEND] ${d}`.trimEnd()));
  backendProcess.stderr.on('data', (d) => console.error(`[BACKEND ERR] ${d}`.trimEnd()));
  backendProcess.on('error', (err) => console.error('[BACKEND] Error de proceso:', err.message));

  // ── 4. Esperar al backend y abrir la ventana ───────────────────────────────
  try {
    await waitForBackend('http://127.0.0.1:8000');
    console.log('[main] Backend listo. Creando ventana...');
    createWindow();
  } catch (err) {
    console.error('[main] El backend no arrancó:', err.message);
    if (app.isPackaged) app.quit();
    else createWindow(); // En dev abrimos igual para ver errores en DevTools
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (backendProcess) backendProcess.kill();
    app.quit();
  }
});

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill();
});

// macOS: re-crear ventana si la app sigue activa y no hay ventanas abiertas
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
