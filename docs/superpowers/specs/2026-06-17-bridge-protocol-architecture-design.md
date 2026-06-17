# Cross-Chain Messaging Bridge — Protocol Architecture Design

**Date:** 2026-06-17
**Status:** Draft for review
**Scope:** Overall architecture + per-component abstract interfaces and requirements. Per-subsystem implementation plans follow as separate documents.

---

## 1. Purpose & goals

Build a **generic cross-chain message-passing protocol** between **two internal, permissioned EVM chains**, modeled faithfully on the LayerZero V2 architecture. The protocol moves **arbitrary `bytes` payloads** between the chains with strong delivery guarantees. **Asset transfer (including cross-asset native swaps) is one application built on top** — not a special case in the protocol layer.

**Primary goals**
- Move arbitrary application payloads chain A ↔ chain B.
- **Exactly-once** delivery per message.
- **Ordered commit** per channel, with failed executions **parked for retry** (non-blocking at the protocol level — see §7).
- Modular, swappable verification (start with M-of-N attestors; allow evolution to an on-chain light client without touching the Endpoint).
- A clean application interface (`OApp`) so the asset bridge and future apps are pure consumers.

**Non-goals (this document)**
- The cross-asset pricing/liquidity logic (separate application spec).
- Public/permissionless DVN marketplace, fee market dynamics (we run all workers).

## 2. Constraints & assumptions

| # | Assumption | Impact if wrong |
|---|-----------|-----------------|
| A1 | Both chains are EVM, permissioned, with **fast/deterministic finality** (PoA/IBFT-style). | If finality is probabilistic, attestors need a confirmation-depth policy and reorg handling. |
| A2 | We operate **all** off-chain workers (N attestors + executor). | A third-party worker model would add auth/incentive design. |
| A3 | Only **two** chains, with our own EID space (e.g. `1`, `2`). | More chains → channel/config fan-out, but design already generalizes. |
| A4 | Endpoint is **immutable** (decided). Evolution via lib/verifier config swap only. | — |
| A5 | Addresses stored as **bytes32** (decided) for non-EVM future-proofing. | — |

**Open questions** (do not block architecture; resolve before/within subsystem specs):
- **OQ1 — Fee/gas model:** who funds destination execution gas? Options: operator-funded executor (no on-chain fee), or sender prepays native fee at `send()` (LZ-faithful). *Leaning operator-funded for an internal network; confirm.*
- ~~OQ2 — Stack~~ **(resolved):** attestor + executor workers in **Go** (go-ethereum tooling); protocol-core contracts in **Foundry** (Solidity). **Three test tiers (§9):** acceptance (e2e+stress, TS/Vitest+viem) built first as the CA baseline; integration (TS/Vitest) per subsystem; unit (Foundry `forge test` / `go test`) per implementation step under TDD.
- **OQ3 — Ordered semantics precision:** does a parked (failed-execution) message block later nonces on the same channel, or may later nonces execute? See §7 for the proposed rule.
- **OQ4 — Key management:** attestor signing keys (HSM / KMS / threshold-sig).

## 3. Architecture overview

Both chains run the **same immutable contract set**; off-chain workers bridge them.

```
 CHAIN A (EID 1)                                  CHAIN B (EID 2)
 ┌─────────────────────────────┐                 ┌─────────────────────────────┐
 │ OApp (sender)               │                 │ OApp (receiver)             │
 │   │ _lzSend                 │                 │   ▲ _lzReceive              │
 │   ▼                         │                 │   │                         │
 │ Endpoint.send() ──► SendLib │                 │ Endpoint.lzReceive() ◄──────┤
 │   • bump outboundNonce      │                 │   • verify payloadHash       │
 │   • build packet, emit      │                 │   • enforce nonce            │
 │     PacketSent              │                 │   ▲ commit (verify)          │
 └───────┬─────────────────────┘                 │   │ ReceiveLib               │
         │ PacketSent event                       └───┴──────────────────────────┘
         │                                            ▲              ▲
         ▼                                            │ verify()     │ lzReceive()
   ┌───────────────┐   M-of-N attestations            │              │
   │ Attestor × N  │ ─────────────────────────────────┘              │
   └───────────────┘                                                 │
   ┌───────────────┐   delivers message calldata                     │
   │ Executor (1)  │ ────────────────────────────────────────────────┘
   └───────────────┘
```

