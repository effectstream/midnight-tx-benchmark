#!/usr/bin/env -S deno run -A --unstable-detect-cjs
/**
 * Midnight TX Batcher CLI
 *
 * Usage: MIDNIGHT_NETWORK_ID=<network> deno task cli bench <command>
 */

import { requireNetworkId } from "./config.ts";

requireNetworkId();

const [group, command, ...rest] = Deno.args;

if (group !== "bench" || !command) {
  console.log("Usage: deno task cli bench <command>\n");
  console.log("Commands:");
  console.log("  create-wallets    Create w1-w10 + xw1-xw10");
  console.log("  fund-from-genesis [amount]  Genesis sends to w1 (default: 100T)");
  console.log("  fund-from-w1      [amount]  w1 sends to w2-w10 (default: 10T)");
  console.log("  fund-round2       [amount]  Genesis sends to each w1-w10 (default: 10T)");
  console.log("  delegate          Self-delegate all w1-w10 for dust generation");
  console.log("  balance           Show tokens + UTXOs + dust per wallet");
  console.log("  deploy            Deploy round-value contract (if needed)");
  console.log("  run-4e            Simplest: 1 wallet, 1 TX self-transfer");
  console.log("  run-4f            Single delegated: 1 xw creates TX, 1 w balances+submits");
  console.log("  run-4a            Sequential 1-TX per wallet");
  console.log("  run-4b            Parallel 2-TX per wallet");
  console.log("  run-4c            Delegated 1-TX (xw creates, w balances)");
  console.log("  run-4d            Delegated 2-TX with speculative chaining");
  console.log("  run-4g            Sequential contract calls (add_entry, 10 wallets)");
  console.log("  report            Comparison table of all benchmark results");
  Deno.exit(1);
}

const optionalAmount = rest[0] ? BigInt(rest[0]) : undefined;

const commands: Record<string, () => Promise<void>> = {
  "create-wallets": async () => { const { benchCreateWallets } = await import("./commands/bench.ts"); await benchCreateWallets(); },
  "fund-from-genesis": async () => { const { benchFundFromGenesis } = await import("./commands/bench.ts"); await benchFundFromGenesis(optionalAmount); },
  "fund-from-w1": async () => { const { benchFundFromW1 } = await import("./commands/bench.ts"); await benchFundFromW1(optionalAmount); },
  "fund-round2": async () => { const { benchFundRound2 } = await import("./commands/bench.ts"); await benchFundRound2(optionalAmount); },
  "delegate": async () => { const { benchDelegate } = await import("./commands/bench.ts"); await benchDelegate(); },
  "balance": async () => { const { benchBalance } = await import("./commands/bench.ts"); await benchBalance(); },
  "deploy": async () => { const { benchDeploy } = await import("./commands/bench.ts"); await benchDeploy(); },
  "run-4a": async () => { const { benchRun4a } = await import("./commands/bench.ts"); await benchRun4a(); },
  "run-4b": async () => { const { benchRun4b } = await import("./commands/bench.ts"); await benchRun4b(); },
  "run-4c": async () => { const { benchRun4c } = await import("./commands/bench.ts"); await benchRun4c(); },
  "run-4d": async () => { const { benchRun4d } = await import("./commands/bench.ts"); await benchRun4d(); },
  "run-4e": async () => { const { benchRun4e } = await import("./commands/bench.ts"); await benchRun4e(); },
  "run-4f": async () => { const { benchRun4f } = await import("./commands/bench.ts"); await benchRun4f(); },
  "run-4g": async () => { const { benchRun4g } = await import("./commands/bench.ts"); await benchRun4g(); },
  "report": async () => { const { benchReport } = await import("./commands/bench.ts"); benchReport(); },
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: bench ${command}`);
  Deno.exit(1);
}

await handler();
