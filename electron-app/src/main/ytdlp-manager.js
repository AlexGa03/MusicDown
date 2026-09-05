'use strict';

/**
 * @file src/main/ytdlp-manager.js
 * @description Gestor de ciclo de vida, resolución multiplataforma y descarga automática de yt-dlp y ffmpeg.
 */

const fs               = require('fs');
const path             = require('path');
const https            = require('https');
const os               = require('os');
const { pipeline }     = require('stream/promises');
const { execFileSync, execFile, execSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

// ─── Constantes del Sistema ───────────────────────────────────────────────────

const IS_WIN   = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const EXEC_MODE = 0o755;
const DIR_MODE  = 0o700;
const MIN_SIZE  = 1_000_000; // 1 MB mínimo para binario ejecutable real
const MAX_HOPS  = 10;

/**
 * Detecta si la aplicación se está ejecutando dentro de un contenedor Docker.
 * Se comprueba la variable de entorno IS_DOCKER o la existencia del directorio /app/downloads
 * (volumen estándar del contenedor MusicDown) o el archivo /.dockerenv.
 */
const IS_DOCKER = !!(
  process.env.IS_DOCKER ||
  process.env.DOCKER_CONTAINER ||
  (process.platform === 'linux' && fs.existsSync('/.dockerenv')) ||
  (process.platform === 'linux' && fs.existsSync('/app/downloads'))
);


const ALLOWED_DOWNLOAD_DOMAINS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'github-production-release-asset-2e65be.s3.amazonaws.com'
];

const DOWNLOAD_URLS = {
  win32:  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  linux:  'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
};

const DOWNLOAD_URL = DOWNLOAD_URLS[process.platform] || DOWNLOAD_URLS.linux;

// ─── Estado Global del Módulo ─────────────────────────────────────────────────

/** @type {'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'} */
let _status = 'IDLE';
let _statusMessage = 'No inicializado';
let _binaryPath = null;
let _ffmpegPath = null;
let _outputDir  = null;
let _initPromise = null;
let cachedYtDlpPath = null;

// ─── Notificaciones de Estado IPC ─────────────────────────────────────────────

/**
 * Notifica a todas las ventanas abiertas sobre el cambio de estado de yt-dlp.
 * @param {'INITIALIZING' | 'READY' | 'ERROR'} status
 * @param {string} message
 * @param {object} [extra]
 */
function broadcastStatus(status, message, extra = {}) {
  _status = status;
  _statusMessage = message;

  const payload = {
    status: _status,
    message: _statusMessage,
    binaryPath: _binaryPath || getYtDlpPath(),
    ffmpegPath: _ffmpegPath || getFfmpegPath(),
    outputDir: _outputDir,
    isReady: _status === 'READY',
    ...extra,
  };

  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('app:ytdlp-status', payload);
      win.webContents.send('app:log', {
        level: status === 'ERROR' ? 'error' : (status === 'READY' ? 'success' : 'info'),
        msg: `[yt-dlp] [${status}] ${message}`,
        ts: new Date().toLocaleTimeString('es-ES', { hour12: false }),
      });
    }
  }
}

// ─── Helpers de Rutas de Binarios Normalizadas ────────────────────────────────

/**
 * Obtiene el directorio de binarios de la aplicación dentro de userData.
 * @param {Electron.App} [appInstance]
 * @returns {string}
 */
const getBinDir = (appInstance) => {
  const electronApp = appInstance || app;
  if (electronApp && typeof electronApp.getPath === 'function') {
    return path.join(electronApp.getPath('userData'), 'bin');
  }
  return path.join(os.homedir(), '.config', 'musicdown', 'bin');
};

/**
 * Obtiene la ruta del ejecutable yt-dlp dentro de userData/bin.
 * @param {Electron.App} [appInstance]
 * @returns {string}
 */
