// pnpm playground — bring up the whole bridge for interactive smoke testing with the REAL workers:
// 3 anvil chains, the protocol stack + 9 per-wallet UserApps, the full pathway mesh, the real Go
// DVN attestors (2-of-3) + the real Go Executor (all 6 pathways), the Vite app, and a Cloudflare
// tunnel. Ctrl+C tears it all down.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pad, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { startAnvil } from '../tests/src/harness/anvil'
import { clients } from '../tests/src/harness/clients'
import { deployStack, type Ctx } from '../tests/src/harness/deploy'
import { ABI } from '../tests/src/harness/abis'
import { ulnConfigBytes } from '../tests/src/harness/app'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(__dirname, '..', 'worker')

// 3 wallets = anvil accounts 6,7,8 (pre-funded on every chain). System accounts: 0,4,5 = executor
// signers; 1,2,3 = the DVN attestor set (we run 2 of 3).
const WALLET_KEYS: { label: string; key: Hex }[] = [
  { label: 'W1', key: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' },
  { label: 'W2', key: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' },
  { label: 'W3', key: '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97' },
]
const ATTESTOR_KEYS: Hex[] = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', // acct 1
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', // acct 2
]
const ATTESTOR_SET_KEYS: Hex[] = [
  ...ATTESTOR_KEYS,
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', // acct 3 (in the set, not run)
]
const EXECUTOR_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', // acct 0
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', // acct 4
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', // acct 5
]
const ATTESTOR_ADDRS = ATTESTOR_SET_KEYS.map((k) => privateKeyToAccount(k).address as Hex)

const CHAINS = [
  { key: 'a', eid: 1, port: 8800, proxy: '/rpc/a' },
  { key: 'b', eid: 2, port: 8802, proxy: '/rpc/b' },
  { key: 'c', eid: 3, port: 8804, proxy: '/rpc/c' },
]
const M = 2

const procs: { name: string; stop: () => void }[] = []
const track = (name: string, stop: () => void) => procs.push({ name, stop })

async function write(ctx: Ctx, address: Hex, abi: any, fn: string, args: any[]) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({ address, abi, functionName: fn, args, account: w.account!, chain: w.chain })
  return ctx.pub.waitForTransactionReceipt({ hash })
}

