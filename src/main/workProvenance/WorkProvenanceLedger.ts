import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { ProviderId } from '../store/types'
import type { WorkspaceLockClaimKind, WorkspaceLockHunk } from '../workLocks/WorkspaceLockTypes'

export const WORK_PROVENANCE_SCHEMA_VERSION = 1
export const WORK_PROVENANCE_DIRECTORY = join('taskwraith', 'work-provenance-v1')
export const WORK_PROVENANCE_EVENTS_DIRECTORY = 'events'
export const WORK_PROVENANCE_RECOVERY_REF_PREFIX = 'refs/taskwraith/work-provenance/'
const WORK_PROVENANCE_RECOVERY_REF_RE = /^refs\/taskwraith\/work-provenance\/[a-f0-9]{40}$/

const MAX_OBSERVED_DIRTY_PATHS = 1_000
const MAX_EVENT_TEXT = 512
const MAX_EVENT_FILE_BYTES = 1024 * 1024
const GIT_TIMEOUT_MS = 4_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024
export const WORK_PROVENANCE_OPERATION_TIMEOUT_MS = 1_500

const workProvenanceAbortContext = new AsyncLocalStorage<AbortSignal>()

export type WorkProvenanceConfidence =
  | 'exact'
  | 'observed-native'
  | 'correlated-claim'
  | 'ambiguous'
  | 'unknown'

export interface WorkProvenanceActor {
  sessionId?: string
  taskId?: string
  runId?: string
  chatId?: string
  chatTitle?: string
  provider?: ProviderId | string
  participantId?: string
  participantRole?: string
  laneId?: string
  displayName?: string
  markerFile?: string
  markerObservationId?: string
  lockOwnerId?: string
  authorityInstanceId?: string
  processBirthReceiptHash?: string
}

export interface WorkProvenanceWorkspaceIdentity {
  root: string
  gitDir: string
  gitCommonDir: string
  repositoryId: string
  worktreeId: string
}

export type WorkProvenancePathState =
  | 'missing'
  | 'file'
  | 'directory'
  | 'symlink'
  | 'other'
  | 'unstable'
  | 'unreadable'

export interface WorkProvenancePathFingerprint {
  state: WorkProvenancePathState
  sha256?: string
  sizeBytes?: number
  linkTarget?: string
}

export interface WorkProvenanceClaimEvidence {
  kind: WorkspaceLockClaimKind
  hunk?: WorkspaceLockHunk
}

export interface WorkProvenanceOriginEvent {
  schemaVersion: typeof WORK_PROVENANCE_SCHEMA_VERSION
  eventId: string
  kind: 'origin'
  recordedAt: string
  confidence: WorkProvenanceConfidence
  source: 'taskwraith-broker' | 'taskwraith-native-run' | 'work-guard-marker'
  workspace: WorkProvenanceWorkspaceIdentity
  path: string
  before?: WorkProvenancePathFingerprint
  after: WorkProvenancePathFingerprint
  actor: WorkProvenanceActor
  operation?: {
    id: string
    name?: string
    outcome?: string
    exclusive?: boolean
    preexistingDirty?: boolean
  }
  claim?: WorkProvenanceClaimEvidence
  predecessorOriginEventId?: string
  authority?: {
    lockOwnerId?: string
    authorityInstanceId?: string
    acquisitionTransitionId?: string
    leaseIds?: string[]
  }
}

export interface WorkProvenanceResolutionEvent {
  schemaVersion: typeof WORK_PROVENANCE_SCHEMA_VERSION
  eventId: string
  kind: 'resolution'
  recordedAt: string
  originEventId: string
  reason: 'clean' | 'committed' | 'reverted' | 'adopted' | 'superseded' | 'recovered' | 'discarded'
  actor?: WorkProvenanceActor
  successorOriginEventId?: string
}

export interface WorkProvenanceRecoveryEvent {
  schemaVersion: typeof WORK_PROVENANCE_SCHEMA_VERSION
  eventId: string
  kind: 'recovery'
  recordedAt: string
  originEventId: string
  recovery: {
    ref: string
    commit: string
    tree: string
    pinnedAt: string
  }
}

export type WorkProvenanceEvent =
  | WorkProvenanceOriginEvent
  | WorkProvenanceResolutionEvent
  | WorkProvenanceRecoveryEvent

export interface WorkProvenanceTarget {
  path: string
  kind: WorkspaceLockClaimKind
  hunk?: WorkspaceLockHunk
}

