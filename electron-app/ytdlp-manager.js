'use strict';

/**
 * @file ytdlp-manager.js
 * @description Gestiona el ciclo de vida del binario standalone de yt-dlp.
 *
 * Responsabilidades:
 *   - Descarga del binario desde GitHub Releases si no existe.
 *   - Validación post-descarga: tamaño mínimo + ejecución de --version.
 *   - Verificación y corrección del bit +x en cada arranque (Linux).
 *   - Actualización silenciosa en background (yt-dlp -U).
 *   - Resolución de la ruta de ffmpeg bundleado.
 *   - Resolución del directorio de descarga escribible.
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const os      = require('os');
const { execFileSync, execFile } = require('child_process');

// ─── Constantes ───────────────────────────────────────────────────────────────

const IS_WINDOWS  = process.platform === 'win32';
const BINARY_NAME = IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp';
const EXEC_MODE   = 0o755;
const DIR_MODE    = 0o700;
const MAX_REDIRECTS = 10;
/** Tamaño mínimo válido para un binario yt-dlp real (~3 MB). */
const MIN_BINARY_SIZE = 1_000_000;

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
const DOWNLOAD_URL = DOWNLOAD_URLS[process.platform] ?? DOWNLOAD_URLS.linux;

// Estado del módulo
let _resolvedBinaryPath = null;
let _ffmpegPath         = null;
let _outputDir          = null;

// ─── Helpers de Seguridad y Sanitización ─────────────────────────────────────

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

function sanitizePath(p) {
  if (!p || typeof p !== 'string') return '';
  const home = os.homedir();
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p;
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

function _getBinDir(app) {
  return path.join(app.getPath('userData'), 'bin');
}

/**
 * Descarga un archivo HTTPS siguiendo redirecciones seguras. Escritura atómica (.tmp → final).
 * @param {string} url
 * @param {string} destPath
 * @param {number} [hops=0]
 * @returns {Promise<void>}
 */
function _downloadFile(url, destPath, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > MAX_REDIRECTS)
      return reject(new Error(`[ytdlp-manager] Demasiadas redirecciones (>${MAX_REDIRECTS})`));
    if (!isAllowedUrl(url))
      return reject(new Error(`[ytdlp-manager] Dominio no autorizado para descarga: ${url}`));

    const tmpPath = destPath + '.tmp';

    const req = https.get(url, { timeout: 30_000 }, (res) => {
      const { statusCode, headers } = res;

      if ([301, 302, 307, 308].includes(statusCode)) {
        const location = headers.location;
        if (!location) { res.resume(); return reject(new Error(`Redirección ${statusCode} sin Location`)); }
        res.resume();
        const nextUrl = new URL(location, url).toString();
        if (!isAllowedUrl(nextUrl)) {
          return reject(new Error(`Redirección a dominio no autorizado: ${nextUrl}`));
        }
        return resolve(_downloadFile(nextUrl, destPath, hops + 1));
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`[ytdlp-manager] HTTP ${statusCode}`));
      }

      const stream = fs.createWriteStream(tmpPath);
      res.pipe(stream);

      stream.on('finish', () => {
        stream.close(() => {
          fs.rename(tmpPath, destPath, (err) => {
            if (err) { fs.unlink(tmpPath, () => {}); return reject(err); }
            resolve();
          });
        });
      });
      stream.on('error', (err) => { fs.unlink(tmpPath, () => {}); reject(err); });
      res.on('error',   (err) => { fs.unlink(tmpPath, () => {}); reject(err); });
    });
    req.on('error', (err) => reject(new Error(`[ytdlp-manager] Red: ${err.message}`)));
  });
}

/**
 * Aplica chmod 755 en POSIX. No-op en Windows.
 * @param {string} binaryPath
 * @returns {Promise<void>}
 */
function _makeExecutable(binaryPath) {
  if (IS_WINDOWS) return Promise.resolve();
  return new Promise((resolve, reject) => {
    fs.chmod(binaryPath, EXEC_MODE, (err) => {
      if (err) return reject(err);
      console.log(`[BINARY CHECK] chmod 755 aplicado: ${binaryPath}`);
      resolve();
    });
  });
}

