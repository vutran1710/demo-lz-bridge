# Cross-Chain Messaging Bridge — Overall Program Plan

> **Reading order:** (1) Overall design → `docs/superpowers/specs/2026-06-17-bridge-protocol-architecture-design.md`. (2) This overall plan. (3) Per-subsystem plans → `2026-06-17-protocol-core.md`, `2026-06-17-attestor-worker.md`.

**Goal:** Deliver a generic cross-chain message-passing protocol between two permissioned EVM chains (LZ-V2-faithful), proven by an acceptance baseline that transfers arbitrary data exactly-once and in order.

**Governing principle (user-mandated):**
1. **Acceptance baseline first.** The **e2e + stress** suites are authored before any component logic and are the program's *ultimate* Conformance/Acceptance (CA) baseline. Arbitrary-data transfer makes them simple to express: *send bytes A→B, assert delivered intact, exactly once, in order.*
2. **TDD per implementation.** Each subsystem: **integration suite first** (TS/Vitest, red), then **unit-test TDD per step** (Foundry `forge test` / `go test`).
3. **Per-milestone CA.** No milestone is "done" until its CA gate passes (or is red-by-design at baseline).

**Tech stack:** Solidity/Foundry (contracts), Go/go-ethereum (workers), TypeScript + Vitest + viem (acceptance + integration), Anvil (local nodes).

---

## Program structure

```
P0  Skeletons & scaffold        (just enough to deploy/spawn so suites can run red)
P1  Acceptance baseline         (e2e + stress authored RED — the CA baseline)   ← FIRST
P2  Protocol core               (subsystem 1, TDD: integration → unit/step)
P3  Attestor worker             (subsystem 2, TDD: integration → unit/step)
                                 ⇒ acceptance baseline turns GREEN
```

Why P0 precedes P1: the acceptance suites must **compile, deploy, and spawn** to be meaningfully red (failing on missing behavior, not on harness/compile errors). P0 delivers reverting contract skeletons + a no-op worker binary + harness wiring — no logic. P1 then authors the acceptance scenarios against that surface.

---

## Program milestones & CA gates

| # | Milestone | Spanned plan(s) | Deliverable | **CA gate (done when…)** |
|---|-----------|-----------------|-------------|--------------------------|
| **P0** | Skeletons & scaffold | core M0–M2, worker M0–M1 | Foundry + Go + TS workspaces; reverting contract skeletons; no-op attestor binary; harness can deploy stack to Anvil and spawn N worker processes | `forge build` + `go build` pass; harness deploys skeletons to a live node and spawns 3 worker processes; a `send` tx reverts `NotImplemented` (wiring proven, no logic) |
| **P1** | **Acceptance baseline (CA root)** | new: `acceptance/` suites | E2E + stress suites authored against the target interfaces | `pnpm test:e2e` and `pnpm test:stress` **run** and are **uniformly RED for missing-behavior reasons only** (commit never happens / times out) — zero harness/compile failures; committed. **This red baseline is the contract the rest of the program must satisfy.** |
| **P2** | Protocol core (subsystem 1) | `2026-06-17-protocol-core.md` | Endpoint, Send/ReceiveLib, codec, OApp — TDD | Protocol-core **integration suite GREEN** (lifecycle, retry, threshold, ordering, replay, peer-auth, escape); every implementation step landed via failing **unit test → impl → green**; `forge build --sizes` within limits |
| **P3** | Attestor worker (subsystem 2) | `2026-06-17-attestor-worker.md` | Go attestor (watch→finality→verify→commit), TDD | Worker **integration GREEN**; and the **P1 acceptance baseline (e2e + stress) turns GREEN** with N real workers, incl. chaos (kill/restart attestor) and load (sustained + burst, no gaps/double-commit/lost packets) |

> Subsystems 3 (executor worker) and 4 (cross-asset app) are out of program scope here; the acceptance harness performs execution. They become P4/P5 in a later cycle, extending the same CA baseline.

---

## P0 — Skeletons & scaffold

Execute, in order:
- **Protocol-core plan M0–M2** (scaffold, interfaces + reverting skeletons, harness: anvil/clients/abis/packet/attest/executor/deploy/app).
- **Attestor-worker plan M0–M1** (Go module, config, no-op `Run`; harness `worker.ts` build+spawn, `twonode.ts`).

**CA gate (P0):**
- [ ] `cd contracts && forge build` passes; `cd worker && go build ./...` passes.
- [ ] Harness deploys the skeleton stack to two Anvil nodes and spawns 3 attestor processes that log "started".
- [ ] A harness `send` call reverts `NotImplemented` (proves deploy+wiring, not logic).
- [ ] Committed.

