/**
 * Benchmark harness — timing, stats, result output.
 */

const BENCHMARKS_DIR = new URL("../benchmarks", import.meta.url).pathname;

export interface TxTiming {
  index: number;
  wallet: string;
  createMs: number;
  balanceMs: number;
  proveMs: number;
  submitMs: number;
  confirmMs: number;
  totalMs: number;
  txHash?: string;
  error?: string;
  errorCode?: string;
}

export interface BenchmarkResult {
  network: string;
  description: string;
  walletCount: number;
  txCount: number;
  successCount: number;
  failCount: number;
  tps: number;
  tpsPerWallet: number;
  timing: {
    avgCreateMs: number;
    avgBalanceMs: number;
    avgProveMs: number;
    avgSubmitMs: number;
    avgConfirmMs: number;
    totalMs: number;
  };
  errors: Record<string, number>;
  transactions: TxTiming[];
  startedAt: string;
  completedAt: string;
}

export async function timedOp<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

export function calculateStats(
  transactions: TxTiming[],
  walletCount: number,
  totalMs: number,
  description: string,
): BenchmarkResult {
  const successful = transactions.filter((t) => !t.error);
  const failed = transactions.filter((t) => !!t.error);

  const errors: Record<string, number> = {};
  for (const t of failed) {
    const code = t.errorCode ?? "unknown";
    errors[code] = (errors[code] ?? 0) + 1;
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const tps = totalMs > 0 ? (successful.length / totalMs) * 1000 : 0;

  return {
    network: Deno.env.get("MIDNIGHT_NETWORK_ID") ?? "unknown",
    description,
    walletCount,
    txCount: transactions.length,
    successCount: successful.length,
    failCount: failed.length,
    tps,
    tpsPerWallet: walletCount > 0 ? tps / walletCount : 0,
    timing: {
      avgCreateMs: avg(successful.map((t) => t.createMs)),
      avgBalanceMs: avg(successful.map((t) => t.balanceMs)),
      avgProveMs: avg(successful.map((t) => t.proveMs)),
      avgSubmitMs: avg(successful.map((t) => t.submitMs)),
      avgConfirmMs: avg(successful.map((t) => t.confirmMs)),
      totalMs,
    },
    errors,
    transactions,
    startedAt: "",
    completedAt: "",
  };
}

export function formatResults(result: BenchmarkResult): string {
  const lines = [
    ``,
    `${"=".repeat(60)}`,
    `  Benchmark Results: ${result.description}`,
    `${"=".repeat(60)}`,
    ``,
    `  Network:      ${result.network}`,
    `  Wallets:      ${result.walletCount}`,
    `  Transactions: ${result.successCount}/${result.txCount} succeeded`,
    ``,
    `  TPS:          ${result.tps.toFixed(3)}`,
    `  TPS/wallet:   ${result.tpsPerWallet.toFixed(3)}`,
    `  Total time:   ${(result.timing.totalMs / 1000).toFixed(1)}s`,
    ``,
    `  Avg create:   ${result.timing.avgCreateMs.toFixed(0)}ms`,
    `  Avg balance:  ${result.timing.avgBalanceMs.toFixed(0)}ms`,
    `  Avg prove:    ${result.timing.avgProveMs.toFixed(0)}ms`,
    `  Avg submit:   ${result.timing.avgSubmitMs.toFixed(0)}ms`,
    `  Avg confirm:  ${result.timing.avgConfirmMs.toFixed(0)}ms`,
  ];

  if (Object.keys(result.errors).length > 0) {
    lines.push(``, `  Errors:`);
    for (const [code, count] of Object.entries(result.errors)) {
      lines.push(`    ${code}: ${count}`);
    }
  }

  lines.push(``, `${"=".repeat(60)}`, ``);
  return lines.join("\n");
}

export function saveBenchResult(result: BenchmarkResult, prefix: string): string {
  try {
    Deno.mkdirSync(BENCHMARKS_DIR, { recursive: true });
  } catch { /* exists */ }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${prefix}-${timestamp}.json`;
  const filepath = `${BENCHMARKS_DIR}/${filename}`;

  const serializer = (_: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v;

  Deno.writeTextFileSync(filepath, JSON.stringify(result, serializer, 2));
  return filepath;
}

/** Wait for a transaction hash to appear in the indexer. */
export async function waitForTxConfirmation(
  indexerUrl: string,
  txHash: string,
  timeoutMs = 300_000,
): Promise<bigint> {
  const query = `query ($id: HexEncoded!) {
    transactions(offset: { identifier: $id }) {
      hash
      block { height }
    }
  }`;

  const normalizedHash = txHash.toLowerCase().replace(/^0x/, "");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(indexerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { id: normalizedHash } }),
      });
      const body = await resp.json() as any;
      const tx = body.data?.transactions?.[0];
      if (tx?.block) {
        return BigInt(tx.block.height);
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Confirmation timeout for ${txHash}`);
}
