import { useEffect, useMemo, useState } from 'react'
import { getAddress, hexToString, isHex, stringToHex, type Hex } from 'viem'
import './styles.css'
import type { ChainCfg, Deployment, WorkerActivity, WorkerStatus } from './types'
import { publicFor, walletFor } from './viem'
import { endpointAbi, sendLibAbi, userAppAbi } from './abi'
import { decodePacket } from './codec'
import { System } from './System'

type PendingSend = {
  id: string
  txHash: Hex
  submittedAt: number
  walletLabel: string
  walletAddress: Hex
  src: string
  dst: string
  payload: Hex
}

type Transfer = {
  id: string
  walletLabel: string
  walletAddress?: Hex
  sourceWalletApp: Hex
  destinationWalletApp: Hex
  guid: Hex
  payloadHash: Hex
  headerHash: Hex
  message: Hex
  sender: Hex
  nonce: bigint
  src: string
  dst: string
  srcEid: number
  dstEid: number
  sendTxHash: Hex
  sendTimestamp: number
  verifiedTxHash?: Hex
  verifiedTimestamp?: number
  deliveredTxHash?: Hex
  deliveredTimestamp?: number
  receivedTxHash?: Hex
  receivedTimestamp?: number
  committed: boolean
  delivered: boolean
  received: boolean
}

type ActivityLine = {
  id: string
  pending: boolean
  timestamp?: number
  title: string
  detail: string
}

type PacketSentLog = {
  args: { encodedPacket: Hex }
  blockNumber: bigint
  transactionHash: Hex
}

type PacketVerifiedLog = {
  args: {
    origin: { srcEid: number; sender: Hex; nonce: bigint }
    receiver: Hex
    payloadHash: Hex
  }
  blockNumber: bigint
  transactionHash: Hex
}

type PacketDeliveredLog = {
  args: {
    origin: { srcEid: number; sender: Hex; nonce: bigint }
    receiver: Hex
  }
  blockNumber: bigint
  transactionHash: Hex
}

type ReceivedLog = {
  args: { srcEid: number; nonce: bigint; sender: Hex; message: Hex }
  blockNumber: bigint
  transactionHash: Hex
}

type RecvMsg = { srcEid: number; nonce: string; sender: Hex; message: Hex }

type AppRef = {
  walletLabel: string
  walletAddress: Hex
  app: Hex
}

const LOG_CUTOFF_STORAGE_KEY = 'playground-log-cutoff'

