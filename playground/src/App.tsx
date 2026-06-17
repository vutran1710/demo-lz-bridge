import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeEventLog, hexToString, isHex, stringToHex, pad, type Hex } from 'viem'
import './styles.css'
import type { Deployment, ChainCfg } from './types'
import { publicFor, walletFor } from './viem'
import { userAppAbi, sendLibAbi, receiveLibAbi } from './abi'
import { decodePacket } from './codec'

type Flight = {
  id: string
  walletLabel: string
  src: string
  dst: string
  guid: Hex
  payloadHash: Hex
  headerHash: Hex
  nonce: bigint
  srcEid: number
  committed: boolean
  delivered: boolean
}

type RecvMsg = { srcEid: number; nonce: string; sender: Hex; message: Hex }

export default function App() {
  const [dep, setDep] = useState<Deployment | null>(null)
  const [walletIdx, setWalletIdx] = useState(0)
  const [src, setSrc] = useState('a')
  const [dst, setDst] = useState('b')
  const [payload, setPayload] = useState('hello omnichain')
  const [mode, setMode] = useState<'utf8' | 'hex'>('utf8')
  const [flights, setFlights] = useState<Flight[]>([])
  const [recv, setRecv] = useState<Record<string, RecvMsg[]>>({})
  const [err, setErr] = useState('')
  const flightsRef = useRef<Flight[]>([])
  flightsRef.current = flights

  useEffect(() => {
    fetch('/deployment.json').then((r) => r.json()).then((d: Deployment) => {
      setDep(d)
      if (d.chains[1]) setDst(d.chains[1].key)
    })
  }, [])

  const chainByKey = useMemo(() => {
    const m: Record<string, ChainCfg> = {}
    dep?.chains.forEach((c) => (m[c.key] = c))
    return m
  }, [dep])

  async function send() {
    setErr('')
    if (!dep) return
    if (src === dst) return setErr('source and destination must differ')
    const wallet = dep.wallets[walletIdx]
    const srcChain = chainByKey[src]
    const dstChain = chainByKey[dst]
    const payloadHex: Hex = mode === 'hex' ? (isHex(payload) ? (payload as Hex) : (('0x' + payload) as Hex)) : stringToHex(payload)
    if (mode === 'hex' && !isHex(payloadHex)) return setErr('invalid hex payload')
    const srcApp = wallet.apps[String(srcChain.eid)]
    try {
      const wc = walletFor(srcChain, wallet.key)
      const pub = publicFor(srcChain)
      const hash = await wc.writeContract({ address: srcApp, abi: userAppAbi, functionName: 'sendMessage', args: [dstChain.eid, payloadHex], account: wc.account!, chain: wc.chain })
      const rcpt = await pub.waitForTransactionReceipt({ hash })
      // find PacketSent, decode
      let flight: Flight | null = null
      for (const log of rcpt.logs) {
        try {
          const ev = decodeEventLog({ abi: sendLibAbi, data: log.data, topics: log.topics })
          if (ev.eventName === 'PacketSent') {
            const p = decodePacket((ev.args as any).encodedPacket as Hex)
            flight = {
              id: p.guid, walletLabel: wallet.label, src, dst, guid: p.guid, payloadHash: p.payloadHash,
              headerHash: p.headerHash, nonce: p.nonce, srcEid: srcChain.eid, committed: false, delivered: false,
            }
          }
        } catch {
          // not a PacketSent log
        }
      }
      if (flight) setFlights((f) => [flight!, ...f].slice(0, 8))
    } catch (e: any) {
      setErr(e?.shortMessage || e?.message || String(e))
    }
  }

  // Poll: receiver grid + in-flight pipeline
  useEffect(() => {
    if (!dep) return
    let alive = true
    const tick = async () => {
      const nextRecv: Record<string, RecvMsg[]> = {}
      for (let wi = 0; wi < dep.wallets.length; wi++) {
        for (const chain of dep.chains) {
          const app = dep.wallets[wi].apps[String(chain.eid)]
          try {
            const logs = await publicFor(chain).getContractEvents({ address: app, abi: userAppAbi, eventName: 'Received', fromBlock: 0n, toBlock: 'latest' })
            nextRecv[`${wi}:${chain.key}`] = logs.map((l: any) => ({ srcEid: Number(l.args.srcEid), nonce: String(l.args.nonce), sender: l.args.sender as Hex, message: l.args.message as Hex }))
          } catch {
            // chain not ready
          }
        }
      }
      if (alive) setRecv(nextRecv)

      // pipeline
      const fl = flightsRef.current
      if (fl.some((f) => !f.delivered)) {
        const updated = await Promise.all(fl.map(async (f) => {
          if (f.delivered) return f
          const dstChain = chainByKey[f.dst]
          const pub = publicFor(dstChain)
          let committed = f.committed
          try {
            committed = (await pub.readContract({ address: dstChain.receiveLib, abi: receiveLibAbi, functionName: 'committed', args: [f.headerHash, f.payloadHash] })) as boolean
          } catch {}
          // delivered = a Received event with matching srcEid+nonce on the dst wallet app
          const key = `${walletIdxOf(dep, f.walletLabel)}:${f.dst}`
          const delivered = (nextRecv[key] || []).some((m) => m.srcEid === f.srcEid && m.nonce === String(f.nonce))
          return { ...f, committed: committed || f.committed, delivered }
        }))
        if (alive) setFlights(updated)
      }
    }
    const id = setInterval(tick, 1500)
    tick()
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [dep, chainByKey])

  if (!dep) return <div className="app"><h1>Loading deployment…</h1><div className="sub">Run <code>pnpm playground</code> first.</div></div>

  return (
    <div className="app">
      <h1>OneMatrix Bridge — Playground</h1>
      <div className="sub">3 chains · 3 wallets · real DVN (2-of-3) + Executor · arbitrary cross-chain data</div>
      <div className="warn">⚠ Local anvil test wallets, private keys embedded, exposed via public tunnel. No real funds.</div>

      <div className="panel">
        <h2>Send</h2>
        <div className="row">
          <div className="field">
            <label>Wallet</label>
            <select value={walletIdx} onChange={(e) => setWalletIdx(Number(e.target.value))}>
              {dep.wallets.map((w, i) => <option key={i} value={i}>{w.label} · {w.address.slice(0, 8)}…</option>)}
            </select>
          </div>
          <div className="field">
            <label>Source chain</label>
            <select value={src} onChange={(e) => setSrc(e.target.value)}>
              {dep.chains.map((c) => <option key={c.key} value={c.key}>{c.key.toUpperCase()} (eid {c.eid})</option>)}
            </select>
          </div>
          <div className="field">
            <label>Dest chain</label>
            <select value={dst} onChange={(e) => setDst(e.target.value)}>
              {dep.chains.map((c) => <option key={c.key} value={c.key}>{c.key.toUpperCase()} (eid {c.eid})</option>)}
            </select>
          </div>
          <div className="field">
            <label>Payload type</label>
            <div className="toggle">
              <button className={mode === 'utf8' ? 'on' : ''} onClick={() => setMode('utf8')}>utf8</button>
              <button className={mode === 'hex' ? 'on' : ''} onClick={() => setMode('hex')}>hex</button>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label>Payload</label>
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={mode === 'hex' ? '0x…' : 'type a message'} />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={send} disabled={src === dst}>Commit &amp; transfer →</button>
          {err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{err}</span>}
        </div>

        {flights.map((f) => (
          <div className="flight" key={f.id}>
            <div><b>{f.walletLabel}</b> {f.src.toUpperCase()} → {f.dst.toUpperCase()} · nonce {String(f.nonce)}</div>
            <div className="mono">guid {f.guid.slice(0, 18)}…</div>
            <div className="stages">
              <span className="stage done">Sent</span>
              <span className={`stage ${f.committed ? 'done' : ''}`}>Verified &amp; Committed</span>
              <span className={`stage ${f.delivered ? 'done' : ''}`}>Delivered</span>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Receivers — wallet × chain</h2>
        {dep.wallets.map((w, wi) => (
          <div key={wi} style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 6 }}><span className="pill">{w.label}</span></div>
            <div className="grid3">
              {dep.chains.map((c) => {
                const msgs = recv[`${wi}:${c.key}`] || []
                return (
                  <div className="cell" key={c.key}>
                    <h3>{c.key.toUpperCase()} (eid {c.eid})</h3>
                    {msgs.length === 0 && <div className="empty">no messages</div>}
                    {msgs.slice().reverse().slice(0, 5).map((m, i) => (
                      <div className="msg" key={i}>
                        <div>{tryUtf8(m.message)}</div>
                        <div className="meta">from eid {m.srcEid} · nonce {m.nonce}</div>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function walletIdxOf(dep: Deployment, label: string): number {
  return dep.wallets.findIndex((w) => w.label === label)
}
function tryUtf8(hex: Hex): string {
  try {
    const s = hexToString(hex)
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s)) return s || '(empty)'
  } catch {}
  return hex
}
// keep pad import referenced (used implicitly by viem types in some builds)
void pad
