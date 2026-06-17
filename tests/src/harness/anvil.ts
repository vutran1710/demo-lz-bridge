import { spawn, type ChildProcess } from 'node:child_process'

export type AnvilHandle = { rpc: string; stop: () => void }

// Default ports avoid 8545, which commonly collides with Docker/other local services.
export async function startAnvil(port = 8600): Promise<AnvilHandle> {
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--silent', '--chain-id', '31337'])
  const rpc = `http://127.0.0.1:${port}`
  await waitForRpc(rpc)
  return { rpc, stop: () => proc.kill('SIGKILL') }
}

// Confirm the endpoint is *our* anvil (chainId 31337) and actually mines, not some other service on the port.
async function waitForRpc(rpc: string) {
  for (let i = 0; i < 100; i++) {
    try {
      const chainId = await rpcCall(rpc, 'eth_chainId', [])
      if (chainId === '0x7a69') return // 31337
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`anvil did not start (or wrong service) on ${rpc}`)
}

async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`)
  const json = (await res.json()) as { result?: unknown; error?: unknown }
  if (json.error) throw new Error(`rpc ${method} error: ${JSON.stringify(json.error)}`)
  return json.result
}
