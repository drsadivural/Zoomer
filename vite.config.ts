import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Keeps `vite dev --host` safe to expose. Miniflare's /cdn-cgi/ tooling (the local
 * explorer can read and write D1 and R2) only checks the Host header, which a remote
 * client can forge, so those paths are served to loopback clients only.
 */
function loopbackOnlyDevTools(): Plugin {
  return {
    name: "loopback-only-dev-tools",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (LOOPBACK.has(req.socket.remoteAddress ?? "")) return next();
        let target = req.url ?? "";
        try {
          target = decodeURIComponent(target);
        } catch {
          // Malformed escapes: match on the raw form.
        }
        if (/cdn-cgi/i.test(target)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [loopbackOnlyDevTools(), react(), tailwindcss(), cloudflare()],
  server: {
    // Hostnames allowed in the Host header. Adding the public subdomain lets the
    // Caddy reverse proxy forward requests through with the original Host.
    allowedHosts: ["zoomer-dev.ayonix.com"],
    // Generated bootstrap credentials must never be served, even with `--host`.
    fs: { deny: ["**/.secrets/**", "**/seed/seed.sql"] },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "~worker": path.resolve(import.meta.dirname, "./worker"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          ui: ["radix-ui", "lucide-react"],
        },
      },
    },
  },
});
