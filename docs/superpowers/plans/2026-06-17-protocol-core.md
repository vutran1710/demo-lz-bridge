# Protocol Core Implementation Plan (Subsystem 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the on-chain message-passing protocol (Endpoint + SendLib + ReceiveLib + packet codec + OApp base) for two permissioned EVM chains, modeled on LayerZero V2, verified by a black-box TypeScript/Vitest integration suite.

**Architecture:** Faithful LZ-V2 modularity. Immutable `Endpoint` owns channel state (nonces, committed payload hashes) and a per-OApp library/config registry. `SendLib` serializes packets and emits `PacketSent`. `ReceiveLib` accumulates M-of-N attestations and commits payload hashes via `Endpoint.verify`. `Endpoint.lzReceive` checks the committed hash and dispatches into an `OApp`. Ordered commit + parked-retry semantics.

**Tech Stack:** Solidity ^0.8.24, Foundry (build/deploy only — **no forge unit tests**), TypeScript + Vitest + viem for **all** tests (integration only, black-box), Anvil as the local EVM node.

**Build discipline (user-mandated):** Phase 1 establishes interfaces + reverting skeletons so the suite compiles. Phase 2 writes the **entire** integration suite (red). Phase 3 implements contracts until the suite is green. **No contract logic before the suite exists.**

---

## Milestones

Each milestone is independently reviewable and ends in a committed, demonstrable state. Do not start a milestone until the previous one's exit criteria are met.

| Milestone | Phase / Tasks | Deliverable | Exit criteria (gate) |
|-----------|---------------|-------------|----------------------|
| **M0 — Scaffold** | Phase 0 · Task 0 | Foundry contracts pkg + TS/Vitest workspace + Anvil wiring | `forge build` passes on an empty src; `pnpm vitest run` discovers 0 tests without error; committed |
| **M1 — Interfaces & skeletons** | Phase 1 · Tasks 1–2 | All types, events, interfaces, reverting contract skeletons, mock apps | `forge build` compiles; every contract deploys; every state method reverts `NotImplemented`; committed |
| **M2 — Test harness** | Phase 2 · Task 3 | Anvil/clients/abis/packet/attest/executor/deploy/app helpers | Harness can deploy the skeleton stack to a live Anvil node and submit a `send` tx that reverts `NotImplemented` (proves wiring, not logic) |
| **M3 — Integration suite (RED)** | Phase 2 · Tasks 4–10 | All 7 integration suites written | `pnpm test:integration` runs; **every** test fails for `NotImplemented`/missing-logic reasons only (no harness/compile errors); committed. **← user-mandated gate: all suites exist before any logic** |
| **M4 — Codec + app layer** | Phase 3 · Tasks 11–12 | `PacketCodec`, `OAppCore`, `OApp`, mock `sendMessage` | `forge build` passes; `PacketSent` fires on `send`; lifecycle suite progresses past the send step |
| **M5 — Send + verify path** | Phase 3 · Tasks 13–14 | `Endpoint.send`/`SendLib`, `ReceiveLib` M-of-N | **threshold** suite GREEN; lifecycle reaches commit |
| **M6 — Execute path (suite GREEN)** | Phase 3 · Task 15 | `Endpoint.verify` + `lzReceive` + escape hatches | **All 7 integration suites GREEN** |
| **M7 — Hardening & freeze** | Phase 3 · Task 16 | Contract size check, final green run | `forge build --sizes` within limits; 0 test failures; interface frozen for Plan 2 |

> Phase headings below are tagged with their milestone (e.g. `[M3]`) so executors can checkpoint at milestone boundaries.

**Relationship to the overall plan.** This is program milestone **P2** in `2026-06-17-overall-plan.md`. The program’s e2e + stress **acceptance baseline (P1)** is authored *before* this plan runs and is the ultimate CA. The **exit criteria** column above **is** each milestone’s CA gate. The integration suite (M3) below is this subsystem’s **TDD entry point** (written red first); see the per-step overlay next.

**TDD overlay (per implementation task in Phase 3).** The plan steps already follow red→green at the integration level. Within each Phase-3 task, also apply the **unit-test inner loop (§9.3)** in Foundry: before writing a step’s Solidity, add a failing `forge test` for that step’s detail, then implement to green, then commit. Map:

| Phase-3 task | Required failing `forge test` first |
|---|---|
| 11 PacketCodec | `test/Codec.t.sol` — header offsets, `guidOf`, `payloadHash`, `decodeHeader` round-trip + fuzz |
| 12 OApp | `test/OApp.t.sol` — `onlyEndpoint`/`onlyPeer` reverts, peer storage |
| 13 Send | `test/Send.t.sol` — outbound nonce monotonicity, `PacketSent` emit |
| 14 ReceiveLib | `test/Uln.t.sol` — threshold arithmetic (under/exact/over), non-member reject, double-commit reject |
| 15 Endpoint recv | `test/Channel.t.sol` — gap-free verify, hash-mismatch reject, clear-on-execute, parked-retry |

(Add `test/` back to `foundry.toml` for these unit tests; black-box suites stay in `/tests`.)

---

## File Structure

```
contracts/
  src/
    interfaces/
      IEndpoint.sol          # send/verify/lzReceive/config surface
      IMessageLib.sol        # ISendLib + IReceiveLib
      IOAppCore.sol          # peer registry
      ILayerZeroReceiver.sol # lzReceive callback on apps
    libraries/
      PacketCodec.sol        # §4 byte layout, guid, payloadHash
    Endpoint.sol             # channel state + registry + send/verify/lzReceive
    SendLib.sol              # packet build + PacketSent + fee
    ReceiveLib.sol           # M-of-N verify + commitVerification
    OAppCore.sol             # peer storage + auth
    OApp.sol                 # OAppSender + OAppReceiver
    mocks/
      AppEcho.sol            # test OApp: echoes received bytes into an event
      AppRevert.sol          # test OApp: reverts in _lzReceive on demand (park/retry)
  foundry.toml
  remappings.txt
tests/                       # TS workspace (pnpm + vitest + viem)
  package.json
  vitest.config.ts
  src/
    harness/
      anvil.ts               # spawn/stop a local anvil node
      deploy.ts              # deploy + wire the full contract set
      packet.ts              # TS mirror of PacketCodec (encode/guid/payloadHash)
      attest.ts              # produce M-of-N attestor signatures / verify calls
      executor.ts            # harness-as-executor: call Endpoint.lzReceive
      clients.ts             # viem wallet/public clients, funded test accounts
      abis.ts                # generated ABIs (from forge build artifacts)
    integration/
      lifecycle.test.ts      # happy path send→verify→commit→execute
      retry.test.ts          # reverting receiver → park → retry → success
      threshold.test.ts      # under/at/over M-of-N; non-member rejection
      ordering.test.ts       # ordered commit; out-of-order/double-commit rejection
      replay.test.ts         # cleared hash not re-executable; mutated message rejected
      peerauth.test.ts       # lzReceive only from Endpoint; sender==peer required
      escape.test.ts         # skip / nilify / burn behavior
  tsconfig.json
package.json                 # workspace root (pnpm-workspace.yaml)
```

