import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, pad, type Hex } from 'viem'
import { twoNode, type TwoNode, EID_DST, EID_SRC } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { encodePacket } from '../harness/packet'
import { execute } from '../harness/executor'
import { collectEchoed, trySend } from './helpers'
import { pollUntil } from '../harness/poll'

// ULTIMATE ACCEPTANCE BASELINE: arbitrary bytes A→B delivered intact, in order, exactly once —
// driven autonomously by real DVN attestors (verify) + the real Executor (commit + deliver).
describe('acceptance: arbitrary data transfer', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8600, 8610)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
    exec = startExecutor(net.executorEnv())
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  function randBytes(n: number): Hex {
    const a = new Uint8Array(n)
    for (let i = 0; i < n; i++) a[i] = (i * 31 + 7) & 0xff
    return bytesToHex(a)
  }

  test(
    'arbitrary bytes delivered intact, in order (autonomous)',
    async () => {
      const payloads = [randBytes(1), randBytes(64), randBytes(4096)]
      for (const p of payloads) await trySend(net.sctx, net.appSrc, p)
      const ok = await pollUntil(
        async () => (await collectEchoed(net.dctx, net.appDst)).length >= payloads.length,
        40_000,
      )
      expect(ok).toBe(true)
      expect(await collectEchoed(net.dctx, net.appDst)).toEqual(payloads) // intact + in order
    },
    50_000,
  )

  test(
    'exactly once: delivered once and not re-executable',
    async () => {
      const before = (await collectEchoed(net.dctx, net.appDst)).length
      const message = randBytes(32)
      const nonce = BigInt(before + 1)
      await trySend(net.sctx, net.appSrc, message)
      const ok = await pollUntil(
        async () => (await collectEchoed(net.dctx, net.appDst)).length === before + 1,
        40_000,
      )
      expect(ok).toBe(true)

      // re-executing the (already delivered, cleared) message must revert
      const { guid } = encodePacket(nonce, EID_SRC, net.appSrc, EID_DST, net.appDst, message)
      await expect(
        execute(net.dctx, { srcEid: EID_SRC, sender: pad(net.appSrc, { size: 32 }), nonce }, net.appDst, guid, message),
      ).rejects.toBeTruthy()
    },
    50_000,
  )
})
