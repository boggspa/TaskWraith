import type { ThreadCatalogueQuery } from './threadCatalogueTypes'

export type ThreadCatalogueReadQuery = Exclude<
  ThreadCatalogueQuery,
  {
    method:
      | 'repair-source'
      | 'changed'
      | 'owner'
      | 'erase'
      | 'finish-erasure'
      | 'prepare'
      | 'prepared'
      | 'discard-prepared'
      | 'begin-recovery'
      | 'end-recovery'
      | 'adopt-prepared'
  }
>
export const THREAD_CATALOGUE_WIRE_MAX_BYTES = 2 * 1024 * 1024 + 65_536
export type ThreadCatalogueMaintenanceQuery = Extract<
  ThreadCatalogueQuery,
  {
    method:
      | 'repair-source'
      | 'owner'
      | 'changed'
      | 'erase'
      | 'finish-erasure'
      | 'prepare'
      | 'prepared'
      | 'discard-prepared'
      | 'begin-recovery'
      | 'end-recovery'
      | 'adopt-prepared'
  }
>

const safeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  value !== '.' &&
  value !== '..' &&
  !/[/\\\0]/.test(value)
const token = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
const kinds = new Set([
  'control',
  'introspection',
  'remote',
  'people-donor',
  'message',
  'run',
  'run-summary',
  'shell',
  'recovery',
  'record'
])

export function decodeThreadCatalogueMaintenanceQuery(
  value: unknown
): ThreadCatalogueMaintenanceQuery | null {
  if (!value || typeof value !== 'object') return null
  const q = value as Record<string, unknown>
  if (q.method === 'repair-source' && safeId(q.chatId))
    return { method: 'repair-source', chatId: q.chatId }
  if (q.method === 'begin-recovery' && safeId(q.chatId) && safeId(q.desktopWriterId))
    return { method: 'begin-recovery', chatId: q.chatId, desktopWriterId: q.desktopWriterId }
  if (q.method === 'end-recovery' && safeId(q.chatId) && safeId(q.recoveryToken))
    return { method: 'end-recovery', chatId: q.chatId, recoveryToken: q.recoveryToken }
  if (
    q.method === 'adopt-prepared' &&
    safeId(q.chatId) &&
    safeId(q.recoveryToken) &&
    safeId(q.preparedId)
  )
    return {
      method: 'adopt-prepared',
      chatId: q.chatId,
      recoveryToken: q.recoveryToken,
      preparedId: q.preparedId
    }
  if ((q.method === 'prepared' || q.method === 'discard-prepared') && safeId(q.preparedId))
    return { method: q.method, preparedId: q.preparedId }
  if (
    q.method === 'prepare' &&
    safeId(q.chatId) &&
    safeId(q.recoveryToken) &&
    typeof q.sourceWitness === 'string' &&
    /^[a-f0-9]{64}$/.test(q.sourceWitness)
  ) {
    const m = q.mutation as Record<string, unknown> | undefined
    if (!m) return null
    const base = {
      method: 'prepare' as const,
      chatId: q.chatId,
      recoveryToken: q.recoveryToken,
      sourceWitness: q.sourceWitness
    }
    if (m.kind === 'prune-blackboard' && typeof m.atMs === 'number' && Number.isFinite(m.atMs))
      return { ...base, mutation: { kind: 'prune-blackboard', atMs: m.atMs } }
    if (
      (m.kind === 'recover-worker-control' || m.kind === 'repair-title') &&
      typeof m.at === 'string' &&
      m.at.length <= 64 &&
      Number.isFinite(Date.parse(m.at))
    )
      return { ...base, mutation: { kind: m.kind, at: m.at } }
    if (
      m.kind === 'expire-wakeup' &&
      ['solo', 'ensemble'].includes(String(m.family)) &&
      token(m.wakeupId) &&
      typeof m.expectedWakeAt === 'string' &&
      m.expectedWakeAt.length <= 64 &&
      typeof m.expiredAt === 'string' &&
      m.expiredAt.length <= 64 &&
      Number.isFinite(Date.parse(m.expiredAt))
    )
      return {
        ...base,
        mutation: {
          kind: 'expire-wakeup',
          family: m.family as 'solo' | 'ensemble',
          wakeupId: m.wakeupId,
          expectedWakeAt: m.expectedWakeAt,
          expiredAt: m.expiredAt
        }
      }
    if (
      m.kind === 'settle-runs' &&
      typeof m.nowIso === 'string' &&
      m.nowIso.length <= 64 &&
      Number.isFinite(Date.parse(m.nowIso)) &&
      typeof m.minAgeMs === 'number' &&
      Number.isFinite(m.minAgeMs) &&
      m.minAgeMs >= 0 &&
      Array.isArray(m.runs) &&
      m.runs.length <= 1000
    ) {
      const runs: Array<{
        runId: string
        session?: {
          runId: string
          appChatId?: string
          provider?: string
          status?: string
          updatedAt: number
        }
      }> = []
      for (const item of m.runs) {
        if (!item || typeof item !== 'object' || !token(item.runId)) return null
        if (!item.session) {
          runs.push({ runId: item.runId })
          continue
        }
        const s = item.session
        if (
          s.runId !== item.runId ||
          typeof s.updatedAt !== 'number' ||
          !Number.isFinite(s.updatedAt)
        )
          return null
        for (const key of ['appChatId', 'provider', 'status'])
          if (s[key] !== undefined && !token(s[key])) return null
        runs.push({
          runId: item.runId,
          session: {
            runId: item.runId,
            updatedAt: s.updatedAt,
            ...(s.appChatId === undefined ? {} : { appChatId: s.appChatId }),
            ...(s.provider === undefined ? {} : { provider: s.provider }),
            ...(s.status === undefined ? {} : { status: s.status })
          }
        })
      }
      return {
        ...base,
        mutation: { kind: 'settle-runs', nowIso: m.nowIso, minAgeMs: m.minAgeMs, runs }
      }
    }
    return null
  }
  if (q.method === 'owner') {
    const o = q.owner as Record<string, unknown> | undefined
    return o?.writer === 'desktop' &&
      safeId(o.writerId) &&
      (o.pid === undefined || (Number.isSafeInteger(o.pid) && Number(o.pid) > 1))
      ? {
          method: 'owner',
          owner: {
            writer: 'desktop',
            writerId: o.writerId,
            ...(o.pid === undefined ? {} : { pid: Number(o.pid) })
          }
        }
      : null
  }
  if (q.method === 'changed' && safeId(q.chatId)) return { method: 'changed', chatId: q.chatId }
  if (
    (q.method === 'erase' || q.method === 'finish-erasure') &&
    (q.chatId === undefined || safeId(q.chatId))
  ) {
    const scope = q.chatId === undefined ? {} : { chatId: q.chatId as string }
    if (q.method === 'erase') return { method: 'erase', ...scope }
    if (safeId(q.generation))
      return { method: 'finish-erasure', generation: q.generation, ...scope }
  }
  return null
}

