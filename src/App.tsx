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
import { OnrampWebSDK } from '@onramp.money/onramp-web-sdk'
import './App.css'

const brc29ProtocolID: WalletProtocol = [2, '3241645161d8']
const NETWORK: 'mainnet' | 'testnet' = 'mainnet'
const WOC_BASE = 'https://api.whatsonchain.com'
const WOC_SEGMENT = NETWORK === 'mainnet' ? 'main' : 'test'
const ONRAMP_LABEL = 'onramp.bsvblockchain.tech'
const DERIVATION_PREFIX = 'onramp'
// From Onramp Money's public config: coin 66 "Bitcoin SV" on network 10535,
// whose chainSymbol is "bsv".
// https://api.onramp.money/onramp/api/v2/buy/public/allConfig
const COIN_CODE = 'bsv'
const COIN_NETWORK = 'bsv'
const FLOW_TYPE_BUY = 1
const WIDGET_CONTAINER_ID = 'onramp-widget'
const LOG_STORAGE_KEY = 'onramp-brc100:activity'
const IMPORTED_STORAGE_KEY = 'onramp-brc100:imported'
const POLL_INTERVAL_MS = 8000

type Status =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'watching'
  | 'detected'
  | 'internalizing'
  | 'imported'
  | 'error'

type LogEntry = { kind: 'info' | 'success' | 'error'; text: string; at: Date }

type AddressUtxo = { txid: string; confirmed: boolean }

// The SDK types every event payload as `object`, so treat the contents as
// unknown and only read fields defensively.
type OnrampEvent = { type: string; data: unknown; isOnramp: boolean }

