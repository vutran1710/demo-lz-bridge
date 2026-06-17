import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = resolve(__dirname, '../../../worker')
const BIN = resolve(WORKER_DIR, 'bin/attestor')

export function buildWorker() {
  execFileSync('go', ['build', '-o', BIN, './cmd/attestor'], { cwd: WORKER_DIR, stdio: 'inherit' })
}

export type WorkerHandle = { proc: ChildProcess; stop: () => void; sawStarted: () => boolean }

export function startAttestor(env: Record<string, string>): WorkerHandle {
  const proc = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: 'pipe' })
  let started = false
  const onData = (d: Buffer) => {
    const s = d.toString()
    if (s.includes('attestor started')) started = true
    process.stdout.write(`[${env.ATTESTOR_ID ?? '?'}] ${s}`)
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  return { proc, stop: () => proc.kill('SIGINT'), sawStarted: () => started }
}