export interface BeginBrokeredMutationInput {
  workspacePath: string
  operationId: string
  toolName: string
  actor: WorkProvenanceActor
  targets: readonly WorkProvenanceTarget[]
  authority?: WorkProvenanceOriginEvent['authority']
  /** User-approved opaque host execution: observe tree deltas without claiming exact causality. */
  observeWorkspaceWhenUnscoped?: boolean
}

export interface BeginObservedNativeRunInput {
  workspacePath: string
  runId: string
  actor: WorkProvenanceActor
}

export interface CapturedWorkProvenance {
  workspace: WorkProvenanceWorkspaceIdentity
  events: WorkProvenanceOriginEvent[]
}

export interface WorkProvenanceOperation {
  capture(outcome: string): Promise<CapturedWorkProvenance | null>
}

export interface WorkProvenanceObservedRunHandle {
  key: string
  runId: string
  worktreeId: string
}

export interface WorkProvenanceRecorderOptions {
  now?: () => Date
  nextId?: () => string
  logError?: (scope: string, error: unknown) => void
  maxObservedDirtyPaths?: number
}

interface ExactBaseline {
  target: WorkProvenanceTarget
  relativePath: string
  before: WorkProvenancePathFingerprint
  preexistingDirty: boolean
}

interface DirtyWorkspaceSnapshot {
  entries: Map<string, WorkProvenancePathFingerprint>
  truncated: boolean
}

interface ActiveObservedRun {
  workspace: WorkProvenanceWorkspaceIdentity
  actor: WorkProvenanceActor
  before: DirtyWorkspaceSnapshot
  startedAt: string
  contended: boolean
}

interface RunGitResult {
  code: number
  stdout: string
}

class WorkProvenancePersistenceQueue {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tail.catch(() => undefined)
    let releaseSlot!: () => void
    const slot = new Promise<void>((resolveSlot) => {
      releaseSlot = resolveSlot
    })
    this.tail = predecessor.then(() => slot)
    try {
      await waitForWorkProvenancePromise(predecessor, signal)
      throwIfWorkProvenanceAborted(signal)
      return await operation()
    } finally {
      releaseSlot()
    }
  }
}

/**
 * Best-effort, authority-free edit accountability.
 *
 * Receipts are written only after mutation authorization and execution have
 * already been decided elsewhere. A failure here is logged and swallowed: the
 * provenance layer can explain a write, but can never grant one, retain its
 * lock, cancel its provider, or turn an otherwise valid run into a failure.
 */
export class WorkProvenanceRecorder {
  private readonly now: () => Date
  private readonly nextId: () => string
  private readonly logError?: (scope: string, error: unknown) => void
  private readonly maxObservedDirtyPaths: number
  private readonly activeObservedRuns = new Map<string, ActiveObservedRun>()
  private readonly persistenceQueue = new WorkProvenancePersistenceQueue()

  constructor(options: WorkProvenanceRecorderOptions = {}) {
    this.now = options.now || (() => new Date())
    this.nextId = options.nextId || randomUUID
    this.logError = options.logError
    this.maxObservedDirtyPaths = Math.max(
      1,
      Math.floor(options.maxObservedDirtyPaths || MAX_OBSERVED_DIRTY_PATHS)
    )
  }

