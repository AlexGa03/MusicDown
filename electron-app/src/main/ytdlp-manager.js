'use strict';

/**
 * @file src/main/ytdlp-manager.js
 * @description Gestor de ciclo de vida, resolución multiplataforma y descarga automática de yt-dlp y ffmpeg.
 */

const fs               = require('fs');
const path             = require('path');
const https            = require('https');
const os               = require('os');
const { execFileSync, execFile } = require('child_process');
const { BrowserWindow } = require('electron');

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
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.github.com',
  'github-releases.githubusercontent.com',
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
    binaryPath: _binaryPath || (typeof app !== 'undefined' ? getYtDlpPath(app) : null),
    ffmpegPath: _ffmpegPath,
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

// ─── Resolución de Rutas de Binarios ──────────────────────────────────────────

/**
 * Resuelve la ruta esperada de yt-dlp.
 * IMPORTANTE: NUNCA devuelve null.
 * @param {Electron.App} appInstance
 * @returns {string} Ruta absoluta del binario (instalado o esperado).
 */
function getYtDlpPath(appInstance) {
  // 1. Si ya se resolvió y validó en memoria, retornarlo
  if (_binaryPath && fs.existsSync(_binaryPath)) {
    return _binaryPath;
  }

  // 2. Ruta local estándar en el directorio de datos del usuario (userData/bin/)
  let localUserBin = '';
  if (appInstance && typeof appInstance.getPath === 'function') {
    localUserBin = path.normalize(path.join(appInstance.getPath('userData'), 'bin', BIN_NAME));
  } else {
    localUserBin = path.normalize(path.join(os.homedir(), '.config', 'musicdown', 'bin', BIN_NAME));
  }

  if (fs.existsSync(localUserBin)) {
    return localUserBin;
  }

  // 3. Fallbacks en Linux / Docker (instalación global vía pip3 o apt)
  if (!IS_WIN) {
    const globalFallbacks = [
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
      '/opt/homebrew/bin/yt-dlp',
    ];

    for (const sysPath of globalFallbacks) {
      if (fs.existsSync(sysPath)) {
        return sysPath;
      }
    }

    try {
      const whichResult = execFileSync('which', ['yt-dlp'], { encoding: 'utf8', windowsHide: true }).trim();
      if (whichResult && fs.existsSync(whichResult)) {
        return whichResult;
      }
    } catch {
      // No presente en PATH global
    }
  } else {
    // Fallback PATH en Windows (where yt-dlp)
    try {
      const whereResult = execFileSync('where', ['yt-dlp.exe'], { encoding: 'utf8', windowsHide: true })
        .trim().split(/\r?\n/)[0].trim();
      if (whereResult && fs.existsSync(whereResult)) {
        return whereResult;
      }
    } catch {
      // No presente en PATH de Windows
    }
  }

  // Si aún no existe en disco, se retorna la ruta destino donde se descargará
  return localUserBin;
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
    return ALLOWED_DOWNLOAD_DOMAINS.some(domain =>
      parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

/**
 * Descarga un archivo por HTTPS con redirecciones seguras y escritura atómica.
 *
 * Protocolo de escritura atómica (garantía anti-race-condition en Windows):
 *   1. Escribe el contenido en <dest>.tmp
 *   2. Espera el evento 'finish' del WriteStream y cierra el descriptor
 *   3. Verifica que el .tmp tenga tamaño > MIN_SIZE (descarta páginas de error HTML)
 *   4. Elimina <dest> si existía y renombra .tmp → dest atómicamente con renameSync
 *   5. Solo entonces la promesa resuelve, desbloqueando _initPromise
 *
 * @param {string} url
 * @param {string} dest
 * @param {number} [hop=0]
 * @returns {Promise<void>}
 */
function downloadFile(url, dest, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > MAX_HOPS) return reject(new Error(`Demasiadas redirecciones (>${MAX_HOPS})`));
    if (!isAllowedUrl(url)) return reject(new Error(`URL o dominio no autorizado: ${url}`));

    const tmp = dest + '.tmp';
    const parentDir = path.dirname(dest);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Eliminar cualquier .tmp residual de una descarga anterior interrumpida
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}

    const req = https.get(url, { timeout: 60_000 }, (res) => {
      const { statusCode, headers } = res;

      if ([301, 302, 307, 308].includes(statusCode)) {
        if (!headers.location) {
          res.resume();
          return reject(new Error(`Redirección ${statusCode} sin cabecera Location`));
        }
        res.resume();
        const nextUrl = new URL(headers.location, url).toString();
        if (!isAllowedUrl(nextUrl)) {
          return reject(new Error(`Redirección a dominio no autorizado: ${nextUrl}`));
        }
        return resolve(downloadFile(nextUrl, dest, hop + 1));
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} al descargar yt-dlp desde ${url}`));
      }

      const out = fs.createWriteStream(tmp);
      res.pipe(out);

      // ── Escritura Atómica con Validación de Tamaño ────────────────────────
      out.on('finish', () => {
        // out.close() garantiza que el descriptor del archivo está cerrado
        // y todos los bytes han sido escritos en disco antes de renombrar.
        out.close((closeErr) => {
          if (closeErr) {
            try { fs.unlinkSync(tmp); } catch {}
            return reject(new Error(`Error al cerrar descriptor de archivo .tmp: ${closeErr.message}`));
          }

          // Validación de tamaño mínimo sobre el .tmp (antes de renombrar)
          // Esto protege contra páginas de error HTML descargadas por redirecciones
          // no detectadas o respuestas de rate-limiting que devuelvan 200 con HTML.
          let tmpSize = 0;
          try {
            tmpSize = fs.statSync(tmp).size;
          } catch (statErr) {
            return reject(new Error(`No se pudo leer el tamaño del archivo .tmp: ${statErr.message}`));
          }

          if (tmpSize < MIN_SIZE) {
            try { fs.unlinkSync(tmp); } catch {}
            return reject(new Error(
              `Descarga corrupta o incompleta: el archivo .tmp tiene solo ${tmpSize} bytes ` +
              `(mínimo requerido: ${MIN_SIZE} bytes). ` +
              `Puede ser una página de error HTML o una descarga interrumpida.`
            ));
          }

          // Rename atómico: reemplaza el destino solo cuando .tmp es válido
          try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            fs.renameSync(tmp, dest);
            resolve();
          } catch (renameErr) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
            reject(new Error(`Error al renombrar .tmp → destino: ${renameErr.message}`));
          }
        });
      });

      out.on('error', (e) => {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        reject(new Error(`Error de escritura en disco: ${e.message}`));
      });

      res.on('error', (e) => {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
        reject(new Error(`Error de transferencia HTTP: ${e.message}`));
      });
    });

    req.on('error', (e) => reject(new Error(`Error de red: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout de descarga agotado para yt-dlp'));
    });
  });
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
 * @param {Electron.App} appInstance
 * @returns {string|null}
 */
