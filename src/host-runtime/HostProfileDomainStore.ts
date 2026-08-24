/**
 * Lease-gated, Node-only durable profile domain store.
 *
 * The caller acquires HostProfileAuthorityLease. This store nevertheless
 * invokes `assertProfileAuthority` before every profile-backed operation so a
 * released/stale lease cannot accidentally continue serving mutable profile
 * state. Files use private modes, no-follow reads, bounded JSON, and atomic
 * temp/fsync/rename publication.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'

import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest,
  HostTranscriptHistoryEntry
} from '../shared/hostHistoryProtocol'

export const HOST_PROFILE_WORKSPACES_FILENAME = 'workspaces.json'
export const HOST_PROFILE_CHATS_DIRECTORY = 'chats'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_WORKSPACES_BYTES = 4 * 1024 * 1024
const MAX_CHAT_BYTES = 64 * 1024 * 1024
const MAX_TEXT = 16_000

export interface HostProfileAuthorityPort {
  assertProfileAuthority(): void
}

export interface HostProfileWorkspace {
  readonly id: string
  readonly path: string
  readonly realPath: string
  readonly displayName?: string
  readonly pinned: boolean
  readonly updatedAt: number
  readonly [key: string]: unknown
}

export interface HostProfileThread {
  readonly appChatId: string
  readonly scope: 'global' | 'workspace'
  readonly workspaceId?: string
  readonly workspacePath?: string
  readonly title: string
  readonly provider?: string
  readonly providerMetadata?: Record<string, unknown>
  readonly workflowMode?: 'normal' | 'plan'
  readonly archived: boolean
  readonly pinned?: boolean
  readonly messages: readonly HostProfileMessage[]
  readonly runs?: readonly HostProfileRun[]
  readonly updatedAt: number
  readonly persistenceRevision?: number
  readonly [key: string]: unknown
}

export interface HostProfileMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'error'
  readonly content: string
  readonly timestamp: string
}

export interface HostProfileRun {
  readonly runId: string
  readonly provider?: string
  readonly status?: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly requestedModel?: string
}

export interface HostProfileDomainStoreOptions {
  readonly profilePath: string
  readonly authority: HostProfileAuthorityPort
  readonly now?: () => number
  readonly idFactory?: () => string
  /** Fault seam after durable temp fsync and before authoritative rename. */
  readonly beforeAtomicPublish?: (targetPath: string) => void
}

