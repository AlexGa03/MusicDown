'use strict';

/**
 * @file ipc-download-handler.js
 * @description Orquestador de descargas en el proceso principal de Electron.
 *
 * FLUJO:
 *   Frontend -> window.ytdlp.startQueue(items) -> IPC 'ytdlp:startQueue'
 *   -> _processQueue() -> _runDownload() x N (secuencial)
 *   -> spawn(yt-dlp) -> stdout/stderr parseados -> eventos IPC al renderer
 *   -> POST /notify/* al backend Python -> WebSocket -> frontend React
 *
 * CANALES IPC (renderer -> main):
 *   - 'ytdlp:startQueue'  payload: { items, options? } | [{url,title}]
 *   - 'ytdlp:download'    payload: { url, options? }   (descarga individual)
 *   - 'ytdlp:cancel'      payload: { pid? }            (sin pid = cancela todo)
 *   - 'ytdlp:status'      payload: {}
 *
 * EVENTOS IPC (main -> renderer):
 *   - 'ytdlp:progress'   { url, file, percent, speed, eta }
 *   - 'ytdlp:log'        { level: 'info'|'warn'|'error', msg }
 *   - 'ytdlp:done'       { url, outputPath }
 *   - 'ytdlp:error'      { url, message }
 *   - 'ytdlp:queueDone'  {}
 */

const { spawn }   = require('child_process');
const path        = require('path');
const os          = require('os');
const http        = require('http');
const fs          = require('fs');
const { getYtDlpPath, getFfmpegPath, getOutputDir, validateBinary, sanitizePath } = require('./ytdlp-manager.js');

// ─── Estado interno ───────────────────────────────────────────────────────────

/** pid -> ChildProcess. Todos los procesos yt-dlp activos. */
const _activeJobs = new Map();
/** Flag para abortar el bucle de cola. */
let _cancelQueue = false;

// ─── Helpers de Sanitización ──────────────────────────────────────────────────

function sanitizeInputString(input, maxLength = 2048) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// ─── Notificaciones HTTP al backend Python ────────────────────────────────────

/**
 * POST al backend Python para retransmitir eventos por WebSocket.
 * Totalmente non-blocking y tolerante a fallos (backend puede estar caido).
 * @param {string} endpoint - '/notify/progress' | '/notify/done' | '/notify/error'
 * @param {object} payload
 */
function _notifyBackend(endpoint, payload) {
  try {
    const body = JSON.stringify(payload);
    const req  = http.request({
      hostname: '127.0.0.1', port: 8000, path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => { /* silencioso */ });
    req.write(body);
    req.end();
  } catch { /* silencioso */ }
}

// ─── Parseo de stdout de yt-dlp ──────────────────────────────────────────────

// [download]  45.2% of ~ 4.20MiB at 1.23MiB/s ETA 00:02
const RE_PROGRESS    = /\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+([\d:]+)/;
// [download] Destination: /path/to/file.webm
const RE_DESTINATION = /\[download\]\s+Destination:\s+(.+)/;
// [ExtractAudio] Destination: /path/to/file.mp3
// [ffmpeg] Destination: /path/to/file.mp3
const RE_FINAL_DEST  = /\[(?:ExtractAudio|ffmpeg)\].*Destination:\s+(.+)/;

/**
 * Parsea una línea de stdout de yt-dlp (con strip de ANSI).
 * @param {string} raw
 * @returns {{ type: string, [key: string]: any } | null}
 */
function _parseLine(raw) {
  // Strip completo de secuencias ANSI y caracteres de control de cursor
  const line = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '').trim();
  if (!line) return null;

  let m;
  if ((m = line.match(RE_PROGRESS)))
    return { type: 'progress', percent: parseFloat(m[1]), speed: m[2], eta: m[3] };
  if ((m = line.match(RE_FINAL_DEST)))
    return { type: 'finalDest', outputPath: m[1].trim() };
  if ((m = line.match(RE_DESTINATION)))
    return { type: 'destination', outputPath: m[1].trim() };

  return { type: 'raw', text: line };
}

// ─── Construcción de argumentos CLI ──────────────────────────────────────────

/**
 * Construye los flags CLI para yt-dlp.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.outputDir]
 * @param {string} [opts.format]
 * @param {string} [opts.audioCodec]
 * @param {string} [opts.audioQuality]
 * @param {string} [opts.ffmpegLocation]
 * @param {boolean} [opts.extractAudio=true]
 * @returns {string[]}
 */
