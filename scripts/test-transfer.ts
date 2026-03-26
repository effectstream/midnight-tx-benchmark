import { initNetwork, getNetworkId, TTL_DURATION_MS } from "../src/config.ts";
import { findWallet } from "../src/wallet-store.ts";
import { buildWallet, syncWallet } from "../src/wallet-ops.ts";
import { waitForDustFunds } from "@paimaexample/midnight-contracts";
import { nativeToken } from "@midnight-ntwrk/ledger-v8";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import * as Rx from "rxjs";

initNetwork();
const w1 = findWallet("w1")!;
const w2 = findWallet("w2")!;

console.log("Building w1...");
const wr = await buildWallet(w1.seed);
console.log("Syncing w1...");
await syncWallet(wr, { waitNonZero: false, timeoutMs: 120000 });

console.log("Waiting for dust (non-zero)...");
const dustBal = await waitForDustFunds(wr.wallet, { waitNonZero: true, timeoutMs: 60000 });
console.log("Dust balance:", dustBal);

// Get w2 address
const w2r = await buildWallet(w2.seed);
const w2Addr = w2r.unshieldedAddress;
await w2r.wallet.stop().catch(() => {});
console.log("w2 address:", w2Addr);

// Try to get wallet state
const state: any = await Rx.firstValueFrom(
  wr.wallet.state().pipe(Rx.filter((s: any) => s.isSynced))
);
const balances = state.unshielded?.balances;
console.log("Unshielded balances:", balances);
const coins = state.unshielded?.availableCoins ?? [];
console.log("Available coins:", coins.length);

// Try the transfer
console.log("\nAttempting transfer of 10,000 to w2...");
try {
  const networkId = getNetworkId();
  const tokenId = nativeToken();
  const parsedAddr = MidnightBech32m.parse(w2Addr).decode(UnshieldedAddress, networkId);
  const ttl = new Date(Date.now() + TTL_DURATION_MS);

  console.log("Calling transferTransaction...");
  const recipe = await wr.wallet.transferTransaction(
    [{
      type: "unshielded",
      outputs: [{ amount: 10000n, type: String(tokenId), receiverAddress: parsedAddr }],
    }],
    {
      shieldedSecretKeys: wr.walletZswapSecretKeys,
      dustSecretKey: wr.walletDustSecretKey,
    },
    { ttl },
  );
  console.log("Got recipe, signing...");
  const signed = await wr.wallet.signUnprovenTransaction(
    recipe.transaction,
    (payload: Uint8Array) => wr.unshieldedKeystore.signData(payload),
  );
  console.log("Finalizing...");
  const finalized = await wr.wallet.finalizeTransaction(signed);
  console.log("Submitting...");
  const txId = await wr.wallet.submitTransaction(finalized);
  console.log("SUCCESS:", txId);
} catch (e: any) {
  console.error("TRANSFER FAILED:", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n"));
}

await wr.wallet.stop().catch(() => {});
