'use strict';

/**
 * @file src/preload.js
 * @description Puente seguro entre main process y renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

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
  addItems: (items) => {
    const validItems = Array.isArray(items) ? items : [];
    return ipcRenderer.invoke('app:addItems', validItems);
  },

  startQueue: () => ipcRenderer.invoke('app:startQueue'),
  stop: () => ipcRenderer.invoke('app:stop'),
  clear: () => ipcRenderer.invoke('app:clear'),
  openFolder: () => ipcRenderer.invoke('app:openFolder'),
  getStatus: () => ipcRenderer.invoke('app:getStatus'),

  answerPlaylist: (url, downloadAll) => {
    const safeUrl = typeof url === 'string' ? url : '';
    const safeDlAll = Boolean(downloadAll);
    return ipcRenderer.invoke('app:playlistAnswer', { url: safeUrl, downloadAll: safeDlAll });
  },

  // ── ON: main → renderer (eventos push) ───────────────────────────────────
  onLog: (cb) => on('app:log', cb),
  onProgress: (cb) => on('app:progress', cb),
  onQueueUpdate: (cb) => on('app:queueUpdate', cb),
  onDone: (cb) => on('app:done', cb),
  onError: (cb) => on('app:error', cb),
  onQueueDone: (cb) => on('app:queueDone', cb),
  onPlaylistPrompt: (cb) => on('app:playlistPrompt', cb),
  onYtDlpStatus: (cb) => on('app:ytdlp-status', cb),
});

console.log('[preload] contextBridge registrado correctamente.');
