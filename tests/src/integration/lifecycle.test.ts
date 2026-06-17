import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { pad, stringToHex, type Hex } from 'viem'
import { startAnvil, type AnvilHandle } from '../harness/anvil'
import { clients } from '../harness/clients'
import { deployStack, type Ctx } from '../harness/deploy'
import { deployApp, wireChannel } from '../harness/app'
import { encodePacket } from '../harness/packet'
import { attest, commit } from '../harness/attest'
import { execute } from '../harness/executor'
import { ABI } from '../harness/abis'

// Protocol-core integration tier (P2). Single-node loopback channel (eid 2, src==dst) exercises the
// full contract path via harness-as-executor — no worker needed. M-of-N = 2-of-3.
const EID = 2
const EMPTY = ('0x' + '0'.repeat(64)) as Hex

describe('protocol-core integration', () => {
  let node: AnvilHandle
  let ctx: Ctx
  let appA: Hex
  let appB: Hex

  beforeAll(async () => {
    node = await startAnvil(8660)
    const { pub, wallets } = clients(node.rpc)
    ctx = await deployStack(node.rpc, EID, pub as any, wallets as any)
    appA = await deployApp(ctx, 'AppEcho')
    appB = await deployApp(ctx, 'AppEcho')
    await wireChannel(ctx, appA, appB, EID, EID, [1, 2, 3], [], 2)
  })
  afterAll(() => node?.stop())

  async function sendMsg(message: Hex) {
    const w = ctx.wallets[0]
    const hash = await w.writeContract({
      address: appA,
      abi: ABI.AppEcho.abi,
      functionName: 'sendMessage',
      args: [EID, message],
      account: w.account!,
      chain: w.chain,
    })
    return ctx.pub.waitForTransactionReceipt({ hash })
  }
  const committedHash = (nonce: bigint) =>
    ctx.pub.readContract({
      address: ctx.endpoint,
      abi: ABI.Endpoint.abi,
      functionName: 'inboundPayloadHash',
      args: [appB, EID, pad(appA, { size: 32 }), nonce],
    }) as Promise<Hex>
  const origin = (nonce: bigint) => ({ srcEid: EID, sender: pad(appA, { size: 32 }), nonce })

  test('happy path: send → verify(2-of-3) → commit → execute, delivered exactly once', async () => {
    const message = stringToHex('hello-omnichain')
    const { guid, header, payloadHash } = encodePacket(1n, EID, appA, EID, appB, message)
    await sendMsg(message)
    await attest(ctx, [1, 2], header, payloadHash)
    await commit(ctx, header, payloadHash)
    expect(await committedHash(1n)).toBe(payloadHash)

    const rcpt = await execute(ctx, origin(1n), appB, guid, message)
    const echoed = rcpt.logs.find((l) => l.address.toLowerCase() === appB.toLowerCase())
    expect(echoed).toBeTruthy()
    expect(await committedHash(1n)).toBe(EMPTY) // cleared → exactly once
    await expect(execute(ctx, origin(1n), appB, guid, message)).rejects.toBeTruthy() // replay reverts
  })

  test('under threshold does not commit; exact threshold commits', async () => {
    const message = stringToHex('threshold')
    const { header, payloadHash } = encodePacket(2n, EID, appA, EID, appB, message)
    await sendMsg(message)
    await attest(ctx, [1], header, payloadHash) // 1 of 2
    await expect(commit(ctx, header, payloadHash)).rejects.toBeTruthy()
    await attest(ctx, [2], header, payloadHash) // now 2 of 2
    await commit(ctx, header, payloadHash)
    expect(await committedHash(2n)).toBe(payloadHash)
  })

  test('double-commit reverts', async () => {
    const message = stringToHex('threshold')
    const { header, payloadHash } = encodePacket(2n, EID, appA, EID, appB, message)
    await expect(commit(ctx, header, payloadHash)).rejects.toBeTruthy()
  })

  test('mutated message rejected at execute (payload hash mismatch)', async () => {
    // nonce 2 is committed for the real message; executing with different bytes must revert
    const { guid } = encodePacket(2n, EID, appA, EID, appB, stringToHex('threshold'))
    await expect(execute(ctx, origin(2n), appB, guid, stringToHex('TAMPERED'))).rejects.toBeTruthy()
  })

  test('out-of-order commit rejected (gap-free)', async () => {
    const m4 = stringToHex('n4')
    await sendMsg(stringToHex('n3')) // nonce 3
    await sendMsg(m4) // nonce 4
    const p4 = encodePacket(4n, EID, appA, EID, appB, m4)
    await attest(ctx, [1, 2], p4.header, p4.payloadHash)
    await expect(commit(ctx, p4.header, p4.payloadHash)).rejects.toBeTruthy() // nonce 3 not committed yet
  })

  test('ordered execution and park/retry via a reverting receiver', async () => {
    // fresh channel with a reverting receiver
    const appR = await deployApp(ctx, 'AppRevert')
    await wireChannel(ctx, appA, appR, EID, EID, [1, 2, 3], [], 2)
    const message = stringToHex('retry-me')
    const w0 = ctx.wallets[0]
    // appA already has peer for EID set to appB from earlier wiring; re-point to appR for this send
    await ctx.pub.waitForTransactionReceipt({
      hash: await w0.writeContract({ address: appA, abi: ABI.AppEcho.abi, functionName: 'setPeer', args: [EID, pad(appR, { size: 32 })], account: w0.account!, chain: w0.chain }),
    })
    // appA outbound nonce to appR starts at 1 (distinct receiver)
    const { guid, header, payloadHash } = encodePacket(1n, EID, appA, EID, appR, message)
    await ctx.pub.waitForTransactionReceipt({
      hash: await w0.writeContract({ address: appA, abi: ABI.AppEcho.abi, functionName: 'sendMessage', args: [EID, message], account: w0.account!, chain: w0.chain }),
    })
    await attest(ctx, [1, 2], header, payloadHash)
    await commit(ctx, header, payloadHash)
    const originR = { srcEid: EID, sender: pad(appA, { size: 32 }), nonce: 1n }
    // failing receiver → execute reverts, hash stays committed (parked)
    await expect(execute(ctx, originR, appR, guid, message)).rejects.toBeTruthy()
    const stillThere = (await ctx.pub.readContract({ address: ctx.endpoint, abi: ABI.Endpoint.abi, functionName: 'inboundPayloadHash', args: [appR, EID, pad(appA, { size: 32 }), 1n] })) as Hex
    expect(stillThere).toBe(payloadHash)
    // fix receiver, retry succeeds
    await ctx.pub.waitForTransactionReceipt({
      hash: await w0.writeContract({ address: appR, abi: ABI.AppRevert.abi, functionName: 'setFailing', args: [false], account: w0.account!, chain: w0.chain }),
    })
    await execute(ctx, originR, appR, guid, message)
    const cleared = (await ctx.pub.readContract({ address: ctx.endpoint, abi: ABI.Endpoint.abi, functionName: 'inboundPayloadHash', args: [appR, EID, pad(appA, { size: 32 }), 1n] })) as Hex
    expect(cleared).toBe(EMPTY)
  })
})
