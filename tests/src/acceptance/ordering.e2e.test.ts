import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, collectEchoed } from './helpers'
import { pollUntil } from '../harness/poll'

// Sad path / invariant: under a burst, per-channel delivery is in strict nonce order (never n+1
// before n), even with a multi-signer pool.
describe('sad-path: ordered execution under burst', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8708, 8718)
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
    'burst delivered in strict nonce order',
    async () => {
      const N = 15
      const sent: Hex[] = []
      for (let i = 1; i <= N; i++) {
        const m = msg(i)
        sent.push(m)
        await trySend(net.sctx, net.appSrc, m)
      }
      expect(await pollUntil(async () => (await collectEchoed(net.dctx, net.appDst)).length === N, 40_000)).toBe(true)
      expect(await collectEchoed(net.dctx, net.appDst)).toEqual(sent) // strict order
    },
    50_000,
  )
})
