import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { encodeAbiParameters, stringToHex, type Hex } from 'viem'
import { startAnvil, type AnvilHandle } from '../harness/anvil'
import { clients } from '../harness/clients'
import { deployStack, type Ctx } from '../harness/deploy'
import { deployApp, wireChannel } from '../harness/app'
import { encodePacket } from '../harness/packet'
import { attest, commit } from '../harness/attest'
import { ABI } from '../harness/abis'

// P4.M0 contract integration: ExecutorConfig set/get + ReceiveLib.verifiable transition.
const EID = 2

describe('executor config + verifiable', () => {
  let node: AnvilHandle
  let ctx: Ctx
  let appA: Hex
  let appB: Hex

  beforeAll(async () => {
    node = await startAnvil(8680)
    const { pub, wallets } = clients(node.rpc)
    ctx = await deployStack(node.rpc, EID, pub as any, wallets as any)
    appA = await deployApp(ctx, 'AppEcho')
    appB = await deployApp(ctx, 'AppEcho')
    await wireChannel(ctx, appA, appB, EID, EID, [1, 2, 3], [], 2)
  })
  afterAll(() => node?.stop())

  test('ExecutorConfig set via Endpoint.setConfig is retrievable', async () => {
    const cfg = encodeAbiParameters(
      [{ type: 'tuple', components: [
        { name: 'maxMessageSize', type: 'uint32' },
        { name: 'executor', type: 'address' },
        { name: 'lzReceiveGas', type: 'uint128' },
      ] }],
      [{ maxMessageSize: 10000, executor: appA, lzReceiveGas: 200000n }],
    )
    const w = ctx.wallets[0]
    await ctx.pub.waitForTransactionReceipt({
      hash: await w.writeContract({
        address: ctx.endpoint, abi: ABI.Endpoint.abi, functionName: 'setConfig',
        args: [appB, ctx.executorConfig, [{ eid: EID, configType: 1, config: cfg }]],
        account: w.account!, chain: w.chain,
      }),
    })
    const got = (await ctx.pub.readContract({
      address: ctx.executorConfig, abi: ABI.ExecutorConfig.abi, functionName: 'getConfig', args: [appB, EID],
    })) as { maxMessageSize: number; executor: Hex; lzReceiveGas: bigint }
    expect(got.lzReceiveGas).toBe(200000n)
    expect(got.maxMessageSize).toBe(10000)
  })

  test('verifiable() goes false → true at threshold → false after commit', async () => {
    const message = stringToHex('verifiable-check')
    const { header, payloadHash } = encodePacket(1n, EID, appA, EID, appB, message)
    const w = ctx.wallets[0]
    await ctx.pub.waitForTransactionReceipt({
      hash: await w.writeContract({ address: appA, abi: ABI.AppEcho.abi, functionName: 'sendMessage', args: [EID, message], account: w.account!, chain: w.chain }),
    })
    const isVerifiable = () =>
      ctx.pub.readContract({ address: ctx.receiveLib, abi: ABI.ReceiveLib.abi, functionName: 'verifiable', args: [header, payloadHash] }) as Promise<boolean>

    expect(await isVerifiable()).toBe(false)
    await attest(ctx, [1], header, payloadHash)
    expect(await isVerifiable()).toBe(false) // 1 of 2
    await attest(ctx, [2], header, payloadHash)
    expect(await isVerifiable()).toBe(true) // threshold met
    await commit(ctx, header, payloadHash)
    expect(await isVerifiable()).toBe(false) // committed
  })
})