---

## Phase 0 — Scaffold `[M0]`

### Task 0: Initialize the monorepo

**Files:**
- Create: `foundry.toml`, `contracts/`, `tests/`, `package.json`, `pnpm-workspace.yaml`

- [ ] **Step 1: Scaffold Foundry contracts package**

Run:
```bash
mkdir -p contracts && cd contracts && forge init --no-git --no-commit . && rm -rf test script src/Counter.sol && cd ..
```

- [ ] **Step 2: Configure `contracts/foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
# no `test` dir — tests live in /tests (TypeScript)
```

- [ ] **Step 3: Scaffold the TS test workspace**

Run:
```bash
mkdir -p tests/src/harness tests/src/integration
cd tests && pnpm init -y && pnpm add -D vitest viem @types/node typescript tsx && cd ..
```

- [ ] **Step 4: Add `tests/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false, // each suite owns an anvil node + deploy; no cross-talk
  },
})
```

- [ ] **Step 5: Add root `package.json` scripts**

```json
{
  "name": "bridge",
  "private": true,
  "scripts": {
    "build:contracts": "cd contracts && forge build",
    "test:integration": "cd tests && pnpm vitest run src/integration"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold contracts (foundry) + ts integration workspace (vitest/viem)"
```

---

## Phase 1 — Interfaces & reverting skeletons `[M1]`

> Goal: the contract set **compiles, deploys, and is callable**, but every state-changing method reverts `"NOT_IMPLEMENTED"`. This lets the Phase-2 suite deploy and exercise the ABI; every assertion fails until Phase 3.

### Task 1: Shared types & events

**Files:**
- Create: `contracts/src/interfaces/IEndpoint.sol` (types + events block at top)

- [ ] **Step 1: Define structs & events**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct MessagingParams { uint32 dstEid; bytes32 receiver; bytes message; bytes options; bool payInLzToken; }
struct MessagingFee   { uint256 nativeFee; uint256 lzTokenFee; }
struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }
struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }
struct SetConfigParam { uint32 eid; uint32 configType; bytes config; }

// ReceiveLib config decoded from SetConfigParam.config for configType = CONFIG_TYPE_ULN (=2)
struct UlnConfig {
    uint64  confirmations;
    address[] requiredAttestors;   // all must sign
    address[] optionalAttestors;   // X of these must sign
    uint8   optionalThreshold;     // X
}

event PacketSent(bytes encodedPacket, bytes options, address sendLibrary);
event PacketVerified(Origin origin, address receiver, bytes32 payloadHash); // emitted on commit
event PacketDelivered(Origin origin, address receiver);                     // emitted on successful execute
event LzReceiveAlert(address indexed receiver, address indexed executor, Origin origin, bytes32 guid, bytes reason);
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `cd contracts && forge build`
Expected: compiles (no contracts yet, just types — add the interface in Task 2 in the same file region).

- [ ] **Step 3: Commit**

```bash
git add contracts/src/interfaces/IEndpoint.sol && git commit -m "feat(contracts): shared messaging types and events"
```

### Task 2: Interfaces + reverting skeleton contracts

**Files:**
- Modify: `contracts/src/interfaces/IEndpoint.sol`
- Create: `contracts/src/interfaces/IMessageLib.sol`, `IOAppCore.sol`, `ILayerZeroReceiver.sol`
- Create: `contracts/src/Endpoint.sol`, `SendLib.sol`, `ReceiveLib.sol`, `OAppCore.sol`, `OApp.sol`
- Create: `contracts/src/mocks/AppEcho.sol`, `AppRevert.sol`

- [ ] **Step 1: Append `IEndpoint` to `IEndpoint.sol`**

```solidity
interface IEndpoint {
    function quote(MessagingParams calldata p, address sender) external view returns (MessagingFee memory);
    function send(MessagingParams calldata p, address refundAddress) external payable returns (MessagingReceipt memory);

    function verify(Origin calldata o, address receiver, bytes32 payloadHash) external;
    function lzReceive(Origin calldata o, address receiver, bytes32 guid, bytes calldata message, bytes calldata extraData) external payable;

    function skip(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce) external;
    function nilify(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash) external;
    function burn(address oapp, uint32 srcEid, bytes32 sender, uint64 nonce, bytes32 payloadHash) external;

    function setSendLibrary(address oapp, uint32 eid, address lib) external;
    function setReceiveLibrary(address oapp, uint32 eid, address lib, uint256 gracePeriod) external;
    function setConfig(address oapp, address lib, SetConfigParam[] calldata params) external;
    function setDelegate(address delegate) external;

    function outboundNonce(address sender, uint32 dstEid, bytes32 receiver) external view returns (uint64);
    function inboundNonce(address receiver, uint32 srcEid, bytes32 sender) external view returns (uint64);
    function inboundPayloadHash(address receiver, uint32 srcEid, bytes32 sender, uint64 nonce) external view returns (bytes32);
}
```

- [ ] **Step 2: `IMessageLib.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./IEndpoint.sol";

struct Packet { uint64 nonce; uint32 srcEid; address sender; uint32 dstEid; bytes32 receiver; bytes32 guid; bytes message; }

interface ISendLib {
    function send(Packet calldata packet, bytes calldata options, bool payInLzToken)
        external returns (MessagingFee memory fee, bytes memory encodedPacket);
    function quote(Packet calldata packet, bytes calldata options, bool payInLzToken)
        external view returns (MessagingFee memory);
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
}

interface IReceiveLib {
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external;
    function commitVerification(bytes calldata packetHeader, bytes32 payloadHash) external;
    function setConfig(address oapp, SetConfigParam[] calldata params) external;
    function getUlnConfig(address oapp, uint32 srcEid) external view returns (UlnConfig memory);
}
```

- [ ] **Step 3: `IOAppCore.sol` and `ILayerZeroReceiver.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IOAppCore {
    function setPeer(uint32 eid, bytes32 peer) external;
    function peers(uint32 eid) external view returns (bytes32);
}
```

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./IEndpoint.sol";
interface ILayerZeroReceiver {
    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData) external payable;
}
```

- [ ] **Step 4: Reverting skeletons — `Endpoint.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./interfaces/IEndpoint.sol";

