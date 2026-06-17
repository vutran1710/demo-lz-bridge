import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { trySend, inboundNonce, inboundPayloadHash } from './helpers'
import { pollUntil } from '../harness/poll'

// Stress acceptance: throughput + burst with no gaps / no double-commit / no lost packets.
// RED until P2/P3.
describe('acceptance: stress / throughput', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []

  beforeAll(async () => {
    buildWorker()
    net = await twoNode(2, 8640, 8650)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
  }, 120_000)

  afterAll(() => {
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function msg(i: number): Hex {
    return bytesToHex(new Uint8Array([(i >> 8) & 0xff, i & 0xff]))
  }

  test(
    'sustained: 200 packets commit in order with no gaps',
    async () => {
      const N = 200
      for (let i = 1; i <= N; i++) await trySend(net.sctx, net.appSrc, msg(i))

      const reached = await pollUntil(
        async () => (await inboundNonce(net.dctx, net.appDst, net.appSrc)) === BigInt(N),
        280_000,
      )
      expect(reached).toBe(true)

      const EMPTY = ('0x' + '0'.repeat(64)) as Hex
      for (let i = 1; i <= N; i++) {
        const h = await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, BigInt(i))
        expect(h).not.toBe(EMPTY) // every nonce committed — no gaps
      }
    },
    300_000,
  )
})
