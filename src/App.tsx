import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  RampInstantSDK,
  RampInstantEventTypes,
  type RampInstantPurchase
} from '@ramp-network/ramp-instant-sdk'
import './App.css'

const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']
const NETWORK: 'mainnet' | 'testnet' = 'mainnet'
const WOC_BASE = 'https://api.whatsonchain.com'
const WOC_SEGMENT = NETWORK === 'mainnet' ? 'main' : 'test'
const RAMP_LABEL = 'ramp.bsvblockchain.tech'
const DERIVATION_PREFIX = 'ramp'
const SWAP_ASSET = 'BSV_BSV'
const PENDING_STORAGE_KEY = 'ramp-brc100:pending'
const LOG_STORAGE_KEY = 'ramp-brc100:activity'
const POLL_INTERVAL_MS = 8000

const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', PT: 'EUR',
  IE: 'EUR', AT: 'EUR', BE: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR',
  SK: 'EUR', SI: 'EUR', EE: 'EUR', LT: 'EUR', LV: 'EUR', CY: 'EUR',
  MT: 'EUR', HR: 'EUR',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CH: 'CHF',
  SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
  RO: 'RON', BG: 'BGN',
  IN: 'INR', BR: 'BRL', MX: 'MXN', ZA: 'ZAR', SG: 'SGD', HK: 'HKD',
  KR: 'KRW', TR: 'TRY', AE: 'AED'
}

function detectDefaultCurrency(): string {
  try {
    const lang = navigator.language || 'en-US'
    const region = new Intl.Locale(lang).maximize().region ?? ''
    return REGION_CURRENCY[region] ?? 'USD'
  } catch {
    return 'USD'
  }
}

function detectVariant(): 'embedded-desktop' | 'embedded-mobile' {
  if (typeof window === 'undefined') return 'embedded-desktop'
  return window.matchMedia('(max-width: 600px)').matches
    ? 'embedded-mobile'
    : 'embedded-desktop'
}

type Status =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'awaiting-purchase'
  | 'awaiting-release'
  | 'internalizing'
  | 'imported'
  | 'error'

type LogEntry = { kind: 'info' | 'success' | 'error'; text: string; at: Date }

type PendingPurchase = {
  id: string
  apiUrl: string
  viewToken: string
  address: string
  derivationIndex: number
  fiatValue: string
  fiatCurrency: string
  createdAt: string
}

function loadLog(): LogEntry[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<
      Omit<LogEntry, 'at'> & { at: string }
    >
    return parsed.map((e) => ({ ...e, at: new Date(e.at) }))
  } catch {
    return []
  }
}

function saveLog(entries: LogEntry[]): void {
  try {
    localStorage.setItem(
      LOG_STORAGE_KEY,
      JSON.stringify(entries.map((e) => ({ ...e, at: e.at.toISOString() })))
    )
  } catch {
    // ignore
  }
}

function loadPending(): PendingPurchase | null {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PendingPurchase) : null
  } catch {
    return null
  }
}

function savePending(p: PendingPurchase | null): void {
  try {
    if (p) localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(p))
    else localStorage.removeItem(PENDING_STORAGE_KEY)
  } catch {
    // ignore
  }
}

async function deriveAddressForIndex(
  wallet: WalletClient,
  index: number
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({
    protocolID: brc29ProtocolID,
    keyID: DERIVATION_PREFIX + ' ' + String(index),
    counterparty: 'anyone',
    forSelf: true
  })
  return PublicKey.fromString(publicKey).toAddress(NETWORK)
}

async function getNextIndex(wallet: WalletClient): Promise<number> {
  const response = await wallet.listActions({
    labels: [RAMP_LABEL],
    labelQueryMode: 'all',
    limit: 1
  })
  const total =
    typeof response.totalActions === 'number'
      ? response.totalActions
      : (response.actions?.length ?? 0)
  return total
}

async function fetchPurchase(
  apiUrl: string,
  id: string,
  viewToken: string
): Promise<RampInstantPurchase | null> {
  const url = `${apiUrl.replace(/\/+$/, '')}/purchase/${id}?secret=${encodeURIComponent(viewToken)}`
  const r = await fetch(url)
  if (!r.ok) return null
  return (await r.json()) as RampInstantPurchase
}

