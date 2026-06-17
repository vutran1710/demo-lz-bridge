import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tight default so a stuck test fails fast instead of hanging. Long-running tests (e.g. the
    // 200-packet stress) set their own explicit per-test timeout. beforeAll builds the Go binary
    // and spins up 2 anvil nodes + workers, so hookTimeout gets more headroom.
    testTimeout: 45_000,
    hookTimeout: 90_000,
    fileParallelism: false, // each suite owns an anvil node + deploy; no cross-talk
  },
})
