import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { stringToHex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, collectEchoed } from './helpers'
import { pollUntil, sleep } from '../harness/poll'

// Sad path: executor offline ⇒ verified but NOT delivered (liveness SPOF); recovers on restart.
describe('sad-path: executor down', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle | undefined

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8700, 8710)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  test(
    'not delivered while executor is down; delivered once it starts',
    async () => {
      await trySend(net.sctx, net.appSrc, stringToHex('waiting-for-executor'))
      // attestors verify, but with no executor nothing commits/delivers
      await sleep(8000)
      expect((await collectEchoed(net.dctx, net.appDst)).length).toBe(0)

      // bring the executor up → backlog delivered
      exec = startExecutor(net.executorEnv())
      expect(await pollUntil(async () => (await collectEchoed(net.dctx, net.appDst)).length === 1, 25_000)).toBe(true)
    },
    45_000,
  )
})
