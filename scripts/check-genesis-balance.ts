import { initNetwork } from "../src/config.ts";
import { findWallet } from "../src/wallet-store.ts";
import { buildWallet, syncWallet } from "../src/wallet-ops.ts";
import * as Rx from "rxjs";

initNetwork();
const g = findWallet("genesis")!;
const wr = await buildWallet(g.seed);
await syncWallet(wr, { waitNonZero: false, timeoutMs: 60000 });

const state: any = await Rx.firstValueFrom(
  wr.wallet.state().pipe(Rx.filter((s: any) => s.isSynced))
);
const balances = state.unshielded?.balances;
console.log("Genesis unshielded balances:", balances);
const coins = state.unshielded?.availableCoins ?? [];
console.log("Available coins:", coins.length);
for (const c of coins.slice(0, 3)) {
  console.log("  Coin:", c.amount?.toString(), "registered:", c.meta?.registeredForDustGeneration);
}
await wr.wallet.stop().catch(() => {});