contract Endpoint is IEndpoint {
    uint32 public immutable eid;
    constructor(uint32 _eid) { eid = _eid; }
    error NotImplemented();

    function quote(MessagingParams calldata, address) external pure returns (MessagingFee memory) { revert NotImplemented(); }
    function send(MessagingParams calldata, address) external payable returns (MessagingReceipt memory) { revert NotImplemented(); }
    function verify(Origin calldata, address, bytes32) external pure { revert NotImplemented(); }
    function lzReceive(Origin calldata, address, bytes32, bytes calldata, bytes calldata) external payable { revert NotImplemented(); }
    function skip(address, uint32, bytes32, uint64) external pure { revert NotImplemented(); }
    function nilify(address, uint32, bytes32, uint64, bytes32) external pure { revert NotImplemented(); }
    function burn(address, uint32, bytes32, uint64, bytes32) external pure { revert NotImplemented(); }
    function setSendLibrary(address, uint32, address) external pure { revert NotImplemented(); }
    function setReceiveLibrary(address, uint32, address, uint256) external pure { revert NotImplemented(); }
    function setConfig(address, address, SetConfigParam[] calldata) external pure { revert NotImplemented(); }
    function setDelegate(address) external pure { revert NotImplemented(); }
    function outboundNonce(address, uint32, bytes32) external pure returns (uint64) { revert NotImplemented(); }
    function inboundNonce(address, uint32, bytes32) external pure returns (uint64) { revert NotImplemented(); }
    function inboundPayloadHash(address, uint32, bytes32, uint64) external pure returns (bytes32) { revert NotImplemented(); }
}
```

- [ ] **Step 5: Reverting skeletons — `SendLib.sol`, `ReceiveLib.sol`, `OAppCore.sol`, `OApp.sol`**

Each implements its interface with every external method `revert NotImplemented();` (mirror the pattern above). `OApp` is `abstract` with a `virtual _lzReceive(Origin, bytes32, bytes, address, bytes)` hook and a concrete `lzReceive` that reverts for now.

- [ ] **Step 6: Mocks — `AppEcho.sol`, `AppRevert.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../OApp.sol";

contract AppEcho is OApp {
    event Echoed(uint32 srcEid, bytes32 sender, uint64 nonce, bytes message);
    constructor(address ep) OApp(ep) {}
    function _lzReceive(Origin calldata o, bytes32, bytes calldata message, address, bytes calldata) internal override {
        emit Echoed(o.srcEid, o.sender, o.nonce, message);
    }
}
```

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../OApp.sol";

contract AppRevert is OApp {
    bool public failing = true;
    event Received(uint64 nonce);
    constructor(address ep) OApp(ep) {}
    function setFailing(bool f) external { failing = f; }
    function _lzReceive(Origin calldata o, bytes32, bytes calldata, address, bytes calldata) internal override {
        require(!failing, "APP_REVERT");
        emit Received(o.nonce);
    }
}
```

- [ ] **Step 7: Build**

Run: `cd contracts && forge build`
Expected: PASS (compiles; deployable skeletons).

- [ ] **Step 8: Commit**

```bash
git add contracts/src && git commit -m "feat(contracts): interfaces + reverting skeletons + mock apps"
```

---

## Phase 2 — Integration suite (TS/Vitest, all red) `[M2 harness · M3 suites]`

> Every test below should FAIL after Phase 1 (skeletons revert `NotImplemented`). That red state is the deliverable of this phase.

### Task 3: Harness — node, clients, ABIs, packet mirror

**Files:**
- Create: `tests/src/harness/anvil.ts`, `clients.ts`, `abis.ts`, `packet.ts`, `attest.ts`, `executor.ts`, `deploy.ts`

- [ ] **Step 1: `anvil.ts` — spawn/stop a local node**

```ts
import { spawn, type ChildProcess } from 'node:child_process'
export async function startAnvil(port = 8545): Promise<{ rpc: string; stop: () => void }> {
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--silent', '--chain-id', '31337'])
  const rpc = `http://127.0.0.1:${port}`
  await waitForRpc(rpc)
  return { rpc, stop: () => proc.kill('SIGKILL') }
}
async function waitForRpc(rpc: string) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(rpc, { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_chainId', params:[] }) }); return }
    catch { await new Promise(r => setTimeout(r, 100)) }
  }
  throw new Error('anvil did not start')
}
```

- [ ] **Step 2: `clients.ts` — viem wallet/public clients + funded keys**

```ts
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
// anvil default mnemonic accounts
export const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
] as const
export function clients(rpc: string) {
  const transport = http(rpc)
  const pub = createPublicClient({ chain: foundry, transport })
  const wallets = KEYS.map(k => createWalletClient({ account: privateKeyToAccount(k), chain: foundry, transport }))
  return { pub, wallets, accounts: KEYS.map(k => privateKeyToAccount(k)) }
}
```

- [ ] **Step 3: `abis.ts` — import ABIs from forge artifacts**

```ts
import endpoint from '../../../contracts/out/Endpoint.sol/Endpoint.json'
import sendLib from '../../../contracts/out/SendLib.sol/SendLib.json'
import receiveLib from '../../../contracts/out/ReceiveLib.sol/ReceiveLib.json'
import appEcho from '../../../contracts/out/AppEcho.sol/AppEcho.json'
import appRevert from '../../../contracts/out/AppRevert.sol/AppRevert.json'
export const ABI = {
  Endpoint:  { abi: endpoint.abi,  bytecode: endpoint.bytecode.object as `0x${string}` },
  SendLib:   { abi: sendLib.abi,   bytecode: sendLib.bytecode.object as `0x${string}` },
  ReceiveLib:{ abi: receiveLib.abi,bytecode: receiveLib.bytecode.object as `0x${string}` },
  AppEcho:   { abi: appEcho.abi,   bytecode: appEcho.bytecode.object as `0x${string}` },
  AppRevert: { abi: appRevert.abi, bytecode: appRevert.bytecode.object as `0x${string}` },
}
```

- [ ] **Step 4: `packet.ts` — TS mirror of §4 codec (the executable spec for the byte layout)**

```ts
import { encodePacked, keccak256, pad, toHex, concat, type Hex } from 'viem'

