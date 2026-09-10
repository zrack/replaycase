import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appOutDir = process.env.REPLAYCASE_APP_OUT_DIR?.trim() || process.env.NARROWSLINK_APP_OUT_DIR?.trim() || "dist";

export default defineConfig({
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  build: {
    emptyOutDir: true,
    outDir: appOutDir,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) return "telemetry-charts";
          if (id.includes("node_modules/@phosphor-icons")) return "icons";
          if (id.includes("node_modules/fflate")) return "evidence-bundle";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react-runtime";
        },
      },
    },
  },
  plugins: [react()],
});
