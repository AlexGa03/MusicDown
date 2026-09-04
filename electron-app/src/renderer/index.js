/**
 * @file src/renderer/index.js
 * @description Lógica completa del renderer de MusicDown.
 *
 * IMPORTANTE: Este script se carga al final del <body> del HTML, por lo que
 * el DOM ya está completamente parseado cuando se ejecuta. No se necesita
 * esperar a DOMContentLoaded para acceder a elementos — pero lo hacemos de
 * todas formas para garantizar compatibilidad con cualquier cambio de carga.
 *
 * API disponible en window.electronAPI (expuesta por src/preload.js):
 *   .addItems(items)             → Promise<{ added, total }>
 *   .startQueue()                → Promise<{ started, count? }>
 *   .stop()                      → Promise<{ stopped }>
 *   .clear()                     → Promise<{ cleared }>
 *   .openFolder()                → Promise<{ opened, dir? }>
 *   .getStatus()                 → Promise<Status>
 *   .answerPlaylist(url, dlAll)  → Promise<{ ok }>
 *   .onLog(cb)                   → () => void (cleanup)
 *   .onProgress(cb)              → () => void
 *   .onQueueUpdate(cb)           → () => void
 *   .onDone(cb)                  → () => void
 *   .onError(cb)                 → () => void
 *   .onQueueDone(cb)             → () => void
 *   .onPlaylistPrompt(cb)        → () => void
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. ESTADO DE LA UI
// ─────────────────────────────────────────────────────────────────────────────

/** @type {{ url: string, title: string, isPlaylist: boolean, status: string }[]} */
let queueItems     = [];
let isDownloading  = false;
/** @type {boolean} — se establece al recibir getStatus() con isDocker:true */
let isDockerEnv    = false;

// ─────────────────────────────────────────────────────────────────────────────
// 2. HELPER DE LOGS (DOM + consola del navegador)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inserta un mensaje en el panel de logs del DOM Y en console.log del navegador.
 * Siempre loguea en consola aunque el panel no exista.
 *
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'|'progress'} type
 */
