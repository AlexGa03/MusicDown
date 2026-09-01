const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs-extra");

function run(cmd, cwd = process.cwd()) {
  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

async function main() {
  const backendDir = path.join(__dirname, "backend");
  const frontendDir = path.join(__dirname, "frontend");
  const distDir = path.join(__dirname, "dist");

  // 🔹 Borrar dist antes de build
  fs.removeSync(distDir);

  // 🔹 Hacer build del Frontend
  console.log("🔨 Construyendo Frontend...");
  execSync("npm run build", { cwd: frontendDir, stdio: "inherit" });
  
  // Asegurarse de que dist existe
  fs.ensureDirSync(distDir);

  // --- INICIO DE MODIFICACIÓN PARA ENTORNO VIRTUAL ---
  const venvDir = path.join(backendDir, "venv");
  
  // Detectar el sistema operativo para usar las rutas correctas
  const isWin = process.platform === "win32";
  const binFolder = isWin ? "Scripts" : "bin";
  
  // Rutas directas a los ejecutables dentro del entorno virtual
  const pythonExe = path.join(venvDir, binFolder, isWin ? "python.exe" : "python");
  const pyinstallerExe = path.join(venvDir, binFolder, isWin ? "pyinstaller.exe" : "pyinstaller");

  // Crear el entorno virtual si no existe
  if (!fs.existsSync(venvDir)) {
    console.log("📦 Creando entorno virtual de Python aislado (venv)...");
    const basePython = isWin ? "python" : "python3"; 
    run(`${basePython} -m venv venv`, backendDir);
  }

  // 1️⃣ Instalar dependencias necesarias en el Python del venv
  console.log("⬇️ Instalando dependencias en el entorno virtual...");
  run(`"${pythonExe}" -m pip install -U pip`, backendDir);
  
  // Añadimos fastapi y uvicorn a la lista de instalación del entorno virtual
  run(`"${pythonExe}" -m pip install -U fastapi uvicorn yt-dlp websockets pyinstaller`, backendDir);
  // --- FIN DE MODIFICACIÓN PARA ENTORNO VIRTUAL ---

  // 2️⃣ Compilar backend con PyInstaller usando el venv
  const backendDist = path.join(distDir, "backend");
  const backendBuild = path.join(__dirname, "build"); // Definimos la ruta exacta para los archivos temporales

  // Limpiamos las carpetas antiguas para destruir cualquier caché defectuosa
  if (fs.existsSync(backendDist)) fs.removeSync(backendDist);
  if (fs.existsSync(backendBuild)) fs.removeSync(backendBuild);

  console.log("🐍 Compilando Backend...");
  
  // 👇 Ejecutamos pyinstaller llamando a su ejecutable directo y añadimos --clean
  const pyInstallerCmd = [
    `"${pyinstallerExe}"`, 
    "--clean", // ¡NUEVO! Obliga a PyInstaller a ignorar la caché y empezar desde cero
    "--onefile",
    "backend.py",
    `--distpath ${backendDist}`,
    `--workpath ${backendBuild}`, // Usamos la ruta absoluta que definimos arriba
    "--hidden-import=uvicorn.logging",
    "--hidden-import=uvicorn.loops",
    "--hidden-import=uvicorn.loops.auto",
    "--hidden-import=uvicorn.protocols",
    "--hidden-import=uvicorn.protocols.http",
    "--hidden-import=uvicorn.protocols.http.auto",
    "--hidden-import=uvicorn.protocols.websockets",
    "--hidden-import=uvicorn.protocols.websockets.auto",
    "--hidden-import=uvicorn.lifespan.on",
    "--hidden-import=websockets"
  ].join(" ");

  run(pyInstallerCmd, backendDir);

  // 3️⃣ Copiar frontend build a dist/frontend
  const frontendDist = path.join(frontendDir, "dist");
  const targetFrontendDist = path.join(distDir, "frontend");

  if (!fs.existsSync(frontendDist)) {
    console.error(
      `❌ No se encontró la carpeta de build del frontend en ${frontendDist}`
    );
    process.exit(1);
  }

  fs.removeSync(targetFrontendDist);
  fs.copySync(frontendDist, targetFrontendDist);
  console.log(`✅ Frontend copiado a ${targetFrontendDist}`);
}

main();