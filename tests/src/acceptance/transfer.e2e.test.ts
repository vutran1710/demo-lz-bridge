import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, type Hex } from 'viem'
import { twoNode, type TwoNode } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { encodePacket } from '../harness/packet'
import { execute } from '../harness/executor'
import { EID_DST, EID_SRC } from '../harness/twonode'
import { pad } from 'viem'
import { collectEchoed, inboundPayloadHash, trySend, EMPTY } from './helpers'
import { pollUntil } from '../harness/poll'

// ULTIMATE ACCEPTANCE BASELINE (CA root).
// The arbitrary-data north star: send bytes A->B, delivered intact, exactly once, in order.
// RED until the protocol (P2) and the attestor worker (P3) are implemented.
describe('acceptance: arbitrary data transfer', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []

  beforeAll(async () => {
    buildWorker()
    net = await twoNode(2, 8600, 8610)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
  }, 120_000)

  afterAll(() => {
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function randBytes(n: number): Hex {
    const a = new Uint8Array(n)
    for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 0xff // deterministic, content-varied
    return bytesToHex(a)
  }

  test('arbitrary bytes delivered intact, in order', async () => {
    const payloads = [randBytes(1), randBytes(64), randBytes(4096)]
    for (const p of payloads) await trySend(net.sctx, net.appSrc, p)

    // real attestors must drive commit on the dst; then the harness (executor role) delivers.
    const delivered = await pollUntil(async () => (await collectEchoed(net.dctx, net.appDst)).length >= payloads.length, 60_000)

    if (delivered) {
      // execution step (harness as executor) once committed — happens inside the loop in a full build;
      // here we assert the end state the protocol must reach.
    }

    const received = await collectEchoed(net.dctx, net.appDst)
    expect(received).toEqual(payloads) // intact + in order
  })

  test('exactly once: a delivered message cannot be re-executed', async () => {
    const message = randBytes(32)
    await trySend(net.sctx, net.appSrc, message)
    const nonce = 1n
    const { guid, payloadHash } = encodePacket(nonce, EID_SRC, net.appSrc, EID_DST, net.appDst, message)

    const committed = await pollUntil(async () => (await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, nonce)) === payloadHash, 60_000)
    expect(committed).toBe(true) // RED until P2/P3

    await execute(net.dctx, { srcEid: EID_SRC, sender: pad(net.appSrc, { size: 32 }), nonce }, net.appDst, guid, message)
    const cleared = await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, nonce)
    expect(cleared).toBe(EMPTY)
    // re-execution must revert (hash cleared)
    await expect(
      execute(net.dctx, { srcEid: EID_SRC, sender: pad(net.appSrc, { size: 32 }), nonce }, net.appDst, guid, message),
    ).rejects.toBeTruthy()
  })
})