  async beginBrokeredMutation(
    input: BeginBrokeredMutationInput
  ): Promise<WorkProvenanceOperation | null> {
    const signal = currentWorkProvenanceAbortSignal()
    try {
      throwIfWorkProvenanceAborted(signal)
      const workspace = await resolveWorkProvenanceWorkspace(input.workspacePath, signal)
      if (!workspace) return null
      const actor = normalizeActor(input.actor)
      const targets = uniqueTargets(input.targets)
      if (targets.length > 0) {
        const planned: Array<{ target: WorkProvenanceTarget; relativePath: string }> = []
        for (const target of targets) {
          throwIfWorkProvenanceAborted(signal)
          const relativePath = await repositoryRelativePath(workspace.root, target.path, signal)
          if (!relativePath || isGitMetadataPath(relativePath)) continue
          planned.push({ target, relativePath })
        }
        if (planned.length === 0) return null
        const dirtyBefore = await captureDirtyTargetPaths(
          workspace,
          planned.map((entry) => entry.relativePath),
          signal
        )
        const baselines: ExactBaseline[] = []
        for (const entry of planned) {
          baselines.push({
            ...entry,
            before: await fingerprintPath(resolve(workspace.root, entry.relativePath), signal),
            // A failed Git sample must weaken attribution, never silently award
            // pre-existing bytes to the new exact operation.
            preexistingDirty: dirtyBefore === null || dirtyBefore.has(entry.relativePath)
          })
        }
        return oneShotOperation(async (outcome, captureSignal) => {
          const events: WorkProvenanceOriginEvent[] = []
          for (const baseline of baselines) {
            throwIfWorkProvenanceAborted(captureSignal)
            const after = await fingerprintPath(
              resolve(workspace.root, baseline.relativePath),
              captureSignal
            )
            if (sameFingerprint(baseline.before, after)) continue
            const stable = after.state !== 'unstable' && after.state !== 'unreadable'
            events.push(
              this.originEvent({
                workspace,
                path: baseline.relativePath,
                before: baseline.before,
                after,
                actor,
                confidence: stable ? 'exact' : 'ambiguous',
                source: 'taskwraith-broker',
                operation: {
                  id: boundedText(input.operationId) || this.nextId(),
                  name: boundedText(input.toolName),
                  outcome: boundedText(outcome),
                  exclusive: stable,
                  preexistingDirty: baseline.preexistingDirty
                },
                claim: {
                  kind: baseline.target.kind,
                  ...(baseline.target.hunk ? { hunk: { ...baseline.target.hunk } } : {})
                },
                ...(input.authority ? { authority: normalizeAuthority(input.authority) } : {})
              })
            )
          }
          throwIfWorkProvenanceAborted(captureSignal)
          return events.length ? { workspace, events } : null
        }, this.logError)
      }

      if (!input.observeWorkspaceWhenUnscoped) return null
      const before = await captureDirtyWorkspace(workspace, this.maxObservedDirtyPaths, signal)
      return oneShotOperation(async (outcome, captureSignal) => {
        const after = await captureDirtyWorkspace(
          workspace,
          this.maxObservedDirtyPaths,
          captureSignal
        )
        const events = this.observedEvents({
          workspace,
          actor,
          before,
          after,
          source: 'taskwraith-broker',
          operationId: input.operationId,
          operationName: input.toolName,
          outcome,
          // A repository/tree-scoped host command has no exact target receipt.
          // Never upgrade it to exclusive merely because the sample fit under
          // the size bound; another approved lane may have changed a disjoint
          // path during the same interval.
          exclusive: false
        })
        throwIfWorkProvenanceAborted(captureSignal)
        return events.length ? { workspace, events } : null
      }, this.logError)
    } catch (error) {
      if (!workProvenanceWasAborted(signal, error)) {
        this.logError?.('begin brokered work provenance', error)
      }
      return null
    }
  }

  async beginObservedNativeRun(
    input: BeginObservedNativeRunInput
  ): Promise<WorkProvenanceObservedRunHandle | null> {
    const signal = currentWorkProvenanceAbortSignal()
    let handle: WorkProvenanceObservedRunHandle | null = null
    let activeRecord: ActiveObservedRun | null = null
    let abortCleanup: (() => void) | null = null
    try {
      throwIfWorkProvenanceAborted(signal)
      const workspace = await resolveWorkProvenanceWorkspace(input.workspacePath, signal)
      if (!workspace) return null
      handle = {
        key: `${workspace.worktreeId}\0${input.runId}`,
        runId: input.runId,
        worktreeId: workspace.worktreeId
      }
      if (this.activeObservedRuns.has(handle.key)) return handle
      for (const active of this.activeObservedRuns.values()) {
        if (active.workspace.worktreeId === workspace.worktreeId) active.contended = true
      }
      const record: ActiveObservedRun = {
        workspace,
        actor: normalizeActor(input.actor),
        before: { entries: new Map(), truncated: false },
        startedAt: this.now().toISOString(),
        contended: [...this.activeObservedRuns.values()].some(
          (active) => active.workspace.worktreeId === workspace.worktreeId
        )
      }
      activeRecord = record
      this.activeObservedRuns.set(handle.key, record)
      abortCleanup = () => this.deleteActiveObservedRun(handle!.key, record)
      signal?.addEventListener('abort', abortCleanup, { once: true })
      record.before = await captureDirtyWorkspace(workspace, this.maxObservedDirtyPaths, signal)
      throwIfWorkProvenanceAborted(signal)
      return handle
    } catch (error) {
      if (handle && activeRecord) this.deleteActiveObservedRun(handle.key, activeRecord)
      if (!workProvenanceWasAborted(signal, error)) {
        this.logError?.(`begin native-run provenance ${input.runId}`, error)
      }
      return null
    } finally {
      if (abortCleanup) signal?.removeEventListener('abort', abortCleanup)
    }
  }

