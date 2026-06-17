import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, collectEchoed } from './helpers'
import { pollUntil, sleep } from '../harness/poll'

// Sad path: a signer dies mid-flight; remaining executor capacity still delivers everything.
// Modeled as two single-signer executor processes (disjoint accounts) — kill one, the other
// finishes. Idempotency on-chain makes the overlap harmless.
describe('sad-path: signer crash', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec1: ExecutorHandle
  let exec2: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8706, 8716)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
    exec1 = startExecutor({ ...net.executorEnv([0]), EXECUTOR_ID: 'e1' })
    exec2 = startExecutor({ ...net.executorEnv([4]), EXECUTOR_ID: 'e2' })
  }, 120_000)

  afterAll(() => {
    exec1?.stop()
    exec2?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function msg(i: number): Hex {
    return bytesToHex(new Uint8Array([i & 0xff]))
  }

  test(
    'all messages delivered despite one signer dying mid-burst',
    async () => {
      const N = 8
      for (let i = 1; i <= N; i++) await trySend(net.sctx, net.appSrc, msg(i))
      await sleep(500)
      exec1.stop() // kill one signer mid-flight
      expect(await pollUntil(async () => (await collectEchoed(net.dctx, net.appDst)).length === N, 40_000)).toBe(true)
    },
    50_000,
  )
})