**On-chain (per chain):** `Endpoint`, `SendLib`, `ReceiveLib`, `Verifier` (ReceiveLib config), `Executor` (config), `OApp` base.
**Off-chain:** `Attestor` (×N), `Executor` (×1).

Component-to-LayerZero mapping and the "contract vs worker" disambiguation are in §5.

## 4. Packet format & codec (decided)

```
offset size field      notes
0      1    version    codec version = 1
1      8    nonce      uint64, per-channel send sequence
9      4    srcEid     source endpoint id
13     32   sender     source OApp, bytes32 (EVM addr left-padded)
45     4    dstEid     destination endpoint id
49     32   receiver   destination OApp, bytes32
--- header = 81 bytes ---
81     32   guid       globally unique message id
113    ..   message    arbitrary application payload
```

```
guid        = keccak256(abi.encodePacked(nonce, srcEid, sender, dstEid, receiver))
payload     = guid ‖ message
payloadHash = keccak256(payload)        // attestors sign over header + payloadHash
```

- `PacketSent(bytes encodedPacket, bytes options, address sendLib)` where `encodedPacket = header ‖ guid ‖ message` — the single source of truth attestors read.
- **Channel identity** = `(srcEid, sender, dstEid, receiver)`. `nonce` is monotonic **per channel**.
- Message bytes travel only in the executor's `lzReceive` calldata; the chain re-checks `keccak256(guid ‖ message) == committed payloadHash`, so neither executor nor relayer can mutate content.

## 5. Components — abstract interfaces & requirements

> All interfaces are Solidity-shaped sketches for the on-chain parts and pseudo-interfaces for off-chain workers. Field names mirror LayerZero V2 where practical.

### 5.1 Endpoint (contract, immutable, one per chain)

**Responsibility:** entry/exit point; owns channel state (nonces, committed payload hashes); registry of libs + per-OApp config; the only contract OApps and workers transact against.

```solidity
struct MessagingParams { uint32 dstEid; bytes32 receiver; bytes message; bytes options; bool payInLzToken; }
struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }
struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }
struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }

interface IEndpoint {
    // SEND (called by OApp, same chain)
    function quote(MessagingParams calldata p, address sender) external view returns (MessagingFee memory);
    function send(MessagingParams calldata p, address refundAddress) external payable returns (MessagingReceipt memory);

    // RECEIVE
    function verify(Origin calldata o, address receiver, bytes32 payloadHash) external; // called by ReceiveLib on threshold
    function lzReceive(Origin calldata o, address receiver, bytes32 guid, bytes calldata message, bytes calldata extraData) external payable; // called by Executor

    // CHANNEL MGMT (OApp/delegate)
    function skip(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce) external;
    function nilify(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash) external;
    function burn(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash) external;
    function clear(address oapp, Origin calldata o, bytes32 guid, bytes calldata message) external;

    // CONFIG / REGISTRY (OApp owner/delegate)
    function setSendLibrary(address oapp, uint32 eid, address lib) external;
    function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256 gracePeriod) external;
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
    function setDelegate(address delegate) external;

    // VIEWS
    function outboundNonce(address sender, uint32 dstEid, bytes32 receiver) external view returns (uint64);
    function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64);
    function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) external view returns (bytes32);
}
```

**State**
```
outboundNonce[sender][dstEid][receiver]              uint64
lazyInboundNonce[receiver][srcEid][sender]           uint64
inboundPayloadHash[receiver][srcEid][sender][nonce]  bytes32   // EMPTY = cleared/executed
sendLibrary / receiveLibrary / config registry
```

