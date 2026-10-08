import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxies /api/* to the Flask backend during `npm run dev`, so the
// frontend can just call fetch("/api/...") with no CORS setup needed —
// same pattern the old server-rendered frontend had "for free" by being
// served from the same Flask process. In production, VITE_API_BASE_URL
// (see src/api/client.js) points at wherever the Flask API is deployed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:5001",
        changeOrigin: true,
      },
    },
  },
});