  async finishObservedNativeRun(
    handle: WorkProvenanceObservedRunHandle,
    outcome: string
  ): Promise<void> {
    const signal = currentWorkProvenanceAbortSignal()
    const active = this.activeObservedRuns.get(handle.key)
    if (!active) return
    const runId = handle.runId
    if (active.workspace.worktreeId !== handle.worktreeId) return
    const abortCleanup = () => this.deleteActiveObservedRun(handle.key, active)
    signal?.addEventListener('abort', abortCleanup, { once: true })
    try {
      throwIfWorkProvenanceAborted(signal)
      const after = await captureDirtyWorkspace(
        active.workspace,
        this.maxObservedDirtyPaths,
        signal
      )
      const exclusive = !(active.contended || active.before.truncated || after.truncated)
      const events = this.observedEvents({
        workspace: active.workspace,
        actor: active.actor,
        before: active.before,
        after,
        source: 'taskwraith-native-run',
        operationId: runId,
        operationName: 'provider-run',
        outcome,
        exclusive
      })
      if (events.length) {
        // A brokered exact receipt from this same run is stronger evidence than
        // the surrounding opaque-run observation. Keep the native boundary for
        // genuinely native writes, but never duplicate/dilute an exact receipt.
        const exactAfterByPath = new Map(
          (await readWorkProvenanceEvents(active.workspace.root, signal))
            .filter(
              (event): event is WorkProvenanceOriginEvent =>
                event.kind === 'origin' &&
                event.source === 'taskwraith-broker' &&
                event.confidence === 'exact' &&
                event.workspace.worktreeId === active.workspace.worktreeId &&
                event.actor.runId === runId &&
                event.recordedAt >= active.startedAt
            )
            .map((event) => [event.path, event.after] as const)
        )
        const nativeOnlyEvents = events.filter((event) => {
          const exactAfter = exactAfterByPath.get(event.path)
          return !exactAfter || !sameFingerprint(exactAfter, event.after)
        })
        if (nativeOnlyEvents.length) {
          throwIfWorkProvenanceAborted(signal)
          await this.persist({ workspace: active.workspace, events: nativeOnlyEvents })
        }
      }
    } catch (error) {
      if (!workProvenanceWasAborted(signal, error)) {
        this.logError?.(`finish native-run provenance ${runId}`, error)
      }
    } finally {
      signal?.removeEventListener('abort', abortCleanup)
      this.deleteActiveObservedRun(handle.key, active)
    }
  }

  async persist(captured: CapturedWorkProvenance | null): Promise<void> {
    if (!captured?.events.length) return
    const signal = currentWorkProvenanceAbortSignal()
    try {
      await this.persistenceQueue.run(signal, async () => {
        throwIfWorkProvenanceAborted(signal)
        const eventsDirectory = await ensureEventsDirectory(captured.workspace.gitCommonDir, signal)
        for (const event of captured.events) {
          throwIfWorkProvenanceAborted(signal)
          await writeImmutableEvent(eventsDirectory, event, signal)
        }
      })
    } catch (error) {
      if (!workProvenanceWasAborted(signal, error)) {
        this.logError?.('persist work provenance', error)
      }
    }
  }

  private deleteActiveObservedRun(key: string, expected: ActiveObservedRun): void {
    if (this.activeObservedRuns.get(key) === expected) this.activeObservedRuns.delete(key)
  }

  private observedEvents(input: {
    workspace: WorkProvenanceWorkspaceIdentity
    actor: WorkProvenanceActor
    before: DirtyWorkspaceSnapshot
    after: DirtyWorkspaceSnapshot
    source: 'taskwraith-broker' | 'taskwraith-native-run'
    operationId: string
    operationName: string
    outcome: string
    exclusive: boolean
  }): WorkProvenanceOriginEvent[] {
    const events: WorkProvenanceOriginEvent[] = []
    for (const [path, after] of input.after.entries) {
      const before = input.before.entries.get(path)
      if (before && sameFingerprint(before, after)) continue
      const stable = after.state !== 'unstable' && after.state !== 'unreadable'
      const confidence = input.exclusive && stable ? 'observed-native' : 'ambiguous'
      events.push(
        this.originEvent({
          workspace: input.workspace,
          path,
          ...(before ? { before } : {}),
          after,
          actor: input.actor,
          confidence,
          source: input.source,
          operation: {
            id: boundedText(input.operationId) || this.nextId(),
            name: boundedText(input.operationName),
            outcome: boundedText(input.outcome),
            exclusive: input.exclusive
          }
        })
      )
    }
    return events
  }

  private originEvent(
    input: Omit<WorkProvenanceOriginEvent, 'schemaVersion' | 'eventId' | 'kind' | 'recordedAt'>
  ): WorkProvenanceOriginEvent {
    return {
      schemaVersion: WORK_PROVENANCE_SCHEMA_VERSION,
      eventId: `origin-${this.nextId()}`,
      kind: 'origin',
      recordedAt: this.now().toISOString(),
      ...input
    }
  }
}

