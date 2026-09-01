'use strict';

/**
 * @file ipc-download-handler.js
 * @description Orquestador de cola de descargas. Gestiona el ciclo de vida
 * completo: cola, spawn de yt-dlp, parseo de streams y eventos IPC.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  CANALES IPC  (renderer → main, via ipcRenderer.invoke)                  │
 * ├───────────────────┬─────────────────────────────────────────────────────┤
 * │ app:addItems      │ [{ url, title? }] → añade a la cola interna          │
 * │ app:startQueue    │ {} → arranca el procesador de cola                   │
 * │ app:stop          │ {} → mata el proceso activo y cancela la cola         │
 * │ app:clear         │ {} → vacía la cola (solo si no hay descarga activa)  │
 * │ app:openFolder    │ {} → abre el dir de descargas con shell.openPath()   │
 * │ app:getStatus     │ {} → devuelve estado actual del manager              │
 * │ app:playlistAnswer│ { url, downloadAll: boolean } → resuelve el prompt   │
 * └───────────────────┴─────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  EVENTOS IPC  (main → renderer, via webContents.send)                    │
 * ├───────────────────┬─────────────────────────────────────────────────────┤
 * │ app:log           │ { level, msg, ts }                                   │
 * │ app:progress      │ { index, total, title, percent, speed, eta }         │
 * │ app:queueUpdate   │ { queue: QueueItem[], active: boolean }              │
 * │ app:done          │ { index, total, title, outputPath }                  │
 * │ app:error         │ { index, total, title, message }                     │
 * │ app:queueDone     │ { completed, errors }                                │
 * │ app:playlistPrompt│ { url, title } — renderer debe responder por invoke  │
 * └───────────────────┴─────────────────────────────────────────────────────┘
 *
 * @typedef {{ url: string, title: string, isPlaylist: boolean,
 *             status: 'pending'|'active'|'done'|'error' }} QueueItem
 */

const { spawn }  = require('child_process');
const { shell }  = require('electron');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const { getBinaryPath, getFfmpegPath, getOutputDir, sanitizePath } = require('./ytdlp-manager.js');

// ─── Utilidades ───────────────────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32';

/**
 * Sanitiza una cadena de entrada eliminando caracteres de control y limitando la longitud.
 * @param {any} input
 * @param {number} [maxLength=2048]
 * @returns {string}
 */
function sanitizeInputString(input, maxLength = 2048) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Detecta si una cadena es una URL de YouTube con parámetro de playlist.
 * @param {string} s
 * @returns {boolean}
 */
function isPlaylistUrl(s) {
  return /list=/.test(s) && /youtube\.com|youtu\.be/.test(s);
}

/**
 * Detecta si una cadena es una URL de YouTube (no necesariamente playlist).
 * @param {string} s
 * @returns {boolean}
 */
function isYouTubeUrl(s) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(s);
}

/**
 * Normaliza una entrada del usuario al formato { url, title, isPlaylist }.
 * - URL de YouTube válida → usa tal cual.
 * - Texto libre           → convierte a ytsearch1:<texto>.
 * @param {string} input
 * @returns {{ url: string, title: string, isPlaylist: boolean, status: string }|null}
 */
function normalizeInput(input) {
  const s = sanitizeInputString(input);
  if (!s) return null;

  const isPlaylist = isPlaylistUrl(s);
  const isUrl      = isYouTubeUrl(s);

  return {
    url:        isUrl ? s : `ytsearch1:${s}`,
    title:      s.length > 70 ? s.substring(0, 67) + '...' : s,
    isPlaylist,
    status:     'pending',
  };
}

// ─── Estado global del orquestador ───────────────────────────────────────────

/** @type {QueueItem[]} Cola principal de descargas. */
let _queue = [];

/** @type {import('child_process').ChildProcess|null} Proceso activo. */
let _activeChild = null;

/** Flag para abortar el bucle de cola. */
let _stopRequested = false;

/** @type {Map<string, { resolve: Function, reject: Function }>}
 *  Promesas pendientes de confirmación de playlist. */
const _playlistPrompts = new Map();

// ─── Helper de envío IPC seguro ───────────────────────────────────────────────

/**
 * Envía un evento IPC al renderer de forma segura (sin throw si isDestroyed).
 * @param {Electron.WebContents} wc
 * @param {string} channel
 * @param {any} payload
 */
function emit(wc, channel, payload) {
  try {
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  } catch (e) {
    console.warn(`[ipc] emit('${channel}') falló:`, e.message);
  }
}

