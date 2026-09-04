'use strict';

/**
 * @file src/main/ipc-download-handler.js
 * @description Orquestador de cola de descargas y comunicación IPC con el proceso Renderer.
 */

const { spawn }  = require('child_process');
const { shell, BrowserWindow } = require('electron');
const path       = require('path');
const os         = require('os');
const fs         = require('fs');
const {
  getYtDlpPath,
  getBinaryPath,
  getFfmpegPath,
  getOutputDir,
  getYtDlpStatus,
  isYtDlpReady,
  isDocker,
  sanitizePath,
} = require('./ytdlp-manager.js');

const IS_WIN = process.platform === 'win32';

// ─── Utilidades de Sanitización y Validación ─────────────────────────────────

function sanitizeInputString(input, maxLength = 2048) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function isPlaylistUrl(s) {
  return /list=/.test(s) && /youtube\.com|youtu\.be/.test(s);
}

function isYouTubeUrl(s) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(s);
}

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

// ─── Estado de la Cola ────────────────────────────────────────────────────────

let _queue = [];
let _activeChild = null;
let _stopRequested = false;
const _playlistPrompts = new Map();

// ─── Helpers IPC ─────────────────────────────────────────────────────────────

function emit(wc, channel, payload) {
  try {
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  } catch (e) {
    console.warn(`[ipc] emit('${channel}') falló:`, e.message);
  }
}

function log(wc, msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('es-ES', { hour12: false });
  const rawMsg = typeof msg === 'string' ? msg : JSON.stringify(msg);
  console.log(`[${level.toUpperCase()}] ${rawMsg}`);
  emit(wc, 'app:log', { level, msg: rawMsg, ts });
}

function broadcastQueue(wc) {
  emit(wc, 'app:queueUpdate', {
    queue:  _queue,
    active: _activeChild !== null,
  });
}

// ─── Construcción de Argumentos CLI ──────────────────────────────────────────

function buildArgs(url, opts = {}) {
  const {
    downloadAll    = false,
    outputDir      = getOutputDir() || path.normalize(path.join(os.homedir(), 'Downloads', 'MusicDown')),
    ffmpegLocation = getFfmpegPath(),
  } = opts;

  const normalizedOutDir = path.normalize(outputDir);
  try {
    if (!fs.existsSync(normalizedOutDir)) {
      fs.mkdirSync(normalizedOutDir, { recursive: true });
    }
  } catch {}

  const args = [
    '--newline',
    '--no-colors',
    '--progress',
    // Suprime el warning "No supported Javascript runtime could be found"
    // que aparece en Linux AppImage donde deno no está disponible.
    // yt-dlp intentará los runtimes disponibles sin abortar la descarga.
    '--no-warnings',
    // Fuerza el cliente de reproductor por defecto de YouTube para evitar
    // dependencias de runtime JS externo (deno/node) en la resolución de streams.
    '--extractor-args', 'youtube:player_client=default',
  ];

  args.push(downloadAll ? '--yes-playlist' : '--no-playlist');

  if (ffmpegLocation && typeof ffmpegLocation === 'string' && fs.existsSync(ffmpegLocation)) {
    args.push(
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--ffmpeg-location', ffmpegLocation
    );
  } else {
    console.warn('[ipc] FFmpeg no disponible. Descargando stream original sin conversión.');
    args.push('-f', 'bestaudio');
  }

  args.push('-o', path.join(normalizedOutDir, '%(title)s.%(ext)s'));
  args.push('--', url);

  return args;
}

// ─── Parseo de Salida de yt-dlp ──────────────────────────────────────────────

const RE_PROGRESS    = /\[download\]\s+([\d.]+)%\s+of\s+\S+\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+([\d:]+)/;
const RE_DESTINATION = /\[download\]\s+Destination:\s+(.+)/;
const RE_EXTRACT     = /\[ExtractAudio\].*Destination:\s+(.+)/;
const RE_FFMPEG      = /\[ffmpeg\].*Destination:\s+(.+)/;

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

// ─── Ejecución de Descarga Individual ────────────────────────────────────────

