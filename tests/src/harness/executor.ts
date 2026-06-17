import type { Hex } from 'viem'
import type { Ctx } from './deploy'

// The harness plays the executor role until subsystem 3 exists: it calls Endpoint.lzReceive
// on the destination to deliver a committed message. Returns the receipt (throws if it reverts).
export async function execute(
  ctx: Ctx,
  origin: { srcEid: number; sender: Hex; nonce: bigint },
  receiver: Hex,
  guid: Hex,
  message: Hex,
) {
  const w = ctx.wallets[0]
  const hash = await w.writeContract({
    address: ctx.endpoint,
    abi: ctx.abi.Endpoint.abi,
    functionName: 'lzReceive',
    args: [origin, receiver, guid, message, '0x'],
    account: w.account!,
    chain: w.chain,
  })
  return ctx.pub.waitForTransactionReceipt({ hash })
}
