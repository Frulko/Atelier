import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// En développement, l'API est celle d'un orchestrateur lancé à côté (ATELIER_API, 8080 par défaut).
// Le proxy garde l'origine du navigateur : cookies de session et contrôle d'Origin fonctionnent comme en production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": { target: process.env.ATELIER_API ?? "http://localhost:8080" } } },
  build: { outDir: "dist", sourcemap: false },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
