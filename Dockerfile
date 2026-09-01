# ==============================================================================
# Multi-Stage Dockerfile for MusicDown (Electron + Web GUI via noVNC)
# Base Image: Debian Bookworm (node:20-bookworm-slim)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build de dependencias
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY electron-app/package*.json ./electron-app/
WORKDIR /app/electron-app
RUN npm install

COPY electron-app/ ./
RUN npm run build --if-present

# Stage 2: Runtime con X11 Virtual y NoVNC (Web GUI)
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:0

# Instalar conjunto completo de librerías nativas requeridas por Chromium/Electron en Debian
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    ffmpeg \
    ca-certificates \
    curl \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/electron-app

COPY --from=builder /app/electron-app /app/electron-app

RUN echo '#!/bin/bash\n\
Xvfb :0 -screen 0 1280x800x24 &\n\
fluxbox &\n\
x11vnc -display :0 -nopw -forever -shared &\n\
websockify --web /usr/share/novnc 8080 localhost:5900 &\n\
cd /app/electron-app && npm start -- --no-sandbox\n\
' > /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
