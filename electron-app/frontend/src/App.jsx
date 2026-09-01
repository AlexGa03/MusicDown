import React, { useEffect, useState, useRef, useCallback } from "react";
import ImportSongs from "./ImportSongs";

/**
 * App.jsx — Frontend React con IPC directo a yt-dlp via window.ytdlp
 *
 * FLUJO COMPLETO:
 *   1. Usuario añade URLs → POST /add → backend Python actualiza download_queue
 *   2. Usuario pulsa "Iniciar":
 *      a. POST /start (marca is_downloading en Python)
 *      b. GET /queue  (obtiene la lista actual)
 *      c. window.ytdlp.startQueue(items) → IPC → Node.js → spawn yt-dlp
 *   3. Node.js emite eventos IPC → actualizan UI React directamente
 *   4. Node.js también POST /notify/* → Python → WebSocket (opcional)
 */

const BACKEND = "http://127.0.0.1:8000";

// ─── Utilidades ───────────────────────────────────────────────────────────────

const LEVEL_COLORS = {
  error:    "text-red-400",
  warn:     "text-yellow-400",
  success:  "text-green-400",
  info:     "text-gray-300",
  progress: "text-blue-300",
};

const LEVEL_ICONS = {
  error: "✗", warn: "⚠", success: "✓", info: "·", progress: "↓",
};

// ─── Componente principal ─────────────────────────────────────────────────────

