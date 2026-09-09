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
 * Run every cleanup step, then seal, then rethrow the first failure.
 *
 * A step that rejects must not skip the steps after it. The agy lane drains its
 * transcript monitor and then releases the permission lease, and that lease is
 * what restores the user's temporary agy settings overlay — so a drain failure
 * silently leaving the overlay in place is a worse outcome than the drain
 * failure itself. Sealing still happens whatever the steps do, and the caller
 * still sees the first error, so the run fails exactly as it did before.
 */
export async function sealRunToolReceiptAfterCleanup(
  receipt: SealableRunToolReceipt | null | undefined,
  steps: ReadonlyArray<() => Promise<unknown> | unknown>
): Promise<void> {
  let failure: { error: unknown } | null = null
  try {
    for (const step of steps) {
      try {
        await step()
      } catch (error) {
        failure = failure ?? { error }
      }
    }
  } finally {
    sealRunToolReceipt(receipt)
  }
  if (failure) throw failure.error
}
