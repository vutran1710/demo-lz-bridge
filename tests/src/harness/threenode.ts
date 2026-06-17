import { pad, type Hex } from 'viem'
import { startAnvil, type AnvilHandle } from './anvil'
import { clients, KEYS } from './clients'
import { deployStack, type Ctx } from './deploy'
import { ulnConfigBytes } from './app'
import { ABI } from './abis'

// Three chains A(eid1) / B(eid2) / C(eid3) wired into a ring of pathways A→B, B→C, C→A, each with a
// RelayApp that forwards on receive. Validates multi-chain: one DVN + one Executor service all three
// pathways (pathway-list), same DVN key across chains.
export type ThreeNode = {
  nodes: AnvilHandle[]
  ctxs: Ctx[]
  relays: Hex[]
  eids: number[]
  attestorIdxs: number[]
  attestorEnvFor: (i: number) => Record<string, string>
  executorEnv: () => Record<string, string>
  stop: () => void
}

async function write(ctx: Ctx, address: Hex, abi: any, fn: string, args: any[]) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({ address, abi, functionName: fn, args, account: w.account!, chain: w.chain })
  return ctx.pub.waitForTransactionReceipt({ hash })
}

export async function threeNode(M = 2, basePort = 8800): Promise<ThreeNode> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const eids = [1, 2, 3]
  const nodes: AnvilHandle[] = []
  for (let i = 0; i < 3; i++) nodes.push(await startAnvil(basePort + i * 2))
  const ctxs: Ctx[] = []
  for (let i = 0; i < 3; i++) {
    const c = clients(nodes[i].rpc)
    ctxs.push(await deployStack(nodes[i].rpc, eids[i], c.pub as any, c.wallets as any))
  }
  // RelayApp on each chain
  const relays: Hex[] = []
  for (const ctx of ctxs) {
    const w = ctx.wallets[0]
    const hash = await w.deployContract({ abi: ABI.RelayApp.abi, bytecode: ABI.RelayApp.bytecode, args: [ctx.endpoint], account: w.account!, chain: w.chain })
    const r = await ctx.pub.waitForTransactionReceipt({ hash })
    relays.push(r.contractAddress as Hex)
  }

  const attestorIdxs = [1, 2, 3]
  const attestorAddrs = attestorIdxs.map((i) => clients(nodes[0].rpc).accounts[i].address as Hex)
  const edges: [number, number][] = [[0, 1], [1, 2], [2, 0]] // A→B, B→C, C→A

  for (const [s, d] of edges) {
    const sctx = ctxs[s], dctx = ctxs[d], sEid = eids[s], dEid = eids[d], sRelay = relays[s], dRelay = relays[d]
    // src: send peer + send library
    await write(sctx, sRelay, ABI.RelayApp.abi, 'setPeer', [dEid, pad(dRelay, { size: 32 })])
    await write(sctx, sctx.endpoint, ABI.Endpoint.abi, 'setSendLibrary', [sRelay, dEid, sctx.sendLib])
    // dst: receive peer (auth) + receive library + ULN M-of-N (same attestor addresses on every chain)
    await write(dctx, dRelay, ABI.RelayApp.abi, 'setPeer', [sEid, pad(sRelay, { size: 32 })])
    await write(dctx, dctx.endpoint, ABI.Endpoint.abi, 'setReceiveLibrary', [dRelay, sEid, dctx.receiveLib, 0n])
    const cfg = ulnConfigBytes(1n, [], attestorAddrs, M)
    await write(dctx, dctx.endpoint, ABI.Endpoint.abi, 'setConfig', [dRelay, dctx.receiveLib, [{ eid: sEid, configType: 2, config: cfg }]])
  }
  // forwarding: B forwards to C, C forwards to A (A is the origin, receives last with hops=0)
  await write(ctxs[1], relays[1], ABI.RelayApp.abi, 'setNextEid', [eids[2]])
  await write(ctxs[2], relays[2], ABI.RelayApp.abi, 'setNextEid', [eids[0]])

  const attestorPathways = edges.map(([s, d], i) => ({
    id: `p${i}`, srcRpc: nodes[s].rpc, dstRpc: nodes[d].rpc, dstReceiveLib: ctxs[d].receiveLib, confirmations: 1,
  }))
  const executorPathways = edges.map(([s, d], i) => ({
    id: `p${i}`, srcRpc: nodes[s].rpc, dstRpc: nodes[d].rpc, dstReceiveLib: ctxs[d].receiveLib, dstEndpoint: ctxs[d].endpoint, confirmations: 1,
  }))

  return {
    nodes, ctxs, relays, eids, attestorIdxs,
    attestorEnvFor: (i: number) => ({
      ATTESTOR_ID: `a${i}`,
      ATTESTOR_KEY: KEYS[i].slice(2),
      POLL_MS: '150',
      CURSOR_PATH: `/tmp/ring-a${i}-${runId}`,
      PATHWAYS_JSON: JSON.stringify(attestorPathways),
    }),
    executorEnv: () => ({
      EXECUTOR_ID: 'exec',
      EXECUTOR_KEYS: [KEYS[0], KEYS[4], KEYS[5]].join(','),
      POLL_MS: '120',
      PATHWAYS_JSON: JSON.stringify(executorPathways),
    }),
    stop: () => nodes.forEach((n) => n.stop()),
  }
}
