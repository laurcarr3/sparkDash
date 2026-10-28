import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Allow HMR when opened via LAN IP / Docker
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === "1",
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5555",
        configure(proxy) {
          proxy.on("proxyReq", (_proxyRequest, request) => {
            if (!/\/models\/[^/]+\/(?:start|stop)$/.test(request.url || "")) return;
            console.info("[sparkDash Vite proxy] request", {
              requestId: request.headers["x-request-id"] ?? null,
              method: request.method,
              path: request.url,
              target: "http://127.0.0.1:5555",
            });
          });
          proxy.on("proxyRes", (proxyResponse, request) => {
            if (!/\/models\/[^/]+\/(?:start|stop)$/.test(request.url || "")) return;
            console.info("[sparkDash Vite proxy] response", {
              requestId: request.headers["x-request-id"] ?? null,
              method: request.method,
              path: request.url,
              status: proxyResponse.statusCode,
              responseRequestId: proxyResponse.headers["x-request-id"] ?? null,
            });
          });
          proxy.on("error", (error, request) => {
            if (!/\/models\/[^/]+\/(?:start|stop)$/.test(request.url || "")) return;
            console.error("[sparkDash Vite proxy] failure", {
              requestId: request.headers["x-request-id"] ?? null,
              method: request.method,
              path: request.url,
              error: { name: error.name, message: error.message, stack: error.stack },
            });
          });
        },
      },
      "/ws": {
        target: "ws://127.0.0.1:5555",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
