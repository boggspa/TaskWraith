// Map an MSP approval request onto TaskWraith's approval orchestration inputs.
//
// Pure module — no Electron, no orchestrator import — so the mapping is unit
// testable and the bridge stays Electron-free. The orchestrator call itself is
// built in the composition root and injected, because it closes over the run
// manager, the permission service and a WebContents sender.

import type { AgenticServiceId } from '../store/types'
import type { MuseMspApprovalRequest, MuseMspApprovalSubject } from './MuseMspProtocol'

export interface MuseMspApprovalAsk {
  readonly service: AgenticServiceId
  /** Ledger `kind` and timeout key; mirrors `kimi/${toolKind}`. */
  readonly method: string
  readonly title: string
  readonly body: string
  readonly toolName: string
  /**
   * `rawArgs` parsed. MSP sends model-authored argument JSON as a STRING, and
   * every ACP provider hands the orchestrator an already-parsed object, so the
   * parse happens here — failing to null rather than throwing, because a
   * malformed argument blob must still reach a human as an approval card.
   */
  readonly rawToolCall: Record<string, unknown> | null
}

/**
 * MSP approval subject -> agentic service.
 *
 * The MSP schema documents `ApprovalSubject.kind` as an OPEN discriminator with
 * five known values — `shell | fileAccess | network | process | tool` — and
 * says unknown kinds "are rendered generically and never auto-approved by
 * clients". All five are mapped explicitly below; the fallthrough exists for
 * the sixth Muse invents.
 *
 * The default is `shellCommands`, the most heavily gated service, so an
 * unrecognised subject is over-gated rather than waved through. Note that
 * over-gating is not free in one direction: bucketing a generic `tool` under
 * `shellCommands` would mean a session grant on shell commands silently
 * covered every native Muse tool, which is why `tool` is mapped to `mcpTools`
 * rather than left to the default.
 *
 * There is no read-only or network service in `AgenticServiceId`, so a file
 * subject maps to `fileChanges` whatever its `access` says — Muse only raises
 * an approval for a file it considers consequential, and the orchestrator's own
 * read-only/workspace-inspection fast path is what keeps genuine reads cheap.
 */
export function museMspSubjectToService(
  subject: MuseMspApprovalSubject | null | undefined,
  toolName?: string
): AgenticServiceId {
  const kind = (subject?.kind || '').trim().toLowerCase()
  switch (kind) {
    case 'file':
    case 'fileaccess':
    case 'filewrite':
    case 'write':
    case 'edit':
      return 'fileChanges'
    case 'network':
    case 'fetch':
    case 'web':
    // A generic native Muse tool. `mcpTools` is the bucket every other
    // provider's tool calls land in; leaving it to the shellCommands default
    // would let a shell grant cover it.
    case 'tool':
      return 'mcpTools'
    case 'shell':
    case 'command':
    case 'process':
    case 'execute':
      return 'shellCommands'
    default:
      break
  }
  // Fall back to the tool name before the default: an unrecognised subject on a
  // clearly-named fetch/search tool is still not a shell command.
  const named = (toolName || subject?.toolName || '').trim().toLowerCase()
  if (named === 'fetch' || named === 'search' || named === 'web_search') return 'mcpTools'
  return 'shellCommands'
}

function parseRawArgs(rawArgs: unknown): Record<string, unknown> | null {
  if (typeof rawArgs !== 'string' || !rawArgs.trim()) return null
  try {
    const parsed = JSON.parse(rawArgs) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Human-facing summary of what Muse is asking to do. */
function describeSubject(subject: MuseMspApprovalSubject | null | undefined): string {
  if (!subject) return ''
  if (subject.command) return subject.command
  if (subject.path) {
    const access = (subject.access || '').trim()
    return access ? `${access} ${subject.path}` : subject.path
  }
  if (subject.host) return subject.port ? `${subject.host}:${subject.port}` : subject.host
  if (subject.target) return subject.target
  return ''
}

export function describeMuseMspApproval(request: MuseMspApprovalRequest): MuseMspApprovalAsk {
  const subject = request?.subject
  const toolName = (request?.toolName || subject?.toolName || 'tool').trim() || 'tool'
  const service = museMspSubjectToService(subject, toolName)
  const detail = describeSubject(subject)
  const escalated = request?.judgeEscalated ? ' (escalated by Muse)' : ''
  const protectedWrite = request?.protectedWrite ? ' (protected write)' : ''
  return {
    service,
    method: `muse/${(subject?.kind || 'tool').trim() || 'tool'}`,
    title: `Muse wants to run ${toolName}${protectedWrite}`,
    body: detail ? `${detail}${escalated}` : `${toolName}${escalated}`,
    toolName,
    rawToolCall: parseRawArgs(request?.rawArgs)
  }
}
