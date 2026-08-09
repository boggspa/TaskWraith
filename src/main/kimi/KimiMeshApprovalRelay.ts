import { createHash } from 'node:crypto'

type JsonRecord = Record<string, unknown>

export interface KimiMeshApprovalRelayIssue {
  appRunId?: string
  appChatId?: string
  toolName: string
  arguments: Record<string, unknown>
}

export interface KimiMeshApprovalRelayConsume {
  appRunId?: string
  appChatId?: string
  toolName: string
  arguments: Record<string, unknown>
}

interface PendingRelay {
  routeKey: string
  toolName: string
  argumentDigest: string
  expiresAt: number
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!isRecord(value)) return value
  const result: JsonRecord = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalJsonValue(value[key])
  }
  return result
}

function argumentDigest(toolName: string, args: JsonRecord): string | null {
  try {
    const serialized = JSON.stringify([toolName, canonicalJsonValue(args)])
    if (Buffer.byteLength(serialized, 'utf8') > 96 * 1024) return null
    return createHash('sha256').update(serialized).digest('hex')
  } catch {
    return null
  }
}

function routeKey(appRunId?: string, appChatId?: string): string | null {
  const runId = typeof appRunId === 'string' ? appRunId.trim() : ''
  const chatId = typeof appChatId === 'string' ? appChatId.trim() : ''
  return runId && chatId ? `${runId}\u0000${chatId}` : null
}

export function kimiMeshArgumentsFromAcpToolCall(
  toolName: string,
  rawToolCall: unknown
): JsonRecord | null {
  if (!isRecord(rawToolCall) || !isRecord(rawToolCall.rawInput)) return null
  const rawInput = rawToolCall.rawInput
  if (isRecord(rawInput.arguments)) {
    const normalized = canonicalJsonValue(rawInput.arguments)
    return isRecord(normalized) ? normalized : null
  }
  const args: JsonRecord = {}
  for (const [key, value] of Object.entries(rawInput)) {
    if (key === 'tool_name') continue
    if (
      key === 'name' &&
      typeof value === 'string' &&
      (value === toolName || value.toLowerCase() === `mcp__taskwraith__${toolName}`)
    ) {
      continue
    }
    args[key] = value
  }
  const normalized = canonicalJsonValue(args)
  return isRecord(normalized) ? normalized : null
}

/**
 * Relays one exact human/policy decision from Kimi's ACP transport gate to the
 * authenticated HTTP MCP call that immediately follows it. The receipt is
 * route-bound, argument-hashed, short-lived, and consumed once; only the digest
 * is retained. This prevents a second Mesh approval card without treating
 * model-controlled ACP labels as execution authority.
 */
export class KimiMeshApprovalRelay {
  private readonly pending: PendingRelay[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000,
    private readonly maxPending = 64
  ) {}

  issue(input: KimiMeshApprovalRelayIssue): boolean {
    const key = routeKey(input.appRunId, input.appChatId)
    const digest = argumentDigest(input.toolName, input.arguments)
    if (!key || !digest) return false
    this.prune()
    this.pending.push({
      routeKey: key,
      toolName: input.toolName,
      argumentDigest: digest,
      expiresAt: this.now() + this.ttlMs
    })
    if (this.pending.length > this.maxPending) {
      this.pending.splice(0, this.pending.length - this.maxPending)
    }
    return true
  }

  consume(input: KimiMeshApprovalRelayConsume): boolean {
    const key = routeKey(input.appRunId, input.appChatId)
    const digest = argumentDigest(input.toolName, input.arguments)
    if (!key || !digest) return false
    this.prune()
    const index = this.pending.findIndex(
      (entry) =>
        entry.routeKey === key &&
        entry.toolName === input.toolName &&
        entry.argumentDigest === digest
    )
    if (index < 0) return false
    this.pending.splice(index, 1)
    return true
  }

  private prune(): void {
    const now = this.now()
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index].expiresAt <= now) this.pending.splice(index, 1)
    }
  }
}
