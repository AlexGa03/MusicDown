'use strict';

/**
 * @file ytdlp-manager.js
 * @description Gestiona el ciclo de vida del binario standalone yt-dlp.
 *
 * Responsabilidades:
 *   - Descarga desde GitHub Releases si no existe en userData/bin/.
 *   - Validación post-descarga: tamaño > 1 MB + ejecución de --version.
 *   - chmod 755 en Linux (no-op en Windows).
 *   - Verificación y corrección del bit +x en cada arranque.
 *   - Auto-update no bloqueante (yt-dlp -U) si ya existe.
 *   - Resolución de ffmpeg bundleado o del sistema.
 *   - Resolución del directorio de descarga escribible.
 */

const fs               = require('fs');
const path             = require('path');
const https            = require('https');
const os               = require('os');
const { execFileSync, execFile } = require('child_process');
const { app } = require('electron');
// ─── Constantes ───────────────────────────────────────────────────────────────

const IS_WIN      = process.platform === 'win32';
const BIN_NAME    = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const EXEC_MODE   = 0o755;
const DIR_MODE    = 0o700;
const MIN_SIZE    = 1_000_000; // 1 MB mínimo para un binario real
const MAX_HOPS    = 10;

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

// ─── Estado del módulo ────────────────────────────────────────────────────────

/** @type {string|null} Ruta al binario yt-dlp, disponible tras ensureYtDlp(). */
let _binaryPath = null;
/** @type {string|null} Ruta a ffmpeg (bundleado o del sistema). */
let _ffmpegPath = null;
/** @type {string|null} Directorio de descarga escribible. */
let _outputDir  = null;

// ─── Helpers de Seguridad y Sanitización ─────────────────────────────────────
function getYtDlpPath() {
  const localUserBin = path.join(app.getPath('userData'), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  
  // 1. Si existe en userData, usarlo
  if (fs.existsSync(localUserBin)) {
    return localUserBin;
  }
  
  // 2. Fallback para contenedores Docker o sistemas con yt-dlp global
  const systemBin = '/usr/local/bin/yt-dlp';
  if (fs.existsSync(systemBin)) {
    return systemBin;
  }

  return localUserBin;
}
/**
 * Valida que una URL use HTTPS y provenga de un dominio oficial de GitHub.
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
 * Sanitiza una ruta del sistema para evitar exponer nombres de usuario en logs o interfaz.
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

// ─── Descarga HTTPS con redirecciones seguras ────────────────────────────────

/**
 * Descarga una URL HTTPS siguiendo redirecciones validadas contra dominios permitidos.
 * Escritura atómica: primero a <dest>.tmp, luego rename.
 *
 * @param {string} url
 * @param {string} dest       Ruta final del archivo.
 * @param {number} [hop=0]   Contador de saltos (interno).
 * @returns {Promise<void>}
 */
function downloadFile(url, dest, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > MAX_HOPS) return reject(new Error(`Demasiadas redirecciones (>${MAX_HOPS})`));
    if (!isAllowedUrl(url)) return reject(new Error(`URL o dominio no autorizado para descarga: ${url}`));

    const tmp = dest + '.tmp';

    const req = https.get(url, { timeout: 60_000 }, (res) => {
      const { statusCode, headers } = res;

      // Seguir redirecciones
      if ([301, 302, 307, 308].includes(statusCode)) {
        if (!headers.location) {
          res.resume();
          return reject(new Error(`Redirección ${statusCode} sin cabecera Location`));
        }
        res.resume();
        const nextUrl = new URL(headers.location, url).toString();
        if (!isAllowedUrl(nextUrl)) {
          return reject(new Error(`Redirección a dominio no autorizado bloqueada: ${nextUrl}`));
        }
        return resolve(downloadFile(nextUrl, dest, hop + 1));
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} al descargar yt-dlp`));
      }

      const out = fs.createWriteStream(tmp);
      res.pipe(out);

      out.on('finish', () => {
        out.close(() => {
          fs.rename(tmp, dest, (err) => {
            if (err) { fs.unlink(tmp, () => {}); return reject(err); }
            resolve();
          });
        });
      });
      out.on('error', (e) => { fs.unlink(tmp, () => {}); reject(e); });
      res.on('error', (e) => { fs.unlink(tmp, () => {}); reject(e); });
    });

    req.on('error', (e) => reject(new Error(`Red: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout descargando yt-dlp')); });
  });
}

