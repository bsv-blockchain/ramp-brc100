import { createServer } from 'node:http'
import { createSignHandler, SIGN_PATH } from './onramper-sign.js'

// Names match the Onramper dashboard's "Signing Secret" field.
const secret = process.env.SIGNING_SECRET
if (!secret) {
  console.error('[onramper-sign] SIGNING_SECRET is not set — refusing to start.')
  process.exit(1)
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const port = Number(process.env.PORT ?? 8081)
const handleSign = createSignHandler({ secret, allowedOrigins })

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]

  if (path === '/health') {
    res.statusCode = 200
    res.setHeader('content-type', 'text/plain')
    res.end('healthy\n')
    return
  }

  if (path === SIGN_PATH) {
    void handleSign(req, res)
    return
  }

  res.statusCode = 404
  res.end()
}).listen(port, () => {
  console.log(`[onramper-sign] listening on :${port}${SIGN_PATH}`)
  if (allowedOrigins.length === 0) {
    console.log('[onramper-sign] same-origin only (no CORS origins allowed)')
  } else {
    console.log(`[onramper-sign] allowed origins: ${allowedOrigins.join(', ')}`)
  }
})
