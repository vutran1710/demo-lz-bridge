import { pad, type Hex } from 'viem'
import type { Ctx } from '../harness/deploy'
import { ABI } from '../harness/abis'
import { EID_SRC } from '../harness/twonode'

const EMPTY = ('0x' + '0'.repeat(64)) as Hex

// Send arbitrary bytes from the source app. Tolerant of NotImplemented reverts (pre-P2) so the
// acceptance suite fails on the END assertion (not delivered) rather than throwing during setup —
// keeping the red signal about behavior, not wiring.
export async function trySend(sctx: Ctx, appSrc: Hex, message: Hex): Promise<void> {
  try {
    const w = sctx.wallets[0]
    const hash = await w.writeContract({
      address: appSrc,
      abi: ABI.AppEcho.abi,
      functionName: 'sendMessage',
      args: [2, message],
      value: 0n,
      account: w.account!,
      chain: w.chain,
    })
    await sctx.pub.waitForTransactionReceipt({ hash })
  } catch {
    // protocol not implemented yet — acceptance assertion will report non-delivery
  }
}

export async function inboundPayloadHash(dctx: Ctx, appDst: Hex, appSrc: Hex, nonce: bigint): Promise<Hex> {
  return dctx.pub.readContract({
    address: dctx.endpoint,
    abi: ABI.Endpoint.abi,
    functionName: 'inboundPayloadHash',
    args: [appDst, EID_SRC, pad(appSrc, { size: 32 }), nonce],
  }) as Promise<Hex>
}

export async function inboundNonce(dctx: Ctx, appDst: Hex, appSrc: Hex): Promise<bigint> {
  return dctx.pub.readContract({
    address: dctx.endpoint,
    abi: ABI.Endpoint.abi,
    functionName: 'inboundNonce',
    args: [appDst, EID_SRC, pad(appSrc, { size: 32 })],
  }) as Promise<bigint>
}

// Collect Echoed(message) events emitted by the destination AppEcho, in block/log order.
export async function collectEchoed(dctx: Ctx, appDst: Hex): Promise<Hex[]> {
  const logs = await dctx.pub.getContractEvents({
    address: appDst,
    abi: ABI.AppEcho.abi,
    eventName: 'Echoed',
    fromBlock: 0n,
    toBlock: 'latest',
  })
  return logs.map((l: any) => l.args.message as Hex)
}

export { EMPTY }
