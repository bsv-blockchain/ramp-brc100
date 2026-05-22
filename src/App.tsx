import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  WalletClient,
  PublicKey,
  PrivateKey,
  P2PKH,
  Beef,
  Utils,
  type WalletProtocol,
  type InternalizeActionArgs,
  type InternalizeOutput
} from '@bsv/sdk'
import { RampInstantSDK } from '@ramp-network/ramp-instant-sdk'
import './App.css'

const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']
const NETWORK: 'mainnet' | 'testnet' = 'mainnet'
const WOC_BASE = 'https://api.whatsonchain.com'
const WOC_SEGMENT = NETWORK === 'mainnet' ? 'main' : 'test'

const getCurrentDate = (): string => new Date().toISOString().split('T')[0]

type Status =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'purchasing'
  | 'internalizing'
  | 'imported'
  | 'error'

type LogEntry = { kind: 'info' | 'success' | 'error'; text: string; at: Date }

function App() {
  const [wallet, setWallet] = useState<WalletClient | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [amountFiat, setAmountFiat] = useState<string>('50')
  const [fiatCurrency, setFiatCurrency] = useState<string>('EUR')

  const derivationPrefix = useMemo(
    () => Utils.toBase64(Utils.toArray(getCurrentDate(), 'utf8')),
    []
  )
  const derivationSuffix = useMemo(
    () => Utils.toBase64(Utils.toArray('legacy', 'utf8')),
    []
  )

  const appendLog = useCallback((entry: Omit<LogEntry, 'at'>) => {
    setLog((prev) => [{ ...entry, at: new Date() }, ...prev])
  }, [])

  const connect = useCallback(async () => {
    setStatus('connecting')
    setError(null)
    try {
      const w = new WalletClient('auto', 'localhost')
      const { authenticated } = await w.isAuthenticated()
      if (!authenticated) {
        await w.waitForAuthentication()
      }
      const { publicKey } = await w.getPublicKey({
        protocolID: brc29ProtocolID,
        keyID: derivationPrefix + ' ' + derivationSuffix,
        counterparty: 'anyone',
        forSelf: true
      })
      const addr = PublicKey.fromString(publicKey).toAddress(NETWORK)
      setWallet(w)
      setAddress(addr)
      setStatus('ready')
      appendLog({ kind: 'info', text: `Derived address ${addr}` })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setStatus('error')
    }
  }, [appendLog, derivationPrefix, derivationSuffix])

  const internalizePurchase = useCallback(
    async (txid: string) => {
      if (!wallet || !address) return
      setStatus('internalizing')
      appendLog({ kind: 'info', text: `Fetching BEEF for ${txid}` })
      try {
        const resp = await fetch(
          `${WOC_BASE}/v1/bsv/${WOC_SEGMENT}/tx/${txid}/beef`
        )
        if (!resp.ok) throw new Error(`WoC BEEF fetch failed: ${resp.status}`)
        const beefHex = (await resp.text()).trim()
        const beef = new Beef()
        beef.mergeBeef(Utils.toArray(beefHex, 'hex'))

        const atomic = beef.findAtomicTransaction(txid)
        if (!atomic) throw new Error('Atomic transaction not found in BEEF')

        const targetScriptHex = new P2PKH().lock(address).toHex()
        const outputs: InternalizeOutput[] = atomic.outputs
          .map((out, idx) => ({ out, idx }))
          .filter(({ out }) => out.lockingScript.toHex() === targetScriptHex)
          .map(({ idx }) => ({
            outputIndex: idx,
            protocol: 'wallet payment' as const,
            paymentRemittance: {
              senderIdentityKey: new PrivateKey(1).toPublicKey().toString(),
              derivationPrefix,
              derivationSuffix
            }
          }))

        if (outputs.length === 0)
          throw new Error(`No outputs paying ${address} found in tx`)

        const args: InternalizeActionArgs = {
          tx: atomic.toAtomicBEEF(),
          description: 'Ramp BSV Purchase',
          outputs,
          labels: [
            'ramp',
            'inbound',
            address,
            `ts:${Math.floor(Date.now() / 1000)}`
          ]
        }
        const result = await wallet.internalizeAction(args)
        if (result?.accepted) {
          setStatus('imported')
          appendLog({
            kind: 'success',
            text: `Imported ${txid} (${outputs.length} output${outputs.length > 1 ? 's' : ''})`
          })
        } else {
          throw new Error('internalizeAction not accepted')
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        setStatus('error')
        appendLog({ kind: 'error', text: msg })
      }
    },
    [wallet, address, derivationPrefix, derivationSuffix, appendLog]
  )

  const openRamp = useCallback(() => {
    if (!address) return
    setStatus('purchasing')
    setError(null)

    const apiKey = import.meta.env.VITE_RAMP_API_KEY
    if (!apiKey) {
      setError('Missing VITE_RAMP_API_KEY in env')
      setStatus('error')
      return
    }

    const ramp = new RampInstantSDK({
      hostAppName: 'Ramp BRC-100 Demo',
      hostLogoUrl: 'https://cdn.rampnetwork.com/logo.png',
      swapAsset: 'BSV',
      userAddress: address,
      fiatValue: amountFiat || undefined,
      fiatCurrency: fiatCurrency || undefined,
      hostApiKey: apiKey
    })

    ramp.on('*', (event: { type: string; payload?: unknown }) => {
      if (event.type === 'PURCHASE_CREATED') {
        appendLog({ kind: 'info', text: 'Purchase created on Ramp' })
      }
      if (event.type === 'PURCHASE_SUCCESSFUL') {
        const payload = event.payload as
          | { purchase?: { finalTxHash?: string } }
          | undefined
        const txid = payload?.purchase?.finalTxHash
        if (txid) {
          appendLog({ kind: 'success', text: `Ramp delivered txid ${txid}` })
          void internalizePurchase(txid)
        } else {
          appendLog({
            kind: 'error',
            text: 'PURCHASE_SUCCESSFUL had no finalTxHash'
          })
        }
      }
      if (event.type === 'WIDGET_CLOSE') {
        setStatus((s) => (s === 'purchasing' ? 'ready' : s))
      }
    })

    ramp.show()
  }, [address, amountFiat, fiatCurrency, appendLog, internalizePurchase])

  useEffect(() => {
    void connect()
  }, [connect])

  return (
    <main className="container">
      <header>
        <h1>Buy BSV via Ramp</h1>
        <p className="muted">
          BRC-29 Legacy Bridge derived address. Funds auto-internalized
          post-purchase.
        </p>
      </header>

      <section className="card">
        <div className="row">
          <span className="label">Status</span>
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <div className="row">
          <span className="label">Address</span>
          <code className="mono">{address ?? '—'}</code>
        </div>
        <div className="row">
          <span className="label">Derivation</span>
          <code className="mono small">
            prefix={derivationPrefix} suffix={derivationSuffix}
          </code>
        </div>
        {error && <div className="error">{error}</div>}
      </section>

      <section className="card">
        <h2>Purchase</h2>
        <div className="form">
          <label>
            Amount
            <input
              type="number"
              min="1"
              value={amountFiat}
              onChange={(e) => setAmountFiat(e.target.value)}
              disabled={
                status === 'purchasing' || status === 'internalizing'
              }
            />
          </label>
          <label>
            Currency
            <select
              value={fiatCurrency}
              onChange={(e) => setFiatCurrency(e.target.value)}
              disabled={
                status === 'purchasing' || status === 'internalizing'
              }
            >
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          className="primary"
          onClick={openRamp}
          disabled={
            !address ||
            status === 'purchasing' ||
            status === 'internalizing'
          }
        >
          {status === 'purchasing' ? 'Ramp widget open…' : 'Buy BSV'}
        </button>
        {(status === 'idle' ||
          status === 'connecting' ||
          status === 'error') && (
          <button
            type="button"
            className="secondary"
            onClick={() => void connect()}
          >
            {status === 'connecting' ? 'Connecting…' : 'Reconnect wallet'}
          </button>
        )}
      </section>

      <section className="card">
        <h2>Activity</h2>
        {log.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="log">
            {log.map((entry, i) => (
              <li key={i} className={`log-${entry.kind}`}>
                <span className="log-time">
                  {entry.at.toLocaleTimeString()}
                </span>
                <span className="log-text">{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

export default App
