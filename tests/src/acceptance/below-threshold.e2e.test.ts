import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { stringToHex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { trySend, collectEchoed } from './helpers'
import { sleep } from '../harness/poll'

// Sad path: below the M-of-N threshold the message must NEVER commit/deliver (fail safe).
describe('sad-path: below DVN threshold', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8702, 8712) // M=2 of N=3
    // start only ONE attestor — threshold (2) can never be met
    workers = [startAttestor(net.attestorEnv(net.attestorIdxs[0]))]
    exec = startExecutor(net.executorEnv())
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  test(
    'never delivered with only 1 of 2 required attestations',
    async () => {
      await trySend(net.sctx, net.appSrc, stringToHex('should-never-arrive'))
      await sleep(12000) // executor keeps polling verifiable=false → never commits
      expect((await collectEchoed(net.dctx, net.appDst)).length).toBe(0)
    },
    30_000,
  )
})
