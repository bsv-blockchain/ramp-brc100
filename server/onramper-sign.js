/**
 * Onramper widget URL signing.
 *
 * Onramper requires the `wallets` query parameter to be HMAC-signed with the
 * project's signing secret — unsigned URLs still pre-fill the address, but
 * the transaction is rejected at checkout. The secret must never reach the
 * browser, so signing happens here.
 *
 * The browser posts a wallet address, not a string to sign: this module
 * builds the signed content itself, so the endpoint can never be used as an
 * oracle for arbitrary payloads.
 *
 * https://docs.onramper.com/docs/signing-widget-url
 */
import { createHmac } from 'node:crypto'

export const SIGN_PATH = '/api/onramper/sign'
export const ONRAMPER_CRYPTO = 'bsv_bsv'

const MAX_BODY_BYTES = 512

// Base58Check P2PKH mainnet address: version byte 0x00 gives a leading '1',
// followed by 25-34 more Base58 characters.
const ADDRESS_PATTERN = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/

/**
 * @param {unknown} address
 * @returns {string}
 */
export function buildSignContent(address) {
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) {
    throw new Error('invalid BSV address')
  }
  // Onramper signs the raw, un-encoded value; the browser URL-encodes it
  // afterwards. With a single wallet the alphabetical-ordering step in
  // Onramper's guide is a no-op.
  return `wallets=${ONRAMPER_CRYPTO}:${address}`
}

/**
 * @param {string} secret
 * @param {unknown} address
 * @returns {{ signContent: string, signature: string }}
 */
export function signAddress(secret, address) {
  const signContent = buildSignContent(address)
  const signature = createHmac('sha256', secret)
    .update(signContent)
    .digest('hex')
  return { signContent, signature }
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // Stop reading rather than destroying the socket, so the caller still
    // gets a response. Node closes the connection once it is flushed.
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError()
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Same-origin requests still carry an `Origin` header on POST, so it is
 * matched against the host the browser actually connected to rather than
 * being treated as cross-origin. The port matters, so nginx must forward
 * `$http_host` (not `$host`, which strips it).
 */
function isSameOrigin(origin, host) {
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Builds a framework-free `(req, res)` handler for POST {@link SIGN_PATH}.
 *
 * Same-origin callers are always allowed — that covers both the
 * nginx-proxied deployment and the Vite dev server. Other origins are
 * refused unless listed in `allowedOrigins`.
 *
 * @param {{ secret: string, allowedOrigins?: string[] }} options
 */
export function createSignHandler({ secret, allowedOrigins = [] }) {
  if (!secret) throw new Error('a signing secret is required')

  return async function handleSignRequest(req, res) {
    const origin = req.headers.origin
    const originAllowed =
      !origin ||
      isSameOrigin(origin, req.headers.host) ||
      allowedOrigins.includes(origin)
    if (origin && originAllowed) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (!originAllowed) {
      sendJson(res, 403, { error: 'origin not allowed' })
      return
    }

    let body
    try {
      body = await readJsonBody(req)
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: 'request body too large' })
      } else {
        sendJson(res, 400, { error: 'invalid request body' })
      }
      return
    }

    try {
      sendJson(res, 200, signAddress(secret, body?.address))
    } catch {
      sendJson(res, 400, { error: 'invalid BSV address' })
    }
  }
}
