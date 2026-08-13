# ramp-brc100

Vite + React front-end that lets users buy BSV with fiat via
[Onramp Money](https://onramp.money) and auto-imports the purchased
outputs into any BRC-100 wallet.

The widget is mounted inline via the SDK's embedded mode. The user only
sees a hero + the embedded widget; addresses and key derivation are
managed silently in the background.

## How it works

1. **Connect.** `new WalletClient('auto', 'localhost')` discovers a
   BRC-100 wallet over any available substrate (window, native messaging,
   etc.). If none is found, an install modal directs the user to
   [BSV Desktop](https://desktop.bsvb.tech). The wallet connects
   automatically and auto-retries on transient errors.

2. **Pick the next derivation index.** The app calls
   `wallet.listActions({ labels: ['onramp.bsvblockchain.tech'], labelQueryMode: 'all', limit: 1 })`
   and uses `totalActions` as the next index `i`. This avoids reusing
   addresses without relying on the calendar.

3. **Derive a fresh P2PKH address** for index `i`:
   - `protocolID = [2, '3241645161d8']` (BRC-29)
   - `keyID = 'onramp ' + String(i)`
   - `counterparty = 'anyone'`, `forSelf = true`
   - `PublicKey.fromString(publicKey).toAddress('mainnet')`

4. **Mount the widget** with
   [`@onramp.money/onramp-web-sdk`](https://www.npmjs.com/package/@onramp.money/onramp-web-sdk)
   in embedded mode (`containerId`), pre-filling `walletAddress` and
   pinning the asset with `coinCode: 'bsv'` / `network: 'bsv'`. Those come
   from Onramp Money's public config — coin 66 "Bitcoin SV" on network
   10535, whose `chainSymbol` is `bsv`:

   ```bash
   curl -s https://api.onramp.money/onramp/api/v2/buy/public/allConfig
   ```

5. **Watch the address on-chain.** The SDK emits `TX_EVENTS`
   (`ONRAMP_WIDGET_TX_SENT`, `TX_COMPLETED`, …), but its payload schema is
   undocumented — the TypeScript types declare `data: object` — so those
   events drive status text only and nothing else. Delivery itself is
   confirmed on-chain, which is provider-agnostic and cannot drift from
   reality. The app polls WhatsOnChain every 8 seconds:

   ```text
   GET /v1/bsv/main/address/{address}/unspent
   ```

   The split `confirmed/unspent` + `unconfirmed/unspent` endpoints 404 on
   an address with no history — the steady state here — so the combined
   one is used and `height === 0` marks a mempool entry.

6. **Internalize the funds.** For a detected txid the app fetches the
   BEEF from WhatsOnChain
   (`api.whatsonchain.com/v1/bsv/main/tx/{txid}/beef`), finds outputs
   paying the derived address, and calls `wallet.internalizeAction(...)`
   with `protocol: 'wallet payment'` and
   `paymentRemittance: { derivationPrefix: 'onramp', derivationSuffix: String(i), senderIdentityKey }`.
   The action is labelled `onramp.bsvblockchain.tech` so it counts toward
   the next index. An unconfirmed transaction has no merkle proof yet, so
   the BEEF fetch fails and the poller retries until it is mined.

7. **Rotate.** Every delivery sitting at the address is imported before
   the pointer advances to `i + 1` — rotation is one-way, so a second
   purchase arriving at the same address would otherwise be stranded.
   Imported txids are remembered in `localStorage`, so an address whose
   outputs are all already in the wallet (an interrupted rotation) is
   skipped rather than re-imported.

## Recovery

Because index `i` is a simple counter, the entire deposit history can
be recovered from any compatible wallet:

```text
for i = 0, 1, 2, …:
    keyID = 'onramp ' + String(i)
    derive P2PKH address for [2, '3241645161d8'] · keyID
    if address has UTXOs → import; else stop after a gap window
```

No date math, no off-chain state required.

## Setup

```bash
cp .env.example .env
# paste VITE_ONRAMP_APP_ID from the Onramp Money merchant dashboard
npm install
npm run dev
```

A BRC-100 wallet must be reachable to `WalletClient`. The app runs in
mainnet mode; pair it with a mainnet wallet.

Set `VITE_ONRAMP_SANDBOX=true` to point the widget at
`test.onramp.money` instead of production.

## Env vars

Both are `VITE_*`, so both are inlined into the public bundle. That is
fine — the Onramp Money widget takes only a public `appId`. There is no
URL signing and therefore no server-side secret, no signing service and
nothing that must be kept out of the bundle.

| Name                   | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `VITE_ONRAMP_APP_ID`   | Onramp Money application ID (a number)             |
| `VITE_ONRAMP_SANDBOX`  | `"true"` to use the sandbox environment            |

A missing app ID is logged as a developer-only `console.warn`. The widget
simply won't mount; users do not see an error.

## Persisted state

| Key                        | Contents                                     |
| -------------------------- | -------------------------------------------- |
| `onramp-brc100:activity`   | Activity log (capped at 100 entries)         |
| `onramp-brc100:imported`   | Txids already internalized (capped at 200)   |

Refreshing the page resumes watching the current derived address.

## Production

Tagging `v*` publishes `ghcr.io/bsv-blockchain/ramp-brc100` to GHCR.
`VITE_ONRAMP_APP_ID` is baked in **at build time** from the repository
Actions secret of the same name — setting it as a runtime env var on the
container has no effect.

Deployed from [`bsva-infra-flux`](https://github.com/bsv-blockchain/bsva-infra-flux)
at `apps/base/ramp-brc-100` to `bsva-us-1`, fronted by a Cloudflare
tunnel at `ramp.bsvblockchain.tech`.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — type-check and build for production
- `npm run preview` — preview the production build

## Stack

- Vite + React + TypeScript
- [`@bsv/sdk`](https://www.npmjs.com/package/@bsv/sdk) for wallet client,
  key derivation, BEEF parsing and `internalizeAction`
- [`@onramp.money/onramp-web-sdk`](https://www.npmjs.com/package/@onramp.money/onramp-web-sdk)
  for the embedded purchase widget
- WhatsOnChain address and BEEF endpoints for delivery detection and
  proof retrieval

## History

The Onramper (onramper.com) implementation this replaced is preserved on
the [`onramper-widget`](https://github.com/bsv-blockchain/ramp-brc100/tree/onramper-widget)
branch. It required a server-side HMAC signing service for the widget
URL, which Onramp Money does not.