const getYtDlpBinaryPath = (appInstance) =>
  path.join(getBinDir(appInstance), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

/**
 * Obtiene la ruta del ejecutable ffmpeg dentro de userData/bin.
 * @param {Electron.App} [appInstance]
 * @returns {string}
 */
const getFfmpegBinaryPath = (appInstance) =>
  path.join(getBinDir(appInstance), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// ─── Resolución de Rutas de Binarios ──────────────────────────────────────────

/**
 * Resuelve la ruta esperada de yt-dlp de forma dinámica y resiliente.
 * IMPORTANTE: NUNCA devuelve null.
 * @param {Electron.App} [appInstance]
 * @returns {string} Ruta absoluta del binario (instalado o esperado).
 */
function getYtDlpPath(appInstance) {
  // 1. Entorno Docker (contenedor): verificar rutas globales instaladas por el Dockerfile
  if (IS_DOCKER) {
    const dockerCandidates = [
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      getYtDlpBinaryPath(appInstance),
    ];
    for (const p of dockerCandidates) {
      if (fs.existsSync(p)) {
        try {
          if (fs.statSync(p).size >= MIN_SIZE) {
            return p;
          }
        } catch (_) {}
      }
    }
  }

  // 2. Entorno Desktop (Windows, Linux, macOS):
  // El motor SIEMPRE reside y se ejecuta en userData/bin para tener permisos de escritura y auto-actualización
  const userBin = getYtDlpBinaryPath(appInstance);
  if (fs.existsSync(userBin)) {
    try {
      if (fs.statSync(userBin).size >= MIN_SIZE) {
        return userBin;
      }
    } catch (_) {}
  }

  if (_binaryPath && fs.existsSync(_binaryPath)) {
    try {
      if (fs.statSync(_binaryPath).size >= MIN_SIZE) {
        return _binaryPath;
      }
    } catch (_) {}
  }

  if (cachedYtDlpPath && fs.existsSync(cachedYtDlpPath)) {
    try {
      if (fs.statSync(cachedYtDlpPath).size >= MIN_SIZE) {
        return cachedYtDlpPath;
      }
    } catch (_) {}
  }

  // Fallback: devolver la ruta esperada en userData/bin (nunca null)
  return userBin;
}

/**
 * Sanitiza una ruta para logs.
 * @param {string|null|undefined} p
 * @returns {string}
 */
function sanitizePath(p) {
  if (!p || typeof p !== 'string') return '';
  const home = os.homedir();
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

/**
 * Valida URLs autorizadas para descarga.
 * @param {string} urlString
 * @returns {boolean}
 */
function isAllowedUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_DOWNLOAD_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain) || hostname.includes('github')
    );
  } catch {
    return false;
  }
}

/**
 * Descarga un archivo por HTTPS con redirecciones seguras y escritura tolerante a NTFS.
 *
 * En Windows (NTFS), pipeline cierra el stream, pero Windows Defender suele retener un lock
 * de inspección sobre ejecutables recién descargados. Se implementa un ciclo de reintentos
 * para fs.renameSync con fallback automático a fs.copyFileSync + fs.unlinkSync diferido.
 *
 * @param {string} url
 * @param {string} dest
 * @returns {Promise<void>}
 */
async function downloadFile(url, dest) {
  const tmp = dest + '.tmp';
  const parentDir = path.dirname(dest);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true, mode: DIR_MODE });
  }
  if (fs.existsSync(tmp)) {
    try { fs.unlinkSync(tmp); } catch {}
  }

  let currentUrl = url;
  let hops = 0;

  while (hops < 10) {
    hops++;
    if (!isAllowedUrl(currentUrl)) {
      throw new Error(`URL o dominio no autorizado: ${currentUrl}`);
    }

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MusicDown/2.0',
        'Accept': '*/*'
      },
      timeout: 45000,
    };

    const res = await new Promise((resolve, reject) => {
      const req = https.get(currentUrl, options, resolve);
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout de red conectando a ${currentUrl}`));
      });
    });

    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      if (!res.headers.location) {
        res.resume();
        throw new Error(`Redirección ${res.statusCode} sin cabecera Location`);
      }
      currentUrl = new URL(res.headers.location, currentUrl).toString();
      res.resume();
      continue;
    }

    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode} al descargar desde ${currentUrl}`);
    }

    const fileStream = fs.createWriteStream(tmp, { flags: 'w' });
    await pipeline(res, fileStream);
    break;
  }

  // Margen inicial para que el kernel libere el descriptor de escritura
  await new Promise(r => setTimeout(r, 100));

  let size = 0;
  try {
    size = fs.statSync(tmp).size;
  } catch (statErr) {
    throw new Error(`No se pudo leer el archivo temporal en disco: ${statErr.message}`);
  }

  broadcastStatus('INITIALIZING', `yt-dlp.tmp escrito (${size} bytes). Asentando binario...`);
  console.log(`[ytdlp-manager] yt-dlp.tmp escrito (${size} bytes). Asentando binario...`);

  if (size < MIN_SIZE) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`Archivo descargado demasiado pequeño (${size} bytes). Mínimo requerido: ${MIN_SIZE} bytes.`);
  }

  // ── Renombrado / Copia tolerante a locks de NTFS y Windows Defender ──────────
  let finalized = false;
  let lastErr = null;

  // 1. Intentar renameSync con backoff incremental (100ms, 200ms, 300ms...)
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (fs.existsSync(dest)) {
        try { fs.unlinkSync(dest); } catch (_) {}
      }
      fs.renameSync(tmp, dest);
      finalized = true;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }

  // 2. Fallback de copia directa si el handle sigue bloqueado por el antivirus
  if (!finalized) {
    try {
      console.warn(`[ytdlp-manager] Rename bloqueado (${lastErr?.code}). Aplicando fallback copyFileSync...`);
      fs.copyFileSync(tmp, dest);
      try { fs.unlinkSync(tmp); } catch (_) {}
      finalized = true;
    } catch (copyErr) {
      lastErr = copyErr;
    }
  }

  if (!finalized) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw new Error(`Fallo al asentar binario en NTFS (${lastErr?.code || 'EPERM'}): ${lastErr?.message}`);
  }
}