function runDownload(wc, item, index, total, opts = {}) {
  return new Promise((resolve) => {
    // getBinaryPath() resuelve con prioridad:
    //   1. _binaryPath (validado por ensureYtDlp)
    //   2. /usr/local/bin/yt-dlp (pip3 Docker)
    //   3. /usr/bin/yt-dlp (apt)
    //   4. which/where en PATH
    //   5. null si no hay binario disponible
    const binary = getBinaryPath();

    console.log(`[IPC RECEIVED] runDownload | item ${index + 1}/${total}: ${item.url}`);
    console.log(`[BINARY CHECK] Ruta efectiva de yt-dlp: ${binary ?? '(no disponible)'}`);

    // Si el binario no existe físicamente en el disco
    if (!binary || !fs.existsSync(binary)) {
      const isInit = getYtDlpStatus() === 'INITIALIZING';
      const msg = isInit
        ? 'Motor yt-dlp aún se está inicializando, por favor espere unos segundos...'
        : `Motor yt-dlp no disponible. Ruta resuelta: '${binary ?? 'ninguna'}'. Verifique su conexión o permisos.`;

      console.error(`[BINARY CHECK] ${msg}`);
      log(wc, msg, isInit ? 'warn' : 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      return resolve({ outputPath: null, exitCode: -1 });
    }

    const args = buildArgs(item.url, opts);

    console.log('[SPAWN COMMAND]:', binary);
    console.log('[SPAWN COMMAND] args:', args.join(' '));
    log(wc, `Iniciando: ${item.title}`, 'info');

    let child;
    try {
      child = spawn(binary, args, {
        stdio:       ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env:         { ...process.env, TERM: 'dumb' },
      });
    } catch (spawnErr) {
      const msg = `Excepción al invocar spawn: ${spawnErr.message}`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      return resolve({ outputPath: null, exitCode: -1 });
    }

    if (!child || child.pid === undefined) {
      const msg = `Fallo al iniciar subproceso yt-dlp: ${binary}`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      return resolve({ outputPath: null, exitCode: -1 });
    }

    _activeChild = child;
    let outputPath = null;
    let stdBuf     = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdBuf += chunk;
      const parts = stdBuf.split('\n');
      stdBuf = parts.pop();

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
          log(wc, `Convirtiendo a MP3: ${path.basename(outputPath)}`, 'info');
        } else if (parsed.type === 'destination') {
          outputPath = parsed.outputPath;
          log(wc, `Descargando: ${path.basename(outputPath)}`, 'info');
        } else if (parsed.type === 'raw' && parsed.text) {
          log(wc, parsed.text, 'info');
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      chunk.split(/[\n\r]/)
        .map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim())
        .filter(Boolean)
        .forEach(line => {
          console.error(`[STDERR] ${line}`);
          log(wc, line, 'error');
        });
    });

    child.on('error', (err) => {
      _activeChild = null;
      const msg = `Error en subproceso: ${err.message}`;
      console.error(msg);
      log(wc, msg, 'error');
      emit(wc, 'app:error', { index, total, title: item.title, message: msg });
      resolve({ outputPath: null, exitCode: -1 });
    });

    child.on('close', (code, signal) => {
      _activeChild = null;
      console.log(`[CHILD CLOSED]: code=${code} signal=${signal}`);

      if (code === 0 || code === null) {
        log(wc, `✓ Completado con éxito: ${item.title}`, 'success');
        emit(wc, 'app:done', { index, total, title: item.title, outputPath });
        resolve({ outputPath, exitCode: 0 });
      } else {
        const msg = `yt-dlp finalizó con código de error ${code}${signal ? ` (${signal})` : ''}`;
        console.error(msg);
        log(wc, `✗ Falló: ${item.title} — ${msg}`, 'error');
        emit(wc, 'app:error', { index, total, title: item.title, message: msg });
        resolve({ outputPath: null, exitCode: code });
      }
    });
  });
}

// ─── Confirmación de Playlists ────────────────────────────────────────────────

