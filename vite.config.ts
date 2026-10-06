import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // server.ts (Express) is retired -- every /api/* call the UI makes is now
      // served by the Python FastAPI app (uvicorn app:app --port 5000).
      // Run the FastAPI server separately and let Vite's dev server proxy to it.
      proxy: {
        '/api': {
          target: process.env.TCP_API_URL || 'http://localhost:5000',
          changeOrigin: true,
        },
      },
    },
    // Mirrors `server.proxy` above so `npm run start` (vite preview, serving
    // the production build) also reaches FastAPI for /api/* — otherwise only
    // `npm run dev` would have working API calls.
    preview: {
      proxy: {
        '/api': {
          target: process.env.TCP_API_URL || 'http://localhost:5000',
          changeOrigin: true,
        },
      },
    },
  };
});
