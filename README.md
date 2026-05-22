# ramp-brc100

Vite + React front-end that lets users buy BSV with fiat via
[Ramp Network](https://docs.rampnetwork.com/sdk-reference) and
auto-imports the purchased outputs into any BRC-100 wallet.

The Ramp Instant widget is mounted inline (embedded mode, not a popup).
The user only sees a hero + the embedded widget; addresses and key
derivation are managed silently in the background.

## How it works

1. **Connect.** `new WalletClient('auto', 'localhost')` discovers a
   BRC-100 wallet over any available substrate (window, native messaging,
   etc.). If none is found, an install modal directs the user to
   [BSV Desktop](https://desktop.bsvb.tech). The wallet connects
   automatically and auto-retries on transient errors.

2. **Pick the next derivation index.** The app calls
   `wallet.listActions({ labels: ['ramp.bsvblockchain.tech'], labelQueryMode: 'all', limit: 1 })`
   and uses `totalActions` as the next index `i`. This avoids reusing
   addresses without relying on the calendar.

3. **Derive a fresh P2PKH address** for index `i`:
   - `protocolID = [2, '3241645161d8']` (BRC-29)
   - `keyID = 'ramp ' + String(i)`
   - `counterparty = 'anyone'`, `forSelf = true`
   - `PublicKey.fromString(publicKey).toAddress('mainnet')`

4. **Embed the Ramp widget** into a `<div>` via
   `containerNode` + `variant: 'embedded-desktop' | 'embedded-mobile'`,
   pre-filling `userAddress` and `fiatCurrency` (defaulted from
   `navigator.language` → region → ISO currency).

5. **Listen for `PURCHASE_CREATED`.** Ramp's SDK does not emit a
   `PURCHASE_SUCCESSFUL` event; the `finalTxHash` is populated on the
   purchase object later. The app stores the purchase id, `apiUrl`, and
   `purchaseViewToken` in `localStorage` and polls
   `${apiUrl}/purchase/{id}?secret={token}` every 8 seconds until
   `finalTxHash` appears (or the purchase reaches `EXPIRED` /
   `CANCELLED`).

6. **Internalize the funds.** Once `finalTxHash` is available, the app
   fetches the BEEF from WhatsOnChain
   (`api.whatsonchain.com/v1/bsv/main/tx/{txid}/beef`), finds outputs
   paying the derived address, and calls `wallet.internalizeAction(...)`
   with `protocol: 'wallet payment'` and
   `paymentRemittance: { derivationPrefix: 'ramp', derivationSuffix: String(i), senderIdentityKey }`.
   The action is labelled `ramp.bsvblockchain.tech` so it counts toward
   the next index.

7. **Rotate.** After a successful internalize the address pointer
   advances to `i + 1`; the next purchase will use a brand-new address.

## Recovery

Because index `i` is a simple counter, the entire deposit history can
be recovered from any compatible wallet:

```text
for i = 0, 1, 2, …:
    keyID = 'ramp ' + String(i)
    derive P2PKH address for [2, '3241645161d8'] · keyID
    if address has UTXOs → import; else stop after a gap window
```

No date math, no off-chain state required.

## Setup

```bash
cp .env.example .env
# edit .env, paste your Ramp host API key (VITE_RAMP_API_KEY)
npm install
npm run dev
```

A BRC-100 wallet must be reachable to `WalletClient`. The Ramp widget
runs in mainnet mode; pair it with a mainnet wallet.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — type-check and build for production
- `npm run preview` — preview the production build

## Env vars

| Name                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `VITE_RAMP_API_KEY` | Ramp Network host API key (see Ramp dashboard)       |

Missing the API key is logged as a developer-only `console.warn`. The
widget simply won't mount; users do not see an error.

## Persisted state

| Key                          | Contents                                           |
| ---------------------------- | -------------------------------------------------- |
| `ramp-brc100:activity`       | Activity log (capped at 100 entries)               |
| `ramp-brc100:pending`        | In-flight purchase awaiting Ramp release           |

Refreshing the page resumes polling for a pending purchase.

## Stack

- Vite + React + TypeScript
- [`@bsv/sdk`](https://www.npmjs.com/package/@bsv/sdk) for wallet client,
  key derivation, BEEF parsing and `internalizeAction`
- [`@ramp-network/ramp-instant-sdk`](https://www.npmjs.com/package/@ramp-network/ramp-instant-sdk)
  for the embedded purchase widget
- WhatsOnChain BEEF endpoint for proof retrieval
