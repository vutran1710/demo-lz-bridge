import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { stringToHex } from 'viem'
import { startAnvil, type AnvilHandle } from '../harness/anvil'
import { clients } from '../harness/clients'
import { deployStack, type Ctx } from '../harness/deploy'
import { deployApp, sendFrom } from '../harness/app'
import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { pollUntil } from '../harness/poll'

// P0 CA gate: the stack deploys, a worker process spawns, and a `send` reverts NotImplemented
// (proves deploy + wiring; protocol logic is intentionally absent until P2/P3).
describe('P0 conformance gate', () => {
  let node: AnvilHandle
  let ctx: Ctx
  let app: `0x${string}`

  beforeAll(async () => {
    node = await startAnvil(8600)
    const { pub, wallets } = clients(node.rpc)
    ctx = await deployStack(node.rpc, 1, pub as any, wallets as any)
    app = await deployApp(ctx, 'AppEcho')
  })
  afterAll(() => node?.stop())

  test('skeleton stack deploys to a live node', () => {
    expect(ctx.endpoint).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(ctx.sendLib).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(ctx.receiveLib).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(app).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  test('send() reverts NotImplemented (logic withheld until P2)', async () => {
    await expect(sendFrom(ctx, app, 2, app, stringToHex('hello'))).rejects.toBeTruthy()
  })

  test('attestor binary builds and a process starts cleanly', async () => {
    buildWorker()
    let w: WorkerHandle | undefined
    try {
      w = startAttestor({
        ATTESTOR_ID: 'smoke',
        SRC_RPC: node.rpc,
        DST_RPC: node.rpc,
        SRC_ENDPOINT: ctx.endpoint,
        DST_RECEIVE_LIB: ctx.receiveLib,
        ATTESTOR_KEY: 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        CURSOR_PATH: `/tmp/smoke-${Date.now()}.cursor`,
      })
      expect(await pollUntil(async () => w!.sawStarted(), 10_000)).toBe(true)
    } finally {
      w?.stop()
    }
  })
})
