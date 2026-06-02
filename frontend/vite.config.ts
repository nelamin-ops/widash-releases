import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy third-party deps into their own chunks so they
        // get cached independently by the browser. App code loads
        // first; charts/animations/dnd come along on demand.
        manualChunks: {
          react: ["react", "react-dom"],
          recharts: ["recharts"],
          motion: ["framer-motion"],
          dnd: ["@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities"],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
