import { useEffect, useState } from 'react'
import { formatEther, type Hex } from 'viem'
import { publicFor } from './viem'
import type { Deployment } from './types'

type SysChain = { key: string; height: string; ts: number }
type SysWorker = { id: string; role: string; online: boolean; processed: number; signers: number; balances: Record<string, string> }

export function System({ dep }: { dep: Deployment }) {
  const [chains, setChains] = useState<SysChain[]>([])
  const [workers, setWorkers] = useState<SysWorker[]>([])
  const [now, setNow] = useState(Math.floor(Date.now() / 1000))

  useEffect(() => {
    let alive = true
    const tick = async () => {
      setNow(Math.floor(Date.now() / 1000))
      const cs = await Promise.all(
        dep.chains.map(async (c) => {
          try {
            const b = await publicFor(c).getBlock({ blockTag: 'latest' })
            return { key: c.key, height: String(b.number), ts: Number(b.timestamp) }
          } catch {
            return { key: c.key, height: '?', ts: 0 }
          }
        }),
      )
      const ws = await Promise.all(
        (dep.workers || []).map(async (w) => {
          let online = false
          let processed = 0
          try {
            const r = await fetch(w.status, { cache: 'no-store' })
            const j = await r.json()
            online = !!j.online
            processed = Number(j.processed)
          } catch {
            online = false
          }
          const balances: Record<string, string> = {}
          for (const c of dep.chains) {
            try {
              let sum = 0n
              for (const a of w.addresses) sum += await publicFor(c).getBalance({ address: a as Hex })
              balances[c.key] = Number(formatEther(sum)).toFixed(1)
            } catch {
              balances[c.key] = '?'
            }
          }
          return { id: w.id, role: w.role, online, processed, signers: w.addresses.length, balances }
        }),
      )
      if (alive) {
        setChains(cs)
        setWorkers(ws)
      }
    }
    const id = setInterval(tick, 2500)
    tick()
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [dep])

  const dvn = workers.filter((w) => w.role === 'dvn')
  const exec = workers.filter((w) => w.role === 'executor')
  const onlineDvn = dvn.filter((w) => w.online).length
  const onlineExec = exec.filter((w) => w.online).length

  return (
    <div className="panel">
      <h2>System</h2>
      <div className="row" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <span className="pill">Executors {onlineExec}/{exec.length} online</span>
        <span className="pill">DVN {onlineDvn}/{dvn.length} running{dep.dvnSet ? ` · ${dep.dvnSet.threshold}-of-${dep.dvnSet.configured}` : ''}</span>
        <span className="pill">{dep.chains.length} chains</span>
      </div>

      <div className="grid3">
        {chains.map((c) => (
          <div className="cell" key={c.key}>
            <h3>Chain {c.key.toUpperCase()}</h3>
            <div className="msg">block <b>#{c.height}</b></div>
            <div className="meta">last block {c.ts ? `${Math.max(0, now - c.ts)}s ago` : '—'}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10 }}>
        {workers.map((w) => (
          <div className="flight" key={w.id}>
            <div>
              <span className={`dot ${w.online ? 'on' : 'off'}`} /> <b>{w.id}</b> <span className="pill">{w.role}</span>
              {' '}· {w.online ? 'online' : 'offline'} · processed <b>{w.processed}</b>
              {w.role === 'executor' && <> · {w.signers} signers</>}
            </div>
            <div className="meta">balance · {dep.chains.map((c) => `${c.key.toUpperCase()} ${w.balances[c.key] ?? '?'}`).join('  ')} ETH</div>
          </div>
        ))}
      </div>
    </div>
  )
}
