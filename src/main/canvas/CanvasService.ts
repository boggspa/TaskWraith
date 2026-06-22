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
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSessionRecord,
  CanvasSessionSummary,
  CanvasViewport
} from './canvasTypes'
import { isValidBundleId, redactUrlQuery, resolveViewport, validateCanvasUrl } from './canvasTypes'
import type { CanvasStore } from './CanvasStore'

export interface CanvasServiceDeps {
  createDriver: (
    kind: CanvasDriverKind,
    sessionId: string,
    opts?: { embedded?: boolean }
  ) => CanvasDriver
  store: CanvasStore
  uuid: () => string
  now: () => string
  /** Broadcast an audit event to the renderer (already persisted by the service). */
  broadcast?: (event: CanvasEventRecord) => void
  logger?: Pick<Console, 'warn' | 'error'>
  maxInteractionsPerSession?: number
  maxEvalsPerSession?: number
}

interface LiveSession {
  driver: CanvasDriver
  record: CanvasSessionRecord
  interactions: number
  evals: number
}

const SUPPORTED_DRIVERS: ReadonlySet<CanvasDriverKind> = new Set(['web', 'device'])
// Defence-in-depth cap so a hijacked agent (or a session-granted approval)
// cannot machine-gun clicks/fills against a live app. Per live session.
const MAX_INTERACTIONS_PER_SESSION = 200
// Eval is RCE and human-approved per call, but cap it anyway so a compromised
// approve-loop can't run unbounded scripts. Separate, tighter budget.
const MAX_EVALS_PER_SESSION = 50

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

export class CanvasService implements CanvasController {
  private readonly sessions = new Map<string, LiveSession>()

  constructor(private readonly deps: CanvasServiceDeps) {}

