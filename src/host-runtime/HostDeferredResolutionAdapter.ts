/**
 * Host deferred-resolution adapter (Host Arc Scope-4 S4a).
 *
 * Implements `HostDeferredCommandBridgePorts` over `HostDeferredAllowPipeline`
 * so the Bridge stays byte-unchanged while E owns sole-journal publish and
 * receipt completion.
 *
 * Dual-completion seam (ADAPTER-OVER-WIDEN):
 * - `executeCommand` → pipeline exactly once. The pipeline's coordinator
 *   already observes, publishes effects, and completes the receipt at the
 *   sole-journal position (2E-2 pin #2).
 * - `publishEffects` / `completeReceipt` are honest already-owned no-ops.
 *   Bridge still calls them after execute; they must never re-publish or
 *   re-complete what the pipeline owns.
 *
 * Body-free throughout. Indeterminate and already_terminal map to E's
 * non-success executor shape with zero fabricated success and zero second H.
 *
 * Bridge `executeCommand` input omits `idempotencyKey` (durable on the
 * envelope). Composition injects `resolveIdempotencyKey` so this module never
 * imports stores, Authority, Bridge, or composition roots.
 */

import type {
  HostDeferredAllowPipeline,
  HostDeferredAllowPipelineResult
} from './HostDeferredAllowPipeline'
import type {
  HostDeferredCommandBridgePorts,
  HostDeferredCompleteReceiptInput,
  HostDeferredExecuteCommandInput,
  HostDeferredExecutorResult,
  HostDeferredPublishEffectsInput
} from './HostDeferredCommandBridge'
import type { HostDeferredCommandEnvelopeResolverInput } from './HostDeferredCommandEnvelopeResolver'
import type { HostCommandReceiptTerminalStatus } from './HostCommandReceiptStore'

/** Body-free terminal code when the receipt is already terminal (zero re-success). */
export const HOST_DEFERRED_RESOLUTION_ALREADY_TERMINAL_CODE = 'receipt_already_terminal' as const

/** Body-free terminal code when Host substrate is unavailable or the pipeline throws. */
export const HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE = 'host_unavailable' as const

/**
 * Body-free terminal code when the durable idempotencyKey cannot be resolved.
 * Matches the resolver's closed vocabulary so callers never invent a second code set.
 */
export const HOST_DEFERRED_RESOLUTION_KEY_UNAVAILABLE_CODE = 'envelope_not_found' as const

/**
 * Resolve the durable idempotencyKey Bridge ports omit.
 * Return null/undefined/empty to fail closed without calling the pipeline (zero H).
 */
export type HostDeferredResolutionResolveIdempotencyKey = (
  input: HostDeferredExecuteCommandInput
) => string | null | undefined

export interface HostDeferredResolutionAdapterOptions {
  /** Allow-pipeline that verify→execute→complete owns the sole-journal path. */
  readonly pipeline: HostDeferredAllowPipeline
  /** Supply the durable idempotencyKey Bridge execute input does not carry. */
  readonly resolveIdempotencyKey: HostDeferredResolutionResolveIdempotencyKey
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== 'function') {
    throw new Error(`HostDeferredResolutionAdapter requires ${label}`)
  }
}

function mapCompletedStatus(status: HostCommandReceiptTerminalStatus): HostDeferredExecutorResult {
  // effects always empty: coordinator already published; dual-complete forbids re-publish.
  switch (status) {
    case 'succeeded':
      return { status: 'succeeded', terminalCode: 'executed', effects: [] }
    case 'failed':
      return { status: 'failed', terminalCode: 'failed', effects: [] }
    case 'denied':
      // HostDeferredExecutorResult has no denied arm — explicit non-success code only.
      return { status: 'failed', terminalCode: 'denied', effects: [] }
    case 'cancelled':
      return { status: 'cancelled', terminalCode: 'cancelled', effects: [] }
    default: {
      const _exhaustive: never = status
      void _exhaustive
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
      }
    }
  }
}

function mapPipelineResult(result: HostDeferredAllowPipelineResult): HostDeferredExecutorResult {
  switch (result.kind) {
    case 'completed':
      return mapCompletedStatus(result.status)
    case 'indeterminate':
      // Preserve the closed indeterminate code; never fabricate success; zero second H.
      return { status: 'failed', terminalCode: result.code }
    case 'already_terminal':
      // ZERO fabricated success even when the receipt already succeeded.
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_ALREADY_TERMINAL_CODE
      }
    case 'host_unavailable':
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
      }
    default: {
      const _exhaustive: never = result
      void _exhaustive
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
      }
    }
  }
}

function toResolverInput(
  input: HostDeferredExecuteCommandInput,
  idempotencyKey: string
): HostDeferredCommandEnvelopeResolverInput {
  return {
    deferredId: input.deferredId,
    commandId: input.commandId,
    idempotencyKey,
    commandFingerprint: input.commandFingerprint,
    commandName: input.commandName,
    actor: input.actor,
    challengeId: input.challengeId,
    challengeKind: input.challengeKind
  }
}

/**
 * Build Bridge resolve-side ports backed by the AllowPipeline.
 *
 * Production assembly (resolver + mutation pipeline + this adapter) is owned by
 * HostMainComposition (S4c). This factory is pure wiring of the dual-completion
 * seam and does not construct stores or executors.
 */
export function createHostDeferredResolutionAdapter(
  options: HostDeferredResolutionAdapterOptions
): HostDeferredCommandBridgePorts {
  if (!options || typeof options !== 'object') {
    throw new Error('HostDeferredResolutionAdapter requires options')
  }
  if (!options.pipeline || typeof options.pipeline !== 'object') {
    throw new Error('HostDeferredResolutionAdapter requires pipeline')
  }
  requireFunction(options.pipeline.execute, 'pipeline.execute')
  requireFunction(options.resolveIdempotencyKey, 'resolveIdempotencyKey')

  const pipeline = options.pipeline
  const resolveIdempotencyKey = options.resolveIdempotencyKey

  const executeCommand = async (
    input: HostDeferredExecuteCommandInput
  ): Promise<HostDeferredExecutorResult> => {
    let key: string | null | undefined
    try {
      key = resolveIdempotencyKey(input)
    } catch {
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
      }
    }

    if (typeof key !== 'string' || key.length === 0) {
      // Fail closed without reaching the pipeline — zero H.
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_KEY_UNAVAILABLE_CODE
      }
    }

    let result: HostDeferredAllowPipelineResult
    try {
      // Pipeline exactly once: verify + (on verified) mutation observe/complete.
      result = await pipeline.execute(toResolverInput(input, key))
    } catch {
      return {
        status: 'failed',
        terminalCode: HOST_DEFERRED_RESOLUTION_HOST_UNAVAILABLE_CODE
      }
    }

    return mapPipelineResult(result)
  }

  /**
   * Already-owned no-op. The pipeline coordinator published at the sole-journal
   * position; Bridge's post-execute call must not re-publish.
   */
  const publishEffects = async (_input: HostDeferredPublishEffectsInput): Promise<void> => {
    // intentionally empty — dual-completion seam
  }

  /**
   * Already-owned no-op. The pipeline coordinator completed the receipt;
   * Bridge's post-execute call must not re-complete.
   */
  const completeReceipt = async (_input: HostDeferredCompleteReceiptInput): Promise<void> => {
    // intentionally empty — dual-completion seam
  }

  return {
    executeCommand,
    publishEffects,
    completeReceipt
  }
}
