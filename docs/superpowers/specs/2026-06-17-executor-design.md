# Executor & Delivery — Design Spec (Subsystem 3)

**Date:** 2026-06-17
**Status:** Approved design
**Builds on:** `2026-06-17-bridge-protocol-architecture-design.md` (overall design). This is subsystem 3 (Executor), previously deferred. Cross-asset app (subsystem 4) follows.

---

## 1. Purpose

Add the **Executor** — the off-chain role that takes a *verified* message and makes it *land and execute* on the destination chain. Per LayerZero's model the Executor is about **liveness/throughput, not trust**: a compromised executor cannot forge messages (verification is independent of execution), but it is a liveness single point of failure. We therefore design it to be **horizontally scalable** with a **signer pool**, distinct from the trust-distributed DVN.

This milestone also tightens **separation of concerns**: the DVN/attestor becomes **verify-only**, and the Executor owns **`commitVerification` + `lzReceive`**.

## 2. Role split (decided)

| Role | On-chain calls | Property |
|------|----------------|----------|
| **DVN / attestor** (refactor) | `ReceiveLib.verify()` only | Trust — distributed M-of-N, independent keys |
| **Executor** (new) | `ReceiveLib.commitVerification()` → `Endpoint.lzReceive()` | Liveness — horizontally scalable signer pool |

Rationale: the trust layer should *only attest*; bringing a message onto the destination channel (commit) and delivering it (execute) are liveness actions and belong to the scalable role. `commitVerification` and `lzReceive` are both permissionless on-chain, so this is purely an off-chain responsibility split.

## 3. On-chain changes

Modeled on LayerZero's ExecutorConfig + enforcedOptions + PriceFeed, simplified for a private two-chain network (fee = 0 for now per OQ1; structured so fees can be enabled later).

### 3.1 `ExecutorConfig` registry (new contract)
Per `(oapp, dstEid)`:
```solidity
struct ExecutorConfig {
    uint32  maxMessageSize;   // reject oversized messages at send time
    address executor;         // the designated executor (informational; lzReceive stays permissionless)
    uint128 lzReceiveGas;     // gas budget the executor must supply to the receiver call
}
```
Set via `Endpoint.setConfig(oapp, lib, params)` with `configType = 1` (executor). Stored in the `ExecutorConfig` contract; read by the Executor worker (for gas) and by `SendLib` (for `maxMessageSize` enforcement + future fee quote).

### 3.2 `IPriceFeed` seam (new, minimal)
```solidity
interface IPriceFeed { function gasPrice(uint32 dstEid) external view returns (uint256); }
```
A static implementation for the private net (returns a configured value). The worker fee library / `SendLib.quote` can use it later to charge fees; **today fees remain 0**. This exists so the fee model is a config change, not a redesign.

### 3.3 `ReceiveLib.verifiable(...)` view (new)
```solidity
function verifiable(bytes calldata packetHeader, bytes32 payloadHash) external view returns (bool);
```
Returns true when the M-of-N threshold is met but the message is not yet committed. Lets the Executor poll readiness instead of blind-submitting `commitVerification` (which still reverts as a safety net).

### 3.4 `Endpoint.lzReceive` gas enforcement
`lzReceive` reads `ExecutorConfig.lzReceiveGas` for the channel and supplies exactly that gas to the receiver call (`ILayerZeroReceiver.lzReceive{gas: lzReceiveGas}(...)`), so a receiver cannot consume unbounded gas and delivery cost is predictable. If `lzReceiveGas == 0`, fall back to forwarding available gas (back-compat with P2 behavior).

### 3.5 Attestor refactor
Remove opportunistic `commitVerification` from the attestor worker → it submits `verify` only. (Pure SoC; the Executor commits.)

## 4. Off-chain Executor worker (Go) — separated stages

One binary, run as M horizontally-scalable instances and/or one instance with a signer pool of N accounts. Stages, each independently testable:

1. **Discovery / watcher** — subscribe to source `PacketSent` (what to deliver) and track destination readiness. Maintains the set of in-flight messages with their channel + nonce.
2. **Commit stage** — for a discovered message, poll `ReceiveLib.verifiable(...)`; once true, call `commitVerification(...)` (idempotent; guarded by on-chain `committed`).
3. **Scheduler** — per-channel ordered queues. A channel = `(srcEid, sender, receiver)`. Within a channel, messages are released in strict nonce order (matches `Endpoint` ordered-execution). Across channels, fully parallel.
4. **Signer pool** — N signer accounts. **Channel-sharded (Approach A):** each channel is leased to exactly one signer at a time (consistent-hash by channel, with dynamic rebalance on signer failure). A signer manages its own account nonce locally (as in P3). Guarantees no two signers race the same channel (which would revert via ordered execution) and scales by adding signers.
5. **Executor / tx builder** — build `lzReceive(origin, receiver, guid, message, extraData)` supplying `ExecutorConfig.lzReceiveGas`; submit via the channel's leased signer.
6. **Retry / backoff** — on a reverting receiver, the tx reverts and the message stays parked (Endpoint semantics); retry with exponential backoff. Never skip a nonce. Emit a structured log/alert after K failures.
7. **Checkpoint / idempotency** — persist per-channel executed-nonce cursor; on restart, resume. Re-executing a cleared message is a safe on-chain no-op (`NotExecutable`), so crashes never double-deliver.

### Failure semantics
- **Executor offline** → messages get verified by DVNs but **not committed/delivered**; on restart the worker commits + delivers the backlog. (Demonstrates the liveness SPOF; safety preserved.)
- **Below DVN threshold** → `verifiable` stays false → executor never commits → **no delivery** (fail safe).
- **Signer crash** → its leased channels are re-leased to healthy signers; delivery continues.
- **Out-of-order** → scheduler + per-channel lease guarantee nonce order; `Endpoint` rejects violations as a backstop.

## 5. Configuration model
Per `(oapp, dstEid)`: send/receive libs + `UlnConfig` (DVN set, from P2) + **`ExecutorConfig`** (this spec) + `PriceFeed` (network-level). Set by the OApp owner/delegate via `Endpoint.setConfig`. Worker env: `SRC_RPC`, `DST_RPC`, `SRC_ENDPOINT`, `DST_RECEIVE_LIB`, `DST_ENDPOINT`, `EXECUTOR_CONFIG`, signer keys (pool), poll/backoff params, cursor path.

## 6. Testing strategy (integration-only, TS/Vitest + viem; sad-path first)

Per project discipline: **acceptance/integration suites written before worker logic**, components black-box. The real Executor **replaces the harness-as-executor** in the existing acceptance suite.

**Happy path (existing, now via real executor):** transfer e2e + stress turn green using the real Executor instead of the harness.

**Sad-path / failure e2e (new — first-class deliverables):**
1. **Executor down → recovers:** DVNs verify; executor offline ⇒ not committed/delivered; start executor ⇒ backlog committed + delivered.
2. **Below-threshold fail-safe:** only `M-1` DVNs up ⇒ `verifiable=false` ⇒ executor never commits ⇒ message never delivered within timeout (no false delivery).
3. **Reverting receiver → retry → deliver:** `AppRevert` reverts; executor retries with backoff; after `setFailing(false)`, delivers; nonce never skipped.
4. **Signer crash → pool continues:** kill one signer mid-load; remaining signers deliver all messages; channel re-leased.
5. **Out-of-order safety:** under the parallel pool, assert per-channel delivery is strictly in nonce order.
6. **Idempotent restart:** restart the executor mid-flight; no double-delivery, no gaps.

**Contract integration (TS/Vitest):** `ExecutorConfig` set/get; `lzReceive` gas enforcement (a receiver exceeding `lzReceiveGas` reverts/contained); `verifiable` view transitions false→true at threshold.

**Unit (TDD inner loop):** Go `go test` for scheduler ordering, channel→signer leasing, backoff; Foundry `forge test` for `ExecutorConfig` decode + gas-enforced `lzReceive`.

## 7. Decomposition / milestones
- **P4** — this spec: ExecutorConfig + verifiable view + gas-enforced lzReceive + DVN verify-only refactor + Go Executor worker (signer pool) + sad-path e2e.
- **P5** — Cross-asset bridge app (OApp): lock/release + pricing/liquidity (subsystem 4; the original asset-bridge ask).
- **P6 (optional)** — fee market + execution-options codec: enable OQ1 fees via PriceFeed, per-message `lzReceive`/`nativeDrop` options (`OAppOptionsType3`-style).

## 8. Open items
- OQ1 fees: structured (PriceFeed + ExecutorConfig) but kept 0 until P6.
- Native drop / `msg.value` on `lzReceive`: out of scope until an app needs it (P6).
- Cross-instance coordination: P4 uses a single executor instance with an N-signer pool (channel-sharded). Multiple *instances* (for HA) would need a shared lease store (Redis/DB) — deferred; noted as a scale-out path.
