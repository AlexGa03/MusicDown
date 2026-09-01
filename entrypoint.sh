#!/bin/bash
set -e

# Configuración de variables de entorno con valores por defecto
export DISPLAY=${DISPLAY:-":0"}
export RESOLUTION=${RESOLUTION:-"1280x800x24"}
export ELECTRON_DISABLE_SANDBOX=1
export ELECTRON_ENABLE_LOGGING=1

echo "============================================================"
echo "  Iniciando MusicDown Container (Web GUI via noVNC)"
echo "  Display:    ${DISPLAY}"
echo "  Resolucion: ${RESOLUTION}"
echo "  Puerto Web: 8080 (http://localhost:8080)"
echo "============================================================"

# Limpiar posibles bloqueos residuales del servidor X
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0

# 1. Iniciar Servidor X virtual (Xvfb)
echo "[1/4] Arrancando Xvfb en ${DISPLAY} (${RESOLUTION})..."
Xvfb ${DISPLAY} -screen 0 ${RESOLUTION} -ac +extension GLX +render -noreset &
XVFB_PID=$!

# Esperar activamente a que el display X esté listo
for i in $(seq 1 30); do
    if xset -q -display ${DISPLAY} >/dev/null 2>&1; then
        echo "      Display X virtual listo y respondiendo."
        break
    fi
    sleep 0.2
done

# 2. Iniciar Gestor de Ventanas liviano (Fluxbox)
echo "[2/4] Arrancando gestor de ventanas Fluxbox..."
fluxbox &
FLUXBOX_PID=$!

# 3. Iniciar Servidor VNC (x11vnc)
echo "[3/4] Arrancando servidor VNC (x11vnc:5900)..."
x11vnc -display ${DISPLAY} -nopw -listen localhost -xkb -ncache 10 -ncache_cr -forever -shared -rfbport 5900 -quiet &
X11VNC_PID=$!

# 4. Iniciar WebSockets Proxy / noVNC
echo "[4/4] Arrancando noVNC Web Server en http://0.0.0.0:8080..."
websockify --web /usr/share/novnc 8080 localhost:5900 &
WEBSOCKIFY_PID=$!

# Manejador de señales de apagado elegante (Graceful shutdown)
cleanup() {
    echo ""
    echo "Recibida senal de terminacion. Deteniendo MusicDown y servicios auxiliares..."
    kill -TERM "$APP_PID" 2>/dev/null || true
    kill -TERM "$WEBSOCKIFY_PID" 2>/dev/null || true
    kill -TERM "$X11VNC_PID" 2>/dev/null || true
    kill -TERM "$FLUXBOX_PID" 2>/dev/null || true
    kill -TERM "$XVFB_PID" 2>/dev/null || true
    wait
    echo "Contenedor finalizado correctamente."
    exit 0
}
trap cleanup SIGTERM SIGINT

# 5. Ejecutar la aplicación Electron MusicDown
echo "[5/5] Lanzando aplicacion Electron MusicDown..."
cd /app/electron-app
npm start -- --no-sandbox &
APP_PID=$!

wait "$APP_PID"
