/**
 * Sealing a run's tool capability receipt on every terminal path.
 *
 * A receipt is created when a provider run starts, and until it is settled it
 * reads as "this run's tool lifecycle is still open". Three AntiGravity paths
 * ended a run without sealing one: a cleanup step that rejects, a setup failure
 * that returns before the transport starts, and a transport that throws before
 * its close handler is wired. On all three, `approval_status` reported a dead
 * run as though its tools were still resolving.
 *
 * These helpers live outside the composition root so the sealing semantics are
 * testable without an Electron main harness, and so each terminal path costs
 * one call rather than another layer of inline try/finally nesting.
 *
 * Sealing is evidence only. It never changes a permission decision, and a
 * reporting failure must never mask or replace the error that ended the run.
 */
export interface SealableRunToolReceipt {
  settle: () => void
}

/**
 * Seal the receipt for a run that is over. Safe to call on a run that never
 * created one, and safe to call more than once: the reporter's own `settle` is
 * idempotent, and a throwing reporter is swallowed rather than propagated.
 */
export function sealRunToolReceipt(receipt: SealableRunToolReceipt | null | undefined): void {
  try {
    receipt?.settle()
  } catch {
    /* Reporting cannot change run authority, nor hide how the run actually ended. */
  }
}

/**
 * Run a run's cleanup work and seal its receipt afterwards, whether or not that
 * cleanup succeeded. The cleanup's own rejection still propagates unchanged, so
 * callers keep the failure they would have seen before.
 */
export async function sealRunToolReceiptAfter<T>(
  receipt: SealableRunToolReceipt | null | undefined,
  cleanup: () => Promise<T> | T
): Promise<T> {
  try {
    return await cleanup()
  } finally {
    sealRunToolReceipt(receipt)
  }
}
