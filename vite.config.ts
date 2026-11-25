import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = `http://127.0.0.1:${process.env.API_PORT || env.API_PORT || 3001}`;
  return {
  plugins: [tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: apiTarget } },
  },
  preview: {
    host: '127.0.0.1', port: 4173, strictPort: true,
    proxy: { '/api': { target: apiTarget } },
  },
  };
});