function appendLog(message, type = 'info') {
  // Siempre en consola del navegador (visible en DevTools > Console)
  const icons = { info: 'ℹ', success: '✓', error: '✗', warn: '⚠', progress: '↓' };
  console.log(`[LOG-${type.toUpperCase()}] ${icons[type] ?? '·'} ${message}`);

  const logPanel = document.getElementById('log-panel');
  if (!logPanel) return;

  const entry = document.createElement('div');
  entry.className = `log-${type}`;

  const ts   = new Date().toLocaleTimeString('es-ES', { hour12: false });
  entry.textContent = `[${ts}] ${icons[type] ?? '·'} ${message}`;

  logPanel.appendChild(entry);

  // Auto-scroll al fondo
  const container = logPanel.parentElement;
  if (container) container.scrollTop = container.scrollHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. HELPERS DE BARRA DE PROGRESO
// ─────────────────────────────────────────────────────────────────────────────

function showProgress(title, percent, speed, eta) {
  const container = document.getElementById('progress-container');
  const titleEl   = document.getElementById('progress-title');
  const percentEl = document.getElementById('progress-percent');
  const barEl     = document.getElementById('progress-bar');
  const metaEl    = document.getElementById('progress-meta');

  if (!container) return;

  container.classList.remove('hidden');
  if (titleEl)   titleEl.textContent   = title.length > 45 ? title.slice(0, 42) + '...' : title;
  if (percentEl) percentEl.textContent = `${percent.toFixed(1)}%`;
  if (barEl)     barEl.style.width     = `${percent}%`;
  if (metaEl)    metaEl.textContent    = `${speed}  ETA ${eta}`;
}

function hideProgress() {
  const container = document.getElementById('progress-container');
  const barEl     = document.getElementById('progress-bar');
  if (container) container.classList.add('hidden');
  if (barEl)     barEl.style.width = '0%';
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. RENDERIZADO DE LA COLA
// ─────────────────────────────────────────────────────────────────────────────

function renderQueue() {
  const listEl  = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');

  if (countEl) countEl.textContent = queueItems.length;
  if (!listEl) return;

  if (queueItems.length === 0) {
    listEl.innerHTML = '<div class="text-gray-500 text-center mt-12 text-sm italic">La cola está vacía</div>';
    return;
  }

  listEl.innerHTML = '';
  queueItems.forEach((item, idx) => {
    const div = document.createElement('div');

    const statusClass = {
      pending: 'item-pending',
      active:  'item-active',
      done:    'item-done',
      error:   'item-error',
    }[item.status] ?? 'item-pending';

    const statusBadge = {
      active:  '<span class="text-xs text-blue-400 animate-pulse shrink-0">⏳ En curso</span>',
      done:    '<span class="text-xs text-green-400 shrink-0">✓</span>',
      error:   '<span class="text-xs text-red-400 shrink-0">✗</span>',
      pending: '',
    }[item.status] ?? '';

    const playlistBadge = item.isPlaylist
      ? '<span class="text-xs bg-purple-900/60 text-purple-300 px-1.5 py-0.5 rounded shrink-0">Playlist</span>'
      : '';

    div.className = `p-3 rounded-lg flex items-center gap-2.5 transition-all ${statusClass}`;
    div.innerHTML = `
      <span class="text-gray-500 font-mono text-xs w-5 shrink-0">${idx + 1}.</span>
      <span class="flex-1 truncate text-sm text-gray-200" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
      ${playlistBadge}
      ${statusBadge}
    `;
    listEl.appendChild(div);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ESTADO DE BOTONES
// ─────────────────────────────────────────────────────────────────────────────

function updateButtons() {
  const hasPending = queueItems.some(i => i.status === 'pending');

  const btnStart  = document.getElementById('btn-start');
  const btnStop   = document.getElementById('btn-stop');
  const btnClear  = document.getElementById('btn-clear');
  const btnFolder = document.getElementById('btn-folder');

  if (btnStart)  btnStart.disabled  = isDownloading || !hasPending;
  if (btnStop)   btnStop.disabled   = !isDownloading;
  if (btnClear)  btnClear.disabled  = isDownloading;

  // En Docker no hay gestor de archivos de escritorio; ocultar el botón
  // y mostrar un tooltip informativo sobre el volumen montado.
  if (btnFolder) {
    if (isDockerEnv) {
      btnFolder.disabled = true;
      btnFolder.style.opacity = '0.35';
      btnFolder.style.cursor  = 'not-allowed';
      btnFolder.title = 'Entorno Docker: accede a /app/downloads desde el host';
    } else {
      btnFolder.disabled = false;
      btnFolder.style.opacity = '';
      btnFolder.style.cursor  = '';
      btnFolder.title = '';
    }
  }

  console.log(`[RENDERER] updateButtons — isDownloading=${isDownloading} hasPending=${hasPending} isDockerEnv=${isDockerEnv}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. MODAL DE CONFIRMACIÓN DE PLAYLIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Muestra un modal bloqueante para elegir cómo descargar una playlist.
 * @param {string} url
 * @param {string} title
 * @returns {Promise<boolean>} true = playlist completa; false = solo canción.
 */
function showPlaylistModal(url, title) {
  return new Promise((resolve) => {
    // Eliminar modal anterior si existe
    const existing = document.getElementById('playlist-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'playlist-modal';
    overlay.className = 'fixed inset-0 bg-black/75 flex items-center justify-center z-50';
    overlay.innerHTML = `
      <div class="bg-gray-800 border border-gray-600 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <h2 class="text-base font-bold text-white mb-2">🎵 Playlist detectada</h2>
        <p class="text-sm text-gray-300 mb-1 truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</p>
        <p class="text-xs text-gray-500 mb-5 break-all">${escapeHtml(url)}</p>
        <p class="text-sm text-gray-400 mb-4">¿Cómo deseas descargarla?</p>
        <div class="flex gap-3">
          <button id="playlist-modal-single"
            class="flex-1 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-600 text-sm font-medium transition cursor-pointer">
            🎵 Solo esta canción
          </button>
          <button id="playlist-modal-all"
            class="flex-1 py-2.5 rounded-xl bg-purple-700 hover:bg-purple-600 text-sm font-medium transition cursor-pointer">
            📂 Playlist completa
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    document.getElementById('playlist-modal-single').addEventListener('click', () => cleanup(false));
    document.getElementById('playlist-modal-all').addEventListener('click',    () => cleanup(true));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ACCIONES PRINCIPALES (invocan window.electronAPI)
// ─────────────────────────────────────────────────────────────────────────────

/** Añade el texto del input a la cola. */
async function handleAddSingle() {
  console.log('[RENDERER] handleAddSingle() invocado');

  const inputEl = document.getElementById('input-url');
  const value   = inputEl?.value?.trim();

  if (!value) {
    appendLog('Introduce una canción o URL antes de añadir.', 'warn');
    return;
  }
  if (!window.electronAPI) {
    appendLog('ERROR: API de Electron no disponible (preload no cargado).', 'error');
    return;
  }

  appendLog(`Añadiendo: "${value}"...`, 'info');

  try {
    const result = await window.electronAPI.addItems([value]);
    console.log('[RENDERER] addItems result:', result);

    if (result.added > 0) {
      appendLog(`✓ Añadido. Cola: ${result.total} elemento(s).`, 'success');
      if (inputEl) inputEl.value = '';
    } else {
      appendLog(`"${value}" ya está en la cola o no es válido.`, 'warn');
    }
  } catch (err) {
    console.error('[RENDERER] addItems ERROR:', err);
    appendLog(`Error al añadir: ${err.message}`, 'error');
  }
}

/** Inicia el procesamiento de la cola. */
async function handleStartQueue() {
  console.log('[RENDERER] handleStartQueue() invocado');

  if (isDownloading) {
    appendLog('Ya hay una descarga en curso.', 'warn');
    return;
  }
  if (!window.electronAPI) {
    appendLog('ERROR: API de Electron no disponible.', 'error');
    return;
  }

  appendLog('Iniciando cola de descargas...', 'info');
  isDownloading = true;
  updateButtons();

  try {
    const result = await window.electronAPI.startQueue();
    console.log('[RENDERER] startQueue result:', result);

    if (!result.started) {
      appendLog(`No se pudo iniciar: ${result.reason ?? 'desconocido'}`, 'error');
      isDownloading = false;
      updateButtons();
    } else {
      appendLog(`Cola aceptada: ${result.count} elemento(s). Procesando...`, 'success');
    }
  } catch (err) {
    console.error('[RENDERER] startQueue ERROR:', err);
    appendLog(`Error al iniciar: ${err.message}`, 'error');
    isDownloading = false;
    updateButtons();
  }
}

/** Detiene la descarga activa. */
async function handleStop() {
  console.log('[RENDERER] handleStop() invocado');

  if (!window.electronAPI) return;
  appendLog('Deteniendo descarga...', 'warn');

  try {
    const result = await window.electronAPI.stop();
    console.log('[RENDERER] stop result:', result);
    appendLog('Descarga detenida.', 'warn');
  } catch (err) {
    console.error('[RENDERER] stop ERROR:', err);
    appendLog(`Error al detener: ${err.message}`, 'error');
  }
}

/** Vacía la cola. */
async function handleClear() {
  console.log('[RENDERER] handleClear() invocado');

  if (isDownloading) {
    appendLog('No se puede limpiar mientras hay una descarga activa.', 'warn');
    return;
  }
  if (!window.electronAPI) return;

  try {
    const result = await window.electronAPI.clear();
    console.log('[RENDERER] clear result:', result);

    if (result.cleared) {
      queueItems = [];
      renderQueue();
      updateButtons();
      appendLog('Cola limpiada.', 'info');
    }
  } catch (err) {
    console.error('[RENDERER] clear ERROR:', err);
    appendLog(`Error al limpiar: ${err.message}`, 'error');
  }
}

/** Abre el directorio de descargas con el explorador nativo. */
async function handleOpenFolder() {
  console.log('[RENDERER] handleOpenFolder() invocado');

  if (!window.electronAPI) return;

  try {
    const result = await window.electronAPI.openFolder();
    console.log('[RENDERER] openFolder result:', result);

    if (result.docker) {
      // En Docker, el main process ya emitió el mensaje por IPC log.
      // Aquí añadimos una copia en la consola del renderer como refuerzo visual.
      appendLog(result.message ?? '📦 Docker: sincroniza canciones en el volumen /app/downloads del host.', 'info');
      return;
    }

    if (!result.opened) {
      appendLog(`No se pudo abrir la carpeta: ${result.error ?? 'Desconocido'}`, 'error');
    }
  } catch (err) {
    console.error('[RENDERER] openFolder ERROR:', err);
    appendLog(`Error al abrir carpeta: ${err.message}`, 'error');
  }
}

/** Limpia el panel de logs. */
function handleClearConsole() {
  console.log('[RENDERER] handleClearConsole() invocado');
  const logPanel = document.getElementById('log-panel');
  if (logPanel) {
    logPanel.innerHTML = '<div class="log-info">&gt; Consola limpiada.</div>';
  }
}

/** Procesa un archivo .txt importado línea por línea. */
async function handleFileImport(file) {
  console.log('[RENDERER] handleFileImport() — archivo:', file?.name);

  if (!file) return;
  if (!window.electronAPI) {
    appendLog('ERROR: API de Electron no disponible.', 'error');
    return;
  }

  appendLog(`Importando "${file.name}"...`, 'info');

  const text  = await file.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  console.log('[RENDERER] Líneas parseadas del .txt:', lines.length, lines);

  if (lines.length === 0) {
    appendLog('El archivo está vacío.', 'warn');
    return;
  }

  try {
    const result = await window.electronAPI.addItems(lines);
    console.log('[RENDERER] addItems (file) result:', result);
    appendLog(`✓ Importados ${result.added} de ${lines.length} elemento(s) de "${file.name}".`, 'success');
  } catch (err) {
    console.error('[RENDERER] addItems (file) ERROR:', err);
    appendLog(`Error al importar: ${err.message}`, 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. SUSCRIPCIONES A EVENTOS IPC DEL MAIN PROCESS
// ─────────────────────────────────────────────────────────────────────────────

function initIPCListeners() {
  console.log('[RENDERER] initIPCListeners() — verificando window.electronAPI...');

  if (!window.electronAPI) {
    console.error('[RENDERER] CRÍTICO: window.electronAPI es undefined o null.');
    appendLog('⚠️ API de Electron no detectada. Verifica que el preload esté cargado.', 'error');
    return;
  }

  console.log('[RENDERER] window.electronAPI disponible:', Object.keys(window.electronAPI));

  // Suscripción a logs
  window.electronAPI.onLog(({ level, msg }) => {
    appendLog(msg, level);
  });

  // Progreso de descarga individual
  window.electronAPI.onProgress(({ title, percent, speed, eta }) => {
    console.log(`[RENDERER] onProgress: ${title} — ${percent}%`);
    showProgress(title, percent, speed, eta);
  });

  // Actualización del estado de toda la cola
  window.electronAPI.onQueueUpdate(({ queue, active }) => {
    console.log(`[RENDERER] onQueueUpdate: ${queue.length} items, active=${active}`);
    queueItems    = queue;
    isDownloading = active;
    renderQueue();
    updateButtons();
  });

  // Descarga individual completada
  window.electronAPI.onDone(({ title, outputPath }) => {
    console.log('[RENDERER] onDone:', title, outputPath);
    appendLog(`✓ Completado: "${title}"${outputPath ? ' → ' + outputPath : ''}`, 'success');
  });

  // Error en descarga individual
  window.electronAPI.onError(({ title, message }) => {
    console.error('[RENDERER] onError:', title, message);
    appendLog(`✗ Error en "${title}": ${message}`, 'error');
  });

  // Cola entera finalizada
  window.electronAPI.onQueueDone(({ completed, errors }) => {
    console.log(`[RENDERER] onQueueDone: completed=${completed} errors=${errors}`);
    isDownloading = false;
    hideProgress();
    updateButtons();
    appendLog(`🏁 Finalizado: ${completed} OK${errors > 0 ? `, ${errors} errores` : ''}.`, 'success');
  });

  // Prompt de confirmación de playlist
  window.electronAPI.onPlaylistPrompt(async ({ url, title }) => {
    console.log('[RENDERER] onPlaylistPrompt:', url, title);
    appendLog(`⚠️ Playlist detectada: "${title}". Esperando decisión...`, 'warn');

    const downloadAll = await showPlaylistModal(url, title);

    console.log(`[RENDERER] Respuesta playlist: downloadAll=${downloadAll}`);
    appendLog(`Descargando ${downloadAll ? 'playlist completa' : 'solo canción actual'}.`, 'info');

    try {
      await window.electronAPI.answerPlaylist(url, downloadAll);
    } catch (err) {
      console.error('[RENDERER] answerPlaylist ERROR:', err);
    }
  });

  // Suscripción al estado de yt-dlp en tiempo real
  if (typeof window.electronAPI.onYtDlpStatus === 'function') {
    window.electronAPI.onYtDlpStatus(({ status, message, version }) => {
      console.log(`[RENDERER] onYtDlpStatus: ${status} - ${message}`);
      const indicator = document.getElementById('status-indicator');
      if (indicator) {
        if (status === 'READY') {
          indicator.textContent = `yt-dlp OK ${version ? 'v' + version : ''}`;
          indicator.className   = 'text-xs font-mono no-drag text-green-400';
        } else if (status === 'INITIALIZING') {
          indicator.textContent = '⏳ Descargando yt-dlp...';
          indicator.className   = 'text-xs font-mono no-drag text-yellow-400 animate-pulse';
        } else if (status === 'ERROR') {
          indicator.textContent = '⚠️ Error yt-dlp';
          indicator.className   = 'text-xs font-mono no-drag text-red-400';
        }
      }
    });
  }

  console.log('[RENDERER] Suscripciones IPC registradas OK.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. INICIALIZACIÓN — EVENT LISTENERS DEL DOM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra todos los event listeners del DOM.
 * Se llama tanto en DOMContentLoaded como directamente al ejecutarse el script
 * (el script está al final del body, el DOM ya está parseado).
 */
function initDOM() {
  console.log('[RENDERER] initDOM() — registrando event listeners...');

  // ── Botón "+ Añadir" ──────────────────────────────────────────────────────
  const btnAdd = document.getElementById('btn-add');
  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      console.log('[RENDERER] btn-add click');
      handleAddSingle();
    });
    console.log('[RENDERER] btn-add listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #btn-add no encontrado en el DOM');
  }

  // ── Input URL: Enter para añadir ─────────────────────────────────────────
  const inputUrl = document.getElementById('input-url');
  if (inputUrl) {
    inputUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        console.log('[RENDERER] input-url Enter');
        handleAddSingle();
      }
    });
    console.log('[RENDERER] input-url keydown listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #input-url no encontrado en el DOM');
  }

  // ── Input File: importar .txt ─────────────────────────────────────────────
  const inputFile = document.getElementById('input-file');
  if (inputFile) {
    inputFile.addEventListener('change', (e) => {
      console.log('[RENDERER] input-file change, files:', e.target.files?.length);
      const file = e.target.files?.[0];
      if (file) {
        handleFileImport(file).finally(() => {
          // Limpiar el input para permitir re-seleccionar el mismo archivo
          inputFile.value = '';
        });
      }
    });
    console.log('[RENDERER] input-file change listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #input-file no encontrado en el DOM');
  }

  // ── Botón ▶ Iniciar ───────────────────────────────────────────────────────
  const btnStart = document.getElementById('btn-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      console.log('[RENDERER] btn-start click');
      handleStartQueue();
    });
    console.log('[RENDERER] btn-start listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #btn-start no encontrado en el DOM');
  }

  // ── Botón ⏹ Detener ───────────────────────────────────────────────────────
  const btnStop = document.getElementById('btn-stop');
  if (btnStop) {
    btnStop.addEventListener('click', () => {
      console.log('[RENDERER] btn-stop click');
      handleStop();
    });
    console.log('[RENDERER] btn-stop listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #btn-stop no encontrado en el DOM');
  }

  // ── Botón 🗑 Limpiar Cola ─────────────────────────────────────────────────
  const btnClear = document.getElementById('btn-clear');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      console.log('[RENDERER] btn-clear click');
      handleClear();
    });
    console.log('[RENDERER] btn-clear listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #btn-clear no encontrado en el DOM');
  }

  // ── Botón 📂 Abrir Carpeta ────────────────────────────────────────────────
  const btnFolder = document.getElementById('btn-folder');
  if (btnFolder) {
    btnFolder.addEventListener('click', () => {
      console.log('[RENDERER] btn-folder click');
      handleOpenFolder();
    });
    console.log('[RENDERER] btn-folder listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #btn-folder no encontrado en el DOM');
  }

  // ── Botón 🗑 Limpiar Consola ──────────────────────────────────────────────
  const btnClearConsole = document.getElementById('btn-clear-console');
  if (btnClearConsole) {
    btnClearConsole.addEventListener('click', () => {
      console.log('[RENDERER] btn-clear-console click');
      handleClearConsole();
    });
    console.log('[RENDERER] btn-clear-console listener registrado OK');
  } else {
    console.error('[RENDERER] CRÍTICO: #btn-clear-console no encontrado en el DOM');
  }

  console.log('[RENDERER] initDOM() completado.');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ARRANQUE DEL RENDERER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Punto de entrada principal del renderer.
 * Se ejecuta tanto cuando el script carga (DOM ya parseado por estar al final del body)
 * como en DOMContentLoaded (por si acaso se importa de otra forma).
 */
async function bootstrap() {
  console.log('[RENDERER] ========== bootstrap() START ==========');
  console.log('[RENDERER] window.electronAPI:', typeof window.electronAPI);

  // 1. Registrar listeners del DOM
  initDOM();

  // 2. Suscribir a eventos IPC
  initIPCListeners();

  // 3. Consultar estado inicial del manager
  if (window.electronAPI) {
    try {
      appendLog('Consultando estado del sistema...', 'info');
      const status = await window.electronAPI.getStatus();
      console.log('[RENDERER] getStatus:', status);

      // ── Detección de entorno Docker ──────────────────────────────────────
      // Se establece ANTES de updateButtons() para que oculte btn-folder
      // desde el primer render si la app está corriendo en contenedor.
      if (status.isDocker) {
        isDockerEnv = true;
        console.log('[RENDERER] Modo Docker detectado. btn-folder será deshabilitado.');
        appendLog('📦 Modo Docker: canciones sincronizadas en el volumen montado (/app/downloads).', 'info');
      }

      const binOk  = !!status.binaryPath;
      const ffOk   = !!status.ffmpegPath;

      const indicator = document.getElementById('status-indicator');
      if (indicator) {
        indicator.textContent = binOk ? `yt-dlp OK` : `⚠️ yt-dlp no disponible`;
        indicator.className   = `text-xs font-mono no-drag ${binOk ? 'text-green-400' : 'text-red-400'}`;
      }

      appendLog(
        binOk
          ? 'yt-dlp: Motor de descargas listo.'
          : '⚠️ yt-dlp no disponible. Se intentará descargar automáticamente.',
        binOk ? 'success' : 'warn'
      );

      appendLog(
        ffOk
          ? 'ffmpeg: Conversor de audio listo.'
          : '⚠️ ffmpeg no encontrado. Se descargará audio sin conversión a MP3.',
        ffOk ? 'success' : 'warn'
      );

      if (status.outputDir) {
        appendLog(`📁 Carpeta de descargas: ${status.outputDir}`, 'info');
      }

      // Restaurar cola si la app se reinició
      if (status.queue?.length) {
        queueItems = status.queue;
        renderQueue();
        appendLog(`Cola restaurada: ${status.queue.length} elemento(s) pendientes.`, 'info');
      }

      isDownloading = status.active;
      updateButtons();

    } catch (err) {
      console.error('[RENDERER] getStatus ERROR:', err);
      appendLog(`Error al consultar estado: ${err.message}`, 'error');
    }
  } else {
    appendLog('⚠️ window.electronAPI no disponible. ¿Está cargado el preload?', 'error');

    const indicator = document.getElementById('status-indicator');
    if (indicator) {
      indicator.textContent = '⚠️ Preload no cargado';
      indicator.className   = 'text-xs font-mono no-drag text-red-400';
    }
  }

  console.log('[RENDERER] ========== bootstrap() END ==========');
}

// ── Punto de entrada ──────────────────────────────────────────────────────────
// El script está al final del <body>, por lo que el DOM ya está parseado.
// DOMContentLoaded sirve como doble garantía si el script se cargara de otra forma.

if (document.readyState === 'loading') {
  // El DOM todavía no está listo (no debería ocurrir dado que el script está al final del body)
  console.log('[RENDERER] DOM loading — esperando DOMContentLoaded...');
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  // El DOM ya está listo (caso normal: script al final del body)
  console.log('[RENDERER] DOM ya listo — ejecutando bootstrap() directamente');
  bootstrap();
}
