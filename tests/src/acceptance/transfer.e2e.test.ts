import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, pad, type Hex } from 'viem'
import { twoNode, type TwoNode, EID_DST, EID_SRC } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { encodePacket } from '../harness/packet'
import { execute } from '../harness/executor'
import { ABI } from '../harness/abis'
import { collectEchoed, inboundPayloadHash, trySend, EMPTY } from './helpers'
import { pollUntil } from '../harness/poll'

// ULTIMATE ACCEPTANCE BASELINE (CA root): send arbitrary bytes A->B, delivered intact, in order,
// exactly once. Real M-of-N attestor processes drive verify->commit; the harness plays the
// executor (subsystem 3) and calls lzReceive once a message is committed.
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
    for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 0xff
    return bytesToHex(a)
  }

  async function nextOutboundNonce(): Promise<bigint> {
    const cur = (await net.sctx.pub.readContract({
      address: net.sctx.endpoint,
      abi: ABI.Endpoint.abi,
      functionName: 'outboundNonce',
      args: [net.appSrc, EID_DST, pad(net.appDst, { size: 32 })],
    })) as bigint
    return cur + 1n
  }

  async function deliver(nonce: bigint, message: Hex) {
    const { guid, payloadHash } = encodePacket(nonce, EID_SRC, net.appSrc, EID_DST, net.appDst, message)
    const committed = await pollUntil(
      async () => (await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, nonce)) === payloadHash,
      60_000,
    )
    expect(committed).toBe(true) // attestors must have driven the commit
    await execute(net.dctx, { srcEid: EID_SRC, sender: pad(net.appSrc, { size: 32 }), nonce }, net.appDst, guid, message)
    return { guid, payloadHash }
  }

  test('arbitrary bytes delivered intact, in order', async () => {
    const payloads = [randBytes(1), randBytes(64), randBytes(4096)]
    const base = await nextOutboundNonce()
    for (const p of payloads) await trySend(net.sctx, net.appSrc, p)
    for (let i = 0; i < payloads.length; i++) await deliver(base + BigInt(i), payloads[i])

    const received = await collectEchoed(net.dctx, net.appDst)
    expect(received).toEqual(payloads) // intact + in order
  })

  test('exactly once: a delivered message cannot be re-executed', async () => {
    const message = randBytes(32)
    const nonce = await nextOutboundNonce()
    await trySend(net.sctx, net.appSrc, message)
    const { guid } = await deliver(nonce, message)

    expect(await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, nonce)).toBe(EMPTY) // cleared
    await expect(
      execute(net.dctx, { srcEid: EID_SRC, sender: pad(net.appSrc, { size: 32 }), nonce }, net.appDst, guid, message),
    ).rejects.toBeTruthy() // replay reverts
  })
})