/**
 * Verifica y corrige el bit +x si falta (Linux).
 * Puede ocurrir si el archivo se copió desde un FS montado noexec.
 * @param {string} binaryPath
 */
function _ensureExecutableBit(binaryPath) {
  if (IS_WINDOWS) return;
  try {
    const stat = fs.statSync(binaryPath);
    if ((stat.mode & 0o111) === 0) {
      console.warn(`[BINARY CHECK] Bit +x ausente en ${binaryPath}. Aplicando chmodSync...`);
      fs.chmodSync(binaryPath, EXEC_MODE);
      console.log('[BINARY CHECK] Permisos corregidos OK.');
    } else {
      console.log(`[BINARY CHECK] Permisos OK (mode=${stat.mode.toString(8)}): ${binaryPath}`);
    }
  } catch (err) {
    console.warn(`[BINARY CHECK] No se pudo verificar permisos: ${err.message}`);
  }
}

/**
 * Valida que el binario descargado sea real y no un HTML de error:
 *   1. Tamaño > MIN_BINARY_SIZE
 *   2. Ejecución de `yt-dlp --version` con exit 0
 * @param {string} binaryPath
 * @returns {{ valid: boolean, version?: string, error?: string }}
 */
function validateBinary(binaryPath) {
  console.log(`[BINARY CHECK] Validando binario: ${binaryPath}`);

  // 1. Existencia
  if (!fs.existsSync(binaryPath)) {
    return { valid: false, error: 'El archivo no existe.' };
  }

  // 2. Tamaño mínimo
  const stat = fs.statSync(binaryPath);
  console.log(`[BINARY CHECK] Tamaño: ${(stat.size / 1_000_000).toFixed(2)} MB (mínimo: ${MIN_BINARY_SIZE / 1_000_000} MB)`);
  if (stat.size < MIN_BINARY_SIZE) {
    return {
      valid: false,
      error: `Binario demasiado pequeño (${stat.size} bytes). Probablemente es un HTML de error.`,
    };
  }

  // 3. Prueba de ejecución: yt-dlp --version
  try {
    const version = execFileSync(binaryPath, ['--version'], {
      timeout:     10_000,
      encoding:    'utf8',
      windowsHide: true,
    }).trim();
    console.log(`[BINARY CHECK] yt-dlp --version OK: ${version}`);
    return { valid: true, version };
  } catch (err) {
    return {
      valid: false,
      error: `yt-dlp --version falló: ${err.message}`,
    };
  }
}

/**
 * Resuelve el directorio de descarga por defecto, garantizando que sea escribible.
 * Cascada de candidatos:
 *   1. app.getPath('downloads') — directorio de descargas del sistema
 *   2. ~/Music
 *   3. ~/Documents
 *   4. os.tmpdir()/MusicDown — siempre disponible
 * @param {Electron.App} app
 * @returns {string} Ruta absoluta escribible.
 */
function resolveOutputDir(app) {
  const candidates = [
    path.join(app.getPath('downloads'), 'MusicDown'),
    path.join(os.homedir(), 'Music', 'MusicDown'),
    path.join(os.homedir(), 'Documents', 'MusicDown'),
    path.join(os.tmpdir(), 'MusicDown'),
  ];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Prueba de escritura real
      const testFile = path.join(dir, '.write_test');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      console.log(`[ytdlp-manager] Directorio de salida escribible: ${dir}`);
      return dir;
    } catch {
      console.warn(`[ytdlp-manager] Directorio no escribible: ${dir}`);
    }
  }

  // Fallback absoluto: directorio temporal del sistema operativo
  const fallback = os.tmpdir();
  console.warn(`[ytdlp-manager] Usando fallback de emergencia: ${fallback}`);
  return fallback;
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/** Ruta al binario yt-dlp resuelto. */
function getYtDlpPath() { return _resolvedBinaryPath; }

/** Ruta al binario ffmpeg resuelto (bundleado o del sistema). */
function getFfmpegPath() { return _ffmpegPath; }

/** Directorio de salida escribible resuelto. */
function getOutputDir()  { return _outputDir; }

/**
 * Lanza `yt-dlp -U` en background sin bloquear.
 * Ignora errores de red silenciosamente.
 * @param {string} binaryPath
 */
