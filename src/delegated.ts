/**
 * Delegated proving and balancing — Party A / Party B flow.
 *
 * Party A: creates a circuit transaction, captures the UnboundTransaction (no funds needed).
 * Party B: balances, proves, and submits the UnboundTransaction (needs dust).
 */

import { TTL_DURATION_MS } from "./config.ts";
import type { WalletResult } from "./wallet-ops.ts";
import { classifyError } from "./errors.ts";
import type {
  FinalizedTransaction,
  UnprovenTransaction,
} from "@midnight-ntwrk/ledger-v8";
import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js-types";
import type { BalancingRecipe } from "@midnight-ntwrk/wallet-sdk-facade";

const createTtl = () => new Date(Date.now() + TTL_DURATION_MS);

export type DelegatedTxStage = "unproven" | "unbound" | "finalized";

export interface DelegatedTxEntry {
  tx: UnboundTransaction | UnprovenTransaction | FinalizedTransaction;
  txStage: DelegatedTxStage;
}

export interface DelegatedTimings {
  txId: string;
  balanceMs: number;
  proveMs: number;
  submitMs: number;
}

/**
 * Balance, sign, prove, and submit a single delegated transaction.
 */
export async function balanceAndSubmit(
  walletResult: WalletResult,
  entry: DelegatedTxEntry,
): Promise<DelegatedTimings> {
  const keys = {
    shieldedSecretKeys: walletResult.walletZswapSecretKeys,
    dustSecretKey: walletResult.walletDustSecretKey,
  };
  const opts = { ttl: createTtl() };

  // Phase 1: Balance
  const balanceStart = performance.now();
  let recipe: BalancingRecipe;

  switch (entry.txStage) {
    case "unbound":
      recipe = await walletResult.wallet.balanceUnboundTransaction(
        entry.tx as UnboundTransaction, keys, opts,
      );
      break;
    case "unproven":
      recipe = await walletResult.wallet.balanceUnprovenTransaction(
        entry.tx as UnprovenTransaction, keys, opts,
      );
      break;
    case "finalized":
      recipe = await walletResult.wallet.balanceFinalizedTransaction(
        entry.tx as FinalizedTransaction, keys, opts,
      );
      break;
  }
  const balanceMs = performance.now() - balanceStart;

  // Phase 2: Sign + prove (finalize = ZK proof generation)
  const proveStart = performance.now();
  const signedRecipe = await walletResult.wallet.signRecipe(
    recipe,
    (payload: Uint8Array) => walletResult.unshieldedKeystore.signData(payload),
  );
  const finalized = await walletResult.wallet.finalizeRecipe(signedRecipe);
  const proveMs = performance.now() - proveStart;

  // Phase 3: Submit
  const submitStart = performance.now();
  const txId = await walletResult.wallet.submitTransaction(finalized);
  const submitMs = performance.now() - submitStart;

  return { txId: String(txId), balanceMs, proveMs, submitMs };
}

export interface BatchTxResult {
  hash: string;
  balanceMs: number;
  proveMs: number;
  submitMs: number;
  error?: string;
}

/**
 * Balance and submit a batch of delegated transactions using speculative chaining.
 */
export async function balanceAndSubmitBatch(
  walletResult: WalletResult,
  entries: DelegatedTxEntry[],
): Promise<BatchTxResult[]> {
  const keys = {
    shieldedSecretKeys: walletResult.walletZswapSecretKeys,
    dustSecretKey: walletResult.walletDustSecretKey,
  };
  const opts = { ttl: createTtl() };
  const results: BatchTxResult[] = [];

  // Phase 1: Balance all (speculative chaining)
  const recipes: { recipe: BalancingRecipe | null; balanceMs: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i];
      const balanceStart = performance.now();
      let recipe: BalancingRecipe;
      switch (entry.txStage) {
        case "unbound":
          recipe = await walletResult.wallet.balanceUnboundTransaction(
            entry.tx as UnboundTransaction, keys, opts,
          );
          break;
        case "unproven":
          recipe = await walletResult.wallet.balanceUnprovenTransaction(
            entry.tx as UnprovenTransaction, keys, opts,
          );
          break;
        case "finalized":
          recipe = await walletResult.wallet.balanceFinalizedTransaction(
            entry.tx as FinalizedTransaction, keys, opts,
          );
          break;
      }
      const balanceMs = performance.now() - balanceStart;
      recipes.push({ recipe, balanceMs });
      console.log(`  Balanced tx ${i + 1}/${entries.length} (${balanceMs.toFixed(0)}ms)`);
    } catch (e) {
      console.error(`  Balance failed for tx ${i + 1}: ${e}`);
      recipes.push({ recipe: null, balanceMs: 0 });
      for (let j = i + 1; j < entries.length; j++) recipes.push({ recipe: null, balanceMs: 0 });
      break;
    }
  }

  // Phase 2: Sign + finalize
  const finalized: { tx: FinalizedTransaction | null; proveMs: number }[] = [];
  for (let i = 0; i < recipes.length; i++) {
    const { recipe } = recipes[i];
    if (!recipe) {
      finalized.push({ tx: null, proveMs: 0 });
      continue;
    }
    try {
      const proveStart = performance.now();
      const signed = await walletResult.wallet.signRecipe(
        recipe,
        (payload: Uint8Array) =>
          walletResult.unshieldedKeystore.signData(payload),
      );
      const tx = await walletResult.wallet.finalizeRecipe(signed);
      const proveMs = performance.now() - proveStart;
      finalized.push({ tx, proveMs });
      console.log(`  Finalized tx ${i + 1}/${entries.length} (${proveMs.toFixed(0)}ms)`);
    } catch (e) {
      console.error(`  Finalize failed for tx ${i + 1}: ${e}`);
      finalized.push({ tx: null, proveMs: 0 });
    }
  }

  // Phase 3: Submit sequentially
  for (let i = 0; i < finalized.length; i++) {
    const { tx, proveMs } = finalized[i];
    const { balanceMs } = recipes[i];
    if (!tx) {
      results.push({
        hash: "",
        balanceMs,
        proveMs,
        submitMs: 0,
        error: recipes[i].recipe ? "finalize_failed" : "balance_failed",
      });
      continue;
    }
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 5000;
    let submitted = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const submitStart = performance.now();
        const txId = await walletResult.wallet.submitTransaction(tx);
        const submitMs = performance.now() - submitStart;
        results.push({ hash: String(txId), balanceMs, proveMs, submitMs });
        console.log(`  Submitted tx ${i + 1}/${entries.length}: ${txId} (${submitMs.toFixed(0)}ms${attempt > 1 ? ` attempt=${attempt}` : ""})`);
        submitted = true;
        break;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const classified = classifyError(err);
        if (attempt < MAX_RETRIES && classified.retryable) {
          console.warn(`  Retry ${attempt}/${MAX_RETRIES} tx ${i + 1}: ${classified.code} - ${err.message.slice(0, 60)}`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        results.push({ hash: "", balanceMs, proveMs, submitMs: 0, error: err.message });
        console.error(`  Submit failed for tx ${i + 1}: ${err.message}`);
        submitted = true;
        break;
      }
    }
    if (!submitted) {
      results.push({ hash: "", balanceMs, proveMs, submitMs: 0, error: "max_retries_exceeded" });
    }
  }

  return results;
}
