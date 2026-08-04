/**
 * CanvasService — the trusted main-process orchestrator behind the canvas_*
 * MCP tools. Owns the live session registry, routes to a driver, persists
 * session records + audit events, and broadcasts events to the renderer.
 *
 * It implements {@link CanvasController}; the MCP executor depends on that
 * interface, so the service can be swapped for a fake in tests. Drivers are
 * injected via `createDriver` for the same reason (the real `web` driver needs
 * Electron, which vitest does not provide).
 *
 * Audit discipline: every action appends a CanvasEventRecord whose `detail` is
 * REDACTED metadata only — a screenshot records `{ frameHash, width, height }`,
 * never the PNG bytes; network/console record counts, not bodies.
 */
import { createHash } from 'crypto'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasAnnotation,
  CanvasController,
  CanvasCallContext,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasDriverKind,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasEventKind,
  CanvasEventRecord,
  CanvasFrame,
  CanvasInspectInput,
  CanvasMark,
  CanvasNavigateInput,
  CanvasNavState,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSessionRecord,
  CanvasSessionSummary,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasViewport,
  CanvasWindowOpenTarget
} from './canvasTypes'
import { assertCanvasEvalApprovalReceipt } from './CanvasEvalAudit'
import {
  isValidBundleId,
  redactUrlQuery,
  resolveViewport,
  validateCanvasHtml,
  validateCanvasImageRef,
  validateCanvasUrl
} from './canvasTypes'
import type { CanvasStore } from './CanvasStore'

export interface CanvasServiceDeps {
  createDriver: (
    kind: CanvasDriverKind,
    sessionId: string,
    opts?: {
      embedded?: boolean
      /** Canonical main-owned chat authority for content-addressed image reads. */
      appChatId?: string
      /** Canonical main-owned run authority for a native-window target. */
      appRunId?: string
      /** Opaque main-owned native-window lease; never sourced from canvas_open. */
      windowTarget?: CanvasWindowOpenTarget
      initialSketchDocument?: CanvasSketchDocument
      onSketchDocumentChange?: (document: CanvasSketchDocument) => void
      /** Live browser-chrome state stream for the web driver (ephemeral). */
      onNavState?: (state: CanvasNavState) => void
      /** Committed main-frame / in-page navigation (url settled). */
      onNavigationCommitted?: (state: CanvasNavState) => void
    }
  ) => CanvasDriver
  store: CanvasStore
  uuid: () => string
  now: () => string
  /** Broadcast an audit event to the renderer (already persisted by the service). */
  broadcast?: (event: CanvasEventRecord) => void
  /**
   * Push ephemeral browser-chrome state (address bar / back-forward / spinner)
   * to the renderer. NEVER persisted here: the durable record keeps only the
   * query-redacted URL + title via the committed-navigation path.
   */
  broadcastNavState?: (payload: CanvasNavStateBroadcast) => void
  logger?: Pick<Console, 'warn' | 'error'>
  maxInteractionsPerSession?: number
  maxEvalsPerSession?: number
  historyParticipants?: readonly CanvasHistoryParticipant[]
}

export interface CanvasNavStateBroadcast {
  canvasId: string
  chatId?: string
  workspacePath?: string
  state: CanvasNavState
}

interface LiveSession {
  driver: CanvasDriver
  record: CanvasSessionRecord
  interactions: number
  evals: number
  generation: number
}

interface PendingOpen {
  driver: CanvasDriver
  record: CanvasSessionRecord
  ctx: CanvasCallContext
  generation: number
  settled: Promise<void>
  markSettled: () => void
}

interface ClosingSession {
  session: LiveSession
  ctx: CanvasCallContext
  closePromise: Promise<void>
}

export interface CanvasHistoryAuthority {
  chatIds?: Iterable<string>
  workspacePaths?: Iterable<string>
}

/**
 * A durable surface that participates in the same history-clear transaction as
 * Canvas. It receives the exact main-owned authority and raises/releases its
 * own admission hold synchronously with Canvas rather than being purged later
 * by a best-effort side channel.
 */
export interface CanvasHistoryParticipant {
  beginAuthorityHistoryClear(input: CanvasHistoryAuthority): Promise<void>
  endAuthorityHistoryClear(input: CanvasHistoryAuthority): void
  beginHistoryClear(): Promise<void>
  endHistoryClear(): void
}

const SUPPORTED_DRIVERS: ReadonlySet<CanvasDriverKind> = new Set([
  'web',
  'html',
  'image',
  'sketch',
  'device',
  'window'
])
// Defence-in-depth cap so a hijacked agent (or a session-granted approval)
// cannot machine-gun clicks/fills against a live app. Per live session.
const MAX_INTERACTIONS_PER_SESSION = 200
// Eval is RCE and human-approved per call, but cap it anyway so a compromised
// approve-loop can't run unbounded scripts. Separate, tighter budget.
const MAX_EVALS_PER_SESSION = 50

function canonicalAuthority(value: unknown): string | undefined {
  return typeof value === 'string' && Boolean(value) && value.trim() === value ? value : undefined
}

function canonicalWindowTarget(value: unknown): CanvasWindowOpenTarget | undefined {
  const leaseId = canonicalAuthority((value as Partial<CanvasWindowOpenTarget> | null)?.leaseId)
  return leaseId ? Object.freeze({ leaseId }) : undefined
}

