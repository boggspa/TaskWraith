import { resolve } from 'node:path'
import {
  isActiveRunSessionStatus,
  isTerminalRunSessionStatus,
  type RunManager,
  type RunSession
} from '../RunManager'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import {
  codexMcpRoutingKey,
  resolveCodexMcpRouteHint,
  type CodexMcpRouteHint
} from './CodexMcpRouting'

type RouteSessions = Pick<RunManager, 'get' | 'getByProviderSession' | 'getClaimedTerminalStatus'>

export interface CodexMcpRouteRecoveryReceipt {
  previousRunId: string
  currentRunId: string
  providerSessionId: string
  toolCallId: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function seatIdentity(session: RunSession): string | null {
  const state = record(session.state)
  if (!state) return null
  const ensemble = state.ensembleRun
  if (ensemble === undefined || ensemble === null) return 'solo'
  const participantId = record(ensemble)?.participantId
  return typeof participantId === 'string' && participantId.trim()
    ? `ensemble:${participantId}`
    : null
}

function sameWorkspace(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (!left.trim() || !right.trim()) return false
  return resolve(left) === resolve(right)
}

/**
 * Codex can retain a loaded thread's MCP child after thread/unsubscribe, so
 * that child's env may name a terminal app run while a resumed turn is live.
 * Recover only with the current native tool-call witness for that exact seat.
 * The original route remains authoritative in every other case.
 */
export function resolveCodexMcpToolRoute(input: {
  route?: AgentRunRoute | null
  toolName: string
  args: unknown
  hints: Map<string, CodexMcpRouteHint>
  sessions: RouteSessions
  nowMs: number
  maxAgeMs: number
  allowsTerminalSession?: (session: RunSession) => boolean
  onRecovery?: (receipt: CodexMcpRouteRecoveryReceipt) => void
}): AgentRunRoute | null {
  const original = input.route || null
  if (!original?.appRunId && !original?.appChatId) {
    // Preserve the existing legacy unbound-bridge fallback. It does not infer
    // a seat from provider order or from whichever task happens to be newest.
    return (
      resolveCodexMcpRouteHint({
        hints: [...input.hints.values()],
        nowMs: input.nowMs,
        toolName: input.toolName,
        args: input.args,
        maxAgeMs: input.maxAgeMs
      }) || original
    )
  }
  if (!original.appRunId) return original

  const previous = input.sessions.get(original.appRunId)
  if (
    !previous ||
    previous.provider !== 'codex' ||
    !isTerminalRunSessionStatus(previous.status) ||
    input.allowsTerminalSession?.(previous) ||
    !previous.providerSessionId ||
    !previous.appChatId ||
    (original.appChatId && original.appChatId !== previous.appChatId)
  )
    return original

  const current = input.sessions.getByProviderSession('codex', previous.providerSessionId)
  const previousSeat = seatIdentity(previous)
  if (
    !current ||
    current.runId === previous.runId ||
    current.provider !== 'codex' ||
    !isActiveRunSessionStatus(current.status) ||
    input.sessions.getClaimedTerminalStatus(current.runId) ||
    !current.sender ||
    current.providerSessionId !== previous.providerSessionId ||
    current.appChatId !== previous.appChatId ||
    !sameWorkspace(previous.workspacePath, current.workspacePath) ||
    previousSeat === null ||
    previousSeat !== seatIdentity(current)
  )
    return original

  const key = codexMcpRoutingKey(input.toolName, input.args)
  const matching = [...input.hints.values()].filter((hint) => {
    const age = input.nowMs - hint.startedAtMs
    return (
      hint.route.appRunId === current.runId &&
      hint.route.appChatId === current.appChatId &&
      age >= 0 &&
      age <= input.maxAgeMs &&
      codexMcpRoutingKey(hint.toolName, hint.args) === key
    )
  })
  if (matching.length !== 1) return original
  const hint = matching[0]
  if (input.hints.get(hint.itemId) !== hint) return original

  // Synchronous, before dispatch: a duplicate stale broker request cannot
  // spend the same native tool-call witness twice. The normal live-context,
  // permission, and approval checks still run on the recovered route.
  input.hints.delete(hint.itemId)
  try {
    input.onRecovery?.({
      previousRunId: previous.runId,
      currentRunId: current.runId,
      providerSessionId: current.providerSessionId,
      toolCallId: hint.itemId
    })
  } catch {
    // Diagnostic failure must not revoke an otherwise valid tool route.
  }
  return { appRunId: current.runId, appChatId: current.appChatId }
}
