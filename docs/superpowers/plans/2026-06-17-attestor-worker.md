# Attestor Worker Implementation Plan (Subsystem 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the off-chain Go attestor worker (one of N in the M-of-N verifier set) that watches the source chain's `PacketSent`, waits for finality, recomputes the payload hash, and submits `ReceiveLib.verify` on the destination — verified by black-box TypeScript/Vitest **stress** and **e2e** suites that run real attestor processes.

**Architecture:** A single Go binary, run N times with distinct signing keys. Components: config loader, dual `ethclient` (source + destination), `PacketSent` log watcher, finality gate, payload-hash recomputation (mirrors `PacketCodec`), tx signer/submitter calling `ReceiveLib.verify`, and a crash-safe block cursor store. Idempotent and gap-free on restart.

**Tech Stack:** Go 1.22+, go-ethereum (`ethclient`, `abigen`, `crypto`), Bolt/JSON file cursor store. Tests: TypeScript + Vitest + viem (black-box), Anvil nodes, the worker spawned as a child process. **Depends on Plan 1 (protocol-core) contracts being green.**

**Build discipline (user-mandated):** Skeleton + interfaces first (M0–M1), then the **entire** stress + e2e suites written red (M2–M3), then worker logic until green (M4–M5). **No worker logic before the suites exist.**

---

## Milestones

| Milestone | Phase / Tasks | Deliverable | Exit criteria (gate) |
|-----------|---------------|-------------|----------------------|
| **M0 — Go scaffold + skeleton** | Phase 0 · Tasks 0–1 | Go module, `cmd/attestor`, config, no-op `Attestor.Run` skeleton | `go build ./...` passes; binary starts, reads config, logs "started", exits cleanly on SIGINT |
| **M1 — Harness process control** | Phase 1 · Task 2 | TS helpers to build the binary and spawn/stop N attestor processes against Anvil | Harness builds the binary once and can start/stop 3 attestor processes; health log observed |
| **M2 — E2E suite (RED)** | Phase 1 · Tasks 3–4 | Two-node + N-attestor full-lifecycle e2e suite, incl. chaos | `pnpm test:e2e` runs; every test fails because the worker does not yet attest (commit never happens / times out); committed |
| **M3 — Stress suite (RED)** | Phase 1 · Task 5 | Throughput/burst/concurrent-channel/restart stress suite | `pnpm test:stress` runs; fails (no attestations); committed. **← user-mandated gate: all suites exist before logic** |
| **M4 — Worker core (E2E GREEN)** | Phase 2 · Tasks 6–10 | Watcher, finality gate, payload-hash, signer/submitter, cursor store wired into `Run` | **E2E suite GREEN**: send on src ⇒ M-of-N attest ⇒ commit ⇒ execute, with N real workers; chaos (kill/restart one) still commits |
| **M5 — Resilience & stress (GREEN)** | Phase 2 · Tasks 11–12 | Idempotent restart, catch-up, backoff/retry | **Stress suite GREEN**: no gaps / no double-commit / no lost packets under sustained + burst load; restart mid-load recovers |

> Phase headings are tagged with their milestone. Stop and review at each milestone boundary.

**Relationship to the overall plan.** This is program milestone **P3** in `2026-06-17-overall-plan.md`. The **e2e + stress acceptance suites are authored in P1** (overall plan, `tests/src/acceptance/`) *before* this plan runs — they are the program CA baseline. **Do not re-author them here.** Tasks 3–5 below are therefore re-scoped: they **reference and run** the P1 acceptance files (and add only any worker-specific harness wiring they still need). This plan’s own TDD tiers are: the **worker integration suite** (TDD entry point) and **per-step `go test`** (inner loop, §9.3).

**TDD overlay (per implementation task in Phase 2).** Before each step’s Go code, add a failing `go test` for that step’s detail, implement to green, commit:

| Phase-2 task | Required failing `go test` first |
|---|---|
| 6 packet | `packet_test.go` — `Parse` offsets + `PayloadHash` golden vector matching `packet.ts`/`PacketCodec.sol` |
| 7 client/cursor | `cursor_test.go` — load-default-zero, atomic save, torn-write recovery |
| 8 finality | `finality_test.go` — `Confirmed` boundary (head==block+confs-1) |
| 9 submitter | `submitter_test.go` — tx built with correct selector/args; nonce serialization |
| 10 Run loop | covered by the P1 e2e suite turning green (integration-level) |

