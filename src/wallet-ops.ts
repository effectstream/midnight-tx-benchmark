/**
 * Wallet operations — build facades, sync, get balances.
 */

import { initNetwork, getNetworkUrls, getNetworkId } from "./config.ts";
import {
  buildWalletFacade,
  syncAndWaitForFunds,
  waitForDustFunds,
  type WalletResult,
} from "@paimaexample/midnight-contracts";
import * as Rx from "rxjs";

export type { WalletResult };

export async function buildWallet(seed: string): Promise<WalletResult> {
  initNetwork();
  return await buildWalletFacade(getNetworkUrls(), seed, getNetworkId());
}

/** Build a wallet, run fn, then stop the wallet regardless of outcome. */
export async function withWallet<T>(
  seed: string,
  fn: (result: WalletResult) => Promise<T>,
): Promise<T> {
  const result = await buildWallet(seed);
  try {
    return await fn(result);
  } finally {
    await result.wallet.stop().catch(() => {});
  }
}

export interface SyncOptions {
  waitNonZero?: boolean;
  logLabel?: string;
  timeoutMs?: number;
}

export async function syncWallet(
  walletResult: WalletResult,
  opts: SyncOptions = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 300_000;
  const label = opts.logLabel ?? "wallet";

  try {
    await Rx.firstValueFrom(
      walletResult.wallet.state().pipe(
        Rx.filter((s: any) => s.isSynced),
        Rx.timeout({
          each: timeout,
          with: () => Rx.throwError(() => new Error(`${label}: sync timeout`)),
        }),
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ${label}: sync error — ${msg}`);
  }
}

export async function ensureDust(walletResult: WalletResult, requireNonZero = false): Promise<void> {
  try {
    await waitForDustFunds(walletResult.wallet, {
      waitNonZero: requireNonZero,
      timeoutMs: requireNonZero ? 180_000 : 30_000,
    });
  } catch {
    // Dust might not be available yet — that's OK for some operations
  }
}
