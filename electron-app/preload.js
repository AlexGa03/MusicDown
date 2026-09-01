'use strict';

/**
 * @file preload.js
 * @description Expone la API de yt-dlp al renderer de forma segura via contextBridge.
 *
 * API disponible en window.ytdlp:
 *
 *   // Procesar la cola completa (uso principal desde el frontend)
 *   const result = await window.ytdlp.startQueue(items, options);
 *   // items: [{ url: string, title?: string }]
 *   // options: { outputDir?, audioCodec?, audioQuality?, ffmpegLocation? }
 *
 *   // Descargar una sola URL
 *   const { pid } = await window.ytdlp.download(url, options);
 *
 *   // Cancelar: sin pid cancela toda la cola; con pid cancela ese job
 *   await window.ytdlp.cancel();         // cancela todo
 *   await window.ytdlp.cancel(pid);      // cancela un job especifico
 *
 *   // Suscripciones (devuelven funcion de cleanup)
 *   const unsub = window.ytdlp.onProgress(({ url, file, percent, speed, eta }) => {});
 *   const unsub = window.ytdlp.onLog(({ level, msg }) => {});
 *   const unsub = window.ytdlp.onDone(({ url, outputPath }) => {});
 *   const unsub = window.ytdlp.onError(({ url, message }) => {});
 *   const unsub = window.ytdlp.onQueueDone(() => {});
 *
 *   // Consultar estado
 *   const { active, jobs, binaryPath, ffmpegPath } = await window.ytdlp.status();
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Suscribe a un canal IPC del main process de forma segura.
 * @param {string} channel
 * @param {(data: any) => void} callback
 * @returns {() => void} Funcion de limpieza.
 */
function _on(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, data) => {
    try {
      callback(data);
    } catch (err) {
      console.error(`[preload] Error en callback de ${channel}:`, err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ytdlp', {
  /**
   * Procesa la cola completa secuencialmente.
   * @param {{ url: string, title?: string }[]} items
   * @param {object} [options]
   * @returns {Promise<{ started: boolean, count?: number }>}
   */
  startQueue: (items, options = {}) => {
    const safeItems = Array.isArray(items) ? items : [];
    const safeOpts = (options && typeof options === 'object') ? options : {};
    return ipcRenderer.invoke('ytdlp:startQueue', { items: safeItems, options: safeOpts });
  },

  /**
   * Descarga una sola URL (uso directo, sin cola).
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<{ pid: number }>}
   */
  download: (url, options = {}) => {
    const safeUrl = typeof url === 'string' ? url : '';
    const safeOpts = (options && typeof options === 'object') ? options : {};
    return ipcRenderer.invoke('ytdlp:download', { url: safeUrl, options: safeOpts });
  },

  /**
   * Cancela descargas.
   * @param {number} [pid]
   * @returns {Promise<{ cancelled: boolean }>}
   */
  cancel: (pid) => {
    const safePid = typeof pid === 'number' ? pid : undefined;
    return ipcRenderer.invoke('ytdlp:cancel', safePid !== undefined ? { pid: safePid } : {});
  },

  /** Estado del manager. */
  status: () => ipcRenderer.invoke('ytdlp:status'),

  /** Evento: progreso de descarga. */
  onProgress:  (cb) => _on('ytdlp:progress',  cb),
  /** Evento: mensaje de log de yt-dlp. */
  onLog:       (cb) => _on('ytdlp:log',        cb),
  /** Evento: descarga completada. */
  onDone:      (cb) => _on('ytdlp:done',       cb),
  /** Evento: error en descarga. */
  onError:     (cb) => _on('ytdlp:error',      cb),
  /** Evento: toda la cola ha terminado. */
  onQueueDone: (cb) => _on('ytdlp:queueDone',  cb),
});