(CA note: the **exit criteria** column above **is** each milestone’s CA gate; P3’s gate is the P1 acceptance baseline going green.)

---

## File Structure

```
worker/                            # Go module: github.com/onematrix/bridge/worker
  go.mod
  cmd/attestor/main.go             # entrypoint: load config, signal handling, run
  internal/
    config/config.go               # env/flag config + validation
    chain/client.go                # ethclient wrappers (src + dst), nonce mgmt
    watch/watcher.go               # poll PacketSent logs from source endpoint
    packet/packet.go               # decode encodedPacket; recompute payloadHash (mirror PacketCodec)
    finality/finality.go           # wait N confirmations
    submit/submitter.go            # build/sign/send ReceiveLib.verify tx
    store/cursor.go                # crash-safe last-processed-block cursor
    attestor/attestor.go           # orchestration: the Run loop tying it together
  bindings/                        # abigen output
    endpoint.go  receivelib.go
tests/                             # existing TS workspace (extended)
  src/
    harness/
      worker.ts                    # build binary + spawn/stop attestor processes
      twonode.ts                   # bring up 2 anvil nodes + deploy stack on each
    e2e/
      lifecycle.e2e.test.ts        # full path with real workers
      chaos.e2e.test.ts            # kill/restart attestor; revert receiver; reorg (if A1 relaxed)
    stress/
      throughput.stress.test.ts    # sustained + burst, many channels, restart-under-load
  package.json                     # add test:e2e / test:stress scripts
```

---

## Phase 0 — Go scaffold + skeleton `[M0]`

### Task 0: Initialize the Go module + bindings

**Files:** Create `worker/go.mod`, `worker/cmd/attestor/main.go`, `worker/bindings/`.

- [ ] **Step 1: Init module + deps**

```bash
mkdir -p worker/cmd/attestor worker/internal worker/bindings && cd worker
go mod init github.com/onematrix/bridge/worker
go get github.com/ethereum/go-ethereum@latest
cd ..
```

- [ ] **Step 2: Generate ABI bindings from Plan-1 artifacts**

```bash
# requires abigen (from go-ethereum) on PATH
cd contracts && forge build && cd ..
jq -r '.abi' contracts/out/Endpoint.sol/Endpoint.json   > /tmp/endpoint.abi
jq -r '.abi' contracts/out/ReceiveLib.sol/ReceiveLib.json > /tmp/receivelib.abi
abigen --abi /tmp/endpoint.abi   --pkg bindings --type Endpoint   --out worker/bindings/endpoint.go
abigen --abi /tmp/receivelib.abi --pkg bindings --type ReceiveLib --out worker/bindings/receivelib.go
```

- [ ] **Step 3: `main.go` skeleton (starts, logs, clean shutdown)**

```go
package main

import (
	"context"; "log"; "os"; "os/signal"; "syscall"
	"github.com/onematrix/bridge/worker/internal/attestor"
	"github.com/onematrix/bridge/worker/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil { log.Fatalf("config: %v", err) }
	ctx, cancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1); signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; cancel() }()
	log.Printf("attestor started id=%s src=%s dst=%s", cfg.AttestorID, cfg.SrcRPC, cfg.DstRPC)
	if err := attestor.New(cfg).Run(ctx); err != nil && ctx.Err() == nil { log.Fatalf("run: %v", err) }
	log.Printf("attestor stopped")
}
```

- [ ] **Step 4: Commit**

```bash
git add worker && git commit -m "chore(worker): go module scaffold + abigen bindings + main skeleton"
```

### Task 1: Config + no-op `Attestor.Run`

**Files:** Create `worker/internal/config/config.go`, `worker/internal/attestor/attestor.go`.

- [ ] **Step 1: `config.go`**

