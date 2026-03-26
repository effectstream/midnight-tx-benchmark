/**
 * Error classification for Midnight transactions.
 */

export interface ClassifiedError {
  code: string;
  retryable: boolean;
  message: string;
}

export function classifyError(error: Error): ClassifiedError {
  const msg = error.message.toLowerCase();

  if (msg.includes("mempool") && msg.includes("full")) {
    return { code: "mempool_full", retryable: true, message: "Mempool is full — wait and retry" };
  }
  if (msg.includes("no dust") || msg.includes("insufficient dust")) {
    return { code: "no_dust", retryable: true, message: "No dust available — wait for generation" };
  }
  if (msg.includes("timeout")) {
    return { code: "timeout", retryable: true, message: "Operation timed out" };
  }
  if (msg.includes("ttl") && msg.includes("expired")) {
    return { code: "ttl_expired", retryable: true, message: "Transaction TTL expired" };
  }
  if (msg.includes("proof") && msg.includes("fail")) {
    return { code: "proof_failed", retryable: true, message: "Proof generation failed" };
  }
  if (msg.includes("intentalreadyexists") || msg.includes("intent already exists")) {
    return { code: "duplicate", retryable: false, message: "Transaction already submitted (idempotent)" };
  }
  if (msg.includes("submission error") || msg.includes("submit")) {
    return { code: "submission_error", retryable: true, message: "Transaction submission rejected by node" };
  }
  if (msg.includes("insufficient") || msg.includes("not enough")) {
    return { code: "insufficient_funds", retryable: false, message: "Insufficient funds or dust" };
  }
  if (msg.includes("invalid")) {
    return { code: "invalid_tx", retryable: false, message: "Invalid transaction" };
  }

  return { code: "unknown", retryable: false, message: error.message };
}
