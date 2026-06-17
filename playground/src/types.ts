import type { Hex } from 'viem'

export type ChainCfg = { key: string; eid: number; rpc: string; endpoint: Hex; receiveLib: Hex }
export type WalletCfg = { label: string; address: Hex; key: Hex; apps: Record<string, Hex> } // eid -> app
export type Deployment = { chains: ChainCfg[]; wallets: WalletCfg[] }