async function main() {
  console.log('▶ starting 3 anvil chains…')
  const nodes = await Promise.all(CHAINS.map((c) => startAnvil(c.port)))
  nodes.forEach((n, i) => track(`anvil:${CHAINS[i].key}`, n.stop))

  console.log('▶ deploying protocol stacks…')
  const ctxs: Ctx[] = []
  for (let i = 0; i < CHAINS.length; i++) {
    const c = clients(nodes[i].rpc)
    ctxs.push(await deployStack(nodes[i].rpc, CHAINS[i].eid, c.pub as any, c.wallets as any))
  }

  console.log('▶ deploying 9 UserApps (3 wallets × 3 chains)…')
  const userApps: Hex[][] = []
  for (let wi = 0; wi < WALLET_KEYS.length; wi++) {
    userApps[wi] = []
    for (let ci = 0; ci < CHAINS.length; ci++) {
      const ctx = ctxs[ci]
      const w = ctx.wallets[0]
      const hash = await w.deployContract({ abi: ABI.UserApp.abi, bytecode: ABI.UserApp.bytecode, args: [ctx.endpoint], account: w.account!, chain: w.chain })
      const r = await ctx.pub.waitForTransactionReceipt({ hash })
      userApps[wi][ci] = r.contractAddress as Hex
    }
  }

  console.log('▶ wiring full pathway mesh…')
  for (let wi = 0; wi < WALLET_KEYS.length; wi++) {
    for (let s = 0; s < CHAINS.length; s++) {
      for (let d = 0; d < CHAINS.length; d++) {
        if (s === d) continue
        const sctx = ctxs[s], dctx = ctxs[d]
        const sEid = CHAINS[s].eid, dEid = CHAINS[d].eid
        const sApp = userApps[wi][s], dApp = userApps[wi][d]
        await write(sctx, sApp, ABI.UserApp.abi, 'setPeer', [dEid, pad(dApp, { size: 32 })])
        await write(sctx, sctx.endpoint, ABI.Endpoint.abi, 'setSendLibrary', [sApp, dEid, sctx.sendLib])
        await write(dctx, dApp, ABI.UserApp.abi, 'setPeer', [sEid, pad(sApp, { size: 32 })])
        await write(dctx, dctx.endpoint, ABI.Endpoint.abi, 'setReceiveLibrary', [dApp, sEid, dctx.receiveLib, 0n])
        const cfg = ulnConfigBytes(1n, [], ATTESTOR_ADDRS, M)
        await write(dctx, dctx.endpoint, ABI.Endpoint.abi, 'setConfig', [dApp, dctx.receiveLib, [{ eid: sEid, configType: 2, config: cfg }]])
      }
    }
  }

  // deployment.json for the browser (proxy RPC paths)
  const deployment = {
    chains: CHAINS.map((c, i) => ({ key: c.key, eid: c.eid, rpc: c.proxy, endpoint: ctxs[i].endpoint, receiveLib: ctxs[i].receiveLib })),
    wallets: WALLET_KEYS.map((w, wi) => ({
      label: w.label,
      address: privateKeyToAccount(w.key).address,
      key: w.key,
      apps: Object.fromEntries(CHAINS.map((c, ci) => [c.eid, userApps[wi][ci]])),
    })),
  }
  mkdirSync(resolve(__dirname, 'public'), { recursive: true })
  writeFileSync(resolve(__dirname, 'public', 'deployment.json'), JSON.stringify(deployment, null, 2))
  console.log('▶ wrote deployment.json')

  // pathways for the real Go workers (direct anvil RPCs) — all 6 directed chain pairs
  const pathways: any[] = []
  for (let s = 0; s < CHAINS.length; s++)
    for (let d = 0; d < CHAINS.length; d++)
      if (s !== d) pathways.push({ id: `${CHAINS[s].key}${CHAINS[d].key}`, srcRpc: nodes[s].rpc, dstRpc: nodes[d].rpc, dstReceiveLib: ctxs[d].receiveLib, dstEndpoint: ctxs[d].endpoint, confirmations: 1 })
  const PATHWAYS_JSON = JSON.stringify(pathways)

  console.log('▶ building Go workers…')
  execFileSync('go', ['build', '-o', 'bin/attestor', './cmd/attestor'], { cwd: WORKER_DIR, stdio: 'inherit' })
  execFileSync('go', ['build', '-o', 'bin/executor', './cmd/executor'], { cwd: WORKER_DIR, stdio: 'inherit' })

  console.log('▶ starting real DVN attestors (2-of-3) + Executor…')
  ATTESTOR_KEYS.forEach((key, i) => {
    const p = spawnProc('bin/attestor', { ATTESTOR_ID: `a${i + 1}`, ATTESTOR_KEY: key.slice(2), POLL_MS: '150', CURSOR_PATH: `/tmp/pg-a${i}-${Date.now()}`, PATHWAYS_JSON }, `a${i + 1}`)
    track(`attestor:a${i + 1}`, () => p.kill('SIGINT'))
  })
  const exec = spawnProc('bin/executor', { EXECUTOR_ID: 'exec', EXECUTOR_KEYS: EXECUTOR_KEYS.join(','), POLL_MS: '120', PATHWAYS_JSON }, 'exec')
  track('executor', () => exec.kill('SIGINT'))

  console.log('▶ starting Vite app on :5173…')
  const vite = spawn('pnpm', ['exec', 'vite', '--port', '5173', '--strictPort'], { cwd: __dirname, stdio: 'inherit', env: process.env })
  track('vite', () => vite.kill('SIGINT'))

  console.log('▶ opening Cloudflare tunnel…')
  const cf = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:5173'], { stdio: 'pipe' })
  track('cloudflared', () => cf.kill('SIGINT'))
  const onCf = (b: Buffer) => {
    const m = b.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m) console.log(`\n🌐  PUBLIC URL:  ${m[0]}\n`)
  }
  cf.stdout?.on('data', onCf)
  cf.stderr?.on('data', onCf)

  console.log('\n✅ playground up (real DVN + Executor). Ctrl+C to tear down.\n')
}

function spawnProc(bin: string, env: Record<string, string>, label: string): ChildProcess {
  const p = spawn(resolve(WORKER_DIR, bin), [], { cwd: WORKER_DIR, env: { ...process.env, ...env }, stdio: 'pipe' })
  const tag = (b: Buffer) => process.stdout.write(`[${label}] ${b}`)
  p.stdout?.on('data', tag)
  p.stderr?.on('data', tag)
  return p
}

function shutdown() {
  console.log('\n▶ tearing down…')
  for (const p of procs.reverse()) {
    try {
      p.stop()
    } catch {
      // ignore
    }
  }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((e) => {
  console.error(e)
  shutdown()
})
