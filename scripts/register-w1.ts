import { initNetwork } from "../src/config.ts";
import { findWallet } from "../src/wallet-store.ts";
import { buildWallet, syncWallet } from "../src/wallet-ops.ts";
import * as Rx from "rxjs";

initNetwork();
const w = findWallet("w1")!;
const wr = await buildWallet(w.seed);
await syncWallet(wr, { waitNonZero: false, timeoutMs: 60000 });

const state: any = await Rx.firstValueFrom(
  wr.wallet.state().pipe(Rx.filter((s: any) => s.isSynced))
);
const coins = state.unshielded?.availableCoins ?? [];
const unreg = coins.filter((c: any) => c.meta.registeredForDustGeneration === false);
console.log("Total UTXOs:", coins.length, "Unregistered:", unreg.length);

if (unreg.length > 0) {
  console.log("Registering", unreg.length, "UTXOs for dust...");
  const recipe = await (wr.wallet as any).registerNightUtxosForDustGeneration(
    unreg,
    wr.unshieldedKeystore.getPublicKey(),
    (payload: Uint8Array) => wr.unshieldedKeystore.signData(payload),
  );
  const fin = await (wr.wallet as any).finalizeRecipe(recipe);
  const txId = await wr.wallet.submitTransaction(fin);
  console.log("Registered:", txId);
} else {
  console.log("All UTXOs already registered.");
}
await wr.wallet.stop().catch(() => {});