export async function resolveWorkProvenanceWorkspace(
  workspacePath: string,
  signal: AbortSignal | undefined = currentWorkProvenanceAbortSignal()
): Promise<WorkProvenanceWorkspaceIdentity | null> {
  throwIfWorkProvenanceAborted(signal)
  const cwd = resolve(workspacePath)
  const result = await runGit(
    cwd,
    [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir'
    ],
    signal
  )
  throwIfWorkProvenanceAborted(signal)
  if (result.code !== 0) return null
  const [rootLine, gitDirLine, commonDirLine] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!rootLine || !gitDirLine || !commonDirLine) return null
  const root = await physicalPlannedPath(resolve(rootLine), signal)
  const gitDir = await physicalPlannedPath(resolve(cwd, gitDirLine), signal)
  const gitCommonDir = await physicalPlannedPath(resolve(cwd, commonDirLine), signal)
  return {
    root,
    gitDir,
    gitCommonDir,
    repositoryId: createHash('sha256').update(gitCommonDir).digest('hex'),
    worktreeId: createHash('sha256').update(`${root}\0${gitDir}`).digest('hex')
  }
}

export async function readWorkProvenanceEvents(
  workspacePath: string,
  signal: AbortSignal | undefined = currentWorkProvenanceAbortSignal()
): Promise<WorkProvenanceEvent[]> {
  throwIfWorkProvenanceAborted(signal)
  const workspace = await resolveWorkProvenanceWorkspace(workspacePath, signal)
  if (!workspace) return []
  const directory = join(
    workspace.gitCommonDir,
    WORK_PROVENANCE_DIRECTORY,
    WORK_PROVENANCE_EVENTS_DIRECTORY
  )
  let names: string[]
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort()
    throwIfWorkProvenanceAborted(signal)
  } catch (error) {
    throwIfWorkProvenanceAborted(signal)
    return []
  }
  const events: WorkProvenanceEvent[] = []
  for (const name of names) {
    try {
      throwIfWorkProvenanceAborted(signal)
      const eventPath = join(directory, name)
      const stat = await fs.lstat(eventPath)
      throwIfWorkProvenanceAborted(signal)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_FILE_BYTES) continue
      const parsed = JSON.parse(await fs.readFile(eventPath, { encoding: 'utf8', signal }))
      throwIfWorkProvenanceAborted(signal)
      if (
        parsed?.schemaVersion === WORK_PROVENANCE_SCHEMA_VERSION &&
        typeof parsed?.eventId === 'string' &&
        typeof parsed?.recordedAt === 'string' &&
        validWorkProvenanceEventShape(parsed)
      ) {
        events.push(parsed as WorkProvenanceEvent)
      }
    } catch (error) {
      throwIfWorkProvenanceAborted(signal)
      // One corrupt local receipt must not hide the remaining immutable events.
    }
  }
  return events.sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) || left.eventId.localeCompare(right.eventId)
  )
}

function validWorkProvenanceEventShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  const workspace = event.workspace as Record<string, unknown> | undefined
  const after = event.after as Record<string, unknown> | undefined
  const recovery = event.recovery as Record<string, unknown> | undefined
  if (event.kind === 'origin') {
    return (
      safeWorkProvenanceEventPath(event.path) &&
      typeof workspace?.repositoryId === 'string' &&
      typeof workspace?.worktreeId === 'string' &&
      Boolean(after)
    )
  }
  if (event.kind === 'resolution') return typeof event.originEventId === 'string'
  return (
    event.kind === 'recovery' &&
    typeof event.originEventId === 'string' &&
    event.eventId ===
      `recovery-${createHash('sha256').update(event.originEventId).digest('hex')}` &&
    typeof recovery?.ref === 'string' &&
    WORK_PROVENANCE_RECOVERY_REF_RE.test(recovery.ref) &&
    typeof recovery?.commit === 'string' &&
    /^[a-f0-9]{40,64}$/.test(recovery.commit) &&
    typeof recovery?.tree === 'string' &&
    /^[a-f0-9]{40,64}$/.test(recovery.tree)
  )
}

function safeWorkProvenanceEventPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes('\0') &&
    !isAbsolute(value) &&
    !value.split('/').includes('..') &&
    value !== '.git' &&
    !value.startsWith('.git/')
  )
}