function _buildArgs(url, opts = {}) {
  const {
    outputDir      = getOutputDir() || path.join(os.tmpdir(), 'MusicDown'),
    format         = 'bestaudio/best',
    audioCodec     = 'mp3',
    audioQuality   = '192',
    ffmpegLocation = getFfmpegPath(),
    extractAudio   = true,
  } = opts;

  // Garantizar que el directorio de salida existe
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch { /* si ya existe, ok */ }

  const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

  const args = [
    '--format',         format,
    '--output',         outputTemplate,
    '--no-playlist',
    '--no-warnings',
    '--ignore-errors',
    '--no-color',
    '--newline',
    '--progress',
    '--socket-timeout', '15',
  ];

  // Solo añadir extraccion de audio si ffmpeg esta disponible
  if (extractAudio && ffmpegLocation && typeof ffmpegLocation === 'string') {
    args.push(
      '--extract-audio',
      '--audio-format',  audioCodec,
      '--audio-quality', audioQuality,
      '--ffmpeg-location', ffmpegLocation,
    );
  } else if (extractAudio && !ffmpegLocation) {
    console.warn('[DEBUG-DOWNLOAD] extractAudio solicitado pero ffmpeg no disponible. Descargando sin conversion.');
  }

  // Separador de fin de opciones para evitar Argument Injection
  args.push('--', url);

  return args;
}

// ─── Spawn con logging completo ───────────────────────────────────────────────

/**
 * Lanza yt-dlp para una URL. Devuelve una Promise que siempre se resuelve
 * (nunca rechaza) para que la cola pueda continuar con el siguiente item.
 *
 * @param {Electron.WebContents} sender
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<{ outputPath: string|null, error?: string }>}
 */
