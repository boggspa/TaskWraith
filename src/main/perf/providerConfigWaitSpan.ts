/**
 * provider_config_wait span (Independent Threads Programme M1 A1.1 #3).
 *
 * Start when a run must wait for a shared provider configuration resource
 * (Codex app-server lifecycle / Cursor workspace overlay); end when that wait
 * settles — admitted, aborted, or failed. Compatible immediate joins emit
 * nothing. A missing sink or chatId is a no-op. A throwing sink loses the
 * measurement, never the acquisition.
 */

import type { WorkSpanAttrs, WorkSpanEnd } from './WorkSpanRecorder'

export type ProviderConfigWaitSink = {
  begin(attrs: WorkSpanAttrs): WorkSpanEnd
}

export type ProviderConfigWaitReason =
  | 'cold_start'
  | 'cohort_drain'
  | 'runtime_or_credential_domain'
  | 'registration_change'

export type ProviderConfigWaitResource = 'codex_daemon' | 'cursor_overlay'

export interface ProviderConfigWaitBegin {
  readonly chatId?: string
  readonly runId?: string
  readonly participantId?: string
  readonly laneId?: string
  readonly resource: ProviderConfigWaitResource
  readonly reason: ProviderConfigWaitReason
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

const noop: WorkSpanEnd = () => undefined

/**
 * Begin a provider_config_wait span. Always returns an idempotent end handle
 * that never throws, so callers can `finally` it around an await.
 */
export function beginProviderConfigWait(
  sink: ProviderConfigWaitSink | undefined,
  attrs: ProviderConfigWaitBegin
): WorkSpanEnd {
  if (!sink || typeof sink.begin !== 'function') return noop
  if (!isNonEmptyString(attrs.chatId)) return noop
  let end: WorkSpanEnd
  try {
    end = sink.begin({
      chatId: attrs.chatId.trim(),
      kind: 'provider_config_wait',
      resource: attrs.resource,
      reason: attrs.reason,
      ...(isNonEmptyString(attrs.runId) ? { runId: attrs.runId.trim() } : {}),
      ...(isNonEmptyString(attrs.participantId)
        ? { participantId: attrs.participantId.trim() }
        : {}),
      ...(isNonEmptyString(attrs.laneId) ? { laneId: attrs.laneId.trim() } : {})
    })
  } catch {
    return noop
  }
  if (typeof end !== 'function') return noop
  let finished = false
  return (options) => {
    if (finished) return
    finished = true
    try {
      end(options)
    } catch {
      // Instrumentation must never alter acquisition or overlay admission.
    }
  }
}
