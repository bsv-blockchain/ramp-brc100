import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { onramperSignPlugin } from './server/vite-plugin.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Empty prefix so non-VITE_ vars load too. Only VITE_* are inlined into the
  // bundle, so the signing secret stays server-side.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), onramperSignPlugin(env.SIGNING_SECRET)],
    server: {
      port: 8080,
      host: true,
      allowedHosts: ['deggen.ngrok.app']
    },
    preview: {
      port: 8080,
      host: true,
      allowedHosts: ['deggen.ngrok.app']
    }
  }
})
