import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { stringToHex, type Hex } from 'viem'
import { threeNode, type ThreeNode } from '../harness/threenode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { ABI } from '../harness/abis'
import { pollUntil } from '../harness/poll'
import type { Ctx } from '../harness/deploy'

// MULTI-CHAIN e2e: data flows A→B→C→A across three chains via a RelayApp that forwards each hop.
// One DVN (2 attestors) + one Executor service all three pathways. Validate receipt on each chain.
describe('acceptance: 3-chain ring A→B→C→A', () => {
  let net: ThreeNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await threeNode(2, 8800)
    workers = [startAttestor(net.attestorEnvFor(1)), startAttestor(net.attestorEnvFor(2))] // 2 of 3
    exec = startExecutor(net.executorEnv())
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  async function received(ctx: Ctx, relay: Hex): Promise<Hex[]> {
    const logs = await ctx.pub.getContractEvents({
      address: relay, abi: ABI.RelayApp.abi, eventName: 'Received', fromBlock: 0n, toBlock: 'latest',
    })
    return logs.map((l: any) => l.args.data as Hex)
  }

  test(
    'message delivered around the ring, received on B, C, and back on A',
    async () => {
      const data = stringToHex('ring-payload')
      // kick on A (ctx 0): send [hops=2][data] to B (eid 2); B→C→A forward automatically
      const a = net.ctxs[0]
      const w = a.wallets[0]
      await a.pub.waitForTransactionReceipt({
        hash: await w.writeContract({
          address: net.relays[0], abi: ABI.RelayApp.abi, functionName: 'start',
          args: [net.eids[1], 2, data], account: w.account!, chain: w.chain,
        }),
      })

      // B (ctx1), then C (ctx2), then A (ctx0) must each receive the payload
      for (const idx of [1, 2, 0]) {
        const ok = await pollUntil(async () => (await received(net.ctxs[idx], net.relays[idx])).some((d) => d === data), 70_000)
        expect(ok, `chain index ${idx} did not receive`).toBe(true)
      }
    },
    90_000,
  )
})