// ONRAMP_WIDGET_TX_SENDING -> "sending"
function describeTxEvent(type: string): string {
  return type.replace(/^ONRAMP_WIDGET_TX_/, '').toLowerCase().replace(/_/g, ' ')
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

function loadImported(): string[] {
  try {
    const raw = localStorage.getItem(IMPORTED_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function saveImported(txids: string[]): void {
  try {
    localStorage.setItem(
      IMPORTED_STORAGE_KEY,
      JSON.stringify(txids.slice(-200))
    )
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
    labels: [ONRAMP_LABEL],
    labelQueryMode: 'all',
    limit: 1
  })
  const total =
    typeof response.totalActions === 'number'
      ? response.totalActions
      : (response.actions?.length ?? 0)
  return total
}

// The widget's transaction events carry no documented payload schema, so
// delivery is confirmed on-chain rather than taken from the provider: the
// derived address is watched for unspent outputs. The split
// confirmed/unconfirmed endpoints 404 on an address with no history — which
// is the steady state here — so the combined one is used instead. Mempool
// entries come back with height 0.
async function fetchAddressUtxos(address: string): Promise<AddressUtxo[]> {
  const resp = await fetch(
    `${WOC_BASE}/v1/bsv/${WOC_SEGMENT}/address/${address}/unspent`
  )
  if (!resp.ok) throw new Error(`WoC unspent fetch failed: ${resp.status}`)
  const utxos = (await resp.json()) as Array<{
    tx_hash: string
    height?: number
  }>

  const found = new Map<string, boolean>()
  for (const utxo of utxos) {
    const isConfirmed = (utxo.height ?? 0) > 0
    found.set(utxo.tx_hash, (found.get(utxo.tx_hash) ?? false) || isConfirmed)
  }
  return [...found].map(([txid, confirmed]) => ({ txid, confirmed }))
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

  const importedRef = useRef<string[]>(loadImported())
  const importingRef = useRef(false)

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

  const rotate = useCallback(
    async (w: WalletClient) => {
      const nextI = await getNextIndex(w)
      const nextAddr = await deriveAddressForIndex(w, nextI)
      setDerivationIndex(nextI)
      setAddress(nextAddr)
      appendLog({ kind: 'info', text: `Rotated to address #${nextI}` })
    },
    [appendLog]
  )

  // Fetch the BEEF for a delivered transaction and internalize every output
  // paying the derived address. Throws on failure; the caller keeps polling,
  // because a freshly broadcast transaction has no merkle proof yet.
  const internalizeDelivery = useCallback(
    async (txid: string, deliveryAddress: string, deliveryIndex: number) => {
      if (!wallet) throw new Error('wallet not connected')
      setStatus('internalizing')
      appendLog({ kind: 'info', text: `Fetching BEEF for ${txid}` })
      const suffix = String(deliveryIndex)

      const resp = await fetch(
        `${WOC_BASE}/v1/bsv/${WOC_SEGMENT}/tx/${txid}/beef`
      )
      if (!resp.ok) throw new Error(`WoC BEEF fetch failed: ${resp.status}`)
      const beefHex = (await resp.text()).trim()
      const beef = new Beef()
      beef.mergeBeef(Utils.toArray(beefHex, 'hex'))

      const atomic = beef.findAtomicTransaction(txid)
      if (!atomic) throw new Error('Atomic transaction not found in BEEF')

      const targetScriptHex = new P2PKH().lock(deliveryAddress).toHex()
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
        throw new Error(`No outputs paying ${deliveryAddress} found in tx`)

      const args: InternalizeActionArgs = {
        tx: atomic.toAtomicBEEF(),
        description: 'Onramp BSV Purchase',
        outputs,
        labels: [
          ONRAMP_LABEL,
          'inbound',
          deliveryAddress,
          `onramp-i:${suffix}`,
          `ts:${Math.floor(Date.now() / 1000)}`
        ]
      }
      const result = await wallet.internalizeAction(args)
      if (!result?.accepted) throw new Error('internalizeAction not accepted')

      appendLog({
        kind: 'success',
        text: `Imported ${txid} (${outputs.length} output${outputs.length > 1 ? 's' : ''})`
      })

      importedRef.current = [...importedRef.current, txid]
      saveImported(importedRef.current)
    },
    [wallet, appendLog]
  )

  // Watch the current derived address for an inbound delivery.
  useEffect(() => {
    if (!wallet || !address || derivationIndex === null) return
    let cancelled = false
    const announced = new Set<string>()

    const poll = async () => {
      if (cancelled || importingRef.current) return
      let utxos: AddressUtxo[]
      try {
        utxos = await fetchAddressUtxos(address)
      } catch {
        return // transient network failure — keep polling
      }
      if (cancelled || utxos.length === 0) return

      const fresh = utxos.filter((u) => !importedRef.current.includes(u.txid))
      if (fresh.length === 0) {
        // Everything here is already in the wallet — the address was left
        // behind by an interrupted rotation. Advance past it.
        importingRef.current = true
        try {
          await rotate(wallet)
        } catch {
          // retry on the next tick
        } finally {
          importingRef.current = false
        }
        return
      }

      for (const utxo of fresh) {
        if (announced.has(utxo.txid)) continue
        announced.add(utxo.txid)
        appendLog({
          kind: 'info',
          text: `Detected ${utxo.confirmed ? 'confirmed' : 'unconfirmed'} payment ${utxo.txid}`
        })
      }
      setStatus('detected')

      // Import every delivery sitting at this address before rotating —
      // nothing brings the watcher back here once the address advances, so a
      // second purchase made before the first one landed would be stranded.
      // Confirmed first: unconfirmed transactions have no merkle proof yet
      // and will just throw.
      const ordered = [
        ...fresh.filter((u) => u.confirmed),
        ...fresh.filter((u) => !u.confirmed)
      ]
      importingRef.current = true
      let allImported = true
      try {
        for (const utxo of ordered) {
          if (cancelled) return
          try {
            await internalizeDelivery(utxo.txid, address, derivationIndex)
          } catch (e: unknown) {
            // Most failures here are "not confirmed yet". Log and retry on a
            // later tick; hold the address until everything has landed.
            allImported = false
            const msg = e instanceof Error ? e.message : String(e)
            appendLog({ kind: 'error', text: `Import pending: ${msg}` })
          }
        }
        if (cancelled) return
        if (allImported) {
          setStatus('imported')
          await rotate(wallet)
        } else {
          setStatus('detected')
        }
      } catch {
        // rotation failed — retry on the next tick
      } finally {
        importingRef.current = false
      }
    }

    void poll()
    const id = window.setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [
    wallet,
    address,
    derivationIndex,
    appendLog,
    internalizeDelivery,
    rotate
  ])

  // Mount the Onramp Money widget for the current address. Remounted on
  // rotation so the new address is pre-filled.
  useEffect(() => {
    if (!address) return

    const rawAppId = import.meta.env.VITE_ONRAMP_APP_ID
    const appId = Number(rawAppId)
    if (!rawAppId || !Number.isFinite(appId)) {
      console.warn(
        '[onramp-brc100] VITE_ONRAMP_APP_ID is not set to a number — the Onramp Money widget will not mount. Set it in .env to enable purchases.'
      )
      return
    }

    const sdk = new OnrampWebSDK({
      appId,
      walletAddress: address,
      coinCode: COIN_CODE,
      network: COIN_NETWORK,
      flowType: FLOW_TYPE_BUY,
      containerId: `#${WIDGET_CONTAINER_ID}`,
      sandbox: import.meta.env.VITE_ONRAMP_SANDBOX === 'true',
      theme: {
        default: 'lightMode',
        lightMode: {
          baseColor: '#16a34a',
          inputRadius: '10px',
          buttonRadius: '10px'
        }
      }
    })

    // Status only — the payload schema is undocumented, so nothing here is
    // trusted for accounting. The chain watcher above decides what is real.
    sdk.on('TX_EVENTS', (event: OnrampEvent) => {
      appendLog({
        kind: 'info',
        text: `Onramp: ${describeTxEvent(event.type)}`
      })
    })

    sdk.on('WIDGET_EVENTS', (event: OnrampEvent) => {
      if (event.type === 'ONRAMP_WIDGET_FAILED') {
        appendLog({ kind: 'error', text: 'Onramp widget failed to load' })
      }
    })

    void sdk.show().then(() => {
      setStatus((s) => (s === 'ready' || s === 'imported' ? 'watching' : s))
    })

    return () => {
      try {
        sdk.close()
      } catch {
        // ignore teardown errors
      }
    }
  }, [address, appendLog])

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
  const isDelivering = status === 'detected' || status === 'internalizing'

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
          and funds are imported automatically on delivery.
        </p>
      </section>

      {error && (
        <section className="card">
          <div className="error">{error}</div>
        </section>
      )}

      {isDelivering && (
        <section className="card pending">
          <h2>
            {status === 'internalizing' ? 'Importing' : 'Payment detected'}
          </h2>
          <p className="muted">
            {status === 'internalizing'
              ? 'Fetching proof and importing the outputs into your wallet.'
              : 'Waiting for the transaction to confirm so it can be imported. ' +
                `Checking every ${Math.round(POLL_INTERVAL_MS / 1000)}s.`}
          </p>
        </section>
      )}

      <section className="widget-wrapper">
        <div id={WIDGET_CONTAINER_ID} className="widget-host" />
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
              address and import your purchase automatically.
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