/** Emite un log con timestamp y mensaje sanitizado. */
function log(wc, msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('es-ES', { hour12: false });
  const sanitizedMsg = sanitizePath(typeof msg === 'string' ? msg : JSON.stringify(msg));
  console.log(`[${level.toUpperCase()}] ${sanitizedMsg}`);
  emit(wc, 'app:log', { level, msg: sanitizedMsg, ts });
}

/** Emite el estado actual de la cola. */
function broadcastQueue(wc) {
  emit(wc, 'app:queueUpdate', {
    queue:  _queue,
    active: _activeChild !== null,
  });
}

// ─── Construcción de argumentos CLI ──────────────────────────────────────────

/**
 * Construye el array de flags para yt-dlp según la especificación.
 * Utiliza '--' antes de la URL para evitar Argument/Option Injection.
 *
 * @param {string} url
 * @param {object} opts
 * @param {boolean} [opts.downloadAll=false]   Para playlists: descarga completa vs solo canción.
 * @param {string}  [opts.outputDir]           Directorio de salida.
 * @param {string}  [opts.ffmpegLocation]      Ruta a ffmpeg.
 * @returns {string[]}
 */
function buildArgs(url, opts = {}) {
  const {
    downloadAll    = false,
    outputDir      = getOutputDir() || path.join(os.tmpdir(), 'MusicDown'),
    ffmpegLocation = getFfmpegPath(),
  } = opts;

  // Garantizar que el directorio de salida existe y es escribible
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch { /* ya existe */ }

  const args = [
    '--newline',
    '--no-colors',
    '--progress',
  ];

  // Control de playlist
  args.push(downloadAll ? '--yes-playlist' : '--no-playlist');

  // Extracción de audio (solo si ffmpeg disponible)
  if (ffmpegLocation && typeof ffmpegLocation === 'string') {
    args.push(
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', ffmpegLocation,
    );
  } else {
    // Fallback sin conversión: descarga el mejor audio disponible
    console.warn('[ipc] ffmpeg no disponible. Descargando sin conversión a MP3.');
    args.push('-f', 'bestaudio');
  }

  args.push('-o', path.join(outputDir, '%(title)s.%(ext)s'));

  // SEGURIDAD: Separador de fin de opciones para evitar que URLs o búsquedas
  // con guiones sean interpretadas como flags por yt-dlp.
  args.push('--', url);

  return args;
}

// ─── Parseo de stdout de yt-dlp ──────────────────────────────────────────────

// [download]  45.2% of ~  4.20MiB at  1.23MiB/s ETA 00:02
const RE_PROGRESS    = /\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+([\d:]+)/;
// [download] Destination: /path/to/file.webm
const RE_DESTINATION = /\[download\]\s+Destination:\s+(.+)/;
// [ExtractAudio] Destination: /path/to/file.mp3
const RE_EXTRACT     = /\[ExtractAudio\].*Destination:\s+(.+)/;
// [ffmpeg] Destination: ...
const RE_FFMPEG      = /\[ffmpeg\].*Destination:\s+(.+)/;

/**
 * Parsea una línea de stdout de yt-dlp.
 * @param {string} raw
 * @returns {{ type: string, [k: string]: any }|null}
 */
function parseLine(raw) {
  const line = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
  if (!line) return null;

  let m;
  if ((m = line.match(RE_PROGRESS)))
    return { type: 'progress', percent: parseFloat(m[1]), speed: m[2], eta: m[3] };
  if ((m = line.match(RE_EXTRACT)) || (m = line.match(RE_FFMPEG)))
    return { type: 'finalDest', outputPath: m[1].trim() };
  if ((m = line.match(RE_DESTINATION)))
    return { type: 'destination', outputPath: m[1].trim() };
  return { type: 'raw', text: line };
}

// ─── Spawn de un item ─────────────────────────────────────────────────────────

/**
 * Descarga un solo item de la cola. La Promise siempre se resuelve
 * (nunca rechaza) para que el bucle de cola pueda continuar.
 *
 * @param {Electron.WebContents} wc
 * @param {QueueItem} item
 * @param {number} index   Posición en la cola (0-based).
 * @param {number} total   Total de items.
 * @param {object} [opts]  Opciones adicionales (downloadAll, outputDir).
 * @returns {Promise<{ outputPath: string|null, exitCode: number|null }>}
 */