// ─── Permisos ─────────────────────────────────────────────────────────────────

/**
 * Aplica chmod 755 en POSIX. No-op en Windows.
 * @param {string} p
 */
function makeExecutable(p) {
  if (IS_WIN) return;
  try {
    fs.chmodSync(p, EXEC_MODE);
    console.log(`[ytdlp-manager] chmod 755 OK: ${p}`);
  } catch (e) {
    console.warn(`[ytdlp-manager] chmod falló: ${e.message}`);
  }
}

/**
 * Verifica y corrige el bit +x si falta (montaje noexec, copia sin permisos, etc.).
 * @param {string} p
 */
function ensureExecBit(p) {
  if (IS_WIN) return;
  try {
    const mode = fs.statSync(p).mode;
    if ((mode & 0o111) === 0) {
      console.warn(`[BINARY CHECK] Bit +x ausente. Aplicando chmodSync...`);
      fs.chmodSync(p, EXEC_MODE);
      console.log('[BINARY CHECK] Permisos corregidos.');
    }
  } catch (e) {
    console.warn(`[BINARY CHECK] No se pudo verificar permisos: ${e.message}`);
  }
}

// ─── Validación del binario ───────────────────────────────────────────────────

/**
 * Valida que el binario sea real (no HTML de error) y ejecutable.
 *   1. Comprueba existencia.
 *   2. Tamaño mínimo > 1 MB.
 *   3. Ejecuta `yt-dlp --version` con timeout de 10 s.
 *
 * @param {string} p
 * @returns {{ valid: boolean, version?: string, error?: string }}
 */
function validateBinary(p) {
  if (!fs.existsSync(p)) return { valid: false, error: 'No existe.' };

  const { size } = fs.statSync(p);
  console.log(`[BINARY CHECK] Tamaño: ${(size / 1e6).toFixed(2)} MB`);
  if (size < MIN_SIZE) {
    return { valid: false, error: `Binario demasiado pequeño (${size} bytes). Probablemente un HTML de error.` };
  }

  try {
    const version = execFileSync(p, ['--version'], {
      timeout:     10_000,
      encoding:    'utf8',
      windowsHide: true,
    }).trim();
    console.log(`[BINARY CHECK] yt-dlp --version: ${version}`);
    return { valid: true, version };
  } catch (e) {
    return { valid: false, error: `--version falló: ${e.message}` };
  }
}

// ─── Directorio de salida escribible ─────────────────────────────────────────

/**
 * Resuelve el directorio de descarga por defecto, garantizando que sea escribible.
 * Cascada: downloads/MusicDown → Music/MusicDown → Documents/MusicDown → tmp/MusicDown.
 *
 * @param {Electron.App} app
 * @returns {string} Ruta absoluta escribible.
 */
function resolveOutputDir(app) {
  const candidates = [
    path.join(app.getPath('downloads'), 'MusicDown'),
    path.join(os.homedir(), 'Music',     'MusicDown'),
    path.join(os.homedir(), 'Documents', 'MusicDown'),
    path.join(os.tmpdir(),               'MusicDown'),
  ];

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write_probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      console.log(`[ytdlp-manager] Directorio de salida: ${dir}`);
      return dir;
    } catch {
      console.warn(`[ytdlp-manager] No escribible: ${dir}`);
    }
  }

  // Fallback de emergencia
  console.warn('[ytdlp-manager] Usando tmpdir() como fallback.');
  return os.tmpdir();
}

// ─── Auto-update en background ────────────────────────────────────────────────

/**
 * Ejecuta `yt-dlp -U` de forma no bloqueante.
 * Ignora errores de red (el usuario puede estar offline).
 * @param {string} p
 */