export function buildGuid(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex): Hex {
  return keccak256(encodePacked(
    ['uint64','uint32','bytes32','uint32','bytes32'],
    [nonce, srcEid, pad(sender, { size: 32 }), dstEid, pad(receiver, { size: 32 })]))
}
export function encodeHeader(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex): Hex {
  return encodePacked(
    ['uint8','uint64','uint32','bytes32','uint32','bytes32'],
    [1, nonce, srcEid, pad(sender, { size: 32 }), dstEid, pad(receiver, { size: 32 })])
}
export function payloadHashOf(guid: Hex, message: Hex): Hex {
  return keccak256(concat([guid, message]))
}
export function encodePacket(nonce: bigint, srcEid: number, sender: Hex, dstEid: number, receiver: Hex, message: Hex) {
  const guid = buildGuid(nonce, srcEid, sender, dstEid, receiver)
  const header = encodeHeader(nonce, srcEid, sender, dstEid, receiver)
  return { guid, header, payloadHash: payloadHashOf(guid, message), encoded: concat([header, guid, message]) }
}
```

- [ ] **Step 5: `attest.ts` — drive M-of-N `verify` calls from attestor accounts**

```ts
import type { Hex } from 'viem'
// Each attestor (by index into clients.wallets) submits ReceiveLib.verify(header, payloadHash, confirmations)
export async function attest(ctx: any, attestorIdxs: number[], header: Hex, payloadHash: Hex, confirmations: bigint) {
  for (const i of attestorIdxs) {
    await ctx.wallets[i].writeContract({
      address: ctx.receiveLib, abi: ctx.abi.ReceiveLib.abi,
      functionName: 'verify', args: [header, payloadHash, confirmations],
    })
  }
}
```

- [ ] **Step 6: `executor.ts` — harness plays the executor (Phase 1 has no executor worker)**

```ts
import type { Hex } from 'viem'
export async function execute(ctx: any, origin: { srcEid:number; sender:Hex; nonce:bigint }, receiver: Hex, guid: Hex, message: Hex) {
  return ctx.wallets[0].writeContract({
    address: ctx.endpoint, abi: ctx.abi.Endpoint.abi,
    functionName: 'lzReceive', args: [origin, receiver, guid, message, '0x'],
  })
}
```

- [ ] **Step 7: `deploy.ts` — deploy + wire the full set on one node**

```ts
import { ABI } from './abis'
import type { Hex } from 'viem'
// Deploys Endpoint(eid), SendLib, ReceiveLib, wires default libs, returns a context object.
export async function deployStack(rpc: string, eid: number, pub: any, wallets: any[]) {
  async function deploy(c: {abi:any;bytecode:Hex}, args: any[] = []) {
    const hash = await wallets[0].deployContract({ abi: c.abi, bytecode: c.bytecode, args })
    const r = await pub.waitForTransactionReceipt({ hash }); return r.contractAddress as Hex
  }
  const endpoint   = await deploy(ABI.Endpoint, [eid])
  const sendLib    = await deploy(ABI.SendLib, [endpoint])
  const receiveLib = await deploy(ABI.ReceiveLib, [endpoint])
  return { rpc, eid, endpoint, sendLib, receiveLib, pub, wallets, abi: ABI }
}
```

- [ ] **Step 8: Commit harness**

```bash
git add tests/src/harness && git commit -m "test(harness): anvil/clients/abis/packet/attest/executor/deploy"
```

### Task 4: Lifecycle integration test (happy path)

**Files:**
- Create: `tests/src/integration/lifecycle.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { beforeAll, afterAll, expect, test } from 'vitest'
import { startAnvil } from '../harness/anvil'
import { clients } from '../harness/clients'
import { deployStack } from '../harness/deploy'
import { encodePacket } from '../harness/packet'
import { attest } from '../harness/attest'
import { execute } from '../harness/executor'
import { decodeEventLog, pad, stringToHex, type Hex } from 'viem'

let node: { rpc: string; stop: () => void }, ctx: any, appA: Hex, appB: Hex
const EID_A = 1, EID_B = 2
const M = 2 // 2-of-3

beforeAll(async () => {
  node = await startAnvil(8545)
  const { pub, wallets } = clients(node.rpc)
  ctx = await deployStack(node.rpc, EID_B, pub, wallets) // single-node model: src+dst share node, distinguished by eid
  // deploy two apps; configure receiveLib M-of-N with attestor accounts [1,2,3]
  appA = await deployApp(ctx, 'AppEcho')
  appB = await deployApp(ctx, 'AppEcho')
  await wireChannel(ctx, appA, appB, EID_A, EID_B, /*attestors*/[1,2,3], /*required*/[], /*optional threshold*/ M)
})
afterAll(() => node.stop())

test('send → verify(M-of-N) → commit → execute delivers the message exactly once', async () => {
  const message = stringToHex('hello-omnichain')
  const nonce = 1n
  const { guid, header, payloadHash, encoded } =
    encodePacket(nonce, EID_A, appA, EID_B, appB, message)

  // 1. send from appA toward appB
  await sendFrom(ctx, appA, EID_B, appB, message)

  // 2. M-of-N attest on the destination receiveLib
  await attest(ctx, [1,2], header, payloadHash, 1n)

  // 3. commit
  await ctx.wallets[0].writeContract({ address: ctx.receiveLib, abi: ctx.abi.ReceiveLib.abi,
    functionName: 'commitVerification', args: [header, payloadHash] })
  const committed = await ctx.pub.readContract({ address: ctx.endpoint, abi: ctx.abi.Endpoint.abi,
    functionName: 'inboundPayloadHash', args: [appB, EID_A, pad(appA,{size:32}), nonce] })
  expect(committed).toBe(payloadHash)

  // 4. execute (harness-as-executor) and observe the app event
  const rcpt = await ctx.pub.waitForTransactionReceipt({
    hash: await execute(ctx, { srcEid: EID_A, sender: pad(appA,{size:32}), nonce }, appB, guid, message) })
  const echoed = rcpt.logs.map((l:any) => safeDecode(ctx.abi.AppEcho.abi, l)).find((e:any)=>e?.eventName==='Echoed')
  expect(echoed.args.message).toBe(message)

  // 5. exactly-once: committed hash cleared
  const after = await ctx.pub.readContract({ address: ctx.endpoint, abi: ctx.abi.Endpoint.abi,
    functionName: 'inboundPayloadHash', args: [appB, EID_A, pad(appA,{size:32}), nonce] })
  expect(after).toBe('0x' + '0'.repeat(64))
})
```

Helper functions `deployApp`, `wireChannel`, `sendFrom`, `safeDecode` go in `tests/src/harness/app.ts` (Step 2).

- [ ] **Step 2: Write `tests/src/harness/app.ts` helpers**

```ts
import { ABI } from './abis'
import { encodeAbiParameters, pad, type Hex } from 'viem'