**Requirements**
- R-EP-1: `send` MUST increment `outboundNonce` atomically and pass the packet to the configured SendLib.
- R-EP-2: `verify` MUST be callable only by the OApp's configured ReceiveLib; it commits `inboundPayloadHash` and advances `lazyInboundNonce` without gaps.
- R-EP-3: `lzReceive` MUST verify `keccak256(guid ‖ message) == inboundPayloadHash[...][nonce]`, clear the hash **before** calling the receiver (reentrancy-safe), and revert atomically if the receiver reverts (leaving the hash committed for retry).
- R-EP-4: Replay protection — a cleared (EMPTY) payload hash MUST NOT be re-executed.
- R-EP-5: Immutable — no upgrade path; no admin function may alter committed channel state arbitrarily (only `skip`/`nilify`/`burn` by the owning OApp).
- R-EP-6: Anyone MAY call `lzReceive` to retry a committed-but-failed message (executor is not privileged for retries).

### 5.2 SendLib (contract)

**Responsibility:** on `send`, serialize the canonical packet, compute fees, emit `PacketSent`, dispatch work to Verifier + Executor configs.

```solidity
interface ISendLib {
    function send(Packet calldata packet, bytes calldata options, bool payInLzToken)
        external returns (MessagingFee memory fee, bytes memory encodedPacket);
    function quote(Packet calldata packet, bytes calldata options, bool payInLzToken)
        external view returns (MessagingFee memory);
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
}
```

**Requirements**
- R-SL-1: Produce `encodedPacket` exactly per §4 (deterministic, version-tagged).
- R-SL-2: Emit `PacketSent(encodedPacket, options, address(this))`.
- R-SL-3: Fee computation MUST be a pure function of (message size, options, config); align with OQ1.
- R-SL-4: Only callable by the Endpoint.

### 5.3 ReceiveLib (contract)

**Responsibility:** accumulate attestor verifications; on M-of-N threshold, commit the payload hash to the Endpoint.

```solidity
interface IReceiveLib {
    // called by attestor workers
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external;
    // called by anyone once threshold reached
    function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external;
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
    function getUlnConfig(address oapp, uint32 srcEid) external view returns (UlnConfig memory);
}

struct UlnConfig {
    uint64  confirmations;        // required source confirmations
    address[] requiredAttestors;  // all must sign
    address[] optionalAttestors;  // X of these must sign
    uint8   optionalThreshold;    // X
}
```

**Requirements**
- R-RL-1: Record verification keyed `lookup[keccak256(header)][payloadHash][attestor]`.
- R-RL-2: `commitVerification` MUST enforce M-of-N: all `requiredAttestors` present AND `optionalThreshold` of `optionalAttestors` present, at ≥ `confirmations`.
- R-RL-3: On success, call `Endpoint.verify(origin, receiver, payloadHash)` exactly once per (channel, nonce); reject double-commit.
- R-RL-4: Reject attestations from addresses not in the configured set.
- R-RL-5: Config changes MUST NOT retroactively validate already-rejected packets.

### 5.4 Verifier — M-of-N attestors (on-chain config in ReceiveLib + N off-chain workers)

**On-chain:** the `UlnConfig` above (which addresses, threshold, confirmations) lives in ReceiveLib.
**Off-chain (`Attestor` worker, ×N):**

```
interface AttestorWorker {
  watch():        subscribe to source Endpoint PacketSent
  onPacket(evt):  // for each new packet
    wait_for_finality(evt.blockNumber, confirmations)
    payloadHash = keccak256(evt.guid ‖ evt.message)
    if !already_verified(header, payloadHash):
        tx = dstReceiveLib.verify(header, payloadHash, confirmations)
        submit_signed(tx, attestorKey)
  recover():      on restart, replay from last processed source block
}
```

**Requirements**
- R-VF-1: Each attestor MUST independently recompute `payloadHash` from the source event — never trust another worker's hash.
- R-VF-2: MUST wait `confirmations` source blocks (A1: small/fixed) before signing.
- R-VF-3: Idempotent — re-submitting `verify` for an already-verified (header, hash) is a no-op/safe.
- R-VF-4: Crash-safe — persist last-processed source block; replay on restart without gaps or double-effect.
- R-VF-5: Keys isolated per attestor (OQ4); no shared signing material across the N.
- R-VF-6: Liveness — if fewer than M attestors are healthy, messages stall (do not commit) rather than commit unsafely.