## P1 — Acceptance baseline (authored FIRST, held RED)

**Files (new):**
```
tests/src/acceptance/
  transfer.e2e.test.ts      # arbitrary-data: send bytes A→B, assert delivered intact, exactly once, in order
  chaos.e2e.test.ts         # attestor down (M-of-N), restart idempotency, reverting receiver park/retry
  throughput.stress.test.ts # sustained 200, burst 100, 5 concurrent channels, restart-under-load
```
Add scripts: `"test:e2e": "vitest run src/acceptance/*.e2e.test.ts"`, `"test:stress": "vitest run src/acceptance/*.stress.test.ts"`.

> These are the suites described in attestor-worker plan Tasks 3–5; in this revised structure they are **pulled to P1 and authored before P2/P3 implementation**. The worker plan’s Phase-1 test tasks therefore *reference* these acceptance files instead of re-authoring them. The protocol-core integration suites (P2) and the worker integration suites (P3) are the per-subsystem TDD entry points underneath this baseline.

The canonical acceptance assertion (arbitrary data, the simple north star):

```ts
test('arbitrary bytes are delivered intact, exactly once, in order', async () => {
  const payloads = [randBytes(1), randBytes(64), randBytes(4096)]   // arbitrary content & sizes
  for (const p of payloads) await sendFrom(net.sctx, net.appSrc, 2, net.appDst, p)
  // real attestors must drive commit; harness executes; AppEcho re-emits received bytes
  const received = await collectEchoed(net.dctx, net.appDst, payloads.length, /*timeout*/ 60_000)
  expect(received).toEqual(payloads)                                 // intact + in order
  // exactly once: re-execute any delivered nonce → reverts (cleared)
  await expect(reExecuteFirst(net)).rejects.toBeTruthy()
})
```

**CA gate (P1):**
- [ ] `pnpm test:e2e` and `pnpm test:stress` execute end-to-end (deploy + spawn succeed).
- [ ] Every acceptance test is **RED for missing-behavior reasons** (timeout waiting for commit / empty echo), not harness/compile errors.
- [ ] Acceptance files committed. **Baseline frozen as the program’s definition of done.**

## P2 — Protocol core (subsystem 1, TDD)

Execute the full **`2026-06-17-protocol-core.md`** plan (M3–M7), with this TDD overlay per implementation task:
1. Ensure the task’s **integration assertions** exist (protocol-core integration suite — its Phase 2).
2. For each implementation step: write the **failing unit test** (`forge test`), implement minimally, green, commit (TDD inner loop, §9.3).

**CA gate (P2):**
- [ ] Protocol-core integration suite GREEN (all 7 files).
- [ ] Each implemented unit (codec, channel, threshold, lzReceive, OApp) has a passing `forge test`.
- [ ] `forge build --sizes` within limits; interface frozen.

## P3 — Attestor worker (subsystem 2, TDD)

Execute **`2026-06-17-attestor-worker.md`** plan (M4–M5), TDD overlay:
1. Worker **integration** assertions first.
2. Per step: failing **`go test`** → implement → green → commit.

**CA gate (P3) — the program acceptance gate:**
- [ ] Worker integration GREEN.
- [ ] **P1 acceptance baseline GREEN:** `pnpm test:e2e` (incl. chaos) and `pnpm test:stress` all pass with N real attestor processes.
- [ ] No gaps / no double-commit / no lost packets under sustained + burst load; kill/restart mid-load recovers.

---

## Cross-cutting consistency (verified across all plans)

- `payloadHash = keccak256(guid ‖ message)` — identical in `PacketCodec.sol`, `packet.ts`, `packet.go`.
- ULN `configType = 2`; attestor accounts `[1,2,3]`; `M = 2` default; EIDs `1`(src)/`2`(dst) — identical across harness, contracts, worker env.
- Acceptance suites own e2e/stress; subsystem plans own their integration + unit tiers. No suite is authored twice.

## Open items (defaults chosen; not blockers)
- OQ1 fee/gas: operator-funded, zero on-chain fee (SendLib returns 0). 
- OQ3 ordering: ordered-only channels; add per-channel flag if/when an unordered channel is needed.
- OQ4 keys: env hex key for tests; HSM/KMS for production (follow-up).
- A1 finality: assumed fast/deterministic; reorg recovery deferred (chaos suite stubs the case).
