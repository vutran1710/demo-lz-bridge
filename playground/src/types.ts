import type { Hex } from 'viem'

export type ChainCfg = { key: string; eid: number; rpc: string; endpoint: Hex; sendLib: Hex; receiveLib: Hex }
export type WalletCfg = { label: string; address: Hex; key: Hex; apps: Record<string, Hex> } // eid -> app
export type WorkerCfg = { id: string; role: 'dvn' | 'executor'; status: string; addresses: Hex[] }
export type WorkerActivity = {
  seq: number
  timestamp: number
  workerId: string
  role: 'dvn' | 'executor'
  pathway?: string
  action: string
  status: string
  contract?: string
  contractAddress?: Hex | string
  method?: string
  txHash?: Hex | string
  guid?: Hex | string
  nonce?: number
  srcEid?: number
  dstEid?: number
  sender?: Hex | string
  receiver?: Hex | string
  payloadHash?: Hex | string
  detail?: string
  error?: string
}
export type WorkerStatus = {
  id: string
  role: 'dvn' | 'executor'
  online: boolean
  processed: number
  pathways: number
  events?: WorkerActivity[]
}
export type Deployment = {
  chains: ChainCfg[]
  wallets: WalletCfg[]
  workers?: WorkerCfg[]
  dvnSet?: { configured: number; threshold: number }
}