function oneShotOperation(
  capture: (
    outcome: string,
    signal: AbortSignal | undefined
  ) => Promise<CapturedWorkProvenance | null>,
  logError?: (scope: string, error: unknown) => void
): WorkProvenanceOperation {
  let captured: Promise<CapturedWorkProvenance | null> | null = null
  return {
    capture(outcome) {
      if (!captured) {
        const signal = currentWorkProvenanceAbortSignal()
        if (signal?.aborted) {
          captured = Promise.resolve(null)
          return captured
        }
        const attempt = capture(outcome, signal).then((result) => {
          throwIfWorkProvenanceAborted(signal)
          return result
        })
        captured = waitForWorkProvenancePromise(attempt, signal).catch((error) => {
          if (!workProvenanceWasAborted(signal, error)) {
            logError?.('capture work provenance', error)
          }
          return null
        })
      }
      return captured
    }
  }
}

/**
 * Bound provenance work at provider/lock seams. The deadline aborts cooperative
 * ledger I/O before releasing the caller; any non-cancellable syscall still
 * has its late rejection observed here rather than becoming a provider failure.
 */
export async function settleWorkProvenanceWithin<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = WORK_PROVENANCE_OPERATION_TIMEOUT_MS
): Promise<T | null> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const work = Promise.resolve()
    .then(() =>
      workProvenanceAbortContext.run(controller.signal, () => operation(controller.signal))
    )
    .catch(() => null)
  const timeout = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(
      () => {
        controller.abort(new Error('Work provenance operation exceeded its deadline.'))
        resolveTimeout(null)
      },
      Math.max(1, Math.floor(timeoutMs))
    )
    timer.unref?.()
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function currentWorkProvenanceAbortSignal(): AbortSignal | undefined {
  return workProvenanceAbortContext.getStore()
}

function throwIfWorkProvenanceAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

function workProvenanceWasAborted(signal: AbortSignal | undefined, error: unknown): boolean {
  return (
    signal?.aborted === true ||
    (error !== null &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  )
}

async function waitForWorkProvenancePromise<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) {
    // The producer may already have started before its caller noticed the
    // deadline. Observe its eventual rejection even though no consumer should
    // wait for it now.
    void pending.catch(() => undefined)
    throwIfWorkProvenanceAborted(signal)
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function uniqueTargets(targets: readonly WorkProvenanceTarget[]): WorkProvenanceTarget[] {
  const byKey = new Map<string, WorkProvenanceTarget>()
  for (const target of targets) {
    if (!target?.path) continue
    const normalized: WorkProvenanceTarget = {
      path: resolve(target.path),
      kind: target.kind,
      ...(target.hunk ? { hunk: { ...target.hunk } } : {})
    }
    const key = JSON.stringify([
      normalized.path,
      normalized.kind,
      normalized.hunk?.baseline || '',
      normalized.hunk?.startLine ?? -1,
      normalized.hunk?.endLine ?? -1
    ])
    byKey.set(key, normalized)
  }
  return [...byKey.values()]
}

function normalizeActor(actor: WorkProvenanceActor): WorkProvenanceActor {
  const normalized: WorkProvenanceActor = {}
  for (const [key, value] of Object.entries(actor)) {
    const text = boundedText(value)
    if (text) Object.assign(normalized, { [key]: text })
  }
  return normalized
}

function normalizeAuthority(
  authority: NonNullable<WorkProvenanceOriginEvent['authority']>
): NonNullable<WorkProvenanceOriginEvent['authority']> {
  const leaseIds = [...new Set(authority.leaseIds || [])]
    .map((leaseId) => boundedText(leaseId))
    .filter((leaseId): leaseId is string => Boolean(leaseId))
    .slice(0, 1_000)
  return {
    ...(boundedText(authority.lockOwnerId)
      ? { lockOwnerId: boundedText(authority.lockOwnerId) }
      : {}),
    ...(boundedText(authority.authorityInstanceId)
      ? { authorityInstanceId: boundedText(authority.authorityInstanceId) }
      : {}),
    ...(boundedText(authority.acquisitionTransitionId)
      ? { acquisitionTransitionId: boundedText(authority.acquisitionTransitionId) }
      : {}),
    ...(leaseIds.length ? { leaseIds } : {})
  }
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/[\0\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized ? normalized.slice(0, MAX_EVENT_TEXT) : undefined
}

async function repositoryRelativePath(
  root: string,
  targetPath: string,
  signal: AbortSignal | undefined
): Promise<string | null> {
  throwIfWorkProvenanceAborted(signal)
  const absoluteTarget = await physicalPlannedPath(resolve(targetPath), signal)
  const candidate = relative(root, absoluteTarget)
  if (
    !candidate ||
    candidate === '..' ||
    candidate.startsWith(`..${sep}`) ||
    isAbsolute(candidate)
  ) {
    return null
  }
  return candidate.split(sep).join('/')
}

/** Resolve existing ancestors so lexical aliases such as macOS /var -> /private do not escape. */
async function physicalPlannedPath(
  inputPath: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const missingSegments: string[] = []
  let cursor = resolve(inputPath)
  while (true) {
    try {
      throwIfWorkProvenanceAborted(signal)
      const physical = await fs.realpath(cursor)
      throwIfWorkProvenanceAborted(signal)
      return resolve(physical, ...missingSegments.reverse())
    } catch (error) {
      throwIfWorkProvenanceAborted(signal)
      if (!isErrno(error, 'ENOENT')) throw error
      const parent = dirname(cursor)
      if (parent === cursor) return resolve(inputPath)
      missingSegments.push(basename(cursor))
      cursor = parent
    }
  }
}

function isGitMetadataPath(relativePath: string): boolean {
  return relativePath === '.git' || relativePath.startsWith('.git/')
}

async function captureDirtyTargetPaths(
  workspace: WorkProvenanceWorkspaceIdentity,
  relativePaths: readonly string[],
  signal: AbortSignal | undefined
): Promise<Set<string> | null> {
  const result = await runGit(
    workspace.root,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...relativePaths],
    signal
  )
  throwIfWorkProvenanceAborted(signal)
  if (result.code !== 0) return null
  return new Set(parseStatusPaths(result.stdout))
}

async function captureDirtyWorkspace(
  workspace: WorkProvenanceWorkspaceIdentity,
  maxPaths: number,
  signal: AbortSignal | undefined
): Promise<DirtyWorkspaceSnapshot> {
  const result = await runGit(
    workspace.root,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    signal
  )
  throwIfWorkProvenanceAborted(signal)
  if (result.code !== 0) throw new Error('Git status could not be sampled for provenance.')
  const paths = parseStatusPaths(result.stdout).filter((path) => !isGitMetadataPath(path))
  const selected = paths.slice(0, maxPaths)
  const entries = new Map<string, WorkProvenancePathFingerprint>()
  for (const relativePath of selected) {
    throwIfWorkProvenanceAborted(signal)
    entries.set(relativePath, await fingerprintPath(resolve(workspace.root, relativePath), signal))
  }
  throwIfWorkProvenanceAborted(signal)
  return { entries, truncated: paths.length > selected.length }
}

function parseStatusPaths(statusOutput: string): string[] {
  const fields = statusOutput.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const status = field.slice(0, 2)
    const currentPath = field.slice(3)
    if (currentPath) paths.push(currentPath.split('\\').join('/'))
    if ((status[0] === 'R' || status[0] === 'C') && fields[index + 1]) index += 1
  }
  return [...new Set(paths)].sort()
}