/**
 * Aplica permisos de ejecución chmod 755 (Solo en POSIX/Linux/macOS, NO en Windows).
 * @param {string} p
 */
function makeExecutable(p) {
  if (IS_WIN) return; // En Windows no se ejecuta chmod
  try {
    fs.chmodSync(p, EXEC_MODE);
    console.log(`[ytdlp-manager] chmod 755 aplicado a: ${p}`);
  } catch (e) {
    console.warn(`[ytdlp-manager] No se pudo aplicar chmod a ${p}: ${e.message}`);
  }
}

/**
 * Valida la integridad funcional y tamaño del binario.
 * @param {string} p
 * @returns {{ valid: boolean, version?: string, error?: string }}
 */
function validateBinary(p) {
  if (!fs.existsSync(p)) {
    return { valid: false, error: 'El archivo no existe en el disco.' };
  }

  try {
    const stat = fs.statSync(p);
    if (stat.size < MIN_SIZE) {
      return { valid: false, error: `Tamaño insuficiente (${stat.size} bytes). Archivo corrupto o error HTML.` };
    }

    const version = execFileSync(p, ['--version'], {
      timeout: 10_000,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();

    return { valid: true, version };
  } catch (e) {
    return { valid: false, error: `Fallo al ejecutar '${p} --version': ${e.message}` };
  }
}

/**
 * Resuelve y crea el directorio de descargas con ruta absoluta y normalizada.
 *
 * En entornos Docker, se prioriza /app/downloads (volumen montado del host).
 * En entornos de escritorio, se usa la carpeta Downloads del usuario.
 *
 * @param {Electron.App} appInstance
 * @returns {string} Ruta absoluta normalizada.
 */
function resolveOutputDir(appInstance) {
  // ── Prioridad 1: Entorno Docker → usar el volumen /app/downloads montado en el host ──
  // Esto permite que las descargas sean visibles directamente en la máquina anfitriona
  // mediante: docker run -v ~/Descargas:/app/downloads ...
  if (IS_DOCKER) {
    const dockerVolume = '/app/downloads';
    try {
      if (!fs.existsSync(dockerVolume)) {
        fs.mkdirSync(dockerVolume, { recursive: true });
      }
      const probe = path.join(dockerVolume, '.write_probe_' + Date.now());
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      console.log(`[ytdlp-manager] Docker detectado. Usando volumen: ${dockerVolume}`);
      return dockerVolume;
    } catch (e) {
      console.warn(`[ytdlp-manager] Volumen Docker no escribible (${e.message}). Usando fallback...`);
    }
  }

  // ── Prioridad 2: Desktop → Downloads/MusicDown del usuario ──────────────────
  let downloadsBase = '';
  try {
    downloadsBase = appInstance.getPath('downloads');
  } catch {
    downloadsBase = path.join(os.homedir(), 'Downloads');
  }

  const candidates = [
    path.normalize(path.join(downloadsBase, 'MusicDown')),
    path.normalize(path.join(os.homedir(), 'Music', 'MusicDown')),
    path.normalize(path.join(os.homedir(), 'Documents', 'MusicDown')),
    path.normalize(path.join(os.tmpdir(), 'MusicDown')),
  ];

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const probe = path.join(dir, '.write_probe_' + Date.now());
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      console.log(`[ytdlp-manager] Directorio de descargas listo: ${dir}`);
      return dir;
    } catch {
      console.warn(`[ytdlp-manager] Candidato no escribible: ${dir}`);
    }
  }

  const fallback = path.normalize(path.join(os.tmpdir(), 'MusicDown'));
  try { fs.mkdirSync(fallback, { recursive: true }); } catch {}
  return fallback;
}