function updateInBackground(p) {
  console.log('[ytdlp-manager] Lanzando yt-dlp -U en background...');
  execFile(p, ['-U'], { timeout: 90_000, windowsHide: true }, (err, stdout, stderr) => {
    if (err) {
      const out = ((stdout || '') + (stderr || '')).toLowerCase();
      if (out.includes('up to date') || out.includes('up-to-date')) {
        console.log('[ytdlp-manager] yt-dlp ya está actualizado.');
      } else {
        console.warn('[ytdlp-manager] -U falló (sin red?):', err.message);
      }
      return;
    }
    console.log('[ytdlp-manager] -U resultado:', (stdout || stderr || '').trim() || '(sin salida)');
  });
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/** Ruta al binario. Null antes de ensureYtDlp(). */
function getBinaryPath() { return _binaryPath; }

/** Ruta a ffmpeg (bundleado o del sistema). Null si no se encontró. */
function getFfmpegPath()  { return _ffmpegPath; }

/** Directorio de descarga escribible. Null antes de ensureYtDlp(). */
function getOutputDir()   { return _outputDir; }

/**
 * Inicialización principal del manager.
 * Debe llamarse en `app.whenReady()`, antes de `createWindow()`.
 *
 * 1. Resuelve ffmpeg bundleado (backend/bin/) o del sistema.
 * 2. Resuelve el directorio de salida escribible.
 * 3. Descarga yt-dlp si no existe y lo valida.
 * 4. Verifica permisos si ya existe y lanza -U en background.
 *
 * @param {Electron.App} app
 * @returns {Promise<string>} Ruta al binario.
 */
async function ensureYtDlp(app) {
  // ── 1. ffmpeg ─────────────────────────────────────────────────────────────
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'backend', 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')
    : path.join(__dirname, '..', '..', 'backend', 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');

  if (fs.existsSync(bundled)) {
    _ffmpegPath = bundled;
    console.log(`[ytdlp-manager] ffmpeg bundleado: ${_ffmpegPath}`);
  } else {
    try {
      const cmd = IS_WIN ? 'where' : 'which';
      _ffmpegPath = execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
        .trim().split('\n')[0].trim();
      if (_ffmpegPath) console.log(`[ytdlp-manager] ffmpeg del sistema: ${_ffmpegPath}`);
    } catch {
      _ffmpegPath = null;
      console.warn('[ytdlp-manager] ⚠️  ffmpeg no encontrado. Conversión a MP3 desactivada.');
    }
  }

  // ── 2. Directorio de salida ───────────────────────────────────────────────
  _outputDir = resolveOutputDir(app);

  // ── 3. Directorio bin del manager ─────────────────────────────────────────
  const binDir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: DIR_MODE });
  if (!IS_WIN) {
    try { fs.chmodSync(binDir, DIR_MODE); } catch {}
  }

  const binaryPath = path.join(binDir, BIN_NAME);

  if (fs.existsSync(binaryPath)) {
    // Caso A: ya existe — verificar permisos y validar
    console.log(`[ytdlp-manager] Binario encontrado: ${sanitizePath(binaryPath)}`);
    ensureExecBit(binaryPath);

    const v = validateBinary(binaryPath);
    if (!v.valid) {
      console.error(`[BINARY CHECK] Binario inválido (${v.error}). Eliminando y re-descargando...`);
      fs.unlinkSync(binaryPath);
      return ensureYtDlp(app); // Recursión para descargar de nuevo
    }

    _binaryPath = binaryPath;
    updateInBackground(binaryPath);
  } else {
    // Caso B: no existe — descargar, permisos, validar
    console.log(`[ytdlp-manager] Descargando desde fuente oficial...`);
    await downloadFile(DOWNLOAD_URL, binaryPath);
    makeExecutable(binaryPath);
    ensureExecBit(binaryPath);

    const v = validateBinary(binaryPath);
    if (!v.valid) {
      fs.unlinkSync(binaryPath);
      throw new Error(`Binario descargado inválido: ${v.error}`);
    }

    console.log(`[ytdlp-manager] yt-dlp ${v.version} instalado correctamente.`);
    _binaryPath = binaryPath;
  }

  return _binaryPath;
}

module.exports = {
  ensureYtDlp,
  validateBinary,
  getBinaryPath,
  getFfmpegPath,
  getOutputDir,
  sanitizePath,
};
