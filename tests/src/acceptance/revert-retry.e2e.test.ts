import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { stringToHex } from 'viem'
import { twoNode, type TwoNode, EID_DST, EID_SRC } from '../harness/twonode'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { buildExecutor, startExecutor, type ExecutorHandle } from '../harness/executorproc'
import { encodePacket } from '../harness/packet'
import { ABI } from '../harness/abis'
import { trySend, inboundPayloadHash, EMPTY } from './helpers'
import { pollUntil, sleep } from '../harness/poll'

// Sad path: a reverting receiver parks the message (committed, not delivered); the executor retries
// with backoff and delivers once the receiver stops reverting. Nonce is never skipped.
describe('sad-path: reverting receiver → retry', () => {
  let net: TwoNode
  let workers: WorkerHandle[] = []
  let exec: ExecutorHandle

  beforeAll(async () => {
    buildWorker()
    buildExecutor()
    net = await twoNode(2, 8704, 8714, 'AppRevert') // dst app reverts on demand (starts failing)
    workers = net.attestorIdxs.map((i) => startAttestor(net.attestorEnv(i)))
    exec = startExecutor(net.executorEnv())
  }, 120_000)

  afterAll(() => {
    exec?.stop()
    workers.forEach((w) => w.stop())
    net?.stop()
  })

  test(
    'parked while reverting, delivered after fix',
    async () => {
      const message = stringToHex('retry-me')
      const { payloadHash } = encodePacket(1n, EID_SRC, net.appSrc, EID_DST, net.appDst, message)
      await trySend(net.sctx, net.appSrc, message)

      // committed (verified) but parked: hash stays set because lzReceive reverts
      expect(await pollUntil(async () => (await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, 1n)) === payloadHash, 20_000)).toBe(true)
      await sleep(2000)
      expect(await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, 1n)).toBe(payloadHash) // still parked

      // stop reverting → executor retry delivers (hash cleared)
      const w = net.dctx.wallets[0]
      await net.dctx.pub.waitForTransactionReceipt({
        hash: await w.writeContract({ address: net.appDst, abi: ABI.AppRevert.abi, functionName: 'setFailing', args: [false], account: w.account!, chain: w.chain }),
      })
      expect(await pollUntil(async () => (await inboundPayloadHash(net.dctx, net.appDst, net.appSrc, 1n)) === EMPTY, 20_000)).toBe(true)
    },
    50_000,
  )
})
