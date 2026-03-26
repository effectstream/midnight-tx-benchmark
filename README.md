# midnight-tx-batcher

TPS benchmarking CLI for the Midnight network. Measures transaction throughput under six scenarios: single-wallet reference baselines (4e, 4f), sequential transfers, parallel transfers, delegated proving (1-TX), and delegated proving with speculative chaining (2-TX).

## Prerequisites

- Deno 2.x+
- Reference projects symlinked in this directory:
  - `midnight-tps/` — wallet CLI and compiled contract artifacts
  - `midnight-node/`, `midnight-indexer/`, `midnight-proof-server/` — local network binaries

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MIDNIGHT_NETWORK_ID` | Yes | — | Network to use: `undeployed`, `preprod`, or `mainnet` |
| `MIDNIGHT_STORAGE_PASSWORD` | For infra (deploy) and 4c/4d/4f | `MyP@ssw0rd!20260` | LevelDB encryption password (must be 16+ chars) |

## Install

```bash
deno install --allow-scripts
```

## Usage

All commands require `MIDNIGHT_NETWORK_ID` (undeployed, preprod, or mainnet):

```bash
export MIDNIGHT_NETWORK_ID=undeployed
export MIDNIGHT_STORAGE_PASSWORD=MyP@ssw0rd
```

### Step 1: Start Infrastructure

Use the reference CLI to start a local network:

```bash
deno run -A midnight-tps/cli.ts network start
deno run -A midnight-tps/cli.ts network status
```

### Step 2: Create and Fund Wallets

Each sub-step is a separate command. Run `bench balance` after each to verify.

```bash
# Create w1-w10 (funded) + xw1-xw10 (empty, Party A)
deno task cli bench create-wallets

# Genesis sends 100,000 Nights to w1
deno task cli bench fund-from-genesis

# w1 distributes 10,000 Nights to w2-w10
deno task cli bench fund-from-w1

# Genesis sends another 10,000 Nights to each w1-w10
# Result: each wallet has ~20,000 Nights + 2 UTXOs
deno task cli bench fund-round2

# Register all w1-w10 for dust generation (self-delegation)
deno task cli bench delegate

# Verify everything
deno task cli bench balance
```

### Step 3: Run Benchmarks

Run the reference baselines first, then each multi-wallet scenario. Verify results before proceeding.

```bash
# 4e: Single — 1 wallet sends 1 self-transfer TX (reference baseline)
deno task cli bench run-4e

# 4f: Single delegated — 1 xw creates circuit TX, 1 w balances + submits (reference baseline)
deno task cli bench run-4f

# 4a: Parallel — 10 wallets each send 1 TX concurrently
deno task cli bench run-4a

# 4b: Prove+Submit — 10 wallets prove 2 TXs each, then submit all in parallel
deno task cli bench run-4b

# 4c: Delegated 1-TX — xw1-xw10 create circuit TXs, w1-w10 balance and submit
deno task cli bench run-4c

# 4d: Delegated 2-TX — same as 4c but 2 TXs per pair with speculative chaining
deno task cli bench run-4d

# 4g: Contract calls — 10 wallets each call add_entry sequentially
MIDNIGHT_STORAGE_PASSWORD='MyP@ssw0rd!20260' deno task cli bench run-4g
```

### Step 5: Compare Results

```bash
deno task cli bench report
```

Prints a comparison table:

```
  Scenario            TXs  Success   Time(s)      TPS    TPS/W
  ------------------ ----- -------- --------- -------- --------
  4e single              1        1      18.2    0.055    0.055
  4f single-deleg        1        1      22.4    0.045    0.045
  4a sequential         10       10     205.3    0.049    0.005
  4b parallel           20       18      42.1    0.428    0.043
  4c delegated-1        10       10      38.7    0.258    0.026
  4d delegated-2        20       16      45.2    0.354    0.035
```

## Benchmark Scenarios

| Scenario | Description | TX Count | Mode |
|----------|-------------|----------|------|
| **4e** | 1 wallet sends 1 self-transfer TX (reference baseline) | 1 | Single |
| **4f** | 1 xw creates circuit TX, 1 w balances + proves + submits (reference baseline) | 1 | Single Delegated |
| **4a** | 10 wallets each send 1 TX concurrently | 10 | Parallel |
| **4b** | 10 wallets prove 2 TXs each, then submit all in parallel | 20 | Prove + Submit |
| **4c** | xw (Party A) creates circuit TX, w (Party B) balances + proves + submits | 10 | Delegated |
| **4d** | Same as 4c but 2 TXs per pair using speculative chaining (batch balance) | 20 | Delegated + Batch |
| **4g** | 10 wallets each call add_entry on the contract sequentially | 10 | Contract Call |

## Project Structure

```
src/
  cli.ts                 Entry point (Deno CLI)
  config.ts              Network configuration
  wallet-store.ts        wallets.json CRUD
  wallet-ops.ts          Wallet build/sync/dust operations
  tx-utils.ts            Transfer utilities
  delegated.ts           Party A/B flow + speculative chaining
  benchmark.ts           Timing, stats, result output
  errors.ts              Error classification
  contract-store.ts      contracts.json registry
  commands/
    bench.ts             All bench subcommand implementations
```

## Output

Benchmark results are saved as JSON files in `benchmarks/`:

```
benchmarks/
  4a-sequential-2026-03-25T23-10-00-000Z.json
  4b-parallel-2026-03-25T23-15-00-000Z.json
  ...
```

Each file contains per-transaction timing breakdowns (create, prove, submit, confirm), TPS metrics, and error categorization.

## Reference Projects

| Symlink | Source | Purpose |
|---------|--------|---------|
| `midnight-tps/` | `../midnight-tps` | Reference CLI, contract artifacts, wallet scripts |
| `midnight-ref-ai/` | `../midnight-ref-ai` | Full SDK source (node, ledger, indexer, JS libraries) |
| `midnight-node/` | paima-engine-8 | Midnight node binary |
| `midnight-indexer/` | paima-engine-8 | Chain/wallet indexer binary |
| `midnight-proof-server/` | paima-engine-8 | Zero-knowledge proof server |
# midnight-tx-benchmark