/**
 * Resuelve la ruta de FFmpeg.
 * @param {Electron.App} [appInstance]
 * @returns {string|null}
 */
function resolveFfmpeg(appInstance) {
  const electronApp = appInstance || app;
  const ffmpegName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

  if (process.platform === 'win32') {
    const resourcesBin = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'ffmpeg.exe') : null;
    console.log('[ytdlp-manager] Buscando FFmpeg en resourcesPath:', resourcesBin || '(no disponible)');

    let appPathBin = null;
    let userDataBin = null;
    try {
      if (electronApp && typeof electronApp.getAppPath === 'function') {
        appPathBin = path.join(electronApp.getAppPath(), '..', 'bin', 'ffmpeg.exe');
      }
    } catch (_) {}
    try {
      if (electronApp && typeof electronApp.getPath === 'function') {
        userDataBin = path.join(electronApp.getPath('userData'), 'bin', 'ffmpeg.exe');
      }
    } catch (_) {}

    const winCandidates = [
      resourcesBin,
      appPathBin,
      userDataBin,
      getFfmpegBinaryPath(electronApp),
      process.resourcesPath ? path.join(process.resourcesPath, 'backend', 'bin', 'ffmpeg.exe') : null,
      path.join(__dirname, '..', '..', 'bin', 'ffmpeg.exe'),
    ].filter(Boolean);

    for (const candidate of winCandidates) {
      if (fs.existsSync(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.size > 100_000) {
            console.log(`[ytdlp-manager] ✓ FFmpeg detectado en: ${candidate}`);
            _ffmpegPath = path.normalize(candidate);
            return _ffmpegPath;
          }
        } catch (_) {}
      }
    }

    // Comprobación en PATH del sistema en Windows
    try {
      const out = execSync('where ffmpeg.exe', { encoding: 'utf8', windowsHide: true })
        .trim().split(/\r?\n/)[0].trim();
      if (out && fs.existsSync(out)) {
        console.log(`[ytdlp-manager] ✓ FFmpeg en PATH: ${out}`);
        _ffmpegPath = path.normalize(out);
        return _ffmpegPath;
      }
    } catch (_) {}

    console.warn('[ytdlp-manager] ⚠️ FFmpeg no encontrado en resourcesPath ni en PATH de Windows.');
    return null;
  }

  // ── Linux / macOS / POSIX (AppImage & Host) ───────────────────────────────
  const resourcesBin = process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'ffmpeg') : null;
  
  let appPathBin = null;
  let userDataBin = null;
  try {
    if (electronApp && typeof electronApp.getAppPath === 'function') {
      appPathBin = path.join(electronApp.getAppPath(), '..', 'bin', 'ffmpeg');
    }
  } catch (_) {}
  try {
    if (electronApp && typeof electronApp.getPath === 'function') {
      userDataBin = path.join(electronApp.getPath('userData'), 'bin', 'ffmpeg');
    }
  } catch (_) {}

  const linuxCandidates = [
    resourcesBin,
    appPathBin,
    path.join(__dirname, '..', '..', 'bin', 'ffmpeg'),
    path.join(__dirname, '..', '..', 'backend', 'bin', 'ffmpeg'),
    userDataBin,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/bin/ffmpeg'
  ].filter(Boolean);

  for (const candidate of linuxCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        try { fs.chmodSync(candidate, 0o755); } catch (_) {}
        const stat = fs.statSync(candidate);
        if (stat.size > 100_000) {
          console.log(`[ytdlp-manager] ✓ FFmpeg detectado en Linux: ${candidate}`);
          _ffmpegPath = path.normalize(candidate);
          return _ffmpegPath;
        }
      }
    } catch (_) {}
  }

  // Comprobación de fallback mediante comando del sistema
  try {
    const out = execSync('which ffmpeg', { encoding: 'utf8', windowsHide: true })
      .trim().split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) {
      console.log(`[ytdlp-manager] ✓ FFmpeg en PATH del sistema: ${out}`);
      _ffmpegPath = path.normalize(out);
      return _ffmpegPath;
    }
  } catch (_) {}

  console.warn('[ytdlp-manager] ⚠️ FFmpeg no encontrado en rutas locales ni en PATH de Linux.');
  return null;
}

