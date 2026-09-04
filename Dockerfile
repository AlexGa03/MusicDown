# ==============================================================================
# Multi-Stage Dockerfile for MusicDown (Electron + Web GUI via noVNC)
# Base Image: Debian Bookworm (node:20-bookworm-slim)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Builder
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app/electron-app

# Copiar manifiestos de dependencias
COPY electron-app/package*.json ./

# Copiar manifiestos de frontend subordinado si aplica
COPY electron-app/frontend/package*.json ./frontend/

# Instalar dependencias limpias para compilación
RUN npm ci

# Compilar frontend si aplica
RUN if [ -f "./frontend/package.json" ]; then \
        cd frontend && npm ci && npm run build && cd ..; \
    fi

# Copiar el código fuente completo de la aplicación
COPY electron-app/ .

# Limpieza de caché de npm
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

# Crear directorios para descargas y datos de usuario con permisos adecuados
RUN mkdir -p /app/downloads /app/userData /root/.config

# Copiar script de inicialización y punto de entrada
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Volumen persistente para almacenar descargas de música
VOLUME ["/app/downloads"]

# Exponer el puerto HTTP de noVNC (acceso por navegador)
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
