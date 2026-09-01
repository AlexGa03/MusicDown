import os
import sys
import uvicorn
import threading
import asyncio
import argparse
import shutil
import platform
import subprocess
from fastapi import FastAPI, WebSocket, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
from urllib.parse import urlparse, parse_qs

# ---------------------------------------------------------------------------
# NOTA: yt_dlp ha sido eliminado como dependencia Python.
# Las descargas ahora son ejecutadas por el proceso principal de Electron
# mediante el binario standalone yt-dlp gestionado por ytdlp-manager.js.
# Este backend actua unicamente como servidor de estado y WebSocket.
# ---------------------------------------------------------------------------

# --- MODELOS ---
class SongPayload(BaseModel):
    songs: List[str]

class TogglePayload(BaseModel):
    index: int
    download_all: bool

# --- CONFIGURACION ---
parser = argparse.ArgumentParser()
parser.add_argument("--frontend-path", type=str, help="Ruta del frontend")
args, unknown = parser.parse_known_args()

app = FastAPI()

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

if args.frontend_path:
    FRONTEND_FOLDER = args.frontend_path
else:
    FRONTEND_FOLDER = os.path.join(BASE_DIR, "../frontend/dist")

DOWNLOAD_FOLDER = os.path.join(os.path.expanduser("~"), "Downloads", "MusicDown")
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)

local_ffmpeg = os.path.join(BASE_DIR, "bin", "ffmpeg")
if os.path.exists(local_ffmpeg):
    FFMPEG_PATH = local_ffmpeg
else:
    FFMPEG_PATH = shutil.which("ffmpeg")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- ESTADO GLOBAL ---
download_queue: List[Dict[str, Any]] = []
is_downloading = False
global_loop = None

# --- GESTOR WEBSOCKET ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                pass

manager = ConnectionManager()

@app.on_event("startup")
async def startup_event():
    global global_loop
    global_loop = asyncio.get_running_loop()

def send_log_ui(msg: str, type="info"):
    print(f"[{type.upper()}] {msg}")
    if global_loop and manager.active_connections:
        asyncio.run_coroutine_threadsafe(
            manager.broadcast({"type": "log", "msg": msg, "level": type}),
            global_loop
        )

# --- FUNCIONES AUXILIARES ---
def open_file_explorer(path):
    try:
        if platform.system() == "Windows":
            os.startfile(path)
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception as e:
        send_log_ui(f"Error abriendo carpeta: {e}", "error")

def is_playlist_url(url: str) -> bool:
    return "list=" in url or "playlist" in url

# --- ENDPOINTS DE COLA ---

@app.get("/queue")
async def get_queue():
    """Devuelve el estado actual de la cola de descarga."""
    return {"queue": download_queue, "is_downloading": is_downloading}

@app.post("/add")
async def add_to_queue(payload: SongPayload):
    """Agrega URLs o terminos de busqueda a la cola."""
    count = 0
    if payload.songs:
        for url in payload.songs:
            item = {
                'url': url,
                'title': url,
                'is_playlist': is_playlist_url(url),
                'download_all': False
            }
            download_queue.append(item)
            count += 1

        send_log_ui(f"Anadidas {count} entradas.")
        await manager.broadcast({"type": "queue_update", "queue": download_queue})

    return {"status": "ok", "queue_length": len(download_queue)}

@app.post("/toggle_playlist")
async def toggle_playlist(payload: TogglePayload):
    """Activa o desactiva el modo 'descargar playlist completa' en un item."""
    if payload.index >= 0 and payload.index < len(download_queue):
        download_queue[payload.index]['download_all'] = payload.download_all
        await manager.broadcast({"type": "queue_update", "queue": download_queue})
        return {"status": "updated"}
    raise HTTPException(status_code=404, detail="Item no encontrado")

@app.post("/start")
async def start_download():
    """
    Notifica que el frontend quiere iniciar descargas.
    La ejecucion real de yt-dlp ocurre en el proceso Electron via IPC (ytdlp:download).
    Este endpoint solo actualiza el estado y lo emite por WebSocket.
    """
    global is_downloading
    if not is_downloading and download_queue:
        is_downloading = True
        send_log_ui("Cola lista para procesar. El proceso Electron iniciara las descargas.", "info")
        await manager.broadcast({"type": "download_ready", "queue": download_queue})
        return {"message": "Iniciando..."}
    return {"message": "No se puede iniciar"}

@app.post("/stop")
async def stop_download():
    """Marca la descarga como detenida. El proceso Electron cancelara los jobs activos."""
    global is_downloading
    if is_downloading:
        is_downloading = False
        send_log_ui("Detencion solicitada.", "warning")
        await manager.broadcast({"type": "stop_requested"})
        return {"message": "Deteniendo..."}
    return {"message": "Nada que detener"}

@app.post("/clear")
async def clear_queue():
    """Limpia la cola de descarga."""
    global download_queue
    if is_downloading:
        raise HTTPException(status_code=400, detail="Descarga en curso")
    download_queue = []
    send_log_ui("Cola limpiada", "warning")
    await manager.broadcast({"type": "queue_update", "queue": download_queue})
    return {"status": "cleared"}

@app.post("/open_folder")
async def open_folder_endpoint():
    """Abre el explorador de archivos en la carpeta de descargas."""
    open_file_explorer(DOWNLOAD_FOLDER)
    return {"message": "Abriendo carpeta"}

# --- Endpoint para que Electron notifique progreso al WebSocket ---

class ProgressPayload(BaseModel):
    url: str
    file: str = ""
    percent: float = 0.0
    speed: str = ""
    eta: str = ""

class DonePayload(BaseModel):
    url: str
    output_path: str = ""

class ErrorPayload(BaseModel):
    url: str
    message: str

@app.post("/notify/progress")
async def notify_progress(payload: ProgressPayload):
    """
    El proceso Electron envia el progreso de yt-dlp aqui para retransmitirlo
    a todos los clientes WebSocket conectados.
    """
    await manager.broadcast({
        "type": "progress",
        "file": payload.file,
        "progress": payload.percent,
        "speed": payload.speed,
        "eta": payload.eta,
    })
    return {"ok": True}

@app.post("/notify/done")
async def notify_done(payload: DonePayload):
    """Notifica que una descarga ha completado."""
    global is_downloading
    # Quitar de la cola el item completado
    download_queue[:] = [i for i in download_queue if i['url'] != payload.url]
    if not download_queue:
        is_downloading = False
        await manager.broadcast({"type": "queue_finished"})
    await manager.broadcast({
        "type": "completed",
        "file": os.path.basename(payload.output_path) if payload.output_path else payload.url,
        "queue": download_queue,
    })
    return {"ok": True}

@app.post("/notify/error")
async def notify_error(payload: ErrorPayload):
    """Notifica que una descarga ha fallado."""
    # Quitar de la cola el item fallido
    download_queue[:] = [i for i in download_queue if i['url'] != payload.url]
    if not download_queue:
        global is_downloading
        is_downloading = False
        await manager.broadcast({"type": "queue_finished"})
    send_log_ui(f"Error descargando {payload.url}: {payload.message}", "error")
    await manager.broadcast({
        "type": "error",
        "url": payload.url,
        "message": payload.message,
        "queue": download_queue,
    })
    return {"ok": True}

# --- WEBSOCKET ---

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except:
        manager.disconnect(websocket)

# --- STATIC FILES ---

if os.path.exists(FRONTEND_FOLDER):
    app.mount("/", StaticFiles(directory=FRONTEND_FOLDER, html=True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
