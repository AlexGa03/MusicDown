'use strict';

/**
 * @file src/preload.js
 * @description Puente seguro entre main process y renderer via contextBridge.
 *
 * Expone window.electronAPI con exactamente los métodos que src/renderer/index.js usa.
 * Cualquier discrepancia de nombre entre preload e index.js causa TypeError silencioso.
 *
 * MÉTODOS INVOKE (renderer → main, con respuesta):
 *   addItems(items)              app:addItems      → { added, total }
 *   startQueue()                 app:startQueue    → { started, count? }
 *   stop()                       app:stop          → { stopped }
 *   clear()                      app:clear         → { cleared }
 *   openFolder()                 app:openFolder    → { opened, dir? }
 *   getStatus()                  app:getStatus     → { binaryPath, ffmpegPath, outputDir, queue, active }
 *   answerPlaylist(url, dlAll)   app:playlistAnswer → { ok }
 *
 * MÉTODOS ON (main → renderer, suscripción unidireccional):
 *   onLog(cb)             app:log           { level, msg, ts }
 *   onProgress(cb)        app:progress      { index, total, title, percent, speed, eta }
 *   onQueueUpdate(cb)     app:queueUpdate   { queue, active }
 *   onDone(cb)            app:done          { index, total, title, outputPath }
 *   onError(cb)           app:error         { index, total, title, message }
 *   onQueueDone(cb)       app:queueDone     { completed, errors }
 *   onPlaylistPrompt(cb)  app:playlistPrompt { url, title }
 *
 * Todos los métodos on*() devuelven una función de limpieza () => void.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Registra un listener IPC seguro y devuelve su función de cleanup.
 * @param {string} channel
 * @param {(data: any) => void} cb
 * @returns {() => void}
 */
function on(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_event, data) => {
    try {
      cb(data);
    } catch (err) {
      console.error(`[preload] Error en callback de ${channel}:`, err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {

  // ── INVOKE: renderer → main ───────────────────────────────────────────────

  /**
   * Añade una lista de entradas (URLs, búsquedas) a la cola del main process.
   * @param {(string | { url: string, title?: string })[]} items
   * @returns {Promise<{ added: number, total: number }>}
   */
  addItems: (items) => {
    const validItems = Array.isArray(items) ? items : [];
    return ipcRenderer.invoke('app:addItems', validItems);
  },

  /**
   * Inicia el procesamiento secuencial de la cola.
   * @returns {Promise<{ started: boolean, count?: number, reason?: string }>}
   */
  startQueue: () => ipcRenderer.invoke('app:startQueue'),

  /**
   * Detiene la descarga activa y pausa el avance de la cola.
   * @returns {Promise<{ stopped: boolean }>}
   */
  stop: () => ipcRenderer.invoke('app:stop'),

  /**
   * Vacía la cola (solo si no hay descarga activa).
   * @returns {Promise<{ cleared: boolean }>}
   */
  clear: () => ipcRenderer.invoke('app:clear'),

  /**
   * Abre el directorio de descargas con el explorador nativo.
   * @returns {Promise<{ opened: boolean, dir?: string, error?: string }>}
   */
  openFolder: () => ipcRenderer.invoke('app:openFolder'),

  /**
   * Devuelve el estado actual del manager.
   * @returns {Promise<{ binaryPath: string|null, ffmpegPath: string|null,
   *                     outputDir: string|null, queue: any[], active: boolean }>}
   */
  getStatus: () => ipcRenderer.invoke('app:getStatus'),

  /**
   * Responde al prompt de confirmación de playlist.
   * @param {string}  url
   * @param {boolean} downloadAll
   * @returns {Promise<{ ok: boolean }>}
   */
  answerPlaylist: (url, downloadAll) => {
    const safeUrl = typeof url === 'string' ? url : '';
    const safeDlAll = Boolean(downloadAll);
    return ipcRenderer.invoke('app:playlistAnswer', { url: safeUrl, downloadAll: safeDlAll });
  },

  // ── ON: main → renderer (eventos push) ───────────────────────────────────

  /** @param {(data: { level: string, msg: string, ts: string }) => void} cb */
  onLog: (cb) => on('app:log', cb),

  /** @param {(data: { index: number, total: number, title: string,
   *                   percent: number, speed: string, eta: string }) => void} cb */
  onProgress: (cb) => on('app:progress', cb),

  /** @param {(data: { queue: any[], active: boolean }) => void} cb */
  onQueueUpdate: (cb) => on('app:queueUpdate', cb),

  /** @param {(data: { index: number, total: number, title: string,
   *                   outputPath: string|null }) => void} cb */
  onDone: (cb) => on('app:done', cb),

  /** @param {(data: { index: number, total: number, title: string,
   *                   message: string }) => void} cb */
  onError: (cb) => on('app:error', cb),

  /** @param {(data: { completed: number, errors: number }) => void} cb */
  onQueueDone: (cb) => on('app:queueDone', cb),

  /** @param {(data: { url: string, title: string }) => void} cb */
  onPlaylistPrompt: (cb) => on('app:playlistPrompt', cb),
});

console.log('[preload] contextBridge registrado. window.electronAPI disponible en el renderer.');
