import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { trySend, inboundNonce, inboundPayloadHash } from './helpers'
import { pollUntil } from '../harness/poll'

// Stress acceptance (2 anvil chains): verify+commit layer under load — every packet committed in
// strict order with no gaps and no loss/duplication. Delivery/receipt correctness is covered by
// transfer.e2e; receipt-AT-SCALE (multi-channel, parallel) is added in P4.M3 with the real
// Executor, since a single channel's ordered delivery is inherently sequential.
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
    'sustained: 200 packets committed in order with no gaps or loss',
    async () => {
      const N = 200
      for (let i = 1; i <= N; i++) await trySend(net.sctx, net.appSrc, msg(i))

      const reached = await pollUntil(
        async () => (await inboundNonce(net.dctx, net.appDst, net.appSrc)) === BigInt(N),
        90_000,
      )
      expect(reached).toBe(true)

      const EMPTY = ('0x' + '0'.repeat(64)) as Hex
      for (let i = 1; i <= N; i++) {
        const h = await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, BigInt(i))
        expect(h).not.toBe(EMPTY) // every nonce committed — no gaps, no loss
      }
    },
    120_000,
  )
})
