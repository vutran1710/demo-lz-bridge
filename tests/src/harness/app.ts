import { encodeAbiParameters, pad, type Hex } from 'viem'
import { ABI } from './abis'
import type { Ctx } from './deploy'

export async function deployApp(ctx: Ctx, kind: 'AppEcho' | 'AppRevert'): Promise<Hex> {
  const c = ABI[kind]
  const w = ctx.wallets[0]
  const hash = await w.deployContract({ abi: c.abi, bytecode: c.bytecode, args: [ctx.endpoint], account: w.account!, chain: w.chain })
  const r = await ctx.pub.waitForTransactionReceipt({ hash })
  return r.contractAddress as Hex
}

// encode UlnConfig into SetConfigParam.config (configType = 2)
export function ulnConfigBytes(
  confirmations: bigint,
  required: Hex[],
  optional: Hex[],
  threshold: number,
): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'confirmations', type: 'uint64' },
          { name: 'requiredAttestors', type: 'address[]' },
          { name: 'optionalAttestors', type: 'address[]' },
          { name: 'optionalThreshold', type: 'uint8' },
        ],
      },
    ],
    [{ confirmations, requiredAttestors: required, optionalAttestors: optional, optionalThreshold: threshold }],
  )
}

async function write(ctx: Ctx, address: Hex, abi: any, functionName: string, args: any[]) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({ address, abi, functionName, args, account: w.account!, chain: w.chain })
  return ctx.pub.waitForTransactionReceipt({ hash })
}

// Configure a directed channel src(eidA) -> dst(eidB): peers on both apps, libs, ULN M-of-N config on receiver.
export async function wireChannel(
  ctx: Ctx,
  appA: Hex,
  appB: Hex,
  eidA: number,
  eidB: number,
  optionalAttestorIdxs: number[],
  requiredAttestorIdxs: number[],
  optThreshold: number,
) {
  const optional = optionalAttestorIdxs.map((i) => ctx.wallets[i].account!.address as Hex)
  const required = requiredAttestorIdxs.map((i) => ctx.wallets[i].account!.address as Hex)

  await write(ctx, appA, ABI.AppEcho.abi, 'setPeer', [eidB, pad(appB, { size: 32 })])
  await write(ctx, appB, ABI.AppEcho.abi, 'setPeer', [eidA, pad(appA, { size: 32 })])

  for (const app of [appA, appB]) {
    await write(ctx, ctx.endpoint, ABI.Endpoint.abi, 'setSendLibrary', [app, eidB, ctx.sendLib])
    await write(ctx, ctx.endpoint, ABI.Endpoint.abi, 'setReceiveLibrary', [app, eidA, ctx.receiveLib, 0n])
  }

  const cfg = ulnConfigBytes(1n, required, optional, optThreshold)
  await write(ctx, ctx.endpoint, ABI.Endpoint.abi, 'setConfig', [
    appB,
    ctx.receiveLib,
    [{ eid: eidA, configType: 2, config: cfg }],
  ])
}

export async function sendFrom(ctx: Ctx, app: Hex, dstEid: number, _receiver: Hex, message: Hex) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({
    address: app,
    abi: ABI.AppEcho.abi,
    functionName: 'sendMessage',
    args: [dstEid, message],
    value: 0n,
    account: w.account!,
    chain: w.chain,
  })
  return ctx.pub.waitForTransactionReceipt({ hash })
}