  private emit(
    canvasId: string,
    kind: CanvasEventKind,
    ctx: CanvasCallContext,
    detail?: Record<string, unknown>
  ): void {
    const event: CanvasEventRecord = {
      schemaVersion: 1,
      id: this.deps.uuid(),
      canvasId,
      kind,
      provider: ctx.provider,
      chatId: ctx.chatId,
      runId: ctx.runId,
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
   * Chat-scoped ownership: a session is reachable only from the chat that
   * opened it (sessions opened in a global-scope run share the no-chat scope).
   * This stops an agent in chat A from inspecting/closing chat B's canvas even
   * if it learns the id.
   */
  private owns(record: CanvasSessionRecord, ctx: CanvasCallContext): boolean {
    return (record.chatId ?? null) === (ctx.chatId ?? null)
  }

  private require(canvasId: string, ctx: CanvasCallContext): LiveSession {
    const session = this.sessions.get(canvasId)
    if (!session || !this.owns(session.record, ctx)) {
      // Same message whether absent or cross-chat — never reveal another chat's id.
      throw new Error(`No open canvas with id "${canvasId}". Call canvas_open first.`)
    }
    return session
  }

  async open(
    input: CanvasOpenInput,
    ctx: CanvasCallContext
  ): Promise<{ canvasId: string } & CanvasSessionHandle> {
    const driverKind = input.driver ?? 'web'
    if (!SUPPORTED_DRIVERS.has(driverKind)) {
      throw new Error(`Canvas driver "${driverKind}" is not available in this build.`)
    }
    // Validate up front so a bad input never even spawns a window / boots a sim.
    let recordUrl: string
    let eventHost: string | undefined
    if (driverKind === 'device') {
      const bundleId = (input.bundleId || '').trim()
      if (!bundleId || !isValidBundleId(bundleId)) {
        throw new Error('The device driver requires a valid `bundleId` (e.g. "com.example.App").')
      }
      eventHost = (input.device?.udid || 'booted').trim()
      recordUrl = `device://${eventHost}/${bundleId}`
    } else {
      const verdict = validateCanvasUrl((input.url || '').trim(), input.originAllowlist ?? [])
      if (!verdict.ok) throw new Error(verdict.reason || 'Canvas URL was rejected.')
      recordUrl = redactUrlQuery(verdict.normalizedUrl ?? (input.url || ''))
      eventHost = verdict.host
    }

    const canvasId = this.deps.uuid()
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
      originAllowlist: input.originAllowlist ?? [],
      status: 'opening',
      chatId: ctx.chatId,
      runId: ctx.runId,
      workspacePath: ctx.workspacePath,
      createdAt: nowIso,
      updatedAt: nowIso
    }
    this.deps.store.upsertSession(baseRecord)

    // Embed is web-only and renderer-initiated; the agent's executor never sets it.
    const embedded = driverKind === 'web' && input.embed === true
    const driver = this.deps.createDriver(driverKind, canvasId, { embedded })
    try {
      const handle = await driver.open(input)
      const record: CanvasSessionRecord = {
        ...baseRecord,
        status: 'active',
        url: redactUrlQuery(handle.url),
        title: handle.title,
        viewport: handle.viewport,
        updatedAt: this.deps.now()
      }
      this.sessions.set(canvasId, { driver, record, interactions: 0, evals: 0 })
      this.deps.store.upsertSession(record)
      this.emit(canvasId, 'session.opened', ctx, {
        driver: driverKind,
        host: eventHost,
        url: redactUrlQuery(handle.url)
      })
      return { canvasId, ...handle }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.store.upsertSession({
        ...baseRecord,
        status: 'error',
        error: message,
        updatedAt: this.deps.now()
      })
      this.emit(canvasId, 'session.error', ctx, { error: message })
      try {
        await driver.close()
      } catch {
        // Best effort — the open already failed.
      }
      throw err
    }
  }

  list(ctx: CanvasCallContext): CanvasSessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => this.owns(session.record, ctx))
      .map((session) => toSummary(session.record))
  }

  status(canvasId: string, ctx: CanvasCallContext): CanvasSessionSummary | null {
    const live = this.sessions.get(canvasId)
    if (live) return this.owns(live.record, ctx) ? toSummary(live.record) : null
    const persisted = this.deps.store.getSession(canvasId)
    return persisted && this.owns(persisted, ctx) ? toSummary(persisted) : null
  }

  async snapshot(canvasId: string, ctx: CanvasCallContext): Promise<CanvasElementTree> {
    const { driver } = this.require(canvasId, ctx)
    const tree = await driver.snapshot()
    this.emit(canvasId, 'snapshot', ctx, { nodeCount: tree.nodeCount, url: tree.url })
    return tree
  }

  async screenshot(canvasId: string, ctx: CanvasCallContext): Promise<CanvasFrame> {
    const { driver } = this.require(canvasId, ctx)
    const frame = await driver.screenshot()
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
    args: { ref?: string; selector?: string; styles?: string[] },
    ctx: CanvasCallContext
  ): Promise<CanvasElementDetail> {
    const { driver } = this.require(canvasId, ctx)
    const detail = await driver.inspect(args)
    this.emit(canvasId, 'inspect', ctx, {
      ref: args.ref,
      selector: args.selector,
      found: detail.found
    })
    return detail
  }

  async network(
    canvasId: string,
    args: { filter?: 'all' | 'failed'; requestId?: number },
    ctx: CanvasCallContext
  ): Promise<CanvasNetworkEntry[]> {
    const { driver } = this.require(canvasId, ctx)
    const entries = await driver.network(args)
    this.emit(canvasId, 'network', ctx, { count: entries.length, filter: args.filter ?? 'all' })
    return entries
  }

  async console(
    canvasId: string,
    args: { level?: 'all' | 'warn' | 'error'; lines?: number },
    ctx: CanvasCallContext
  ): Promise<CanvasConsoleEntry[]> {
    const { driver } = this.require(canvasId, ctx)
    const entries = await driver.console(args)
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

  async click(
    canvasId: string,
    args: CanvasActionInput,
    ctx: CanvasCallContext
  ): Promise<CanvasActResult> {
    const session = this.require(canvasId, ctx)
    this.chargeInteraction(session)
    const result = await session.driver.act({ ...args, kind: 'click' })
    this.emit(canvasId, 'interaction', ctx, {
      action: 'click',
      ref: args.ref,
      selector: args.selector,
      found: result.found
    })
    return result
  }

  async fill(
    canvasId: string,
    args: CanvasActionInput,
    ctx: CanvasCallContext
  ): Promise<CanvasActResult> {
    const session = this.require(canvasId, ctx)
    this.chargeInteraction(session)
    const result = await session.driver.act({ ...args, kind: 'fill' })
    // Audit records the field targeted, NEVER the value typed.
    this.emit(canvasId, 'interaction', ctx, {
      action: 'fill',
      ref: args.ref,
      selector: args.selector,
      found: result.found
    })
    return result
  }

  async annotate(
    canvasId: string,
    marks: CanvasMark[],
    ctx: CanvasCallContext
  ): Promise<CanvasAnnotation> {
    const session = this.require(canvasId, ctx)
    // Annotate shares the per-session interaction budget so overlay-spam can't
    // flush the capped canvas audit-event history.
    this.chargeInteraction(session)
    await session.driver.annotate(marks)
    const annotation: CanvasAnnotation = {
      schemaVersion: 1,
      id: this.deps.uuid(),
      canvasId,
      marks,
      author: 'agent',
      createdAt: this.deps.now()
    }
    this.deps.store.appendAnnotation(annotation)
    this.emit(canvasId, 'annotation', ctx, { annotationId: annotation.id, count: marks.length })
    return annotation
  }

  async evaluate(
    canvasId: string,
    args: { script: string },
    ctx: CanvasCallContext
  ): Promise<CanvasEvalResult> {
    const session = this.require(canvasId, ctx)
    this.chargeEval(session)
    const result = await session.driver.evaluate(args)
    // Audit records only the script's sha256 + length + outcome — NEVER the script
    // text (could embed secrets the agent read) and NEVER the returned value.
    this.emit(canvasId, 'eval', ctx, {
      scriptHash: createHash('sha256').update(args.script).digest('hex'),
      scriptLength: args.script.length,
      ok: result.ok
    })
    return result
  }

  async reload(canvasId: string, ctx: CanvasCallContext): Promise<void> {
    const { driver } = this.require(canvasId, ctx)
    await driver.reload()
    this.emit(canvasId, 'reload', ctx)
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
    try {
      await session.driver.close()
    } catch (err) {
      this.deps.logger?.warn?.(`canvas: driver close failed for ${canvasId}: ${String(err)}`)
    }
    this.deps.store.upsertSession({
      ...session.record,
      status: 'closed',
      closedAt: this.deps.now(),
      updatedAt: this.deps.now()
    })
    this.emit(canvasId, 'session.closed', ctx)
  }

  /** Close every live session regardless of owner — call on app shutdown. */
  async closeAll(): Promise<void> {
    const entries = [...this.sessions.entries()]
    await Promise.all(entries.map(([id, session]) => this.teardown(id, session, {})))
  }
}
