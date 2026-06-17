# P5 — Cross-Asset Bridge App (OApp) Implementation Plan (Roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. **Roadmap-level plan** — re-run `superpowers:brainstorming` when P5 starts to lock the pricing/liquidity design (it has open decisions), then expand these milestones into bite-sized tasks.

**Goal:** Build the cross-asset native-token bridge as an application (OApp) riding on the protocol — the original ask: send the source chain's native token, receive the destination chain's native token.

**Architecture:** A lock/release **liquidity** app (native tokens can't be minted): lock native on source, release native from a destination reserve. Cross-asset (e.g. ETH↔BNB) requires a **price source + slippage**, so this is closer to a cross-chain swap than a 1:1 bridge. Built as two OApp contracts (one per chain) using the protocol's `_lzSend`/`_lzReceive`, plus per-chain liquidity reserves.

**Tech Stack:** Solidity/Foundry (OApp + reserves), Go (price/rebalance keeper, optional), TS+Vitest+viem (integration/e2e). Branch each milestone fresh from `main`.

**Prerequisite:** P4 (Executor) merged — delivery must be autonomous for an asset app to be usable.

---

## Open design decisions (resolve in brainstorming at P5 start)
- **Price source:** off-chain oracle pushed on-chain vs. on-chain feed vs. fixed admin rate. Cross-asset value (ETH↔BNB) needs one; affects trust + slippage.
- **Liquidity model:** operator-funded reserves vs. LP deposits + fees; rebalancing across chains.
- **Failure on insufficient reserve:** queue/refund/partial — what happens when the destination reserve can't cover the release.
- **Fee/slippage:** min-out, max-slippage, who sets the spread.

## Milestones & CA gates

| # | Milestone | CA gate |
|---|-----------|---------|
| **P5.M0** | Acceptance e2e suite (RED): "lock N native on src → recipient receives priced amount of dst native, within slippage; exactly once" | suite runs, RED for missing-app reasons |
| **P5.M1** | `LiquidityReserve` contract (deposit/withdraw/release, accounting; release only by the app) | forge unit + integration green |
| **P5.M2** | `CrossAssetOApp` contracts (src: lock + `_lzSend(amount, recipient, minOut)`; dst: `_lzReceive` → price → release from reserve) | forge unit green; protocol integration (send→deliver→release) green |
| **P5.M3** | Price source + slippage enforcement (chosen model); reject below `minOut` | integration green; below-slippage reverts/refunds |
| **P5.M4** | Sad paths: insufficient reserve, below-slippage, reverting release, replay → exactly-once | sad-path e2e green |
| **P5.M5** | Acceptance e2e GREEN end-to-end (real DVN + Executor + app); CI | e2e + stress green in CI |

## Notes
- Reuses the protocol (Endpoint/libs), the DVN (P3), and the Executor (P4) unchanged — the asset bridge is *just an OApp* plus reserves. No protocol changes expected.
- Security: the destination app must treat the message as authoritative only after protocol delivery (peer-authenticated `_lzReceive`); never release on unverified input.
- This plan is intentionally milestone-level; expand to bite-sized TDD tasks after the P5 brainstorming resolves the open decisions above.