function _runDownload(sender, url, opts = {}) {
  return new Promise((resolve) => {
    // ── [IPC RECEIVED] ──────────────────────────────────────────────────────
    console.log('[IPC RECEIVED] _runDownload iniciado para:', url);

    // ── [BINARY CHECK] ──────────────────────────────────────────────────────
    const binaryPath = getYtDlpPath();
    console.log(`[BINARY CHECK] getYtDlpPath() = ${binaryPath}`);

    if (!binaryPath) {
      const msg = '[BINARY CHECK] ERROR: binaryPath es null. ensureYtDlp() no se ejecuto correctamente.';
      console.error(msg);
      _sendSafe(sender, 'ytdlp:error', { url, message: msg });
      return resolve({ outputPath: null, error: msg });
    }

    if (!fs.existsSync(binaryPath)) {
      const msg = `[BINARY CHECK] ERROR: El binario no existe en disco: ${binaryPath}`;
      console.error(msg);
      _sendSafe(sender, 'ytdlp:error', { url, message: msg });
      return resolve({ outputPath: null, error: msg });
    }

    // Validacion rapida del binario antes del spawn
    const validation = validateBinary(binaryPath);
    if (!validation.valid) {
      const msg = `[BINARY CHECK] ERROR: Binario invalido: ${validation.error}`;
      console.error(msg);
      _sendSafe(sender, 'ytdlp:error', { url, message: msg });
      return resolve({ outputPath: null, error: msg });
    }
    console.log(`[BINARY CHECK] OK. Version: ${validation.version}`);

    // ── [SPAWN COMMAND] ─────────────────────────────────────────────────────
    const args = _buildArgs(url, opts);
    console.log('[SPAWN COMMAND]:', binaryPath);
    console.log('[SPAWN COMMAND] args:', args.join(' '));

    _sendSafe(sender, 'ytdlp:log', {
      level: 'info',
      msg: `Spawning: ${path.basename(binaryPath)} ${args.slice(0, 3).join(' ')} ...`,
    });

    let child;
    try {
      child = spawn(binaryPath, args, {
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // env: no heredamos nada extra que pueda causar prompts interactivos
        env: { ...process.env, TERM: 'dumb' },
      });
    } catch (spawnErr) {
      const msg = `[CHILD ERROR] spawn() lanzó excepción síncrona: ${spawnErr.message}`;
      console.error(msg);
      _sendSafe(sender, 'ytdlp:error', { url, message: msg });
      return resolve({ outputPath: null, error: msg });
    }

    // Verificar que se asignó PID (spawn() puede fallar silenciosamente con PID undefined)
    if (!child || child.pid === undefined) {
      const msg = `[CHILD ERROR] spawn() no asignó PID. El ejecutable no existe o no es válido: ${binaryPath}`;
      console.error(msg);
      _sendSafe(sender, 'ytdlp:error', { url, message: msg });
      return resolve({ outputPath: null, error: msg });
    }

    console.log(`[SPAWN COMMAND] PID asignado: ${child.pid}`);
    _activeJobs.set(child.pid, child);

    let currentOutputPath = null;
    let stdoutBuf = '';

    // ── [RAW STDOUT] ────────────────────────────────────────────────────────
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      // Log de stdout crudo (limitado a 200 chars para no saturar la consola)
      const preview = chunk.replace(/\n/g, '\\n').replace(/\r/g, '\\r').substring(0, 200);
      console.log(`[RAW STDOUT] ${preview}`);

      stdoutBuf += chunk;
      const parts = stdoutBuf.split('\n');
      stdoutBuf = parts.pop(); // posible línea incompleta

      for (const raw of parts) {
        const parsed = _parseLine(raw);
        if (!parsed) continue;

        if (parsed.type === 'progress') {
          const data = {
            url,
            file:    currentOutputPath ? path.basename(currentOutputPath) : url,
            percent: parsed.percent,
            speed:   parsed.speed,
            eta:     parsed.eta,
          };
          _sendSafe(sender, 'ytdlp:progress', data);
          _notifyBackend('/notify/progress', {
            url, file: data.file, percent: parsed.percent,
            speed: parsed.speed, eta: parsed.eta,
          });

        } else if (parsed.type === 'finalDest') {
          currentOutputPath = parsed.outputPath;
          console.log(`[RAW STDOUT] Destino final (post-ffmpeg): ${currentOutputPath}`);
          _sendSafe(sender, 'ytdlp:log', { level: 'info', msg: `Convirtiendo: ${path.basename(currentOutputPath)}` });

        } else if (parsed.type === 'destination') {
          currentOutputPath = parsed.outputPath;
          console.log(`[RAW STDOUT] Destino: ${currentOutputPath}`);
          _sendSafe(sender, 'ytdlp:log', { level: 'info', msg: `Descargando: ${path.basename(currentOutputPath)}` });

        } else if (parsed.type === 'raw' && parsed.text) {
          _sendSafe(sender, 'ytdlp:log', { level: 'info', msg: parsed.text });
        }
      }
    });

    // ── [RAW STDERR] ────────────────────────────────────────────────────────
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const lines = chunk.split(/[\n\r]/)
        .map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim())
        .filter(Boolean);

      for (const line of lines) {
        console.error(`[RAW STDERR] ${line}`);
        _sendSafe(sender, 'ytdlp:log', { level: 'error', msg: line });
      }
    });

    // ── [CHILD ERROR] ───────────────────────────────────────────────────────
    // Este evento solo se emite si spawn() falla al intentar ejecutar el proceso
    // (ENOENT = no existe, EACCES = sin permisos de ejecucion)
    child.on('error', (err) => {
      _activeJobs.delete(child.pid);
      const msg = `[CHILD ERROR] ${err.code || 'ERROR'}: ${err.message}`;
      console.error(msg);
      _sendSafe(sender, 'ytdlp:error', { url, message: msg });
      _notifyBackend('/notify/error', { url, message: msg });
      resolve({ outputPath: null, error: msg });
    });

    // ── [CHILD CLOSED WITH CODE] ────────────────────────────────────────────
    child.on('close', (code, signal) => {
      _activeJobs.delete(child.pid);
      console.log(`[CHILD CLOSED WITH CODE]: ${code} | signal: ${signal} | PID: ${child.pid}`);
      console.log(`[CHILD CLOSED WITH CODE]: outputPath = ${currentOutputPath}`);

      if (code === 0 || code === null) {
        _sendSafe(sender, 'ytdlp:done', { url, outputPath: currentOutputPath });
        _notifyBackend('/notify/done', { url, output_path: currentOutputPath || '' });
        resolve({ outputPath: currentOutputPath });
      } else {
        const message = `yt-dlp salió con código ${code}${signal ? ` (signal: ${signal})` : ''}`;
        console.error(`[CHILD CLOSED WITH CODE] ERROR: ${message}`);
        _sendSafe(sender, 'ytdlp:error', { url, message });
        _notifyBackend('/notify/error', { url, message });
        // RESOLVEMOS (no rechazamos) para que la cola continue con el siguiente item
        resolve({ outputPath: null, error: message });
      }
    });
  });
}

// ─── Helper de envío seguro ───────────────────────────────────────────────────

/**
 * Envía un evento IPC al renderer solo si el WebContents no está destruido.
 * @param {Electron.WebContents} sender
 * @param {string} channel
 * @param {any} data
 */
function _sendSafe(sender, channel, data) {
  try {
    if (sender && !sender.isDestroyed()) sender.send(channel, data);
  } catch (err) {
    console.warn(`[ipc-download] sendSafe falló en canal '${channel}':`, err.message);
  }
}

// ─── Procesador de cola ───────────────────────────────────────────────────────

/**
 * Procesa la cola completa secuencialmente.
 * La función siempre termina (nunca queda colgada) gracias a que
 * _runDownload() resuelve SIEMPRE su Promise (nunca rechaza).
 *
 * @param {Electron.WebContents} sender
 * @param {{ url: string, title?: string }[]} items
 * @param {object} [opts]
 */
