/**
 * Claude Agent SDK steering at its structured, full-batch tool boundary.
 *
 * PostToolBatch is emitted exactly once after every tool in a parallel batch
 * has resolved and before Claude's next model request. That makes it the safe
 * place to either stop an armed cooperative-cancel run or add broker steering
 * context. PostToolUse and renderer `tool_result` projections are deliberately
 * outside this module: both can fire once per member of a parallel batch.
 */

import type { RunSession } from '../RunManager'
import { drainPendingSteerTextFromSession, formatSteeringInjection } from './BrokerSteerTransport'

export interface ClaudePostToolBatchToolCall {
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  tool_response?: unknown
}

/** Structural subset of the Agent SDK's PostToolBatchHookInput. */
export interface ClaudePostToolBatchHookInput {
  hook_event_name: 'PostToolBatch'
  tool_calls: ClaudePostToolBatchToolCall[]
  /** Present when the batch belongs to a native Claude subagent. */
  agent_id?: string
  [key: string]: unknown
}

/** Structural subset of AbortSignal used by Agent SDK hook callbacks. */
export interface ClaudePostToolBatchHookOptions {
  signal: Pick<AbortSignal, 'aborted'>
}

/** Structural subset of the Agent SDK's SyncHookJSONOutput. */
export interface ClaudePostToolBatchHookOutput {
  continue?: boolean
  stopReason?: string
  hookSpecificOutput?: {
    hookEventName: 'PostToolBatch'
    additionalContext: string
  }
}

export type ClaudePostToolBatchSteerHook = (
  input: unknown,
  toolUseId: string | undefined,
  options: ClaudePostToolBatchHookOptions
) => Promise<ClaudePostToolBatchHookOutput>

type ClaudeSteerSession = Pick<RunSession, 'liveSteerTransport' | 'pendingSteerText'>

export interface ClaudePostToolBatchRunManager {
  get(runId: string): ClaudeSteerSession | null | undefined
  getInterruptState(runId: string): { killAfterToolResult?: boolean }
}

export interface ClaudeStructuredToolBatchBoundary {
  /** Exact app-run identity captured by the query that owns this hook. */
  runId: string
  /** The SDK-owned full parallel batch, not a renderer projection. */
  input: ClaudePostToolBatchHookInput
  signal: Pick<AbortSignal, 'aborted'>
}

export type ClaudeStructuredBoundaryCallback = (
  boundary: ClaudeStructuredToolBatchBoundary
) => boolean | void | Promise<boolean | void>

export interface ClaudePostToolBatchSteerDeps {
  /** Exact app run that owns the Claude SDK query receiving this hook. */
  runId: string
  runManager: ClaudePostToolBatchRunManager
  /**
   * Interrupt the exact SDK query after its complete tool batch. Returning
   * false explicitly refuses the interrupt; void/true means it was accepted.
   */
  onArmedBoundary: ClaudeStructuredBoundaryCallback
  /** Boundary failures are contained so a later full batch can retry. */
  onBoundaryError?: (error: unknown) => void
}

export const CLAUDE_STEER_BOUNDARY_STOP_REASON =
  'TaskWraith reached the completed tool batch reserved for queued steering.'

const CONTINUE: ClaudePostToolBatchHookOutput = { continue: true }

function asPostToolBatchInput(input: unknown): ClaudePostToolBatchHookInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const candidate = input as Record<string, unknown>
  if (candidate.hook_event_name !== 'PostToolBatch' || !Array.isArray(candidate.tool_calls)) {
    return null
  }
  return candidate as unknown as ClaudePostToolBatchHookInput
}

/**
 * Build the hook registered under `options.hooks.PostToolBatch`.
 *
 * The exact run id is closed over at query construction, so no current/global
 * run lookup can steer a neighbouring Claude session. An armed structured
 * boundary always takes precedence over text injection: its callback may stop
 * the query, in which case `additionalContext` would not be read. Otherwise,
 * draining is the last synchronous side effect before returning the framed
 * context, which is also when BrokerSteerTransport records delivery evidence.
 */
export function createClaudePostToolBatchSteerHook(
  deps: ClaudePostToolBatchSteerDeps
): ClaudePostToolBatchSteerHook {
  const runId = deps.runId.trim()
  if (!runId) throw new Error('Claude PostToolBatch steering requires an exact run id.')

  return async (input, _toolUseId, options): Promise<ClaudePostToolBatchHookOutput> => {
    const batch = asPostToolBatchInput(input)
    if (!batch || options.signal.aborted) return CONTINUE
    // Hooks propagate into native Agent workers. A host steer belongs to the
    // primary seat; draining it into a subagent would create false delivery
    // evidence and leave the primary model unaware of the user's instruction.
    if (typeof batch.agent_id === 'string' && batch.agent_id.trim()) return CONTINUE

    if (deps.runManager.getInterruptState(runId).killAfterToolResult === true) {
      try {
        const accepted = await deps.onArmedBoundary({ runId, input: batch, signal: options.signal })
        if (accepted === false) return CONTINUE
        return {
          continue: false,
          stopReason: CLAUDE_STEER_BOUNDARY_STOP_REASON
        }
      } catch (error) {
        deps.onBoundaryError?.(error)
        return CONTINUE
      }
    }

    const session = deps.runManager.get(runId)
    if (!session) return CONTINUE

    // No awaits or fallible external work may follow this drain. Its receipt
    // callbacks therefore mean the returned context is already committed to
    // this PostToolBatch response, not merely observed in a UI event stream.
    const steerText = drainPendingSteerTextFromSession(session)
    if (!steerText) return CONTINUE
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolBatch',
        additionalContext: formatSteeringInjection(steerText)
      }
    }
  }
}
