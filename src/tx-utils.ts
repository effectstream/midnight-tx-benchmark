/**
 * Transaction utilities — transfers, token resolution.
 */

import { TTL_DURATION_MS, getNetworkId, initNetwork } from "./config.ts";
import type { WalletResult } from "./wallet-ops.ts";
import { nativeToken, type UnprovenTransaction } from "@midnight-ntwrk/ledger-v8";
import {
  MidnightBech32m,
  UnshieldedAddress,
} from "@midnight-ntwrk/wallet-sdk-address-format";
import * as Rx from "rxjs";

export function resolveNativeTokenId(): string {
  const token = nativeToken() as unknown as { raw?: string };
  if (typeof token === "string") return token;
  if (token?.raw) return token.raw;
  return String(token);
}

export async function resolveUnshieldedTokenId(
  walletResult: WalletResult,
): Promise<string> {
  const state: any = await Rx.firstValueFrom(walletResult.wallet.state());
  const balances = state.unshielded?.balances as
    | Map<string, bigint>
    | Record<string, bigint>
    | undefined;
  if (balances) {
    const keys = balances instanceof Map
      ? Array.from(balances.keys())
      : Object.keys(balances);
    const preferred = resolveNativeTokenId();
    if (keys.includes(preferred)) return preferred;
    if (keys.length > 0) return keys[0];
  }
  return resolveNativeTokenId();
}

export interface TransferTimings {
  txId: string;
  createMs: number;
  proveMs: number;
  submitMs: number;
}

export interface ProvedTransfer {
  finalized: import("@midnight-ntwrk/ledger-v8").FinalizedTransaction;
  createMs: number;
  proveMs: number;
}

export async function transferUnshielded(
  walletResult: WalletResult,
  receiverAddress: string,
  amount: bigint,
  tokenId?: string,
): Promise<TransferTimings> {
  initNetwork();
  const networkId = getNetworkId();
  const resolvedTokenId = tokenId ?? await resolveUnshieldedTokenId(walletResult);

  const parsedAddress = MidnightBech32m.parse(receiverAddress).decode(
    UnshieldedAddress,
    networkId,
  );

  const ttl = new Date(Date.now() + TTL_DURATION_MS);

  // Phase 1: Create transaction recipe (includes internal balancing)
  const createStart = performance.now();
  const recipe = await walletResult.wallet.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: [
          { amount, type: resolvedTokenId, receiverAddress: parsedAddress },
        ],
      },
    ],
    {
      shieldedSecretKeys: walletResult.walletZswapSecretKeys,
      dustSecretKey: walletResult.walletDustSecretKey,
    },
    { ttl },
  );
  const createMs = performance.now() - createStart;

  // Phase 2: Sign + prove (finalize = ZK proof generation)
  const proveStart = performance.now();
  const signed: UnprovenTransaction =
    await walletResult.wallet.signUnprovenTransaction(
      recipe.transaction,
      (payload: Uint8Array) =>
        walletResult.unshieldedKeystore.signData(payload),
    );
  const finalized = await walletResult.wallet.finalizeTransaction(signed);
  const proveMs = performance.now() - proveStart;

  // Phase 3: Submit
  const submitStart = performance.now();
  const txId = await walletResult.wallet.submitTransaction(finalized);
  const submitMs = performance.now() - submitStart;

  return { txId: String(txId), createMs, proveMs, submitMs };
}

/** Create + sign + prove, but do NOT submit. */
export async function proveUnshielded(
  walletResult: WalletResult,
  receiverAddress: string,
  amount: bigint,
  tokenId?: string,
): Promise<ProvedTransfer> {
  initNetwork();
  const networkId = getNetworkId();
  const resolvedTokenId = tokenId ?? await resolveUnshieldedTokenId(walletResult);

  const parsedAddress = MidnightBech32m.parse(receiverAddress).decode(
    UnshieldedAddress,
    networkId,
  );

  const ttl = new Date(Date.now() + TTL_DURATION_MS);

  const createStart = performance.now();
  const recipe = await walletResult.wallet.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: [
          { amount, type: resolvedTokenId, receiverAddress: parsedAddress },
        ],
      },
    ],
    {
      shieldedSecretKeys: walletResult.walletZswapSecretKeys,
      dustSecretKey: walletResult.walletDustSecretKey,
    },
    { ttl },
  );
  const createMs = performance.now() - createStart;

  const proveStart = performance.now();
  const signed: UnprovenTransaction =
    await walletResult.wallet.signUnprovenTransaction(
      recipe.transaction,
      (payload: Uint8Array) =>
        walletResult.unshieldedKeystore.signData(payload),
    );
  const finalized = await walletResult.wallet.finalizeTransaction(signed);
  const proveMs = performance.now() - proveStart;

  return { finalized, createMs, proveMs };
}

/** Submit a finalized transaction. */
export async function submitFinalized(
  walletResult: WalletResult,
  finalized: import("@midnight-ntwrk/ledger-v8").FinalizedTransaction,
): Promise<{ txId: string; submitMs: number }> {
  const submitStart = performance.now();
  const txId = await walletResult.wallet.submitTransaction(finalized);
  const submitMs = performance.now() - submitStart;
  return { txId: String(txId), submitMs };
}
