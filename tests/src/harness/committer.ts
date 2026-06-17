import { keccak256, slice, type Hex } from 'viem'
import type { Ctx } from './deploy'
import { ABI } from './abis'

// M1 SHIM (removed in P4.M3 once the real Executor commits): a tiny commit-stage that mirrors what
// the Executor will do — watch source PacketSent, and once the dst threshold is met, call
// commitVerification. The DVN/attestor is verify-only, so something must commit; until the Go
// Executor exists, the harness does it. lzReceive (delivery) is still driven by the harness executor.
export type CommitterHandle = { stop: () => void }

export function startCommitter(sctx: Ctx, dctx: Ctx): CommitterHandle {
  let running = true
  const committed = new Set<string>()

  const loop = async () => {
    while (running) {
      try {
        const logs = await sctx.pub.getContractEvents({
          address: sctx.sendLib,
          abi: ABI.SendLib.abi,
          eventName: 'PacketSent',
          fromBlock: 0n,
          toBlock: 'latest',
        })
        for (const l of logs) {
          const encoded = (l as any).args.encodedPacket as Hex
          const header = slice(encoded, 0, 81)
          const payloadHash = keccak256(slice(encoded, 81)) // keccak(guid ‖ message)
          const key = `${header}:${payloadHash}`
          if (committed.has(key)) continue
          const ok = (await dctx.pub.readContract({
            address: dctx.receiveLib,
            abi: ABI.ReceiveLib.abi,
            functionName: 'verifiable',
            args: [header, payloadHash],
          })) as boolean
          if (!ok) continue
          const w = dctx.wallets[0]
          try {
            const hash = await w.writeContract({
              address: dctx.receiveLib,
              abi: ABI.ReceiveLib.abi,
              functionName: 'commitVerification',
              args: [header, payloadHash],
              account: w.account!,
              chain: w.chain,
            })
            await dctx.pub.waitForTransactionReceipt({ hash })
            committed.add(key)
          } catch {
            // not verifiable yet / already committed — retry next pass
          }
        }
      } catch {
        // transient RPC error — retry
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  void loop()
  return { stop: () => (running = false) }
}
