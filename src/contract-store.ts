/**
 * Contract address registry — tracks deployed contract addresses per network.
 */

const CONTRACTS_FILE = new URL("../contracts.json", import.meta.url).pathname;

export interface DeployedContract {
  contractName: string;
  networkId: string;
  contractAddress: string;
  deployedAt: string;
}

export function loadContracts(): DeployedContract[] {
  try {
    const data = Deno.readTextFileSync(CONTRACTS_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveContracts(contracts: DeployedContract[]): void {
  Deno.writeTextFileSync(CONTRACTS_FILE, JSON.stringify(contracts, null, 2) + "\n");
}

export function getContractAddress(
  contractName: string,
  networkId: string,
): string | undefined {
  const contracts = loadContracts();
  const entry = contracts.find(
    (c) => c.contractName === contractName && c.networkId === networkId,
  );
  return entry?.contractAddress;
}

export function saveContract(entry: DeployedContract): void {
  const contracts = loadContracts();
  const idx = contracts.findIndex(
    (c) =>
      c.contractName === entry.contractName && c.networkId === entry.networkId,
  );
  if (idx >= 0) {
    contracts[idx] = entry;
  } else {
    contracts.push(entry);
  }
  saveContracts(contracts);
}
