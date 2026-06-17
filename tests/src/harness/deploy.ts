import type { Hex, PublicClient, WalletClient } from 'viem'
import { ABI } from './abis'

export type Ctx = {
  rpc: string
  eid: number
  endpoint: Hex
  sendLib: Hex
  receiveLib: Hex
  executorConfig: Hex
  pub: PublicClient
  wallets: WalletClient[]
  abi: typeof ABI
}

// Deploys Endpoint(eid) + SendLib + ReceiveLib on one node and returns a context object.
export async function deployStack(
  rpc: string,
  eid: number,
  pub: PublicClient,
  wallets: WalletClient[],
): Promise<Ctx> {
  async function deploy(c: { abi: any; bytecode: Hex }, args: any[] = []): Promise<Hex> {
    const hash = await wallets[0].deployContract({ abi: c.abi, bytecode: c.bytecode, args, account: wallets[0].account!, chain: wallets[0].chain })
    const r = await pub.waitForTransactionReceipt({ hash })
    return r.contractAddress as Hex
  }
  const executorConfig = await deploy(ABI.ExecutorConfig, [])
  const endpoint = await deploy(ABI.Endpoint, [eid, executorConfig])
  const sendLib = await deploy(ABI.SendLib, [endpoint])
  const receiveLib = await deploy(ABI.ReceiveLib, [endpoint])
  return { rpc, eid, endpoint, sendLib, receiveLib, executorConfig, pub, wallets, abi: ABI }
}