function runDownload(wc, item, index, total, opts = {}) {
  return new Promise((resolve) => {
    const binary = getBinaryPath();

    // ── [IPC RECEIVED] ──────────────────────────────────────────────────────
    console.log(`[IPC RECEIVED] runDownload | item ${index + 1}/${total}: ${item.url}`);

    // ── [BINARY CHECK] ──────────────────────────────────────────────────────
    console.log(`[BINARY CHECK] getBinaryPath() = ${binary}`);

    if (!binary || !fs.existsSync(binary)) {
      const msg = `[BINARY CHECK] ERROR: binario yt-dlp no disponible (${binary}).`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      return resolve({ outputPath: null, exitCode: -1 });
    }

    const args = buildArgs(item.url, opts);

    // ── [SPAWN COMMAND] ─────────────────────────────────────────────────────
    console.log('[SPAWN COMMAND]:', binary);
    console.log('[SPAWN COMMAND] args:', args.join(' '));
    log(wc, `Iniciando: ${item.title}`, 'info');

    let child;
    try {
      child = spawn(binary, args, {
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env:         { ...process.env, TERM: 'dumb' }, // Evita prompts de terminal
      });
    } catch (spawnErr) {
      const msg = `[CHILD ERROR] spawn() excepción: ${spawnErr.message}`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      return resolve({ outputPath: null, exitCode: -1 });
    }

    if (!child || child.pid === undefined) {
      const msg = `[CHILD ERROR] spawn() sin PID. Ejecutable inválido: ${binary}`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      return resolve({ outputPath: null, exitCode: -1 });
    }

    console.log(`[SPAWN COMMAND] PID: ${child.pid}`);
    _activeChild = child;

    let outputPath = null;
    let stdBuf     = '';

    // ── [RAW STDOUT] ────────────────────────────────────────────────────────
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // Log crudo para diagnóstico (preview de 200 chars)
      const preview = chunk.replace(/\n/g, '\\n').replace(/\r/g, '\\r').substring(0, 200);
      console.log(`[RAW STDOUT] ${preview}`);

      stdBuf += chunk;
      const parts = stdBuf.split('\n');
      stdBuf = parts.pop(); // fragmento incompleto

      for (const raw of parts) {
        const parsed = parseLine(raw);
        if (!parsed) continue;

        if (parsed.type === 'progress') {
          emit(wc, 'app:progress', {
            index, total,
            title:   item.title,
            percent: parsed.percent,
            speed:   parsed.speed,
            eta:     parsed.eta,
          });
        } else if (parsed.type === 'finalDest') {
          outputPath = parsed.outputPath;
          log(wc, `Convirtiendo: ${path.basename(outputPath)}`, 'info');
        } else if (parsed.type === 'destination') {
          outputPath = parsed.outputPath;
          log(wc, `Descargando: ${path.basename(outputPath)}`, 'info');
        } else if (parsed.type === 'raw' && parsed.text) {
          log(wc, parsed.text, 'info');
        }
      }
    });

    // ── [RAW STDERR] ────────────────────────────────────────────────────────
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      chunk.split(/[\n\r]/)
        .map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim())
        .filter(Boolean)
        .forEach(line => {
          console.error(`[RAW STDERR] ${line}`);
          log(wc, line, 'error');
        });
    });

    // ── [CHILD ERROR] ───────────────────────────────────────────────────────
    child.on('error', (err) => {
      _activeChild = null;
      const msg = `[CHILD ERROR] ${err.code ?? 'ERR'}: ${err.message}`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      resolve({ outputPath: null, exitCode: -1 });
    });

    // ── [CHILD CLOSED WITH CODE] ────────────────────────────────────────────
    child.on('close', (code, signal) => {
      _activeChild = null;
      console.log(`[CHILD CLOSED WITH CODE]: ${code} | signal: ${signal} | outputPath: ${outputPath}`);

      if (code === 0 || code === null) {
        log(wc, `✓ Completado: ${item.title}`, 'success');
        emit(wc, 'app:done', { index, total, title: item.title, outputPath });
        resolve({ outputPath, exitCode: code ?? 0 });
      } else {
        const msg = `yt-dlp salió con código ${code}${signal ? ` (signal: ${signal})` : ''}`;
        console.error(`[CHILD CLOSED WITH CODE] ERROR: ${msg}`);
        log(wc, `✗ Error: ${item.title} — ${msg}`, 'error');
        emit(wc, 'app:error', { index, total, title: item.title, message: msg });
        // Resolvemos (no rechazamos) para que la cola continúe
        resolve({ outputPath: null, exitCode: code });
      }
    });
  });
}