### 5.5 Executor (on-chain config + 1 off-chain worker)

**Responsibility:** after commit, deliver the message calldata by calling `Endpoint.lzReceive`, supplying destination gas.

```
interface ExecutorWorker {
  watch():           subscribe to destination commit events (PayloadVerified)
  onCommitted(c):    // packet hash committed on destination
    msg = lookup_message(c.guid)          // from source PacketSent cache
    gas = enforced_options(c.channel)     // execution gas budget
    tx  = dstEndpoint.lzReceive(origin, receiver, guid, msg, extraData){gas}
    submit_signed(tx, executorKey)
    on_revert: record for retry (do NOT advance; message stays committed)
}
```

**Requirements**
- R-EX-1: MUST supply the `enforcedOptions` gas budget for the destination receiver.
- R-EX-2: MUST be tolerant of receiver reverts — record and retry; never mark a message done unless `lzReceive` succeeds.
- R-EX-3: MUST honor ordered execution per §7 (do not execute nonce n+1 ahead of a still-failing nonce n on the same channel, if ordered mode is enforced for that channel).
- R-EX-4: Crash-safe and idempotent — re-running `lzReceive` on an already-executed (cleared) message is a safe no-op (Endpoint enforces via empty hash).
- R-EX-5: Gas funding policy per OQ1.

### 5.6 OApp base (contract, inherited by applications)

**Responsibility:** standard send/receive plumbing + peer registry for application contracts.

```solidity
interface IOAppCore {
    function setPeer(uint32 eid, bytes32 peer) external;
    function peers(uint32 eid) external view returns (bytes32);
}
abstract contract OApp /* OAppSender + OAppReceiver */ {
    function _lzSend(uint32 dstEid, bytes memory message, bytes memory options,
                     MessagingFee memory fee, address refund) internal returns (MessagingReceipt memory);
    function _lzReceive(Origin calldata o, bytes32 guid, bytes calldata message,
                        address executor, bytes calldata extraData) internal virtual; // app implements
    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata message,
                       address executor, bytes calldata extraData) external payable;   // called by Endpoint
}
```

**Requirements**
- R-OA-1: `lzReceive` MUST be callable only by the Endpoint, and MUST verify `o.sender == peers(o.srcEid)` (peer authentication).
- R-OA-2: `_lzReceive` is the application hook; reverts here leave the message committed for retry (R-EP-3).
- R-OA-3: Peer config restricted to the OApp owner/delegate.
- R-OA-4: The cross-asset asset-bridge is a separate OApp implementation (own spec); the protocol layer has no asset semantics.

## 6. Message lifecycle (end to end)

1. **Send (src):** App calls `_lzSend` → `Endpoint.send`. Endpoint bumps `outboundNonce`, SendLib builds the packet, computes fee, emits `PacketSent`.
2. **Observe (off-chain):** N attestors read `PacketSent`, wait `confirmations`, recompute `payloadHash`.
3. **Verify (dst):** Each attestor calls `ReceiveLib.verify(header, payloadHash, confirmations)`.
4. **Commit (dst):** Once M-of-N met, `commitVerification` → `Endpoint.verify` stores `inboundPayloadHash`, advances `lazyInboundNonce`.
5. **Execute (dst):** Executor calls `Endpoint.lzReceive` with the message. Endpoint checks the hash, clears it, calls `OApp.lzReceive` → `_lzReceive`.
6. **Retry (if needed):** If `_lzReceive` reverts, the committed hash remains; executor (or anyone) retries until success, or the OApp owner uses `skip`/`nilify`/`burn`.

## 7. Delivery semantics & error handling (decided: ordered commit, parked retry)

