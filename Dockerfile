# ==============================================================================
# Multi-Stage Dockerfile for MusicDown (Electron + Web GUI via noVNC)
# Base Image: Debian Bookworm (node:20-bookworm-slim)
#
# Stage 1 (builder): instala dependencias Node de electron-app/ con npm install.
# Stage 2 (runtime): entorno headless X11 + Fluxbox + noVNC + yt-dlp + ffmpeg.
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Builder
# Nota: se usa npm install (no npm ci) para tolerar lockfiles desincronizados
# entre entornos de desarrollo y CI sin bloquear el build de Docker.
# No existe ningún subdirectorio frontend/ independiente en este proyecto.
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app/electron-app

# Copiar solo los manifiestos primero para aprovechar la caché de capas Docker:
# si package.json no cambia, npm install no se vuelve a ejecutar.
COPY electron-app/package*.json ./

# Instalar todas las dependencias (producción + devDependencies para electron-builder)
RUN npm install --prefer-offline --no-audit --no-fund

# Copiar el código fuente completo de la aplicación
COPY electron-app/ .

# Limpieza de caché para reducir tamaño de la imagen intermedia
RUN npm cache clean --force

# ------------------------------------------------------------------------------
# Stage 2: Runtime Web GUI (Headless X11 + Fluxbox + noVNC + Electron)
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

LABEL maintainer="MusicDown DevOps Team"
LABEL description="Containerized MusicDown Electron Desktop App accessible via Web Browser (noVNC)"

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    RESOLUTION=1280x800x24 \
    ELECTRON_DISABLE_SANDBOX=1 \
    ELECTRON_ENABLE_LOGGING=1 \
    IS_DOCKER=1 \
    NODE_ENV=production

# 1. Instalar dependencias de sistema:
# - Servidor X virtual y gestor de ventanas: xvfb, fluxbox, x11vnc, xauth, dbus-x11
# - Servidor Web / Proxy VNC: novnc, websockify
# - Procesamiento multimedia y utilidades: ffmpeg, ca-certificates, curl, wget, procps
# - Python3 y pip para gestión oficial de yt-dlp
# - Librerías compartidas de Chromium/Electron: GTK-3, NSS, ASOUND, ATK, GBM, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    curl \
    wget \
    procps \
    xauth \
    x11-xserver-utils \
    dbus-x11 \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libsecret-1-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxtst6 \
    libpango-1.0-0 \
    libcairo2 \
    libxkbcommon0 \
    fonts-liberation \
    fonts-dejavu-core \
    && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# 2. Instalar yt-dlp globalmente en el sistema con pip3 (ubicado en /usr/local/bin/yt-dlp)
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && ffmpeg -version | head -n 1

WORKDIR /app

# Copiar aplicación construida y sus node_modules desde el stage de builder
COPY --from=builder /app/electron-app ./electron-app

# Crear directorios para descargas y datos de usuario.
# /app/downloads recibe permisos 777 para garantizar lectura/escritura universal:
#   - El proceso Electron corre como root en el contenedor
#   - El volumen montado desde el host puede tener un UID diferente
#   - chmod 777 asegura que cualquier proceso dentro del contenedor pueda escribir
RUN mkdir -p /app/downloads /app/userData /root/.config \
    && chmod 777 /app/downloads

# Copiar script de inicialización y punto de entrada
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Volumen persistente para almacenar descargas de música
VOLUME ["/app/downloads"]

# Exponer el puerto HTTP de noVNC (acceso por navegador)
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