// ─── Gestor de confirmación de playlists ──────────────────────────────────────

/**
 * Emite un evento de confirmación de playlist al renderer y espera
 * la respuesta del usuario vía `app:playlistAnswer`.
 * Timeout de 60 s: si el usuario no responde, se descarga solo la canción.
 *
 * @param {Electron.WebContents} wc
 * @param {QueueItem} item
 * @returns {Promise<boolean>} true = descargar playlist completa.
 */
function askPlaylistPreference(wc, item) {
  return new Promise((resolve) => {
    const key     = item.url;
    const timeout = setTimeout(() => {
      _playlistPrompts.delete(key);
      console.warn('[ipc] Timeout en confirmación de playlist. Descargando solo canción.');
      resolve(false);
    }, 60_000);

    _playlistPrompts.set(key, {
      resolve: (downloadAll) => {
        clearTimeout(timeout);
        _playlistPrompts.delete(key);
        resolve(downloadAll);
      },
    });

    emit(wc, 'app:playlistPrompt', { url: item.url, title: item.title });
  });
}

// ─── Procesador de cola ───────────────────────────────────────────────────────

/**
 * Procesa la cola completa de forma secuencial con async/await real.
 * Usa setImmediate para no bloquear el event loop al arrancar.
 *
 * @param {Electron.WebContents} wc
 * @param {string} [outputDir]  Directorio de descarga (override).
 */
async function processQueue(wc, outputDir) {
  _stopRequested = false;
  let completed  = 0;
  let errors     = 0;
  const total    = _queue.filter(i => i.status === 'pending').length;

  console.log(`[ipc] Cola iniciada: ${total} item(s) pendientes.`);
  log(wc, `Cola iniciada: ${total} canción(es) en cola.`, 'info');

  for (let i = 0; i < _queue.length; i++) {
    if (_stopRequested) {
      log(wc, '⏹ Cola detenida por el usuario.', 'warn');
      break;
    }

    const item = _queue[i];
    if (item.status !== 'pending') continue;

    item.status = 'active';
    broadcastQueue(wc);

    // Preguntar preferencia de playlist cuando sea el turno
    let downloadAll = false;
    if (item.isPlaylist) {
      log(wc, `⚠️  Playlist detectada: ${item.title}. Esperando decisión...`, 'warn');
      downloadAll = await askPlaylistPreference(wc, item);
      log(wc, `Playlist: ${downloadAll ? 'descargando completa' : 'solo canción actual'}.`, 'info');
    }

    const result = await runDownload(wc, item, completed, total, {
      downloadAll,
      outputDir: outputDir || getOutputDir(),
    });

    if (result.exitCode === 0 || result.exitCode === null) {
      item.status = 'done';
      completed++;
    } else {
      item.status = 'error';
      errors++;
    }

    broadcastQueue(wc);
  }

  log(wc, `🏁 Cola finalizada. ✓ ${completed} completadas, ✗ ${errors} errores.`, 'info');
  emit(wc, 'app:queueDone', { completed, errors });

  // Limpiar items procesados (done/error) de la cola
  _queue = _queue.filter(i => i.status === 'pending');
  broadcastQueue(wc);
}

// ─── Registro de handlers IPC ─────────────────────────────────────────────────

/**
 * Registra todos los canales IPC con validación estricta de parámetros.
 * Llamar UNA SOLA VEZ en `main.js`, ANTES de `createWindow()`.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {Electron.App}     app
 */
