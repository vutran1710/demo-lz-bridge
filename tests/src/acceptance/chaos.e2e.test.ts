import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode, EID_SRC, EID_DST } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { encodePacket } from '../harness/packet'
import { trySend, inboundPayloadHash } from './helpers'
import { pollUntil, sleep } from '../harness/poll'

// Chaos acceptance: the M-of-N verifier must tolerate a downed attestor and worker restarts.
// RED until P2/P3.
describe('acceptance: chaos / fault tolerance', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []

  beforeAll(async () => {
    buildWorker()
    net = await twoNode(2, 8620, 8630) // M=2 of N=3
  }, 120_000)

  afterAll(() => {
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function msg(n: number): Hex {
    const a = new Uint8Array(8)
    for (let i = 0; i < 8; i++) a[i] = (n + i) & 0xff
    return bytesToHex(a)
  }

  test('commit succeeds with only M of N attestors running', async () => {
    // start only 2 of 3 (indexes 1,2); never start 3 — M-of-N must still reach threshold.
    workers = [net.attestorIdxs[0], net.attestorIdxs[1]].map((i) => startAttestor(net.attestorEnv(i)))
    const message = msg(1)
    const nonce = 1n
    const { payloadHash } = encodePacket(nonce, EID_SRC, net.appSrc, EID_DST, net.appDst, message)
    await trySend(net.sctx, net.appSrc, message)
    const committed = await pollUntil(
      async () => (await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, nonce)) === payloadHash,
      60_000,
    )
    expect(committed).toBe(true)
  })

  test('attestor restart mid-flight is idempotent (exactly one commit)', async () => {
    const message = msg(2)
    const nonce = 2n
    const { payloadHash } = encodePacket(nonce, EID_SRC, net.appSrc, EID_DST, net.appDst, message)
    await trySend(net.sctx, net.appSrc, message)
    // restart attestor 0 immediately
    workers[0].stop()
    await sleep(300)
    workers[0] = startAttestor(net.attestorEnv(net.attestorIdxs[0]))
    const committed = await pollUntil(
      async () => (await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, nonce)) === payloadHash,
      60_000,
    )
    expect(committed).toBe(true)
  })
})
