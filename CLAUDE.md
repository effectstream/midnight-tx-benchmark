# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

TPS benchmarking CLI for the Midnight blockchain network. Measures transaction throughput across six scenarios: sequential transfers, parallel transfers, delegated proving (1-TX and 2-TX), and simplified single-wallet variants (4e, 4f).

## Commands

```bash
# Install dependencies
deno install --allow-scripts

# Type-check
deno check src/cli.ts

# Run any CLI command
deno run -A --unstable-detect-cjs src/cli.ts bench <subcommand>

# Or via deno task
deno task cli bench <subcommand>

# Run a development script
deno run -A --unstable-detect-cjs scripts/<script-name>.ts
```

Required environment variables before running:
```bash
export MIDNIGHT_NETWORK_ID=undeployed   # undeployed | preprod | mainnet
export MIDNIGHT_STORAGE_PASSWORD='MyP@ssw0rd!20260'  # needed for deploy, 4c, 4d, 4f (16+ chars)
```

There is no automated test suite. Testing is done via CLI commands and scripts in `scripts/`.

## Architecture

**Entry point**: `src/cli.ts` — simple switch-based CLI with a single `bench` command group.

**All benchmark logic lives in `src/commands/bench.ts`** — this is the largest file and contains implementations for all subcommands (create-wallets, fund-from-genesis, fund-from-w1, fund-round2, delegate, balance, deploy, run-4a through run-4f, report).

**Core modules** (all in `src/`):
- `wallet-ops.ts` — Wallet facade building, sync, dust management. Key function: `buildWallet(seed)` returns a wallet facade connected to the network. `withWallet<T>()` provides resource cleanup.
- `wallet-store.ts` — JSON-backed CRUD for `wallets.json` (name, mnemonic, seed).
- `tx-utils.ts` — Transaction creation and unshielded transfer utilities.
- `delegated.ts` — Delegated proving: Party A creates unbound circuit TXs (via interception providers), Party B balances/proves/submits. `balanceAndSubmitBatch()` implements speculative chaining for scenario 4d.
- `benchmark.ts` — Timing (`timedOp<T>()`), statistics (`calculateStats()`), result output (`saveBenchResult()`), and TX confirmation polling via indexer GraphQL.
- `config.ts` — Network config resolution via `@paimaexample/midnight-contracts`. Must call `initNetwork()` once per command.
- `errors.ts` — Error classification (mempool_full, no_dust, timeout, etc.).
- `contract-store.ts` — JSON registry for deployed contract addresses (`contracts.json`).

**Data flow for delegated scenarios (4c/4d)**:
1. Party A (xw wallets) — builds wallet with mocked/interception providers, calls contract circuit, captures `UnboundTransaction`
2. Party B (w wallets) — receives unbound TX, balances it against their funds, generates ZK proof, submits to node

**State files**: `wallets.json` (wallet seeds), `contracts.json` (deployed addresses), `benchmarks/*.json` (results with per-TX timing breakdowns).

## Key Patterns

- **Deno runtime** with `nodeModulesDir: "auto"` for npm package compatibility
- **Import map** in `deno.json` maps `@midnight-ntwrk/*` to `npm:` and `@paimaexample/*` to `jsr:` specifiers
- **RxJS observables** for wallet state — filtering and timeout operators used in `syncWallet()`
- **No build step** — Deno runs TypeScript directly; `deno check` is for type checking only
- **Midnight SDK versions are pinned** — `@midnight-ntwrk/*` packages at specific versions (v3-v8 range)
- **1-hour TTL** on all transactions (`TTL_DURATION_MS` in `config.ts`)
- **Wallets must have dust** (gas) before they can balance/prove — handled by `bench delegate` (self-delegation)

## Benchmark Workflow Order

Commands must run in sequence:
1. `create-wallets` — creates w1-w10 + xw1-xw10
2. `fund-from-genesis` — genesis sends 100K to w1
3. `fund-from-w1` — w1 distributes to w2-w10
4. `fund-round2` — genesis tops up each w1-w10
5. `delegate` — self-delegate w1-w10 for dust
6. `deploy` — deploy round-value contract (needed for 4c/4d/4f)
7. `run-4a` through `run-4f` — individual benchmark scenarios
8. `report` — aggregate comparison table