export async function deployApp(ctx: any, kind: 'AppEcho'|'AppRevert'): Promise<Hex> {
  const c = ABI[kind]
  const hash = await ctx.wallets[0].deployContract({ abi: c.abi, bytecode: c.bytecode, args: [ctx.endpoint] })
  const r = await ctx.pub.waitForTransactionReceipt({ hash }); return r.contractAddress
}

// encode UlnConfig into SetConfigParam.config (configType=2)
export function ulnConfigBytes(confirmations: bigint, required: Hex[], optional: Hex[], threshold: number): Hex {
  return encodeAbiParameters(
    [{ type:'tuple', components:[
      {name:'confirmations',type:'uint64'},
      {name:'requiredAttestors',type:'address[]'},
      {name:'optionalAttestors',type:'address[]'},
      {name:'optionalThreshold',type:'uint8'}]}],
    [{ confirmations, requiredAttestors: required, optionalAttestors: optional, optionalThreshold: threshold }])
}

export async function wireChannel(ctx:any, appA:Hex, appB:Hex, eidA:number, eidB:number,
                                  attestorIdxs:number[], required:Hex[], optThreshold:number) {
  const optional = attestorIdxs.map(i => ctx.wallets[i].account.address as Hex)
  // peers
  await ctx.wallets[0].writeContract({ address: appA, abi: ABI.AppEcho.abi, functionName:'setPeer', args:[eidB, pad(appB,{size:32})] })
  await ctx.wallets[0].writeContract({ address: appB, abi: ABI.AppEcho.abi, functionName:'setPeer', args:[eidA, pad(appA,{size:32})] })
  // libraries
  for (const app of [appA, appB]) {
    await ctx.wallets[0].writeContract({ address: ctx.endpoint, abi: ABI.Endpoint.abi, functionName:'setSendLibrary', args:[app, eidB, ctx.sendLib] })
    await ctx.wallets[0].writeContract({ address: ctx.endpoint, abi: ABI.Endpoint.abi, functionName:'setReceiveLibrary', args:[app, eidA, ctx.receiveLib, 0n] })
  }
  // ULN config on receiveLib for the receiver app (appB), src = eidA
  const cfg = ulnConfigBytes(1n, required, optional, optThreshold)
  await ctx.wallets[0].writeContract({ address: ctx.endpoint, abi: ABI.Endpoint.abi,
    functionName:'setConfig', args:[appB, ctx.receiveLib, [{ eid: eidA, configType: 2, config: cfg }]] })
}

export async function sendFrom(ctx:any, app:Hex, dstEid:number, receiver:Hex, message:Hex) {
  // AppEcho exposes a thin `send(dstEid, message)` test entrypoint (added to OApp via a `sendMessage` helper)
  return ctx.wallets[0].writeContract({ address: app, abi: ABI.AppEcho.abi, functionName:'sendMessage',
    args:[dstEid, message], value: 0n })
}

export function safeDecode(abi:any, log:any) {
  try { const { decodeEventLog } = require('viem'); return decodeEventLog({ abi, ...log }) } catch { return null }
}
```

> Note for Phase 3: `AppEcho`/`AppRevert` must expose `sendMessage(uint32 dstEid, bytes message)` calling `_lzSend`. Add that to the mocks when implementing OApp (Task 12).

- [ ] **Step 3: Run the suite to confirm RED**

Run: `pnpm test:integration`
Expected: FAIL — `send`/`verify`/`commitVerification`/`lzReceive` revert `NotImplemented`.

- [ ] **Step 4: Commit**

```bash
git add tests/src && git commit -m "test(integration): lifecycle happy-path suite (red)"
```

### Task 5: Retry suite (reverting receiver → park → retry)

**Files:**
- Create: `tests/src/integration/retry.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { beforeAll, afterAll, expect, test } from 'vitest'
import { startAnvil } from '../harness/anvil'; import { clients } from '../harness/clients'
import { deployStack } from '../harness/deploy'; import { deployApp, wireChannel, sendFrom } from '../harness/app'
import { encodePacket } from '../harness/packet'; import { attest } from '../harness/attest'; import { execute } from '../harness/executor'
import { pad, stringToHex, type Hex } from 'viem'

let node:any, ctx:any, appA:Hex, appB:Hex; const EID_A=1, EID_B=2
beforeAll(async () => {
  node = await startAnvil(8546); const { pub, wallets } = clients(node.rpc)
  ctx = await deployStack(node.rpc, EID_B, pub, wallets)
  appA = await deployApp(ctx, 'AppEcho'); appB = await deployApp(ctx, 'AppRevert')
  await wireChannel(ctx, appA, appB, EID_A, EID_B, [1,2,3], [], 2)
})
afterAll(() => node.stop())