export default function App() {
  const [dep, setDep] = useState<Deployment | null>(null)
  const [walletIdx, setWalletIdx] = useState(0)
  const [src, setSrc] = useState('a')
  const [dst, setDst] = useState('b')
  const [payload, setPayload] = useState('hello omnichain')
  const [mode, setMode] = useState<'utf8' | 'hex'>('utf8')
  const [logCutoff, setLogCutoff] = useState<number>(() => readStoredLogCutoff())
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([])
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [workerEvents, setWorkerEvents] = useState<WorkerActivity[]>([])
  const [recv, setRecv] = useState<Record<string, RecvMsg[]>>({})
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/deployment.json')
      .then((r) => r.json())
      .then((d: Deployment) => {
        setDep(d)
        if (d.chains[1]) setDst(d.chains[1].key)
      })
  }, [])

  const chainByKey = useMemo(() => {
    const m: Record<string, ChainCfg> = {}
    dep?.chains.forEach((c) => { m[c.key] = c })
    return m
  }, [dep])

  const chainByEid = useMemo(() => {
    const m = new Map<number, ChainCfg>()
    dep?.chains.forEach((c) => m.set(c.eid, c))
    return m
  }, [dep])

  const appsByChainAndAddress = useMemo(() => {
    const m = new Map<string, AppRef>()
    dep?.wallets.forEach((wallet) => {
      dep.chains.forEach((chain) => {
        const app = wallet.apps[String(chain.eid)]
        m.set(appRefKey(chain.key, app), { walletLabel: wallet.label, walletAddress: wallet.address, app })
      })
    })
    return m
  }, [dep])

  async function send() {
    setErr('')
    if (!dep) return
    if (src === dst) return setErr('source and destination must differ')

    const wallet = dep.wallets[walletIdx]
    const srcChain = chainByKey[src]
    const dstChain = chainByKey[dst]
    const payloadHex: Hex = mode === 'hex'
      ? (isHex(payload) ? payload as Hex : (`0x${payload}` as Hex))
      : stringToHex(payload)
    if (mode === 'hex' && !isHex(payloadHex)) return setErr('invalid hex payload')

    try {
      const wc = walletFor(srcChain, wallet.key)
      const hash = await wc.writeContract({
        address: wallet.apps[String(srcChain.eid)],
        abi: userAppAbi,
        functionName: 'sendMessage',
        args: [dstChain.eid, payloadHex],
        account: wc.account!,
        chain: wc.chain,
      })

      setPendingSends((items) => [
        {
          id: String(hash),
          txHash: hash,
          submittedAt: Math.floor(Date.now() / 1000),
          walletLabel: wallet.label,
          walletAddress: wallet.address,
          src,
          dst,
          payload: payloadHex,
        },
        ...items.filter((item) => item.txHash !== hash),
      ].slice(0, 24))
    } catch (e: any) {
      setErr(e?.shortMessage || e?.message || String(e))
    }
  }

  function clearLogs() {
    const cutoff = Math.floor(Date.now() / 1000)
    setLogCutoff(cutoff)
    storeLogCutoff(cutoff)
    setPendingSends([])
    setTransfers([])
    setWorkerEvents([])
    setRecv({})
  }

  useEffect(() => {
    if (!dep) return
    let alive = true

    const tick = async () => {
      const workerStatuses = await Promise.all((dep.workers || []).map(async (worker) => {
        try {
          const res = await fetch(worker.status, { cache: 'no-store' })
          return await res.json() as WorkerStatus
        } catch {
          return { id: worker.id, role: worker.role, online: false, processed: 0, pathways: 0, events: [] } as WorkerStatus
        }
      }))
      const nextWorkerEvents = workerStatuses
        .flatMap((worker) => worker.events || [])
        .filter((event) => passesLogCutoff(event.timestamp, logCutoff))
        .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq)

      const chainEvents = await Promise.all(dep.chains.map(async (chain) => {
        const pub = publicFor(chain)
        try {
          const [sent, verified, delivered] = await Promise.all([
            pub.getContractEvents({ address: chain.sendLib, abi: sendLibAbi, eventName: 'PacketSent', fromBlock: 0n, toBlock: 'latest' }),
            pub.getContractEvents({ address: chain.endpoint, abi: endpointAbi, eventName: 'PacketVerified', fromBlock: 0n, toBlock: 'latest' }),
            pub.getContractEvents({ address: chain.endpoint, abi: endpointAbi, eventName: 'PacketDelivered', fromBlock: 0n, toBlock: 'latest' }),
          ])
          return {
            chain,
            sent: sent as unknown as PacketSentLog[],
            verified: verified as unknown as PacketVerifiedLog[],
            delivered: delivered as unknown as PacketDeliveredLog[],
          }
        } catch {
          return { chain, sent: [] as PacketSentLog[], verified: [] as PacketVerifiedLog[], delivered: [] as PacketDeliveredLog[] }
        }
      }))

      const recvEntries = await Promise.all(dep.wallets.flatMap((wallet, wi) => dep.chains.map(async (chain) => {
        const app = wallet.apps[String(chain.eid)]
        try {
          const logs = await publicFor(chain).getContractEvents({ address: app, abi: userAppAbi, eventName: 'Received', fromBlock: 0n, toBlock: 'latest' })
          return { key: `${wi}:${chain.key}`, app, chain, logs: logs as unknown as ReceivedLog[] }
        } catch {
          return { key: `${wi}:${chain.key}`, app, chain, logs: [] as ReceivedLog[] }
        }
      })))

      const blocksByChain = new Map<string, Set<bigint>>()
      const rememberBlock = (chainKey: string, blockNumber: bigint) => {
        if (!blocksByChain.has(chainKey)) blocksByChain.set(chainKey, new Set())
        blocksByChain.get(chainKey)!.add(blockNumber)
      }

      chainEvents.forEach((entry) => {
        entry.sent.forEach((log) => rememberBlock(entry.chain.key, log.blockNumber))
        entry.verified.forEach((log) => rememberBlock(entry.chain.key, log.blockNumber))
        entry.delivered.forEach((log) => rememberBlock(entry.chain.key, log.blockNumber))
      })
      recvEntries.forEach((entry) => entry.logs.forEach((log) => rememberBlock(entry.chain.key, log.blockNumber)))

      const blockTimestamps = new Map<string, number>()
      await Promise.all(dep.chains.map(async (chain) => {
        const blocks = Array.from(blocksByChain.get(chain.key) || [])
        await Promise.all(blocks.map(async (blockNumber) => {
          try {
            const block = await publicFor(chain).getBlock({ blockNumber })
            blockTimestamps.set(blockTsKey(chain.key, blockNumber), Number(block.timestamp))
          } catch {
            blockTimestamps.set(blockTsKey(chain.key, blockNumber), 0)
          }
        }))
      }))

      const verifiedByKey = new Map<string, { txHash: Hex; timestamp: number }>()
      const deliveredByKey = new Map<string, { txHash: Hex; timestamp: number }>()
      const receivedByKey = new Map<string, { txHash: Hex; timestamp: number }>()

      chainEvents.forEach((entry) => {
        entry.verified.forEach((log) => {
          const origin = log.args.origin
          verifiedByKey.set(
            verificationKey(origin.srcEid, origin.sender, log.args.receiver, origin.nonce, log.args.payloadHash),
            { txHash: log.transactionHash, timestamp: blockTimestamps.get(blockTsKey(entry.chain.key, log.blockNumber)) || 0 },
          )
        })
        entry.delivered.forEach((log) => {
          const origin = log.args.origin
          deliveredByKey.set(
            requestKey(origin.srcEid, origin.sender, log.args.receiver, origin.nonce),
            { txHash: log.transactionHash, timestamp: blockTimestamps.get(blockTsKey(entry.chain.key, log.blockNumber)) || 0 },
          )
        })
      })

      const nextRecv: Record<string, RecvMsg[]> = {}
      recvEntries.forEach((entry) => {
        const visibleLogs = entry.logs.filter((log) => passesLogCutoff(blockTimestamps.get(blockTsKey(entry.chain.key, log.blockNumber)) || 0, logCutoff))
        nextRecv[entry.key] = visibleLogs.map((log) => ({
          srcEid: Number(log.args.srcEid),
          nonce: String(log.args.nonce),
          sender: log.args.sender,
          message: log.args.message,
        }))
        visibleLogs.forEach((log) => {
          receivedByKey.set(
            requestKey(Number(log.args.srcEid), log.args.sender, entry.app, log.args.nonce),
            { txHash: log.transactionHash, timestamp: blockTimestamps.get(blockTsKey(entry.chain.key, log.blockNumber)) || 0 },
          )
        })
      })

      const nextTransfers: Transfer[] = []
      chainEvents.forEach((entry) => {
        entry.sent.forEach((log) => {
          const packet = decodePacket(log.args.encodedPacket)
          const dstChain = chainByEid.get(packet.dstEid)
          if (!dstChain) return
          const sendTimestamp = blockTimestamps.get(blockTsKey(entry.chain.key, log.blockNumber)) || 0
          if (!passesLogCutoff(sendTimestamp, logCutoff)) return

          const srcWalletApp = bytes32ToAddress(packet.sender)
          const dstWalletApp = bytes32ToAddress(packet.receiver)
          const appRef = appsByChainAndAddress.get(appRefKey(entry.chain.key, srcWalletApp))
          const verified = verifiedByKey.get(verificationKey(packet.srcEid, packet.sender, dstWalletApp, packet.nonce, packet.payloadHash))
          const delivered = deliveredByKey.get(requestKey(packet.srcEid, packet.sender, dstWalletApp, packet.nonce))
          const received = receivedByKey.get(requestKey(packet.srcEid, packet.sender, dstWalletApp, packet.nonce))

          nextTransfers.push({
            id: packet.guid,
            walletLabel: appRef?.walletLabel || shortHex(srcWalletApp),
            walletAddress: appRef?.walletAddress,
            sourceWalletApp: srcWalletApp,
            destinationWalletApp: dstWalletApp,
            guid: packet.guid,
            payloadHash: packet.payloadHash,
            headerHash: packet.headerHash,
            message: packet.message,
            sender: packet.sender,
            nonce: packet.nonce,
            src: entry.chain.key,
            dst: dstChain.key,
            srcEid: packet.srcEid,
            dstEid: packet.dstEid,
            sendTxHash: log.transactionHash,
            sendTimestamp,
            verifiedTxHash: verified?.txHash,
            verifiedTimestamp: verified?.timestamp,
            deliveredTxHash: delivered?.txHash,
            deliveredTimestamp: delivered?.timestamp,
            receivedTxHash: received?.txHash,
            receivedTimestamp: received?.timestamp,
            committed: !!verified,
            delivered: !!delivered,
            received: !!received,
          })
        })
      })

      nextTransfers.sort((a, b) => b.sendTimestamp - a.sendTimestamp || Number(b.nonce - a.nonce))

      if (!alive) return
      setWorkerEvents(nextWorkerEvents)
      setRecv(nextRecv)
      setTransfers(nextTransfers)
      setPendingSends((items) => items.filter((item) => passesLogCutoff(item.submittedAt, logCutoff) && !nextTransfers.some((transfer) => sameHex(transfer.sendTxHash, item.txHash))))
    }

    const id = setInterval(tick, 2000)
    tick()
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [appsByChainAndAddress, chainByEid, dep, logCutoff])

  if (!dep) {
    return <div className="app"><h1>Loading deployment…</h1><div className="sub">Run <code>pnpm playground</code> first.</div></div>
  }

  return (
    <div className="app">
      <h1>OneMatrix Bridge — Playground</h1>
      <div className="sub">3 chains · 3 wallets · real DVN (2-of-3) + Executor · arbitrary cross-chain data</div>
      <div className="warn">⚠ Local anvil test wallets, private keys embedded, exposed via public tunnel. No real funds.</div>

      <System dep={dep} />

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
              <button type="button" className={mode === 'utf8' ? 'on' : ''} onClick={() => setMode('utf8')}>utf8</button>
              <button type="button" className={mode === 'hex' ? 'on' : ''} onClick={() => setMode('hex')}>hex</button>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label>Payload</label>
          <textarea value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={mode === 'hex' ? '0x…' : 'type a message'} />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="send-btn" onClick={send} disabled={src === dst}>Commit &amp; transfer →</button>
          {err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{err}</span>}
        </div>

        {transfers.slice(0, 8).map((transfer) => (
          <div className="flight" key={transfer.id}>
            <div><b>{transfer.walletLabel}</b> {transfer.src.toUpperCase()} → {transfer.dst.toUpperCase()} · nonce {String(transfer.nonce)}</div>
            <div className="mono">guid {shortHex(transfer.guid, 18)} · tx {shortHex(transfer.sendTxHash)}</div>
            <div className="stages">
              <span className="stage done">Sent</span>
              <span className={`stage ${transfer.committed ? 'done' : ''}`}>Verified &amp; Committed</span>
              <span className={`stage ${transfer.delivered ? 'done' : ''}`}>Delivered</span>
              <span className={`stage ${transfer.received ? 'done' : ''}`}>Received</span>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Activities / Log</h2>
          <button type="button" className="clear-btn" onClick={clearLogs} disabled={!hasVisibleLogs(pendingSends, transfers, workerEvents, recv)}>Clear</button>
        </div>
        <div className="sub">Detailed journey with exact contracts, methods, tx hashes, worker actions, and destination receive.</div>

        {pendingSends.length === 0 && transfers.length === 0 && <div className="empty">no transfer activity yet</div>}

        {pendingSends.map((pending) => (
          <div className="activity-card" key={pending.id}>
            <div className="activity-head">
              <div><b>{pending.walletLabel}</b> {pending.src.toUpperCase()} → {pending.dst.toUpperCase()}</div>
              <span className="pill">pending</span>
            </div>
            <div className="activity-list">
              {buildPendingActivities(pending).map((item) => (
                <div className="activity-item" key={item.id}>
                  <div className={`activity-dot ${item.pending ? 'pending' : 'done'}`} />
                  <div className="activity-content">
                    <div className="activity-title">{item.title}</div>
                    <div className="activity-meta">{formatTimestamp(item.timestamp)} · {item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {transfers.map((transfer) => (
          <div className="activity-card" key={transfer.id}>
            <div className="activity-head">
              <div><b>{transfer.walletLabel}</b> {transfer.src.toUpperCase()} → {transfer.dst.toUpperCase()} · nonce {String(transfer.nonce)}</div>
              <div className="row-inline">
                <span className="pill">{transfer.committed ? 'committed' : 'in-flight'}</span>
                <span className="pill">{transfer.received ? 'received' : transfer.delivered ? 'delivered' : 'routing'}</span>
              </div>
            </div>
            <div className="mono">guid {transfer.guid} · header {shortHex(transfer.headerHash)} · payload {describePayload(transfer.message)}</div>
            <div className="activity-list">
              {buildTransferActivities(transfer, workerEvents).map((item) => (
                <div className="activity-item" key={item.id}>
                  <div className={`activity-dot ${item.pending ? 'pending' : 'done'}`} />
                  <div className="activity-content">
                    <div className="activity-title">{item.title}</div>
                    <div className="activity-meta">{formatTimestamp(item.timestamp)} · {item.detail}</div>
                  </div>
                </div>
              ))}
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

function buildPendingActivities(pending: PendingSend): ActivityLine[] {
  return [
    {
      id: `${pending.id}:request`,
      pending: false,
      timestamp: pending.submittedAt,
      title: `${pending.walletLabel} requested transfer ${pending.src.toUpperCase()} → ${pending.dst.toUpperCase()}`,
      detail: `UI action · wallet ${shortHex(pending.walletAddress)} · payload ${describePayload(pending.payload)}`,
    },
    {
      id: `${pending.id}:submitted`,
      pending: true,
      timestamp: pending.submittedAt,
      title: `Contract UserApp on ${pending.src.toUpperCase()} · sendMessage() submitted`,
      detail: `tx ${shortHex(pending.txHash)} · waiting for source-chain receipt`,
    },
  ]
}

function buildTransferActivities(transfer: Transfer, workerEvents: WorkerActivity[]): ActivityLine[] {
  const base: ActivityLine[] = [
    {
      id: `${transfer.id}:request`,
      pending: false,
      timestamp: transfer.sendTimestamp,
      title: `${transfer.walletLabel} requested transfer ${transfer.src.toUpperCase()} → ${transfer.dst.toUpperCase()}`,
      detail: `UI action · wallet ${transfer.walletAddress ? shortHex(transfer.walletAddress) : 'unknown'} · app ${shortHex(transfer.sourceWalletApp)}`,
    },
    {
      id: `${transfer.id}:send`,
      pending: false,
      timestamp: transfer.sendTimestamp,
      title: `Contract UserApp on ${transfer.src.toUpperCase()} · sendMessage() mined`,
      detail: `tx ${shortHex(transfer.sendTxHash)} · source app ${shortHex(transfer.sourceWalletApp)}`,
    },
    {
      id: `${transfer.id}:packet`,
      pending: false,
      timestamp: transfer.sendTimestamp,
      title: `Contract SendLib on ${transfer.src.toUpperCase()} · PacketSent`,
      detail: `guid ${shortHex(transfer.guid)} · payload hash ${shortHex(transfer.payloadHash)} · dst app ${shortHex(transfer.destinationWalletApp)}`,
    },
    {
      id: `${transfer.id}:verified`,
      pending: !transfer.committed,
      timestamp: transfer.verifiedTimestamp,
      title: `Contract Endpoint on ${transfer.dst.toUpperCase()} · verify() / PacketVerified`,
      detail: transfer.committed
        ? `tx ${shortHex(transfer.verifiedTxHash)} · payload committed for nonce ${String(transfer.nonce)}`
        : `awaiting DVN threshold and destination commit`,
    },
    {
      id: `${transfer.id}:delivered`,
      pending: !transfer.delivered,
      timestamp: transfer.deliveredTimestamp,
      title: `Contract Endpoint on ${transfer.dst.toUpperCase()} · lzReceive() / PacketDelivered`,
      detail: transfer.delivered
        ? `tx ${shortHex(transfer.deliveredTxHash)} · receiver ${shortHex(transfer.destinationWalletApp)}`
        : `awaiting executor delivery`,
    },
    {
      id: `${transfer.id}:received`,
      pending: !transfer.received,
      timestamp: transfer.receivedTimestamp,
      title: `Contract UserApp on ${transfer.dst.toUpperCase()} · Received`,
      detail: transfer.received
        ? `tx ${shortHex(transfer.receivedTxHash)} · payload ${describePayload(transfer.message)}`
        : `awaiting destination app receive`,
    },
  ]

  const workerLines = workerEvents
    .filter((event) => sameHex(event.guid, transfer.guid))
    .map((event) => workerEventLine(event))

  return [...base, ...workerLines].sort((a, b) => {
    const aTs = a.timestamp ?? Number.MAX_SAFE_INTEGER
    const bTs = b.timestamp ?? Number.MAX_SAFE_INTEGER
    return aTs - bTs || a.id.localeCompare(b.id)
  })
}

function workerEventLine(event: WorkerActivity): ActivityLine {
  const contractMethod = event.contract && event.method
    ? `${event.contract}.${event.method}`
    : event.contract || event.method || event.action
  const pathway = event.pathway ? `path ${event.pathway}` : 'path ?'
  const tx = event.txHash ? ` · tx ${shortHex(event.txHash as Hex)}` : ''
  const contractAddr = event.contractAddress ? ` · ${shortHex(event.contractAddress as Hex)}` : ''
  const payload = event.payloadHash ? ` · payload ${shortHex(event.payloadHash as Hex)}` : ''
  const detail = [
    `${event.workerId} (${event.role})`,
    pathway,
    event.detail || `${event.status} ${contractMethod}`,
    `${contractMethod}${contractAddr}${tx}${payload}`,
    event.error ? `error: ${event.error}` : '',
  ].filter(Boolean).join(' · ')

  return {
    id: `worker:${event.workerId}:${event.seq}`,
    pending: event.status !== 'confirmed' && event.status !== 'observed' && event.status !== 'queued' && event.status !== 'submitted',
    timestamp: event.timestamp,
    title: `Worker ${event.workerId} · ${contractMethod}`,
    detail,
  }
}

function appRefKey(chainKey: string, app: Hex): string {
  return `${chainKey}:${app.toLowerCase()}`
}

function blockTsKey(chainKey: string, blockNumber: bigint): string {
  return `${chainKey}:${blockNumber}`
}

function bytes32ToAddress(value: Hex): Hex {
  return getAddress(`0x${value.slice(-40)}`) as Hex
}

function requestKey(srcEid: number, sender: Hex, receiver: Hex, nonce: bigint): string {
  return `${srcEid}:${sender.toLowerCase()}:${receiver.toLowerCase()}:${String(nonce)}`
}

function verificationKey(srcEid: number, sender: Hex, receiver: Hex, nonce: bigint, payloadHash: Hex): string {
  return `${requestKey(srcEid, sender, receiver, nonce)}:${payloadHash.toLowerCase()}`
}

function sameHex(a?: Hex | string, b?: Hex | string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

function passesLogCutoff(timestamp: number, cutoff: number): boolean {
  return cutoff === 0 || timestamp >= cutoff
}

function hasVisibleLogs(
  pendingSends: PendingSend[],
  transfers: Transfer[],
  workerEvents: WorkerActivity[],
  recv: Record<string, RecvMsg[]>,
): boolean {
  return pendingSends.length > 0 || transfers.length > 0 || workerEvents.length > 0 || Object.values(recv).some((msgs) => msgs.length > 0)
}

function shortHex(value?: Hex | string, width = 12): string {
  if (!value) return '—'
  const v = String(value)
  return v.length <= width + 6 ? v : `${v.slice(0, width)}…${v.slice(-6)}`
}

function formatTimestamp(ts?: number): string {
  if (!ts) return 'pending'
  return new Date(ts * 1000).toLocaleTimeString()
}

function describePayload(hex: Hex): string {
  const decoded = tryUtf8(hex)
  return decoded === hex ? shortHex(hex, 18) : decoded
}

function tryUtf8(hex: Hex): string {
  try {
    const s = hexToString(hex)
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s)) return s || '(empty)'
  } catch {}
  return hex
}

function readStoredLogCutoff(): number {
  if (typeof window === 'undefined') return 0
  const raw = Number(window.localStorage.getItem(LOG_CUTOFF_STORAGE_KEY) || '0')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function storeLogCutoff(cutoff: number) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(LOG_CUTOFF_STORAGE_KEY, String(cutoff))
}
