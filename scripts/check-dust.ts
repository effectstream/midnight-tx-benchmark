import { initNetwork } from "../src/config.ts";
import { findWallet } from "../src/wallet-store.ts";
import { buildWallet, syncWallet } from "../src/wallet-ops.ts";
import { waitForDustFunds } from "@paimaexample/midnight-contracts";
import * as Rx from "rxjs";

initNetwork();
const w = findWallet("w1")!;
const wr = await buildWallet(w.seed);
await syncWallet(wr, { waitNonZero: false, timeoutMs: 60000 });

const state: any = await Rx.firstValueFrom(
  wr.wallet.state().pipe(Rx.filter((s: any) => s.isSynced))
);

// Night balance
const balances = state.unshielded?.balances;
let nightBal = 0n;
if (balances instanceof Map) {
  for (const v of balances.values()) nightBal += v ?? 0n;
} else if (balances) {
  for (const v of Object.values(balances)) nightBal += (v as bigint) ?? 0n;
}
console.log("Night balance:", nightBal);

// UTXOs
const coins = state.unshielded?.availableCoins ?? [];
const reg = coins.filter((c: any) => c.meta.registeredForDustGeneration === true);
const unreg = coins.filter((c: any) => c.meta.registeredForDustGeneration === false);
console.log("UTXOs:", coins.length, "Registered:", reg.length, "Unregistered:", unreg.length);

// Dust
try {
  console.log("Waiting for dust (30s timeout)...");
  const dust = await waitForDustFunds(wr.wallet, { waitNonZero: true, timeoutMs: 30000 });
  console.log("Dust balance:", dust);
} catch (e: any) {
  console.log("Dust not available:", e.message?.slice(0, 80));
}

await wr.wallet.stop().catch(() => {});
