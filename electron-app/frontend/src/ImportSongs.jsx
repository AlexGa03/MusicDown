import React, { useState } from "react";

function ImportSongs({ onImport, disabled }) {
  const [fileName, setFileName] = useState("");

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setFileName(file.name);
    const text = await file.text();
    const songs = text.split("\n").map((s) => s.trim()).filter(Boolean);

    await fetch("http://127.0.0.1:8000/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songs }),
    });

    onImport();
  };

  return (
    <div className="p-4">
      <label
        className={`cursor-pointer px-4 py-2 rounded-lg shadow-md ${
          disabled
            ? "bg-gray-400 cursor-not-allowed"
            : "bg-blue-600 hover:bg-blue-700 text-white"
        }`}
      >
        Importar canciones
        <input
          type="file"
          accept=".txt"
          className="hidden"
          onChange={handleFileChange}
          disabled={disabled}
        />
      </label>
      {fileName && <p className="text-sm mt-2">Archivo cargado: {fileName}</p>}
    </div>
  );
}

export default ImportSongs;