export default function App() {
  const [songInput,      setSongInput]      = useState("");
  const [queue,          setQueue]          = useState([]);  // [{ url, title }]
  const [logs,           setLogs]           = useState([]);
  const [isDownloading,  setIsDownloading]  = useState(false);
  const [progress,       setProgress]       = useState({});  // url -> percent
  const [ytdlpReady,     setYtdlpReady]     = useState(false);
  const [ytdlpStatus,    setYtdlpStatus]    = useState(null); // { binaryPath, ffmpegPath, outputDir }

  const logsEndRef = useRef(null);

  // ── Verificar disponibilidad de window.ytdlp (preload) ────────────────────
  useEffect(() => {
    const check = () => {
      if (window.ytdlp) {
        setYtdlpReady(true);
        // Consultar estado inicial del manager
        window.ytdlp.status().then(setYtdlpStatus).catch(() => {});
      }
    };
    check();
    // Reintento si el preload tarda un tick en inyectarse
    const t = setTimeout(check, 600);
    return () => clearTimeout(t);
  }, []);

  // ── Suscripciones a eventos IPC del main process ──────────────────────────
  useEffect(() => {
    if (!ytdlpReady) return;

    const subs = [
      window.ytdlp.onProgress(({ url, file, percent, speed, eta }) => {
        setProgress(prev => ({ ...prev, [url]: percent }));
        addLog(`${file} — ${percent.toFixed(1)}% @ ${speed} ETA ${eta}`, "progress");
      }),
      window.ytdlp.onLog(({ level, msg }) => addLog(msg, level === "error" ? "error" : "info")),
      window.ytdlp.onDone(({ url, outputPath }) => {
        setProgress(prev => ({ ...prev, [url]: 100 }));
        addLog(`Completado: ${outputPath || url}`, "success");
        fetchQueue();
      }),
      window.ytdlp.onError(({ url, message }) => {
        addLog(`Error [${url.slice(0, 50)}]: ${message}`, "error");
        fetchQueue();
      }),
      window.ytdlp.onQueueDone(() => {
        setIsDownloading(false);
        setProgress({});
        addLog("Cola finalizada.", "success");
        fetchQueue();
        // Actualizar estado del manager
        window.ytdlp.status().then(setYtdlpStatus).catch(() => {});
      }),
    ];

    return () => subs.forEach(unsub => unsub());
  }, [ytdlpReady]);

  // ── Auto-scroll del log ───────────────────────────────────────────────────
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const addLog = useCallback((msg, level = "info") => {
    const ts = new Date().toLocaleTimeString("es-ES", { hour12: false });
    setLogs(prev => [...prev.slice(-299), { ts, msg, level }]);
  }, []);

  const fetchQueue = useCallback(async () => {
    try {
      const res  = await fetch(`${BACKEND}/queue`);
      const data = await res.json();
      const items = (data.queue || []).map(item =>
        typeof item === "string" ? { url: item, title: item } : item
      );
      setQueue(items);
      // Solo sincronizar isDownloading desde el backend si NO estamos en medio de una cola local
      if (!isDownloading) setIsDownloading(data.is_downloading || false);
    } catch (err) {
      addLog(`fetchQueue error: ${err.message}`, "error");
    }
  }, [isDownloading, addLog]);

  // ── Polling de estado del backend ─────────────────────────────────────────
  useEffect(() => {
    fetchQueue();
    const id = setInterval(fetchQueue, 2500);
    return () => clearInterval(id);
  }, [fetchQueue]);

  // ── Acciones ──────────────────────────────────────────────────────────────
  const handleAddSong = async () => {
    const val = songInput.trim();
    if (!val) return;
    try {
      await fetch(`${BACKEND}/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songs: [val] }),
      });
      setSongInput("");
      fetchQueue();
    } catch (err) {
      addLog(`Error al añadir: ${err.message}`, "error");
    }
  };

  const handleStart = async () => {
    if (!ytdlpReady) {
      addLog("ERROR: window.ytdlp no disponible. Comprueba que el preload.js está cargado.", "error");
      return;
    }
    if (isDownloading) return;

    try {
      addLog("Iniciando...", "info");

      // 1. Avisar al backend Python
      await fetch(`${BACKEND}/start`, { method: "POST" });

      // 2. Obtener la cola del backend (fuente de verdad)
      const res    = await fetch(`${BACKEND}/queue`);
      const data   = await res.json();
      const rawQueue = data.queue || [];

      if (!rawQueue.length) {
        addLog("La cola está vacía.", "warn");
        return;
      }

      // 3. Normalizar: el backend devuelve objetos { url, title, ... }
      const items = rawQueue.map(item =>
        typeof item === "string"
          ? { url: item, title: item }
          : { url: item.url || item.title, title: item.title || item.url }
      ).filter(item => item.url);

      addLog(`Enviando ${items.length} item(s) al proceso Electron...`, "info");
      setIsDownloading(true);
      setProgress({});

      // 4. Invocar IPC — se resuelve inmediatamente; el progreso llega por eventos
      const result = await window.ytdlp.startQueue(items);
      addLog(
        result.started
          ? `Cola aceptada: ${result.count} item(s). Procesando...`
          : `startQueue rechazado: ${result.reason}`,
        result.started ? "info" : "error"
      );

      if (!result.started) setIsDownloading(false);

    } catch (err) {
      addLog(`Error en handleStart: ${err.message}`, "error");
      setIsDownloading(false);
    }
  };

  const handleStop = async () => {
    try {
      await fetch(`${BACKEND}/stop`, { method: "POST" });
      if (ytdlpReady) await window.ytdlp.cancel(); // cancela todos los jobs activos
      setIsDownloading(false);
      setProgress({});
      addLog("Descarga detenida.", "warn");
      fetchQueue();
    } catch (err) {
      addLog(`Error al detener: ${err.message}`, "error");
    }
  };

  const handleClear = async () => {
    try {
      await fetch(`${BACKEND}/clear`, { method: "POST" });
      setProgress({});
      setLogs([]);
      fetchQueue();
    } catch (err) {
      addLog(`Error al limpiar: ${err.message}`, "error");
    }
  };

  // ── Métricas de progreso ──────────────────────────────────────────────────
  const progressValues = Object.values(progress);
  const globalPercent  = progressValues.length
    ? progressValues.reduce((a, b) => a + b, 0) / progressValues.length
    : 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col items-center p-4 text-white bg-black bg-opacity-80">
      <div className="bg-gray-900 border-2 border-gray-600 p-4 rounded-2xl w-full max-w-2xl space-y-4">

        {/* Título */}
        <h1 className="text-2xl font-bold text-center">🎶 YouTube Music Downloader</h1>

        {/* Panel de estado del binario */}
        <div className={`text-xs p-2 rounded-lg border ${ytdlpReady ? "border-green-700 bg-green-950" : "border-red-700 bg-red-950"}`}>
          <div className="flex items-center gap-2">
            <span>{ytdlpReady ? "✅" : "❌"}</span>
            <span className="font-mono">
              {ytdlpReady ? `yt-dlp listo` : "yt-dlp no disponible (preload no cargado)"}
            </span>
          </div>
          {ytdlpStatus && (
            <div className="mt-1 space-y-0.5 text-gray-400">
              <div>📦 Binario: <span className="text-gray-200">{ytdlpStatus.binaryPath || "—"}</span></div>
              <div>🎬 ffmpeg: <span className={ytdlpStatus.ffmpegPath ? "text-green-300" : "text-red-300"}>{ytdlpStatus.ffmpegPath || "NO ENCONTRADO"}</span></div>
              <div>📁 Salida: <span className="text-gray-200">{ytdlpStatus.outputDir || "—"}</span></div>
            </div>
          )}
        </div>

        {/* Input + Añadir */}
        <div className="flex gap-2">
          <input
            type="text"
            value={songInput}
            onChange={e => setSongInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAddSong()}
            placeholder="URL de YouTube o nombre de canción"
            className="flex-1 px-3 py-2 rounded-lg bg-gray-800 border border-gray-600 text-sm"
            disabled={isDownloading}
          />
          <button
            onClick={handleAddSong}
            disabled={isDownloading}
            className="px-3 py-2 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-40 text-sm"
          >
            + Añadir
          </button>
        </div>

        <ImportSongs onImport={fetchQueue} disabled={isDownloading} />

        {/* Controles */}
        <div className="flex gap-2">
          <button
            onClick={handleStart}
            disabled={isDownloading || queue.length === 0 || !ytdlpReady}
            className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-sm font-medium"
          >
            ▶ Iniciar ({queue.length})
          </button>
          <button
            onClick={handleStop}
            disabled={!isDownloading}
            className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-40 text-sm"
          >
            ⏹ Detener
          </button>
          <button
            onClick={handleClear}
            disabled={isDownloading}
            className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-sm"
          >
            🗑 Limpiar
          </button>
          {ytdlpReady && (
            <button
              onClick={() => window.ytdlp.status().then(s => { setYtdlpStatus(s); addLog(JSON.stringify(s), "info"); })}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-400"
            >
              🔍 Status
            </button>
          )}
        </div>

        {/* Barra de progreso global */}
        {isDownloading && (
          <div>
            <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${globalPercent}%` }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-1">{globalPercent.toFixed(1)}% completado</p>
          </div>
        )}

        {/* Cola */}
        <div className="bg-gray-800 p-3 rounded-xl">
          <h2 className="text-sm font-semibold mb-2 text-gray-300">📋 Cola ({queue.length})</h2>
          {queue.length === 0 ? (
            <p className="text-gray-500 text-xs">Sin canciones.</p>
          ) : (
            <ul className="text-xs space-y-1 max-h-32 overflow-y-auto">
              {queue.map((item, i) => {
                const url = item.url || item;
                const pct = progress[url];
                return (
                  <li key={i} className="flex items-center gap-2 text-gray-300">
                    <span className="w-4 text-gray-500 shrink-0">{i + 1}.</span>
                    <span className="flex-1 truncate">{item.title || url}</span>
                    {pct !== undefined && (
                      <span className="text-blue-300 shrink-0 font-mono">{pct.toFixed(0)}%</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Logs */}
        <div className="bg-gray-950 p-3 rounded-xl">
          <h2 className="text-sm font-semibold mb-2 text-gray-300">📜 Logs</h2>
          <div className="h-48 overflow-y-auto text-xs font-mono space-y-0.5 pr-1">
            {logs.length === 0
              ? <span className="text-gray-600">Sin actividad...</span>
              : logs.map((entry, i) => (
                <div key={i} className={`flex gap-2 ${LEVEL_COLORS[entry.level] || "text-gray-400"}`}>
                  <span className="text-gray-600 shrink-0">{entry.ts}</span>
                  <span className="shrink-0">{LEVEL_ICONS[entry.level] || "·"}</span>
                  <span className="break-all">{entry.msg}</span>
                </div>
              ))
            }
            <div ref={logsEndRef} />
          </div>
        </div>

      </div>
    </div>
  );
}
