/**
 * Network configuration resolution and validation.
 */

import { midnightNetworkConfig } from "@paimaexample/midnight-contracts/midnight-env";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

export const GENESIS_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";
export const TTL_DURATION_MS = 60 * 60 * 1000;

export function requireNetworkId(): string {
  const id = Deno.env.get("MIDNIGHT_NETWORK_ID");
  if (!id) {
    console.error(
      "Error: MIDNIGHT_NETWORK_ID is required.\n" +
        "  MIDNIGHT_NETWORK_ID=undeployed deno task cli <command>\n" +
        "  MIDNIGHT_NETWORK_ID=preprod   deno task cli <command>\n" +
        "  MIDNIGHT_NETWORK_ID=mainnet   deno task cli <command>",
    );
    Deno.exit(1);
  }
  return id;
}

export function getNetworkConfig() {
  return midnightNetworkConfig;
}

export function getNetworkUrls() {
  return {
    id: midnightNetworkConfig.id,
    indexer: midnightNetworkConfig.indexer,
    indexerWS: midnightNetworkConfig.indexerWS,
    node: midnightNetworkConfig.node,
    proofServer: midnightNetworkConfig.proofServer,
  };
}

export function getNetworkId() {
  return midnightNetworkConfig.id;
}

export function initNetwork(): void {
  setNetworkId(midnightNetworkConfig.id);
}
