import type { TranscriptMediaRef } from '../store/types'

export interface TrustedRunMediaPayload {
  appChatId: string
  appRunId: string
  mediaRefs: readonly TranscriptMediaRef[]
}

export interface TrustedRunMediaDeliveryOptions {
  appChatId?: string
  appRunId?: string
  mediaRefs: readonly TranscriptMediaRef[]
  inject: (appRunId: string | undefined, refs: readonly TranscriptMediaRef[]) => boolean
  sendForeground?: (payload: TrustedRunMediaPayload) => void
}

export type TrustedRunMediaDeliveryResult = 'empty' | 'injected' | 'foreground' | 'unroutable'

/**
 * Route refs created by main directly to the transcript owner. This path does
 * not sanitize, deduplicate, reorder, or cap: its callers have already built
 * and authorized the refs, including meaningful repeated temporal frames.
 */
export function deliverTrustedRunMediaRefs(
  options: TrustedRunMediaDeliveryOptions
): TrustedRunMediaDeliveryResult {
  const { appChatId, appRunId, mediaRefs, inject, sendForeground } = options
  if (mediaRefs.length === 0) return 'empty'
  if (inject(appRunId, mediaRefs)) return 'injected'
  if (appChatId && appRunId && sendForeground) {
    sendForeground({ appChatId, appRunId, mediaRefs })
    return 'foreground'
  }
  return 'unroutable'
}
