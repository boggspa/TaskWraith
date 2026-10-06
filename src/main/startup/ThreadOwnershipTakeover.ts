/**
 * Explicit, per-thread takeover of a pending recovery hold by this desktop.
 *
 * A desktop that starts does not pre-empt anything: every unrelated thread
 * keeps its hold. Only a deliberate request names one thread, and the Host
 * checks the request comes from the registered desktop writer over the
 * authenticated maintenance channel. A hold it took over may let the thread's
 * claim through, so activation is asked again for that one thread; the
 * coordinator still requires the head's exact Host publication.
 */
import type { ThreadCatalogueTakeoverOutcome } from '../../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import type { ThreadCatalogueMaintenanceQuery } from '../../shared/threadCatalogueProtocol'
import type { ThreadOwnershipActivationTrigger } from '../host/ThreadOwnershipActivationSupplier'
import type { ThreadOwnershipActivationResult } from '../services/ThreadOwnershipActivationCoordinator'

export interface ThreadRecoveryTakeoverResult {
  readonly takeover: ThreadCatalogueTakeoverOutcome
  /** Null when activation is not composed or was not asked again. */
  readonly activation: ThreadOwnershipActivationResult | null
}

export function createThreadRecoveryTakeover(options: {
  maintain<T>(query: ThreadCatalogueMaintenanceQuery): Promise<T>
  writerId(): string
  trigger(): Pick<ThreadOwnershipActivationTrigger, 'retry'> | null
}): (chatId: string) => Promise<ThreadRecoveryTakeoverResult> {
  return async (chatId) => {
    const takeover = await options.maintain<ThreadCatalogueTakeoverOutcome>({
      method: 'takeover-recovery',
      chatId,
      desktopWriterId: options.writerId()
    })
    if (takeover.kind !== 'taken' && takeover.kind !== 'none') {
      return { takeover, activation: null }
    }
    const trigger = options.trigger()
    return { takeover, activation: trigger ? await trigger.retry(chatId) : null }
  }
}