```go
package config

import ("errors"; "os"; "strconv")

type Config struct {
	AttestorID   string
	SrcRPC       string
	DstRPC       string
	SrcEndpoint  string // 0x... source Endpoint (emits PacketSent)
	DstReceiveLib string // 0x... destination ReceiveLib (verify target)
	PrivateKey   string // hex, no 0x
	Confirmations uint64
	PollMs       int
	CursorPath   string
}

func Load() (*Config, error) {
	c := &Config{
		AttestorID: os.Getenv("ATTESTOR_ID"), SrcRPC: os.Getenv("SRC_RPC"), DstRPC: os.Getenv("DST_RPC"),
		SrcEndpoint: os.Getenv("SRC_ENDPOINT"), DstReceiveLib: os.Getenv("DST_RECEIVE_LIB"),
		PrivateKey: os.Getenv("ATTESTOR_KEY"), CursorPath: os.Getenv("CURSOR_PATH"),
	}
	c.Confirmations = atou(os.Getenv("CONFIRMATIONS"), 1)
	c.PollMs = int(atou(os.Getenv("POLL_MS"), 200))
	if c.SrcRPC == "" || c.DstRPC == "" || c.PrivateKey == "" || c.SrcEndpoint == "" || c.DstReceiveLib == "" {
		return nil, errors.New("missing required config (SRC_RPC,DST_RPC,SRC_ENDPOINT,DST_RECEIVE_LIB,ATTESTOR_KEY)")
	}
	if c.CursorPath == "" { c.CursorPath = "/tmp/attestor-" + c.AttestorID + ".cursor" }
	return c, nil
}
func atou(s string, d uint64) uint64 { if s == "" { return d }; v, err := strconv.ParseUint(s, 10, 64); if err != nil { return d }; return v }
```

- [ ] **Step 2: `attestor.go` skeleton (Run blocks until ctx done, does nothing)**

```go
package attestor

import ("context"; "time"; "github.com/onematrix/bridge/worker/internal/config")

type Attestor struct{ cfg *config.Config }
func New(cfg *config.Config) *Attestor { return &Attestor{cfg: cfg} }

// Run: skeleton — implemented in Phase 2.
func (a *Attestor) Run(ctx context.Context) error {
	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond); defer t.Stop()
	for { select {
		case <-ctx.Done(): return nil
		case <-t.C: /* Phase 2: watch → finality → recompute → submit */
	} }
}
```

- [ ] **Step 3: Build + smoke-run**

```bash
cd worker && go build ./... && \
SRC_RPC=x DST_RPC=x SRC_ENDPOINT=0x0 DST_RECEIVE_LIB=0x0 ATTESTOR_KEY=ab go run ./cmd/attestor & sleep 1; kill %1; cd ..
```
Expected: logs `attestor started ... ` then `attestor stopped` on signal.

- [ ] **Step 4: Commit**

```bash
git add worker && git commit -m "feat(worker): config loader + no-op Run skeleton (M0 complete)"
```

---

## Phase 1 — Stress + E2E suites (TS/Vitest, all red) `[M1 harness · M2 e2e · M3 stress]`

### Task 2: Harness — build binary + spawn N attestor processes + two-node setup

**Files:** Create `tests/src/harness/worker.ts`, `tests/src/harness/twonode.ts`; modify `tests/package.json`.

- [ ] **Step 1: `worker.ts`**

```ts
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

const BIN = resolve(__dirname, '../../../worker/bin/attestor')
export function buildWorker() {
  execFileSync('go', ['build', '-o', BIN, './cmd/attestor'], { cwd: resolve(__dirname, '../../../worker'), stdio: 'inherit' })
}
export type WorkerHandle = { proc: ChildProcess; stop: () => void }
export function startAttestor(env: Record<string,string>): WorkerHandle {
  const proc = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: 'pipe' })
  proc.stdout?.on('data', d => process.stdout.write(`[${env.ATTESTOR_ID}] ${d}`))
  proc.stderr?.on('data', d => process.stderr.write(`[${env.ATTESTOR_ID}] ${d}`))
  return { proc, stop: () => proc.kill('SIGINT') }
}
```