test('reverting receiver parks the message; hash stays committed; retry after fix succeeds', async () => {
  const message = stringToHex('retry-me'); const nonce = 1n
  const { guid, header, payloadHash } = encodePacket(nonce, EID_A, appA, EID_B, appB, message)
  await sendFrom(ctx, appA, EID_B, appB, message)
  await attest(ctx, [1,2], header, payloadHash, 1n)
  await ctx.wallets[0].writeContract({ address: ctx.receiveLib, abi: ctx.abi.ReceiveLib.abi, functionName:'commitVerification', args:[header, payloadHash] })

  // execute while AppRevert.failing == true → lzReceive tx reverts, hash remains
  await expect(ctx.pub.waitForTransactionReceipt({
    hash: await execute(ctx, { srcEid:EID_A, sender:pad(appA,{size:32}), nonce }, appB, guid, message) })
  ).rejects.toBeTruthy()
  const stillCommitted = await ctx.pub.readContract({ address: ctx.endpoint, abi: ctx.abi.Endpoint.abi,
    functionName:'inboundPayloadHash', args:[appB, EID_A, pad(appA,{size:32}), nonce] })
  expect(stillCommitted).toBe(payloadHash)

  // fix the app, retry succeeds, hash clears
  await ctx.wallets[0].writeContract({ address: appB, abi: ctx.abi.AppRevert.abi, functionName:'setFailing', args:[false] })
  await ctx.pub.waitForTransactionReceipt({
    hash: await execute(ctx, { srcEid:EID_A, sender:pad(appA,{size:32}), nonce }, appB, guid, message) })
  const cleared = await ctx.pub.readContract({ address: ctx.endpoint, abi: ctx.abi.Endpoint.abi,
    functionName:'inboundPayloadHash', args:[appB, EID_A, pad(appA,{size:32}), nonce] })
  expect(cleared).toBe('0x' + '0'.repeat(64))
})
```

- [ ] **Step 2: Run → RED.** `pnpm test:integration` — fails on `NotImplemented`.
- [ ] **Step 3: Commit.** `git add tests/src/integration/retry.test.ts && git commit -m "test(integration): park/retry suite (red)"`

### Task 6: Threshold suite (M-of-N)

**Files:** Create `tests/src/integration/threshold.test.ts`

- [ ] **Step 1: Write tests covering each case** (one `test()` each):
  - `under-threshold does not commit`: attest with `[1]` only (1 of required-2) → `commitVerification` reverts; `inboundPayloadHash` is empty.
  - `exact threshold commits`: attest `[1,2]` → commit succeeds; hash stored.
  - `over threshold still commits once`: attest `[1,2,3]` → commit once; second `commitVerification` reverts (double-commit).
  - `non-member attestation rejected`: have account `[3]` removed from config, attest `[3]` → `verify` reverts `NOT_A_VERIFIER` (or its attestation is ignored and commit stays under threshold).

```ts
// shape (under-threshold case shown; replicate per case with adjusted attestor sets/expectations)
test('under threshold: commitVerification reverts and nothing is committed', async () => {
  const message = stringToHex('uth'); const nonce = 1n
  const { header, payloadHash } = encodePacket(nonce, EID_A, appA, EID_B, appB, message)
  await sendFrom(ctx, appA, EID_B, appB, message)
  await attest(ctx, [1], header, payloadHash, 1n) // only 1 of 2
  await expect(ctx.pub.waitForTransactionReceipt({ hash: await ctx.wallets[0].writeContract({
    address: ctx.receiveLib, abi: ctx.abi.ReceiveLib.abi, functionName:'commitVerification', args:[header, payloadHash] }) }))
    .rejects.toBeTruthy()
})
```

- [ ] **Step 2: Run → RED.**
- [ ] **Step 3: Commit.** `git commit -m "test(integration): M-of-N threshold suite (red)"`

### Task 7: Ordering suite

**Files:** Create `tests/src/integration/ordering.test.ts`

- [ ] **Step 1: Write tests:**
  - `commit advances inboundNonce gap-free`: send nonces 1,2; committing nonce 2 before nonce 1 reverts (`INVALID_NONCE`); committing 1 then 2 works.
  - `ordered execution: nonce 2 cannot execute before nonce 1`: with channel in ordered mode, executing nonce 2 while 1 is committed-unexecuted reverts; after 1 executes, 2 executes.

```ts
test('ordered commit is gap-free: cannot commit nonce 2 before nonce 1', async () => {
  const m1 = stringToHex('n1'), m2 = stringToHex('n2')
  await sendFrom(ctx, appA, EID_B, appB, m1); await sendFrom(ctx, appA, EID_B, appB, m2)
  const p1 = encodePacket(1n, EID_A, appA, EID_B, appB, m1)
  const p2 = encodePacket(2n, EID_A, appA, EID_B, appB, m2)
  await attest(ctx, [1,2], p2.header, p2.payloadHash, 1n)
  await expect(ctx.pub.waitForTransactionReceipt({ hash: await ctx.wallets[0].writeContract({
    address: ctx.receiveLib, abi: ctx.abi.ReceiveLib.abi, functionName:'commitVerification', args:[p2.header, p2.payloadHash] }) }))
    .rejects.toBeTruthy()
})
```

- [ ] **Step 2: Run → RED.**  
- [ ] **Step 3: Commit.** `git commit -m "test(integration): ordering suite (red)"`

### Task 8: Replay & payload-integrity suite

**Files:** Create `tests/src/integration/replay.test.ts`

- [ ] **Step 1: Write tests:**
  - `executed message cannot be replayed`: after a successful execute, calling `lzReceive` again with same args reverts (hash empty).
  - `mutated message rejected`: commit `payloadHash` for `message`, then call `lzReceive` with a different `message'` → reverts (`PAYLOAD_HASH_MISMATCH`).
- [ ] **Step 2: Run → RED.**  
- [ ] **Step 3: Commit.** `git commit -m "test(integration): replay + payload integrity suite (red)"`

### Task 9: Peer-auth suite

**Files:** Create `tests/src/integration/peerauth.test.ts`

- [ ] **Step 1: Write tests:**
  - `lzReceive only callable by Endpoint`: call `AppEcho.lzReceive` directly from a wallet → reverts (`ONLY_ENDPOINT`).
  - `sender must equal configured peer`: execute with `origin.sender` != `peers(srcEid)` → reverts (`ONLY_PEER`). Achieve by setting appB's peer to a different address than appA.
- [ ] **Step 2: Run → RED.**  
- [ ] **Step 3: Commit.** `git commit -m "test(integration): peer-auth suite (red)"`

### Task 10: Escape-hatch suite

**Files:** Create `tests/src/integration/escape.test.ts`

- [ ] **Step 1: Write tests (owner-only channel management):**
  - `skip advances past an un-committed nonce`: send nonce 1, never commit; owner `skip(appB, EID_A, peer, 1)`; then nonce 2 commits normally.
  - `nilify blocks a committed payload from executing`: commit nonce 1; owner `nilify(...)`; `lzReceive` for nonce 1 reverts; channel can proceed via skip.
  - `burn permanently drops a committed payload`: commit nonce 1; owner `burn(...)`; `inboundPayloadHash` empty and not executable.
  - `escape hatches are owner-only`: a non-owner calling `skip` reverts.
- [ ] **Step 2: Run → RED.**  
- [ ] **Step 3: Commit.** `git commit -m "test(integration): escape-hatch suite (red); phase-2 complete"`

> **End of Phase 2 self-check:** `pnpm test:integration` runs all 7 files; every test is RED for `NotImplemented`/missing-logic reasons (not for harness errors). Fix any harness/compile issues so failures are purely "logic not implemented."

---

## Phase 3 — Implementation (turn the suite green) `[M4–M7]`

> Implement in dependency order. After each task, run `pnpm build:contracts && pnpm test:integration` and watch the relevant suite(s) go green. Commit per task.

### Task 11: Implement `PacketCodec.sol`

**Files:** Create `contracts/src/libraries/PacketCodec.sol`; Modify `SendLib.sol` to use it.

- [ ] **Step 1: Implement codec to match §4 and `packet.ts` exactly**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../interfaces/IMessageLib.sol";

