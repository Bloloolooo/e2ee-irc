import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:3001",
        ws: true
      },
      "/files": {
        target: "http://localhost:3001"
      },
      "/admin": {
        target: "http://localhost:3001"
      }
    }
  }
});
