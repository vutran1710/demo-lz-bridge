import { pad, type Hex } from 'viem'
import { startAnvil, type AnvilHandle } from './anvil'
import { clients, KEYS } from './clients'
import { deployStack, type Ctx } from './deploy'
import { deployApp, ulnConfigBytes } from './app'
import { ABI } from './abis'

export const EID_SRC = 1
export const EID_DST = 2

async function write(ctx: Ctx, address: Hex, abi: any, fn: string, args: any[]) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({ address, abi, functionName: fn, args, account: w.account!, chain: w.chain })
  return ctx.pub.waitForTransactionReceipt({ hash })
}

export type TwoNode = {
  src: AnvilHandle
  dst: AnvilHandle
  sctx: Ctx
  dctx: Ctx
  appSrc: Hex
  appDst: Hex
  attestorIdxs: number[]
  attestorEnv: (i: number) => Record<string, string>
  executorEnv: (signerIdxs?: number[]) => Record<string, string>
  stop: () => void
}

// Two local chains (src EID 1, dst EID 2), a channel appSrc -> appDst, M-of-N attestors on the dst.
export async function twoNode(
  M = 2,
  srcPort = 8600,
  dstPort = 8610,
  dstApp: 'AppEcho' | 'AppRevert' = 'AppEcho',
): Promise<TwoNode> {
  // unique per invocation so a fresh chain never inherits a stale block cursor from a prior run
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const src = await startAnvil(srcPort)
  const dst = await startAnvil(dstPort)
  const sc = clients(src.rpc)
  const dc = clients(dst.rpc)
  const sctx = await deployStack(src.rpc, EID_SRC, sc.pub as any, sc.wallets as any)
  const dctx = await deployStack(dst.rpc, EID_DST, dc.pub as any, dc.wallets as any)
  const appSrc = await deployApp(sctx, 'AppEcho')
  const appDst = await deployApp(dctx, dstApp)

  const attestorIdxs = [1, 2, 3]
  const optional = attestorIdxs.map((i) => sc.accounts[i].address as Hex)

  // src side: peer + send library for appSrc -> dst
  await write(sctx, appSrc, ABI.AppEcho.abi, 'setPeer', [EID_DST, pad(appDst, { size: 32 })])
  await write(sctx, sctx.endpoint, ABI.Endpoint.abi, 'setSendLibrary', [appSrc, EID_DST, sctx.sendLib])

  // dst side: peer + receive library + ULN M-of-N config for appDst <- src
  await write(dctx, appDst, ABI.AppEcho.abi, 'setPeer', [EID_SRC, pad(appSrc, { size: 32 })])
  await write(dctx, dctx.endpoint, ABI.Endpoint.abi, 'setReceiveLibrary', [appDst, EID_SRC, dctx.receiveLib, 0n])
  const cfg = ulnConfigBytes(1n, [], optional, M)
  await write(dctx, dctx.endpoint, ABI.Endpoint.abi, 'setConfig', [
    appDst,
    dctx.receiveLib,
    [{ eid: EID_SRC, configType: 2, config: cfg }],
  ])

  const attestorEnv = (i: number) => ({
    ATTESTOR_ID: `a${i}`,
    SRC_RPC: src.rpc,
    DST_RPC: dst.rpc,
    SRC_ENDPOINT: sctx.endpoint,
    DST_RECEIVE_LIB: dctx.receiveLib,
    ATTESTOR_KEY: KEYS[i].slice(2),
    CONFIRMATIONS: '1',
    POLL_MS: '150',
    CURSOR_PATH: `/tmp/cursor-a${i}-${srcPort}-${dstPort}-${runId}.cursor`,
  })

  // Executor signer pool: accounts 0,4,5 (disjoint from attestors 1,2,3). Commit + deliver are
  // permissionless, so any funded accounts work.
  const executorEnv = (signerIdxs: number[] = [0, 4, 5]) => ({
    EXECUTOR_ID: 'exec',
    SRC_RPC: src.rpc,
    DST_RPC: dst.rpc,
    DST_RECEIVE_LIB: dctx.receiveLib,
    DST_ENDPOINT: dctx.endpoint,
    EXECUTOR_KEYS: signerIdxs.map((i) => KEYS[i]).join(','),
    CONFIRMATIONS: '1',
    POLL_MS: '120',
  })

  return {
    src,
    dst,
    sctx,
    dctx,
    appSrc,
    appDst,
    attestorIdxs,
    attestorEnv,
    executorEnv,
    stop: () => {
      src.stop()
      dst.stop()
    },
  }
}