- **Verification/commit is strictly ordered** per channel via `lazyInboundNonce` — no gaps; nonce n must be committed before n+1.
- **Execution failures are parked, not dropped:** a committed message whose `lzReceive` reverts keeps its `inboundPayloadHash` and is retryable indefinitely.
- **Proposed ordered-execution rule (OQ3):** for channels marked *ordered*, the executor MUST NOT execute nonce n+1 while nonce n is committed-but-unexecuted (preserves dependent-message ordering). For channels marked *unordered*, n+1 may proceed. **Default: ordered.** → confirm in protocol-core spec.
- **Escape hatches (owner-only):** `skip` (advance past an un-committed nonce), `nilify` (invalidate a committed payload so it can't execute), `burn` (permanently drop). These prevent a permanently-stuck channel.
- **Exactly-once:** guaranteed by clearing `inboundPayloadHash` to EMPTY on successful execution + replay rejection (R-EP-4).

## 8. Configuration model

Per (OApp, remote EID): send library, receive library, `UlnConfig` (attestor set + threshold + confirmations), executor address, `enforcedOptions` (execution gas). Set via `Endpoint.setSendLibrary/setReceiveLibrary/setConfig` by the OApp owner/delegate. Defaults provided by protocol owner; OApps may override.

## 9. Testing strategy

**Conformance/Acceptance (CA):** every milestone has a CA gate — a defined set of executable checks that must pass (or be **red-by-design** at baseline) for the milestone to be "done". The program's *ultimate* CA baseline is the e2e + stress suites (below), authored **first**.

Three tiers:

### 9.1 Acceptance tier — built FIRST (the CA baseline)
Black-box, **TypeScript + Vitest + viem**, against local EVM node(s) and real worker processes. Authored before any component logic and held **red** until implementation turns it green. The arbitrary-data transfer scenario makes these simple to express and therefore a trustworthy north star: *send arbitrary `bytes` from app A → app B; assert delivered intact, exactly once, in order.*

- **E2E suite:** two local nodes + N real attestor processes + an arbitrary-data app (and a stub asset app). Full lifecycle; chaos (drop/restart an attestor, revert a receiver, source reorg if A1 relaxed); exactly-once + ordered-commit assertions end to end. Because `Endpoint.lzReceive` is permissionless, the **harness plays the executor** until subsystem 3 exists.
- **Stress suite:** sustained + burst throughput on one channel; many concurrent channels; large messages; nonce-gap pressure; attestor catch-up after lag; worker restart under load. Assert no gaps / no double-commit / no lost packets; record commit latency.

### 9.2 Integration tier — per subsystem, TDD entry point
Black-box **TS/Vitest** suites scoped to one subsystem (e.g. protocol-core contracts alone via harness-as-executor; attestor↔contract). For each implementation, the **integration suite is written first** (red) before the subsystem's code — the TDD entry point at the subsystem level.

### 9.3 Unit tier — per implementation step, TDD inner loop
Within each implementation step, **TDD with unit tests in the native toolchain**: Foundry (`forge test`) for Solidity, `go test` for the Go worker. Write the failing unit test for the step, implement minimally, green, commit. Unit tests cover step-level detail (codec byte offsets, threshold arithmetic, nonce edge cases, payload-hash recompute, cursor atomicity) that black-box suites assert only end-to-end.

> **Discipline (decided):** acceptance suites (9.1) first → then, per subsystem, integration suite (9.2) → then per-step unit-test TDD (9.3) while implementing. A milestone is complete only when its CA gate passes.

## 10. Decomposition into subsystem specs (next)

1. **Protocol core (contracts):** Endpoint + SendLib + ReceiveLib + codec + OApp base. **← Build now (phase 1).**
2. **Attestor worker (off-chain):** the M-of-N verification service. **← Build now (phase 1).**
3. **Executor worker (off-chain):** delivery + retry service. *(Phase 2.)*
4. **Cross-asset bridge app (OApp):** lock/release + pricing/liquidity. *(Phase 2; original ask; rides on 1–3.)*

**Decided build order:** subsystems **1 & 2 first** (covers send→verify→commit and lets the integration/stress suites run end-to-end up to commit), then design+implement 3 & 4. Each subsystem gets its own implementation plan (writing-plans).