async function _processQueue(sender, items, opts = {}) {
  _cancelQueue = false;
  console.log(`[DEBUG-DOWNLOAD] Cola iniciada: ${items.length} item(s)`);

  for (let i = 0; i < items.length; i++) {
    if (_cancelQueue) {
      console.log('[DEBUG-DOWNLOAD] Cola cancelada por el usuario en item', i);
      break;
    }

    const item  = items[i];
    const url   = typeof item === 'string' ? item : (item.url || item.title || String(item));
    const title = typeof item === 'string' ? item : (item.title || item.url || url);

    console.log(`[DEBUG-DOWNLOAD] ─── Item ${i + 1}/${items.length}: ${url}`);
    _sendSafe(sender, 'ytdlp:log', {
      level: 'info',
      msg:   `[${i + 1}/${items.length}] Iniciando: ${title}`,
    });

    await _runDownload(sender, url, opts);
  }

  console.log('[DEBUG-DOWNLOAD] Cola completada.');
  _sendSafe(sender, 'ytdlp:queueDone', {});
  _sendSafe(sender, 'ytdlp:log', { level: 'info', msg: '🏁 Cola finalizada.' });
}

// ─── Registro de handlers IPC ─────────────────────────────────────────────────

/**
 * Registra los canales IPC. Llamar UNA SOLA VEZ en main.js, ANTES de createWindow().
 * @param {Electron.IpcMain} ipcMain
 */
function registerDownloadHandlers(ipcMain) {

  // ── ytdlp:startQueue ─────────────────────────────────────────────────────
  ipcMain.handle('ytdlp:startQueue', (event, payload) => {
    console.log('[IPC RECEIVED] ytdlp:startQueue | payload tipo:', typeof payload);

    // Normalizar payload: puede llegar como array directo o como { items, options }
    let items, opts;
    if (Array.isArray(payload)) {
      items = payload;
      opts  = {};
    } else {
      items = payload?.items ?? [];
      opts  = payload?.options ?? {};
    }

    console.log(`[IPC RECEIVED] ytdlp:startQueue | items recibidos: ${items.length}`);

    if (!items.length) {
      console.warn('[IPC RECEIVED] ytdlp:startQueue: cola vacía recibida.');
      return { started: false, reason: 'Cola vacía' };
    }

    // Lanzar el procesador de cola SIN await para no bloquear el handler IPC
    // El IPC devuelve inmediatamente; el progreso llega via sender.send()
    setImmediate(() => {
      _processQueue(event.sender, items, opts).catch((err) =>
        console.error('[DEBUG-DOWNLOAD] Error fatal en _processQueue:', err)
      );
    });

    return { started: true, count: items.length };
  });

  // ── ytdlp:download (descarga individual) ─────────────────────────────────
  ipcMain.handle('ytdlp:download', (event, payload) => {
    console.log('[IPC RECEIVED] ytdlp:download');
    const url  = typeof payload === 'string' ? payload : payload?.url;
    const opts = (typeof payload === 'object' && payload?.options) ? payload.options : {};

    if (!url?.trim()) throw new Error('URL inválida.');

    // No bloqueamos el handler IPC con await
    setImmediate(() => {
      _runDownload(event.sender, url.trim(), opts).catch((err) =>
        console.error('[DEBUG-DOWNLOAD] Error en _runDownload individual:', err)
      );
    });

    return { queued: true };
  });

  // ── ytdlp:cancel ─────────────────────────────────────────────────────────
  ipcMain.handle('ytdlp:cancel', (_event, payload) => {
    const pid = payload?.pid;
    console.log('[IPC RECEIVED] ytdlp:cancel | pid:', pid ?? '(todos)');

    if (pid !== undefined) {
      const job = _activeJobs.get(pid);
      if (!job) return { cancelled: false, reason: `PID ${pid} no encontrado.` };
      try { job.kill(); } catch (e) { console.warn('kill() falló:', e.message); }
      _activeJobs.delete(pid);
      return { cancelled: true };
    }

    // Cancelar todo
    _cancelQueue = true;
    for (const [p, job] of _activeJobs) {
      try { job.kill(); } catch { /* ok */ }
      console.log(`[DEBUG-DOWNLOAD] Job PID ${p} terminado (cancel all).`);
    }
    _activeJobs.clear();
    return { cancelled: true, all: true };
  });

  // ── ytdlp:status ─────────────────────────────────────────────────────────
  ipcMain.handle('ytdlp:status', () => ({
    active:     _activeJobs.size > 0,
    jobs:       _activeJobs.size,
    binaryPath: sanitizePath(getYtDlpPath()),
    ffmpegPath: sanitizePath(getFfmpegPath()),
    outputDir:  sanitizePath(getOutputDir()),
  }));

  console.log('[ipc-download] Handlers registrados: ytdlp:startQueue | ytdlp:download | ytdlp:cancel | ytdlp:status');
}

module.exports = { registerDownloadHandlers };