/**
 * Obtiene la ruta del ejecutable FFmpeg, resolviéndolo dinámicamente si no está en caché.
 * @param {Electron.App} [appInstance]
 * @returns {string|null}
 */
function getFfmpegPath(appInstance) {
  if (_ffmpegPath && fs.existsSync(_ffmpegPath)) {
    return _ffmpegPath;
  }
  _ffmpegPath = resolveFfmpeg(appInstance);
  return _ffmpegPath;
}

/** URL de build estático oficial de FFmpeg para Windows */
const FFMPEG_WIN_URL = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';
let _ffmpegDownloadPromise = null;

/**
 * Descarga automática de FFmpeg para Windows si no existe en el sistema ni en el bundle.
 * @param {Electron.App} [appInstance]
 * @returns {Promise<string|null>}
 */
async function ensureFfmpeg(appInstance) {
  if (_ffmpegPath && fs.existsSync(_ffmpegPath)) {
    return _ffmpegPath;
  }

  const existing = resolveFfmpeg(appInstance);
  if (existing) {
    _ffmpegPath = existing;
    return _ffmpegPath;
  }

  if (!IS_WIN) {
    return null; // En Linux/Docker FFmpeg se instala vía apt
  }

  if (_ffmpegDownloadPromise) return _ffmpegDownloadPromise;

  _ffmpegDownloadPromise = (async () => {
    const electronApp = appInstance || app;
    const targetPath = getFfmpegBinaryPath(electronApp);
    const binDir = getBinDir(electronApp);

    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true, mode: DIR_MODE });
    }

    const zipPath = path.join(binDir, 'ffmpeg_fallback.zip');
    console.log(`[ytdlp-manager] Iniciando descarga fallback de FFmpeg para Windows desde: ${FFMPEG_WIN_URL}`);
    broadcastStatus(_status, 'Descargando FFmpeg para Windows (soporte MP3)...');

    try {
      await downloadFile(FFMPEG_WIN_URL, zipPath);
      console.log('[ytdlp-manager] Descomprimiendo FFmpeg para Windows...');

      let extracted = false;
      try {
        execSync(`tar -xf "${zipPath}" --strip-components 2 -C "${binDir}" "*/bin/ffmpeg.exe"`, { windowsHide: true });
        extracted = fs.existsSync(targetPath);
      } catch (_) {}

      if (!extracted) {
        const extractTemp = path.join(binDir, 'ffmpeg_temp_ext');
        try {
          execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTemp}' -Force; Move-Item -Path '${extractTemp}\\*\\bin\\ffmpeg.exe' -Destination '${targetPath}' -Force; Remove-Item -Path '${extractTemp}' -Recurse -Force"`, { windowsHide: true });
          extracted = fs.existsSync(targetPath);
        } catch (psErr) {
          console.error(`[ytdlp-manager] Fallo al extraer FFmpeg con PowerShell: ${psErr.message}`);
        }
      }

      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}

      if (extracted && fs.existsSync(targetPath)) {
        _ffmpegPath = targetPath;
        console.log(`[ytdlp-manager] ✓ FFmpeg para Windows instalado correctamente en: ${_ffmpegPath}`);
        broadcastStatus(_status, 'FFmpeg listo para conversión MP3.');
        return _ffmpegPath;
      }
    } catch (dlErr) {
      console.warn(`[ytdlp-manager] No se pudo descargar FFmpeg automáticamente: ${dlErr.message}`);
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (_) {}
    }

    return null;
  })();

  return _ffmpegDownloadPromise;
}

/**
 * Ejecuta yt-dlp -U en segundo plano de manera no bloqueante.
 * @param {string} p
 */
function updateInBackground(p) {
  console.log('[ytdlp-manager] Verificando actualizaciones con yt-dlp -U...');
  execFile(p, ['-U'], { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) {
      console.log('[ytdlp-manager] yt-dlp -U resultado (modo offline o última versión):', err.message);
      return;
    }
    const out = ((stdout || '') + (stderr || '')).trim();
    console.log('[ytdlp-manager] yt-dlp -U resultado:', out || 'Actualizado.');
  });
}