function updateYtDlpInBackground(binaryPath) {
  console.log('[ytdlp-manager] Lanzando yt-dlp -U en background...');
  execFile(binaryPath, ['-U'], { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) {
      const out = ((stdout || '') + (stderr || '')).toLowerCase();
      if (out.includes('up to date') || out.includes('up-to-date')) {
        console.log('[ytdlp-manager] yt-dlp ya esta en la ultima version.');
      } else {
        console.warn('[ytdlp-manager] Actualizacion fallida (probablemente sin red):', err.message);
      }
      return;
    }
    console.log('[ytdlp-manager] yt-dlp -U:', ((stdout || stderr || '').trim() || '(sin salida)'));
  });
}

/**
 * Punto de entrada principal. Llamar en `app.whenReady()` ANTES de `createWindow()`.
 *
 * Resuelve:
 *   - Ruta de ffmpeg bundleado o del sistema.
 *   - Directorio de descarga escribible.
 *   - Binario yt-dlp (descarga si no existe, valida si existe).
 *
 * @param {Electron.App} app
 * @returns {Promise<string>} Ruta al binario yt-dlp.
 */
async function ensureYtDlp(app) {
  const binDir     = _getBinDir(app);
  const binaryPath = path.join(binDir, BINARY_NAME);

  // ── 1. Resolver ffmpeg ────────────────────────────────────────────────────
  const bundledFfmpeg = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'backend', 'bin', IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg')
    : path.join(__dirname, 'backend', 'bin', IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg');

  if (fs.existsSync(bundledFfmpeg)) {
    _ffmpegPath = bundledFfmpeg;
    console.log(`[ytdlp-manager] ffmpeg bundleado: ${_ffmpegPath}`);
  } else {
    try {
      const cmd = IS_WINDOWS ? 'where' : 'which';
      _ffmpegPath = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
        .trim().split('\n')[0].trim();
      console.log(`[ytdlp-manager] ffmpeg del sistema: ${_ffmpegPath}`);
    } catch {
      _ffmpegPath = null;
      console.warn('[ytdlp-manager] ADVERTENCIA: ffmpeg no encontrado. Conversion a MP3 desactivada.');
    }
  }

  // ── 2. Resolver directorio de salida escribible ───────────────────────────
  _outputDir = resolveOutputDir(app);

  // ── 3. Crear directorio bin ───────────────────────────────────────────────
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true, mode: DIR_MODE });
    if (!IS_WINDOWS) {
      try { fs.chmodSync(binDir, DIR_MODE); } catch {}
    }
  }

  if (fs.existsSync(binaryPath)) {
    // Caso A: Ya existe — verificar permisos y validar
    console.log(`[ytdlp-manager] Binario encontrado: ${sanitizePath(binaryPath)}`);
    _ensureExecutableBit(binaryPath);

    const validation = validateBinary(binaryPath);
    if (!validation.valid) {
      console.error(`[BINARY CHECK] Binario invalido: ${validation.error}`);
      console.log('[ytdlp-manager] Eliminando binario corrupto y re-descargando...');
      fs.unlinkSync(binaryPath);
      // Recursion: descargará de nuevo en el siguiente bloque
      return ensureYtDlp(app);
    }

    _resolvedBinaryPath = binaryPath;
    updateYtDlpInBackground(binaryPath);
  } else {
    // Caso B: No existe — descargar, permisos, validar
    console.log(`[ytdlp-manager] Descargando yt-dlp desde fuente oficial...`);
    await _downloadFile(DOWNLOAD_URL, binaryPath);
    await _makeExecutable(binaryPath);
    _ensureExecutableBit(binaryPath);

    const validation = validateBinary(binaryPath);
    if (!validation.valid) {
      fs.unlinkSync(binaryPath);
      throw new Error(`[ytdlp-manager] Binario descargado inválido: ${validation.error}`);
    }

    console.log(`[ytdlp-manager] yt-dlp ${validation.version} listo.`);
    _resolvedBinaryPath = binaryPath;
  }

  return _resolvedBinaryPath;
}

module.exports = {
  ensureYtDlp,
  validateBinary,
  updateYtDlpInBackground,
  getYtDlpPath,
  getFfmpegPath,
  getOutputDir,
  sanitizePath,
};
