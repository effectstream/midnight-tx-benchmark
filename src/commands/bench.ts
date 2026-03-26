/**
 * Bench commands — step-by-step TPS benchmark CLI.
 *
 * Commands:
 *   create-wallets, fund-from-genesis, fund-from-w1, fund-round2,
 *   delegate, balance, deploy, run-4a, run-4b, run-4c, run-4d, report
 */

import { Buffer } from "node:buffer";
import { initNetwork, getNetworkConfig, getNetworkId, TTL_DURATION_MS } from "../config.ts";
import { addWallet, findWallet, loadWallets } from "../wallet-store.ts";
import {
  buildWallet,
  syncWallet,
  ensureDust,
  type WalletResult,
} from "../wallet-ops.ts";
import {
  transferUnshielded,
  resolveUnshieldedTokenId,
  proveUnshielded,
  submitFinalized,
  type TransferTimings,
  type ProvedTransfer,
} from "../tx-utils.ts";
import {
  type TxTiming,
  type BenchmarkResult,
  timedOp,
  calculateStats,
  formatResults,
  saveBenchResult,
  waitForTxConfirmation,
} from "../benchmark.ts";
import { classifyError } from "../errors.ts";
import { getContractAddress, saveContract } from "../contract-store.ts";
import { balanceAndSubmit, balanceAndSubmitBatch, type DelegatedTxEntry, type DelegatedTimings, type BatchTxResult } from "../delegated.ts";
import { generateMnemonic, mnemonicToSeed } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english";
import * as Rx from "rxjs";

// ── Constants ────────────────────────────────────────────────────────────────

const FUNDED_WALLETS = Array.from({ length: 10 }, (_, i) => `w${i + 1}`);
const EMPTY_WALLETS = Array.from({ length: 10 }, (_, i) => `xw${i + 1}`);
const ALL_BENCH_WALLETS = [...FUNDED_WALLETS, ...EMPTY_WALLETS];

// Path to contract artifacts (local copy)
const MANAGED_DIR = new URL("../../contract-round-value/src/managed", import.meta.url).pathname;
const CONTRACT_SOURCE = new URL("../../contract-round-value/src/index.original.ts", import.meta.url).pathname;

const BENCHMARKS_DIR = new URL("../../benchmarks", import.meta.url).pathname;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createWalletIfMissing(name: string): Promise<boolean> {
  if (findWallet(name)) return false;
  const mnemonic = generateMnemonic(english, 256);
  const seedBytes = await mnemonicToSeed(mnemonic);
  const seed = Buffer.from(seedBytes).toString("hex");
  addWallet({ name, mnemonic, seed, createdAt: new Date().toISOString() });
  return true;
}

