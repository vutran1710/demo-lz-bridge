import type { Hex } from 'viem'
import type { Ctx } from './deploy'

// Submit ReceiveLib.verify(header, payloadHash, confirmations) from each given attestor account index.
export async function attest(
  ctx: Ctx,
  attestorIdxs: number[],
  header: Hex,
  payloadHash: Hex,
  confirmations: bigint = 1n,
) {
  for (const i of attestorIdxs) {
    const w = ctx.wallets[i]
    const hash = await w.writeContract({
      address: ctx.receiveLib,
      abi: ctx.abi.ReceiveLib.abi,
      functionName: 'verify',
      args: [header, payloadHash, confirmations],
      account: w.account!,
      chain: w.chain,
    })
    await ctx.pub.waitForTransactionReceipt({ hash })
  }
}

export async function commit(ctx: Ctx, header: Hex, payloadHash: Hex) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({
    address: ctx.receiveLib,
    abi: ctx.abi.ReceiveLib.abi,
    functionName: 'commitVerification',
    args: [header, payloadHash],
    account: w.account!,
    chain: w.chain,
  })
  return ctx.pub.waitForTransactionReceipt({ hash })
}
