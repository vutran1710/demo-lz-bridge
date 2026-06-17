import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, inboundNonce, collectEchoed } from './helpers'
import { pollUntil } from '../harness/poll'

// Stress acceptance (2 anvil chains, real DVN + Executor): 200 packets committed in order with no
// gaps AND received by the destination app intact, in order — no loss, no duplication.
describe('acceptance: stress / throughput', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8640, 8650)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
    exec = startExecutor(net.executorEnv())
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function msg(i: number): Hex {
    return bytesToHex(new Uint8Array([(i >> 8) & 0xff, i & 0xff]))
  }

  test(
    'sustained: 200 packets committed AND received intact, in order, no gaps',
    async () => {
      const N = 200
      const sent: Hex[] = []
      for (let i = 1; i <= N; i++) {
        const m = msg(i)
        sent.push(m)
        await trySend(net.sctx, net.appSrc, m)
      }
      // all committed in order (commit cursor reaches N)
      expect(await pollUntil(async () => (await inboundNonce(net.dctx, net.appDst, net.appSrc)) === BigInt(N), 150_000)).toBe(true)
      // all received by the app, intact and in order (no loss / no duplicate)
      expect(await pollUntil(async () => (await collectEchoed(net.dctx, net.appDst)).length === N, 150_000)).toBe(true)
      expect(await collectEchoed(net.dctx, net.appDst)).toEqual(sent)
    },
    180_000,
  )
})