function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- profile IDs cannot carry terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function safeText(value: unknown, max = MAX_TEXT): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function assertPrivateRegular(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe profile file: ${path}`)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`Profile file is not owner-only: ${path}`)
  }
}

function readOptionalJson(path: string, maxBytes: number): unknown | null {
  try {
    assertPrivateRegular(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const before = lstatSync(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes) {
      throw new Error(`Unsafe profile file: ${path}`)
    }
    if (String(opened.ino) !== String(before.ino) || String(opened.dev) !== String(before.dev)) {
      throw new Error(`Profile file changed while opening: ${path}`)
    }
    const raw = readFileSync(fd, 'utf8')
    const after = lstatSync(path)
    if (
      String(after.ino) !== String(before.ino) ||
      String(after.dev) !== String(before.dev) ||
      after.size !== opened.size
    ) {
      throw new Error(`Profile file changed while reading: ${path}`)
    }
    return JSON.parse(raw)
  } finally {
    closeSync(fd)
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicJson(
  path: string,
  value: unknown,
  maxBytes: number,
  beforePublish?: (targetPath: string) => void
): void {
  const parent = dirname(path)
  const targetExists = existsSync(path)
  if (targetExists) assertPrivateRegular(path)
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  const body = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(body, 'utf8') > maxBytes)
    throw new Error('Profile document exceeds capacity')
  let fd: number | null = null
  let published = false
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      PRIVATE_FILE_MODE
    )
    fchmodSync(fd, PRIVATE_FILE_MODE)
    writeFileSync(fd, body, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    beforePublish?.(path)
    renameSync(temp, path)
    published = true
    if (process.platform !== 'win32') {
      const verified = lstatSync(path)
      if (!verified.isFile() || verified.isSymbolicLink())
        throw new Error('Unsafe published profile file')
    }
    fsyncDirectory(parent)
  } finally {
    if (fd !== null) closeSync(fd)
    if (!published) {
      try {
        unlinkSync(temp)
      } catch {
        // An orphan O_EXCL temp is never authoritative.
      }
    }
  }
}

function assertProfilePath(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('Profile path must be absolute')
  const resolved = resolve(path)
  if (resolved === parse(resolved).root) throw new Error('Profile path must not be filesystem root')
  const canonical = realpathSync(resolved)
  const stat = lstatSync(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Profile path is unsafe')
  return canonical
}

function decodeWorkspace(value: unknown): HostProfileWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid workspace')
  const item = value as Record<string, unknown>
  if (!safeId(item.id) || !safeText(item.path)) {
    throw new Error('Invalid workspace')
  }
  if (item.displayName !== undefined && !safeText(item.displayName, 200))
    throw new Error('Invalid workspace')
  const realPath = safeText(item.realPath) ? item.realPath : item.path
  const updatedAt =
    Number.isSafeInteger(item.updatedAt) && (item.updatedAt as number) >= 0 ? item.updatedAt : 0
  return {
    ...item,
    id: item.id,
    path: item.path,
    realPath,
    pinned: item.pinned === true,
    updatedAt
  } as HostProfileWorkspace
}

function decodeMessage(value: unknown): HostProfileMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid profile message')
  const item = value as Record<string, unknown>
  if (
    !safeId(item.id) ||
    !['user', 'assistant', 'system', 'tool', 'error'].includes(String(item.role))
  ) {
    throw new Error('Invalid profile message')
  }
  // Legacy AppStore tool/error carriers may contain provider payload bodies or
  // empty content. Retain them inertly; history projection excludes them.
  if (
    typeof item.content !== 'string' ||
    Buffer.byteLength(item.content, 'utf8') > MAX_CHAT_BYTES ||
    typeof item.timestamp !== 'string' ||
    item.timestamp.length > 200
  ) {
    throw new Error('Invalid profile message')
  }
  return item as unknown as HostProfileMessage
}

function decodeThread(value: unknown): HostProfileThread {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid profile chat')
  const item = value as Record<string, unknown>
  if (
    !safeId(item.appChatId) ||
    (item.scope !== undefined && item.scope !== 'global' && item.scope !== 'workspace') ||
    !safeText(item.title, 200) ||
    !Array.isArray(item.messages) ||
    !Number.isSafeInteger(item.updatedAt)
  ) {
    throw new Error('Invalid profile chat')
  }
  const scope = item.scope === 'workspace' || safeId(item.workspaceId) ? 'workspace' : 'global'
  if (scope === 'workspace' && (!safeId(item.workspaceId) || !safeText(item.workspacePath))) {
    throw new Error('Invalid profile chat')
  }
  item.messages.forEach(decodeMessage)
  if (item.runs !== undefined) {
    if (!Array.isArray(item.runs)) throw new Error('Invalid profile runs')
    const runIds = new Set<string>()
    for (const run of item.runs) {
      if (!run || typeof run !== 'object' || Array.isArray(run))
        throw new Error('Invalid profile run')
      const record = run as Record<string, unknown>
      if (
        !safeId(record.runId) ||
        (record.status !== undefined && !safeText(record.status, 80)) ||
        runIds.has(record.runId)
      ) {
        throw new Error('Invalid profile run')
      }
      runIds.add(record.runId)
    }
  }
  return {
    ...item,
    appChatId: item.appChatId,
    scope,
    archived: item.archived === true,
    messages: item.messages as HostProfileMessage[],
    updatedAt: item.updatedAt as number,
    ...(Number.isSafeInteger(item.persistenceRevision) && (item.persistenceRevision as number) >= 0
      ? { persistenceRevision: item.persistenceRevision as number }
      : {})
  } as unknown as HostProfileThread
}

export class HostProfileDomainStore {
  private readonly profilePath: string
  private readonly chatsPath: string
  private readonly authority: HostProfileAuthorityPort
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly beforeAtomicPublish?: (targetPath: string) => void

  constructor(options: HostProfileDomainStoreOptions) {
    if (!options?.authority || typeof options.authority.assertProfileAuthority !== 'function') {
      throw new Error('HostProfileDomainStore requires profile authority')
    }
    options.authority.assertProfileAuthority()
    this.authority = options.authority
    this.profilePath = assertProfilePath(options.profilePath)
    this.chatsPath = join(this.profilePath, HOST_PROFILE_CHATS_DIRECTORY)
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? randomUUID
    this.beforeAtomicPublish = options.beforeAtomicPublish
    this.ensureDirectory(this.chatsPath)
  }

  listWorkspaces(): readonly HostProfileWorkspace[] {
    this.assertAuthority()
    const raw = readOptionalJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      MAX_WORKSPACES_BYTES
    )
    if (raw === null) return []
    if (!Array.isArray(raw)) throw new Error('Invalid workspaces document')
    const records = raw.map(decodeWorkspace)
    const ids = new Set<string>()
    const paths = new Set<string>()
    for (const record of records) {
      if (ids.has(record.id) || paths.has(record.realPath))
        throw new Error('Ambiguous workspace document')
      ids.add(record.id)
      paths.add(record.realPath)
    }
    return records
  }

  registerWorkspace(input: {
    path: string
    displayName?: string
    pinned?: boolean
  }): HostProfileWorkspace {
    const realPath = this.assertWorkspaceDirectory(input.path)
    const current = [...this.listWorkspaces()]
    const existing = current.find((workspace) => workspace.realPath === realPath)
    const next: HostProfileWorkspace = {
      ...(existing ?? {}),
      id: existing?.id ?? this.newId(),
      path: realPath,
      realPath,
      ...(input.displayName !== undefined
        ? { displayName: this.requireText(input.displayName, 200) }
        : {}),
      pinned: input.pinned ?? existing?.pinned ?? false,
      updatedAt: this.now()
    }
    const records = existing
      ? current.map((workspace) => (workspace.id === existing.id ? next : workspace))
      : [...current, next]
    atomicJson(
      join(this.profilePath, HOST_PROFILE_WORKSPACES_FILENAME),
      records,
      MAX_WORKSPACES_BYTES,
      this.beforeAtomicPublish
    )
    return next
  }

  createThread(input: {
    scope: 'global' | 'workspace'
    workspaceId?: string
    title?: string
  }): HostProfileThread {
    this.assertAuthority()
    const scope = input?.scope
    if (scope !== 'global' && scope !== 'workspace') throw new Error('Invalid thread scope')
    const now = this.now()
    const record: HostProfileThread = {
      appChatId: this.newId(),
      scope,
      ...(scope === 'workspace' ? this.workspaceThreadFields(input.workspaceId) : {}),
      title: input.title === undefined ? 'New chat' : this.requireText(input.title, 200),
      archived: false,
      messages: [],
      persistenceRevision: 0,
      updatedAt: now
    }
    this.writeThread(record)
    return record
  }

  getThread(threadId: string): HostProfileThread | null {
    this.assertAuthority()
    this.requireId(threadId)
    const raw = readOptionalJson(this.chatPath(threadId), MAX_CHAT_BYTES)
    if (raw === null) return null
    const thread = decodeThread(raw)
    if (thread.appChatId !== threadId) throw new Error('Chat identity mismatch')
    return thread
  }

  listThreads(): readonly HostProfileThread[] {
    this.assertAuthority()
    this.ensureDirectory(this.chatsPath)
    const records: HostProfileThread[] = []
    for (const entry of readdirSync(this.chatsPath, { withFileTypes: true })) {
      if (this.isRecognizedTemp(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error('Unsafe chat directory entry')
        continue
      }
      if (!entry.name.endsWith('.json')) throw new Error('Unsafe chat directory entry')
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe chat directory entry')
      const id = entry.name.slice(0, -'.json'.length)
      if (!safeId(id)) throw new Error('Unsafe chat filename')
      const thread = this.getThread(id)
      if (thread) records.push(thread)
    }
    return records
  }

  configureThread(input: {
    threadId: string
    title?: string
    providerId?: string
    modelId?: string
    reasoningId?: string
    postureId?: 'read_only' | 'plan' | 'default' | 'workspace_write'
    postureConsent?: true
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    this.assertIdle(current)
    const metadata = { ...(current.providerMetadata ?? {}) }
    if (input.modelId !== undefined)
      metadata.selectedModelType = this.requireText(input.modelId, 512)
    if (input.reasoningId !== undefined)
      metadata.reasoningEffort = this.requireText(input.reasoningId, 512)
    let workflowMode = current.workflowMode
    if (input.postureId !== undefined) {
      const posture = this.posture(input.postureId)
      if (input.postureConsent !== undefined && input.postureConsent !== true) {
        throw new Error('Invalid posture consent')
      }
      if (input.postureId === 'workspace_write' && input.postureConsent !== true) {
        throw new Error('Workspace-write posture requires explicit consent')
      }
      metadata.approvalMode = posture.approvalMode
      metadata.permissionPresetId = posture.permissionPresetId
      if (input.postureId === 'workspace_write') metadata.explicitConsentAcknowledged = true
      else delete metadata.explicitConsentAcknowledged
      workflowMode = posture.workflowMode
    }
    const next: HostProfileThread = {
      ...current,
      ...(input.title !== undefined ? { title: this.requireText(input.title, 200) } : {}),
      ...(input.providerId !== undefined
        ? { provider: this.requireText(input.providerId, 512) }
        : {}),
      ...(Object.keys(metadata).length > 0 ? { providerMetadata: metadata } : {}),
      ...(workflowMode !== undefined ? { workflowMode } : {}),
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    // Provider switch hygiene: stale provider sessions must not survive.
    if (input.providerId !== undefined && input.providerId !== current.provider) {
      delete (next as Record<string, unknown>).linkedProviderSessionId
      delete (next as Record<string, unknown>).linkedGeminiSessionId
      delete (next as Record<string, unknown>).taskWraithMcpProfileReceipt
    }
    this.writeThread(next)
    return next
  }

  archiveThread(threadId: string, archived: boolean): HostProfileThread {
    this.assertAuthority()
    if (typeof archived !== 'boolean') throw new Error('Invalid archive state')
    const current = this.requireThread(threadId)
    if (current.archived === archived) return current
    this.assertIdle(current)
    const next = {
      ...current,
      archived,
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  appendTranscript(input: {
    threadId: string
    role: HostProfileMessage['role']
    content: string
    timestamp?: string
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    if (input.role !== 'user' && input.role !== 'assistant' && input.role !== 'system') {
      throw new Error('Invalid transcript role')
    }
    if (!safeText(input.content)) throw new Error('Invalid transcript content')
    const timestamp = input.timestamp ?? new Date(this.now()).toISOString()
    if (!this.isCanonicalIso(timestamp)) throw new Error('Invalid transcript timestamp')
    const message: HostProfileMessage = {
      id: this.newId(),
      role: input.role,
      content: input.content,
      timestamp
    }
    const messages = [...current.messages, message]
    const next = {
      ...current,
      messages,
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  updateRun(input: {
    threadId: string
    runId: string
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    provider?: string
    requestedModel?: string
  }): HostProfileThread {
    this.assertAuthority()
    const current = this.requireThread(input.threadId)
    this.requireId(input.runId)
    if (!['running', 'completed', 'failed', 'cancelled'].includes(input.status)) {
      throw new Error('Invalid run status')
    }
    const runs = [...(current.runs ?? [])]
    const index = runs.findIndex((run) => run.runId === input.runId)
    const prior = index >= 0 ? runs[index] : undefined
    if (!prior && input.status !== 'running') throw new Error('Run must begin as running')
    const priorTerminalStatus = prior ? this.terminalRunStatus(prior) : null
    if (priorTerminalStatus) {
      if (priorTerminalStatus === input.status) return current
      throw new Error('Terminal run cannot change state')
    }
    const run: HostProfileRun = {
      ...(prior ?? {}),
      runId: input.runId,
      status: input.status,
      ...(input.provider !== undefined ? { provider: this.requireText(input.provider, 512) } : {}),
      ...(input.requestedModel !== undefined
        ? { requestedModel: this.requireText(input.requestedModel, 512) }
        : {}),
      ...(prior?.startedAt ? {} : { startedAt: new Date(this.now()).toISOString() }),
      ...(input.status === 'running' ? {} : { endedAt: new Date(this.now()).toISOString() })
    }
    if (index >= 0) runs[index] = run
    else runs.push(run)
    const next = {
      ...current,
      runs,
      persistenceRevision: this.nextRevision(current),
      updatedAt: this.now()
    }
    this.writeThread(next)
    return next
  }

  threadHistory(request: HostThreadHistoryRequest): HostThreadHistoryPage {
    this.assertAuthority()
    const thread = this.requireThread(request.threadId)
    const projected = this.historyEntries(thread)
    const total = projected.length
    const end = request.before?.cursor ?? total
    const generation = thread.persistenceRevision ?? 0
    if (request.before && request.before.generation !== generation)
      throw new Error('History generation mismatch')
    if (!Number.isSafeInteger(end) || end < 0 || end > total)
      throw new Error('History cursor is invalid')
    const start = Math.max(0, end - request.limit)
    const entries = projected.slice(start, end)
    return {
      threadId: thread.appChatId,
      generation,
      cursor: total,
      entries,
      ...(start > 0 ? { nextBefore: { generation, cursor: start } } : {})
    }
  }

  historySince(request: HostHistorySinceRequest): HostHistorySinceResult {
    this.assertAuthority()
    const thread = this.requireThread(request.threadId)
    const cursor = this.historyEntries(thread).length
    const generation = thread.persistenceRevision ?? 0
    return {
      kind: 'full_resnapshot_required',
      threadId: thread.appChatId,
      generation,
      cursor,
      clientGeneration: request.since.generation,
      clientCursor: request.since.cursor,
      reason:
        request.since.generation === generation && request.since.cursor === cursor
          ? 'retention_gap'
          : request.since.generation !== generation
            ? 'generation_mismatch'
            : 'cursor_mismatch'
    }
  }

  private assertAuthority(): void {
    this.authority.assertProfileAuthority()
  }

  private ensureDirectory(path: string): void {
    this.assertAuthority()
    try {
      mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    } catch {
      throw new Error('Profile directory cannot be initialized')
    }
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe profile directory')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Profile directory is not owner-only')
    }
  }

  private assertWorkspaceDirectory(path: string): string {
    if (typeof path !== 'string' || !isAbsolute(path))
      throw new Error('Workspace path must be absolute')
    const resolved = resolve(path)
    if (resolved === parse(resolved).root) throw new Error('Workspace path must not be root')
    const direct = lstatSync(resolved)
    if (!direct.isDirectory() || direct.isSymbolicLink())
      throw new Error('Workspace path is unsafe')
    const real = realpathSync(resolved)
    const stat = statSync(real)
    if (!stat.isDirectory()) throw new Error('Workspace path is not a directory')
    return real
  }

  private workspaceThreadFields(
    workspaceId: string | undefined
  ): Pick<HostProfileThread, 'workspaceId' | 'workspacePath'> {
    this.requireId(workspaceId)
    const workspace = this.listWorkspaces().find((candidate) => candidate.id === workspaceId)
    if (!workspace) throw new Error('Workspace is not registered')
    return { workspaceId: workspace.id, workspacePath: workspace.realPath }
  }

  private requireThread(threadId: string): HostProfileThread {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error('Thread is not found')
    return thread
  }

  private writeThread(thread: HostProfileThread): void {
    this.assertAuthority()
    this.requireId(thread.appChatId)
    atomicJson(this.chatPath(thread.appChatId), thread, MAX_CHAT_BYTES, this.beforeAtomicPublish)
  }

  private chatPath(threadId: string): string {
    this.requireId(threadId)
    return join(this.chatsPath, `${threadId}.json`)
  }

  private newId(): string {
    const id = this.idFactory()
    this.requireId(id)
    return id
  }

  private requireId(value: unknown): asserts value is string {
    if (!safeId(value)) throw new Error('Profile identity is invalid')
  }

  private requireText(value: unknown, max: number): string {
    if (!safeText(value, max)) throw new Error('Profile value is invalid')
    return value
  }

  private assertIdle(thread: HostProfileThread): void {
    if ((thread.runs ?? []).some((run) => this.isActiveRun(run))) {
      throw new Error('Thread is active')
    }
  }

  private isActiveRun(run: HostProfileRun): boolean {
    if (this.terminalRunStatus(run)) return false
    const status = typeof run.status === 'string' ? run.status.toLowerCase() : ''
    // Unknown/no-status records without a proven terminal timestamp fail
    // closed as active; setup must not mutate a possibly live legacy run.
    return ![
      'completed',
      'success',
      'succeeded',
      'failed',
      'error',
      'cancelled',
      'canceled'
    ].includes(status)
  }

  private terminalRunStatus(
    run: HostProfileRun
  ): 'completed' | 'failed' | 'cancelled' | 'unknown' | null {
    switch (typeof run.status === 'string' ? run.status.toLowerCase() : '') {
      case 'completed':
      case 'success':
      case 'succeeded':
        return 'completed'
      case 'failed':
      case 'error':
        return 'failed'
      case 'cancelled':
      case 'canceled':
        return 'cancelled'
      default:
        return this.isCanonicalIso(run.endedAt) ? 'unknown' : null
    }
  }

  private isCanonicalIso(value: unknown): value is string {
    if (!safeText(value, 80)) return false
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
  }

  private isRecognizedTemp(name: string): boolean {
    if (name.startsWith('.') && name.endsWith('.tmp')) return true
    const match = /^(.+)\.json\.(\d+)\.([A-Za-z0-9_-]+)\.tmp$/.exec(name)
    return match !== null && safeId(match[1])
  }

  private nextRevision(thread: HostProfileThread): number {
    const current = thread.persistenceRevision ?? 0
    if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Profile persistence revision is invalid')
    }
    return current + 1
  }

  private historyEntries(thread: HostProfileThread): HostTranscriptHistoryEntry[] {
    return thread.messages.flatMap((message) => {
      if (
        (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') ||
        !safeText(message.content)
      ) {
        return []
      }
      return [
        {
          entryId: message.id,
          role: message.role,
          createdAt: Number.isFinite(Date.parse(message.timestamp))
            ? Date.parse(message.timestamp)
            : 0,
          text: message.content
        }
      ]
    })
  }

  private posture(posture: string): {
    approvalMode: string
    permissionPresetId: 'read_only' | 'default' | 'workspace_write'
    workflowMode: 'normal' | 'plan'
  } {
    switch (posture) {
      case 'read_only':
        return { approvalMode: 'plan', permissionPresetId: 'read_only', workflowMode: 'normal' }
      case 'plan':
        return { approvalMode: 'plan', permissionPresetId: 'read_only', workflowMode: 'plan' }
      case 'default':
        return { approvalMode: 'default', permissionPresetId: 'default', workflowMode: 'normal' }
      case 'workspace_write':
        return {
          approvalMode: 'default',
          permissionPresetId: 'workspace_write',
          workflowMode: 'normal'
        }
      default:
        throw new Error('Invalid posture')
    }
  }
}