// ─── Inicialización Principal ─────────────────────────────────────────────────

/**
 * Inicializa yt-dlp, FFmpeg y las carpetas del sistema emitiendo eventos de estado.
 * Se llama en app.whenReady() antes o durante la creación de la ventana.
 *
 * @param {Electron.App} appInstance
 * @returns {Promise<string>} Ruta validada al binario de yt-dlp.
 */
async function ensureYtDlp(appInstance) {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    broadcastStatus('INITIALIZING', 'Inicializando dependencias del sistema y motor yt-dlp...');

    // 1. Resolver FFmpeg y directorio de descargas
    _ffmpegPath = resolveFfmpeg(appInstance);
    _outputDir  = resolveOutputDir(appInstance);

    // Si en Windows FFmpeg no está presente, iniciar descarga fallback de forma tolerante
    if (!_ffmpegPath && IS_WIN) {
      ensureFfmpeg(appInstance).then(p => {
        if (p) _ffmpegPath = p;
      }).catch(() => {});
    }

    // 2. Resolver ubicación candidata de yt-dlp
    const candidatePath = getYtDlpPath(appInstance);
    console.log(`[ytdlp-manager] Ruta evaluada para yt-dlp: ${candidatePath}`);

    // Si ya existe físicamente en el disco con tamaño válido, validarlo
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).size >= MIN_SIZE) {
      makeExecutable(candidatePath);
      const val = validateBinary(candidatePath);

      if (val.valid) {
        _binaryPath = candidatePath;
        cachedYtDlpPath = candidatePath;
        _ffmpegPath = getFfmpegPath(appInstance);
        broadcastStatus('READY', `yt-dlp v${val.version} listo para operar.`, {
          version: val.version,
          ffmpegPath: _ffmpegPath
        });
        updateInBackground(_binaryPath);
        return _binaryPath;
      } else {
        console.warn(`[ytdlp-manager] Binario existente no válido (${val.error}). Reintentando descarga limpia...`);
        try { fs.unlinkSync(candidatePath); } catch {}
      }
    }

    // 3. Descarga desde fuente oficial de GitHub Releases
    const targetPath = getYtDlpBinaryPath(appInstance);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: DIR_MODE });
    }

    broadcastStatus('INITIALIZING', 'Descargando yt-dlp desde GitHub...');
    console.log(`[ytdlp-manager] Iniciando descarga desde: ${DOWNLOAD_URL} -> ${targetPath}`);

    try {
      await downloadFile(DOWNLOAD_URL, targetPath);
      makeExecutable(targetPath);

      const valPost = validateBinary(targetPath);
      if (!valPost.valid) {
        try { fs.unlinkSync(targetPath); } catch {}
        throw new Error(`Validación de binario fallida tras descarga: ${valPost.error}`);
      }

      _binaryPath = targetPath;
      cachedYtDlpPath = targetPath;
      _ffmpegPath = getFfmpegPath(appInstance);
      broadcastStatus('READY', `yt-dlp v${valPost.version} descargado e instalado correctamente.`, {
        version: valPost.version,
        ffmpegPath: _ffmpegPath
      });
      return _binaryPath;

    } catch (dlErr) {
      console.error(`[ytdlp-manager] Error durante la descarga/instalación de yt-dlp:`, dlErr.stack || dlErr);
      _binaryPath = null;
      cachedYtDlpPath = null;
      broadcastStatus('ERROR', `Error al inicializar yt-dlp: ${dlErr.stack || dlErr.message}`);
      throw dlErr;
    }
  })();

  return _initPromise;
}

// ─── Exportaciones Públicas ───────────────────────────────────────────────────

module.exports = {
  initYtDlp: ensureYtDlp,
  ensureYtDlp,
  getYtDlpPath,
  getBinaryPath: getYtDlpPath,
  getBinDir,
  getYtDlpBinaryPath,
  getFfmpegBinaryPath,
  resolveFfmpeg,
  ensureFfmpeg,
  getFfmpegPath,
  getOutputDir:  () => _outputDir,
  getYtDlpStatus: () => _status,
  isYtDlpReady:  () => _status === 'READY' && Boolean(_binaryPath && fs.existsSync(_binaryPath) && fs.statSync(_binaryPath).size >= MIN_SIZE),
  isDocker:      () => IS_DOCKER,
  sanitizePath,
  validateBinary,
  MIN_SIZE,
};
