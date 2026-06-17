import { keccak256, slice, type Hex } from 'viem'
import type { Ctx } from './deploy'
import { ABI } from './abis'

// M1 SHIM (removed in P4.M3 once the real Executor commits): a tiny commit-stage that mirrors what
// the Executor will do — watch source PacketSent, and once the dst threshold is met, call
// commitVerification. The DVN/attestor is verify-only, so something must commit until the Go
// Executor exists. Pipelined (block cursor + pending queue + explicit nonce, no per-tx receipt
// wait) so it keeps up with the 200-packet stress test.
export type CommitterHandle = { stop: () => void }

type Msg = { header: Hex; payloadHash: Hex }

export function startCommitter(sctx: Ctx, dctx: Ctx): CommitterHandle {
  let running = true
  const pending = new Map<string, Msg>()
  let fromBlock = 0n
  let nonce = 0

  const loop = async () => {
    const w = dctx.wallets[0]
    nonce = await dctx.pub.getTransactionCount({ address: w.account!.address, blockTag: 'pending' })
    while (running) {
      try {
        // 1) discover new PacketSent since the cursor
        const latest = await sctx.pub.getBlockNumber()
        if (latest >= fromBlock) {
          const logs = await sctx.pub.getContractEvents({
            address: sctx.sendLib, abi: ABI.SendLib.abi, eventName: 'PacketSent', fromBlock, toBlock: latest,
          })
          for (const l of logs) {
            const encoded = (l as any).args.encodedPacket as Hex
            const header = slice(encoded, 0, 81)
            const payloadHash = keccak256(slice(encoded, 81)) // keccak(guid ‖ message)
            pending.set(`${header}:${payloadHash}`, { header, payloadHash })
          }
          fromBlock = latest + 1n
        }
        // 2) commit any pending message whose threshold is now met (fire-and-forget, explicit nonce)
        for (const [key, m] of pending) {
          const ok = (await dctx.pub.readContract({
            address: dctx.receiveLib, abi: ABI.ReceiveLib.abi, functionName: 'verifiable', args: [m.header, m.payloadHash],
          })) as boolean
          if (!ok) continue
          try {
            await w.writeContract({
              address: dctx.receiveLib, abi: ABI.ReceiveLib.abi, functionName: 'commitVerification',
              args: [m.header, m.payloadHash], account: w.account!, chain: w.chain, nonce,
            })
            nonce++
            pending.delete(key)
          } catch {
            // not verifiable / already committed / nonce race — retry next pass
          }
        }
      } catch {
        // transient RPC error — retry
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  void loop()
  return { stop: () => (running = false) }
}
