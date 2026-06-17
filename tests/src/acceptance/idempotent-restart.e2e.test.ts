import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, collectEchoed } from './helpers'
import { pollUntil, sleep } from '../harness/poll'

// Sad path: restarting the executor mid-flight must not double-deliver or drop any message.
describe('sad-path: idempotent executor restart', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8720, 8730)
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
    'restart mid-flight: no double-delivery, no gaps',
    async () => {
      const N = 12
      const sent: Hex[] = []
      for (let i = 1; i <= N; i++) {
        const m = msg(i)
        sent.push(m)
        await trySend(net.sctx, net.appSrc, m)
      }
      await sleep(400)
      exec.stop() // restart mid-flight
      await sleep(300)
      exec = startExecutor(net.executorEnv())

      expect(await pollUntil(async () => (await collectEchoed(net.dctx, net.appDst)).length === N, 40_000)).toBe(true)
      await sleep(1000)
      const received = await collectEchoed(net.dctx, net.appDst)
      expect(received.length).toBe(N) // no duplicates
      expect(received).toEqual(sent) // in order, no gaps
    },
    50_000,
  )
})
