/**
 * Wallet storage — JSON file backed CRUD for wallet seeds/mnemonics.
 */

const WALLETS_FILE = new URL("../wallets.json", import.meta.url).pathname;

export interface StoredWallet {
  name: string;
  mnemonic: string;
  seed: string;
  createdAt: string;
}

export function loadWallets(): StoredWallet[] {
  try {
    const data = Deno.readTextFileSync(WALLETS_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export function saveWallets(wallets: StoredWallet[]): void {
  Deno.writeTextFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2) + "\n");
}

export function findWallet(name: string): StoredWallet | undefined {
  return loadWallets().find((w) => w.name === name);
}

export function requireWallet(name: string): StoredWallet {
  const w = findWallet(name);
  if (!w) {
    console.error(`Wallet "${name}" not found. Run: cli bench create-wallets`);
    Deno.exit(1);
  }
  return w;
}

export function addWallet(wallet: StoredWallet): void {
  const wallets = loadWallets();
  if (wallets.find((w) => w.name === wallet.name)) {
    throw new Error(`Wallet "${wallet.name}" already exists.`);
  }
  if (wallets.find((w) => w.seed === wallet.seed)) {
    throw new Error("A wallet with this seed already exists.");
  }
  wallets.push(wallet);
  saveWallets(wallets);
}
