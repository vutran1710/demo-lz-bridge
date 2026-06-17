import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(__dirname, '../../../worker')
const BIN = resolve(WORKER_DIR, 'bin/executor')

export function buildExecutor() {
  execFileSync('go', ['build', '-o', BIN, './cmd/executor'], { cwd: WORKER_DIR, stdio: 'inherit' })
}

export type ExecutorHandle = { proc: ChildProcess; stop: () => void; sawStarted: () => boolean }

export function startExecutor(env: Record<string, string>): ExecutorHandle {
  const proc = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: 'pipe' })
  let started = false
  const onData = (d: Buffer) => {
    const s = d.toString()
    if (s.includes('executor started')) started = true
    process.stdout.write(`[${env.EXECUTOR_ID ?? 'exec'}] ${s}`)
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  return { proc, stop: () => proc.kill('SIGINT'), sawStarted: () => started }
}