function App() {
  const [wallet, setWallet] = useState<WalletClient | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [derivationIndex, setDerivationIndex] = useState<number | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<LogEntry[]>(() => loadLog())
  const [logOpen, setLogOpen] = useState(false)
  const [showInstallModal, setShowInstallModal] = useState(false)
  const [pending, setPending] = useState<PendingPurchase | null>(() =>
    loadPending()
  )
  const [defaultCurrency] = useState<string>(() => detectDefaultCurrency())

  const widgetContainerRef = useRef<HTMLDivElement | null>(null)
  const rampInstanceRef = useRef<RampInstantSDK | null>(null)

  const appendLog = useCallback((entry: Omit<LogEntry, 'at'>) => {
    setLog((prev) => {
      const last = prev[0]
      if (last && last.text === entry.text && last.kind === entry.kind) {
        return prev
      }
      const next = [{ ...entry, at: new Date() }, ...prev].slice(0, 100)
      saveLog(next)
      return next
    })
  }, [])

  const clearLog = useCallback(() => {
    setLog([])
    saveLog([])
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
      const i = await getNextIndex(w)
      const addr = await deriveAddressForIndex(w, i)
      setWallet(w)
      setDerivationIndex(i)
      setAddress(addr)
      setStatus('ready')
      appendLog({ kind: 'info', text: `Derived address #${i}` })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (
        msg.includes('No wallet available over any communication substrate')
      ) {
        setShowInstallModal(true)
        setStatus('idle')
      } else {
        setError(msg)
        setStatus('error')
      }
    }
  }, [appendLog])

  const internalizePurchase = useCallback(
    async (
      txid: string,
      purchaseAddress: string,
      purchaseIndex: number
    ) => {
      if (!wallet) return
      setStatus('internalizing')
      appendLog({ kind: 'info', text: `Fetching BEEF for ${txid}` })
      const suffix = String(purchaseIndex)
      try {
        const resp = await fetch(
          `${WOC_BASE}/v1/bsv/${WOC_SEGMENT}/tx/${txid}/beef`
        )
        if (!resp.ok)
          throw new Error(`WoC BEEF fetch failed: ${resp.status}`)
        const beefHex = (await resp.text()).trim()
        const beef = new Beef()
        beef.mergeBeef(Utils.toArray(beefHex, 'hex'))

        const atomic = beef.findAtomicTransaction(txid)
        if (!atomic) throw new Error('Atomic transaction not found in BEEF')

        const targetScriptHex = new P2PKH().lock(purchaseAddress).toHex()
        const outputs: InternalizeOutput[] = atomic.outputs
          .map((out, idx) => ({ out, idx }))
          .filter(({ out }) => out.lockingScript.toHex() === targetScriptHex)
          .map(({ idx }) => ({
            outputIndex: idx,
            protocol: 'wallet payment' as const,
            paymentRemittance: {
              senderIdentityKey: new PrivateKey(1).toPublicKey().toString(),
              derivationPrefix: DERIVATION_PREFIX,
              derivationSuffix: suffix
            }
          }))

        if (outputs.length === 0)
          throw new Error(`No outputs paying ${purchaseAddress} found in tx`)

        const args: InternalizeActionArgs = {
          tx: atomic.toAtomicBEEF(),
          description: 'Ramp BSV Purchase',
          outputs,
          labels: [
            RAMP_LABEL,
            'inbound',
            purchaseAddress,
            `ramp-i:${suffix}`,
            `ts:${Math.floor(Date.now() / 1000)}`
          ]
        }
        const result = await wallet.internalizeAction(args)
        if (!result?.accepted)
          throw new Error('internalizeAction not accepted')

        appendLog({
          kind: 'success',
          text: `Imported ${txid} (${outputs.length} output${outputs.length > 1 ? 's' : ''})`
        })

        savePending(null)
        setPending(null)

        const nextI = await getNextIndex(wallet)
        const nextAddr = await deriveAddressForIndex(wallet, nextI)
        setDerivationIndex(nextI)
        setAddress(nextAddr)
        setStatus('imported')
        appendLog({ kind: 'info', text: `Rotated to address #${nextI}` })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        setStatus('error')
        appendLog({ kind: 'error', text: msg })
      }
    },
    [wallet, appendLog]
  )

  // Poll Ramp purchase API while a purchase is pending.
  useEffect(() => {
    if (!pending || !wallet) return
    let cancelled = false

    const poll = async () => {
      try {
        const purchase = await fetchPurchase(
          pending.apiUrl,
          pending.id,
          pending.viewToken
        )
        if (cancelled || !purchase) return

        if (purchase.finalTxHash) {
          appendLog({
            kind: 'success',
            text: `Ramp released txid ${purchase.finalTxHash}`
          })
          void internalizePurchase(
            purchase.finalTxHash,
            pending.address,
            pending.derivationIndex
          )
        } else if (purchase.status === 'EXPIRED' || purchase.status === 'CANCELLED') {
          appendLog({
            kind: 'error',
            text: `Purchase ${purchase.status.toLowerCase()}`
          })
          savePending(null)
          setPending(null)
          setStatus('ready')
        }
      } catch {
        // transient failure — keep polling
      }
    }

    setStatus(
      pending.address && pending.id ? 'awaiting-release' : 'awaiting-purchase'
    )
    void poll()
    const id = window.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [pending, wallet, appendLog, internalizePurchase])

  // Mount Ramp widget inline whenever wallet+address ready and no
  // pending purchase is awaiting release.
  useEffect(() => {
    if (!address || !widgetContainerRef.current) return
    if (pending) return

    const apiKey = import.meta.env.VITE_RAMP_API_KEY
    if (!apiKey) {
      console.warn(
        '[ramp-brc100] VITE_RAMP_API_KEY is not set — Ramp widget will not mount. Set it in .env to enable purchases.'
      )
      return
    }

    const container = widgetContainerRef.current
    const ramp = new RampInstantSDK({
      hostAppName: 'Buy BSV',
      hostLogoUrl: 'https://desktop.bsvb.tech/icon.png',
      hostApiKey: apiKey,
      swapAsset: SWAP_ASSET,
      defaultAsset: SWAP_ASSET,
      userAddress: address,
      fiatCurrency: defaultCurrency,
      variant: detectVariant(),
      containerNode: container
    })

    rampInstanceRef.current = ramp

    ramp.on(RampInstantEventTypes.PURCHASE_CREATED, (event) => {
      const payload = event.payload as {
        purchase: RampInstantPurchase
        purchaseViewToken: string
        apiUrl: string
      }
      const p: PendingPurchase = {
        id: payload.purchase.id,
        apiUrl: payload.apiUrl,
        viewToken: payload.purchaseViewToken,
        address,
        derivationIndex: derivationIndex ?? 0,
        fiatValue: payload.purchase.fiatValue,
        fiatCurrency: payload.purchase.fiatCurrency,
        createdAt: payload.purchase.createdAt
      }
      savePending(p)
      setPending(p)
      appendLog({
        kind: 'info',
        text: `Purchase ${p.id} created (${p.fiatValue} ${p.fiatCurrency})`
      })
    })

    ramp.on(RampInstantEventTypes.WIDGET_CLOSE, () => {
      setStatus((s) => (s === 'awaiting-purchase' ? 'ready' : s))
    })

    ramp.show()
    setStatus('awaiting-purchase')

    return () => {
      try {
        ramp.close()
      } catch {
        // ignore teardown errors
      }
      rampInstanceRef.current = null
      container.innerHTML = ''
    }
  }, [address, defaultCurrency, derivationIndex, pending, appendLog])

  useEffect(() => {
    void connect()
  }, [connect])

  // Auto-retry connection on error (but not when install modal is up —
  // user needs to install a wallet first).
  useEffect(() => {
    if (status !== 'error' || showInstallModal) return
    const id = window.setTimeout(() => void connect(), 3000)
    return () => window.clearTimeout(id)
  }, [status, showInstallModal, connect])

  const isConnected = !!wallet && !!address
  const connectionLabel =
    status === 'connecting'
      ? 'Connecting…'
      : isConnected
        ? 'Wallet connected'
        : 'Wallet not connected'

  return (
    <main className="container">
      <section className="hero">
        <span className={`conn-pill ${isConnected ? 'conn-on' : 'conn-off'}`}>
          <span className="conn-dot" /> {connectionLabel}
        </span>
        <h1 className="hero-title">Buy BSV</h1>
        <p className="hero-sub">Receive direct instant payments.</p>
        <p className="hero-blurb">
          Pay with card or bank, get BSV delivered straight to your wallet.
          No copy-paste addresses — your wallet address rotates per purchase
          and funds are imported automatically on release.
        </p>
      </section>

      {error && (
        <section className="card">
          <div className="error">{error}</div>
        </section>
      )}

      {pending && (
        <section className="card pending">
          <h2>Awaiting release</h2>
          <p className="muted">
            Purchase {pending.id.slice(0, 8)}… ({pending.fiatValue}{' '}
            {pending.fiatCurrency}) — waiting for Ramp to broadcast the
            transaction. Polling every {Math.round(POLL_INTERVAL_MS / 1000)}s.
          </p>
        </section>
      )}

      <section className="widget-wrapper">
        <div ref={widgetContainerRef} className="widget-host" />
        {!address && (
          <div className="widget-placeholder">
            <p className="muted">Connecting to your wallet…</p>
          </div>
        )}
      </section>

      <details
        className="activity"
        open={logOpen}
        onToggle={(e) => setLogOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          <span>Activity</span>
          <span className="activity-count">{log.length}</span>
        </summary>
        {log.length === 0 ? (
          <p className="muted activity-empty">Nothing yet.</p>
        ) : (
          <>
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
            <button
              type="button"
              className="ghost activity-clear"
              onClick={clearLog}
            >
              Clear
            </button>
          </>
        )}
      </details>

      {showInstallModal && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-modal-title"
          onClick={() => setShowInstallModal(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 id="install-modal-title">Install BSV Desktop</h2>
            <p className="muted">
              No BSV wallet detected. Install BSV Desktop to derive an
              address and import your Ramp purchase automatically.
            </p>
            <div className="modal-actions">
              <a
                className="primary"
                href="https://desktop.bsvb.tech"
                target="_blank"
                rel="noreferrer noopener"
              >
                Download BSV Desktop
              </a>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setShowInstallModal(false)
                  void connect()
                }}
              >
                Retry connection
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setShowInstallModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
