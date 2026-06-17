import type { Hex } from 'viem'

export type ChainCfg = { key: string; eid: number; rpc: string; endpoint: Hex; receiveLib: Hex }
export type WalletCfg = { label: string; address: Hex; key: Hex; apps: Record<string, Hex> } // eid -> app
export type WorkerCfg = { id: string; role: 'dvn' | 'executor'; status: string; addresses: Hex[] }
export type Deployment = {
  chains: ChainCfg[]
  wallets: WalletCfg[]
  workers?: WorkerCfg[]
  dvnSet?: { configured: number; threshold: number }
}