/** Read-only request allowlist; maintenance/ownership never travels over this surface. */
export function decodeThreadCatalogueReadQuery(value: unknown): ThreadCatalogueReadQuery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const q = value as Record<string, unknown>
  if (q.method === 'introspection') {
    const window = q.window as Record<string, unknown> | undefined
    const after = q.after as Record<string, unknown> | undefined
    if (
      !window ||
      typeof window.windowStart !== 'string' ||
      window.windowStart.length > 64 ||
      !Number.isFinite(Date.parse(window.windowStart)) ||
      typeof window.windowEnd !== 'string' ||
      window.windowEnd.length > 64 ||
      !Number.isFinite(Date.parse(window.windowEnd)) ||
      (window.workspaceId !== undefined && !token(window.workspaceId)) ||
      (after !== undefined && (!after || !safeId(after.chatId) || !integer(after.ordinal)))
    )
      return null
    return {
      method: 'introspection',
      window: {
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        ...(window.workspaceId === undefined ? {} : { workspaceId: String(window.workspaceId) })
      },
      ...(after ? { after: { chatId: String(after.chatId), ordinal: Number(after.ordinal) } } : {})
    }
  }
  if (q.method === 'message-activity') {
    const request = q.request as Record<string, unknown> | undefined
    const after = q.after as Record<string, unknown> | undefined
    if (
      !request ||
      !Number.isFinite(request.resetAt) ||
      !Number.isFinite(request.rangeStart) ||
      (after !== undefined &&
        (!after ||
          !safeId(after.chatId) ||
          typeof after.dayKey !== 'string' ||
          after.dayKey.length > 32))
    )
      return null
    return {
      method: 'message-activity',
      request: { resetAt: Number(request.resetAt), rangeStart: Number(request.rangeStart) },
      ...(after ? { after: { chatId: String(after.chatId), dayKey: String(after.dayKey) } } : {})
    }
  }
  if (
    q.method === 'host-runs' &&
    (q.offset === undefined || (integer(q.offset) && q.offset <= 1800))
  )
    return {
      method: 'host-runs',
      ...(q.offset === undefined ? {} : { offset: q.offset as number })
    }
  if (
    q.method === 'page-runs' &&
    token(q.leaseId) &&
    integer(q.start) &&
    integer(q.end) &&
    (q.maximum === undefined || integer(q.maximum))
  )
    return {
      method: 'page-runs',
      leaseId: q.leaseId,
      start: q.start,
      end: q.end,
      ...(q.maximum === undefined ? {} : { maximum: q.maximum as number })
    }
  if (q.method === 'ordinal' && token(q.leaseId) && token(q.recordId) && kinds.has(String(q.kind)))
    return {
      method: 'ordinal',
      leaseId: q.leaseId,
      recordId: q.recordId,
      kind: q.kind as 'run-summary'
    }
  if (q.method === 'changes') {
    const p = q.position as Record<string, unknown> | undefined
    if (p !== undefined && (!p || !token(p.incarnation) || !integer(p.sequence))) return null
    return {
      method: 'changes',
      ...(p
        ? { position: { incarnation: p.incarnation as string, sequence: p.sequence as number } }
        : {})
    }
  }
  if (q.method === 'list') {
    if (q.workspaceId !== undefined && !token(q.workspaceId)) return null
    if (q.parentChatId !== undefined && !safeId(q.parentChatId)) return null
    if (q.limit !== undefined && (!integer(q.limit) || q.limit > 100)) return null
    const before = q.before as { updatedAt?: unknown; chatId?: unknown } | undefined
    if (
      before &&
      (typeof before.updatedAt !== 'number' ||
        !Number.isFinite(before.updatedAt) ||
        !safeId(before.chatId))
    )
      return null
    return {
      method: 'list',
      ...(q.workspaceId === undefined ? {} : { workspaceId: q.workspaceId as string }),
      ...(q.parentChatId === undefined ? {} : { parentChatId: q.parentChatId as string }),
      ...(q.limit === undefined ? {} : { limit: q.limit as number }),
      ...(before
        ? { before: { updatedAt: before.updatedAt as number, chatId: before.chatId as string } }
        : {})
    }
  }
  if (q.method === 'summary' && safeId(q.chatId)) return { method: 'summary', chatId: q.chatId }
  if ((q.method === 'run' || q.method === 'known-run') && token(q.runId))
    return { method: q.method, runId: q.runId }
  if (
    q.method === 'open' &&
    safeId(q.chatId) &&
    ['metadata', 'pages', 'record', 'runs', 'remote', 'control'].includes(String(q.mode)) &&
    (q.projectionOptions === undefined ||
      (typeof q.projectionOptions === 'string' && q.projectionOptions.length <= 256 * 1024)) &&
    (q.readContext === undefined ||
      (q.readContext &&
        typeof q.readContext === 'object' &&
        token((q.readContext as Record<string, unknown>).runtimeInstanceId) &&
        ((q.readContext as Record<string, unknown>).defaultProvider === undefined ||
          token((q.readContext as Record<string, unknown>).defaultProvider))))
  )
    return {
      method: 'open',
      chatId: q.chatId,
      mode: q.mode as 'metadata' | 'pages' | 'record' | 'runs' | 'remote' | 'control',
      ...(q.projectionOptions === undefined
        ? {}
        : { projectionOptions: q.projectionOptions as string }),
      ...(q.readContext === undefined
        ? {}
        : {
            readContext: {
              runtimeInstanceId: (q.readContext as { runtimeInstanceId: string }).runtimeInstanceId,
              defaultProvider: (q.readContext as { defaultProvider?: string }).defaultProvider
            }
          })
    }
  if (q.method === 'release' && token(q.leaseId)) return { method: 'release', leaseId: q.leaseId }
  if (q.method === 'objects' && token(q.leaseId) && kinds.has(String(q.kind))) {
    for (const key of ['before', 'after', 'maxObjects', 'maxBytes'])
      if (q[key] !== undefined && !integer(q[key])) return null
    if (q.direction !== undefined && !['older', 'newer'].includes(String(q.direction))) return null
    return {
      method: 'objects',
      leaseId: q.leaseId,
      kind: q.kind as 'message',
      ...(q.before === undefined ? {} : { before: q.before as number }),
      ...(q.after === undefined ? {} : { after: q.after as number }),
      ...(q.direction === undefined ? {} : { direction: q.direction as 'older' | 'newer' }),
      ...(q.maxObjects === undefined ? {} : { maxObjects: q.maxObjects as number }),
      ...(q.maxBytes === undefined ? {} : { maxBytes: q.maxBytes as number })
    }
  }
  if (q.method === 'chunk' && token(q.leaseId) && integer(q.offset)) {
    const r = q.reference as Record<string, unknown> | undefined
    if (
      !r ||
      !safeId(r.chatId) ||
      !token(r.generation) ||
      !kinds.has(String(r.kind)) ||
      !integer(r.ordinal) ||
      !integer(r.byteLength) ||
      typeof r.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.sha256) ||
      (q.maximum !== undefined && !integer(q.maximum))
    )
      return null
    return {
      method: 'chunk',
      leaseId: q.leaseId,
      offset: q.offset,
      ...(q.maximum === undefined ? {} : { maximum: q.maximum as number }),
      reference: {
        chatId: r.chatId,
        generation: r.generation,
        kind: r.kind as 'message',
        ordinal: r.ordinal,
        byteLength: r.byteLength,
        sha256: r.sha256
      }
    }
  }
  return null
}

export interface ThreadCatalogueWireReply {
  data: unknown
}
export function decodeThreadCatalogueWireReply(value: unknown): ThreadCatalogueWireReply | null {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'data')) return null
  // The enclosing transport bounds bytes before JSON decode. This wrapper is
  // intentionally version-tolerant; each page consumer checks its query shape.
  return { data: (value as ThreadCatalogueWireReply).data }
}