library PacketCodec {
    uint8 internal constant VERSION = 1;
    function guidOf(uint64 nonce, uint32 srcEid, address sender, uint32 dstEid, bytes32 receiver) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(nonce, srcEid, bytes32(uint256(uint160(sender))), dstEid, receiver));
    }
    function header(Packet memory p) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, p.nonce, p.srcEid, bytes32(uint256(uint160(p.sender))), p.dstEid, p.receiver);
    }
    function payloadHash(bytes32 guid, bytes memory message) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(guid, message));
    }
    function encode(Packet memory p) internal pure returns (bytes memory) {
        return abi.encodePacked(header(p), p.guid, p.message);
    }
    // decode the 81-byte header into an Origin + receiver
    function decodeHeader(bytes calldata h) internal pure returns (Origin memory o, bytes32 receiver, uint32 dstEid) {
        require(h.length >= 81 && uint8(h[0]) == VERSION, "BAD_HEADER");
        o.nonce  = uint64(bytes8(h[1:9]));
        o.srcEid = uint32(bytes4(h[9:13]));
        o.sender = bytes32(h[13:45]);
        dstEid   = uint32(bytes4(h[45:49]));
        receiver = bytes32(h[49:81]);
    }
}
```

- [ ] **Step 2: Build.** `cd contracts && forge build` → PASS.
- [ ] **Step 3: Commit.** `git commit -am "feat(contracts): PacketCodec per spec §4"`

### Task 12: Implement `OAppCore` + `OApp` + mock send entrypoint

**Files:** Modify `OAppCore.sol`, `OApp.sol`, `mocks/AppEcho.sol`, `mocks/AppRevert.sol`.

- [ ] **Step 1: `OAppCore.sol`** — peer storage, `Ownable`, `ONLY_PEER`/`ONLY_ENDPOINT` errors.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./interfaces/IOAppCore.sol";
import "./interfaces/IEndpoint.sol";

abstract contract OAppCore is IOAppCore {
    IEndpoint public immutable endpoint;
    address public owner;
    mapping(uint32 => bytes32) public peers;
    error OnlyOwner(); error OnlyEndpoint(); error OnlyPeer();
    modifier onlyOwner() { if (msg.sender != owner) revert OnlyOwner(); _; }
    constructor(address _endpoint) { endpoint = IEndpoint(_endpoint); owner = msg.sender; }
    function setPeer(uint32 eid, bytes32 peer) external onlyOwner { peers[eid] = peer; }
}
```

- [ ] **Step 2: `OApp.sol`** — `_lzSend`, public `lzReceive` with auth, `_lzReceive` hook.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./OAppCore.sol";
import "./interfaces/ILayerZeroReceiver.sol";

abstract contract OApp is OAppCore, ILayerZeroReceiver {
    constructor(address ep) OAppCore(ep) {}
    function _lzSend(uint32 dstEid, bytes memory message, bytes memory options) internal returns (MessagingReceipt memory) {
        return endpoint.send{value: msg.value}(
            MessagingParams({ dstEid: dstEid, receiver: peers[dstEid], message: message, options: options, payInLzToken: false }),
            msg.sender);
    }
    function lzReceive(Origin calldata o, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData) external payable {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint();
        if (o.sender != peers[o.srcEid]) revert OnlyPeer();
        _lzReceive(o, guid, message, executor, extraData);
    }
    function _lzReceive(Origin calldata o, bytes32 guid, bytes calldata message, address executor, bytes calldata extraData) internal virtual;
}
```

- [ ] **Step 3: Add `sendMessage` to mocks** (the test entrypoint `app.ts` calls):

```solidity
function sendMessage(uint32 dstEid, bytes calldata message) external payable {
    _lzSend(dstEid, message, "");
}
```

- [ ] **Step 4: Build.** `forge build` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(contracts): OAppCore + OApp + mock send entrypoint"`

### Task 13: Implement `SendLib` + `Endpoint.send`/`quote`

**Files:** Modify `SendLib.sol`, `Endpoint.sol`.

- [ ] **Step 1: `Endpoint` send path** — outbound nonce, build `Packet`, delegate to configured SendLib, return receipt.

```solidity
// inside Endpoint
mapping(address => mapping(uint32 => mapping(bytes32 => uint64))) public _outboundNonce;
mapping(address => mapping(uint32 => address)) public sendLib;     // oapp => dstEid => lib
function outboundNonce(address s, uint32 d, bytes32 r) external view returns (uint64) { return _outboundNonce[s][d][r]; }

function send(MessagingParams calldata p, address) external payable returns (MessagingReceipt memory rcpt) {
    uint64 nonce = ++_outboundNonce[msg.sender][p.dstEid][p.receiver];
    bytes32 guid = PacketCodec.guidOf(nonce, eid, msg.sender, p.dstEid, p.receiver);
    Packet memory packet = Packet({ nonce: nonce, srcEid: eid, sender: msg.sender, dstEid: p.dstEid, receiver: p.receiver, guid: guid, message: p.message });
    address lib = sendLib[msg.sender][p.dstEid];
    (MessagingFee memory fee, ) = ISendLib(lib).send(packet, p.options, p.payInLzToken);
    rcpt = MessagingReceipt({ guid: guid, nonce: nonce, fee: fee });
}
```

- [ ] **Step 2: `SendLib.send`** — encode + emit `PacketSent`, return zero fee (OQ1: operator-funded → nativeFee 0 for now).

```solidity
function send(Packet calldata packet, bytes calldata options, bool) external returns (MessagingFee memory fee, bytes memory encoded) {
    encoded = PacketCodec.encode(packet);
    emit PacketSent(encoded, options, address(this));
    fee = MessagingFee({ nativeFee: 0, lzTokenFee: 0 });
}
```

- [ ] **Step 3: Implement `setSendLibrary` + `quote`.** `setSendLibrary` writes `sendLib[oapp][eid]`; `quote` returns zero fee.
- [ ] **Step 4: Build + run lifecycle suite send portion.** `pnpm build:contracts && pnpm test:integration` — `PacketSent` now emits; commit/execute still red.
- [ ] **Step 5: Commit.** `git commit -am "feat(contracts): Endpoint.send + SendLib emit PacketSent"`

### Task 14: Implement `ReceiveLib` (M-of-N verify + commit)

**Files:** Modify `ReceiveLib.sol`.

- [ ] **Step 1: Config storage + `setConfig`/`getUlnConfig`** (decode `UlnConfig` from `SetConfigParam.config`, configType 2), per (oapp, srcEid).
- [ ] **Step 2: `verify`** — record `lookup[keccak256(header)][payloadHash][msg.sender] = confirmations`; revert `NOT_A_VERIFIER` if `msg.sender` not in required∪optional set.
- [ ] **Step 3: `commitVerification`** — recompute origin from header via `PacketCodec.decodeHeader`, load `UlnConfig`, enforce: all `required` present AND ≥ `optionalThreshold` of `optional` present at ≥ `confirmations`; revert `THRESHOLD_NOT_MET` otherwise. On success call `endpoint.verify(origin, receiver, payloadHash)`. Guard against double-commit (track committed flag).

