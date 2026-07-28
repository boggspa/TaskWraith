import { createHash } from 'node:crypto'

import type {
  CanvasWindowClickAuditClaim,
  CanvasWindowClickAuditClaimRequest
} from '../canvas/CanvasWindowDriverFactory'
import type { RunEventInput, RunEventRecord } from '../store/types'

export interface NativeWindowClickAuditDependencies {
  appendRunEvent(input: RunEventInput, options: { durability: 'strict' }): RunEventRecord | null
}

/**
 * Creates the synchronous durable-intent gate used immediately before a
 * confirmed native click consumes its action budget and enters the bridge.
 *
 * The event contains only opaque run bindings and hashes. AX text, the raw ref,
 * PID, window identity, attachment handle, process birth, and consent epoch are
 * deliberately excluded.
 */
export function createNativeWindowClickAuditClaim(
  dependencies: NativeWindowClickAuditDependencies
): CanvasWindowClickAuditClaim {
  return {
    claim(request): void {
      const event = nativeWindowClickAuditEvent(request)
      try {
        const record = dependencies.appendRunEvent(event, { durability: 'strict' })
        if (!record) throw new Error('strict append returned no record')
      } catch {
        throw new Error('The native click audit claim could not be persisted.')
      }
    }
  }
}

function nativeWindowClickAuditEvent(request: CanvasWindowClickAuditClaimRequest): RunEventInput {
  const chatId = opaqueId(request.scope.chatId, 'chat')
  const runId = opaqueId(request.scope.runId, 'run')
  const launchAttemptId = opaqueId(request.scope.attemptId, 'launch attempt')
  const observationId = opaqueId(request.expectedObservationId, 'observation')
  const ref = opaqueId(request.ref, 'AX reference')
  const attachmentGeneration = positiveInteger(request.scope.generation, 'attachment generation')
  const inputEpoch = nonNegativeInteger(request.inputEpoch, 'input epoch')
  const previewDigest = sha256Digest(request.previewDigest, 'preview digest')

  return {
    runId,
    chatId,
    kind: 'tool',
    phase: 'control',
    source: 'main',
    summary: 'One-use native click confirmation claimed.',
    payload: {
      action: 'native_window_click',
      launchAttemptId,
      attachmentGeneration,
      observationId,
      inputEpoch,
      refSha256: createHash('sha256')
        .update('taskwraith:native-window-click-ref:v1\0')
        .update(ref)
        .digest('hex'),
      previewDigest
    }
  }
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Native click ${label} is invalid.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new Error(`Native click ${label} is invalid.`)
  }
  return normalized
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Native click ${label} is invalid.`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Native click ${label} is invalid.`)
  }
  return Number(value)
}

function sha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Native click ${label} is invalid.`)
  }
  return value
}
