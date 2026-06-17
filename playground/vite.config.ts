import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Same-origin RPC proxy so a single Cloudflare tunnel exposes UI + chain RPCs: the remote browser
// talks only to this origin; Vite (on the dev machine) proxies /rpc/* to the local anvil chains.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
    proxy: {
      '/rpc/a': { target: 'http://127.0.0.1:8800', changeOrigin: true, rewrite: (p) => p.replace(/^\/rpc\/a/, '') },
      '/rpc/b': { target: 'http://127.0.0.1:8802', changeOrigin: true, rewrite: (p) => p.replace(/^\/rpc\/b/, '') },
      '/rpc/c': { target: 'http://127.0.0.1:8804', changeOrigin: true, rewrite: (p) => p.replace(/^\/rpc\/c/, '') },
    },
  },
})