```solidity
function commitVerification(bytes calldata header, bytes32 payloadHash) external {
    (Origin memory o, bytes32 receiver32, uint32 dstEid) = PacketCodec.decodeHeader(header);
    require(dstEid == endpoint.eid(), "WRONG_DST");
    address receiver = address(uint160(uint256(receiver32)));
    UlnConfig memory c = _uln[receiver][o.srcEid];
    require(_thresholdMet(keccak256(header), payloadHash, c), "THRESHOLD_NOT_MET");
    endpoint.verify(o, receiver, payloadHash);
    emit PacketVerified(o, receiver, payloadHash);
}
```

- [ ] **Step 4: Build + run threshold suite.** Threshold suite should now pass; lifecycle still needs `Endpoint.verify`/`lzReceive`.
- [ ] **Step 5: Commit.** `git commit -am "feat(contracts): ReceiveLib M-of-N verify + commitVerification"`

### Task 15: Implement `Endpoint.verify` + `lzReceive` + escape hatches

**Files:** Modify `Endpoint.sol`.

- [ ] **Step 1: Channel state + `verify` (ordered, gap-free commit)**

```solidity
mapping(address => mapping(uint32 => mapping(bytes32 => uint64))) public _lazyInboundNonce;
mapping(address => mapping(uint32 => mapping(bytes32 => mapping(uint64 => bytes32)))) public _inboundPayloadHash;
mapping(address => mapping(uint32 => address)) public receiveLib;
bytes32 constant EMPTY = bytes32(0);
error InvalidNonce(); error OnlyReceiveLib(); error PayloadHashMismatch(); error NotExecutable();

function verify(Origin calldata o, address receiver, bytes32 payloadHash) external {
    if (msg.sender != receiveLib[receiver][o.srcEid]) revert OnlyReceiveLib();
    uint64 lazy = _lazyInboundNonce[receiver][o.srcEid][o.sender];
    if (o.nonce != lazy + 1) revert InvalidNonce();          // gap-free, ordered commit
    _lazyInboundNonce[receiver][o.srcEid][o.sender] = o.nonce;
    _inboundPayloadHash[receiver][o.srcEid][o.sender][o.nonce] = payloadHash;
    emit PacketVerified(o, receiver, payloadHash);
}
function inboundNonce(address r, uint32 s, bytes32 se) external view returns (uint64) { return _lazyInboundNonce[r][s][se]; }
function inboundPayloadHash(address r, uint32 s, bytes32 se, uint64 n) external view returns (bytes32) { return _inboundPayloadHash[r][s][se][n]; }
```

- [ ] **Step 2: `lzReceive` (check hash → clear → ordered exec → dispatch → park on revert)**

```solidity
uint64 internal constant _ORDERED = 1; // default channel mode
mapping(address => mapping(uint32 => mapping(bytes32 => uint64))) public _executedNonce;

function lzReceive(Origin calldata o, address receiver, bytes32 guid, bytes calldata message, bytes calldata extraData) external payable {
    bytes32 committed = _inboundPayloadHash[receiver][o.srcEid][o.sender][o.nonce];
    if (committed == EMPTY) revert NotExecutable();
    if (PacketCodec.payloadHash(guid, message) != committed) revert PayloadHashMismatch();
    // ordered execution: previous nonce must already be executed
    if (o.nonce != _executedNonce[receiver][o.srcEid][o.sender] + 1) revert InvalidNonce();
    _inboundPayloadHash[receiver][o.srcEid][o.sender][o.nonce] = EMPTY; // clear before call (reentrancy-safe)
    _executedNonce[receiver][o.srcEid][o.sender] = o.nonce;
    // dispatch; revert here reverts the whole tx → state restored → message stays committed (parked)
    ILayerZeroReceiver(receiver).lzReceive(o, guid, message, msg.sender, extraData);
    emit PacketDelivered(o, receiver);
}
```

> Note: because the clear+dispatch is atomic, a receiver revert rolls back the clear, leaving the hash committed and `_executedNonce` unchanged — exactly the parked-retry semantics. Replay after success fails on `committed == EMPTY`.

- [ ] **Step 3: `setReceiveLibrary` + `setConfig` passthrough** — store `receiveLib[oapp][eid]`; `setConfig` forwards to `IReceiveLib(lib).setConfig(oapp, params)`.
- [ ] **Step 4: Escape hatches** — `skip` advances `_lazyInboundNonce`/`_executedNonce` past `nonce` (owner-gated via OApp delegate check); `nilify` sets payload hash to a sentinel non-executable value; `burn` sets it to EMPTY after asserting it was committed. Gate by `msg.sender == oapp || msg.sender == delegate[oapp]`.
- [ ] **Step 5: Build + run full suite.**

Run: `pnpm build:contracts && pnpm test:integration`
Expected: **all integration suites GREEN** (lifecycle, retry, threshold, ordering, replay, peerauth, escape).

- [ ] **Step 6: Commit.** `git commit -am "feat(contracts): Endpoint verify + lzReceive + escape hatches; integration suite green"`

### Task 16: Gas report + freeze interface

- [ ] **Step 1:** `cd contracts && forge build --sizes` — confirm Endpoint within size limit.
- [ ] **Step 2:** Re-run `pnpm test:integration` once more; confirm 0 failures.
- [ ] **Step 3: Commit.** `git commit -am "chore(contracts): size check; protocol-core complete"`

---

## Self-Review (completed during authoring)

- **Spec coverage:** §4 codec → Task 11 + `packet.ts`; §5.1 Endpoint → Tasks 13/15; §5.2 SendLib → Task 13; §5.3 ReceiveLib → Task 14; §5.4 verifier on-chain config → Task 14; §5.6 OApp → Task 12; §6 lifecycle → lifecycle.test; §7 ordered-commit/park-retry → ordering.test + retry.test + Task 15; §9 integration suite → Phase 2. Verifier *worker* (§5.4 off-chain) and executor *worker* (§5.5) are out of scope here → Plan 2 / subsystem 3.
- **Type consistency:** `Origin`, `Packet`, `UlnConfig`, `MessagingParams` identical across interfaces and tests; `payloadHash = keccak256(guid‖message)` identical in `PacketCodec.sol` and `packet.ts`; ULN `configType = 2` used in `app.ts` and Task 14.
- **Placeholders:** none — every test step has code or an explicit per-case enumeration; mock `sendMessage` flagged in Task 4 note and added in Task 12.
- **Open items deferred (not gaps):** OQ1 fee model — SendLib returns zero fee (operator-funded); revisit if sender-prepay chosen. OQ3 ordered/unordered per-channel — implemented ordered-only; add a config flag when an unordered channel is needed.
