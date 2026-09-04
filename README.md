# MusicDown 🎵

<p align="center">
  <img src="electron-app/assets/logo.png" alt="MusicDown Logo" width="128" height="128" />
</p>

<p align="center">
  <strong>Descargador y extractor de música multiplataforma de alta fidelidad basado en Electron, yt-dlp y FFmpeg.</strong><br>
  <em>High-fidelity cross-platform music downloader and extractor powered by Electron, yt-dlp, and FFmpeg.</em>
</p>

<p align="center">
  <a href="https://github.com/Alexga03/MusicDown/actions/workflows/build-binaries.yml">
    <img src="https://github.com/Alexga03/MusicDown/actions/workflows/build-binaries.yml/badge.svg" alt="Build Desktop Binaries" />
  </a>
  <a href="https://github.com/Alexga03/MusicDown/actions/workflows/docker-publish.yml">
    <img src="https://github.com/Alexga03/MusicDown/actions/workflows/docker-publish.yml/badge.svg" alt="Docker Publish" />
  </a>
  <a href="https://hub.docker.com/">
    <img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker Ready" />
  </a>
  <a href="https://github.com/Alexga03/MusicDown/releases">
    <img src="https://img.shields.io/github/v/release/Alexga03/MusicDown?logo=github&color=orange" alt="Latest Release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License MIT" />
  </a>
  <img src="https://img.shields.io/badge/Electron-28.x-47848F?logo=electron&logoColor=white" alt="Electron 28" />
  <img src="https://img.shields.io/badge/node->=20.0.0-339933?logo=node.js&logoColor=white" alt="Node.js 20" />
</p>

---

<p align="center">
  <a href="#-español">🇪🇸 <strong>Español</strong></a> &nbsp;|&nbsp; <a href="#-english">🇬🇧 <strong>English</strong></a>
</p>

---

## 🇪🇸 Español

### Descripción General

**MusicDown** es una aplicación de escritorio y contenedor Web GUI ligera, potente y moderna concebida para buscar, descargar y convertir música a MP3 de máxima fidelidad (320 kbps VBR/CBR) directamente desde YouTube y cientos de plataformas soportadas por `yt-dlp`.

Dispone de instaladores nativos para **Windows** y **Linux** (AppImage con soporte Wayland/X11), además de una **imagen Docker con GUI Web accesible por navegador** mediante NoVNC, ideal para servidores domésticos (NAS, Raspberry Pi, Unraid o VPS).

---

### 🚀 Descargas Directas (Última Versión)

