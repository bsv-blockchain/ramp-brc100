# ramp-brc100

Vite + React front-end that lets users buy BSV with fiat via
[Onramper](https://docs.onramper.com/docs/widget) and auto-imports the
purchased outputs into any BRC-100 wallet.

The Onramper widget is embedded inline as an iframe (not a popup). The
user only sees a hero + the embedded widget; addresses and key derivation
are managed silently in the background.

## How it works

1. **Connect.** `new WalletClient('auto', 'localhost')` discovers a
   BRC-100 wallet over any available substrate (window, native messaging,
   etc.). If none is found, an install modal directs the user to
   [BSV Desktop](https://desktop.bsvb.tech). The wallet connects
   automatically and auto-retries on transient errors.

2. **Pick the next derivation index.** The app calls
   `wallet.listActions({ labels: ['onramper.bsvblockchain.tech'], labelQueryMode: 'all', limit: 1 })`
   and uses `totalActions` as the next index `i`. This avoids reusing
   addresses without relying on the calendar.

3. **Derive a fresh P2PKH address** for index `i`:
   - `protocolID = [2, '3241645161d8']` (BRC-29)
   - `keyID = 'onramper ' + String(i)`
   - `counterparty = 'anyone'`, `forSelf = true`
   - `PublicKey.fromString(publicKey).toAddress('mainnet')`

4. **Embed the Onramper widget** as an iframe pointed at
   `https://buy.onramper.com/?…`, pre-filling
   `wallets=bsv_bsv:<address>`, locking the asset with
   `onlyCryptos=bsv_bsv`, and defaulting `defaultFiat` from
   `navigator.language` → region → ISO currency. `partnerContext` carries
   `brc100:<i>` so the derivation index shows up in Onramper's dashboard
   and webhook payloads. The widget is themed to match `src/index.css`.

5. **Watch the address on-chain.** Onramper exposes no client-side
   purchase API (transaction lookups need the webhook secret) and the
   widget emits no `postMessage` events to the host page, so delivery is
   detected on-chain instead of through the provider. The app polls
   WhatsOnChain every 8 seconds:

   ```text
   GET /v1/bsv/main/address/{address}/confirmed/unspent
   GET /v1/bsv/main/address/{address}/unconfirmed/unspent
   ```

   This is provider-agnostic — it works no matter which onramp Onramper
   routes the order to.

6. **Internalize the funds.** For a detected txid the app fetches the
   BEEF from WhatsOnChain
   (`api.whatsonchain.com/v1/bsv/main/tx/{txid}/beef`), finds outputs
   paying the derived address, and calls `wallet.internalizeAction(...)`
   with `protocol: 'wallet payment'` and
   `paymentRemittance: { derivationPrefix: 'onramper', derivationSuffix: String(i), senderIdentityKey }`.
   The action is labelled `onramper.bsvblockchain.tech` so it counts
   toward the next index. An unconfirmed transaction has no merkle proof
   yet, so the BEEF fetch fails and the poller simply retries until the
   transaction is mined.

7. **Rotate.** After a successful internalize the address pointer
   advances to `i + 1`; the next purchase will use a brand-new address.
   Imported txids are remembered in `localStorage`, so an address whose
   outputs are all already in the wallet (an interrupted rotation) is
   skipped rather than re-imported.

## Recovery

Because index `i` is a simple counter, the entire deposit history can
be recovered from any compatible wallet:

```text
for i = 0, 1, 2, …:
    keyID = 'onramper ' + String(i)
    derive P2PKH address for [2, '3241645161d8'] · keyID
    if address has UTXOs → import; else stop after a gap window
```

No date math, no off-chain state required.

## Deployment prerequisites

Two things must be configured on the Onramper side before the embed works
in production — both are keyed to your API key, not to anything in this
repo:

- **Frame-ancestors allowlist (production only).** `buy.onramper.com`
  serves `Content-Security-Policy: frame-ancestors …`, which by default
  lists only Onramper's own domains plus `http://localhost` — and a bare
  `http://localhost` covers port 80, so `localhost:8080` is blocked too.
  The sandbox host `buy.onramper.dev` sends no such header, so a
  `pk_test_` key frames anywhere and the whole widget UI can be developed
  locally. Before going live, ask your Onramper contact to add your
  production origin to the key; it is not self-serve in the dashboard.
  Where framing is blocked the page falls back to the "Open Onramper in a
  new tab" link below the widget, which carries the same signed URL.
- **BSV coverage.** BSV routing is thinner than Ramp's was, and varies by
  country: at the time of writing Coinify serves `eur`/NL, `eur`/DE and
  `usd`/CA, while `usd`/US has no working route. Check your key with:

  ```bash
  curl -H "Authorization: $ONRAMPER_API_KEY" \
    "https://api.onramper.com/quotes/eur/bsv_bsv?amount=300&paymentMethod=creditcard&country=nl&type=buy"
  ```

  Any entry without an `errors` array is a live route. Where none exists,
  the widget renders "No onramp available for these details".

## Widget URL signing

Onramper requires the `wallets` parameter to be
[signed](https://docs.onramper.com/docs/signing-widget-url) with your
project's signing secret. Unsigned URLs still pre-fill the address, but
the transaction is rejected at checkout. The secret must never reach the
browser, so signing runs server-side in [`server/`](server/) — a
dependency-free Node service, ~120 lines, Node stdlib only.

It runs in two places from the same handler:

- **Development** — a Vite plugin
  ([`server/vite-plugin.js`](server/vite-plugin.js)) mounts it on the dev
  server, so `npm run dev` gets signed URLs with no extra process. The
  secret is read via `loadEnv(mode, cwd, '')`, which loads non-`VITE_`
  vars; only `VITE_*` names are inlined into the bundle.
- **Production** — the `onramper-sign` container
  ([`Dockerfile.sign`](Dockerfile.sign)). It is *not* published on the
  host; nginx proxies `/api/onramper/sign` to it over the compose
  network.

Either way the browser hits the same relative path, so
`VITE_ONRAMPER_SIGN_URL=/api/onramper/sign` works in both.

### Contract

The browser posts an **address**, never a string to sign — the server
builds the signed content itself, so the endpoint can't be used as an
oracle for arbitrary payloads:

```text
POST /api/onramper/sign
{ "address": "1ExampleAddress…" }

200 { "signContent": "wallets=bsv_bsv:1ExampleAddress…",
      "signature":   "<hmac-sha256 hex>" }
```

The client checks the echoed `signContent` against what it is about to
put in the URL before trusting the signature. Requests are refused with
`400` unless `address` matches a mainnet P2PKH Base58Check address,
`413` above 512 bytes, `405` for non-POST, and `403` for a cross-origin
caller not listed in `ALLOWED_ORIGINS`. Same-origin callers are always
allowed — the origin's host is compared against the request `Host`,
which is why nginx forwards `$http_host` rather than `$host`.

If `VITE_ONRAMPER_SIGN_URL` is blank the widget loads unsigned; a signing
failure is written to the activity log and the widget still renders.

## Setup

```bash
cp .env.example .env
# paste VITE_ONRAMPER_API_KEY and SIGNING_SECRET from
# https://dashboard.onramper.com/developer
npm install
npm run dev
```

A BRC-100 wallet must be reachable to `WalletClient`. The widget runs in
mainnet mode; pair it with a mainnet wallet.

To run the full production shape (nginx + signing container):

```bash
docker compose up --build -d
```

Both read `.env`. Because framing is origin-gated, testing through a
tunnel is usually easier than `localhost`:

```bash
ngrok http 8080
```

Everything is same-origin behind the tunnel — the SPA and
`/api/onramper/sign` share it — so `ALLOWED_ORIGINS` can stay blank.

## Production

Tagging `v*` publishes two images to GHCR:

| Image | Contents |
| ----- | -------- |
| `ghcr.io/bsv-blockchain/ramp-brc100` | Static bundle served by nginx |
| `ghcr.io/bsv-blockchain/ramp-brc100-sign` | Signing service (`server/`) |

They must share a network namespace — nginx proxies to `127.0.0.1:8081`.
In Kubernetes that means two containers in one pod; in Compose it is
`network_mode: "service:ramp-brc100"`. The signing service is never
exposed directly in either.

`VITE_ONRAMPER_API_KEY` is baked into the frontend image **at build
time** from the repository Actions secret of the same name — setting it
as a runtime env var on the container has no effect. `SIGNING_SECRET` is
the opposite: runtime only, on the signing container, and must never be
passed as a build arg.

Deployed from [`bsva-infra-flux`](https://github.com/bsv-blockchain/bsva-infra-flux)
at `apps/base/ramp-brc-100` to `bsva-us-1`, fronted by a Cloudflare
tunnel at `ramp.bsvblockchain.tech`. `SIGNING_SECRET` comes from AWS SSM
Parameter Store (`/apps/ramp-brc100/SIGNING_SECRET`, us-east-2) via
External Secrets Operator.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — type-check and build for production
- `npm run preview` — preview the production build

## Env vars

Anything named `VITE_*` is inlined into the public JavaScript bundle. The
rest is server-side only and never reaches the browser.

| Name                     | Side   | Purpose                                                       |
| ------------------------ | ------ | ------------------------------------------------------------- |
| `VITE_ONRAMPER_API_KEY`  | public | Onramper API key. `pk_test_` selects the sandbox widget host   |
| `VITE_ONRAMPER_SIGN_URL` | public | Signing endpoint path. Blank disables signing                  |
| `SIGNING_SECRET`         | server | Onramper "Signing Secret" — HMAC key for the `wallets` param   |
| `WEBHOOK_SECRET`         | server | Unused by this app; kept so `.env` mirrors the dashboard       |
| `ALLOWED_ORIGINS`        | server | Extra origins allowed to call the signing endpoint. Usually blank |

Missing the API key is logged as a developer-only `console.warn`. The
widget simply won't mount; users do not see an error. The signing service
refuses to start without `SIGNING_SECRET`.

`WEBHOOK_SECRET` and the webhook URL fields in the Onramper dashboard are
not needed: the app detects delivery on-chain rather than through
Onramper's transaction API. Leave them unset unless you add a receiver.

## Persisted state

| Key                          | Contents                                           |
| ---------------------------- | -------------------------------------------------- |
| `onramper-brc100:activity`   | Activity log (capped at 100 entries)               |
| `onramper-brc100:imported`   | Txids already internalized (capped at 200)         |

Refreshing the page resumes watching the current derived address.

## Stack

- Vite + React + TypeScript
- [`@bsv/sdk`](https://www.npmjs.com/package/@bsv/sdk) for wallet client,
  key derivation, BEEF parsing and `internalizeAction`
- [Onramper widget](https://buy.onramper.com) embedded via iframe
- WhatsOnChain address and BEEF endpoints for delivery detection and
  proof retrieval
- [`server/`](server/) — dependency-free Node URL-signing service, shared
  between the Vite dev middleware and the production container