async function getWalletState(walletResult: WalletResult): Promise<any> {
  return Rx.firstValueFrom(
    walletResult.wallet.state().pipe(
      Rx.filter((s: any) => s.isSynced),
      Rx.timeout({ each: 60_000, with: () => Rx.throwError(() => new Error("sync timeout")) }),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench create-wallets
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchCreateWallets(): Promise<void> {
  console.log("\n=== Creating bench wallets ===\n");

  for (const name of ALL_BENCH_WALLETS) {
    const created = await createWalletIfMissing(name);
    console.log(`  ${name}: ${created ? "created" : "exists"}`);
  }

  if (!findWallet("genesis")) {
    console.error("\nGenesis wallet not found. Import it first.");
    console.error("  Add genesis to wallets.json with seed: 0000000000000000000000000000000000000000000000000000000000000001");
    Deno.exit(1);
  }

  console.log(`\nDone. ${ALL_BENCH_WALLETS.length} wallets ready.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench fund-from-genesis — Genesis sends 100,000 to w1
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchFundFromGenesis(amount?: bigint): Promise<void> {
  initNetwork();
  const sendAmount = amount ?? 100_000_000_000_000n;

  const genesis = findWallet("genesis");
  if (!genesis) { console.error("Genesis wallet not found."); Deno.exit(1); }
  const w1 = findWallet("w1");
  if (!w1) { console.error("w1 not found. Run: bench create-wallets"); Deno.exit(1); }

  console.log(`\n=== Funding w1 from genesis (${sendAmount} base units) ===\n`);

  const genesisResult = await buildWallet(genesis.seed);
  console.log("Syncing genesis...");
  await syncWallet(genesisResult, { waitNonZero: false, logLabel: "genesis" });
  const tokenId = await resolveUnshieldedTokenId(genesisResult);

  const w1Result = await buildWallet(w1.seed);
  const w1Addr = w1Result.unshieldedAddress;
  await w1Result.wallet.stop().catch(() => {});

  console.log(`Sending ${sendAmount} to w1 (${w1Addr})...`);
  const { txId } = await transferUnshielded(genesisResult, w1Addr, sendAmount, tokenId);
  console.log(`  TX: ${txId}`);

  await genesisResult.wallet.stop().catch(() => {});
  console.log("\nDone. Wait a few seconds, then verify with: bench balance");
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench fund-from-w1 — w1 sends 10,000 to w2..w10
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchFundFromW1(amount?: bigint): Promise<void> {
  initNetwork();
  const sendAmount = amount ?? 10_000_000_000_000n;

  const w1 = findWallet("w1");
  if (!w1) { console.error("w1 not found. Run: bench create-wallets"); Deno.exit(1); }

  console.log(`\n=== w1 distributing ${sendAmount} to w2-w10 ===\n`);

  const w1Result = await buildWallet(w1.seed);
  console.log("Syncing w1...");
  await syncWallet(w1Result, { waitNonZero: false, logLabel: "w1" });

  // Register w1 for dust if needed, then wait for dust
  const state: any = await Rx.firstValueFrom(
    w1Result.wallet.state().pipe(Rx.filter((s: any) => s.isSynced)),
  );
  const allCoins = state.unshielded?.availableCoins ?? [];
  const unreg = allCoins.filter((c: any) => c.meta.registeredForDustGeneration === false);
  if (unreg.length > 0) {
    console.log(`Registering ${unreg.length} UTXO(s) for dust...`);
    const recipe = await (w1Result.wallet as any).registerNightUtxosForDustGeneration(
      unreg,
      w1Result.unshieldedKeystore.getPublicKey(),
      (payload: Uint8Array) => w1Result.unshieldedKeystore.signData(payload),
    );
    const fin = await (w1Result.wallet as any).finalizeRecipe(recipe);
    const txId = await w1Result.wallet.submitTransaction(fin);
    console.log(`  Registered: ${txId}`);
    console.log("Waiting ~2 min for dust generation...");
    await new Promise((r) => setTimeout(r, 120_000));
  }
  console.log("Waiting for dust...");
  await ensureDust(w1Result, true);
  const tokenId = await resolveUnshieldedTokenId(w1Result);

  const targets: { name: string; address: string }[] = [];
  for (let i = 2; i <= 10; i++) {
    const w = findWallet(`w${i}`);
    if (!w) { console.error(`w${i} not found.`); Deno.exit(1); }
    const wr = await buildWallet(w.seed);
    targets.push({ name: `w${i}`, address: wr.unshieldedAddress });
    await wr.wallet.stop().catch(() => {});
  }

  let successCount = 0;
  for (const t of targets) {
    try {
      console.log(`  w1 -> ${t.name}: sending ${sendAmount}...`);
      const { txId } = await transferUnshielded(w1Result, t.address, sendAmount, tokenId);
      console.log(`    TX: ${txId}`);
      successCount++;
      await new Promise((r) => setTimeout(r, 7000));
    } catch (e) {
      console.error(`    ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await w1Result.wallet.stop().catch(() => {});
  console.log(`\nDone. ${successCount}/9 transfers completed.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench fund-round2 — Genesis sends 10,000 to each w1-w10
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchFundRound2(amount?: bigint): Promise<void> {
  initNetwork();
  const sendAmount = amount ?? 10_000_000_000_000n;

  const genesis = findWallet("genesis");
  if (!genesis) { console.error("Genesis wallet not found."); Deno.exit(1); }

  console.log(`\n=== Genesis sending ${sendAmount} to each w1-w10 ===\n`);

  const genesisResult = await buildWallet(genesis.seed);
  console.log("Syncing genesis...");
  await syncWallet(genesisResult, { waitNonZero: false, logLabel: "genesis" });
  const tokenId = await resolveUnshieldedTokenId(genesisResult);

  const targets: { name: string; address: string }[] = [];
  for (const name of FUNDED_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const wr = await buildWallet(w.seed);
    targets.push({ name, address: wr.unshieldedAddress });
    await wr.wallet.stop().catch(() => {});
  }

  let successCount = 0;
  for (const t of targets) {
    try {
      console.log(`  genesis -> ${t.name}: sending ${sendAmount}...`);
      const { txId } = await transferUnshielded(genesisResult, t.address, sendAmount, tokenId);
      console.log(`    TX: ${txId}`);
      successCount++;
      await new Promise((r) => setTimeout(r, 7000));
    } catch (e) {
      console.error(`    ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await genesisResult.wallet.stop().catch(() => {});
  console.log(`\nDone. ${successCount}/10 transfers completed.`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench delegate — Self-delegate all w1-w10 for dust
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchDelegate(): Promise<void> {
  initNetwork();

  console.log("\n=== Registering w1-w10 for dust generation ===\n");

  const tasks = FUNDED_WALLETS.map(async (name) => {
    const w = findWallet(name);
    if (!w) { console.log(`  ${name}: SKIP (not found)`); return; }

    let walletResult: WalletResult | null = null;
    try {
      walletResult = await buildWallet(w.seed);
      await syncWallet(walletResult, { waitNonZero: false, timeoutMs: 60_000 });

      const state: any = await getWalletState(walletResult);
      const allCoins = state.unshielded?.availableCoins ?? [];
      const unregistered = allCoins.filter((c: any) => c.meta.registeredForDustGeneration === false);

      if (unregistered.length === 0) {
        console.log(`  ${name}: already registered (${allCoins.length} UTXOs)`);
        return;
      }

      console.log(`  ${name}: registering ${unregistered.length} UTXO(s)...`);

      const recipe = await (walletResult.wallet as any).registerNightUtxosForDustGeneration(
        unregistered,
        walletResult.unshieldedKeystore.getPublicKey(),
        (payload: Uint8Array) => walletResult!.unshieldedKeystore.signData(payload),
      );
      const finalized = await (walletResult.wallet as any).finalizeRecipe(recipe);
      const txId = await walletResult.wallet.submitTransaction(finalized);
      console.log(`  ${name}: registered (${txId})`);
    } catch (e) {
      console.error(`  ${name}: ERROR - ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (walletResult) await walletResult.wallet.stop().catch(() => {});
    }
  });

  await Promise.all(tasks);
  console.log("\nDone. Dust takes ~2 minutes to generate after registration.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench balance — Show tokens + UTXOs + dust per wallet
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchBalance(): Promise<void> {
  initNetwork();

  console.log("\n=== Bench Wallet Balances ===\n");

  interface WalletInfo {
    name: string;
    nightBalance: bigint;
    nightAvail: number;
    nightPending: number;
    registered: number;
    dustBalance: bigint;
    dustAvail: number;
    dustPending: number;
    dustWithValue: number;
    status: string;
    error?: string;
  }

  const results: WalletInfo[] = [];

  // Process all wallets concurrently (no throttle)
  const tasks = ALL_BENCH_WALLETS.map(async (name): Promise<WalletInfo> => {
    const w = findWallet(name);
    if (!w) {
      return { name, nightBalance: 0n, nightAvail: 0, nightPending: 0, registered: 0, dustBalance: 0n, dustAvail: 0, dustPending: 0, dustWithValue: 0, status: "NOT FOUND" };
    }

    let walletResult: WalletResult | null = null;
    try {
      walletResult = await buildWallet(w.seed);
      await syncWallet(walletResult, { waitNonZero: false, timeoutMs: 60_000 });

      const state: any = await getWalletState(walletResult);

      // Night balance — prefer totalBalances (avail+pending), fall back to balances (avail only)
      const sumBalances = (b: Map<string, bigint> | Record<string, bigint> | undefined) => {
        if (!b) return 0n;
        const vals = b instanceof Map ? Array.from(b.values()) : Object.values(b);
        return (vals as bigint[]).reduce((a, v) => a + (v ?? 0n), 0n);
      };
      const nightBalance = sumBalances(state.unshielded?.totalBalances) || sumBalances(state.unshielded?.balances);

      // Night UTXOs — available vs pending
      const nightAvailCoins = state.unshielded?.availableCoins ?? [];
      const nightPendingCoins = state.unshielded?.pendingCoins ?? [];
      const registered = nightAvailCoins.filter((c: any) => c.meta?.registeredForDustGeneration === true).length;

      // Dust — read from facade state directly (state.dust is DustWalletState)
      let dustBalance = 0n;
      let dustAvail = 0;
      let dustPending = 0;
      let dustWithValue = 0;
      try {
        const dustState: any = state.dust;
        if (dustState) {
          dustAvail = dustState.availableCoins?.length ?? 0;
          dustPending = dustState.pendingCoins?.length ?? 0;
          dustBalance = typeof dustState.balance === "function" ? dustState.balance(new Date()) : 0n;
          if (typeof dustState.availableCoinsWithFullInfo === "function") {
            const fullInfo: any[] = dustState.availableCoinsWithFullInfo(new Date());
            dustWithValue = fullInfo.filter((d: any) => d.generatedNow > 0n).length;
          }
        }
      } catch { /* no dust state */ }

      const isPartyA = EMPTY_WALLETS.includes(name);
      const status = isPartyA ? "OK (Party A)" : "OK";

      return { name, nightBalance, nightAvail: nightAvailCoins.length, nightPending: nightPendingCoins.length, registered, dustBalance, dustAvail, dustPending, dustWithValue, status };
    } catch (e) {
      return { name, nightBalance: 0n, nightAvail: 0, nightPending: 0, registered: 0, dustBalance: 0n, dustAvail: 0, dustPending: 0, dustWithValue: 0, status: "ERROR", error: e instanceof Error ? e.message : String(e) };
    } finally {
      if (walletResult) await walletResult.wallet.stop().catch(() => {});
    }
  });

  const walletInfos = await Promise.all(tasks);
  // Sort by original order
  for (const name of ALL_BENCH_WALLETS) {
    const info = walletInfos.find((i) => i.name === name);
    if (info) results.push(info);
  }

  // Unit conversions: 1 tNIGHT = 10^6 Stars, 1 tDUST = 10^15 Specks
  const STARS_PER_NIGHT = 1_000_000n;
  const SPECKS_PER_DUST = 1_000_000_000_000_000n;

  const fmtNight = (stars: bigint): string => {
    const whole = stars / STARS_PER_NIGHT;
    const frac = stars % STARS_PER_NIGHT;
    if (frac === 0n) return `${whole.toLocaleString()}`;
    return `${whole.toLocaleString()}.${String(frac).padStart(6, "0").replace(/0+$/, "")}`;
  };

  const fmtDust = (specks: bigint): string => {
    const whole = specks / SPECKS_PER_DUST;
    const frac = specks < 0n ? -((-specks) % SPECKS_PER_DUST) : specks % SPECKS_PER_DUST;
    if (frac === 0n) return `${whole.toLocaleString()}`;
    const absFrac = frac < 0n ? -frac : frac;
    return `${whole.toLocaleString()}.${String(absFrac).padStart(15, "0").replace(/0+$/, "").slice(0, 4)}`;
  };

  // Print table
  const hdr = `  ${"Wallet".padEnd(8)} ${"tNIGHT".padStart(16)} ${"Night UTXOs".padStart(12)} ${"Reg".padStart(4)} ${"tDUST".padStart(12)} ${"Dust UTXOs".padStart(11)} Status`;
  const sep = `  ${"-".repeat(8)} ${"-".repeat(16)} ${"-".repeat(12)} ${"-".repeat(4)} ${"-".repeat(12)} ${"-".repeat(11)} ${"-".repeat(16)}`;
  console.log(hdr);
  console.log(sep);

  for (const r of results) {
    const bal = fmtNight(r.nightBalance);
    const nightUtxos = r.nightPending > 0 ? `${r.nightAvail}+${r.nightPending}p` : `${r.nightAvail}`;
    const reg = `${r.registered}`;
    const dust = r.dustBalance > 0n
      ? fmtDust(r.dustBalance)
      : r.dustWithValue > 0 ? `0 (${r.dustWithValue}>0)` : "0";
    const dustUtxos = r.dustPending > 0 ? `${r.dustAvail}+${r.dustPending}p` : `${r.dustAvail}`;
    const errSuffix = r.error ? ` (${r.error.slice(0, 30)})` : "";
    console.log(
      `  ${r.name.padEnd(8)} ${bal.padStart(16)} ${nightUtxos.padStart(12)} ${reg.padStart(4)} ${dust.padStart(12)} ${dustUtxos.padStart(11)} ${r.status}${errSuffix}`,
    );
  }

  // Contract status
  const networkId = String(getNetworkId());
  const contractAddr = getContractAddress("round-value", networkId);
  console.log();
  if (contractAddr) {
    console.log(`  Contract: round-value @ ${contractAddr.slice(0, 16)}... (deployed)`);
  } else {
    console.log(`  Contract: round-value (not deployed on ${networkId})`);
  }
  console.log();
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench deploy — Deploy round-value contract if needed
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchDeploy(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();
  const networkId = String(getNetworkId());
  const existing = getContractAddress("round-value", networkId);

  if (existing) {
    console.log(`\nround-value already deployed on ${networkId}: ${existing}`);
    return;
  }

  console.log(`\nDeploying round-value on ${networkId}...`);

  const { deployMidnightContract } = await import("@paimaexample/midnight-contracts/deploy");
  const mod = await import(CONTRACT_SOURCE);

  const config = {
    contractName: "contract-round-value",
    contractFileName: `contract-round-value.${Deno.env.get("MIDNIGHT_NETWORK_ID")}.json`,
    contractClass: mod.Counter.Contract,
    witnesses: mod.witnesses,
    privateStateId: "counterPrivateState",
    initialPrivateState: { privateCounter: 0 },
    privateStateStoreName: "counter-private-state",
  };

  try {
    const contractAddress = await deployMidnightContract(config as any, networkConfig);
    console.log(`Contract deployed!`);
    console.log(`  Address: ${contractAddress}`);

    saveContract({
      contractName: "round-value",
      networkId,
      contractAddress: String(contractAddress),
      deployedAt: new Date().toISOString(),
    });
    console.log(`  Saved to contracts.json`);
  } catch (e) {
    console.error(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4a — Parallel 1-TX per wallet
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4a(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();

  console.log("\n=== Benchmark 4a: Parallel 1-TX per wallet ===\n");
  console.log(`  Wallets: ${FUNDED_WALLETS.join(", ")}`);
  console.log(`  Mode: 10 wallets concurrent, 1 TX each\n`);

  console.log("Building wallets...");
  const walletData: { name: string; result: WalletResult; tokenId: string }[] = [];
  for (const name of FUNDED_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    await syncWallet(result, { waitNonZero: false, logLabel: name });
    await ensureDust(result);
    const tokenId = await resolveUnshieldedTokenId(result);
    walletData.push({ name, result, tokenId });
    console.log(`  ${name}: ready`);
  }

  console.log("\nRunning benchmark...\n");

  const transactions: TxTiming[] = [];
  const benchStart = performance.now();
  const startedAt = new Date().toISOString();

  const walletTasks = walletData.map((wd, i) => {
    return (async () => {
      const timing: TxTiming = {
        index: i, wallet: wd.name,
        createMs: 0, balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0, totalMs: 0,
      };

      const txStart = performance.now();
      try {
        const transfer = await transferUnshielded(wd.result, wd.result.unshieldedAddress, 1n, wd.tokenId);
        timing.createMs = transfer.createMs;
        timing.proveMs = transfer.proveMs;
        timing.submitMs = transfer.submitMs;
        timing.txHash = transfer.txId;
        timing.totalMs = performance.now() - txStart;
        console.log(`  [${wd.name}] ${transfer.txId} (create=${timing.createMs.toFixed(0)}ms prove=${timing.proveMs.toFixed(0)}ms submit=${timing.submitMs.toFixed(0)}ms)`);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const classified = classifyError(err);
        timing.error = err.message;
        timing.errorCode = classified.code;
        timing.totalMs = performance.now() - txStart;
        console.error(`  [${wd.name}] ERROR ${classified.code} - ${err.message.slice(0, 80)}`);
      }
      return timing;
    })();
  });

  const results4a = await Promise.all(walletTasks);
  transactions.push(...results4a);

  // Wait for confirmations
  const successfulTxs = transactions.filter((t) => t.txHash);
  if (successfulTxs.length > 0) {
    console.log(`\nWaiting for ${successfulTxs.length} confirmations...`);
    for (const tx of successfulTxs) {
      try {
        const confirmStart = performance.now();
        await waitForTxConfirmation(networkConfig.indexer, tx.txHash!, 300_000);
        tx.confirmMs = performance.now() - confirmStart;
      } catch {
        tx.confirmMs = -1;
        console.error(`  Confirmation timeout for ${tx.txHash}`);
      }
    }
  }

  const totalMs = performance.now() - benchStart;
  const result = calculateStats(transactions, FUNDED_WALLETS.length, totalMs, "4a parallel (10w, 1tx each)");
  result.startedAt = startedAt;
  result.completedAt = new Date().toISOString();

  console.log(formatResults(result));
  const fp = saveBenchResult(result, "4a-parallel");
  console.log(`Results saved to: ${fp}`);

  for (const wd of walletData) await wd.result.wallet.stop().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4b — Parallel 2-TX per wallet
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4b(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();

  console.log("\n=== Benchmark 4b: Prove-then-submit 2-TX per wallet ===\n");
  console.log(`  Wallets: ${FUNDED_WALLETS.join(", ")}`);
  console.log(`  Mode: prove 2 TXs per wallet (parallel across wallets), then submit all in parallel\n`);

  console.log("Building wallets...");
  const walletData: { name: string; result: WalletResult; tokenId: string }[] = [];
  for (const name of FUNDED_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    await syncWallet(result, { waitNonZero: false, logLabel: name });
    await ensureDust(result);
    const tokenId = await resolveUnshieldedTokenId(result);
    walletData.push({ name, result, tokenId });
    console.log(`  ${name}: ready`);
  }

  // Phase 1: Prove all TXs (2 per wallet, sequential within wallet, parallel across wallets)
  console.log("\n--- Phase 1: Prove all TXs ---\n");

  interface ProvedEntry {
    walletIdx: number;
    txIdx: number;
    name: string;
    proved: ProvedTransfer;
    timing: TxTiming;
  }

  const transactions: TxTiming[] = [];
  const benchStart = performance.now();
  const startedAt = new Date().toISOString();

  const proveTasks = walletData.map((wd, wIdx) => {
    return (async () => {
      const entries: ProvedEntry[] = [];
      for (let j = 0; j < 2; j++) {
        const timing: TxTiming = {
          index: wIdx * 2 + j, wallet: wd.name,
          createMs: 0, balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0, totalMs: 0,
        };
        try {
          const proved = await proveUnshielded(wd.result, wd.result.unshieldedAddress, 1n, wd.tokenId);
          timing.createMs = proved.createMs;
          timing.proveMs = proved.proveMs;
          entries.push({ walletIdx: wIdx, txIdx: j, name: wd.name, proved, timing });
          console.log(`  [${wd.name}#${j + 1}] proved (create=${proved.createMs.toFixed(0)}ms prove=${proved.proveMs.toFixed(0)}ms)`);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          const classified = classifyError(err);
          timing.error = err.message;
          timing.errorCode = classified.code;
          transactions.push(timing);
          console.error(`  [${wd.name}#${j + 1}] PROVE ERROR ${classified.code} - ${err.message.slice(0, 80)}`);
        }
      }
      return entries;
    })();
  });

  const allProved = (await Promise.all(proveTasks)).flat();
  console.log(`\nPhase 1 done: ${allProved.length}/20 TXs proved`);

  // Phase 2: Submit all (parallel across wallets)
  console.log("\n--- Phase 2: Submit all TXs ---\n");

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5000;

  const submitTasks = allProved.map((entry) => {
    const wd = walletData[entry.walletIdx];
    return (async () => {
      const txStart = performance.now();
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const { txId, submitMs } = await submitFinalized(wd.result, entry.proved.finalized);
          entry.timing.submitMs = submitMs;
          entry.timing.txHash = txId;
          entry.timing.totalMs = entry.timing.createMs + entry.timing.proveMs + submitMs;
          console.log(`  [${entry.name}#${entry.txIdx + 1}] ${txId} (submit=${submitMs.toFixed(0)}ms${attempt > 1 ? ` attempt=${attempt}` : ""})`);
          break;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          const classified = classifyError(err);
          if (attempt < MAX_RETRIES && classified.retryable) {
            console.warn(`  [${entry.name}#${entry.txIdx + 1}] RETRY ${attempt}/${MAX_RETRIES} ${classified.code} - ${err.message.slice(0, 60)}`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            continue;
          }
          entry.timing.error = err.message;
          entry.timing.errorCode = classified.code;
          entry.timing.totalMs = performance.now() - txStart;
          console.error(`  [${entry.name}#${entry.txIdx + 1}] SUBMIT FAILED ${classified.code} - ${err.message.slice(0, 80)}`);
        }
      }
      transactions.push(entry.timing);
    })();
  });

  await Promise.all(submitTasks);

  // Wait for confirmations
  const successfulTxs = transactions.filter((t) => t.txHash);
  if (successfulTxs.length > 0) {
    console.log(`\nWaiting for ${successfulTxs.length} confirmations...`);
    for (const tx of successfulTxs) {
      try {
        const confirmStart = performance.now();
        await waitForTxConfirmation(networkConfig.indexer, tx.txHash!, 300_000);
        tx.confirmMs = performance.now() - confirmStart;
      } catch {
        tx.confirmMs = -1;
        console.error(`  Confirmation timeout for ${tx.txHash}`);
      }
    }
  }

  const totalMs = performance.now() - benchStart;
  const result = calculateStats(transactions, FUNDED_WALLETS.length, totalMs, "4b prove-then-submit (10w, 2tx each)");
  result.startedAt = startedAt;
  result.completedAt = new Date().toISOString();

  console.log(formatResults(result));
  const fp = saveBenchResult(result, "4b-parallel");
  console.log(`Results saved to: ${fp}`);

  for (const wd of walletData) await wd.result.wallet.stop().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4c — Delegated 1-TX (xw creates, w balances)
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4c(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();
  const networkId = String(getNetworkId());
  const password = Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "MyP@ssw0rd!20260";

  const contractAddress = getContractAddress("round-value", networkId)!;
  if (!contractAddress) {
    console.error("round-value not deployed. Run: bench deploy");
    Deno.exit(1);
  }

  console.log("\n=== Benchmark 4c: Delegated 1-TX per XWallet ===\n");
  console.log(`  Party A (create):  ${EMPTY_WALLETS.join(", ")}`);
  console.log(`  Party B (balance): ${FUNDED_WALLETS.join(", ")}`);
  console.log(`  Contract: ${contractAddress}`);
  console.log(`  Mode: 10 delegated TXs (1 per pair)\n`);

  // Import contract dependencies
  const { findDeployedContract } = await import("@midnight-ntwrk/midnight-js-contracts");
  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const { httpClientProofProvider } = await import("@midnight-ntwrk/midnight-js-http-client-proof-provider");
  const { levelPrivateStateProvider } = await import("@midnight-ntwrk/midnight-js-level-private-state-provider");
  const { NodeZkConfigProvider } = await import("@midnight-ntwrk/midnight-js-node-zk-config-provider");
  const mod = await import(CONTRACT_SOURCE);
  type UnboundTransaction = import("@midnight-ntwrk/midnight-js-types").UnboundTransaction;
  type FinalizedTransaction = import("@midnight-ntwrk/ledger-v8").FinalizedTransaction;

  const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

  // Build Party A wallets (xw1-xw10)
  console.log("Building Party A wallets (xw1-xw10)...");
  const partyA: { name: string; result: WalletResult }[] = [];
  for (const name of EMPTY_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    partyA.push({ name, result });
    console.log(`  ${name}: ready`);
  }

  // Build Party B wallets (w1-w10)
  console.log("Building Party B wallets (w1-w10)...");
  const partyB: { name: string; result: WalletResult }[] = [];
  for (const name of FUNDED_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    await syncWallet(result, { waitNonZero: false });
    await ensureDust(result, true);
    partyB.push({ name, result });
    console.log(`  ${name}: ready`);
  }

  // Helper: intercepting providers for Party A
  function makeInterceptProviders(walletResult: WalletResult, label: string) {
    let captured: UnboundTransaction | null = null;
    let resolve: (() => void) | null = null;
    const promise = new Promise<void>((r) => { resolve = r; });

    const providers: any = {
      privateStateProvider: levelPrivateStateProvider({
        midnightDbName: `midnight-level-db-4c-${label}`,
        privateStateStoreName: `4c-ps-${label}`,
        signingKeyStoreName: `4c-sk-${label}`,
        privateStoragePasswordProvider: async () => password,
        accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
      walletProvider: {
        getCoinPublicKey: () => walletResult.zswapSecretKeys.coinPublicKey,
        getEncryptionPublicKey: () => walletResult.zswapSecretKeys.encryptionPublicKey,
        balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
          captured = tx;
          resolve!();
          throw new Error("DELEGATED_TX_CAPTURED");
        },
        submitTx: () => { throw new Error("Party A should not submit"); },
      },
      midnightProvider: {
        getCoinPublicKey: () => walletResult.zswapSecretKeys.coinPublicKey,
        getEncryptionPublicKey: () => walletResult.zswapSecretKeys.encryptionPublicKey,
        balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
          captured = tx;
          resolve!();
          throw new Error("DELEGATED_TX_CAPTURED");
        },
        submitTx: () => { throw new Error("Party A should not submit"); },
      },
    };

    return { providers, getCaptured: () => captured, waitForCapture: promise };
  }

  async function findContractFor(providers: any) {
    const compiled = CompiledContract.make("contract-round-value", mod.Counter.Contract).pipe(
      CompiledContract.withWitnesses(mod.witnesses as never),
      CompiledContract.withCompiledFileAssets(MANAGED_DIR),
    );
    return findDeployedContract(providers, {
      contractAddress,
      compiledContract: compiled as never,
      privateStateId: "counterPrivateState" as never,
      initialPrivateState: { privateCounter: 0 } as never,
    });
  }

  function makeEntryArgs(idx: number): [Uint8Array, bigint] {
    const id = new Uint8Array(32);
    const rand = crypto.getRandomValues(new Uint8Array(8));
    id[0] = idx;
    id.set(rand, 24);
    return [id, BigInt(idx * 1000)];
  }

  // Phase 1: Create UnboundTransactions (parallel)
  console.log("\n--- Phase 1: Party A creating add_entry TXs (parallel) ---\n");

  interface CapturedTx {
    name: string;
    unboundTx: UnboundTransaction;
    createMs: number;
  }

  const phase1Start = performance.now();
  const capturedTxs: CapturedTx[] = [];

  const createTasks = partyA.map((pa, idx) => {
    return (async () => {
      const label = `${pa.name}-0`;
      const { providers, getCaptured, waitForCapture } = makeInterceptProviders(pa.result, label);
      try {
        const start = performance.now();
        const deployed = await findContractFor(providers);
        const [id, value] = makeEntryArgs(idx);

        (deployed.callTx as any).add_entry(id, value).catch((err: Error) => {
          if (!err.message.includes("DELEGATED_TX_CAPTURED")) {
            console.error(`  [${pa.name}] circuit error: ${err.message.slice(0, 80)}`);
          }
        });

        await waitForCapture;
        const createMs = performance.now() - start;
        capturedTxs.push({ name: pa.name, unboundTx: getCaptured()!, createMs });
        console.log(`  [${pa.name}] captured (${createMs.toFixed(0)}ms)`);
      } catch (e) {
        console.error(`  [${pa.name}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  });

  await Promise.all(createTasks);
  const phase1Ms = performance.now() - phase1Start;
  console.log(`\nPhase 1 done: ${capturedTxs.length}/10 TXs captured in ${(phase1Ms / 1000).toFixed(1)}s`);

  // Phase 2: Balance + Submit (parallel)
  console.log("\n--- Phase 2: Party B balance + prove + submit (parallel) ---\n");

  const phase2Start = performance.now();
  const timings: TxTiming[] = [];

  const submitTasks = capturedTxs.map((ctx, idx) => {
    const bw = partyB[idx % partyB.length];
    return (async () => {
      const timing: TxTiming = {
        index: idx,
        wallet: `${ctx.name}->${bw.name}`,
        createMs: ctx.createMs,
        balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0, totalMs: 0,
      };

      try {
        const entry: DelegatedTxEntry = { tx: ctx.unboundTx as never, txStage: "unbound" };
        const dt = await balanceAndSubmit(bw.result, entry);
        timing.balanceMs = dt.balanceMs;
        timing.proveMs = dt.proveMs;
        timing.submitMs = dt.submitMs;
        timing.txHash = dt.txId;
        timing.totalMs = timing.createMs + timing.balanceMs + timing.proveMs + timing.submitMs;
        console.log(`  [${ctx.name}->${bw.name}] ${dt.txId} (balance=${dt.balanceMs.toFixed(0)}ms prove=${dt.proveMs.toFixed(0)}ms submit=${dt.submitMs.toFixed(0)}ms)`);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        timing.error = err.message;
        timing.errorCode = classifyError(err).code;
        timing.totalMs = timing.createMs;
        console.error(`  [${ctx.name}->${bw.name}] ERROR (${timing.errorCode}): ${err.message}`);
      }
      timings.push(timing);
    })();
  });

  await Promise.all(submitTasks);
  const phase2Ms = performance.now() - phase2Start;
  const totalMs4c = phase1Ms + phase2Ms;

  console.log(`\nPhase 2 done in ${(phase2Ms / 1000).toFixed(1)}s`);

  // Wait for confirmations
  const successfulTxs = timings.filter((t) => t.txHash);
  if (successfulTxs.length > 0) {
    console.log(`\nWaiting for ${successfulTxs.length} confirmations...`);
    for (const tx of successfulTxs) {
      try {
        const confirmStart = performance.now();
        await waitForTxConfirmation(networkConfig.indexer, tx.txHash!, 300_000);
        tx.confirmMs = performance.now() - confirmStart;
      } catch {
        tx.confirmMs = -1;
      }
    }
  }

  const result = calculateStats(timings, FUNDED_WALLETS.length, totalMs4c, "4c delegated-1tx (10 xw -> 10 w)");
  result.startedAt = new Date().toISOString();
  result.completedAt = new Date().toISOString();

  console.log(formatResults(result));
  const fp = saveBenchResult(result, "4c-delegated-1tx");
  console.log(`Results saved to: ${fp}`);

  for (const pa of partyA) await pa.result.wallet.stop().catch(() => {});
  for (const pb of partyB) await pb.result.wallet.stop().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4d — Delegated 2-TX with speculative chaining
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4d(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();
  const networkId = String(getNetworkId());
  const password = Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "MyP@ssw0rd!20260";

  const contractAddress = getContractAddress("round-value", networkId)!;
  if (!contractAddress) {
    console.error("round-value not deployed. Run: bench deploy");
    Deno.exit(1);
  }

  console.log("\n=== Benchmark 4d: Delegated 2-TX with speculative chaining ===\n");
  console.log(`  Party A (create):  ${EMPTY_WALLETS.join(", ")}`);
  console.log(`  Party B (balance): ${FUNDED_WALLETS.join(", ")}`);
  console.log(`  Contract: ${contractAddress}`);
  console.log(`  Mode: 20 delegated TXs (2 per pair, speculative chaining)\n`);

  const { findDeployedContract } = await import("@midnight-ntwrk/midnight-js-contracts");
  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const { httpClientProofProvider } = await import("@midnight-ntwrk/midnight-js-http-client-proof-provider");
  const { levelPrivateStateProvider } = await import("@midnight-ntwrk/midnight-js-level-private-state-provider");
  const { NodeZkConfigProvider } = await import("@midnight-ntwrk/midnight-js-node-zk-config-provider");
  const mod = await import(CONTRACT_SOURCE);
  type UnboundTransaction = import("@midnight-ntwrk/midnight-js-types").UnboundTransaction;
  type FinalizedTransaction = import("@midnight-ntwrk/ledger-v8").FinalizedTransaction;

  const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

  // Build Party A wallets
  console.log("Building Party A wallets (xw1-xw10)...");
  const partyA: { name: string; result: WalletResult }[] = [];
  for (const name of EMPTY_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    partyA.push({ name, result });
    console.log(`  ${name}: ready`);
  }

  // Build Party B wallets
  console.log("Building Party B wallets (w1-w10)...");
  const partyB: { name: string; result: WalletResult }[] = [];
  for (const name of FUNDED_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    await syncWallet(result, { waitNonZero: false });
    await ensureDust(result, true);
    partyB.push({ name, result });
    console.log(`  ${name}: ready`);
  }

  function makeInterceptProviders(walletResult: WalletResult, label: string) {
    let captured: UnboundTransaction | null = null;
    let resolve: (() => void) | null = null;
    const promise = new Promise<void>((r) => { resolve = r; });

    const providers: any = {
      privateStateProvider: levelPrivateStateProvider({
        midnightDbName: `midnight-level-db-4d-${label}`,
        privateStateStoreName: `4d-ps-${label}`,
        signingKeyStoreName: `4d-sk-${label}`,
        privateStoragePasswordProvider: async () => password,
        accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
      walletProvider: {
        getCoinPublicKey: () => walletResult.zswapSecretKeys.coinPublicKey,
        getEncryptionPublicKey: () => walletResult.zswapSecretKeys.encryptionPublicKey,
        balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
          captured = tx;
          resolve!();
          throw new Error("DELEGATED_TX_CAPTURED");
        },
        submitTx: () => { throw new Error("Party A should not submit"); },
      },
      midnightProvider: {
        getCoinPublicKey: () => walletResult.zswapSecretKeys.coinPublicKey,
        getEncryptionPublicKey: () => walletResult.zswapSecretKeys.encryptionPublicKey,
        balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
          captured = tx;
          resolve!();
          throw new Error("DELEGATED_TX_CAPTURED");
        },
        submitTx: () => { throw new Error("Party A should not submit"); },
      },
    };

    return { providers, getCaptured: () => captured, waitForCapture: promise };
  }

  async function findContractFor(providers: any) {
    const compiled = CompiledContract.make("contract-round-value", mod.Counter.Contract).pipe(
      CompiledContract.withWitnesses(mod.witnesses as never),
      CompiledContract.withCompiledFileAssets(MANAGED_DIR),
    );
    return findDeployedContract(providers, {
      contractAddress,
      compiledContract: compiled as never,
      privateStateId: "counterPrivateState" as never,
      initialPrivateState: { privateCounter: 0 } as never,
    });
  }

  function makeEntryArgs(pIdx: number, txIdx: number): [Uint8Array, bigint] {
    const id = new Uint8Array(32);
    const rand = crypto.getRandomValues(new Uint8Array(8));
    id[0] = pIdx; id[1] = txIdx;
    id.set(rand, 24);
    return [id, BigInt(pIdx * 1000 + txIdx)];
  }

  // Phase 1: Create 2 UnboundTransactions per xw (parallel)
  console.log("\n--- Phase 1: Party A creating 2 add_entry TXs each (parallel) ---\n");

  interface CapturedTx {
    name: string;
    unboundTx: UnboundTransaction;
    createMs: number;
    txIdx: number;
  }

  const phase1Start = performance.now();
  const capturedTxs: CapturedTx[] = [];

  const createTasks = partyA.map((pa, pIdx) => {
    return (async () => {
      for (let j = 0; j < 2; j++) {
        const label = `${pa.name}-${j}`;
        const { providers, getCaptured, waitForCapture } = makeInterceptProviders(pa.result, label);
        try {
          const start = performance.now();
          const deployed = await findContractFor(providers);
          const [id, value] = makeEntryArgs(pIdx, j);

          (deployed.callTx as any).add_entry(id, value).catch((err: Error) => {
            if (!err.message.includes("DELEGATED_TX_CAPTURED")) {
              console.error(`  [${pa.name}#${j + 1}] circuit error: ${err.message.slice(0, 80)}`);
            }
          });

          await waitForCapture;
          const createMs = performance.now() - start;
          capturedTxs.push({ name: pa.name, unboundTx: getCaptured()!, createMs, txIdx: j });
          console.log(`  [${pa.name}#${j + 1}] captured (${createMs.toFixed(0)}ms)`);
        } catch (e) {
          console.error(`  [${pa.name}#${j + 1}] ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
  });

  await Promise.all(createTasks);
  const phase1Ms = performance.now() - phase1Start;
  console.log(`\nPhase 1 done: ${capturedTxs.length}/20 TXs captured in ${(phase1Ms / 1000).toFixed(1)}s`);

  // Phase 2: Batch balance+submit with speculative chaining
  console.log("\n--- Phase 2: Party B batch balance + prove + submit (speculative chaining) ---\n");

  const phase2Start = performance.now();
  const timings: TxTiming[] = [];

  const batchTasks = partyB.map((bw, bIdx) => {
    const myTxs = capturedTxs.filter((ctx) => ctx.name === EMPTY_WALLETS[bIdx]);
    if (myTxs.length === 0) return Promise.resolve();

    return (async () => {
      const entries: DelegatedTxEntry[] = myTxs.map((ctx) => ({
        tx: ctx.unboundTx as never,
        txStage: "unbound" as const,
      }));

      console.log(`  ${bw.name}: batching ${entries.length} TXs...`);
      const batchStart = performance.now();

      try {
        const results = await balanceAndSubmitBatch(bw.result, entries);

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const ctx = myTxs[i];
          const timing: TxTiming = {
            index: capturedTxs.indexOf(ctx),
            wallet: `${ctx.name}->${bw.name}`,
            createMs: ctx.createMs,
            balanceMs: r.balanceMs,
            proveMs: r.proveMs,
            submitMs: r.submitMs, confirmMs: 0,
            totalMs: ctx.createMs + r.balanceMs + r.proveMs + r.submitMs,
          };

          if (r.hash) {
            timing.txHash = r.hash;
            console.log(`    [${ctx.name}#${ctx.txIdx + 1}->${bw.name}] ${r.hash} (balance=${r.balanceMs.toFixed(0)}ms prove=${r.proveMs.toFixed(0)}ms submit=${r.submitMs.toFixed(0)}ms)`);
          } else {
            timing.error = r.error ?? "unknown";
            timing.errorCode = "batch_failed";
            console.error(`    [${ctx.name}#${ctx.txIdx + 1}->${bw.name}] ERROR: ${r.error}`);
          }
          timings.push(timing);
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        for (const ctx of myTxs) {
          timings.push({
            index: capturedTxs.indexOf(ctx),
            wallet: `${ctx.name}->${bw.name}`,
            createMs: ctx.createMs,
            balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0,
            totalMs: ctx.createMs,
            error: err.message,
            errorCode: classifyError(err).code,
          });
        }
        console.error(`  ${bw.name}: BATCH ERROR: ${err.message.slice(0, 80)}`);
      }
    })();
  });

  await Promise.all(batchTasks);
  const phase2Ms = performance.now() - phase2Start;
  const totalMs = phase1Ms + phase2Ms;

  console.log(`\nPhase 2 done in ${(phase2Ms / 1000).toFixed(1)}s`);

  // Wait for confirmations
  const successfulTxs = timings.filter((t) => t.txHash);
  if (successfulTxs.length > 0) {
    console.log(`\nWaiting for ${successfulTxs.length} confirmations...`);
    for (const tx of successfulTxs) {
      try {
        const confirmStart = performance.now();
        await waitForTxConfirmation(networkConfig.indexer, tx.txHash!, 300_000);
        tx.confirmMs = performance.now() - confirmStart;
      } catch {
        tx.confirmMs = -1;
      }
    }
  }

  const result = calculateStats(timings, FUNDED_WALLETS.length, totalMs, "4d delegated-2tx speculative (10 xw -> 10 w, 2tx each)");
  result.startedAt = new Date().toISOString();
  result.completedAt = new Date().toISOString();

  console.log(formatResults(result));
  const fp = saveBenchResult(result, "4d-delegated-2tx");
  console.log(`Results saved to: ${fp}`);

  for (const pa of partyA) await pa.result.wallet.stop().catch(() => {});
  for (const pb of partyB) await pb.result.wallet.stop().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4e — Simplest: 1 wallet, 1 self-transfer TX
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4e(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();

  console.log("\n=== Benchmark 4e: 1 wallet, 1 TX ===\n");

  const w = findWallet("w1");
  if (!w) { console.error("w1 not found."); Deno.exit(1); }

  console.log("Building w1...");
  const result = await buildWallet(w.seed);
  await syncWallet(result, { waitNonZero: false, logLabel: "w1" });
  await ensureDust(result, true);
  const tokenId = await resolveUnshieldedTokenId(result);
  console.log("w1 ready.\n");

  const timing: TxTiming = {
    index: 0, wallet: "w1",
    createMs: 0, balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0, totalMs: 0,
  };

  const benchStart = performance.now();
  const startedAt = new Date().toISOString();

  try {
    const transfer = await transferUnshielded(result, result.unshieldedAddress, 1n, tokenId);
    timing.createMs = transfer.createMs;
    timing.proveMs = transfer.proveMs;
    timing.submitMs = transfer.submitMs;
    timing.txHash = transfer.txId;
    console.log(`  TX: ${transfer.txId} (create=${timing.createMs.toFixed(0)}ms prove=${timing.proveMs.toFixed(0)}ms submit=${timing.submitMs.toFixed(0)}ms)`);

    const confirmStart = performance.now();
    await waitForTxConfirmation(networkConfig.indexer, transfer.txId, 60_000);
    timing.confirmMs = performance.now() - confirmStart;
    console.log(`  Confirmed in ${timing.confirmMs.toFixed(0)}ms`);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    timing.error = err.message;
    timing.errorCode = classifyError(err).code;
    console.error(`  ERROR: ${err.message.slice(0, 100)}`);
  }

  timing.totalMs = performance.now() - benchStart;
  const stats = calculateStats([timing], 1, timing.totalMs, "4e single (1w, 1tx)");
  stats.startedAt = startedAt;
  stats.completedAt = new Date().toISOString();

  console.log(formatResults(stats));
  const fp = saveBenchResult(stats, "4e-single");
  console.log(`Results saved to: ${fp}`);

  await result.wallet.stop().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4f — Single delegated: 1 xw creates TX, 1 w balances+submits
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4f(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();
  const networkId = String(getNetworkId());
  const password = Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "MyP@ssw0rd!20260";

  const contractAddress = getContractAddress("round-value", networkId)!;
  if (!contractAddress) {
    console.error("round-value not deployed. Run: bench deploy");
    Deno.exit(1);
  }

  console.log("\n=== Benchmark 4f: Single delegated TX ===\n");
  console.log(`  Party A: xw1 (creates TX)`);
  console.log(`  Party B: w1 (balances + proves + submits)`);
  console.log(`  Contract: ${contractAddress}\n`);

  const { createCircuitCallTxInterface } = await import("@midnight-ntwrk/midnight-js-contracts");
  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const { httpClientProofProvider } = await import("@midnight-ntwrk/midnight-js-http-client-proof-provider");
  const { levelPrivateStateProvider } = await import("@midnight-ntwrk/midnight-js-level-private-state-provider");
  const { NodeZkConfigProvider } = await import("@midnight-ntwrk/midnight-js-node-zk-config-provider");
  const mod = await import(CONTRACT_SOURCE);
  type UnboundTransaction = import("@midnight-ntwrk/midnight-js-types").UnboundTransaction;
  type FinalizedTransaction = import("@midnight-ntwrk/ledger-v8").FinalizedTransaction;

  const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

  // Build xw1 (Party A)
  console.log("Building xw1 (Party A)...");
  const xw1 = findWallet("xw1")!;
  const xw1Result = await buildWallet(xw1.seed);
  console.log("  xw1 ready");

  // Build w1 (Party B)
  console.log("Building w1 (Party B)...");
  const w1 = findWallet("w1")!;
  const w1Result = await buildWallet(w1.seed);
  await syncWallet(w1Result, { waitNonZero: false });
  await ensureDust(w1Result, true);
  console.log("  w1 ready (synced + dust)");

  // Intercepting provider to capture UnboundTransaction
  let captured: UnboundTransaction | null = null;
  let captureResolve: (() => void) | null = null;
  const capturePromise = new Promise<void>((r) => { captureResolve = r; });

  const interceptBalanceTx = async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
    captured = tx;
    captureResolve!();
    throw new Error("DELEGATED_TX_CAPTURED");
  };

  const providers: any = {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: `midnight-level-db-4f-xw1`,
      privateStateStoreName: `4f-ps-xw1`,
      signingKeyStoreName: `4f-sk-xw1`,
      privateStoragePasswordProvider: async () => password,
      accountId: Buffer.from(xw1Result.zswapSecretKeys.coinPublicKey).toString("hex"),
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider: {
      getCoinPublicKey: () => xw1Result.zswapSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => xw1Result.zswapSecretKeys.encryptionPublicKey,
      balanceTx: interceptBalanceTx,
      submitTx: () => { throw new Error("Party A should not submit"); },
    },
    midnightProvider: {
      getCoinPublicKey: () => xw1Result.zswapSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => xw1Result.zswapSecretKeys.encryptionPublicKey,
      balanceTx: interceptBalanceTx,
      submitTx: () => { throw new Error("Party A should not submit"); },
    },
  };

  // ── Setup: build contract interface (skips indexer sync) ──
  console.log("\n--- Setup: building contract interface ---");
  const setupStart = performance.now();

  const compiled = CompiledContract.make("contract-round-value", mod.Counter.Contract).pipe(
    CompiledContract.withWitnesses(mod.witnesses as never),
    CompiledContract.withCompiledFileAssets(MANAGED_DIR),
  );

  // Initialize private state directly (what findDeployedContract does internally)
  providers.privateStateProvider.setContractAddress(contractAddress);
  await providers.privateStateProvider.set("counterPrivateState", { privateCounter: 0 });

  // Debug: test which queries work
  const cs = await providers.publicDataProvider.queryContractState(contractAddress);
  console.log(`  queryContractState: ${cs ? "OK" : "NULL"}`);
  const zs = await providers.publicDataProvider.queryZSwapAndContractState(contractAddress);
  console.log(`  queryZSwapAndContractState: ${zs ? "OK" : "NULL"}`);
  if (!zs) {
    console.error("No public state found for contract. Is it deployed?");
    Deno.exit(1);
  }

  const callTx = createCircuitCallTxInterface(
    providers,
    compiled as never,
    contractAddress,
    "counterPrivateState" as never,
  );
  console.log(`  Ready (${((performance.now() - setupStart) / 1000).toFixed(1)}s)\n`);

  // ── Benchmark starts here ──
  console.log("--- Benchmark: Create + Balance + Prove + Submit ---");
  const benchStart = performance.now();
  const startedAt = new Date().toISOString();

  // Phase 1: Create UnboundTransaction
  const t3 = performance.now();
  const id = new Uint8Array(32);
  crypto.getRandomValues(id);

  (callTx as any).add_entry(id, 42n).catch((err: Error) => {
    if (!err.message.includes("DELEGATED_TX_CAPTURED")) {
      console.error(`  Circuit error: ${err.message.slice(0, 100)}`);
    }
  });

  await capturePromise;
  const createMs = performance.now() - t3;
  console.log(`  Created UnboundTx (${createMs.toFixed(0)}ms)`);

  // Phase 2: balance + prove + submit via w1
  console.log("\n--- Phase 2: Balance + Prove + Submit ---");

  const timing: TxTiming = {
    index: 0, wallet: "xw1->w1",
    createMs, balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0, totalMs: 0,
  };

  try {
    const t4 = performance.now();
    const recipe = await w1Result.wallet.balanceUnboundTransaction(
      captured as never,
      { shieldedSecretKeys: w1Result.walletZswapSecretKeys, dustSecretKey: w1Result.walletDustSecretKey },
      { ttl: new Date(Date.now() + TTL_DURATION_MS) },
    );
    timing.balanceMs = performance.now() - t4;
    console.log(`  Balanced (${timing.balanceMs.toFixed(0)}ms)`);

    const t5 = performance.now();
    const signed = await w1Result.wallet.signRecipe(recipe, (p: Uint8Array) => w1Result.unshieldedKeystore.signData(p));
    const finalized = await w1Result.wallet.finalizeRecipe(signed);
    timing.proveMs = performance.now() - t5;
    console.log(`  Proved (${timing.proveMs.toFixed(0)}ms)`);

    const t6 = performance.now();
    const txId = await w1Result.wallet.submitTransaction(finalized);
    timing.submitMs = performance.now() - t6;
    timing.txHash = String(txId);
    console.log(`  Submitted: ${txId} (${timing.submitMs.toFixed(0)}ms)`);

    const t7 = performance.now();
    await waitForTxConfirmation(networkConfig.indexer, timing.txHash, 60_000);
    timing.confirmMs = performance.now() - t7;
    console.log(`  Confirmed (${timing.confirmMs.toFixed(0)}ms)`);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    timing.error = err.message;
    timing.errorCode = classifyError(err).code;
    console.error(`  ERROR: ${err.message.slice(0, 100)}`);
  }

  timing.totalMs = performance.now() - benchStart;

  const stats = calculateStats([timing], 1, timing.totalMs, "4f single-delegated (1 xw -> 1 w)");
  stats.startedAt = startedAt;
  stats.completedAt = new Date().toISOString();

  console.log(formatResults(stats));
  const fp = saveBenchResult(stats, "4f-single-delegated");
  console.log(`Results saved to: ${fp}`);

  await xw1Result.wallet.stop().catch(() => {});
  await w1Result.wallet.stop().catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench run-4g — Sequential contract calls: each wallet calls add_entry
// ═══════════════════════════════════════════════════════════════════════════════

export async function benchRun4g(): Promise<void> {
  initNetwork();
  const networkConfig = getNetworkConfig();
  const networkId = String(getNetworkId());
  const password = Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "MyP@ssw0rd!20260";

  const contractAddress = getContractAddress("round-value", networkId)!;
  if (!contractAddress) {
    console.error("round-value not deployed. Run: bench deploy");
    Deno.exit(1);
  }

  console.log("\n=== Benchmark 4g: Sequential contract calls (add_entry) ===\n");
  console.log(`  Wallets: ${FUNDED_WALLETS.join(", ")}`);
  console.log(`  Contract: ${contractAddress}`);
  console.log(`  Mode: sequential, 1 add_entry call per wallet\n`);

  const { findDeployedContract } = await import("@midnight-ntwrk/midnight-js-contracts");
  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const { httpClientProofProvider } = await import("@midnight-ntwrk/midnight-js-http-client-proof-provider");
  const { levelPrivateStateProvider } = await import("@midnight-ntwrk/midnight-js-level-private-state-provider");
  const { NodeZkConfigProvider } = await import("@midnight-ntwrk/midnight-js-node-zk-config-provider");
  const mod = await import(CONTRACT_SOURCE);

  const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

  const compiled = CompiledContract.make("contract-round-value", mod.Counter.Contract).pipe(
    CompiledContract.withWitnesses(mod.witnesses as never),
    CompiledContract.withCompiledFileAssets(MANAGED_DIR),
  );

  // Build wallets + contract interfaces
  console.log("Building wallets and contract interfaces...\n");
  const walletData: { name: string; result: WalletResult; callTx: any; cleanup: () => Promise<void> }[] = [];

  for (const name of FUNDED_WALLETS) {
    const w = findWallet(name);
    if (!w) { console.error(`${name} not found.`); Deno.exit(1); }
    const result = await buildWallet(w.seed);
    await syncWallet(result, { waitNonZero: false, logLabel: name });
    await ensureDust(result, true);

    // Real wallet provider — balanceTx/submitTx go through the wallet facade
    const walletAndMidnightProvider = {
      getCoinPublicKey: () => result.zswapSecretKeys.coinPublicKey,
      getEncryptionPublicKey: () => result.zswapSecretKeys.encryptionPublicKey,
      async balanceTx(tx: any, ttl?: Date) {
        const bound = tx.bind();
        const recipe = await result.wallet.balanceFinalizedTransaction(bound, {
          shieldedSecretKeys: result.walletZswapSecretKeys,
          dustSecretKey: result.walletDustSecretKey,
        }, { ttl: ttl ?? new Date(Date.now() + TTL_DURATION_MS) });
        const signed = await result.wallet.signRecipe(recipe, (p: Uint8Array) => result.unshieldedKeystore.signData(p));
        return result.wallet.finalizeRecipe(signed);
      },
      submitTx(tx: any) {
        return result.wallet.submitTransaction(tx);
      },
    };

    const providers: any = {
      privateStateProvider: levelPrivateStateProvider({
        midnightDbName: `midnight-level-db-4g-${name}`,
        privateStateStoreName: `4g-ps-${name}`,
        signingKeyStoreName: `4g-sk-${name}`,
        privateStoragePasswordProvider: async () => password,
        accountId: Buffer.from(result.zswapSecretKeys.coinPublicKey).toString("hex"),
      }),
      publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
      walletProvider: walletAndMidnightProvider,
      midnightProvider: walletAndMidnightProvider,
    };

    console.log(`  ${name}: syncing contract state...`);
    const deployed = await findDeployedContract(providers, {
      contractAddress,
      compiledContract: compiled as never,
      privateStateId: "counterPrivateState" as never,
      initialPrivateState: { privateCounter: 0 } as never,
    });

    walletData.push({
      name,
      result,
      callTx: deployed.callTx,
      cleanup: async () => { await result.wallet.stop().catch(() => {}); },
    });
    console.log(`  ${name}: ready`);
  }

  // ── Benchmark ──
  console.log("\nRunning benchmark...\n");

  const transactions: TxTiming[] = [];
  const benchStart = performance.now();
  const startedAt = new Date().toISOString();

  for (let i = 0; i < walletData.length; i++) {
    const wd = walletData[i];
    const timing: TxTiming = {
      index: i, wallet: wd.name,
      createMs: 0, balanceMs: 0, proveMs: 0, submitMs: 0, confirmMs: 0, totalMs: 0,
    };

    const txStart = performance.now();
    try {
      const id = new Uint8Array(32);
      id[0] = i & 0xFF;
      crypto.getRandomValues(id.subarray(24));

      const callStart = performance.now();
      const callResult = await wd.callTx.add_entry(id, BigInt(i + 1));
      const callMs = performance.now() - callStart;
      // callTx.add_entry does create+balance+prove+submit in one call
      timing.createMs = callMs;
      timing.txHash = String(callResult.public?.txId ?? callResult.txHash ?? "");

      // Try to extract txHash from the result
      if (!timing.txHash && callResult.public?.transactionId) {
        timing.txHash = String(callResult.public.transactionId);
      }

      timing.totalMs = performance.now() - txStart;
      console.log(`  [${i + 1}/10] ${wd.name}: ${timing.txHash?.slice(0, 16)}... (${callMs.toFixed(0)}ms)`);

      // Wait for confirmation
      if (timing.txHash) {
        const confirmStart = performance.now();
        await waitForTxConfirmation(networkConfig.indexer, timing.txHash, 300_000);
        timing.confirmMs = performance.now() - confirmStart;
        console.log(`    Confirmed (${timing.confirmMs.toFixed(0)}ms)`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const classified = classifyError(err);
      timing.error = err.message;
      timing.errorCode = classified.code;
      timing.totalMs = performance.now() - txStart;
      console.error(`  [${i + 1}/10] ${wd.name}: ERROR ${classified.code} - ${err.message.slice(0, 80)}`);
    }
    transactions.push(timing);
  }

  const totalMs = performance.now() - benchStart;
  const stats = calculateStats(transactions, FUNDED_WALLETS.length, totalMs, "4g sequential contract calls (10w, 1 add_entry each)");
  stats.startedAt = startedAt;
  stats.completedAt = new Date().toISOString();

  console.log(formatResults(stats));
  const fp = saveBenchResult(stats, "4g-contract-calls");
  console.log(`Results saved to: ${fp}`);

  for (const wd of walletData) await wd.cleanup();
}

// ═══════════════════════════════════════════════════════════════════════════════
// bench report — Compare all benchmark results
// ═══════════════════════════════════════════════════════════════════════════════

export function benchReport(): void {
  const prefixes = ["4a-parallel", "4b-parallel", "4c-delegated-1tx", "4d-delegated-2tx", "4e-single", "4f-single-delegated", "4g-contract-calls"];
  const labels = ["4a par-1tx", "4b prove+submit", "4c deleg-1tx", "4d deleg-2tx", "4e single", "4f single-deleg", "4g contract-call"];

  let files: string[];
  try {
    files = [...Deno.readDirSync(BENCHMARKS_DIR)]
      .filter((e) => e.isFile && e.name.endsWith(".json"))
      .map((e) => e.name);
  } catch {
    console.log("No benchmark results found. Run bench run-4a/4b/4c/4d first.");
    return;
  }

  console.log("\n=== Benchmark Comparison ===\n");

  const hdr = `  ${"Scenario".padEnd(18)} ${"TXs".padStart(5)} ${"Success".padStart(8)} ${"Time(s)".padStart(9)} ${"TPS".padStart(8)} ${"TPS/W".padStart(8)}`;
  const sep = `  ${"-".repeat(18)} ${"-".repeat(5)} ${"-".repeat(8)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(8)}`;
  console.log(hdr);
  console.log(sep);

  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i];
    const matching = files.filter((f) => f.startsWith(prefix)).sort().reverse();

    if (matching.length === 0) {
      console.log(`  ${labels[i].padEnd(18)} ${"--".padStart(5)} ${"--".padStart(8)} ${"--".padStart(9)} ${"--".padStart(8)} ${"--".padStart(8)}`);
      continue;
    }

    try {
      const data = JSON.parse(Deno.readTextFileSync(`${BENCHMARKS_DIR}/${matching[0]}`)) as BenchmarkResult;
      const time = (data.timing.totalMs / 1000).toFixed(1);
      console.log(
        `  ${labels[i].padEnd(18)} ${String(data.txCount).padStart(5)} ${String(data.successCount).padStart(8)} ${time.padStart(9)} ${data.tps.toFixed(3).padStart(8)} ${data.tpsPerWallet.toFixed(3).padStart(8)}`,
      );
    } catch {
      console.log(`  ${labels[i].padEnd(18)} (error reading results)`);
    }
  }

  console.log();
}
