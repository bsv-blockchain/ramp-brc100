import { createSignHandler, SIGN_PATH } from './onramper-sign.js'

/**
 * Serves the Onramper signing endpoint from the Vite dev server, so
 * `npm run dev` gets signed widget URLs without running the container.
 *
 * The secret is read from a non-`VITE_` env var, so it never reaches the
 * browser bundle.
 *
 * @param {string | undefined} secret
 */
export function onramperSignPlugin(secret) {
  return {
    name: 'onramper-sign',
    apply: 'serve',
    configureServer(server) {
      if (!secret) {
        server.config.logger.warn(
          `[onramper-sign] SIGNING_SECRET is not set — ${SIGN_PATH} is disabled and widget URLs will be unsigned.`
        )
        return
      }
      const handleSign = createSignHandler({ secret, allowedOrigins: [] })
      server.middlewares.use(SIGN_PATH, (req, res, next) => {
        if (req.method !== 'POST' && req.method !== 'OPTIONS') {
          next()
          return
        }
        void handleSign(req, res)
      })
    }
  }
}
