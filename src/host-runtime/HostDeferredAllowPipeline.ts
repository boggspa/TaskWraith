/**
 * Host deferred-allow pipeline (Host Arc Wave 2E-2B Subwave 2 — Lane B).
 *
 * Composes the public synchronous zero-H `verifyCommand` from the resolver with
 * the two-port `HostCommandMutationPipeline` into a single execution path that
 * runs the mutation pipeline exactly once, only on `verified`, with the exact
 * decoded command object verification returned.
 *
 * Never reaches H directly. Never calls `HostDeferredCommandBridge` ports
 * (`completeReceipt`, `publishEffects`). Never imports Authority, AppStore,
 * E, Bridge, bootstrap, composition roots, or envelope/receipt stores
 * directly. Leave the existing resolver, pipeline, coordinator, and stores
 * unedited.
 *
 * Contract (Boss pin host-arc-2e2b-envelope-store-design):
 * - `verifyCommand` (zero H) → verified | indeterminate | already_terminal
 * - On verified: `pipeline.execute(verifiedCommand)` exactly once
 * - Indeterminate / already_terminal return directly; zero H, no second complete
 * - `already_terminal` = done even if envelope still stored
 * - Source idempotencyKey from the durable envelope record (verification step)
 * - Expose only a closed body-free result union
 * - Optionally consume the deferred envelope after terminal completion only
 */

import type { HostCursorPosition } from '../shared/hostProtocol'
import type { HostCommandMutationPipeline } from './HostCommandMutationPipeline'
import type { HostMutationCompletionResult } from './HostMutationCompletionCoordinator'
import type {
  HostDeferredCommandEnvelopeResolverIndeterminateCode,
  HostDeferredCommandEnvelopeResolverInput,
  HostDeferredCommandEnvelopeResolverVerifyResult
} from './HostDeferredCommandEnvelopeResolver'
import type {
  HostCommandReceiptIndeterminateCode,
  HostCommandReceiptStatus,
  HostCommandReceiptTerminalStatus
} from './HostCommandReceiptStore'

/**
 * Closed body-free result union. Never carries command args, tool output,
 * snapshot bodies, actor/target, or unrestricted error prose.
 */
export type HostDeferredAllowPipelineResult =
  | {
      readonly kind: 'completed'
      readonly status: HostCommandReceiptTerminalStatus
      readonly position: HostCursorPosition
      readonly envelope?: 'updated' | 'existing' | 'anomaly'
    }
  | {
      readonly kind: 'indeterminate'
      readonly code:
        | HostDeferredCommandEnvelopeResolverIndeterminateCode
        | HostCommandReceiptIndeterminateCode
      readonly position?: HostCursorPosition
    }
  | {
      readonly kind: 'already_terminal'
      readonly receiptStatus: HostCommandReceiptStatus
    }
  | {
      readonly kind: 'host_unavailable'
    }

/**
 * Optional deferred-envelope consumption after terminal completion.
 * Caller closes over deferredId/actor. Body-free outcomes only.
 */
export type HostDeferredAllowPipelineConsumeEnvelope = () =>
  | { readonly kind: 'updated' }
  | { readonly kind: 'existing' }
  | { readonly kind: 'anomaly' }

export interface HostDeferredAllowPipelineOptions {
  /** Public synchronous zero-H verifyCommand from the resolver. */
  readonly verifyCommand: (
    input: HostDeferredCommandEnvelopeResolverInput
  ) => HostDeferredCommandEnvelopeResolverVerifyResult
  /** Two-port mutation pipeline (observe once → complete once). */
  readonly pipeline: HostCommandMutationPipeline
  /** Optional envelope consumption after terminal completion only. */
  readonly consumeEnvelope?: HostDeferredAllowPipelineConsumeEnvelope
}

function clonePosition(position: HostCursorPosition): HostCursorPosition {
  return { generation: position.generation, cursor: position.cursor }
}

/**
 * Thin orchestrator that composes resolver verification with mutation-pipeline
 * execution. Never reaches H directly and never calls bridge ports.
 */
export class HostDeferredAllowPipeline {
  private readonly verifyCommand: (
    input: HostDeferredCommandEnvelopeResolverInput
  ) => HostDeferredCommandEnvelopeResolverVerifyResult
  private readonly pipeline: HostCommandMutationPipeline
  private readonly consumeEnvelope: HostDeferredAllowPipelineConsumeEnvelope | undefined

  constructor(options: HostDeferredAllowPipelineOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostDeferredAllowPipeline requires options')
    }
    if (typeof options.verifyCommand !== 'function') {
      throw new Error('HostDeferredAllowPipeline requires verifyCommand')
    }
    if (!options.pipeline || typeof options.pipeline !== 'object') {
      throw new Error('HostDeferredAllowPipeline requires pipeline')
    }
    if (typeof options.pipeline.execute !== 'function') {
      throw new Error('HostDeferredAllowPipeline requires pipeline.execute')
    }
    if (options.consumeEnvelope !== undefined && typeof options.consumeEnvelope !== 'function') {
      throw new Error('HostDeferredAllowPipeline consumeEnvelope must be a function')
    }
    this.verifyCommand = options.verifyCommand
    this.pipeline = options.pipeline
    this.consumeEnvelope = options.consumeEnvelope
  }

  /**
   * Verify (zero H, synchronous), then execute through the mutation pipeline
   * exactly once only on `verified`. Indeterminate and already-terminal
   * outcomes return directly. Envelope consumption is attempted only after a
   * durable terminal completion.
   */
  async execute(
    input: HostDeferredCommandEnvelopeResolverInput
  ): Promise<HostDeferredAllowPipelineResult> {
    // Step 1: Verify synchronously — zero H on every path.
    const verified = this.verifyCommand(input)

    if (verified.kind === 'indeterminate') {
      return { kind: 'indeterminate', code: verified.code }
    }
    if (verified.kind === 'already_terminal') {
      return { kind: 'already_terminal', receiptStatus: verified.receiptStatus }
    }

    // Step 2: Execute through the mutation pipeline exactly once.
    const mutationResult: HostMutationCompletionResult = await this.pipeline.execute(
      verified.command
    )

    // Step 3: Map to closed body-free result.
    switch (mutationResult.kind) {
      case 'completed': {
        const position = clonePosition(mutationResult.position)
        // Optionally consume the deferred envelope after terminal completion.
        let envelope: 'updated' | 'existing' | 'anomaly' | undefined = mutationResult.envelope
        if (this.consumeEnvelope) {
          try {
            const consumed = this.consumeEnvelope()
            envelope = consumed.kind
          } catch {
            envelope = 'anomaly'
          }
        }
        return {
          kind: 'completed',
          status: mutationResult.status,
          position,
          ...(envelope !== undefined ? { envelope } : {})
        }
      }
      case 'indeterminate':
        return {
          kind: 'indeterminate',
          code: mutationResult.errorCode,
          position: clonePosition(mutationResult.position)
        }
      case 'host_unavailable':
        return { kind: 'host_unavailable' }
      case 'anomaly':
        return { kind: 'host_unavailable' }
      default: {
        const _exhaustive: never = mutationResult
        void _exhaustive
        return { kind: 'host_unavailable' }
      }
    }
  }
}
