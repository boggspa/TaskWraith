import type { RunQueueJob } from '../store/types'

/**
 * Who a `run-queue-changed` broadcast must reach, and with what.
 *
 * The emitter had exactly one recipient — the main window — while the invoke
 * path (`get-run-queue-jobs`) has always served chat-scoped pop-outs too. So a
 * pop-out learned the queue once, at open, and never again: cancelling or
 * deleting a queued message updated the durable queue and the main window, and
 * the pop-out kept rendering the row it had. Reported as "unable to delete
 * queued messages", because from the pop-out the control genuinely is dead.
 *
 * A naive fan-out is worse than the bug: a pop-out scoped to one chat would
 * receive every chat's queued prompts, which are user request payloads. So the
 * payload is projected PER RECIPIENT, mirroring `scopedChatFilter` in
 * `runQueueHandlers` exactly — main authority sees the whole list, a chat-scoped
 * pop-out sees only its own chat, and a window with neither (the invoke path
 * throws 'Renderer has no run-queue authority' for it) is not a recipient at
 * all rather than a recipient of an empty list.
 *
 * Pure and window-type-agnostic so the projection is testable without Electron.
 */
export interface RunQueueChangedPopout<W> {
  window: W
  /** The pop-out owner's kind; only 'chat' carries run-queue authority. */
  kind: string | undefined
  chatId: string | undefined
}

export interface RunQueueChangedDelivery<W> {
  window: W
  jobs: RunQueueJob[]
}

export function runQueueChangedDeliveries<W>(input: {
  jobs: readonly RunQueueJob[]
  mainWindows: readonly W[]
  popouts: readonly RunQueueChangedPopout<W>[]
}): RunQueueChangedDelivery<W>[] {
  const everything = [...input.jobs]
  const deliveries: RunQueueChangedDelivery<W>[] = input.mainWindows.map((window) => ({
    window,
    jobs: everything
  }))
  for (const popout of input.popouts) {
    if (popout.kind !== 'chat' || !popout.chatId) continue
    const chatId = popout.chatId
    deliveries.push({
      window: popout.window,
      jobs: input.jobs.filter((job) => job.chatId === chatId)
    })
  }
  return deliveries
}
