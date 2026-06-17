import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

// anvil default mnemonic accounts (index 0..3)
export const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]

export function clients(rpc: string) {
  const transport = http(rpc)
  const pub = createPublicClient({ chain: foundry, transport })
  const wallets = KEYS.map((k) =>
    createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport }),
  )
  return { pub, wallets, accounts: KEYS.map((k) => privateKeyToAccount(k)) }
}
