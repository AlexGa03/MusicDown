# ==============================================================================
# Multi-Stage Dockerfile for MusicDown (Electron + Web GUI via noVNC)
# Base Image: Debian Bookworm (node:20-bookworm-slim)
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build de dependencias
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copiar configuración de dependencias de electron-app
COPY electron-app/package*.json ./electron-app/
WORKDIR /app/electron-app
RUN npm install

# Copiar el resto del código de la app
COPY electron-app/ ./
# Ejecutar build si existe el script en package.json, ignorar si no aplica
RUN npm run build --if-present

# Stage 2: Runtime con X11 Virtual y NoVNC (Web GUI)
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:0

# Instalar dependencias del sistema requeridas para Electron, headless display y ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    ffmpeg \
    ca-certificates \
    curl \
    libnss3 \
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
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/electron-app

# Copiar aplicación procesada
COPY --from=builder /app/electron-app /app/electron-app

# Script de arranque del display virtual y servidor NoVNC en puerto 8080
RUN echo '#!/bin/bash\n\
Xvfb :0 -screen 0 1280x800x24 &\n\
fluxbox &\n\
x11vnc -display :0 -nopw -forever -shared &\n\
websockify --web /usr/share/novnc 8080 localhost:5900 &\n\
cd /app/electron-app && npm start -- --no-sandbox\n\
' > /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
