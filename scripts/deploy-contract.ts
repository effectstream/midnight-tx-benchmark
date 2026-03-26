#!/usr/bin/env -S deno run -A --unstable-detect-cjs
/**
 * Deploy the round-value contract.
 *
 * Usage:
 *   MIDNIGHT_NETWORK_ID=undeployed MIDNIGHT_STORAGE_PASSWORD='MyP@ssw0rd!20260' \
 *     deno run -A --unstable-detect-cjs scripts/deploy-contract.ts
 */

import { deployMidnightContract } from "@paimaexample/midnight-contracts/deploy";
import type { DeployConfig } from "@paimaexample/midnight-contracts/types";
import { midnightNetworkConfig } from "@paimaexample/midnight-contracts/midnight-env";
import { saveContract } from "../src/contract-store.ts";
import {
  Counter,
  type CounterPrivateState,
  witnesses,
} from "../contract-round-value/src/index.original.ts";

const networkId = Deno.env.get("MIDNIGHT_NETWORK_ID") ?? "undeployed";
const outputFile = `contract-round-value.${networkId}.json`;

const config: DeployConfig = {
  contractName: "contract-round-value",
  contractFileName: outputFile,
  contractClass: Counter.Contract,
  witnesses,
  privateStateId: "counterPrivateState",
  initialPrivateState: { privateCounter: 0 } as CounterPrivateState,
  privateStateStoreName: "counter-private-state",
};

console.log("Deploying round-value contract...");
console.log(`  Network: ${midnightNetworkConfig.id}`);
console.log(`  Indexer: ${midnightNetworkConfig.indexer}`);

deployMidnightContract(config, midnightNetworkConfig)
  .then(() => {
    // Read the address that deployMidnightContract wrote and sync to contracts.json
    const deployed = JSON.parse(Deno.readTextFileSync(outputFile));
    saveContract({
      contractName: "round-value",
      networkId,
      contractAddress: deployed.contractAddress,
      deployedAt: new Date().toISOString(),
    });
    console.log(`Deployment successful — ${deployed.contractAddress}`);
    console.log(`  Saved to contracts.json`);
    Deno.exit(0);
  })
  .catch((e: unknown) => {
    console.error("Unhandled error:", e);
    Deno.exit(1);
  });