function registerHandlers(ipcMain, app) {

  // ── app:addItems ──────────────────────────────────────────────────────────
  ipcMain.handle('app:addItems', (event, rawItems) => {
    if (!Array.isArray(rawItems) || rawItems.length === 0)
      return { added: 0, total: _queue.length };

    // Limitar tamaño de lote (máx 1000 items) para prevenir DoS
    const itemsToProcess = rawItems.slice(0, 1000);
    let added = 0;

    for (const raw of itemsToProcess) {
      if (!raw) continue;
      let input = '';
      if (typeof raw === 'string') {
        input = raw;
      } else if (typeof raw === 'object' && raw !== null) {
        input = typeof raw.url === 'string' ? raw.url : (typeof raw.title === 'string' ? raw.title : '');
      }
      const parsed = normalizeInput(input);
      if (!parsed) continue;

      // Deduplicar por URL
      if (_queue.some(q => q.url === parsed.url)) continue;
      _queue.push(parsed);
      added++;
    }

    const wc = event.sender;
    log(wc, `${added} elemento(s) añadidos a la cola. Total: ${_queue.length}.`, 'info');
    broadcastQueue(wc);
    return { added, total: _queue.length };
  });

  // ── app:startQueue ────────────────────────────────────────────────────────
  ipcMain.handle('app:startQueue', (event) => {
    const wc = event.sender;

    if (_activeChild) {
      log(wc, 'Ya hay una descarga activa. Detén primero.', 'warn');
      return { started: false, reason: 'Descarga activa' };
    }

    const pending = _queue.filter(i => i.status === 'pending');
    if (!pending.length) {
      log(wc, 'La cola está vacía.', 'warn');
      return { started: false, reason: 'Cola vacía' };
    }

    // Lanzar sin await para devolver el IPC inmediatamente
    setImmediate(() => {
      processQueue(wc).catch(err =>
        console.error('[ipc] Error en processQueue:', err.message)
      );
    });

    return { started: true, count: pending.length };
  });

  // ── app:stop ──────────────────────────────────────────────────────────────
  ipcMain.handle('app:stop', (event) => {
    _stopRequested = true;

    if (_activeChild && typeof _activeChild.pid === 'number') {
      try {
        if (IS_WIN) {
          // Windows: taskkill sin shell para prevenir Command Injection
          const { execFileSync } = require('child_process');
          execFileSync('taskkill', ['/pid', String(_activeChild.pid), '/f', '/t'], { windowsHide: true });
        } else {
          _activeChild.kill('SIGTERM');
        }
        console.log(`[ipc] Proceso ${_activeChild.pid} terminado.`);
      } catch (e) {
        console.warn('[ipc] kill() falló:', e.message);
      }
      _activeChild = null;
    }

    // Resetear items activos a pending para poder relanzar
    _queue.forEach(i => { if (i.status === 'active') i.status = 'pending'; });
    log(event.sender, 'Descarga detenida.', 'warn');
    broadcastQueue(event.sender);
    return { stopped: true };
  });

  // ── app:clear ─────────────────────────────────────────────────────────────
  ipcMain.handle('app:clear', (event) => {
    if (_activeChild) {
      log(event.sender, 'No se puede limpiar mientras hay una descarga activa.', 'warn');
      return { cleared: false };
    }
    _queue = [];
    log(event.sender, 'Cola limpiada.', 'info');
    broadcastQueue(event.sender);
    return { cleared: true };
  });

  // ── app:openFolder ────────────────────────────────────────────────────────
  ipcMain.handle('app:openFolder', async (event) => {
    const dir = getOutputDir();
    if (!dir) {
      log(event.sender, 'Directorio de descargas no disponible.', 'error');
      return { opened: false };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const result = await shell.openPath(dir);
      if (result) {
        log(event.sender, `No se pudo abrir carpeta: ${result}`, 'error');
        return { opened: false, error: result };
      }
      log(event.sender, `Carpeta abierta: ${sanitizePath(dir)}`, 'info');
      return { opened: true, dir: sanitizePath(dir) };
    } catch (err) {
      log(event.sender, `Error abriendo carpeta: ${err.message}`, 'error');
      return { opened: false, error: err.message };
    }
  });

  // ── app:getStatus ─────────────────────────────────────────────────────────
  ipcMain.handle('app:getStatus', () => ({
    binaryPath: sanitizePath(getBinaryPath()),
    ffmpegPath: sanitizePath(getFfmpegPath()),
    outputDir:  sanitizePath(getOutputDir()),
    queue:      _queue,
    active:     _activeChild !== null,
  }));

  // ── app:playlistAnswer ────────────────────────────────────────────────────
  ipcMain.handle('app:playlistAnswer', (_event, payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.url !== 'string') {
      return { ok: false, reason: 'Payload inválido.' };
    }
    const { url, downloadAll } = payload;
    const pending = _playlistPrompts.get(url);
    if (pending) {
      pending.resolve(Boolean(downloadAll));
      return { ok: true };
    }
    return { ok: false, reason: 'No había prompt pendiente para esa URL.' };
  });

  console.log('[ipc] Handlers registrados: app:addItems | app:startQueue | app:stop | app:clear | app:openFolder | app:getStatus | app:playlistAnswer');
}

module.exports = { registerHandlers };
