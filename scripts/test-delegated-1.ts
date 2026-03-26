/**
 * Minimal delegated test: 1 xw creates 1 TX, 1 w balances + submits.
 */
import { initNetwork, getNetworkConfig, getNetworkId, TTL_DURATION_MS } from "../src/config.ts";
import { findWallet } from "../src/wallet-store.ts";
import { buildWallet, syncWallet, ensureDust } from "../src/wallet-ops.ts";
import { getContractAddress } from "../src/contract-store.ts";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { UnboundTransaction } from "@midnight-ntwrk/midnight-js-types";
import type { FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";
import { Buffer } from "node:buffer";

const MANAGED_DIR = new URL("../contract-round-value/src/managed", import.meta.url).pathname;
const CONTRACT_SOURCE = new URL("../contract-round-value/src/index.original.ts", import.meta.url).pathname;

initNetwork();
const networkConfig = getNetworkConfig();
const networkId = String(getNetworkId());
const password = Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "MyP@ssw0rd!2026";
const contractAddress = getContractAddress("round-value", networkId)!;

console.log("Contract:", contractAddress);
console.log("Managed dir:", MANAGED_DIR);

const mod = await import(CONTRACT_SOURCE);
console.log("Contract module loaded, exports:", Object.keys(mod));

const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

// Build xw1 (Party A)
console.log("\n--- Building xw1 (Party A) ---");
const xw1 = findWallet("xw1")!;
const xw1Result = await buildWallet(xw1.seed);
console.log("xw1 built");

// Build w1 (Party B)
console.log("\n--- Building w1 (Party B) ---");
const w1 = findWallet("w1")!;
const w1Result = await buildWallet(w1.seed);
await syncWallet(w1Result, { waitNonZero: false });
await ensureDust(w1Result, true);
console.log("w1 synced with dust");

// Create intercepting providers
let captured: UnboundTransaction | null = null;
let captureResolve: (() => void) | null = null;
const capturePromise = new Promise<void>((r) => { captureResolve = r; });

const providers: any = {
  privateStateProvider: levelPrivateStateProvider({
    midnightDbName: `test-delegated-xw1`,
    privateStateStoreName: `test-ps-xw1`,
    signingKeyStoreName: `test-sk-xw1`,
    privateStoragePasswordProvider: async () => password,
    accountId: Buffer.from(xw1Result.zswapSecretKeys.coinPublicKey).toString("hex"),
  }),
  publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
  zkConfigProvider,
  proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
  walletProvider: {
    getCoinPublicKey: () => xw1Result.zswapSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => xw1Result.zswapSecretKeys.encryptionPublicKey,
    balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
      console.log("  CAPTURED UnboundTransaction!");
      captured = tx;
      captureResolve!();
      throw new Error("DELEGATED_TX_CAPTURED");
    },
    submitTx: () => { throw new Error("Should not submit"); },
  },
  midnightProvider: {
    getCoinPublicKey: () => xw1Result.zswapSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => xw1Result.zswapSecretKeys.encryptionPublicKey,
    balanceTx: async (tx: UnboundTransaction): Promise<FinalizedTransaction> => {
      console.log("  CAPTURED UnboundTransaction (midnight)!");
      captured = tx;
      captureResolve!();
      throw new Error("DELEGATED_TX_CAPTURED");
    },
    submitTx: () => { throw new Error("Should not submit"); },
  },
};

// Find deployed contract
console.log("\n--- Finding deployed contract ---");
const t0 = performance.now();
const compiled = CompiledContract.make("contract-round-value", mod.Counter.Contract).pipe(
  CompiledContract.withWitnesses(mod.witnesses as never),
  CompiledContract.withCompiledFileAssets(MANAGED_DIR),
);
console.log("Compiled contract created in", (performance.now() - t0).toFixed(0), "ms");

const t1 = performance.now();
const deployed = await findDeployedContract(providers, {
  contractAddress,
  compiledContract: compiled as never,
  privateStateId: "counterPrivateState" as never,
  initialPrivateState: { privateCounter: 0 } as never,
});
console.log("findDeployedContract took", (performance.now() - t1).toFixed(0), "ms");

// Call add_entry
console.log("\n--- Calling add_entry ---");
const t2 = performance.now();
const id = new Uint8Array(32);
crypto.getRandomValues(id);

(deployed.callTx as any).add_entry(id, 42n).catch((err: Error) => {
  if (!err.message.includes("DELEGATED_TX_CAPTURED")) {
    console.error("Circuit error:", err.message.slice(0, 100));
  }
});

await capturePromise;
console.log("UnboundTx captured in", (performance.now() - t2).toFixed(0), "ms");

// Balance + Submit via w1
console.log("\n--- Balancing + proving + submitting via w1 ---");
const t3 = performance.now();
const recipe = await w1Result.wallet.balanceUnboundTransaction(
  captured as never,
  { shieldedSecretKeys: w1Result.walletZswapSecretKeys, dustSecretKey: w1Result.walletDustSecretKey },
  { ttl: new Date(Date.now() + TTL_DURATION_MS) },
);
console.log("Balanced in", (performance.now() - t3).toFixed(0), "ms");

const t4 = performance.now();
const signed = await w1Result.wallet.signRecipe(recipe, (p: Uint8Array) => w1Result.unshieldedKeystore.signData(p));
const finalized = await w1Result.wallet.finalizeRecipe(signed);
console.log("Proved in", (performance.now() - t4).toFixed(0), "ms");

const t5 = performance.now();
const txId = await w1Result.wallet.submitTransaction(finalized);
console.log("Submitted in", (performance.now() - t5).toFixed(0), "ms");
console.log("\nSUCCESS:", txId);
console.log("Total time:", (performance.now() - t0).toFixed(0), "ms");

await xw1Result.wallet.stop().catch(() => {});
await w1Result.wallet.stop().catch(() => {});