| Plataforma | Formato | Enlace de Descarga Directa |
|---|---|---|
| **Windows** | Instalador / Portable (`.exe`) | [📥 Descargar para Windows](https://github.com/Alexga03/MusicDown/releases/latest/download/MusicDown-Windows-x64.exe) |
| **Linux** | Paquete universal (`.AppImage`) | [📥 Descargar para Linux](https://github.com/Alexga03/MusicDown/releases/latest/download/MusicDown-Linux-AppImage.AppImage) |
| **Web / Servidor** | Contenedor Docker (NoVNC) | `docker pull alexga03/musicdown:latest` |

> Todas las versiones y notas de cambios están disponibles en la sección de [Releases de GitHub](https://github.com/Alexga03/MusicDown/releases).

---

### ✨ Características Principales

- **Motor Autónomo yt-dlp:** Gestión del ciclo de vida del motor integrada; detecta binarios globales del sistema (`/usr/local/bin/yt-dlp`) o los descarga y valida atómicamente de forma transparente, con verificación de actualizaciones en caliente en segundo plano (`yt-dlp -U`).
- **Conversión de Audio de Alta Fidelidad:** Extracción automática a formato MP3 estéreo con la máxima calidad sonora disponible vía `FFmpeg`.
- **Búsqueda por Texto Libre:** No requiere copiar URLs; puedes ingresar términos directos como `"Daft Punk Get Lucky"` y la app resolverá automáticamente el mejor resultado.
- **Gestión Inteligente de Playlists:** Modal interactivo al ingresar enlaces de listas de reproducción para elegir entre descargar un único tema o la lista completa en lotes.
- **Importación por Archivos de Texto (`.txt`):** Carga masiva de temas o URLs línea por línea arrastrando o seleccionando un fichero `.txt`.
- **Consola y Barra de Progreso en Tiempo Real:** Métricas en vivo de velocidad, porcentaje, tiempo restante (ETA) y registro de eventos.
- **Compatibilidad Total Wayland & Docker:** Diseñado sin bloqueos de cursor en gestores de ventanas modernos (Hyprland, Sway, GNOME, KDE) y adaptado para entornos de contenedorización.

---

### 💻 Guía de Instalación y Uso

#### 1. Linux (AppImage)
1. Descarga el archivo `.AppImage` desde el enlace superior.
2. Otorga permisos de ejecución:
   ```bash
   chmod +x MusicDown-Linux-AppImage.AppImage
   ```
3. Ejecuta la aplicación:
   ```bash
   ./MusicDown-Linux-AppImage.AppImage
   ```

#### 2. Windows (.exe)
1. Descarga `MusicDown-Windows-x64.exe`.
2. Haz doble clic para iniciar el instalador guiado o la versión portable.
3. El motor `yt-dlp` y `ffmpeg` se vincularán de manera automática en el primer inicio.

#### 3. Despliegue en Docker (Acceso Web NoVNC)
MusicDown puede ejecutarse de manera headless en cualquier servidor, exponiendo su interfaz gráfica directamente en tu navegador web gracias a Xvfb, Fluxbox y noVNC:

```bash
docker run -d \
  --name musicdown \
  -p 8080:8080 \
  -v ~/Musica:/app/downloads \
  --restart unless-stopped \
  alexga03/musicdown:latest
```

- **Acceso Web:** Abre tu navegador y navega a `http://localhost:8080/vnc.html` (o `http://<IP-SERVIDOR>:8080/vnc.html`).
- **Persistencia:** Las canciones descargadas se guardan de forma instantánea en la carpeta `~/Musica` de tu máquina anfitriona gracias al volumen mapeado a `/app/downloads`.

---

### 🛠️ Stack Tecnológico

| Capa | Tecnologías |
|---|---|
| **Interfaz & Renderer** | HTML5, JavaScript ES6+, Tailwind CSS |
| **Runtime Desktop** | Electron 28, Node.js 20 |
| **Descarga & Audio** | `yt-dlp`, `FFmpeg` |
| **Contenedorización** | Docker, Debian Bookworm Slim, Xvfb, Fluxbox, x11vnc, noVNC, websockify |
| **Integración Continua (CI/CD)** | GitHub Actions (Matrix Builds: `windows-latest` & `ubuntu-latest`) |

---

### 🧑‍💻 Desarrollo Local

Si deseas compilar o contribuir al proyecto desde el código fuente:

```bash
# 1. Clonar el repositorio
git clone https://github.com/Alexga03/MusicDown.git
cd MusicDown/electron-app

# 2. Instalar dependencias
npm install

# 3. Ejecutar en modo desarrollo
npm start

# 4. Compilar binarios de distribución
npm run build:linux  # Genera .AppImage en electron-app/release/
npm run build:win    # Genera instalador .exe en electron-app/release/
```

---

## 🇬🇧 English

### Overview

**MusicDown** is a modern, lightweight, and powerful desktop application and containerized Web GUI designed to search, download, and convert music to pristine MP3 audio (320 kbps VBR/CBR) directly from YouTube and hundreds of streaming platforms supported by `yt-dlp`.

It provides native desktop installers for **Windows** and **Linux** (AppImage with Wayland/X11 compatibility), as well as a **Docker container with Web GUI access** via NoVNC, ideal for headless servers, home labs, NAS devices (Synology, Unraid, TrueNAS), or Raspberry Pi.

---

### 🚀 Direct Downloads (Latest Release)

| Platform | Format | Direct Download Link |
|---|---|---|
| **Windows** | Installer / Portable (`.exe`) | [📥 Download for Windows](https://github.com/Alexga03/MusicDown/releases/latest/download/MusicDown-Windows-x64.exe) |
| **Linux** | Universal package (`.AppImage`) | [📥 Download for Linux](https://github.com/Alexga03/MusicDown/releases/latest/download/MusicDown-Linux-AppImage.AppImage) |
| **Web / Server** | Docker Container (NoVNC) | `docker pull alexga03/musicdown:latest` |

> For release notes and previous builds, visit the [GitHub Releases Page](https://github.com/Alexga03/MusicDown/releases).

---

### ✨ Key Features

- **Autonomous yt-dlp Engine:** Complete lifecycle management; dynamically links against system binaries (`/usr/local/bin/yt-dlp`) or downloads and validates the official release atomically, with background hot-updating (`yt-dlp -U`).
- **High-Fidelity Audio Conversion:** Automatic extraction and conversion to high-bitrate stereo MP3 using integrated `FFmpeg`.
- **Natural Search (No Links Required):** Search directly by song title or artist (e.g., `"Queen Bohemian Rhapsody"`); the app uses `ytsearch1:` to find the best match.
- **Smart Playlist Detection:** Interactive modal appears when entering playlist URLs, allowing users to choose between downloading a single track or the entire batch.
- **Batch Text File Import (`.txt`):** Queue dozens of tracks at once by simply dropping or selecting a plain `.txt` list.
- **Real-Time Progress & Logs:** Live streaming metrics showing speed, progress percentage, ETA, and an interactive log console.
- **Wayland & Docker Hardened:** Native grab/focus release fixes for Wayland compositors (Hyprland, Sway, GNOME, KDE) and full volume mapping support for Docker.

---

### 💻 Installation & Usage Guide

#### 1. Linux (AppImage)
1. Download the `.AppImage` file from the link above.
2. Make it executable:
   ```bash
   chmod +x MusicDown-Linux-AppImage.AppImage
   ```
3. Run the application:
   ```bash
   ./MusicDown-Linux-AppImage.AppImage
   ```

#### 2. Windows (.exe)
1. Download `MusicDown-Windows-x64.exe`.
2. Double-click the installer to install or run portably.
3. Dependencies (`yt-dlp` and `ffmpeg`) are configured automatically on first launch.

#### 3. Docker Deployment (Web GUI via NoVNC)
Run MusicDown headlessly on any Linux server and access its full graphical user interface right inside your browser:

```bash
docker run -d \
  --name musicdown \
  -p 8080:8080 \
  -v ~/Music:/app/downloads \
  --restart unless-stopped \
  alexga03/musicdown:latest
```

- **Browser Access:** Open your browser and navigate to `http://localhost:8080/vnc.html` (or `http://<SERVER-IP>:8080/vnc.html`).
- **Host Persistence:** Downloaded songs sync directly to your host's `~/Music` directory via the `/app/downloads` volume mapping.

---

### 🛠️ Architecture & Tech Stack

| Layer | Technologies |
|---|---|
| **UI & Renderer** | HTML5, JavaScript ES6+, Tailwind CSS |
| **Desktop Runtime** | Electron 28, Node.js 20 |
| **Downloader & Audio Engine** | `yt-dlp`, `FFmpeg` |
| **Container & Virtual Display** | Docker, Debian Bookworm Slim, Xvfb, Fluxbox, x11vnc, noVNC, websockify |
| **CI / CD Automation** | GitHub Actions (Matrix Pipeline: `windows-latest` & `ubuntu-latest`) |

---

### 🧑‍💻 Contributing & Local Development

To run or build the project from source:

```bash
# 1. Clone the repository
git clone https://github.com/Alexga03/MusicDown.git
cd MusicDown/electron-app

# 2. Install dependencies
npm install

# 3. Start development mode
npm start

# 4. Package desktop binaries
npm run build:linux  # Outputs .AppImage in electron-app/release/
npm run build:win    # Outputs .exe installer in electron-app/release/
```

---

## 📄 License

This project is open-source software licensed under the [MIT License](LICENSE).
