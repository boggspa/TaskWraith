import type {
  NativeWindowCoordinatorRendererObservation,
  NativeWindowCoordinatorRendererStatus
} from '../../../main/nativeWindow/NativeWindowCoordinator'

// Composer still names this field `windowMeta`; it is intentionally derived
// from the coordinator's public renderer observation only.
export type AttachedWindowSnapshot = {
  readonly chatId: string
  readonly generation: number
  readonly windowMeta: NativeWindowCoordinatorRendererObservation['window']
  readonly attachedAt: string
  readonly streaming?: NativeWindowCoordinatorRendererObservation['streaming']
}

export function attachedWindowFromStatus(
  status: NativeWindowCoordinatorRendererStatus
): AttachedWindowSnapshot | null {
  const observation = status.observation
  if (!observation) return null
  return {
    chatId: observation.chatId,
    generation: observation.generation,
    windowMeta: observation.window,
    attachedAt: observation.attachedAt,
    ...(observation.streaming ? { streaming: observation.streaming } : {})
  }
}

export type StickyAppWatchWindowMeta = Pick<
  NativeWindowCoordinatorRendererObservation['window'],
  'title' | 'bundleID' | 'applicationName'
>

export type ResumeAppWatchSnapshot = {
  readonly chatId: string
  readonly windowMeta: StickyAppWatchWindowMeta
  readonly attachedAt: string
  readonly stashedAt: string
  readonly wasStreaming: boolean
}

export function stickyAppWatchStashInput(
  attachment: AttachedWindowSnapshot
): Omit<ResumeAppWatchSnapshot, 'stashedAt'> {
  return {
    chatId: attachment.chatId,
    windowMeta: {
      title: attachment.windowMeta.title,
      bundleID: attachment.windowMeta.bundleID,
      applicationName: attachment.windowMeta.applicationName
    },
    attachedAt: attachment.attachedAt,
    wasStreaming: Boolean(attachment.streaming)
  }
}
