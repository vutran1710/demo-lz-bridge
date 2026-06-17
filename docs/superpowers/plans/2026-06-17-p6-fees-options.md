# P6 — Fee Market + Execution-Options Codec Implementation Plan (Roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. **Roadmap-level plan** — re-run `superpowers:brainstorming` at P6 start to confirm the fee model and options encoding, then expand to bite-sized tasks.

**Goal:** Turn on real economics and per-message execution control: charge DVN + Executor fees at send time (OQ1), and support per-message `lzReceive`/`nativeDrop` options instead of a fixed per-channel gas budget.

**Architecture:** Wire `SendLib.quote`/`send` to compute fees from the `PriceFeed` + worker fee libs (DVN fee + Executor fee), collected in native at `Endpoint.send`. Add an `OAppOptionsType3`-style **options codec** so apps pass `lzReceiveOption(gas,value)`, `lzComposeOption`, `lzNativeDropOption` per message; the Executor reads them to set gas/value and perform native drops.

**Tech Stack:** Solidity/Foundry, Go (executor reads options), TS+Vitest+viem. Branch each milestone fresh from `main`.

**Prerequisite:** P4 (Executor + ExecutorConfig + PriceFeed seam) merged.

---

## Open design decisions (resolve in brainstorming at P6 start)
- **Fee collection:** prepaid native at `send` (LZ-style) vs. operator-subsidized with accounting. For a private net, do we even charge, or just meter for cost visibility?
- **Options encoding:** adopt the LZ `OptionsBuilder`/Type-3 byte format verbatim (interop) vs. a simpler in-house TLV.
- **Native drop / `msg.value`:** needed only if an app must receive gas/value on delivery — confirm a use case before building.

## Milestones & CA gates

| # | Milestone | CA gate |
|---|-----------|---------|
| **P6.M0** | Options codec contract + `forge` unit tests (encode/decode `lzReceive`/`nativeDrop`) | forge unit green |
| **P6.M1** | `SendLib.quote/send` compute + collect fees from PriceFeed (DVN + Executor) | integration: `quote` returns nonzero; `send` reverts on underpayment; green |
| **P6.M2** | Executor reads per-message options → gas/value + native drop on `lzReceive` | e2e: option-specified gas honored; native drop received; green |
| **P6.M3** | `enforcedOptions` floor on the OApp (min gas) + per-tx override | integration: floor enforced; green |
| **P6.M4** | Sad paths: underpayment, oversized message (maxMessageSize), bad options bytes | sad-path e2e green; CI |

## Notes
- The P4 `PriceFeed` + `ExecutorConfig` seams exist precisely so this is additive, not a redesign.
- If the private network never needs real fees or per-message gas, P6 can be skipped — it's optional. Document that decision rather than building speculatively (YAGNI).
- Keep interop in mind: matching the LZ Type-3 options format buys compatibility with LZ tooling/builders at some extra complexity; an in-house format is simpler but bespoke.