function resolveFfmpeg(appInstance) {
  const ffmpegName = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = appInstance.isPackaged
    ? path.join(process.resourcesPath, '..', 'backend', 'bin', ffmpegName)
    : path.join(__dirname, '..', '..', 'backend', 'bin', ffmpegName);

  if (fs.existsSync(bundled)) {
    console.log(`[ytdlp-manager] FFmpeg bundleado detectado: ${bundled}`);
    return bundled;
  }

  if (!IS_WIN) {
    const sysPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const p of sysPaths) {
      if (fs.existsSync(p)) {
        console.log(`[ytdlp-manager] FFmpeg global detectado: ${p}`);
        return p;
      }
    }
  }

  try {
    const cmd = IS_WIN ? 'where' : 'which';
    const out = execFileSync(cmd, [ffmpegName], { encoding: 'utf8', windowsHide: true })
      .trim().split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) {
      console.log(`[ytdlp-manager] FFmpeg en PATH: ${out}`);
      return out;
    }
  } catch {
    // FFmpeg no encontrado en PATH
  }

  console.warn('[ytdlp-manager] ⚠️ FFmpeg no encontrado en el sistema ni en el bundle.');
  return null;
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
    _outputDir = resolveOutputDir(appInstance);

    // 2. Resolver ubicación candidata de yt-dlp
    const candidatePath = getYtDlpPath(appInstance);
    console.log(`[ytdlp-manager] Ruta evaluada para yt-dlp: ${candidatePath}`);

    // Si ya existe en el disco, validarlo
    if (fs.existsSync(candidatePath)) {
      makeExecutable(candidatePath);
      const val = validateBinary(candidatePath);

      if (val.valid) {
        _binaryPath = candidatePath;
        broadcastStatus('READY', `yt-dlp v${val.version} listo para operar.`, { version: val.version });
        updateInBackground(_binaryPath);
        return _binaryPath;
      } else {
        console.warn(`[ytdlp-manager] Binario existente no válido (${val.error}). Reintentando descarga limpia...`);
        try { fs.unlinkSync(candidatePath); } catch {}
      }
    }

    // 3. Descarga desde fuente oficial de GitHub Releases
    const targetPath = path.normalize(path.join(appInstance.getPath('userData'), 'bin', BIN_NAME));
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: DIR_MODE });
    }

    broadcastStatus('INITIALIZING', `Descargando motor ${BIN_NAME} desde GitHub Releases, por favor espere...`);
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
      broadcastStatus('READY', `yt-dlp v${valPost.version} descargado e instalado correctamente.`, { version: valPost.version });
      return _binaryPath;

    } catch (dlErr) {
      console.error(`[ytdlp-manager] Error durante la descarga/instalación de yt-dlp: ${dlErr.message}`);
      _binaryPath = targetPath;
      broadcastStatus('ERROR', `Error al inicializar yt-dlp: ${dlErr.message}`);
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
  getBinaryPath: () => _binaryPath || (typeof app !== 'undefined' ? getYtDlpPath(app) : null),
  getFfmpegPath: () => _ffmpegPath,
  getOutputDir: () => _outputDir,
  getYtDlpStatus: () => _status,
  isYtDlpReady: () => _status === 'READY',
  sanitizePath,
  validateBinary,
};