- [ ] **Step 2: `twonode.ts`** — bring up two Anvil nodes (ports 8545/8555), deploy the Plan-1 stack on each (reuse `deployStack` + `deployApp` + `wireChannel` from Plan 1's harness), and return both contexts plus a helper to build attestor env for src→dst.

```ts
import { startAnvil } from './anvil'; import { clients } from './clients'
import { deployStack } from './deploy'; import { deployApp, wireChannel } from './app'
import { KEYS } from './clients'

export async function twoNode(M = 2) {
  const src = await startAnvil(8545), dst = await startAnvil(8555)
  const sc = clients(src.rpc), dc = clients(dst.rpc)
  const sctx = await deployStack(src.rpc, 1, sc.pub, sc.wallets) // EID 1
  const dctx = await deployStack(dst.rpc, 2, dc.pub, dc.wallets) // EID 2
  const appSrc = await deployApp(sctx, 'AppEcho')
  const appDst = await deployApp(dctx, 'AppEcho')
  // wire send side on src, receive side on dst with M-of-N attestors = accounts [1,2,3]
  await wireChannel(sctx, appSrc, appSrc, 1, 2, [], [], 0)          // src: peer + sendLib only
  await wireChannel(dctx, appSrc, appDst, 1, 2, [1,2,3], [], M)     // dst: peer + receiveLib + ULN
  // attestor env points SRC_ENDPOINT=src endpoint, DST_RECEIVE_LIB=dst receiveLib
  const attestorEnv = (i: number) => ({
    ATTESTOR_ID: `a${i}`, SRC_RPC: src.rpc, DST_RPC: dst.rpc,
    SRC_ENDPOINT: sctx.endpoint, DST_RECEIVE_LIB: dctx.receiveLib,
    ATTESTOR_KEY: KEYS[i].slice(2), CONFIRMATIONS: '1', POLL_MS: '150',
    CURSOR_PATH: `/tmp/cursor-a${i}-${Date.now()}`,
  })
  return { src, dst, sctx, dctx, appSrc, appDst, attestorEnv, stop: () => { src.stop(); dst.stop() } }
}
```

- [ ] **Step 3: `package.json` scripts**

```json
{
  "scripts": {
    "test:integration": "vitest run src/integration",
    "test:e2e": "vitest run src/e2e",
    "test:stress": "vitest run src/stress"
  }
}
```

- [ ] **Step 4: Commit.** `git add tests worker && git commit -m "test(harness): worker process control + two-node setup"`

### Task 3: E2E lifecycle suite (RED)

**Files:** Create `tests/src/e2e/lifecycle.e2e.test.ts`.

- [ ] **Step 1: Write the test (real workers, no harness-as-attestor)**

```ts
import { beforeAll, afterAll, expect, test } from 'vitest'
import { twoNode } from '../harness/twonode'; import { buildWorker, startAttestor, type WorkerHandle } from '../harness/worker'
import { encodePacket } from '../harness/packet'; import { execute } from '../harness/executor'
import { sendFrom } from '../harness/app'; import { pad, stringToHex, type Hex } from 'viem'

let net: Awaited<ReturnType<typeof twoNode>>; let workers: WorkerHandle[] = []
beforeAll(async () => {
  buildWorker(); net = await twoNode(2)
  workers = [1,2,3].map(i => startAttestor(net.attestorEnv(i)))     // 3 real attestor processes
})
afterAll(() => { workers.forEach(w => w.stop()); net.stop() })

async function waitForCommit(nonce: bigint, payloadHash: Hex, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const h = await net.dctx.pub.readContract({ address: net.dctx.endpoint, abi: net.dctx.abi.Endpoint.abi,
      functionName: 'inboundPayloadHash', args: [net.appDst, 1, pad(net.appSrc,{size:32}), nonce] })
    if (h === payloadHash) return true
    await new Promise(r => setTimeout(r, 250))
  }
  return false
}

test('real M-of-N attestors verify a PacketSent and the destination commits, then executes', async () => {
  const message = stringToHex('e2e-hello'); const nonce = 1n
  const { guid, payloadHash } = encodePacket(nonce, 1, net.appSrc, 2, net.appDst, message)
  await sendFrom(net.sctx, net.appSrc, 2, net.appDst, message)        // emit PacketSent on src
  expect(await waitForCommit(nonce, payloadHash)).toBe(true)          // workers drive commit on dst
  // harness executes (executor worker is subsystem 3)
  await net.dctx.pub.waitForTransactionReceipt({
    hash: await execute(net.dctx, { srcEid: 1, sender: pad(net.appSrc,{size:32}), nonce }, net.appDst, guid, message) })
  const cleared = await net.dctx.pub.readContract({ address: net.dctx.endpoint, abi: net.dctx.abi.Endpoint.abi,
    functionName: 'inboundPayloadHash', args: [net.appDst, 1, pad(net.appSrc,{size:32}), nonce] })
  expect(cleared).toBe('0x' + '0'.repeat(64))
})
```

- [ ] **Step 2: Run → RED.** `pnpm test:e2e` — `waitForCommit` times out (skeleton worker never attests).
- [ ] **Step 3: Commit.** `git commit -m "test(e2e): lifecycle with real attestors (red)"`

### Task 4: E2E chaos suite (RED)

**Files:** Create `tests/src/e2e/chaos.e2e.test.ts`.

- [ ] **Step 1: Write tests:**
  - `survives one attestor down (M-of-N with M=2, N=3)`: start only 2 of 3 workers; commit still happens.
  - `attestor restart mid-flight is idempotent`: send packet, kill+restart one worker before commit; exactly one commit, no double-commit revert storm.
  - `reverting receiver parks; later retry by harness delivers` (reuses AppRevert on dst).

```ts
test('commit succeeds with only M of N attestors running', async () => {
  // start workers [1,2] only (M=2, N=3); never start [3]
  const message = stringToHex('chaos-1'); const nonce = 1n
  const { payloadHash } = encodePacket(nonce, 1, net.appSrc, 2, net.appDst, message)
  await sendFrom(net.sctx, net.appSrc, 2, net.appDst, message)
  expect(await waitForCommit(nonce, payloadHash)).toBe(true)
})
```

- [ ] **Step 2: Run → RED.**  
- [ ] **Step 3: Commit.** `git commit -m "test(e2e): chaos suite (red); M2 complete"`

### Task 5: Stress suite (RED)

**Files:** Create `tests/src/stress/throughput.stress.test.ts`.

- [ ] **Step 1: Write tests:**
  - `sustained throughput: 200 packets on one channel all commit in order, no gaps`: fire 200 `sendMessage`s, assert all 200 payload hashes committed and `inboundNonce` reaches 200 with no missing nonce.
  - `burst: 100 packets sent back-to-back are all committed`.
  - `many concurrent channels: 5 app pairs × 40 packets each all commit`.
  - `restart under load: kill+restart an attestor mid-burst; all packets still commit exactly once`.

```ts
test('sustained 200 packets commit in order with no gaps', async () => {
  const N = 200
  for (let i = 1; i <= N; i++) await sendFrom(net.sctx, net.appSrc, 2, net.appDst, stringToHex('m'+i))
  // poll until inboundNonce == N or timeout
  const ok = await pollUntil(async () => {
    const n = await net.dctx.pub.readContract({ address: net.dctx.endpoint, abi: net.dctx.abi.Endpoint.abi,
      functionName: 'inboundNonce', args: [net.appDst, 1, pad(net.appSrc,{size:32})] })
    return n === BigInt(N)
  }, 120_000)
  expect(ok).toBe(true)
  // verify no gaps: each nonce 1..N has a non-empty committed hash
  for (let i = 1; i <= N; i++) {
    const h = await net.dctx.pub.readContract({ address: net.dctx.endpoint, abi: net.dctx.abi.Endpoint.abi,
      functionName: 'inboundPayloadHash', args: [net.appDst, 1, pad(net.appSrc,{size:32}), BigInt(i)] })
    expect(h).not.toBe('0x' + '0'.repeat(64))
  }
})
```

(`pollUntil` is a small helper added to `tests/src/harness/poll.ts`.)

- [ ] **Step 2: Run → RED.** `pnpm test:stress` — times out (no attestations).
- [ ] **Step 3: Commit.** `git commit -m "test(stress): throughput/burst/concurrent/restart suite (red); M3 complete — all suites exist"`

> **End of Phase 1 gate (M3):** all suites authored and committed; every test fails only because the worker doesn't attest yet. No worker logic written.

---

## Phase 2 — Worker implementation (turn suites green) `[M4–M5]`

### Task 6: `packet.go` — decode + recompute payloadHash

**Files:** Create `worker/internal/packet/packet.go`.

- [ ] **Step 1: Implement (mirror `PacketCodec`/`packet.ts`)**

```go
package packet

import ("github.com/ethereum/go-ethereum/common"; "golang.org/x/crypto/sha3")

// encodedPacket = header(81) ‖ guid(32) ‖ message
type Parsed struct { Header []byte; Guid common.Hash; Message []byte; PayloadHash common.Hash; SrcEid uint32; Nonce uint64 }

func keccak(b ...[]byte) common.Hash { h := sha3.NewLegacyKeccak256(); for _, x := range b { h.Write(x) }; var out common.Hash; copy(out[:], h.Sum(nil)); return out }

func Parse(encoded []byte) (Parsed, error) {
	if len(encoded) < 113 || encoded[0] != 1 { return Parsed{}, ErrBadPacket }
	header := encoded[:81]
	guid := common.BytesToHash(encoded[81:113])
	message := encoded[113:]
	return Parsed{
		Header: header, Guid: guid, Message: message,
		PayloadHash: keccak(guid.Bytes(), message),       // keccak(guid ‖ message)
		Nonce:  beUint64(header[1:9]), SrcEid: beUint32(header[9:13]),
	}, nil
}
```

(Add `ErrBadPacket`, `beUint64`, `beUint32`. Verify against a Plan-1 golden vector: same `message`/`nonce`/eids must yield the same `payloadHash` as `packet.ts`.)

- [ ] **Step 2: Build.** `cd worker && go build ./...`
- [ ] **Step 3: Commit.** `git commit -am "feat(worker): packet decode + payloadHash recompute"`

### Task 7: `chain/client.go` + `store/cursor.go`

**Files:** Create both.

- [ ] **Step 1: `client.go`** — `ethclient.Dial(src)`, `ethclient.Dial(dst)`; helpers `HeadBlock(ctx)`, `FilterPacketSent(ctx, from, to)` using the `bindings` filterer on `SRC_ENDPOINT`.
- [ ] **Step 2: `cursor.go`** — JSON file `{ "lastBlock": n }`; `Load()` returns 0 if absent; `Save(n)` atomic (write temp + rename). This delivers crash-safe replay (R-VF-4).
- [ ] **Step 3: Build + commit.** `git commit -am "feat(worker): chain clients + crash-safe block cursor"`

### Task 8: `finality/finality.go`

**Files:** Create.

- [ ] **Step 1:** `Confirmed(head, block, confs uint64) bool { return head >= block+confs-1 }` and a `WaitConfirmed(ctx, client, block)` that polls head until confirmed (R-VF-2). For Anvil (instant blocks) `confirmations=1` resolves immediately.
- [ ] **Step 2: Build + commit.** `git commit -am "feat(worker): finality gate"`

### Task 9: `submit/submitter.go`

**Files:** Create.

- [ ] **Step 1:** Build, sign (EIP-155 with chain id from `DstRPC`), and send `ReceiveLib.verify(header, payloadHash, confirmations)` via the `bindings` transactor with the attestor key. Manage account nonce; return tx hash. Idempotent at the contract level (R-VF-3: re-submitting an already-recorded verify is harmless).
- [ ] **Step 2:** Add `commitVerification(header, payloadHash)` call after submitting verify **only if** the worker is configured as committer (any one attestor may call it; make it opportunistic — try commit, ignore `THRESHOLD_NOT_MET`/`already committed` reverts). This lets the set self-commit without a separate process.
- [ ] **Step 3: Build + commit.** `git commit -am "feat(worker): verify+opportunistic-commit submitter"`

### Task 10: `attestor.go` — wire the Run loop (E2E green)

**Files:** Modify `worker/internal/attestor/attestor.go`.

- [ ] **Step 1: Implement the loop**

```go
func (a *Attestor) Run(ctx context.Context) error {
	cl, err := chain.Dial(a.cfg); if err != nil { return err }
	cur := store.NewCursor(a.cfg.CursorPath); last := cur.Load()
	t := time.NewTicker(time.Duration(a.cfg.PollMs) * time.Millisecond); defer t.Stop()
	for { select {
	case <-ctx.Done(): return nil
	case <-t.C:
		head, err := cl.HeadBlock(ctx); if err != nil { continue }
		safe := head + 1 - a.cfg.Confirmations              // only scan finalized range
		if safe <= last { continue }
		events, err := cl.FilterPacketSent(ctx, last+1, safe); if err != nil { continue }
		for _, ev := range events {
			p, err := packet.Parse(ev.EncodedPacket); if err != nil { continue }
			if err := a.submitter.VerifyAndMaybeCommit(ctx, p.Header, p.PayloadHash, a.cfg.Confirmations); err != nil {
				log.Printf("submit failed nonce=%d: %v", p.Nonce, err); continue  // retry next tick
			}
		}
		last = safe; cur.Save(last)                          // advance only after processing (gap-free)
	} }
}
```

- [ ] **Step 2: Run E2E.** `pnpm test:e2e`
Expected: **lifecycle + chaos GREEN** — real workers attest, dst commits, harness executes.

- [ ] **Step 3: Commit.** `git commit -am "feat(worker): Run loop watch→finality→verify→commit; e2e green (M4)"`

### Task 11: Resilience — idempotent restart + catch-up

**Files:** Modify `attestor.go`, `store/cursor.go`.

- [ ] **Step 1:** On restart, resume from `cur.Load()`; reprocessing an already-verified packet is a contract-level no-op, so the catch-up window is safe (R-VF-3/4). Add a bounded re-scan overlap (e.g. `last - 5`) to tolerate a torn cursor write.
- [ ] **Step 2: Run chaos restart test.** `pnpm test:e2e -t "restart"` → GREEN.
- [ ] **Step 3: Commit.** `git commit -am "feat(worker): idempotent restart + catch-up overlap"`

### Task 12: Submitter robustness under load (Stress green)

**Files:** Modify `submit/submitter.go`.

- [ ] **Step 1:** Serialize tx submission per worker (account-nonce mutex), add exponential backoff on transient RPC errors, and cap in-flight verifies. Ensure `commitVerification` is attempted once per (header,payloadHash) the worker observes threshold-likely (poll `inboundPayloadHash` empty before committing to avoid revert storms under burst).
- [ ] **Step 2: Run stress.** `pnpm test:stress`
Expected: **GREEN** — 200 sustained + burst + concurrent channels commit in order, no gaps/double-commit/lost packets; restart-under-load recovers.

- [ ] **Step 3: Commit.** `git commit -am "feat(worker): submitter backoff + nonce serialization; stress green (M5)"`

---

## Self-Review (completed during authoring)

- **Spec coverage:** §5.4 attestor worker → all of Phase 2; R-VF-1 (independent recompute) → Task 6 + Task 10 (each worker parses the event itself); R-VF-2 (finality) → Task 8; R-VF-3 (idempotent) → Tasks 9/11; R-VF-4 (crash-safe) → Task 7 cursor + Task 11; R-VF-6 (liveness/stall under M-1) → chaos Task 4 + threshold behavior inherited from Plan-1 ReceiveLib; §9 stress + e2e suites → Phase 1.
- **Cross-plan consistency:** `payloadHash = keccak256(guid‖message)` identical in `packet.go` (Task 6), `PacketCodec.sol` (Plan 1 Task 11), `packet.ts` (Plan 1 Task 3). ULN `configType=2` and attestor accounts `[1,2,3]` consistent with Plan-1 `app.ts`. Worker calls `ReceiveLib.verify(header, payloadHash, confirmations)` and `commitVerification(header, payloadHash)` exactly as Plan-1 `IReceiveLib` defines.
- **Placeholders:** none — helper additions (`ErrBadPacket`, `beUint*`, `pollUntil`) are named with their location; each test step has concrete assertions.
- **Dependency:** requires Plan 1 at **M7** (interface frozen, suite green) before Phase 1 here can deploy real contracts. Executor worker (subsystem 3) remains out of scope; harness performs execution in e2e.
- **Open items deferred:** OQ4 (key management) — workers read a raw hex key from env for tests; production HSM/KMS integration is a follow-up. Source reorg handling (A1 relaxed) — only the chaos "reorg" case stubs it; full reorg recovery is deferred until finality assumptions are confirmed.
