/**
 * Command mutation pipeline (Wave 2E-2B).
 *
 * Assumes authority has already created the pending command receipt. This
 * adapter composes exactly one observed execution with exactly one completion
 * transition. It does not evaluate authority, mint identities, begin receipts,
 * publish effects directly, or resolve deferred state.
 */

import { HOST_PROTOCOL_MAX_ID, type HostCommand } from '../shared/hostProtocol'
import { isHostUuid, isSafeHostIdentifier } from '../host-shared/HostCommandIdentity'
import type {
  HostMutationCompletionInput,
  HostMutationCompletionResult
} from './HostMutationCompletionCoordinator'
import type { HostObservedMutationResult } from './HostObservedMutationExecutor'

/** Observe one already-decoded Host command. */
export type HostCommandMutationPipelineObserve = (
  command: HostCommand
) => Promise<HostObservedMutationResult>

/** Complete the pending receipt from the single observed mutation result. */
export type HostCommandMutationPipelineComplete = (
  input: HostMutationCompletionInput
) => HostMutationCompletionResult

export interface HostCommandMutationPipelineOptions {
  readonly observe: HostCommandMutationPipelineObserve
  readonly complete: HostCommandMutationPipelineComplete
}

const OBSERVER_THROW_MUTATION: HostObservedMutationResult = Object.freeze({
  kind: 'execution_may_have_begun',
  effects: Object.freeze([]) as readonly [],
  afterCapture: Object.freeze({ status: 'capture_failed' as const })
})

function hasValidCommandId(command: unknown): command is HostCommand {
  if (!command || typeof command !== 'object') return false
  const commandId = (command as { readonly commandId?: unknown }).commandId
  return isSafeHostIdentifier(commandId, HOST_PROTOCOL_MAX_ID) && isHostUuid(commandId)
}

/**
 * Strict two-port adapter: observe once, then complete once. Port failures are
 * never retried and result envelopes never include unrestricted error prose.
 */
export class HostCommandMutationPipeline {
  private readonly observe: HostCommandMutationPipelineObserve
  private readonly complete: HostCommandMutationPipelineComplete

  constructor(options: HostCommandMutationPipelineOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostCommandMutationPipeline requires options')
    }
    if (typeof options.observe !== 'function') {
      throw new Error('HostCommandMutationPipeline requires observe')
    }
    if (typeof options.complete !== 'function') {
      throw new Error('HostCommandMutationPipeline requires complete')
    }
    this.observe = options.observe
    this.complete = options.complete
  }

  /**
   * Run one valid command through observation and completion without decoding
   * or mutating it. The coordinator result is returned unchanged.
   */
  async execute(command: HostCommand): Promise<HostMutationCompletionResult> {
    if (!hasValidCommandId(command)) {
      return { kind: 'anomaly', reason: 'invalid_command_id' }
    }

    let mutation: HostObservedMutationResult
    try {
      mutation = await this.observe(command)
    } catch {
      mutation = OBSERVER_THROW_MUTATION
    }

    try {
      return this.complete({
        commandId: command.commandId,
        mutation
      })
    } catch {
      return { kind: 'host_unavailable' }
    }
  }
}