function askPlaylistPreference(wc, item) {
  return new Promise((resolve) => {
    const key = item.url;
    const timeout = setTimeout(() => {
      _playlistPrompts.delete(key);
      console.warn('[ipc] Timeout en respuesta de playlist. Descargando solo canción.');
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

// ─── Procesador de Cola Secuencial ───────────────────────────────────────────

async function processQueue(wc, outputDir) {
  _stopRequested = false;
  let completed  = 0;
  let errors     = 0;
  const total    = _queue.filter(i => i.status === 'pending').length;

  console.log(`[ipc] Iniciando procesamiento de ${total} elemento(s).`);
  log(wc, `Cola iniciada: ${total} elemento(s) pendientes.`, 'info');

  for (let i = 0; i < _queue.length; i++) {
    if (_stopRequested) {
      log(wc, '⏹ Cola cancelada por el usuario.', 'warn');
      break;
    }

    const item = _queue[i];
    if (item.status !== 'pending') continue;

    item.status = 'active';
    broadcastQueue(wc);

    let downloadAll = false;
    if (item.isPlaylist) {
      log(wc, `⚠️ Playlist detectada: ${item.title}. Esperando confirmación...`, 'warn');
      downloadAll = await askPlaylistPreference(wc, item);
      log(wc, `Modo playlist: ${downloadAll ? 'Descarga completa' : 'Solo una canción'}.`, 'info');
    }

    const result = await runDownload(wc, item, completed, total, {
      downloadAll,
      outputDir: outputDir || getOutputDir(),
    });

    if (result.exitCode === 0) {
      item.status = 'done';
      completed++;
    } else {
      item.status = 'error';
      errors++;
    }

    broadcastQueue(wc);
  }

  log(wc, `🏁 Cola completada. ${completed} éxito(s), ${errors} error(es).`, 'info');
  emit(wc, 'app:queueDone', { completed, errors });

  _queue = _queue.filter(i => i.status === 'pending');
  broadcastQueue(wc);
}

// ─── Registro de Handlers IPC ─────────────────────────────────────────────────

function registerHandlers(ipcMain, appInstance) {

  // Añadir elementos a la cola
  ipcMain.handle('app:addItems', (event, rawItems) => {
    if (!Array.isArray(rawItems) || rawItems.length === 0)
      return { added: 0, total: _queue.length };

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

      if (_queue.some(q => q.url === parsed.url)) continue;
      _queue.push(parsed);
      added++;
    }

    const wc = event.sender;
    log(wc, `${added} elemento(s) añadidos a la cola. Total en cola: ${_queue.length}.`, 'info');
    broadcastQueue(wc);
    return { added, total: _queue.length };
  });

  // Iniciar descarga de cola
  ipcMain.handle('app:startQueue', (event) => {
    const wc = event.sender;

    if (_activeChild) {
      log(wc, 'Ya hay una descarga en curso.', 'warn');
      return { started: false, reason: 'Descarga en curso' };
    }

    const pending = _queue.filter(i => i.status === 'pending');
    if (!pending.length) {
      log(wc, 'La cola está vacía.', 'warn');
      return { started: false, reason: 'Cola vacía' };
    }

    setImmediate(() => {
      processQueue(wc).catch(err =>
        console.error('[ipc] Error en processQueue:', err.message)
      );
    });

    return { started: true, count: pending.length };
  });

  // Detener descarga activa
  ipcMain.handle('app:stop', (event) => {
    _stopRequested = true;

    if (_activeChild && typeof _activeChild.pid === 'number') {
      try {
        if (IS_WIN) {
          const { execFileSync } = require('child_process');
          execFileSync('taskkill', ['/pid', String(_activeChild.pid), '/f', '/t'], { windowsHide: true });
        } else {
          _activeChild.kill('SIGTERM');
        }
        console.log(`[ipc] Proceso ${_activeChild.pid} cancelado.`);
      } catch (e) {
        console.warn('[ipc] Error al terminar proceso:', e.message);
      }
      _activeChild = null;
    }

    _queue.forEach(i => { if (i.status === 'active') i.status = 'pending'; });
    log(event.sender, 'Descarga detenida por el usuario.', 'warn');
    broadcastQueue(event.sender);
    return { stopped: true };
  });

  // Limpiar cola
  ipcMain.handle('app:clear', (event) => {
    if (_activeChild) {
      log(event.sender, 'No se puede limpiar la cola mientras hay una descarga activa.', 'warn');
      return { cleared: false };
    }
    _queue = [];
    log(event.sender, 'Cola limpiada.', 'info');
    broadcastQueue(event.sender);
    return { cleared: true };
  });

  // ── app:openFolder (Manejo Seguro y Multiplataforma) ───────────────────────
  ipcMain.handle('app:openFolder', async (event) => {
    // ── Bloqueo en entorno Docker ────────────────────────────────────────────
    // En el contenedor no hay gestor de archivos de escritorio instalado.
    // Las descargas son accesibles directamente desde el host mediante el volumen
    // montado (-v ~/Descargas:/app/downloads), por lo que abrir carpeta no aplica.
    if (isDocker()) {
      const msg = '📦 Entorno Docker: Las canciones se sincronizan en el volumen montado (/app/downloads).';
      log(event.sender, msg, 'info');
      return { opened: false, docker: true, dir: '/app/downloads', message: msg };
    }

    let rawDir = getOutputDir();
    if (!rawDir) {
      try {
        rawDir = path.join(appInstance.getPath('downloads'), 'MusicDown');
      } catch {
        rawDir = path.join(os.homedir(), 'Downloads', 'MusicDown');
      }
    }

    // Normalización obligatoria para separadores válidos en Windows (\) y Linux (/)
    const downloadDir = path.normalize(rawDir);

    // ── Crear el directorio síncronamente antes de lanzar el explorador ──────
    // shell.openPath falla silenciosamente si el directorio no existe en disco.
    // mkdirSync con recursive:true es idempotente (no lanza si ya existe).
    try {
      if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir, { recursive: true });
        console.log(`[ipc] Carpeta creada previamente a la apertura: ${downloadDir}`);
      }
    } catch (mkErr) {
      const msg = `No se pudo crear el directorio de descargas: ${mkErr.message}`;
      console.error(`[ipc] ${msg}`);
      log(event.sender, msg, 'error');
      return { opened: false, error: mkErr.message };
    }

    // ── Apertura desacoplada (sin await) para no bloquear el hilo de eventos ─
    // En Wayland/XWayland (Hyprland, Sway, GNOME), esperar la promesa de
    // shell.openPath() mantiene el grab del puntero activo durante toda la
    // sesión del gestor de archivos externo, dejando el cursor atascado al
    // cerrarlo. Lanzar sin await devuelve el control inmediatamente.
    shell.openPath(downloadDir).then((errMsg) => {
      if (errMsg) {
        console.error(`[ipc] shell.openPath error: ${errMsg}`);
        log(event.sender, `No se pudo abrir carpeta: ${errMsg}`, 'error');
      }
    }).catch((err) => {
      console.error(`[ipc] shell.openPath excepción: ${err.message}`);
    });

    // ── Liberación de foco y cursor en Linux/Wayland ─────────────────────────
    // webContents.focus() señala al compositor que el foco de input vuelve
    // al renderer de Electron, liberando el puntero del grab del proceso externo.
    // Se ejecuta inmediatamente tras el lanzamiento desacoplado.
    if (process.platform === 'linux') {
      try {
        // Foco a nivel de webContents (libera el grab del puntero en Wayland)
        event.sender.focus();

        // Adicionalmente, blur+focus a nivel de ventana para forzar al compositor
        // a re-evaluar el estado de foco de la ventana XWayland.
        const win = BrowserWindow.fromWebContents(event.sender)
          || BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.isVisible());
        if (win && !win.isDestroyed()) {
          setTimeout(() => {
            try { win.blur(); win.focus(); } catch {}
          }, 250);
        }
      } catch {}
    }

    log(event.sender, `📂 Abriendo carpeta: ${downloadDir}`, 'info');
    return { opened: true, dir: downloadDir };
  });

  // Estado general de dependencias y cola
  ipcMain.handle('app:getStatus', () => {
    const rawOutDir   = getOutputDir() || path.normalize(path.join(appInstance.getPath('downloads'), 'MusicDown'));
    const resolvedBin = getBinaryPath();

    return {
      binaryPath:  resolvedBin,
      ffmpegPath:  getFfmpegPath(),
      outputDir:   path.normalize(rawOutDir),
      ytdlpStatus: getYtDlpStatus(),
      // isReady solo es true si el binario existe físicamente en disco
      isReady:     isYtDlpReady() && !!resolvedBin && fs.existsSync(resolvedBin),
      isDocker:    isDocker(),
      queue:       _queue,
      active:      _activeChild !== null,
    };
  });

  // Respuesta de modal de playlist
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
    return { ok: false, reason: 'No había solicitud pendiente para esta URL.' };
  });

  console.log('[ipc] Handlers IPC registrados correctamente.');
}

module.exports = { registerHandlers };
