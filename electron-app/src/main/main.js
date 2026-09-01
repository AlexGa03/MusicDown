'use strict';

/**
 * @file src/main/main.js
 * @description Proceso principal de Electron.
 *
 * Orden de arranque:
 *   1. ensureYtDlp(app)           — Descarga / valida el binario yt-dlp.
 *   2. registerHandlers(ipcMain)  — Registra todos los handlers IPC ANTES de createWindow().
 *   3. createWindow()             — Crea la BrowserWindow y carga src/renderer/index.html.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const { ensureYtDlp, sanitizePath } = require('./ytdlp-manager.js');
const { registerHandlers }          = require('./ipc-download-handler.js');

// ─── Ajustes de entorno (Linux headless / virtualización) ─────────────────────

// Previene cuelgues en entornos sin GPU/OpenGL disponible
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ─── Ventana principal ────────────────────────────────────────────────────────

/** @type {BrowserWindow|null} */
let mainWindow = null;

function createWindow() {
  // ── Icono de la aplicación ────────────────────────────────────────────────
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
    backgroundColor: '#111827',   // bg-gray-900 — elimina flash blanco al cargar
    webPreferences: {
      nodeIntegration:             false,        // SEGURIDAD: Node.js NO accesible desde el renderer
      contextIsolation:            true,         // SEGURIDAD: contextos separados
      sandbox:                     true,         // SEGURIDAD: Renderer aislado en sandbox
      webSecurity:                 true,         // SEGURIDAD: Cumplimiento Same-Origin y CSP
      allowRunningInsecureContent: false,        // SEGURIDAD: Bloquea contenido HTTP en contexto seguro
      navigateOnDragDrop:          false,        // SEGURIDAD: Evita navegación arrastrando archivos/URLs
      preload:                     preloadPath,
    },
  });

  // ── Bloquear navegación interna no autorizada ────────────────────────────
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
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

  // ── Gestionar apertura de enlaces externos de forma segura ───────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') {
        shell.openExternal(url).catch(err => {
          console.warn('[security] Error al abrir enlace externo:', err.message);
        });
      } else {
        console.warn('[security] Bloqueada apertura de protocolo no seguro:', parsed.protocol);
      }
    } catch {
      console.warn('[security] URL inválida en setWindowOpenHandler');
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(indexHtml);

  // ── DevTools automático en desarrollo para interceptar errores del renderer ──
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    console.log('[main] DevTools abierto (modo detach).');
  }

  // Log de errores de carga del renderer
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[main] did-fail-load: code=${code} desc=${desc}`);
  });

  // Confirmar que el preload se ejecutó correctamente
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Renderer cargado OK.');
  });

  // Capturar excepciones no manejadas en el renderer
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] render-process-gone:', details.reason, details.exitCode);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Ciclo de vida de la app ──────────────────────────────────────────────────

app.whenReady().then(async () => {
  console.log('[main] app.whenReady() START');
  console.log('[main] userData:', sanitizePath(app.getPath('userData')));
  console.log('[main] downloads:', sanitizePath(app.getPath('downloads')));

  // ── 1. Inicializar yt-dlp (tolerante a fallos) ────────────────────────────
  try {
    const ytdlpPath = await ensureYtDlp(app);
    console.log('[main] yt-dlp OK:', sanitizePath(ytdlpPath));
  } catch (err) {
    console.error('[main] ensureYtDlp falló:', err.message);
    console.error('[main] La app seguirá ejecutándose. El error se mostrará en la UI al descargar.');
  }

  // ── 2. Registrar handlers IPC ANTES de createWindow() ────────────────────
  registerHandlers(ipcMain, app);
  console.log('[main] Handlers IPC registrados.');

  // ── 3. Crear la ventana ───────────────────────────────────────────────────
  createWindow();
  console.log('[main] Ventana creada.');
});

// Cerrar la app en todas las plataformas excepto macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// macOS: re-crear ventana al hacer clic en el ícono del Dock
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
