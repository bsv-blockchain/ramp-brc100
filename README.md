# ramp-brc100

Vite + React front-end that lets users buy BSV with fiat via
[Ramp Network](https://docs.rampnetwork.com/web/quick-start-embedded) and
auto-imports the purchased outputs into a BRC-100 wallet using the same
BRC-29 Legacy Bridge derivation scheme as
[bsv-browser](https://github.com/sirdeggen/bsv-browser).

## How it works

1. Connect to any BRC-100 wallet via `WalletClient('auto', 'localhost')`.
2. Derive a receiving P2PKH address with:
   - `protocolID = [2, '3241645161d8']` (BRC-29)
   - `keyID = base64(YYYY-MM-DD) + ' ' + base64('legacy')`
   - `counterparty = 'anyone'`, `forSelf = true`
3. Open the Ramp Instant widget with that address as `userAddress`.
4. On `PURCHASE_SUCCESSFUL`, take `purchase.finalTxHash`, fetch the BEEF
   from WhatsOnChain, and call `wallet.internalizeAction(...)` with
   `protocol: 'wallet payment'` and the same `derivationPrefix` /
   `derivationSuffix` so the wallet recognises and indexes the UTXOs.

## Setup

```bash
cp .env.example .env
# edit .env, paste your Ramp host API key
npm install
npm run dev
```

A BRC-100 wallet must be installed and reachable via the wallet client
(e.g. a desktop or browser wallet exposing the BRC-100 transport). The
Ramp widget runs in mainnet mode; pair it with a mainnet wallet.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — type-check and build for production
- `npm run preview` — preview the production build

## Env vars

| Name                  | Purpose                          |
| --------------------- | -------------------------------- |
| `VITE_RAMP_API_KEY`   | Ramp Network host API key        |