async function fingerprintPath(
  targetPath: string,
  signal: AbortSignal | undefined
): Promise<WorkProvenancePathFingerprint> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      throwIfWorkProvenanceAborted(signal)
      const before = await fs.lstat(targetPath)
      throwIfWorkProvenanceAborted(signal)
      let fingerprint: WorkProvenancePathFingerprint
      if (before.isFile()) {
        fingerprint = {
          state: 'file',
          sha256: await sha256File(targetPath, signal),
          sizeBytes: before.size
        }
      } else if (before.isSymbolicLink()) {
        const linkTarget = await fs.readlink(targetPath)
        throwIfWorkProvenanceAborted(signal)
        fingerprint = {
          state: 'symlink',
          linkTarget,
          sha256: createHash('sha256').update(linkTarget).digest('hex')
        }
      } else if (before.isDirectory()) {
        fingerprint = { state: 'directory' }
      } else {
        fingerprint = { state: 'other' }
      }
      const after = await fs.lstat(targetPath)
      throwIfWorkProvenanceAborted(signal)
      if (sameStatIdentity(before, after)) return fingerprint
    } catch (error) {
      throwIfWorkProvenanceAborted(signal)
      if (isErrno(error, 'ENOENT')) return { state: 'missing' }
      if (attempt === 1) return { state: 'unreadable' }
    }
  }
  return { state: 'unstable' }
}

function sameStatIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function sameFingerprint(
  left: WorkProvenancePathFingerprint,
  right: WorkProvenancePathFingerprint
): boolean {
  return (
    left.state === right.state &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.linkTarget === right.linkTarget
  )
}

async function sha256File(filePath: string, signal: AbortSignal | undefined): Promise<string> {
  throwIfWorkProvenanceAborted(signal)
  const digest = await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { signal })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
  throwIfWorkProvenanceAborted(signal)
  return digest
}

function runGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal | undefined
): Promise<RunGitResult> {
  throwIfWorkProvenanceAborted(signal)
  return new Promise((resolveResult, reject) => {
    try {
      execFile(
        'git',
        ['-c', 'core.fsmonitor=false', ...args],
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          maxBuffer: GIT_MAX_BUFFER,
          timeout: GIT_TIMEOUT_MS,
          shell: false,
          signal
        },
        (error, stdout) => {
          if (signal?.aborted) {
            reject(signal.reason)
            return
          }
          resolveResult({
            code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
            stdout: stdout || ''
          })
        }
      )
    } catch (error) {
      reject(error)
    }
  })
}

async function ensureEventsDirectory(
  gitCommonDir: string,
  signal: AbortSignal | undefined
): Promise<string> {
  const base = resolve(gitCommonDir)
  const taskWraithDirectory = join(base, 'taskwraith')
  const provenanceDirectory = join(taskWraithDirectory, 'work-provenance-v1')
  const eventsDirectory = join(provenanceDirectory, WORK_PROVENANCE_EVENTS_DIRECTORY)
  for (const directory of [taskWraithDirectory, provenanceDirectory, eventsDirectory]) {
    try {
      throwIfWorkProvenanceAborted(signal)
      const stat = await fs.lstat(directory)
      throwIfWorkProvenanceAborted(signal)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Work provenance path is not a physical directory: ${directory}`)
      }
    } catch (error) {
      throwIfWorkProvenanceAborted(signal)
      if (!isErrno(error, 'ENOENT')) throw error
      try {
        await fs.mkdir(directory, { mode: 0o700 })
      } catch (mkdirError) {
        throwIfWorkProvenanceAborted(signal)
        if (!isErrno(mkdirError, 'EEXIST')) throw mkdirError
      }
      throwIfWorkProvenanceAborted(signal)
      const created = await fs.lstat(directory)
      throwIfWorkProvenanceAborted(signal)
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`Work provenance path is not a physical directory: ${directory}`)
      }
    }
    await fs.chmod(directory, 0o700).catch(() => undefined)
    throwIfWorkProvenanceAborted(signal)
  }
  return eventsDirectory
}

async function writeImmutableEvent(
  eventsDirectory: string,
  event: WorkProvenanceEvent,
  signal: AbortSignal | undefined
): Promise<void> {
  const safeId = event.eventId.replace(/[^A-Za-z0-9._-]+/g, '-')
  const destination = join(eventsDirectory, `${safeId}.json`)
  const temporary = join(eventsDirectory, `.${safeId}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  let published = false
  try {
    throwIfWorkProvenanceAborted(signal)
    handle = await fs.open(temporary, 'wx', 0o600)
    throwIfWorkProvenanceAborted(signal)
    await handle.writeFile(`${JSON.stringify(event, null, 2)}\n`, 'utf8')
    throwIfWorkProvenanceAborted(signal)
    await handle.sync()
    throwIfWorkProvenanceAborted(signal)
    await handle.close()
    handle = null
    throwIfWorkProvenanceAborted(signal)
    try {
      // Linking a fully-fsynced temporary file publishes the receipt without
      // ever replacing an existing event with the same identity. Independent
      // writers therefore need no shared append lock or mutable sequence.
      await fs.link(temporary, destination)
      published = true
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      throwIfWorkProvenanceAborted(signal)
      const existing = await fs.readFile(destination, { encoding: 'utf8', signal })
      throwIfWorkProvenanceAborted(signal)
      const candidate = `${JSON.stringify(event, null, 2)}\n`
      let equivalent = existing === candidate
      if (!equivalent) {
        try {
          equivalent = isDeepStrictEqual(
            eventIdentityPayload(JSON.parse(existing)),
            eventIdentityPayload(event)
          )
        } catch {
          equivalent = false
        }
      }
      if (!equivalent) {
        throw new Error(`Work provenance event identity collision: ${event.eventId}`)
      }
      published = true
    }
    // Publication is the commit point. Once the immutable destination exists,
    // finish its directory durability and temporary cleanup even if the caller's
    // deadline expires while link(2) is returning.
    try {
      const directoryHandle = await fs.open(eventsDirectory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch {
      // Some filesystems reject directory fsync; the immutable link still wins.
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    if (!published) throwIfWorkProvenanceAborted(signal)
  }
}

function eventIdentityPayload(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const { recordedAt: _recordedAt, ...identity } = event as Record<string, unknown>
  if (identity.kind === 'recovery' && identity.recovery && typeof identity.recovery === 'object') {
    const { pinnedAt: _pinnedAt, ...recoveryIdentity } = identity.recovery as Record<
      string,
      unknown
    >
    return { ...identity, recovery: recoveryIdentity }
  }
  return identity
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}
