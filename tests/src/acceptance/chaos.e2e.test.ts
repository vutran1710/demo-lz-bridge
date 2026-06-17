import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, collectEchoed } from './helpers'
import { pollUntil, sleep } from '../harness/poll'

// Chaos acceptance: the M-of-N verifier + Executor must deliver despite a downed attestor and
// restarts. Asserts actual receipt (Echoed) on the destination app.
describe('acceptance: chaos / fault tolerance', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8620, 8630) // M=2 of N=3
    exec = startExecutor(net.executorEnv())
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function msg(n: number): Hex {
    const a = new Uint8Array(8)
    for (let i = 0; i < 8; i++) a[i] = (n + i) & 0xff
    return bytesToHex(a)
  }

  test(
    'delivers with only M of N attestors running',
    async () => {
      // start only 2 of 3 (indexes 1,2); never start 3 — M-of-N still reaches threshold and delivers
      workers = [net.attestorIdxs[0], net.attestorIdxs[1]].map((i) => startAttestor(net.attestorEnv(i)))
      const before = (await collectEchoed(net.dctx, net.appDst)).length
      await trySend(net.sctx, net.appSrc, msg(1))
      const ok = await pollUntil(
        async () => (await collectEchoed(net.dctx, net.appDst)).length === before + 1,
        30_000,
      )
      expect(ok).toBe(true)
    },
    40_000,
  )

  test(
    'attestor restart mid-flight still delivers (no duplicate)',
    async () => {
      const before = (await collectEchoed(net.dctx, net.appDst)).length
      await trySend(net.sctx, net.appSrc, msg(2))
      workers[0].stop()
      await sleep(300)
      workers[0] = startAttestor(net.attestorEnv(net.attestorIdxs[0]))
      const ok = await pollUntil(
        async () => (await collectEchoed(net.dctx, net.appDst)).length === before + 1,
        30_000,
      )
      expect(ok).toBe(true)
      await sleep(1000)
      expect((await collectEchoed(net.dctx, net.appDst)).length).toBe(before + 1) // no duplicate
    },
    40_000,
  )
})
