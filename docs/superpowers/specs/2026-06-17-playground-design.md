# Interactive Smoke-Test Playground — Design Spec

**Date:** 2026-06-17
**Status:** Approved
**Goal:** A visible, browser-based playground to manually smoke-test the full bridge end-to-end over 3 local anvil chains + the real DVN + Executor, accessible remotely via a Cloudflare tunnel.

## Requirements (from user)
- 3 end-user test wallets, all usable by the tester **without MetaMask** (sign with embedded private keys — local test wallets only). Funded on all 3 chains.
- A payload editor / playground: pick a wallet, configurable **src chain → dst chain**, edit a payload, send (commit + transfer) through the real protocol.
- A payload **receiver view per wallet per chain**.
- One command brings up the **whole system** (chains + DVN + Executor + app) for e2e smoke testing.
- **Cloudflare tunnel** so it's reachable from the internet while the tester is away.

## Topology
- 3 anvil chains: **A (eid 1), B (eid 2), C (eid 3)** on ports 8800/8802/8804.
- Protocol stack per chain (reused contracts): Endpoint + SendLib + ReceiveLib + ExecutorConfig + PriceFeed.
- Wallets **W1/W2/W3 = anvil accounts 6/7/8** (pre-funded 10000 ETH on every anvil → "funded on all chains" automatically). System accounts: 0/4/5 = executor signers, 1/2/3 = attestors.
- **`UserApp` OApp** per wallet per chain = **9 instances**. `sendMessage(uint32 dstEid, bytes payload)`; emits `Received(uint32 srcEid, uint64 nonce, bytes32 sender, bytes message)` on `_lzReceive`.
- **Full mesh**: for each wallet, its app on each chain has peers + send lib + (on dst) receive lib + ULN M-of-N (2-of-3) for every other chain. 6 directed pathways.
- **Workers**: 2 attestors (accounts 1,2) + 1 Executor (signer pool 0,4,5), both with `PATHWAYS_JSON` covering all 6 pathways.

## Components

### `contracts/src/mocks/UserApp.sol`
OApp: `sendMessage(dstEid, payload)` → `_lzSend`; `_lzReceive` emits `Received(srcEid, nonce, sender, message)`. Owner = deployer (orchestrator sets peers).

### `playground/orchestrate.ts` (Node, tsx) — the `pnpm playground` command
Reuses `tests/src/harness` (anvil, clients, deployStack, ABI, ulnConfigBytes). Steps:
1. Start 3 persistent anvil chains (8800/8802/8804).
2. Deploy the stack on each; deploy 9 UserApps (3 wallets × 3 chains).
3. Wire the mesh: per wallet, per ordered chain pair (X→Y): `setPeer` both ways, `setSendLibrary` on X, `setReceiveLibrary` + ULN `setConfig` (2-of-3 attestors) on Y.
4. Write `playground/public/deployment.json` (chains, wallets incl. keys, userApps map).
5. Build + spawn 2 attestor processes + 1 executor (`PATHWAYS_JSON` = 6 pathways).
6. `vite` dev server (port 5173).
7. Spawn `cloudflared tunnel --url http://localhost:5173`; parse + print the public URL.
8. Ctrl+C → tear down anvil + workers + tunnel.

### `playground/` Vite + React + viem app
- **Same-origin RPC**: `vite.config.ts` proxies `/rpc/a|b|c` → anvil 8800/8802/8804, so a single tunnel exposes UI + RPC. The app builds RPC URLs from `window.location.origin + /rpc/{a,b,c}`.
- **Config load**: fetch `/deployment.json` at startup.
- **Sender panel**: wallet selector (W1/W2/W3), src-chain + dst-chain dropdowns, payload editor (utf8/hex toggle), Send → `UserApp@src.sendMessage(dstEid, payloadBytes)` signed by the wallet's embedded key. Shows tx hash + computed guid.
- **Live pipeline**: for the in-flight message, poll on-chain state and show `Sent → Verified (M-of-N) → Committed → Delivered`.
- **Receiver grid (3×3)**: wallet × chain panels, each polling `Received` logs from that wallet's UserApp on that chain; shows src eid, nonce, decoded payload, timestamp.
- **Banner**: "Local test wallets on anvil — exposed via public tunnel. No real funds."

## Data flow
pick wallet+src+dst+payload → `UserApp@src.sendMessage` emits `PacketSent` → attestors verify on dst → executor commits + `lzReceive` → `Received` on `UserApp@dst` → appears in that wallet/chain receiver panel + pipeline reaches Delivered.

## Tunnel + RPC reachability
Remote browsers can't reach `localhost` anvil. Solved by the **Vite proxy**: the browser talks only to the tunnel origin; the Vite dev server (on the dev machine) proxies `/rpc/*` to local anvil. One `cloudflared` quick tunnel suffices.

## Out of scope
- Persistence across restarts (fresh chains each run).
- Auth on the tunnel (test-only; documented warning).
- P5/P6 (on hold).

## Verification
- `pnpm playground` brings everything up; `cloudflared` prints a public URL.
- In the app: send W1 A→B with a payload → pipeline reaches Delivered → the W1/B receiver panel shows the payload. Repeat across wallets/chains, incl. a round A→C and B→A.
