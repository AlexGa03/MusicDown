# ==============================================================================
# Multi-Stage Dockerfile for MusicDown (Electron + Web GUI via noVNC)
# Base Image: Debian Bookworm (node:20-bookworm-slim)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Builder
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app/electron-app

# Copiar manifiestos primero para optimizar caché
COPY electron-app/package*.json ./

# Instalar dependencias
RUN npm install --prefer-offline --no-audit --no-fund

# Copiar el código fuente
COPY electron-app/ .

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

# 1. Instalar dependencias de sistema completas
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    ffmpeg \
    python3 \
    python3-minimal \
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

# 2. Descarga e instalación atómica del binario oficial de yt-dlp
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && cp /usr/local/bin/yt-dlp /usr/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && ffmpeg -version | head -n 1

WORKDIR /app

# Copiar aplicación construida
COPY --from=builder /app/electron-app ./electron-app

# Crear directorios para descargas y datos de usuario con permisos totales
RUN mkdir -p /app/downloads /app/userData /root/.config \
    && chmod 777 /app/downloads

# Copiar entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/app/downloads"]

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