function toSummary(record: CanvasSessionRecord): CanvasSessionSummary {
  return {
    canvasId: record.id,
    driver: record.driver,
    url: record.url,
    title: record.title,
    status: record.status,
    viewport: record.viewport,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}

function canvasOpenAuditError(error: unknown): { code: string; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const lower = raw.toLowerCase()
  const code = lower.includes('timed out')
    ? 'navigation_timeout'
    : lower.includes('dns') || lower.includes('private') || lower.includes('ssrf')
      ? 'network_policy_rejected'
      : lower.includes('navigation failed') || lower.includes('load')
        ? 'navigation_failed'
        : 'open_failed'
  return { code, message: `Canvas open failed (${code}).` }
}

function canvasTargetAudit(args: {
  ref?: string
  selector?: string
  expectedObservationId?: string
  expectedInputEpoch?: number
}): Record<string, unknown> {
  const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
  return {
    targetKind: args.ref ? 'ref' : args.selector ? 'selector' : 'none',
    ...(args.ref ? { targetHash: digest(args.ref) } : {}),
    ...(!args.ref && args.selector ? { targetHash: digest(args.selector) } : {}),
    // Native actions require both conditions. They contain no typed value and
    // make the strict pre-dispatch intent receipt reconstructible after a run.
    ...(args.expectedObservationId ? { expectedObservationId: args.expectedObservationId } : {}),
    ...(Number.isSafeInteger(args.expectedInputEpoch)
      ? { expectedInputEpoch: args.expectedInputEpoch }
      : {})
  }
}

export class CanvasService implements CanvasController {
  private readonly sessions = new Map<string, LiveSession>()
  private readonly pendingOpens = new Map<string, PendingOpen>()
  private readonly closingSessions = new Map<string, ClosingSession>()
  private readonly failedCloses = new Map<
    string,
    { session: LiveSession; ctx: CanvasCallContext }
  >()
  private readonly canvasGenerations = new Map<string, number>()
  private generation = 0
  private purging = false
  private purgeInFlight: Promise<void> | null = null
  private historyClearHolds = 0
  private readonly chatHistoryClearHolds = new Map<string, number>()
  private readonly workspaceHistoryClearHolds = new Map<string, number>()
  private readonly chatHistoryRevisions = new Map<string, number>()
  private readonly workspaceHistoryRevisions = new Map<string, number>()
  private historyStoreMutationQueue: Promise<void> = Promise.resolve()
  private readonly scopedClearOperations = new Set<Promise<void>>()

  constructor(private readonly deps: CanvasServiceDeps) {}

  private enqueueHistoryStoreMutation(task: () => void | Promise<void>): Promise<void> {
    const result = this.historyStoreMutationQueue.then(task, task)
    this.historyStoreMutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private normalizedAuthority(input: CanvasHistoryAuthority): {
    chatIds: Set<string>
    workspacePaths: Set<string>
  } {
    return {
      chatIds: new Set([...(input.chatIds ?? [])].map((value) => value.trim()).filter(Boolean)),
      workspacePaths: new Set(
        [...(input.workspacePaths ?? [])].map((value) => value.trim()).filter(Boolean)
      )
    }
  }

  private contextHistoryBlocked(ctx: CanvasCallContext): boolean {
    return Boolean(
      this.purging ||
        (ctx.chatId && (this.chatHistoryClearHolds.get(ctx.chatId) ?? 0) > 0) ||
        (ctx.workspacePath &&
          (this.workspaceHistoryClearHolds.get(ctx.workspacePath) ?? 0) > 0)
    )
  }

  private captureHistoryRevision(ctx: CanvasCallContext): {
    chat: number
    workspace: number
  } {
    return {
      chat: ctx.chatId ? (this.chatHistoryRevisions.get(ctx.chatId) ?? 0) : 0,
      workspace: ctx.workspacePath
        ? (this.workspaceHistoryRevisions.get(ctx.workspacePath) ?? 0)
        : 0
    }
  }

  private historyRevisionChanged(
    ctx: CanvasCallContext,
    captured: { chat: number; workspace: number }
  ): boolean {
    return Boolean(
      (ctx.chatId && (this.chatHistoryRevisions.get(ctx.chatId) ?? 0) !== captured.chat) ||
        (ctx.workspacePath &&
          (this.workspaceHistoryRevisions.get(ctx.workspacePath) ?? 0) !== captured.workspace)
    )
  }

  private recordMatchesAuthority(
    record: CanvasSessionRecord,
    authority: { chatIds: Set<string>; workspacePaths: Set<string> }
  ): boolean {
    return Boolean(
      (record.chatId && authority.chatIds.has(record.chatId)) ||
        (record.workspacePath && authority.workspacePaths.has(record.workspacePath))
    )
  }

  private assertLiveAfterAwait(
    canvasId: string,
    session: LiveSession,
    ctx: CanvasCallContext,
    operation: string
  ): void {
    if (
      this.contextHistoryBlocked(ctx) ||
      session.generation !== this.generation ||
      this.canvasGenerations.get(canvasId) !== session.generation ||
      this.sessions.get(canvasId) !== session
    ) {
      throw new Error(`Canvas ${operation} was cancelled because history was cleared.`)
    }
  }

  private async settleAndClosePendingOpen(
    canvasId: string,
    open: PendingOpen,
    reason: string
  ): Promise<void> {
    try {
      await open.driver.close()
    } catch (error) {
      this.deps.logger?.warn?.(
        `canvas: initial pending driver close failed ${reason} for ${canvasId}: ${String(error)}`
      )
    }
    // This await is unconditional: a driver that cannot abort its underlying
    // platform open may acquire a resource after the first close returns.
    await open.settled
    try {
      await open.driver.close()
    } catch (error) {
      this.deps.logger?.warn?.(
        `canvas: final pending driver close failed ${reason} for ${canvasId}: ${String(error)}`
      )
      throw new Error(`Canvas pending resource could not be closed ${reason}.`)
    }
  }

  private async retryFailedClose(
    canvasId: string,
    entry: { session: LiveSession; ctx: CanvasCallContext }
  ): Promise<void> {
    await entry.session.driver.close()
    if (this.failedCloses.get(canvasId) === entry) {
      this.failedCloses.delete(canvasId)
      if (this.canvasGenerations.get(canvasId) === entry.session.generation) {
        this.canvasGenerations.delete(canvasId)
      }
    }
  }

  private async closeRetiredSession(
    canvasId: string,
    session: LiveSession,
    ctx: CanvasCallContext
  ): Promise<void> {
    try {
      await session.driver.close()
    } catch (error) {
      this.failedCloses.set(canvasId, { session, ctx })
      throw error
    }
  }

  private emit(
    canvasId: string,
    kind: CanvasEventKind,
    ctx: CanvasCallContext,
    detail?: Record<string, unknown>
  ): void {
    if (this.canvasGenerations.get(canvasId) !== this.generation) return
    const event: CanvasEventRecord = {
      schemaVersion: 1,
      id: this.deps.uuid(),
      canvasId,
      kind,
      provider: ctx.provider,
      chatId: ctx.chatId,
      workspacePath: ctx.workspacePath,
      runId: ctx.runId,
      approvalId: ctx.canvasEvalApproval?.approvalId,
      detail,
      createdAt: this.deps.now()
    }
    try {
      this.deps.store.appendEvent(event)
    } catch (err) {
      this.deps.logger?.warn?.(`canvas: failed to persist event ${kind}: ${String(err)}`)
    }
    try {
      this.deps.broadcast?.(event)
    } catch {
      // Renderer may be gone — events are already persisted.
    }
  }

  /**
   * Signed-elevated audit write. Unlike ordinary canvas telemetry this must
   * propagate persistence failures so execution can fail closed.
   */
  private emitStrict(
    canvasId: string,
    kind: CanvasEventKind,
    ctx: CanvasCallContext,
    detail?: Record<string, unknown>
  ): void {
    if (this.canvasGenerations.get(canvasId) !== this.generation) {
      throw new Error('Canvas operation belongs to an expired history generation.')
    }
    const event: CanvasEventRecord = {
      schemaVersion: 1,
      id: this.deps.uuid(),
      canvasId,
      kind,
      provider: ctx.provider,
      chatId: ctx.chatId,
      workspacePath: ctx.workspacePath,
      runId: ctx.runId,
      approvalId: ctx.canvasEvalApproval?.approvalId,
      detail,
      createdAt: this.deps.now()
    }
    this.deps.store.appendEventStrict(event)
    try {
      this.deps.broadcast?.(event)
    } catch {
      // Durability, not renderer availability, is the execution gate.
    }
  }

  /**
   * Ordinary Canvas sessions remain chat-scoped for compatibility. A native
   * window is an actuation capability and is reachable only from the exact
   * canonical chat AND run that adopted it; legacy/incomplete window records
   * therefore fail closed.
   */
  private owns(record: CanvasSessionRecord, ctx: CanvasCallContext): boolean {
    const sameChat = (record.chatId ?? null) === (ctx.chatId ?? null)
    if (record.driver !== 'window') return sameChat
    const chatId = canonicalAuthority(record.chatId)
    const runId = canonicalAuthority(record.runId)
    return (
      Boolean(chatId && runId) &&
      chatId === canonicalAuthority(ctx.chatId) &&
      runId === canonicalAuthority(ctx.runId)
    )
  }

  private require(canvasId: string, ctx: CanvasCallContext): LiveSession {
    if (this.contextHistoryBlocked(ctx)) {
      throw new Error('Canvas history is being cleared; try again afterwards.')
    }
    const session = this.sessions.get(canvasId)
    if (
      !session ||
      session.generation !== this.generation ||
      this.canvasGenerations.get(canvasId) !== session.generation ||
      !this.owns(session.record, ctx)
    ) {
      // Same message whether absent or cross-chat — never reveal another chat's id.
      throw new Error(`No open canvas with id "${canvasId}". Call canvas_open first.`)
    }
    return session
  }

  private sketchScope(ctx: CanvasCallContext): string {
    if (ctx.chatId) return `chat:${ctx.chatId}`
    if (ctx.workspacePath) return `workspace:${ctx.workspacePath}`
    return 'global'
  }

  private persistSketchDocument(scope: string, document: CanvasSketchDocument): void {
    if (this.purging) return
    try {
      this.deps.store.upsertSketchDocument(scope, document)
    } catch (err) {
      this.deps.logger?.warn?.(`canvas: failed to persist sketch document: ${String(err)}`)
    }
  }

  /**
   * Keep the durable session record truthful as the web surface navigates —
   * whoever caused the navigation (tool verb, user link click, redirect). Only
   * the query-redacted URL + title are written, and only when they actually
   * changed, so an SPA's chatty in-page transitions don't grind the store.
   */
  private recordNavigationCommitted(
    canvasId: string,
    generation: number,
    ctx: CanvasCallContext,
    state: CanvasNavState
  ): void {
    if (
      generation !== this.generation ||
      this.canvasGenerations.get(canvasId) !== generation ||
      this.contextHistoryBlocked(ctx)
    ) {
      return
    }
    const session = this.sessions.get(canvasId)
    // During the initial load the session is still pending; open() writes the
    // settled record itself, so there is nothing to update yet.
    if (!session || session.generation !== generation) return
    const url = redactUrlQuery(state.url)
    const title = state.title
    if (session.record.url === url && session.record.title === title) return
    session.record = { ...session.record, url, title, updatedAt: this.deps.now() }
    try {
      this.deps.store.upsertSession(session.record)
    } catch (err) {
      this.deps.logger?.warn?.(`canvas: failed to persist navigation update: ${String(err)}`)
    }
  }

  async open(
    input: CanvasOpenInput,
    ctx: CanvasCallContext
  ): Promise<{ canvasId: string } & CanvasSessionHandle> {
    if (this.contextHistoryBlocked(ctx)) {
      throw new Error('Canvas history is being cleared; try again afterwards.')
    }
    const generation = this.generation
    const driverKind = input.driver ?? 'web'
    if (!SUPPORTED_DRIVERS.has(driverKind)) {
      throw new Error(`Canvas driver "${driverKind}" is not available in this build.`)
    }
    // Validate up front so a bad input never even spawns a window / boots a sim.
    let recordUrl: string
    let eventHost: string | undefined
    let imageAppChatId: string | undefined
    let windowAppChatId: string | undefined
    let windowAppRunId: string | undefined
    let windowTarget: CanvasWindowOpenTarget | undefined
    if (driverKind === 'window') {
      const chatId = canonicalAuthority(ctx.chatId)
      const runId = canonicalAuthority(ctx.runId)
      if (!chatId || !runId) {
        throw new Error('The window driver requires canonical chat and run authority.')
      }
      windowAppChatId = chatId
      windowAppRunId = runId
      windowTarget = canonicalWindowTarget(input.windowTarget)
      if (!windowTarget) {
        throw new Error('The window driver requires an internal native-window lease target.')
      }
      // Persist only a one-way, secret-free correlation id. The opaque lease id
      // remains in the factory dependency and never enters history or events.
      const digest = createHash('sha256').update(windowTarget.leaseId).digest('hex').slice(0, 20)
      recordUrl = `window://managed/${digest}`
      eventHost = undefined
    } else if (driverKind === 'device') {
      const bundleId = (input.bundleId || '').trim()
      if (!bundleId || !isValidBundleId(bundleId)) {
        throw new Error('The device driver requires a valid `bundleId` (e.g. "com.example.App").')
      }
      eventHost = (input.device?.udid || 'booted').trim()
      recordUrl = `device://${eventHost}/${bundleId}`
    } else if (driverKind === 'html') {
      // Agent-authored HTML/SVG. No URL / no host — it is rasterized offscreen
      // with scripts off and egress cut, so there is no SSRF surface to gate;
      // only validate the markup is present and within the size cap.
      const verdict = validateCanvasHtml(input.html ?? '')
      if (!verdict.ok) throw new Error(verdict.reason || 'Invalid canvas html.')
      // Stable, secret-free synthetic id for the audit record (never the markup).
      recordUrl = `html://${createHash('sha256').update(input.html ?? '').digest('hex').slice(0, 8)}`
      eventHost = undefined
    } else if (driverKind === 'image') {
      // Existing content-addressed image attachment. The hash is the only input;
      // the asset store's realpath jail resolves it (a bad hash -> error), so
      // there is no path / SSRF surface — just validate the ref shape.
      const sha256 = (input.mediaSha256 || '').trim()
      const verdict = validateCanvasImageRef(sha256, (input.mediaMimeType || '').trim())
      if (!verdict.ok) throw new Error(verdict.reason || 'Invalid image attachment.')
      if (
        typeof ctx.chatId !== 'string' ||
        !ctx.chatId ||
        ctx.chatId.trim() !== ctx.chatId
      ) {
        throw new Error('The image driver requires an active canonical chat authority.')
      }
      imageAppChatId = ctx.chatId
      // The content hash IS the safe, secret-free id for the audit record.
      recordUrl = `image://${sha256}`
      eventHost = undefined
    } else if (driverKind === 'sketch') {
      recordUrl = 'sketch://new'
      eventHost = undefined
    } else {
      const verdict = validateCanvasUrl((input.url || '').trim(), input.originAllowlist ?? [])
      if (!verdict.ok) throw new Error(verdict.reason || 'Canvas URL was rejected.')
      recordUrl = redactUrlQuery(verdict.normalizedUrl ?? (input.url || ''))
      eventHost = verdict.host
    }

    const canvasId = this.deps.uuid()
    this.canvasGenerations.set(canvasId, generation)
    const nowIso = this.deps.now()
    const viewport = resolveViewport({
      width: input.viewport?.width,
      height: input.viewport?.height
    })
    const baseRecord: CanvasSessionRecord = {
      schemaVersion: 1,
      id: canvasId,
      driver: driverKind,
      url: recordUrl,
      title: '',
      viewport,
      // The allowlist is live driver policy, not useful durable history. Never
      // persist arbitrary caller strings in the session record.
      originAllowlist: [],
      status: 'opening',
      chatId: ctx.chatId,
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
      createdAt: nowIso,
      updatedAt: nowIso
    }
    try {
      this.deps.store.upsertSession(baseRecord)
    } catch (error) {
      if (this.canvasGenerations.get(canvasId) === generation) {
        this.canvasGenerations.delete(canvasId)
      }
      throw error
    }

    // Embed is renderer-initiated (the multiview pane / right-dock canvas panel);
    // the agent's executor never sets it. Only the drivers with a live, hostable
    // surface can embed — web and sketch; html/image/device/window have no surface.
    const embedded = (driverKind === 'web' || driverKind === 'sketch') && input.embed === true
    const sketchScope = driverKind === 'sketch' ? this.sketchScope(ctx) : undefined
    let driver: CanvasDriver
    try {
      driver = this.deps.createDriver(driverKind, canvasId, {
        embedded,
        appChatId: imageAppChatId ?? windowAppChatId,
        ...(windowAppRunId ? { appRunId: windowAppRunId } : {}),
        ...(windowTarget ? { windowTarget } : {}),
        initialSketchDocument: sketchScope
          ? this.deps.store.getSketchDocument(sketchScope) ?? undefined
          : undefined,
        onSketchDocumentChange: sketchScope
          ? (document) => {
              if (
                generation === this.generation &&
                this.canvasGenerations.get(canvasId) === generation &&
                !this.contextHistoryBlocked(ctx)
              ) {
                this.persistSketchDocument(sketchScope, document)
              }
            }
          : undefined,
        ...(driverKind === 'web'
          ? {
              onNavState: (state: CanvasNavState) => {
                if (
                  generation !== this.generation ||
                  this.canvasGenerations.get(canvasId) !== generation ||
                  this.contextHistoryBlocked(ctx)
                ) {
                  return
                }
                try {
                  this.deps.broadcastNavState?.({
                    canvasId,
                    chatId: ctx.chatId,
                    workspacePath: ctx.workspacePath,
                    state
                  })
                } catch {
                  // Chrome state is advisory; the renderer may be gone.
                }
              },
              onNavigationCommitted: (state: CanvasNavState) => {
                this.recordNavigationCommitted(canvasId, generation, ctx, state)
              }
            }
          : {})
      })
    } catch (error) {
      if (this.canvasGenerations.get(canvasId) === generation) {
        this.canvasGenerations.delete(canvasId)
      }
      const auditError = canvasOpenAuditError(error)
      try {
        this.deps.store.upsertSession({
          ...baseRecord,
          status: 'error',
          error: auditError.message,
          updatedAt: this.deps.now()
        })
      } catch {
        // Preserve the construction failure; the store may itself be unavailable.
      }
      throw error
    }
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve
    })
    const pendingOpen: PendingOpen = {
      driver,
      record: baseRecord,
      ctx,
      generation,
      settled,
      markSettled
    }
    this.pendingOpens.set(canvasId, pendingOpen)
    try {
      const handle = await driver.open(
        driverKind === 'window' ? { driver: 'window', viewport } : input
      )
      if (
        generation !== this.generation ||
        this.canvasGenerations.get(canvasId) !== generation ||
        this.pendingOpens.get(canvasId) !== pendingOpen ||
        this.contextHistoryBlocked(ctx)
      ) {
        throw new Error('Canvas open was cancelled because history was cleared.')
      }
      const record: CanvasSessionRecord = {
        ...baseRecord,
        status: 'active',
        // Never trust a native bridge response to supply a durable URL. Its
        // only record identity is the service-minted lease digest above.
        url: driverKind === 'window' ? recordUrl : redactUrlQuery(handle.url),
        title: handle.title,
        viewport: handle.viewport,
        updatedAt: this.deps.now()
      }
      // Persist the active record before publishing the live registry entry.
      // A strict store failure therefore cannot leave a closed-but-reachable
      // session in list/status/require.
      this.deps.store.upsertSession(record)
      this.pendingOpens.delete(canvasId)
      this.sessions.set(canvasId, { driver, record, interactions: 0, evals: 0, generation })
      this.emit(canvasId, 'session.opened', ctx, {
        driver: driverKind,
        host: eventHost,
        url: driverKind === 'window' ? recordUrl : redactUrlQuery(handle.url)
      })
      return {
        canvasId,
        ...handle,
        url: driverKind === 'window' ? recordUrl : handle.url
      }
    } catch (err) {
      this.sessions.delete(canvasId)
      const auditError = canvasOpenAuditError(err)
      if (
        generation === this.generation &&
        this.canvasGenerations.get(canvasId) === generation &&
        !this.contextHistoryBlocked(ctx)
      ) {
        try {
          this.deps.store.upsertSession({
            ...baseRecord,
            status: 'error',
            error: auditError.message,
            updatedAt: this.deps.now()
          })
          this.emit(canvasId, 'session.error', ctx, { errorCode: auditError.code })
        } catch {
          // Never let audit persistence failure skip driver containment or
          // replace the original open failure.
        }
      }
      let closeFailed = false
      try {
        await driver.close()
      } catch (closeError) {
        closeFailed = true
        // A failed open can still have acquired a BrowserWindow, simulator, or
        // temporary screenshot resource before rejecting. Keep that driver in
        // the same retry registry as an ordinary failed close so a later
        // scoped/global clear cannot false-green while the resource survives.
        this.failedCloses.set(canvasId, {
          session: {
            driver,
            record: baseRecord,
            interactions: 0,
            evals: 0,
            generation
          },
          ctx
        })
        this.deps.logger?.warn?.(
          `canvas: failed-open driver close failed for ${canvasId}: ${String(closeError)}`
        )
      }
      if (!closeFailed && this.canvasGenerations.get(canvasId) === generation) {
        this.canvasGenerations.delete(canvasId)
      }
      throw err
    } finally {
      if (this.pendingOpens.get(canvasId) === pendingOpen) {
        this.pendingOpens.delete(canvasId)
      }
      pendingOpen.markSettled()
    }
  }

  /** Summary of a LIVE session, enriched with browser-chrome state when available. */
  private liveSummary(session: LiveSession): CanvasSessionSummary {
    const summary = toSummary(session.record)
    if (session.record.driver === 'web') {
      try {
        const nav = session.driver.navState?.()
        if (nav) {
          summary.isLoading = nav.isLoading
          summary.canGoBack = nav.canGoBack
          summary.canGoForward = nav.canGoForward
        }
      } catch {
        // Surface may be tearing down; the plain record summary still stands.
      }
    }
    return summary
  }

  list(ctx: CanvasCallContext): CanvasSessionSummary[] {
    if (this.contextHistoryBlocked(ctx)) return []
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.generation === this.generation &&
          this.canvasGenerations.get(session.record.id) === session.generation &&
          this.owns(session.record, ctx)
      )
      .map((session) => this.liveSummary(session))
  }

  status(canvasId: string, ctx: CanvasCallContext): CanvasSessionSummary | null {
    if (this.contextHistoryBlocked(ctx)) return null
    const live = this.sessions.get(canvasId)
    if (
      live &&
      live.generation === this.generation &&
      this.canvasGenerations.get(canvasId) === live.generation
    ) {
      return this.owns(live.record, ctx) ? this.liveSummary(live) : null
    }
    const persisted = this.deps.store.getSession(canvasId)
    return persisted && this.owns(persisted, ctx) ? toSummary(persisted) : null
  }

  async snapshot(canvasId: string, ctx: CanvasCallContext): Promise<CanvasElementTree> {
    const session = this.require(canvasId, ctx)
    const tree = await session.driver.snapshot()
    this.assertLiveAfterAwait(canvasId, session, ctx, 'snapshot')
    this.emit(canvasId, 'snapshot', ctx, {
      nodeCount: tree.nodeCount,
      url: redactUrlQuery(tree.url)
    })
    return tree
  }

  async screenshot(canvasId: string, ctx: CanvasCallContext): Promise<CanvasFrame> {
    const session = this.require(canvasId, ctx)
    const frame = await session.driver.screenshot()
    this.assertLiveAfterAwait(canvasId, session, ctx, 'screenshot')
    this.emit(canvasId, 'screenshot', ctx, {
      frameHash: frame.hash,
      width: frame.width,
      height: frame.height,
      byteLength: frame.byteLength
    })
    return frame
  }

  async inspect(
    canvasId: string,
    args: CanvasInspectInput,
    ctx: CanvasCallContext
  ): Promise<CanvasElementDetail> {
    const session = this.require(canvasId, ctx)
    const detail = await session.driver.inspect(args)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'inspect')
    this.emit(canvasId, 'inspect', ctx, {
      ...canvasTargetAudit(args),
      found: detail.found
    })
    return detail
  }

  async network(
    canvasId: string,
    args: { filter?: 'all' | 'failed'; requestId?: number },
    ctx: CanvasCallContext
  ): Promise<CanvasNetworkEntry[]> {
    const session = this.require(canvasId, ctx)
    const entries = await session.driver.network(args)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'network inspection')
    this.emit(canvasId, 'network', ctx, { count: entries.length, filter: args.filter ?? 'all' })
    return entries
  }

  async console(
    canvasId: string,
    args: { level?: 'all' | 'warn' | 'error'; lines?: number },
    ctx: CanvasCallContext
  ): Promise<CanvasConsoleEntry[]> {
    const session = this.require(canvasId, ctx)
    const entries = await session.driver.console(args)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'console inspection')
    this.emit(canvasId, 'console', ctx, { count: entries.length, level: args.level ?? 'all' })
    return entries
  }

  async resize(
    canvasId: string,
    viewport: CanvasViewport,
    ctx: CanvasCallContext
  ): Promise<CanvasViewport> {
    const session = this.require(canvasId, ctx)
    const applied = await session.driver.resize(viewport)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'resize')
    session.record = { ...session.record, viewport: applied, updatedAt: this.deps.now() }
    this.deps.store.upsertSession(session.record)
    this.emit(canvasId, 'resize', ctx, { width: applied.width, height: applied.height })
    return applied
  }

  private chargeInteraction(session: LiveSession): void {
    const maxInteractions = this.deps.maxInteractionsPerSession ?? MAX_INTERACTIONS_PER_SESSION
    if (session.interactions >= maxInteractions) {
      throw new Error(`Canvas interaction budget exhausted (${maxInteractions} per session).`)
    }
    session.interactions += 1
  }

  private chargeEval(session: LiveSession): void {
    const maxEvals = this.deps.maxEvalsPerSession ?? MAX_EVALS_PER_SESSION
    if (session.evals >= maxEvals) {
      throw new Error(`Canvas eval budget exhausted (${maxEvals} per session).`)
    }
    session.evals += 1
  }

  /** Tail of the in-flight interaction chain per canvas. See serializeInteraction. */
  private readonly interactionQueues = new Map<string, Promise<unknown>>()

  /**
   * Serializes the mutating page interactions for one canvas.
   *
   * `chargeInteraction` is a spend counter, not a lock, so concurrent
   * click/fill/annotate calls previously interleaved freely inside the page: two
   * lanes (or one lane and a retry) could dispatch overlapping events at the
   * same element and leave a state neither of them observed. A precondition is
   * only meaningful if nothing can run between the check and the dispatch, so
   * the whole check-then-act sequence has to hold the canvas.
   *
   * Deliberately does NOT cover `evaluate`. The signed-elevated path has a
   * delicate receipt -> ledger-claim -> execute ordering and its own tighter
   * budget; queueing it behind arbitrary interaction latency would change when a
   * single-use approval is burned relative to when the human approved it.
   */
  private serializeInteraction<T>(canvasId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.interactionQueues.get(canvasId) ?? Promise.resolve()
    // Run whether or not the previous entry settled cleanly — one failed
    // interaction must never wedge the canvas for the rest of the session.
    const next = prior.then(run, run)
    this.interactionQueues.set(
      canvasId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  /**
   * Runs one page interaction under the canvas's serialization lock, auditing
   * the INTENT before dispatch and an outcome only when execution is refused,
   * unverified or throws.
   *
   * Ordinary-driver intent remains best-effort telemetry so it does not fsync a
   * full JSON file per click. Native-window intent is a strict pre-dispatch
   * receipt: persistence failure blocks actuation. Both run before `driver.act`,
   * so a driver error or process crash cannot leave an attempted action
   * represented only by an absent intent. The post-await assert remains after
   * any outcome audit; `emit` independently refuses writes after a history
   * generation moves, preserving clear semantics.
   */
  private interact(
    canvasId: string,
    kind: 'click' | 'fill',
    args: CanvasActionInput,
    ctx: CanvasCallContext
  ): Promise<CanvasActResult> {
    return this.serializeInteraction(canvasId, async () => {
      // Resolved inside the lock: the canvas may have closed while we queued.
      const session = this.require(canvasId, ctx)
      this.chargeInteraction(session)
      this.assertLiveAfterAwait(canvasId, session, ctx, kind)
      const targetAudit = canvasTargetAudit(args)
      // Audit records the target, NEVER the value typed.
      const intentDetail = {
        phase: 'intent',
        action: kind,
        ...targetAudit
      }
      if (session.record.driver === 'window') {
        try {
          this.emitStrict(canvasId, 'interaction', ctx, intentDetail)
        } catch {
          throw new Error(
            'Native window interaction was blocked because its pre-dispatch audit intent could not be persisted.'
          )
        }
      } else {
        this.emit(canvasId, 'interaction', ctx, intentDetail)
      }
      // A synchronous broadcast hook could have begun a clear while the intent
      // was emitted. Re-check before invoking the driver.
      this.assertLiveAfterAwait(canvasId, session, ctx, kind)
      let result: CanvasActResult
      try {
        result = await session.driver.act({ ...args, kind })
      } catch (error) {
        this.emit(canvasId, 'interaction', ctx, {
          phase: 'outcome',
          action: kind,
          ...targetAudit,
          outcome: 'driver_error',
          dispatchStatus: 'unknown',
          verified: 'unknown'
        })
        throw error
      }
      if (!result.ok || !result.executed || result.verified !== 'changed') {
        this.emit(canvasId, 'interaction', ctx, {
          phase: 'outcome',
          action: kind,
          ...targetAudit,
          found: result.found,
          // Whether the interaction actually landed is the audit-relevant fact —
          // `found` alone cannot distinguish a dispatch from a refused
          // precondition.
          executed: result.executed,
          verified: result.verified,
          ...(result.refusalReason ? { refusalReason: result.refusalReason } : {})
        })
      }
      this.assertLiveAfterAwait(canvasId, session, ctx, kind)
      return result
    })
  }

  async click(
    canvasId: string,
    args: CanvasActionInput,
    ctx: CanvasCallContext
  ): Promise<CanvasActResult> {
    return this.interact(canvasId, 'click', args, ctx)
  }

  async fill(
    canvasId: string,
    args: CanvasActionInput,
    ctx: CanvasCallContext
  ): Promise<CanvasActResult> {
    return this.interact(canvasId, 'fill', args, ctx)
  }

  async annotate(
    canvasId: string,
    marks: CanvasMark[],
    ctx: CanvasCallContext
  ): Promise<CanvasAnnotation> {
    return this.serializeInteraction(canvasId, () => this.annotateLocked(canvasId, marks, ctx))
  }

  /**
   * NB the audit ordering here is deliberately NOT the one `interact` uses. The
   * artifact annotate produces is persisted CONTENT (the annotation record), not
   * just telemetry, and `appendAnnotation` has no generation self-guard of its
   * own — so writing it after a clear would resurrect erased content. The
   * post-await assert therefore stays in front of the persist, and the overlay
   * (cosmetic, pointer-events:none) is the only thing that can outlive its
   * record. The pre-flight assert below is what stops a canvas mid-clear being
   * drawn on at all.
   */
  private async annotateLocked(
    canvasId: string,
    marks: CanvasMark[],
    ctx: CanvasCallContext
  ): Promise<CanvasAnnotation> {
    const session = this.require(canvasId, ctx)
    // Annotate shares the per-session interaction budget so overlay-spam can't
    // flush the capped canvas audit-event history.
    this.chargeInteraction(session)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'annotation')
    await session.driver.annotate(marks)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'annotation')
    const annotation: CanvasAnnotation = {
      schemaVersion: 1,
      id: this.deps.uuid(),
      canvasId,
      chatId: ctx.chatId,
      workspacePath: ctx.workspacePath,
      runId: ctx.runId,
      marks,
      author: 'agent',
      createdAt: this.deps.now()
    }
    this.deps.store.appendAnnotation(annotation)
    this.emit(canvasId, 'annotation', ctx, { annotationId: annotation.id, count: marks.length })
    return annotation
  }

  async sketchDocument(canvasId: string, ctx: CanvasCallContext): Promise<CanvasSketchDocument> {
    const session = this.require(canvasId, ctx)
    const document = await session.driver.sketchDocument()
    this.assertLiveAfterAwait(canvasId, session, ctx, 'sketch read')
    this.emit(canvasId, 'sketch.read', ctx, { elementCount: document.elements.length })
    return document
  }

  async sketchUpdate(
    canvasId: string,
    update: CanvasSketchUpdateInput,
    ctx: CanvasCallContext
  ): Promise<CanvasSketchDocument> {
    return this.serializeInteraction(canvasId, () =>
      this.sketchUpdateLocked(canvasId, update, ctx)
    )
  }

  /**
   * Same reasoning as `annotateLocked`: the sketch document is persisted content,
   * so its post-await assert stays in front of `persistSketchDocument`.
   */
  private async sketchUpdateLocked(
    canvasId: string,
    update: CanvasSketchUpdateInput,
    ctx: CanvasCallContext
  ): Promise<CanvasSketchDocument> {
    const session = this.require(canvasId, ctx)
    this.chargeInteraction(session)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'sketch update')
    const document = await session.driver.sketchUpdate(update)
    this.assertLiveAfterAwait(canvasId, session, ctx, 'sketch update')
    this.persistSketchDocument(this.sketchScope(ctx), document)
    session.record = {
      ...session.record,
      title: document.title || session.record.title,
      viewport: document.viewport,
      updatedAt: this.deps.now()
    }
    this.deps.store.upsertSession(session.record)
    this.emit(canvasId, 'sketch.update', ctx, {
      mode: update.mode ?? 'append',
      elementCount: document.elements.length
    })
    return document
  }

  async evaluate(
    canvasId: string,
    args: { script: string },
    ctx: CanvasCallContext
  ): Promise<CanvasEvalResult> {
    const session = this.require(canvasId, ctx)
    const approval = assertCanvasEvalApprovalReceipt(args.script, ctx.canvasEvalApproval)
    this.chargeEval(session)
    const receiptDetail = {
      approvalId: approval.approvalId,
      scriptHashAlgorithm: approval.scriptHashAlgorithm,
      scriptHash: approval.scriptHash,
      scriptLength: approval.scriptLength,
      scriptByteLength: approval.scriptByteLength
    }
    try {
      this.emitStrict(canvasId, 'eval.started', ctx, receiptDetail)
    } catch {
      throw new Error(
        'canvas_eval was blocked because its pre-execution audit receipt could not be persisted.'
      )
    }

    let result: CanvasEvalResult
    try {
      result = await session.driver.evaluate(args)
    } catch (error) {
      if (
        this.contextHistoryBlocked(ctx) ||
        session.generation !== this.generation ||
        this.canvasGenerations.get(canvasId) !== session.generation ||
        this.sessions.get(canvasId) !== session
      ) {
        throw new Error('canvas_eval completion was discarded because history was cleared.')
      }
      try {
        this.emitStrict(canvasId, 'eval.completed', ctx, {
          ...receiptDetail,
          outcome: 'host_error',
          ok: false
        })
      } catch {
        throw new Error(
          'canvas_eval may have executed, but its post-execution audit receipt could not be persisted; do not retry automatically.'
        )
      }
      throw error
    }

    try {
      this.assertLiveAfterAwait(canvasId, session, ctx, 'eval completion')
    } catch {
      throw new Error('canvas_eval completion was discarded because history was cleared.')
    }

    try {
      this.emitStrict(canvasId, 'eval.completed', ctx, {
        ...receiptDetail,
        outcome: result.ok ? 'success' : 'script_error',
        ok: result.ok
      })
    } catch {
      throw new Error(
        'canvas_eval executed, but its post-execution audit receipt could not be persisted; do not retry automatically.'
      )
    }
    return result
  }

  async reload(canvasId: string, ctx: CanvasCallContext): Promise<void> {
    const session = this.require(canvasId, ctx)
    await session.driver.reload()
    this.assertLiveAfterAwait(canvasId, session, ctx, 'reload')
    this.emit(canvasId, 'reload', ctx)
  }

  /**
   * Browser navigation on a web canvas. Serialized with the other page
   * interactions (a navigation mid-click would invalidate the precondition a
   * pending actuation just checked) and charged against the same per-session
   * interaction budget. The audit detail records the SETTLED, query-redacted
   * URL — never the raw address.
   */
  async navigate(
    canvasId: string,
    input: CanvasNavigateInput,
    ctx: CanvasCallContext,
    opts?: { chargeInteraction?: boolean }
  ): Promise<CanvasNavState> {
    return this.serializeInteraction(canvasId, async () => {
      const session = this.require(canvasId, ctx)
      if (!session.driver.navigate) {
        throw new Error(
          'Only web canvases support navigation. Open one first (canvas_navigate with a url does this automatically).'
        )
      }
      // The runaway budget exists to stop a hijacked agent, not the human
      // driving their own browser chrome; the renderer IPC opts out.
      if (opts?.chargeInteraction !== false) this.chargeInteraction(session)
      this.assertLiveAfterAwait(canvasId, session, ctx, 'navigation')
      const state = await session.driver.navigate(input)
      this.assertLiveAfterAwait(canvasId, session, ctx, 'navigation')
      this.emit(canvasId, 'navigation', ctx, {
        via: input.url ? 'goto' : input.action,
        url: redactUrlQuery(state.url)
      })
      return state
    })
  }

  async close(canvasId: string, ctx: CanvasCallContext): Promise<void> {
    const session = this.sessions.get(canvasId)
    if (!session || !this.owns(session.record, ctx)) return
    await this.teardown(canvasId, session, ctx)
  }

  private async teardown(
    canvasId: string,
    session: LiveSession,
    ctx: CanvasCallContext
  ): Promise<void> {
    this.sessions.delete(canvasId)
    // Drop the interaction chain with the session so the map cannot grow across
    // a long-lived app run. Anything still queued will fail its own `require`.
    this.interactionQueues.delete(canvasId)
    const historyRevision = this.captureHistoryRevision(ctx)
    const closePromise = session.driver.close()
    const closing: ClosingSession = { session, ctx, closePromise }
    this.closingSessions.set(canvasId, closing)
    try {
      await closePromise
    } catch (error) {
      this.deps.logger?.warn?.(`canvas: driver close failed for ${canvasId}: ${String(error)}`)
      this.failedCloses.set(canvasId, { session, ctx })
      throw error
    } finally {
      if (this.closingSessions.get(canvasId) === closing) {
        this.closingSessions.delete(canvasId)
      }
    }
    if (
      session.generation === this.generation &&
      !this.purging &&
      !this.contextHistoryBlocked(ctx) &&
      !this.historyRevisionChanged(ctx, historyRevision) &&
      this.canvasGenerations.get(canvasId) === session.generation
    ) {
      this.deps.store.upsertSession({
        ...session.record,
        status: 'closed',
        closedAt: this.deps.now(),
        updatedAt: this.deps.now()
      })
      this.emit(canvasId, 'session.closed', ctx)
    }
    if (this.canvasGenerations.get(canvasId) === session.generation) {
      this.canvasGenerations.delete(canvasId)
    }
  }

  /** Close every live session regardless of owner — call on app shutdown. */
  async closeAll(): Promise<void> {
    const entries = [...this.sessions.entries()]
    const pending = [...this.pendingOpens.entries()]
    const closing = [...this.closingSessions.values()]
    const failed = [...this.failedCloses.entries()]
    for (const [canvasId, open] of pending) {
      this.pendingOpens.delete(canvasId)
      if (this.canvasGenerations.get(canvasId) === open.generation) {
        this.canvasGenerations.delete(canvasId)
      }
    }
    const outcomes = await Promise.allSettled([
      ...entries.map(([id, session]) => this.teardown(id, session, {})),
      ...pending.map(async ([canvasId, open]) => {
        await this.settleAndClosePendingOpen(canvasId, open, 'during close-all')
      }),
      ...closing.map((entry) => entry.closePromise),
      ...failed.map(([canvasId, entry]) => this.retryFailedClose(canvasId, entry))
    ])
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'One or more Canvas resources could not be closed during history clear.'
      )
    }
  }

  /** Main-owned chat ids with a live Canvas; used to protect empty chats from reaping. */
  openChatIds(): Set<string> {
    return new Set(
      [
        ...this.sessions.values(),
        ...this.pendingOpens.values(),
        ...[...this.closingSessions.values()].map((entry) => entry.session),
        ...[...this.failedCloses.values()].map((entry) => entry.session)
      ]
        .map((session) => session.record.chatId)
        .filter((chatId): chatId is string => Boolean(chatId))
    )
  }

  /**
   * Raise scoped admission holds and synchronously retire matching live
   * sessions before the first await. The returned promise closes drivers and
   * purges their durable state; callers release the holds in a matching finally.
   */
  beginAuthorityHistoryClear(input: CanvasHistoryAuthority): Promise<void> {
    const operation = this.beginAuthorityHistoryClearInner(input)
    this.scopedClearOperations.add(operation)
    void operation.finally(() => this.scopedClearOperations.delete(operation)).catch(() => {})
    return operation
  }

  private async beginAuthorityHistoryClearInner(
    input: CanvasHistoryAuthority
  ): Promise<void> {
    const authority = this.normalizedAuthority(input)
    const participantPurges = (this.deps.historyParticipants ?? []).map((participant) =>
      participant.beginAuthorityHistoryClear(authority)
    )
    const generationAtStart = this.generation
    const startedDuringGlobalClear = this.purging
    for (const chatId of authority.chatIds) {
      this.chatHistoryClearHolds.set(chatId, (this.chatHistoryClearHolds.get(chatId) ?? 0) + 1)
      this.chatHistoryRevisions.set(chatId, (this.chatHistoryRevisions.get(chatId) ?? 0) + 1)
    }
    for (const workspacePath of authority.workspacePaths) {
      this.workspaceHistoryClearHolds.set(
        workspacePath,
        (this.workspaceHistoryClearHolds.get(workspacePath) ?? 0) + 1
      )
      this.workspaceHistoryRevisions.set(
        workspacePath,
        (this.workspaceHistoryRevisions.get(workspacePath) ?? 0) + 1
      )
    }

    const retired = [...this.sessions.entries()].filter(([, session]) =>
      this.recordMatchesAuthority(session.record, authority)
    )
    const retiredPending = [...this.pendingOpens.entries()].filter(([, open]) =>
      this.recordMatchesAuthority(open.record, authority)
    )
    const retiredClosing = [...this.closingSessions.entries()].filter(([, entry]) =>
      this.recordMatchesAuthority(entry.session.record, authority)
    )
    const retiredFailed = [...this.failedCloses.entries()].filter(([, entry]) =>
      this.recordMatchesAuthority(entry.session.record, authority)
    )
    // Retire first: every in-flight post-await check observes the missing exact
    // session/generation even if a driver close stalls.
    for (const [canvasId, session] of retired) {
      this.sessions.delete(canvasId)
      if (this.canvasGenerations.get(canvasId) === session.generation) {
        this.canvasGenerations.delete(canvasId)
      }
    }
    for (const [canvasId, open] of retiredPending) {
      this.pendingOpens.delete(canvasId)
      if (this.canvasGenerations.get(canvasId) === open.generation) {
        this.canvasGenerations.delete(canvasId)
      }
    }
    for (const [canvasId, entry] of retiredClosing) {
      if (this.canvasGenerations.get(canvasId) === entry.session.generation) {
        this.canvasGenerations.delete(canvasId)
      }
    }
    const closeOutcomes = await Promise.allSettled(
      [
        ...retired.map(([canvasId, session]) =>
          this.closeRetiredSession(canvasId, session, {
            chatId: session.record.chatId,
            workspacePath: session.record.workspacePath,
            runId: session.record.runId
          })
        ),
        ...retiredPending.map(([canvasId, open]) =>
          this.settleAndClosePendingOpen(canvasId, open, 'during scoped history clear')
        ),
        ...retiredClosing.map(([, entry]) => entry.closePromise),
        ...retiredFailed.map(([canvasId, entry]) => this.retryFailedClose(canvasId, entry)),
        ...participantPurges
      ]
    )
    const closeFailures = closeOutcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    )
    if (closeFailures.length > 0) {
      for (const failure of closeFailures) {
        this.deps.logger?.warn?.(
          `canvas: driver close failed during scoped history clear: ${String(failure.reason)}`
        )
      }
      throw new AggregateError(
        closeFailures.map((failure) => failure.reason),
        'One or more Canvas resources could not be closed during scoped history clear.'
      )
    }
    await this.enqueueHistoryStoreMutation(() => {
      // A global clear that began before or during this scoped transaction owns
      // the broader durable erase. Never recreate scoped JSON files afterwards.
      if (
        startedDuringGlobalClear ||
        generationAtStart !== this.generation ||
        this.purging
      ) {
        return
      }
      this.deps.store.purgeAuthoritiesStrict(authority)
    })
  }

  endAuthorityHistoryClear(input: CanvasHistoryAuthority): void {
    const authority = this.normalizedAuthority(input)
    for (const chatId of authority.chatIds) {
      const next = (this.chatHistoryClearHolds.get(chatId) ?? 0) - 1
      if (next > 0) this.chatHistoryClearHolds.set(chatId, next)
      else this.chatHistoryClearHolds.delete(chatId)
    }
    for (const workspacePath of authority.workspacePaths) {
      const next = (this.workspaceHistoryClearHolds.get(workspacePath) ?? 0) - 1
      if (next > 0) this.workspaceHistoryClearHolds.set(workspacePath, next)
      else this.workspaceHistoryClearHolds.delete(workspacePath)
    }
    for (const participant of this.deps.historyParticipants ?? []) {
      participant.endAuthorityHistoryClear(authority)
    }
  }

  /**
   * Begin a global history-clear transaction. The Canvas admission fence stays
   * raised after the physical purge finishes and is released only by the
   * matching `endHistoryClear`, after every other durable store commits.
   */
  async beginHistoryClear(): Promise<void> {
    this.historyClearHolds += 1
    const participantPurge = Promise.all(
      (this.deps.historyParticipants ?? []).map((participant) => participant.beginHistoryClear())
    )
    if (!this.purging) {
      this.purging = true
      this.generation += 1
    }
    if (!this.purgeInFlight) {
      this.purgeInFlight = (async () => {
        await participantPurge
        await this.closeAll()
        while (this.scopedClearOperations.size > 0) {
          const outcomes = await Promise.allSettled([...this.scopedClearOperations])
          const failures = outcomes.filter(
            (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
          )
          if (failures.length > 0) {
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              'A scoped Canvas history clear did not settle safely.'
            )
          }
        }
        // A scoped close can fail and move its driver into failedCloses while
        // the first closeAll snapshot is already in flight. Re-scan after the
        // scoped join so global clear either closes it or fails closed.
        await this.closeAll()
        await this.enqueueHistoryStoreMutation(() => this.deps.store.clearAll())
        this.canvasGenerations.clear()
      })().finally(() => {
        this.purgeInFlight = null
        if (this.historyClearHolds === 0) this.purging = false
      })
    }
    await Promise.all([this.purgeInFlight, participantPurge])
  }

  /** Release one global history-clear admission hold. */
  endHistoryClear(): void {
    if (this.historyClearHolds > 0) this.historyClearHolds -= 1
    if (this.historyClearHolds === 0 && !this.purgeInFlight) this.purging = false
    for (const participant of this.deps.historyParticipants ?? []) participant.endHistoryClear()
  }

  /** Standalone purge used outside the multi-store clear transaction. */
  async purgeHistory(): Promise<void> {
    try {
      await this.beginHistoryClear()
    } finally {
      this.endHistoryClear()
    }
  }
}
