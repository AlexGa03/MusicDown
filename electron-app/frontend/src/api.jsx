import axios from "axios";

const API = axios.create({
  baseURL: "http://127.0.0.1:8000", // tu backend FastAPI
});

export const getQueue = () => API.get("/queue");
export const addSongs = (songs) => API.post("/add", { songs });
export const startDownloads = () => API.post("/start");
export const stopDownloads = () => API.post("/stop");
export const clearQueue = () => API.post("/clear");
