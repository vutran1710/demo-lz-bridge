import { createPublicClient, createWalletClient, defineChain, http, type Hex, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ChainCfg } from './types'

// All anvil chains share id 31337; we address them by RPC. RPC URLs are same-origin proxy paths
// (/rpc/a|b|c) so a single Cloudflare tunnel serves UI + chain RPC.
const anvil = defineChain({ id: 31337, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } })

export function rpcUrl(proxyPath: string): string {
  return new URL(proxyPath, window.location.origin).href
}

export function publicFor(chain: ChainCfg): PublicClient {
  return createPublicClient({ chain: anvil, transport: http(rpcUrl(chain.rpc)) })
}

export function walletFor(chain: ChainCfg, key: Hex): WalletClient {
  return createWalletClient({ account: privateKeyToAccount(key), chain: anvil, transport: http(rpcUrl(chain.rpc)) })
}
