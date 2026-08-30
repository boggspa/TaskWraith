import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  createEmptyHostSnapshot,
  type HostApprovalProjection,
  type HostBootstrapWelcome,
  type HostCapability,
  type HostCommand,
  type HostCommandReceipt,
  type HostDeltaEnvelope,
  type HostDeltaFamily,
  type HostDeltaKind,
  type HostDeltasFrame,
  type HostDeltasSinceResult,
  type HostParticipantProjection,
  type HostResultRef,
  type HostSnapshot
} from '../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportHostFrame,
  type HostWorkspaceGitReadParams,
  type HostWorkspaceGitReadResult
} from '../shared/hostProtocolTransport'
import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import {
  HostPermissionConsentAuthority,
  type HostPermissionConsentProofRequest
} from '../host-runtime/HostPermissionConsent'
import type { TaskWraithControlThreadOffers } from '../shared/taskWraithControlProtocol'
import { taskWraithHostSocketPath } from '../shared/taskWraithHostPaths.node'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import { stripAnsi } from './ansi'
import { createTuiFullAccessPresence } from './fullAccessConsent'
import {
  TaskWraithTui,
  hostDeltasMayReleaseQueuedDraft,
  shouldAdvanceAnimationFrame,
  terminalRunIdsFromHostDeltas
} from './TaskWraithTui'
import { TUI_GLYPHS_ASCII } from './theme'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
  vi.restoreAllMocks()
})

/* -------------------------------------------------------------------------
 * Minimal fake TTY streams
 * ---------------------------------------------------------------------- */

class FakeInput extends PassThrough {
  isTTY = true as const
  private rawMode = false
  setRawMode(mode: boolean): this {
    this.rawMode = mode
    return this
  }
  get isRawMode(): boolean {
    return this.rawMode
  }
}

class FakeOutput extends EventEmitter {
  isTTY = true as const
  columns = 80
  rows = 24
  readonly frames: string[] = []
  write(chunk: string): boolean {
    this.frames.push(chunk)
    return true
  }
  get lastFrame(): string {
    return stripAnsi(this.frames.at(-1) ?? '')
  }
}

function makeTty(): { input: FakeInput; output: FakeOutput } {
  return { input: new FakeInput(), output: new FakeOutput() }
}

function feed(input: FakeInput, text: string): void {
  input.write(Buffer.from(text, 'utf8'))
}

async function waitFor(
  check: () => boolean,
  description: string,
  timeoutMs = 2_000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for: ${description}`)
}

/* -------------------------------------------------------------------------
 * Fake Host v2 — profile-bound local socket + Host local transport
 * ---------------------------------------------------------------------- */

type MutationMode = 'allow' | 'defer'

interface FakeHostHandlers {
  snapshot: () => HostSnapshot | Promise<HostSnapshot>
  offers?: (threadId: string) => TaskWraithControlThreadOffers
  capabilities?: readonly HostCapability[]
  providerStatuses?: () => readonly HostProviderStatusProjection[]
  providerOffers?: (providerId: string) => HostProviderOffersProjection
  providerAuthFlows?: (providerId: string) => readonly HostProviderAuthFlowProjection[]
  providerAuthStatus?: (providerId: string) => HostProviderAuthStatusProjection
  threadHistory?: (request: HostThreadHistoryRequest) => HostThreadHistoryPage
  historySince?: (request: HostHistorySinceRequest) => HostHistorySinceResult
  workspaceGitRead?: (
    params: HostWorkspaceGitReadParams
  ) => HostWorkspaceGitReadResult | Promise<HostWorkspaceGitReadResult>
  /** Opt-in ensemble.seat.toggle interception; absent = generic mutationMode. */
  seatToggle?: (input: {
    threadId: string
    participantId: string
    enabled: boolean
  }) => { kind: 'succeeded' } | { kind: 'denied'; reason: string }
  resultRef?: (command: HostCommand) => HostResultRef | undefined
  resultSummary?: (command: HostCommand) => string | undefined
  onCommand?: (command: HostCommand) => void
  dropCommandResponse?: (command: HostCommand) => boolean
  dropCommandBeforeHandling?: (command: HostCommand) => boolean
  rejectCommandBeforeHandling?: (command: HostCommand) => boolean
  /** allow = immediate succeeded; defer = pending ask until approval.decide */
  mutationMode?: MutationMode
}

const SETUP_HOST_CAPABILITIES: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'model-offers',
  'health',
  'commands',
  'receipts',
  'provider-catalog',
  'provider-auth',
  'setup'
]

class FakeHostV2 {
  readonly userDataPath: string
  readonly discoveryPath: string
  readonly tokenPath: string
  readonly token = 'tui-test-host-token-0123456789abcdef'
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private socketPath = ''
  handlers: FakeHostHandlers
  private readonly receipts = new Map<string, HostCommandReceipt>()
  private readonly approvals = new Map<string, HostApprovalProjection>()
  private readonly decidedProjectionApprovals = new Set<string>()
  private readonly answeredProjectionQuestions = new Set<string>()
  private cursor = 9
  private eventSequence = 0
  snapshotRequests = 0
  welcomeCount = 0
  helloCapabilities: HostCapability[] = []
  readonly commands: HostCommand[] = []
  readonly commandAttempts: HostCommand[] = []

  constructor(userDataPath: string, handlers: FakeHostHandlers) {
    this.userDataPath = userDataPath
    this.discoveryPath = join(userDataPath, 'taskwraith-host-v2.json')
    this.tokenPath = join(userDataPath, 'taskwraith-host-v2.token')
    this.handlers = handlers
  }

  async start(): Promise<void> {
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    const canonicalUserDataPath = await realpath(this.userDataPath)
    this.socketPath = taskWraithHostSocketPath(canonicalUserDataPath)
    if (process.platform !== 'win32') {
      await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
      await chmod(dirname(this.socketPath), 0o700)
      await rm(this.socketPath, { force: true })
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => resolve())
    })
    await writeFile(this.tokenPath, `${this.token}\n`, 'utf8')
    await chmod(this.tokenPath, 0o600)
    await writeFile(
      this.discoveryPath,
      JSON.stringify({
        protocolVersion: 2,
        socketPath: this.socketPath,
        tokenPath: join(canonicalUserDataPath, 'taskwraith-host-v2.token'),
        pid: process.pid,
        startedAt: new Date(0).toISOString(),
        hostId: 'fake-host',
        hostVersion: '1.9.1-preview'
      }),
      'utf8'
    )
    await chmod(this.discoveryPath, 0o600)
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') await rm(this.socketPath, { force: true })
  }

  dropAllClients(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  pushDeltas(
    changes: ReadonlyArray<{
      family: HostDeltaFamily
      kind?: HostDeltaKind
      entityId?: string
      payload?: unknown
    }>
  ): void {
    const fromCursor = this.cursor
    const deltas: HostDeltaEnvelope[] = changes.map((change) => {
      const previousCursor = this.cursor
      this.cursor += 1
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        generation: 3,
        previousCursor,
        cursor: this.cursor,
        kind: change.kind ?? 'upsert',
        family: change.family,
        ...(change.entityId ? { entityId: change.entityId } : {}),
        ...(change.payload !== undefined ? { payload: change.payload } : {}),
        at: new Date().toISOString()
      }
    })
    this.pushDeltaResult({
      kind: 'deltas',
      generation: 3,
      fromCursor,
      toCursor: this.cursor,
      deltas
    })
  }

  pushDeltaResult(result: HostDeltasSinceResult): void {
    this.eventSequence += 1
    for (const socket of this.sockets) {
      this.write(socket, {
        type: 'event',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        sequence: this.eventSequence,
        event: 'deltas',
        payload: {
          type: 'host.deltas',
          protocolVersion: HOST_PROTOCOL_VERSION,
          result
        }
      })
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) this.onLine(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
  }

  private onLine(socket: Socket, line: string): void {
    const message = JSON.parse(line) as Record<string, unknown>
    if (message.type === 'hello') {
      if (message.token !== this.token) {
        socket.destroy()
        return
      }
      const hello = message.hello as { capabilities?: unknown } | undefined
      this.helloCapabilities = Array.isArray(hello?.capabilities)
        ? hello.capabilities.filter(
            (capability): capability is HostCapability => typeof capability === 'string'
          )
        : []
      const hostCapabilities: readonly HostCapability[] = this.handlers.capabilities ?? [
        'bootstrap',
        'snapshot',
        'deltas',
        'model-offers',
        'health',
        'commands',
        'receipts'
      ]
      const welcome: HostBootstrapWelcome = {
        type: 'host.welcome',
        protocolVersion: HOST_PROTOCOL_VERSION,
        controlProtocolCompat: 1,
        projectionVersion: HOST_PROJECTION_VERSION,
        hostId: 'fake-host',
        hostVersion: '1.9.1-preview',
        sessionId: 'fake-session',
        generation: 3,
        cursor: this.cursor,
        authenticatedClient: {
          clientId: 'tui-test',
          clientClass: 'tui',
          clientVersion: '0.1.0-test'
        },
        capabilities: hostCapabilities.filter((capability) =>
          this.helloCapabilities.includes(capability)
        ),
        freshness: 'live'
      }
      this.write(socket, {
        type: 'welcome',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        welcome
      })
      this.welcomeCount += 1
      return
    }
    if (message.type !== 'request') return
    const id = String(message.id)
    const kind = String(message.kind)
    if (kind === 'snapshot.get') {
      this.snapshotRequests += 1
      const respond = (base: HostSnapshot): void => {
        const snapshot: HostSnapshot = {
          ...base,
          questions: base.questions.filter(
            (question) => !this.answeredProjectionQuestions.has(question.questionId)
          ),
          approvals: [
            ...base.approvals.filter(
              (approval) => !this.decidedProjectionApprovals.has(approval.approvalId)
            ),
            ...this.approvals.values()
          ],
          cursor: this.cursor
        }
        this.write(socket, {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id,
          ok: true,
          result: {
            kind: 'snapshot.get',
            frame: {
              type: 'host.snapshot',
              protocolVersion: HOST_PROTOCOL_VERSION,
              snapshot
            }
          }
        })
      }
      // The handler may answer asynchronously (a deferred snapshot for
      // staleness tests); the client awaits the response over the socket
      // either way. A throwing handler becomes a wire error, matching the
      // real Host's error frame — never an uncaught socket exception.
      void Promise.resolve()
        .then(() => this.handlers.snapshot())
        .then(respond, () => {
          this.write(socket, {
            type: 'response',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id,
            ok: false,
            error: { code: 'host_unavailable' }
          })
        })
      return
    }
    if (kind === 'command.submit') {
      const command = message.params as HostCommand
      this.commandAttempts.push(command)
      if (this.handlers.dropCommandBeforeHandling?.(command)) {
        socket.destroy()
        return
      }
      if (this.handlers.rejectCommandBeforeHandling?.(command)) {
        this.write(socket, {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id,
          ok: false,
          error: { code: 'host_unavailable' }
        })
        return
      }
      const existing = this.receipts.get(command.commandId)
      const receipt = existing ?? this.handleCommand(command)
      if (!existing && this.handlers.dropCommandResponse?.(command)) {
        socket.destroy()
        return
      }
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: { kind: 'command.submit', receipt }
      })
      return
    }
    if (kind === 'thread.offers') {
      const threadId = String((message.params as { threadId?: unknown }).threadId ?? '')
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: {
          kind: 'thread.offers',
          offers: this.handlers.offers?.(threadId) ?? makeThreadOffers(threadId)
        }
      })
      return
    }
    if (kind === 'provider.status' && this.handlers.providerStatuses) {
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: { kind: 'provider.status', statuses: this.handlers.providerStatuses() }
      })
      return
    }
    if (kind === 'provider.offers' && this.handlers.providerOffers) {
      const providerId = String((message.params as { providerId?: unknown }).providerId ?? '')
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: { kind: 'provider.offers', offers: this.handlers.providerOffers(providerId) }
      })
      return
    }
    if (kind === 'provider.auth.flows' && this.handlers.providerAuthFlows) {
      const providerId = String((message.params as { providerId?: unknown }).providerId ?? '')
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: { kind: 'provider.auth.flows', flows: this.handlers.providerAuthFlows(providerId) }
      })
      return
    }
    if (kind === 'provider.auth.status' && this.handlers.providerAuthStatus) {
      const providerId = String((message.params as { providerId?: unknown }).providerId ?? '')
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: {
          kind: 'provider.auth.status',
          status: this.handlers.providerAuthStatus(providerId)
        }
      })
      return
    }
    if (kind === 'thread.history' && this.handlers.threadHistory) {
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: {
          kind: 'thread.history',
          page: this.handlers.threadHistory(message.params as HostThreadHistoryRequest)
        }
      })
      return
    }
    if (kind === 'history.since' && this.handlers.historySince) {
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: {
          kind: 'history.since',
          result: this.handlers.historySince(message.params as HostHistorySinceRequest)
        }
      })
      return
    }
    if (kind === 'workspace.git.read' && this.handlers.workspaceGitRead) {
      // The handler may answer asynchronously (deferred reads for staleness
      // tests); the client awaits the response over the socket either way.
      void Promise.resolve(
        this.handlers.workspaceGitRead(message.params as HostWorkspaceGitReadParams)
      ).then((result) => {
        this.write(socket, {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id,
          ok: true,
          result: {
            kind: 'workspace.git.read',
            result
          }
        })
      })
      return
    }
    if (kind === 'receipt.lookup') {
      const params = message.params as { commandId?: string; idempotencyKey?: string }
      const found = params.commandId
        ? this.receipts.get(params.commandId)
        : [...this.receipts.values()].find((row) => row.idempotencyKey === params.idempotencyKey)
      if (!found) {
        this.write(socket, {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id,
          ok: false,
          error: { code: 'host_unavailable' }
        })
        return
      }
      this.write(socket, {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: { kind: 'receipt.lookup', receipt: found }
      })
      return
    }
    this.write(socket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: false,
      error: { code: 'unknown_request_kind' }
    })
  }

  private handleCommand(command: HostCommand): HostCommandReceipt {
    this.commands.push(command)
    this.handlers.onCommand?.(command)
    if (command.name === 'approval.decide') {
      return this.handleApprovalDecide(command)
    }
    if (command.name === 'ensemble.seat.toggle' && this.handlers.seatToggle) {
      const outcome = this.handlers.seatToggle({
        threadId: command.target.threadId,
        participantId: String(command.arguments.participantId ?? ''),
        enabled: command.arguments.enabled === true
      })
      const receipt =
        outcome.kind === 'denied'
          ? this.makeReceipt(command, {
              status: 'denied',
              authority: { decision: 'deny', reason: outcome.reason },
              errorMessage: outcome.reason
            })
          : this.makeReceipt(command, { status: 'succeeded', authority: { decision: 'allow' } })
      this.receipts.set(receipt.commandId, receipt)
      this.cursor += 1
      return receipt
    }
    if (command.name === 'question.answer' && command.target.questionId) {
      this.answeredProjectionQuestions.add(command.target.questionId)
    }
    const mode = this.handlers.mutationMode ?? 'allow'
    if (mode === 'allow' || command.name === 'ping') {
      const resultRef = this.handlers.resultRef?.(command)
      const resultSummary = this.handlers.resultSummary?.(command)
      const receipt = this.makeReceipt(command, {
        status: 'succeeded',
        authority: { decision: 'allow' },
        ...(resultRef ? { resultRef } : {}),
        ...(resultSummary ? { resultSummary } : {})
      })
      this.receipts.set(receipt.commandId, receipt)
      this.cursor += 1
      return receipt
    }
    const receipt = this.makeReceipt(command, {
      status: 'pending',
      authority: { decision: 'ask', reason: 'production deferred' }
    })
    this.receipts.set(receipt.commandId, receipt)
    const approvalId = `approval-${command.commandId}`
    this.approvals.set(approvalId, {
      approvalId,
      // Wave 4.2c: the real Host publishes the governed command on every
      // approval card, so the fake must too or it stops modelling the wire.
      commandId: command.commandId,
      threadId: command.target.threadId,
      status: 'pending',
      actionKind: command.name,
      createdAt: Date.now(),
      summary: `Deferred ${command.name}`
    })
    this.cursor += 1
    return receipt
  }

  private handleApprovalDecide(command: HostCommand): HostCommandReceipt {
    const approvalId = command.target.approvalId
    if (approvalId) this.decidedProjectionApprovals.add(approvalId)
    const approval = approvalId ? this.approvals.get(approvalId) : undefined
    const decision = String(command.arguments.decision ?? '')
    const accept =
      decision === 'accept' || decision === 'acceptForSession' || decision === 'acceptForWorkspace'
    if (approval) {
      const mutation = [...this.receipts.values()].find(
        (row) => row.name === approval.actionKind && row.status === 'pending'
      )
      if (mutation) {
        const next: HostCommandReceipt = {
          ...mutation,
          status: accept ? 'succeeded' : 'denied',
          authority: accept ? { decision: 'allow' } : { decision: 'deny', reason: 'user declined' },
          updatedAt: new Date().toISOString(),
          ...(accept ? {} : { errorCode: 'authority_denied', errorMessage: 'user declined' })
        }
        this.receipts.set(mutation.commandId, next)
      }
      this.approvals.delete(approval.approvalId)
    }
    const decideReceipt = this.makeReceipt(command, {
      status: 'succeeded',
      authority: { decision: 'allow' }
    })
    this.receipts.set(decideReceipt.commandId, decideReceipt)
    this.cursor += 1
    return decideReceipt
  }

  private makeReceipt(
    command: HostCommand,
    overrides: Pick<HostCommandReceipt, 'status' | 'authority'> &
      Partial<
        Pick<HostCommandReceipt, 'errorCode' | 'errorMessage' | 'resultRef' | 'resultSummary'>
      >
  ): HostCommandReceipt {
    const now = new Date().toISOString()
    return {
      type: 'host.receipt',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      name: command.name,
      actor: command.actor,
      authority: overrides.authority,
      status: overrides.status,
      commandFingerprint: 'b'.repeat(64),
      generation: 3,
      cursor: this.cursor,
      createdAt: now,
      updatedAt: now,
      ...(overrides.errorCode ? { errorCode: overrides.errorCode } : {}),
      ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
      ...(overrides.resultRef ? { resultRef: overrides.resultRef } : {}),
      ...(overrides.resultSummary ? { resultSummary: overrides.resultSummary } : {})
    }
  }

  private write(socket: Socket, frame: HostLocalTransportHostFrame): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(frame)}\n`)
  }
}

function makeThreadOffers(threadId = 'thread-1'): TaskWraithControlThreadOffers {
  return {
    threadId,
    provider: {
      runtimeProvider: 'claude',
      displayProvider: 'Claude',
      hueKey: 'claude',
      accent: '#B16105',
      model: 'claude-sonnet-5',
      modelLabel: 'Sonnet 5',
      shortCode: 'CLA'
    },
    currentModel: 'claude-sonnet-5',
    currentReasoningEffort: 'high',
    models: [
      {
        id: 'claude-sonnet-5',
        label: 'Sonnet 5',
        current: true,
        reasoningEfforts: [{ id: 'high', isDefault: true }],
        defaultReasoningEffort: 'high'
      },
      {
        id: 'claude-opus-5',
        label: 'Opus 5',
        reasoningEfforts: [{ id: 'medium' }, { id: 'high', isDefault: true }],
        defaultReasoningEffort: 'high'
      }
    ],
    source: 'curated'
  }
}

function makeHostSnapshot(overrides?: Partial<HostSnapshot>): HostSnapshot {
  const base = createEmptyHostSnapshot({
    generation: 3,
    cursor: 9,
    freshness: 'live',
    generatedAt: new Date(0).toISOString()
  })
  return {
    ...base,
    workspaces: [
      {
        id: 'ws-1',
        name: 'AGBench',
        path: '/tmp/agbench',
        pinned: true,
        updatedAt: 0
      }
    ],
    providers: [
      {
        providerId: 'claude',
        displayProvider: 'Claude',
        modelId: 'sonnet-5',
        modelLabel: 'Sonnet 5',
        shortCode: 'CLD',
        hueKey: 'claude',
        available: true
      }
    ],
    threads: [
      {
        id: 'thread-1',
        workspaceId: 'ws-1',
        title: 'Solo thread',
        chatKind: 'single',
        archived: false,
        pinned: false,
        updatedAt: 10,
        messageCount: 1,
        providerId: 'claude',
        latestPreview: 'Hello TaskWraith',
        previewTruncated: false
      }
    ],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    ...overrides
  }
}

function makeSetupOffers(providerId = 'provider-1'): HostProviderOffersProjection {
  return {
    providerId,
    offerRevision: 'offer-revision-1',
    models: [
      {
        modelId: 'model-1',
        label: 'Model One',
        available: true,
        reasoning: [{ reasoningId: 'reasoning-1', label: 'Focused', available: true }]
      }
    ],
    postures: [
      {
        postureId: 'posture-read',
        label: 'Read',
        available: true,
        requiresExplicitConsent: false,
        ceiling: 'read'
      },
      {
        postureId: 'posture-write',
        label: 'Workspace write',
        available: true,
        requiresExplicitConsent: true,
        ceiling: 'workspace_write'
      }
    ]
  }
}

function makeSetupThread(): HostSnapshot['threads'][number] {
  return {
    id: 'setup-thread-1',
    workspaceId: 'setup-workspace-1',
    title: 'Configured thread',
    chatKind: 'single',
    archived: false,
    pinned: false,
    updatedAt: 20,
    messageCount: 0,
    providerId: 'provider-1',
    latestPreview: 'Ready for the first message',
    previewTruncated: false
  }
}

async function setupHost(
  snapshot: HostSnapshot = makeHostSnapshot(),
  mutationMode: MutationMode = 'allow'
): Promise<{
  host: FakeHostV2
  userDataPath: string
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-host-v2-'))
  const host = new FakeHostV2(userDataPath, { snapshot: () => snapshot, mutationMode })
  await host.start()
  cleanup.push(() => host.stop())
  return { host, userDataPath }
}

function startTui(
  userDataPath: string,
  options: { projectionRefreshMs?: number } & Partial<
    ConstructorParameters<typeof TaskWraithTui>[0]
  > = {}
) {
  const { input, output } = makeTty()
  const tui = new TaskWraithTui({
    clientVersion: '0.1.0-test',
    userDataPath,
    // These tests are about what happens once a thread is open, so they ask for
    // one the way `--thread` does. The TUI only auto-opens a REQUESTED thread;
    // an unrequested reader rests on the home frame, which is covered on its own.
    initialThreadId: 'thread-1',
    colorMode: 'none',
    animationEnabled: false,
    ...options,
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream
  })
  cleanup.push(() => tui.stop())
  return { tui, input, output }
}

describe('TaskWraithTui Host projection (Wave 4.2b)', () => {
  it('applies ordered Host deltas atomically and exposes active/history mission control', async () => {
    const activeMission = {
      missionId: 'mission-live',
      threadId: 'thread-1',
      title: 'Original mission title',
      status: 'active' as const,
      updatedAt: 10,
      activeRoundId: 'round-live'
    }
    const historyMission = {
      missionId: 'mission-history',
      threadId: 'thread-1',
      title: 'Historical proof',
      status: 'completed' as const,
      updatedAt: 5
    }
    const snapshot = makeHostSnapshot({
      missions: [activeMission, historyMission],
      rounds: [
        {
          roundId: 'round-live',
          threadId: 'thread-1',
          status: 'running',
          routing: { mode: 'continuous', fanout: 'read_only' },
          participantIds: ['lead'],
          providerRunIds: []
        }
      ],
      participants: [
        {
          id: 'lead',
          threadId: 'thread-1',
          providerId: 'claude',
          role: 'Lead',
          order: 1,
          enabled: true,
          status: 'running',
          active: true
        }
      ]
    })
    const { host, userDataPath } = await setupHost(snapshot)
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial snapshot')
    const snapshotsBeforeDelta = host.snapshotRequests

    const updatedMission = {
      ...activeMission,
      title: 'Delta mission title',
      status: 'blocked' as const,
      updatedAt: 20
    }
    const updatedThread = {
      ...snapshot.threads[0],
      latestPreview: 'Delta-updated thread preview',
      missionOutcome: 'blocked' as const,
      activeRoundId: 'round-live',
      updatedAt: 20
    }
    host.pushDeltas([
      { family: 'mission', entityId: activeMission.missionId, payload: updatedMission },
      { family: 'thread', entityId: 'thread-1', payload: updatedThread }
    ])
    feed(input, '\u0012')
    await waitFor(() => output.lastFrame.includes('Delta mission title'), 'mission delta rendered')
    expect(output.lastFrame).toContain('Missions · Active')
    expect(output.lastFrame).toContain('round-live · running')
    expect(output.lastFrame).not.toContain('fan-out')
    expect(output.lastFrame).not.toContain('CLD · Lead')
    expect(host.snapshotRequests).toBe(snapshotsBeforeDelta)

    feed(input, '\u001b[C')
    await waitFor(() => output.lastFrame.includes('Missions · History'), 'history filter')
    expect(output.lastFrame).toContain('Historical proof')
    expect(output.lastFrame).not.toContain('Delta mission title')
  })

  it('falls back to one full snapshot when a pushed delta batch breaks the cursor fence', async () => {
    let current = makeHostSnapshot()
    const { host, userDataPath } = await setupHost(current)
    const { tui, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial snapshot')
    const before = host.snapshotRequests
    current = makeHostSnapshot({
      threads: [
        {
          ...current.threads[0],
          title: 'Recovered thread',
          latestPreview: 'Recovered by full snapshot',
          updatedAt: 99
        }
      ]
    })
    host.handlers.snapshot = () => current
    host.pushDeltaResult({
      kind: 'deltas',
      generation: 3,
      fromCursor: 999,
      toCursor: 999,
      deltas: []
    })

    await waitFor(
      () => output.lastFrame.includes('Recovered by full snapshot'),
      'cursor mismatch resnapshot'
    )
    expect(host.snapshotRequests).toBe(before + 1)
  })

  it('periodically reconciles non-journalled Host shadows without losing the selected thread', async () => {
    let current = makeHostSnapshot()
    const { host, userDataPath } = await setupHost(current)
    host.handlers.snapshot = () => current
    const { tui, output } = startTui(userDataPath, { projectionRefreshMs: 25 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial snapshot')
    current = makeHostSnapshot({
      threads: [
        {
          ...current.threads[0],
          latestPreview: 'Periodic projection reconciliation',
          updatedAt: 100
        }
      ]
    })
    await waitFor(
      () => output.lastFrame.includes('Periodic projection reconciliation'),
      'periodic full snapshot',
      2_000
    )
    expect(host.snapshotRequests).toBeGreaterThanOrEqual(3)
  })

  it('connects, auto-selects via thread.select, and accepts composer.send when Host allows', async () => {
    const { host, userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(
      () =>
        output.lastFrame.includes('Solo thread') ||
        output.lastFrame.includes('Host preview only') ||
        output.lastFrame.includes('Hello TaskWraith'),
      'thread auto-selected'
    )
    expect(output.lastFrame).toContain('Hello TaskWraith')
    expect(output.lastFrame).toMatch(/Host preview only|Opened Solo thread/i)

    feed(input, 'ship the preview')
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('Host accepted composer.send'),
      'composer.send succeeded',
      5_000
    )
    expect(output.lastFrame).not.toMatch(/read-only|Wave 4\.2b/i)

    const sent = host.commands.find((command) => command.name === 'composer.send')!
    const liveRun = {
      runId: sent.commandId,
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'running' as const
    }
    host.handlers.snapshot = () => makeHostSnapshot({ runs: [liveRun] })
    host.pushDeltas([{ family: 'run', entityId: liveRun.runId, payload: liveRun }])
    await waitFor(
      () =>
        (
          tui as unknown as {
            hostSnapshot: HostSnapshot | null
          }
        ).hostSnapshot?.runs.some((run) => run.runId === liveRun.runId) === true,
      'live run projected'
    )
    feed(input, '/cancel\r\r')
    await waitFor(
      () => output.lastFrame.includes('Host accepted run.cancel'),
      'run.cancel succeeded',
      5_000
    )
    expect(host.commands.find((command) => command.name === 'run.cancel')?.arguments).toEqual({
      expectedWorkId: liveRun.runId
    })

    host.dropAllClients()
    await host.stop()
    await waitFor(
      () => output.lastFrame.includes('disconnected') || output.lastFrame.includes('reconnecting'),
      'disconnect surfaced'
    )

    const revived = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          threads: [
            {
              id: 'thread-1',
              workspaceId: 'ws-1',
              title: 'Solo thread (revived)',
              chatKind: 'single',
              archived: false,
              pinned: false,
              updatedAt: 20,
              messageCount: 1,
              providerId: 'claude',
              latestPreview: 'Hello again',
              previewTruncated: false
            }
          ]
        }),
      mutationMode: 'allow'
    })
    await revived.start()
    cleanup.push(() => revived.stop())
    // The revived Host's own preview is the proof of reattachment. A reconnect
    // no longer re-announces "Opened <title>": it is the same thread the reader
    // never left, and re-announcing it every drop is the noise this fixed.
    await waitFor(
      () => output.lastFrame.includes('Hello again'),
      'reconnected to the revived Host',
      5_000
    )
  }, 12_000)

  it('queues active-run drafts FIFO and drains one only after each exact run lifecycle', async () => {
    const initialRun = {
      runId: 'run-initial',
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'running' as const
    }
    let current = makeHostSnapshot({ runs: [initialRun] })
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-prompt-fifo-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        current = {
          ...current,
          runs: [
            ...current.runs.filter((run) => run.runId !== command.commandId),
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')

    feed(input, 'first queued\r')
    feed(input, 'second queued\r')
    await waitFor(
      () =>
        ((tui as unknown as { state: { queuedDrafts?: unknown[] } }).state.queuedDrafts?.length ??
          0) === 2,
      'two local drafts queued'
    )
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(0)

    const initialDone = { ...initialRun, providerOutcome: 'completed' as const, endedAt: 20 }
    current = { ...current, runs: [initialDone] }
    host.pushDeltas([{ family: 'run', entityId: initialRun.runId, payload: initialDone }])
    await waitFor(
      () => host.commands.filter((command) => command.name === 'composer.send').length === 1,
      'first queued draft dispatched'
    )
    const firstCommand = host.commands.find((command) => command.name === 'composer.send')!
    expect(firstCommand.arguments.text).toBe('first queued')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(1)
    const firstDone = {
      runId: firstCommand.commandId,
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'completed' as const,
      endedAt: 30
    }
    current = { ...current, runs: [initialDone, firstDone] }
    host.pushDeltas([{ family: 'run', entityId: firstCommand.commandId, payload: firstDone }])
    await waitFor(
      () => host.commands.filter((command) => command.name === 'composer.send').length === 2,
      'second queued draft dispatched'
    )
    expect(
      host.commands.filter((command) => command.name === 'composer.send')[1]?.arguments.text
    ).toBe('second queued')
  })

  it('Esc captures the current draft, requests one cancel, and waits for terminal proof', async () => {
    const active = {
      runId: 'run-active',
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'running' as const
    }
    let current = makeHostSnapshot({ runs: [active] })
    let cancelResponseDropped = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-esc-steer-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      dropCommandResponse: (command) => {
        if (command.name !== 'run.cancel' || cancelResponseDropped) return false
        cancelResponseDropped = true
        return true
      },
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        current = {
          ...current,
          runs: [
            ...current.runs,
            {
              runId: command.commandId,
              threadId: 'thread-1',
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    const snapshotsBeforeEscape = host.snapshotRequests
    host.pushDeltas([{ family: 'run', entityId: active.runId, payload: active }])
    await new Promise((resolve) => setTimeout(resolve, 20))
    feed(input, 'urgent steer')
    ;(tui as unknown as { mutationInFlight: boolean }).mutationInFlight = true
    ;(tui as unknown as { onKeypress: (input: string, key: { name: string }) => void }).onKeypress(
      '',
      { name: 'escape' }
    )
    await waitFor(
      () => host.snapshotRequests > snapshotsBeforeEscape,
      'cached projection refreshed for Escape'
    )
    expect(host.commands.filter((command) => command.name === 'run.cancel')).toHaveLength(0)
    ;(tui as unknown as { mutationInFlight: boolean }).mutationInFlight = false
    ;(tui as unknown as { flushPendingEscapeCancel: () => void }).flushPendingEscapeCancel()
    await waitFor(
      () => host.commands.filter((command) => command.name === 'run.cancel').length === 1,
      'single Escape cancellation'
    )
    await waitFor(() => host.welcomeCount >= 2, 'cancel receipt reconnect', 4_000)
    ;(tui as unknown as { onKeypress: (input: string, key: { name: string }) => void }).onKeypress(
      '',
      { name: 'escape' }
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(host.commands.filter((command) => command.name === 'run.cancel')).toHaveLength(1)
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(0)

    const terminal = { ...active, providerOutcome: 'cancelled' as const, endedAt: 40 }
    current = { ...current, runs: [terminal] }
    host.pushDeltas([{ family: 'run', entityId: active.runId, payload: terminal }])
    await waitFor(
      () => host.commands.some((command) => command.name === 'composer.send'),
      'steer dispatched after terminal proof'
    )
    expect(host.commands.find((command) => command.name === 'composer.send')?.arguments.text).toBe(
      'urgent steer'
    )
  })

  it('fresh-reads then retries one uncertain same-socket Escape cancel by exact identity', async () => {
    const active = {
      runId: 'run-same-socket-cancel',
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'running' as const
    }
    let current = makeHostSnapshot({ runs: [active] })
    let rejected = false
    const snapshotReadsAtAttempts: number[] = []
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-cancel-live-retry-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      rejectCommandBeforeHandling: (command) => {
        if (command.name !== 'run.cancel' || rejected) return false
        rejected = true
        snapshotReadsAtAttempts.push(host.snapshotRequests)
        return true
      },
      onCommand: (command) => {
        if (command.name === 'run.cancel') snapshotReadsAtAttempts.push(host.snapshotRequests)
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    feed(input, 'same socket steer')
    ;(tui as unknown as { onKeypress: (input: string, key: { name: string }) => void }).onKeypress(
      '',
      { name: 'escape' }
    )

    await waitFor(
      () => host.commands.filter((command) => command.name === 'run.cancel').length === 1,
      'exact cancel accepted after fresh read',
      4_000
    )
    const attempts = host.commandAttempts.filter((command) => command.name === 'run.cancel')
    expect(host.welcomeCount).toBe(1)
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((command) => command.commandId)).size).toBe(1)
    expect(new Set(attempts.map((command) => command.idempotencyKey)).size).toBe(1)
    expect(new Set(attempts.map((command) => command.arguments.expectedWorkId))).toEqual(
      new Set([active.runId])
    )
    expect(snapshotReadsAtAttempts[1]).toBeGreaterThan(snapshotReadsAtAttempts[0] ?? -1)
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(0)

    const terminal = { ...active, providerOutcome: 'cancelled' as const, endedAt: 41 }
    current = { ...current, runs: [terminal] }
    host.pushDeltas([{ family: 'run', entityId: active.runId, payload: terminal }])
    await waitFor(
      () => host.commands.some((command) => command.name === 'composer.send'),
      'steer dispatched after terminal proof'
    )
    expect(host.commands.find((command) => command.name === 'composer.send')?.arguments.text).toBe(
      'same socket steer'
    )
  })

  it('recovers a lost send response by exact command identity without double dispatch', async () => {
    let current = makeHostSnapshot()
    let dropped = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-receipt-recovery-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      dropCommandResponse: (command) => {
        if (command.name !== 'composer.send' || dropped) return false
        dropped = true
        return true
      },
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        current = {
          ...current,
          runs: [
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, {
      reconnectBaseDelayMs: 10,
      projectionRefreshMs: 60_000
    })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    feed(input, 'send once across reconnect\r')
    await waitFor(() => dropped, 'send response dropped')
    await waitFor(() => host.welcomeCount >= 2, 'TUI reconnected', 4_000)
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(1)
    const command = host.commands.find((candidate) => candidate.name === 'composer.send')!
    const terminal = {
      runId: command.commandId,
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'completed' as const,
      endedAt: 50
    }
    current = { ...current, runs: [terminal] }
    host.pushDeltas([{ family: 'run', entityId: command.commandId, payload: terminal }])
    await waitFor(
      () =>
        ((tui as unknown as { state: { queuedDrafts?: unknown[] } }).state.queuedDrafts?.length ??
          0) === 0,
      'queued identity recovered'
    )
    expect(host.commands.filter((candidate) => candidate.name === 'composer.send')).toHaveLength(1)
  })

  it('retries the exact command after reconnect when the Host never accepted it', async () => {
    let current = makeHostSnapshot()
    let dropped = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-unaccepted-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      dropCommandBeforeHandling: (command) => {
        if (command.name !== 'composer.send' || dropped) return false
        dropped = true
        return true
      },
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        current = {
          ...current,
          runs: [
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, {
      reconnectBaseDelayMs: 10,
      projectionRefreshMs: 60_000
    })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    feed(input, 'retry exact identity\r')
    await waitFor(() => dropped, 'first command dropped before acceptance')
    await waitFor(
      () => host.commands.filter((command) => command.name === 'composer.send').length === 1,
      'same command accepted after reconnect',
      4_000
    )
    const attempts = host.commandAttempts.filter((command) => command.name === 'composer.send')
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((command) => command.commandId)).size).toBe(1)
    expect(new Set(attempts.map((command) => command.idempotencyKey)).size).toBe(1)
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(1)
  })

  it('backs off then retries the same command when a live socket rejects before acceptance', async () => {
    let current = makeHostSnapshot()
    let rejected = false
    const snapshotReadsAtAttempts: number[] = []
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-live-retry-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      rejectCommandBeforeHandling: (command) => {
        if (command.name !== 'composer.send' || rejected) return false
        snapshotReadsAtAttempts.push(host.snapshotRequests)
        rejected = true
        return true
      },
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        snapshotReadsAtAttempts.push(host.snapshotRequests)
        current = {
          ...current,
          runs: [
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    feed(input, 'retry without reconnect\r')
    await waitFor(
      () => host.commands.filter((command) => command.name === 'composer.send').length === 1,
      'backoff retry accepted',
      4_000
    )
    expect(host.welcomeCount).toBe(1)
    const attempts = host.commandAttempts.filter((command) => command.name === 'composer.send')
    expect(attempts).toHaveLength(2)
    expect(new Set(attempts.map((command) => command.commandId)).size).toBe(1)
    expect(new Set(attempts.map((command) => command.idempotencyKey)).size).toBe(1)
    expect(snapshotReadsAtAttempts[1]).toBeGreaterThan(snapshotReadsAtAttempts[0] ?? -1)
  })

  it('keeps a queued draft bound to its original thread across a reader switch', async () => {
    const active = {
      runId: 'run-thread-a',
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'running' as const
    }
    let current = makeHostSnapshot({
      runs: [active],
      threads: [
        ...makeHostSnapshot().threads,
        {
          id: 'thread-2',
          workspaceId: 'ws-1',
          title: 'Thread B',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 5,
          messageCount: 0,
          providerId: 'claude'
        }
      ]
    })
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-thread-switch-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        current = {
          ...current,
          runs: [
            ...current.runs,
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread A selected')
    feed(input, 'stay on A\r')
    await waitFor(
      () =>
        ((tui as unknown as { state: { queuedDrafts?: unknown[] } }).state.queuedDrafts?.length ??
          0) === 1,
      'draft queued on A'
    )
    ;(tui as unknown as { applyLocalThread: (threadId: string) => void }).applyLocalThread(
      'thread-2'
    )
    const terminal = { ...active, providerOutcome: 'completed' as const, endedAt: 60 }
    current = { ...current, runs: [terminal] }
    host.pushDeltas([{ family: 'run', entityId: active.runId, payload: terminal }])
    await waitFor(
      () => host.commands.some((command) => command.name === 'composer.send'),
      'A draft dispatched'
    )
    const send = host.commands.find((command) => command.name === 'composer.send')!
    expect(send.target.threadId).toBe('thread-1')
    expect(send.arguments.text).toBe('stay on A')
    expect(
      (tui as unknown as { state: { selectedThreadId?: string } }).state.selectedThreadId
    ).toBe('thread-2')
  })

  it('takes one fresh Host read before sending a draft queued onto cached idle state', async () => {
    let current = makeHostSnapshot()
    let snapshotsAtDispatch = -1
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-cached-idle-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        snapshotsAtDispatch = host.snapshotRequests
        current = {
          ...current,
          runs: [
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    const before = host.snapshotRequests
    const updatedThread = { ...current.threads[0], updatedAt: 99 }
    current = { ...current, threads: [updatedThread] }
    host.pushDeltas([{ family: 'thread', entityId: updatedThread.id, payload: updatedThread }])
    await new Promise((resolve) => setTimeout(resolve, 20))
    feed(input, 'send after cached delta\r')
    await waitFor(() => snapshotsAtDispatch >= 0, 'cached queue dispatched')
    expect(snapshotsAtDispatch).toBe(before + 1)
    expect(host.commands.find((command) => command.name === 'composer.send')?.arguments.text).toBe(
      'send after cached delta'
    )
  })

  it('takes a fresh Host read before sending a draft queued onto connected stale state', async () => {
    let current = makeHostSnapshot()
    let snapshotsAtDispatch = -1
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-stale-idle-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => current,
      resultSummary: (command) => (command.name === 'composer.send' ? 'run_started' : undefined),
      onCommand: (command) => {
        if (command.name !== 'composer.send') return
        snapshotsAtDispatch = host.snapshotRequests
        current = {
          ...current,
          runs: [
            {
              runId: command.commandId,
              threadId: command.target.threadId,
              providerId: 'claude',
              providerOutcome: 'running'
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    const before = host.snapshotRequests
    ;(tui as unknown as { markHostProjectionStale: () => void }).markHostProjectionStale()
    feed(input, 'send after stale projection\r')
    await waitFor(() => snapshotsAtDispatch >= 0, 'stale queue dispatched')
    expect(host.welcomeCount).toBe(1)
    expect(snapshotsAtDispatch).toBeGreaterThan(before)
    expect(host.commands.find((command) => command.name === 'composer.send')?.arguments.text).toBe(
      'send after stale projection'
    )
  })

  it('does not full-resnapshot for each nonterminal delta while a draft waits', async () => {
    const active = {
      runId: 'run-streaming',
      threadId: 'thread-1',
      providerId: 'claude',
      providerOutcome: 'running' as const
    }
    let current = makeHostSnapshot({ runs: [active] })
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-queue-stream-deltas-'))
    const host = new FakeHostV2(userDataPath, { snapshot: () => current })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    feed(input, 'wait behind stream\r')
    await waitFor(
      () =>
        ((tui as unknown as { state: { queuedDrafts?: unknown[] } }).state.queuedDrafts?.length ??
          0) === 1,
      'draft queued'
    )
    const before = host.snapshotRequests
    for (let index = 0; index < 3; index += 1) {
      const update = { ...active, startedAt: index + 1 }
      current = { ...current, runs: [update] }
      host.pushDeltas([{ family: 'run', entityId: active.runId, payload: update }])
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(host.snapshotRequests).toBe(before)
    expect(host.commands.filter((command) => command.name === 'composer.send')).toHaveLength(0)
  })

  it('loads Host-v2 model offers, stages a choice, and sends only that offered selection', async () => {
    const { host, userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')
    expect(host.helloCapabilities).toContain('model-offers')
    feed(input, '\u0007')
    await waitFor(
      () => output.lastFrame.includes('Model (preview)') && output.lastFrame.includes('Opus 5'),
      'Host offers rendered'
    )

    feed(input, '\u001b[B')
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Next send uses Opus 5'), 'offer staged')

    feed(input, 'run with the staged offer')
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('Host accepted composer.send'),
      'tuned composer accepted',
      5_000
    )
    const composer = [...host.commands]
      .reverse()
      .find((command) => command.name === 'composer.send')
    expect(composer?.arguments).toMatchObject({
      text: 'run with the staged offer',
      model: 'claude-opus-5',
      reasoningEffort: 'high'
    })
  }, 12_000)

  it('uses active ASCII glyphs in inline model, reasoning, and status notices', async () => {
    const { host, userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath, { glyphs: TUI_GLYPHS_ASCII })

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')

    feed(input, '/m claude-opus-5\r')
    await waitFor(() => output.lastFrame.includes('Next send uses Opus 5'), 'inline model staged')

    feed(input, '/reasoning medium\r')
    await waitFor(
      () => output.lastFrame.includes('Next send uses Opus 5 . medium'),
      'inline reasoning staged'
    )

    feed(input, '/think\r')
    await waitFor(
      () => output.lastFrame.includes('Reasoning for Opus 5: medium . offered: medium, high'),
      'reasoning ladder shown'
    )

    feed(input, '/status\r')
    await waitFor(
      () => output.lastFrame.includes('Node Host connected . profile'),
      'ASCII Host status shown'
    )
    expect(output.lastFrame).not.toContain('·')

    feed(input, '/clear\r')
    await waitFor(
      () => output.lastFrame.includes('Scrollback reset for this TUI session.'),
      'scrollback reset'
    )

    feed(input, 'use the inline selection\r')
    await waitFor(
      () => output.lastFrame.includes('Host accepted composer.send'),
      'inline selection accepted',
      5_000
    )
    const composer = [...host.commands]
      .reverse()
      .find((command) => command.name === 'composer.send')
    expect(composer?.arguments).toMatchObject({
      model: 'claude-opus-5',
      reasoningEffort: 'medium'
    })

    feed(input, '/model unavailable\r')
    await waitFor(
      () =>
        output.lastFrame.includes('Unknown model "unavailable"') &&
        output.lastFrame.includes('claude-opus-5'),
      'invalid model notice'
    )
  }, 12_000)

  it('falls back to creating a workspace thread with /new when provider setup is unavailable', async () => {
    let snapshot = makeHostSnapshot()
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-new-thread-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => snapshot,
      resultRef: (command) => {
        if (command.name !== 'thread.create') return undefined
        snapshot = makeHostSnapshot({
          threads: [
            ...snapshot.threads,
            {
              id: 'thread-new',
              workspaceId: 'ws-1',
              title: 'Fresh solo thread',
              chatKind: 'single',
              archived: false,
              pinned: false,
              updatedAt: 11,
              messageCount: 0,
              providerId: 'claude',
              latestPreview: 'Ready for a fresh prompt',
              previewTruncated: false
            }
          ]
        })
        return { kind: 'thread', threadId: 'thread-new' }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')
    feed(input, '/new\r')
    await waitFor(() => output.lastFrame.includes('Fresh solo thread'), 'new thread opened')

    const create = [...host.commands].reverse().find((command) => command.name === 'thread.create')
    expect(create?.arguments).toEqual({ scope: 'workspace', workspaceId: 'ws-1' })
    expect(
      host.commands.some(
        (command) => command.name === 'thread.select' && command.target.threadId === 'thread-new'
      )
    ).toBe(true)
  }, 12_000)

  it('sends a new thread to the workspace picked with /workspace, not the inherited one', async () => {
    // Built from a char code so this file carries no literal control byte.
    const DOWN = String.fromCharCode(27) + '[B'
    const workspaces = [
      { id: 'ws-1', name: 'GUIGemini', path: '/tmp/guigemini', pinned: false, updatedAt: 0 },
      { id: 'ws-2', name: 'AGBench', path: '/tmp/agbench', pinned: true, updatedAt: 0 }
    ]
    let snapshot = makeHostSnapshot({ workspaces })
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-workspace-pick-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => snapshot,
      resultRef: (command) => {
        if (command.name !== 'thread.create') return undefined
        snapshot = makeHostSnapshot({
          workspaces,
          threads: [
            ...snapshot.threads,
            {
              id: 'thread-new',
              workspaceId: 'ws-2',
              title: 'Fresh solo thread',
              chatKind: 'single',
              archived: false,
              pinned: false,
              updatedAt: 11,
              messageCount: 0,
              providerId: 'claude',
              latestPreview: 'Ready for a fresh prompt',
              previewTruncated: false
            }
          ]
        })
        return { kind: 'thread', threadId: 'thread-new' }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')

    // The open thread lives in ws-1, which is ALSO workspaces[0], so both silent
    // fallbacks point at GUIGemini. Only an explicit pick can put the new thread
    // anywhere else -- which is the whole reason /workspace exists.
    feed(input, '/workspace\r')
    await waitFor(() => output.lastFrame.includes('Workspaces'), 'workspace picker open')
    feed(input, DOWN)
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('New threads will use AGBench'),
      'workspace pick confirmed'
    )

    feed(input, '/new\r')
    await waitFor(() => output.lastFrame.includes('Fresh solo thread'), 'new thread opened')
    const create = [...host.commands].reverse().find((command) => command.name === 'thread.create')
    expect(create?.arguments).toEqual({ scope: 'workspace', workspaceId: 'ws-2' })
  }, 12_000)

  it('answers /dismiss with an empty queue rather than Unknown command', async () => {
    const { userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')

    // /help advertises /dismiss, and a pending question is intercepted upstream
    // of the dispatcher -- so an advertised command must not read as unknown
    // merely because there is nothing queued to dismiss.
    feed(input, '/dismiss\r\r')
    await waitFor(() => output.lastFrame.includes('Nothing to dismiss'), 'empty-queue notice')
    expect(output.lastFrame).not.toContain('Unknown command')
  }, 12_000)

  it('archives the open thread with /archive and restores it from the picker', async () => {
    let archivedFlag = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-archive-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => {
        const base = makeHostSnapshot()
        return {
          ...base,
          threads: base.threads.map((thread) => ({ ...thread, archived: archivedFlag }))
        }
      },
      resultRef: (command) => {
        if (command.name !== 'thread.archive') return undefined
        archivedFlag = command.arguments.archived === true
        return { kind: 'thread', threadId: String(command.target.threadId) }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')

    feed(input, '/archive\r\r')
    await waitFor(() => output.lastFrame.includes('Archived Solo thread'), 'archive notice')
    const archived = [...host.commands].reverse().find((c) => c.name === 'thread.archive')
    expect(archived?.arguments).toEqual({ archived: true })

    // Archived chats are hidden, so the picker is empty until they are revealed.
    feed(input, '/threads\r')
    await waitFor(() => output.lastFrame.includes('No active threads.'), 'archived chat hidden')

    // The fake TTY's arrow sequences are unreliable in this harness, so drive
    // the overlay's real key handler directly.
    const picker = tui as unknown as {
      handleThreadPickerKey: (key: { name?: string }) => void
      state: { showArchivedThreads?: boolean }
    }
    picker.handleThreadPickerKey({ name: 'a' })
    expect(picker.state.showArchivedThreads).toBe(true)
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'archived chat revealed')

    // Enter restores rather than selecting: the Host refuses thread.select for
    // an archived thread, so /archive must not be a one-way door.
    picker.handleThreadPickerKey({ name: 'return' })
    await waitFor(
      () =>
        host.commands.some((c) => c.name === 'thread.archive' && c.arguments.archived === false),
      'restore issued'
    )
  }, 12_000)

  it('registers a workspace from /workspace with a path that contains spaces', async () => {
    const { host, userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')

    // The dispatcher splits the raw line on whitespace, and real workspace paths
    // routinely contain spaces, so the argument has to be re-joined.
    feed(input, '/workspace /Users/me/Documents/Dungeons of Darkness\r')
    await waitFor(
      () => host.commands.some((c) => c.name === 'workspace.register'),
      'workspace.register issued'
    )
    const registered = [...host.commands].reverse().find((c) => c.name === 'workspace.register')
    expect(registered?.arguments).toEqual({ path: '/Users/me/Documents/Dungeons of Darkness' })
  }, 12_000)

  it('guides /new through provider selection before creating a solo thread', async () => {
    let configured = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-new-provider-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          threads: configured
            ? [
                ...makeHostSnapshot().threads,
                {
                  id: 'thread-kimi',
                  workspaceId: 'ws-1',
                  title: 'Kimi solo thread',
                  chatKind: 'single',
                  archived: false,
                  pinned: false,
                  updatedAt: 21,
                  messageCount: 0,
                  providerId: 'kimi',
                  latestPreview: 'Ready for a Kimi prompt',
                  previewTruncated: false
                }
              ]
            : makeHostSnapshot().threads
        }),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [
        { providerId: 'claude', status: 'ready', label: 'Claude' },
        { providerId: 'kimi', status: 'ready', label: 'Kimi' }
      ],
      providerOffers: (providerId) => makeSetupOffers(providerId),
      resultRef: (command) => {
        if (command.name === 'thread.create') {
          return { kind: 'thread', threadId: 'thread-kimi' }
        }
        if (command.name === 'thread.configure') {
          configured = true
          return { kind: 'thread', threadId: 'thread-kimi' }
        }
        return undefined
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')
    feed(input, '/new\r')
    await waitFor(() => output.lastFrame.includes('New solo thread'), 'new-thread overlay')
    expect(output.lastFrame).toContain('Claude · ready')
    expect(output.lastFrame).toContain('Kimi · ready')
    feed(input, '\u001b[B')
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('create a thread'), 'provider offers')
    expect(output.lastFrame).toContain('provider  kimi')
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'thread.create'),
      'thread creation command'
    )
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Workspace write'), 'configuration choices')
    feed(input, '\u001b[C')
    feed(input, ' ')
    await waitFor(
      () => output.lastFrame.includes('Workspace write · acknowledged'),
      'posture acknowledgement'
    )
    feed(input, '\r')
    await waitFor(
      () =>
        output.lastFrame.includes('Kimi solo thread') ||
        output.lastFrame.includes('Ready for a Kimi prompt'),
      'new thread opened',
      5_000
    )
    expect(output.lastFrame).toContain('Ask TaskWraith')

    const configure = host.commands.find((command) => command.name === 'thread.configure')
    expect(configure?.arguments).toMatchObject({
      providerId: 'kimi',
      modelId: 'model-1',
      postureId: 'posture-write',
      offerRevision: 'offer-revision-1',
      reasoningId: 'reasoning-1',
      postureConsent: true
    })
  }, 15_000)

  it('lets /provider <id> skip the picker and cancel with Esc', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-provider-cmd-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [
        { providerId: 'claude', status: 'ready', label: 'Claude' },
        { providerId: 'kimi', status: 'ready', label: 'Kimi' }
      ],
      providerOffers: (providerId) => makeSetupOffers(providerId)
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initial thread selected')
    feed(input, '/provider kimi\r')
    await waitFor(() => output.lastFrame.includes('create a thread'), 'kimi offers without picker')
    expect(output.lastFrame).toContain('New solo thread')
    expect(output.lastFrame).toContain('provider  kimi')
    expect(output.lastFrame).not.toContain('Claude · ready')
    feed(input, '\u001b')
    await waitFor(() => output.lastFrame.includes('New thread cancelled'), 'esc cancels new thread')
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'previous thread restored')
    expect(output.lastFrame).toContain('Ask TaskWraith')
    expect(host.commands.some((command) => command.name === 'thread.create')).toBe(false)

    // /seats is no longer rejected as solo-only: it opens the seat lens,
    // which renders the calm capability-unavailable state on a Host that does
    // not advertise 'ensemble' (this fake does not).
    feed(input, '/seats\r')
    await waitFor(
      () => output.lastFrame.includes('seat control is unavailable on this Host'),
      'seat lens renders the calm capability-unavailable state'
    )
    expect(output.lastFrame).not.toContain('solo-only')
  }, 12_000)

  it('surfaces deferred Host asks and never treats pending as success until y accepts', async () => {
    const { userDataPath } = await setupHost(makeHostSnapshot(), 'defer')
    const { tui, input, output } = startTui(userDataPath)

    const started = tui.start()
    await waitFor(
      () => output.lastFrame.includes('Awaiting Host approval'),
      'thread.select deferred ask',
      5_000
    )
    expect(output.lastFrame).not.toMatch(/Host accepted thread\.select/i)
    expect(output.lastFrame).not.toContain('Hello TaskWraith')

    feed(input, 'y')
    await started
    await waitFor(
      () =>
        output.lastFrame.includes('Hello TaskWraith') ||
        output.lastFrame.includes('Host preview only'),
      'thread opened after accept',
      5_000
    )
    expect(output.lastFrame).toMatch(/Host preview only|Opened Solo thread/i)

    feed(input, 'do not lie about pending')
    feed(input, '\r')
    await waitFor(
      () =>
        output.lastFrame.includes('Awaiting Host approval') &&
        output.lastFrame.includes('composer.send'),
      'composer.send deferred',
      5_000
    )
    expect(output.lastFrame).not.toMatch(/Host accepted composer\.send/i)

    feed(input, 'y')
    await waitFor(
      () => output.lastFrame.includes('Host accepted composer.send'),
      'composer.send succeeded after accept',
      5_000
    )
  }, 15_000)

  it('binds y to its OWN pending ask when another projection has one of the same kind', async () => {
    // WAVE 4.2c RED-PROOF. Two concurrent pending asks share one actionKind —
    // the designed end state once Desktop is a second live projection.
    //
    // The decoy is deliberately NEWER than the ask this TUI is waiting on. The
    // old binding filtered by `actionKind === commandName` and sorted newest
    // first, so it would have resolved the decoy: this client would have
    // approved ANOTHER projection's command while its own ask hung forever.
    // Exact commandId binding cannot be fooled by recency, so this test is RED
    // against the old matching and green only against identity matching.
    const base = makeHostSnapshot()
    const decoy: HostApprovalProjection = {
      approvalId: 'decoy-approval-from-another-projection',
      commandId: 'decoy-command-that-is-never-ours',
      status: 'pending',
      actionKind: 'thread.select',
      createdAt: Date.now() + 600_000,
      summary: 'Deferred thread.select raised by another projection'
    }
    const { userDataPath } = await setupHost(
      { ...base, approvals: [...base.approvals, decoy] },
      'defer'
    )
    const { tui, input, output } = startTui(userDataPath)

    const started = tui.start()
    await waitFor(
      () => output.lastFrame.includes('Awaiting Host approval'),
      'our own thread.select deferred ask',
      5_000
    )

    feed(input, 'y')
    await started
    await waitFor(
      () =>
        output.lastFrame.includes('Hello TaskWraith') ||
        output.lastFrame.includes('Host preview only'),
      'accept resolved OUR ask rather than the newer decoy',
      5_000
    )
    expect(output.lastFrame).toMatch(/Host preview only|Opened Solo thread/i)
  }, 15_000)

  it('restores composer text when a deferred send is declined', async () => {
    const { userDataPath } = await setupHost(makeHostSnapshot(), 'defer')
    const { tui, input, output } = startTui(userDataPath)
    const started = tui.start()
    await waitFor(
      () => output.lastFrame.includes('Awaiting Host approval'),
      'deferred select',
      5_000
    )
    feed(input, 'y')
    await started
    await waitFor(
      () =>
        output.lastFrame.includes('Hello TaskWraith') ||
        output.lastFrame.includes('Host preview only'),
      'opened',
      5_000
    )

    feed(input, 'keep this draft')
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('composer.send'), 'composer pending', 5_000)
    feed(input, 'n')
    await waitFor(
      () =>
        output.lastFrame.includes('keep this draft') && /denied|decline/i.test(output.lastFrame),
      'composer restored after decline',
      5_000
    )
  }, 15_000)

  it('decides the selected thread provider approval by exact projected identity', async () => {
    const snapshot = makeHostSnapshot({
      approvals: [
        {
          approvalId: 'provider-approval-1',
          commandId: 'provider-command-1',
          threadId: 'thread-1',
          status: 'pending',
          actionKind: 'provider.tool',
          createdAt: 10,
          summary: 'Run the requested provider tool'
        }
      ]
    })
    const { host, userDataPath } = await setupHost(snapshot)
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Approval · provider.tool'), 'projected approval')
    feed(input, 'y')

    await waitFor(
      () => host.commands.some((command) => command.name === 'approval.decide'),
      'approval decision command'
    )
    const decision = host.commands.find((command) => command.name === 'approval.decide')
    expect(decision?.target).toEqual({ approvalId: 'provider-approval-1' })
    expect(decision?.arguments).toEqual({ decision: 'accept' })
  })

  it('answers projected questions oldest-first and supports explicit dismiss', async () => {
    const snapshot = makeHostSnapshot({
      questions: [
        {
          questionId: 'question-second',
          threadId: 'thread-1',
          status: 'open',
          promptPreview: 'Should I keep the fallback?',
          askedAt: 20
        },
        {
          questionId: 'question-first',
          threadId: 'thread-1',
          status: 'open',
          promptPreview: 'Which implementation should I use?',
          askedAt: 10
        }
      ]
    })
    const { host, userDataPath } = await setupHost(snapshot)
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(
      () => output.lastFrame.includes('Answer · Which implementation should I use?'),
      'first projected question'
    )
    expect(output.lastFrame).toMatch(/answer . \/dismiss/)
    feed(input, 'Use the bounded implementation')
    feed(input, '\r')

    await waitFor(
      () => host.commands.filter((command) => command.name === 'question.answer').length === 1,
      'question answer command'
    )
    const answer = host.commands.find((command) => command.name === 'question.answer')
    expect(answer?.target).toEqual({ questionId: 'question-first' })
    expect(answer?.arguments).toEqual({
      decision: 'answer',
      answer: 'Use the bounded implementation',
      isCustom: true
    })

    await waitFor(
      () => output.lastFrame.includes('Answer · Should I keep the fallback?'),
      'second projected question'
    )
    feed(input, '/dismiss')
    feed(input, '\r')
    feed(input, '\r')
    await waitFor(
      () => host.commands.filter((command) => command.name === 'question.answer').length === 2,
      'question dismiss command'
    )
    const dismiss = host.commands.filter((command) => command.name === 'question.answer')[1]
    expect(dismiss.target).toEqual({ questionId: 'question-second' })
    expect(dismiss.arguments).toEqual({ decision: 'dismiss' })
  })

  it('shows the "Open TaskWraith to answer" plain-text attention state from Host run evidence', async () => {
    const snapshot = makeHostSnapshot({
      runs: [
        {
          runId: 'run-1',
          threadId: 'thread-1',
          providerId: 'claude',
          providerOutcome: 'requires_action'
        }
      ]
    })
    const { userDataPath } = await setupHost(snapshot)
    const { tui, output } = startTui(userDataPath)

    await tui.start()
    const start = Date.now()
    while (Date.now() - start < 4_000 && !output.lastFrame.includes('Open TaskWraith to answer')) {
      output.emit('resize')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(output.lastFrame).toContain('Open TaskWraith to answer')
    expect(output.lastFrame).not.toMatch(/spinner|working…/i)
  }, 6_000)

  it('reports a missing thread without crashing when the initial thread id no longer exists', async () => {
    const { userDataPath } = await setupHost(
      makeHostSnapshot({
        threads: [
          {
            id: 'other-thread',
            workspaceId: 'ws-1',
            title: 'Other',
            chatKind: 'single',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 0,
            providerId: 'claude'
          }
        ]
      })
    )
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      initialThreadId: 'missing-thread',
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Other'), 'falls back to available thread')
  })

  it('rests on the home frame when no thread was requested', async () => {
    // Landing anywhere is a choice, and `updatedAt` is not the reader's choice:
    // the newest thread is whichever one some other surface touched last, so an
    // unrequested auto-open teleports the reader — on first connect and again on
    // every reconnect. With no `--thread` and nothing selected this session, the
    // home frame is the answer.
    const { host, userDataPath } = await setupHost()
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()

    await waitFor(() => output.lastFrame.includes('no active run'), 'home frame after connecting')
    expect(output.lastFrame).not.toContain('Hello TaskWraith')
    expect(host.commands.filter((command) => command.name === 'thread.select')).toHaveLength(0)
  })

  it('persists a unique ready-provider model from Home without creating a thread', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-home-model-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot({ threads: [] }),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [
        { providerId: 'claude', status: 'ready', label: 'Claude' },
        { providerId: 'codex', status: 'ready', label: 'Codex' }
      ],
      providerOffers: (providerId) => ({
        providerId,
        offerRevision: `${providerId}-revision`,
        models: [
          {
            modelId: providerId === 'codex' ? 'gpt-home-choice' : 'claude-home-choice',
            label: providerId === 'codex' ? 'GPT Home' : 'Claude Home',
            available: true,
            default: true,
            reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
          }
        ],
        postures: []
      })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const persisted: Array<Record<string, unknown>> = []
    const { tui, input, output } = startTui(userDataPath, {
      initialThreadId: undefined,
      persistProfileSettings: (changes) => {
        persisted.push({ ...changes })
        return true
      }
    })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('no active run'), 'home frame')
    await waitFor(
      () =>
        Boolean(
          (tui as unknown as { state: { homeTune?: { providers: unknown[] } } }).state.homeTune
            ?.providers.length
        ),
      'home defaults loaded'
    )
    await waitFor(
      () => output.lastFrame.includes('Claude Home') && output.lastFrame.includes('Default'),
      'home default painted'
    )
    feed(input, '/model gpt-home-choice\r')
    await waitFor(
      () => output.lastFrame.includes('Codex GPT Home') && output.lastFrame.includes('Default'),
      'home model persisted'
    )
    expect(persisted).toContainEqual({
      providerId: 'codex',
      modelId: 'gpt-home-choice',
      reasoningId: undefined
    })
    expect(host.commands).toHaveLength(0)
  })

  it('opens a credential-free /login hub and begins only an advertised flow', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-login-hub-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [
        {
          providerId: 'pi',
          status: 'auth_required',
          label: 'Pi',
          detail: 'Host environment key required.'
        },
        { providerId: 'claude', status: 'auth_required', label: 'Claude' }
      ],
      providerAuthStatus: (providerId) => ({ providerId, state: 'unauthenticated' }),
      providerAuthFlows: (providerId) =>
        providerId === 'claude'
          ? [{ flowId: 'claude:login', kind: 'manual', label: 'Sign in', available: true }]
          : [],
      resultRef: (command) =>
        command.name === 'provider.auth.begin'
          ? {
              kind: 'provider-auth',
              providerId: command.target.providerId,
              operationId: command.commandId
            }
          : undefined
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')

    feed(input, '/login pi\r')
    await waitFor(() => output.lastFrame.includes('Host environment key required'), 'Pi guidance')
    expect(host.commands).toHaveLength(1) // initial thread.select only
    ;(tui as unknown as { onKeypress: (input: string, key: { name: string }) => void }).onKeypress(
      '',
      { name: 'down' }
    )
    await waitFor(() => output.lastFrame.includes('Sign in'), 'Claude flow')
    ;(tui as unknown as { onKeypress: (input: string, key: { name: string }) => void }).onKeypress(
      '',
      { name: 'enter' }
    )
    await waitFor(
      () => host.commands.filter((command) => command.name === 'provider.auth.begin').length === 1,
      'one auth begin'
    )
    expect(
      host.commands.filter(
        (command) => command.name === 'thread.create' || command.name === 'thread.configure'
      )
    ).toHaveLength(0)
    expect(
      host.commands.find((command) => command.name === 'provider.auth.begin')?.arguments
    ).toEqual({ flowId: 'claude:login' })
  })

  it('lazily creates a remembered default thread and sends the first ordinary prompt', async () => {
    const workspaces = [
      {
        id: 'ws-remembered',
        name: 'Remembered',
        path: '/tmp/remembered',
        pinned: false,
        updatedAt: 1
      },
      { id: 'ws-newer', name: 'Newer', path: '/tmp/newer', pinned: false, updatedAt: 20 }
    ]
    let configured = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-lazy-default-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          workspaces,
          threads: configured
            ? [
                {
                  id: 'thread-lazy',
                  workspaceId: 'ws-remembered',
                  title: 'New Chat',
                  chatKind: 'single',
                  archived: false,
                  pinned: false,
                  updatedAt: 30,
                  messageCount: 0,
                  providerId: 'claude',
                  latestPreview: '',
                  previewTruncated: false
                }
              ]
            : []
        }),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [
        { providerId: 'codex', status: 'ready', label: 'Codex' },
        { providerId: 'claude', status: 'ready', label: 'Claude' }
      ],
      providerOffers: () => ({
        providerId: 'claude',
        offerRevision: 'claude-offers-1',
        models: [
          { modelId: 'first-model', label: 'First', available: true, reasoning: [] },
          {
            modelId: 'remembered-model',
            label: 'Remembered',
            available: true,
            default: true,
            reasoning: [{ reasoningId: 'medium', label: 'Medium', available: true }]
          }
        ],
        postures: [
          {
            postureId: 'read_only',
            label: 'Read only',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'read'
          },
          {
            postureId: 'default',
            label: 'Accept Edits',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'workspace_write'
          }
        ]
      }),
      resultRef: (command) => {
        if (command.name === 'thread.create') {
          return { kind: 'thread', threadId: 'thread-lazy' }
        }
        if (command.name === 'thread.configure') {
          configured = true
          return { kind: 'thread', threadId: 'thread-lazy' }
        }
        return undefined
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const persisted: Array<Record<string, unknown>> = []
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      profileSettings: {
        workspaceId: 'ws-remembered',
        providerId: 'claude',
        modelId: 'remembered-model'
      },
      persistProfileSettings: (changes) => {
        persisted.push({ ...changes })
        return true
      },
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()
    await waitFor(() => output.lastFrame.includes('no active run'), 'home frame')

    feed(input, 'send this without choosing a chat\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'composer.send'),
      'lazy first prompt sent',
      8_000
    )

    expect(host.commands.slice(0, 3).map((command) => command.name)).toEqual([
      'thread.create',
      'thread.configure',
      'composer.send'
    ])
    expect(host.commands[0].arguments).toEqual({
      scope: 'workspace',
      workspaceId: 'ws-remembered'
    })
    expect(host.commands[1].arguments).toEqual({
      providerId: 'claude',
      modelId: 'remembered-model',
      postureId: 'default',
      offerRevision: 'claude-offers-1'
    })
    expect(host.commands[2].arguments).toMatchObject({
      text: 'send this without choosing a chat'
    })
    expect(persisted).toContainEqual({ workspaceId: 'ws-remembered' })
    expect(persisted).toContainEqual({
      providerId: 'claude',
      modelId: 'remembered-model',
      reasoningId: undefined
    })
  }, 12_000)

  it('keeps the first draft and opens guided setup when no provider is ready', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-lazy-auth-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [{ providerId: 'claude', status: 'auth_required', label: 'Claude' }],
      providerAuthStatus: () => ({ providerId: 'claude', state: 'unauthenticated' }),
      providerAuthFlows: () => [
        { flowId: 'claude:login', kind: 'manual', label: 'Sign in', available: true }
      ]
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      colorMode: 'none',
      animationEnabled: false,
      profileSettings: { providerId: 'claude' },
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()
    await waitFor(() => output.lastFrame.includes('no active run'), 'home frame')

    feed(input, 'keep this draft\r')
    await waitFor(() => output.lastFrame.includes('Sign in'), 'guided auth setup')
    expect((tui as unknown as { state: { input: string } }).state.input).toBe('keep this draft')
    expect(host.commands.some((command) => command.name === 'thread.create')).toBe(false)
  })

  it('opens the requested thread on connect when one was asked for', async () => {
    const { userDataPath } = await setupHost()
    const { input, output } = makeTty()
    const persisted: Array<Record<string, unknown>> = []
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      userDataPath,
      initialThreadId: 'thread-1',
      colorMode: 'none',
      animationEnabled: false,
      persistProfileSettings: (changes) => {
        persisted.push({ ...changes })
        return true
      },
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    cleanup.push(() => tui.stop())
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'requested thread opened')
    expect(output.lastFrame).not.toContain('no active run')
    expect(persisted).toContainEqual({ workspaceId: 'ws-1' })
  })

  it('opens, filters, navigates and completes the slash-command palette', async () => {
    const { userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')

    feed(input, '/')
    await waitFor(() => output.lastFrame.includes('Commands'), 'slash palette opened')
    feed(input, '\u001b[B')
    await waitFor(
      () => (tui as unknown as { state: { overlayIndex: number } }).state.overlayIndex === 1,
      'slash palette arrow navigation'
    )
    feed(input, '\u001b[6~')
    await waitFor(
      () => (tui as unknown as { state: { overlayIndex: number } }).state.overlayIndex > 1,
      'slash palette page navigation'
    )
    feed(input, 'mo')
    await waitFor(
      () => output.lastFrame.includes('/model [id]') && !output.lastFrame.includes('/workspace'),
      'slash palette filtered'
    )
    feed(input, '\t')
    await waitFor(
      () => !output.lastFrame.includes('Commands') && output.lastFrame.includes('/model'),
      'slash command completed'
    )
    expect(output.lastFrame).not.toContain('Model (preview)')

    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Model (preview)'), 'completed command executed')
  })

  it('keeps destructive palette selections inert and closes on arguments or clear keys', async () => {
    const { host, userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'thread selected')

    feed(input, '/archive\r')
    await waitFor(
      () => !output.lastFrame.includes('Commands') && output.lastFrame.includes('/archive'),
      'destructive command completed without executing'
    )
    expect(host.commands.some((command) => command.name === 'thread.archive')).toBe(false)

    feed(input, '\u0015')
    await waitFor(() => !output.lastFrame.includes('/archive'), 'Ctrl+U cleared completion')
    feed(input, '/git ')
    await waitFor(
      () => !output.lastFrame.includes('Commands') && output.lastFrame.includes('/git'),
      'argument whitespace closed palette'
    )
    feed(input, '\u0015')
    feed(input, '/')
    await waitFor(() => output.lastFrame.includes('Commands'), 'palette reopened')
    feed(input, '\u007f')
    await waitFor(() => !output.lastFrame.includes('Commands'), 'backspace removed slash')

    feed(input, 'ordinary draft')
    feed(input, '\u0010')
    await waitFor(
      () => output.lastFrame.includes('Commands') && output.lastFrame.includes('/model [id]'),
      'Ctrl+P opened the unfiltered palette'
    )
    expect((tui as unknown as { state: { input: string } }).state.input).toBe('ordinary draft')
    feed(input, '\u0010')
    await waitFor(() => !output.lastFrame.includes('Commands'), 'Ctrl+P closed palette')
    expect((tui as unknown as { state: { input: string } }).state.input).toBe('ordinary draft')
    feed(input, '\u0015')
    feed(input, '/help\r')
    await waitFor(() => output.lastFrame.includes('Commands'), '/help opened palette')
  })

  it('keeps the reader overlay open across a Host reconnect', async () => {
    // A reconnect re-attaches the same thread, and re-attaching used to run the
    // full open path: overlay closed, scroll snapped to the bottom, seat lens
    // dropped. On a Host that drops the connection every few seconds that reads
    // as "every time I try to go somewhere it pulls me back".
    const { host, userDataPath } = await setupHost()
    const persisted: Array<Record<string, unknown>> = []
    const { tui, input, output } = startTui(userDataPath, {
      reconnectBaseDelayMs: 10,
      persistProfileSettings: (changes) => {
        persisted.push({ ...changes })
        return true
      }
    })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread open')
    const persistedBeforeReconnect = persisted.length

    feed(input, '\u000b')
    await waitFor(() => output.lastFrame.includes('Threads'), 'thread picker open')

    const welcomesBefore = host.welcomeCount
    host.dropAllClients()
    await waitFor(() => host.welcomeCount > welcomesBefore, 'Host reconnect', 4_000)
    await waitFor(() => output.lastFrame.includes('Threads'), 'picker survived reconnect', 4_000)
    expect(output.lastFrame).toContain('Threads')
    expect(persisted).toHaveLength(persistedBeforeReconnect)
  }, 10_000)

  it('keeps the reader scroll position across a Host reconnect', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-reattach-scroll-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [
        'bootstrap',
        'snapshot',
        'deltas',
        'model-offers',
        'health',
        'commands',
        'receipts',
        'history'
      ],
      threadHistory: (request) => ({
        threadId: request.threadId,
        generation: 3,
        cursor: 11,
        entries: Array.from({ length: 60 }, (_unused, index) => ({
          entryId: `history-${index}`,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          createdAt: index + 1,
          text: `Transcript line ${index}`
        }))
      })
    })
    await host.start()
    cleanup.push(() => host.stop())

    const { tui, input, output } = startTui(userDataPath, { reconnectBaseDelayMs: 10 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Transcript line 59'), 'transcript at the end')

    feed(input, '\u001b[5~')
    await waitFor(
      () => !output.lastFrame.includes('Transcript line 59'),
      'scrolled back from the end'
    )

    const welcomesBefore = host.welcomeCount
    host.dropAllClients()
    await waitFor(() => host.welcomeCount > welcomesBefore, 'Host reconnect', 4_000)
    await waitFor(() => output.lastFrame.includes('Transcript line'), 'transcript re-read', 4_000)
    await new Promise((settle) => setTimeout(settle, 150))

    expect(output.lastFrame).not.toContain('Transcript line 59')
  }, 10_000)

  it('accepts bracketed-paste text as a single composer insertion including embedded line breaks', async () => {
    const { userDataPath } = await setupHost()
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'connected')
    feed(input, '\u001b[200~line one\nline two\u001b[201~')
    await waitFor(() => output.lastFrame.includes('line one'), 'paste inserted')
    expect(output.lastFrame).toContain('line two')
  })

  it('opens a projected thread locally when Host commands are unavailable', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-readonly-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: ['bootstrap', 'snapshot', 'deltas', 'model-offers', 'health', 'receipts']
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'read-only thread preview')

    expect(host.commands).toHaveLength(0)
    expect(output.lastFrame).toContain('Host preview only')
  })

  it('loads a bounded history page and requests older entries at the transcript top', async () => {
    let historyRequests = 0
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-history-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [
        'bootstrap',
        'snapshot',
        'deltas',
        'model-offers',
        'health',
        'commands',
        'receipts',
        'history'
      ],
      threadHistory: (request) => {
        historyRequests += 1
        return request.before
          ? {
              threadId: request.threadId,
              generation: 3,
              cursor: 11,
              entries: [
                {
                  entryId: 'history-older',
                  role: 'user',
                  createdAt: 1,
                  text: 'Older bounded history entry'
                }
              ]
            }
          : {
              threadId: request.threadId,
              generation: 3,
              cursor: 11,
              entries: [
                {
                  entryId: 'history-current',
                  role: 'assistant',
                  createdAt: 2,
                  text: 'Current bounded history entry'
                }
              ],
              nextBefore: { generation: 3, cursor: 1 }
            }
      },
      historySince: (request) => ({
        kind: 'deltas',
        threadId: request.threadId,
        generation: request.since.generation,
        fromCursor: request.since.cursor,
        toCursor: request.since.cursor,
        deltas: []
      })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(
      () => output.lastFrame.includes('Current bounded history entry'),
      'initial history page'
    )
    feed(input, '\u001b[5~')
    await waitFor(() => historyRequests >= 2, 'older history page request')
    await waitFor(
      () => output.lastFrame.includes('Older bounded history entry'),
      'older history render'
    )
  })

  it('drives Host setup through exact result refs before enabling the composer', async () => {
    let configured = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-cold-start-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          workspaces: configured
            ? [
                {
                  id: 'setup-workspace-1',
                  name: 'Setup workspace',
                  path: '/tmp/tui-cold-start',
                  pinned: false,
                  updatedAt: 10
                }
              ]
            : [],
          threads: configured ? [makeSetupThread()] : []
        }),
      capabilities: [
        'bootstrap',
        'snapshot',
        'deltas',
        'model-offers',
        'health',
        'commands',
        'receipts',
        'provider-catalog',
        'setup'
      ],
      providerStatuses: () => [
        { providerId: 'provider-1', status: 'ready', label: 'Provider One' }
      ],
      providerOffers: () => makeSetupOffers(),
      resultRef: (command) => {
        if (command.name === 'workspace.register') {
          return { kind: 'workspace', workspaceId: 'setup-workspace-1' }
        }
        if (command.name === 'thread.create') {
          return { kind: 'thread', threadId: 'setup-thread-1' }
        }
        if (command.name === 'thread.configure') {
          configured = true
          return { kind: 'thread', threadId: 'setup-thread-1' }
        }
        return undefined
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)

    await tui.start()
    await waitFor(
      () => output.lastFrame.includes('absolute workspace path'),
      'workspace setup prompt'
    )
    feed(input, '/tmp/tui-cold-start')
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'workspace.register'),
      'workspace registration command'
    )

    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Provider One'), 'provider selection')
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('create a thread'), 'thread creation prompt')
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'thread.create'),
      'thread creation command'
    )

    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Workspace write'), 'configuration choices')
    feed(input, '\u001b[C')
    feed(input, ' ')
    await waitFor(
      () => output.lastFrame.includes('Workspace write · acknowledged'),
      'posture acknowledgement'
    )
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Ask TaskWraith'), 'composer enabled')

    expect(host.commands.map((command) => command.name)).toEqual([
      'workspace.register',
      'thread.create',
      'thread.configure'
    ])
    const configure = host.commands.at(-1)!
    expect(configure.target).toEqual({ threadId: 'setup-thread-1' })
    expect(configure.arguments).toEqual({
      providerId: 'provider-1',
      modelId: 'model-1',
      postureId: 'posture-write',
      offerRevision: 'offer-revision-1',
      reasoningId: 'reasoning-1',
      postureConsent: true
    })
  })

  it('adds a launch-bound proof only when the user confirms Full Access', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-full-access-'))
    const proofSecret = Buffer.alloc(32, 9)
    const verifier = new HostPermissionConsentAuthority(proofSecret)
    cleanup.push(() => verifier.dispose())
    let proofAccepted = false
    const host = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          workspaces: [
            {
              id: 'ws-full-access',
              name: 'Full Access workspace',
              path: '/tmp/full-access',
              pinned: false,
              updatedAt: 1
            }
          ],
          threads: []
        }),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [{ providerId: 'codex', status: 'ready', label: 'Codex' }],
      providerOffers: () => ({
        providerId: 'codex',
        offerRevision: 'full-access-offer-1',
        models: [
          {
            modelId: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            available: true,
            default: true,
            reasoning: []
          }
        ],
        postures: [
          {
            postureId: 'default',
            label: 'Accept Edits',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'workspace_write'
          },
          {
            postureId: 'full_access',
            label: 'Full Access (YOLO)',
            available: true,
            requiresExplicitConsent: true,
            ceiling: 'full_access',
            detail: 'Verified Codex transport'
          }
        ]
      }),
      resultRef: (command) => {
        if (command.name === 'thread.create') {
          return { kind: 'thread', threadId: 'thread-full-access' }
        }
        if (command.name === 'thread.configure') {
          return { kind: 'thread', threadId: 'thread-full-access' }
        }
        return undefined
      },
      onCommand: (command) => {
        if (command.name !== 'thread.configure') return
        const request: HostPermissionConsentProofRequest = {
          commandId: command.commandId,
          actor: command.actor,
          threadId: command.target.threadId,
          providerId: command.arguments.providerId as string,
          modelId: command.arguments.modelId as string,
          postureId: 'full_access',
          offerRevision: command.arguments.offerRevision as string,
          issuedAt: command.issuedAt
        }
        proofAccepted = verifier.verifyRequestProof(request, command.arguments.postureConsentProof)
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const source = Buffer.from(proofSecret)
    proofSecret.fill(0)
    const presence = createTuiFullAccessPresence(source, {
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      hostId: 'fake-host',
      hostVersion: '1.9.1-preview'
    })
    source.fill(0)
    const { tui, input, output } = startTui(userDataPath, {
      initialThreadId: undefined,
      fullAccessPresence: presence,
      reconnectBaseDelayMs: 60_000
    })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('no active run'), 'home frame')
    feed(input, '/new codex\r')
    await waitFor(() => output.lastFrame.includes('create a thread'), 'thread creation prompt')
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'thread.create'),
      'thread created'
    )
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Accept Edits'), 'posture choices')
    feed(input, '\u001b[C')
    await waitFor(() => output.lastFrame.includes('Full Access (YOLO)'), 'Full Access selected')
    feed(input, ' ')
    await waitFor(
      () => output.lastFrame.includes('Full Access (YOLO) · acknowledged'),
      'Full Access acknowledged'
    )
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'thread.configure'),
      'Full Access configure submitted'
    )

    const configure = host.commands.find((command) => command.name === 'thread.configure')!
    expect(configure.target).toEqual({ threadId: 'thread-full-access' })
    expect(configure.arguments).toMatchObject({
      providerId: 'codex',
      modelId: 'gpt-5.6-terra',
      postureId: 'full_access',
      offerRevision: 'full-access-offer-1',
      postureConsent: true,
      postureConsentProof: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(proofAccepted).toBe(true)
    host.dropAllClients()
    await waitFor(
      () =>
        (tui as unknown as { state: { connection: string } }).state.connection === 'reconnecting',
      'presence connection dropped'
    )
    expect(
      (
        tui as unknown as { hasMatchingFullAccessPresence: () => boolean }
      ).hasMatchingFullAccessPresence()
    ).toBe(false)
  })

  it('keeps Host-offered Full Access unavailable without matching launch presence', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-full-access-mismatch-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          workspaces: [
            {
              id: 'ws-full-access',
              name: 'Full Access workspace',
              path: '/tmp/full-access',
              pinned: false,
              updatedAt: 1
            }
          ],
          threads: []
        }),
      capabilities: SETUP_HOST_CAPABILITIES,
      providerStatuses: () => [{ providerId: 'codex', status: 'ready', label: 'Codex' }],
      providerOffers: () => ({
        providerId: 'codex',
        offerRevision: 'full-access-offer-1',
        models: [
          {
            modelId: 'gpt-5.6-terra',
            label: 'GPT-5.6 Terra',
            available: true,
            default: true,
            reasoning: []
          }
        ],
        postures: [
          {
            postureId: 'default',
            label: 'Accept Edits',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'workspace_write'
          },
          {
            postureId: 'full_access',
            label: 'Full Access (YOLO)',
            available: true,
            requiresExplicitConsent: true,
            ceiling: 'full_access',
            detail: 'Verified Codex transport'
          }
        ]
      }),
      resultRef: (command) =>
        command.name === 'thread.create'
          ? { kind: 'thread', threadId: 'thread-full-access' }
          : undefined
    })
    await host.start()
    cleanup.push(() => host.stop())
    const source = Buffer.alloc(32, 4)
    const mismatched = createTuiFullAccessPresence(source, {
      pid: process.pid + 1,
      startedAt: new Date(0).toISOString(),
      hostId: 'fake-host',
      hostVersion: '1.9.1-preview'
    })
    source.fill(0)
    const { tui, input, output } = startTui(userDataPath, {
      initialThreadId: undefined,
      fullAccessPresence: mismatched
    })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('no active run'), 'home frame')
    feed(input, '/new codex\r')
    await waitFor(() => output.lastFrame.includes('create a thread'), 'thread creation prompt')
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'thread.create'),
      'thread created'
    )
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('fresh standalone Host'),
      'Full Access presence warning'
    )
    ;(tui as unknown as { state: { coldStartPostureIndex?: number } }).state.coldStartPostureIndex =
      1
    feed(input, '\r')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(host.commands.filter((command) => command.name === 'thread.configure')).toHaveLength(0)
    expect(host.commandAttempts.some((command) => command.arguments.postureConsentProof)).toBe(
      false
    )
  })

  it('retains provider-auth state across refresh/reconnect without replaying begin', async () => {
    let authenticated = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-auth-start-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot({ workspaces: [], threads: [] }),
      capabilities: [
        'bootstrap',
        'snapshot',
        'deltas',
        'model-offers',
        'health',
        'commands',
        'receipts',
        'provider-catalog',
        'provider-auth',
        'setup'
      ],
      providerStatuses: () => [
        { providerId: 'provider-1', status: 'auth_required', label: 'Provider One' }
      ],
      providerAuthFlows: () => [
        { flowId: 'flow-1', kind: 'browser', label: 'Sign in in browser', available: true }
      ],
      providerAuthStatus: () => ({
        providerId: 'provider-1',
        state: authenticated ? 'authenticated' : 'unauthenticated'
      }),
      providerOffers: () => makeSetupOffers(),
      resultRef: (command) =>
        command.name === 'workspace.register'
          ? { kind: 'workspace', workspaceId: 'setup-workspace-1' }
          : command.name === 'provider.auth.begin'
            ? { kind: 'provider-auth', providerId: 'provider-1', operationId: command.commandId }
            : undefined
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { reconnectBaseDelayMs: 10 })

    await tui.start()
    await waitFor(
      () => output.lastFrame.includes('absolute workspace path'),
      'workspace setup prompt'
    )
    feed(input, '/tmp/tui-auth-start')
    feed(input, '\r')
    await waitFor(
      () => host.commands.some((command) => command.name === 'workspace.register'),
      'workspace registration command'
    )
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Provider One'), 'provider selection')
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('Sign in in browser'), 'auth-flow selection')
    feed(input, '\r')
    await waitFor(
      () => host.commands.filter((command) => command.name === 'provider.auth.begin').length === 1,
      'provider auth begin command'
    )
    await waitFor(
      () => output.lastFrame.includes('Authentication is still pending'),
      'pending auth status'
    )

    feed(input, '\r')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(host.commands.filter((command) => command.name === 'provider.auth.begin')).toHaveLength(
      1
    )

    host.dropAllClients()
    await waitFor(() => host.welcomeCount >= 2, 'Host reconnect')
    feed(input, '\r')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(host.commands.filter((command) => command.name === 'provider.auth.begin')).toHaveLength(
      1
    )

    authenticated = true
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('create a thread'),
      'authenticated provider offers'
    )
    expect(host.commands.filter((command) => command.name === 'provider.auth.begin')).toHaveLength(
      1
    )
  })
})

describe('TaskWraithTui terminal restoration', () => {
  it('restores raw mode and the primary screen buffer on stop()', async () => {
    const { input, output } = makeTty()
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await tui.start()
    expect(input.isRawMode).toBe(true)
    expect(output.frames.some((frame) => frame.includes('\u001b[?1049h'))).toBe(true)
    tui.stop()
    expect(input.isRawMode).toBe(false)
    expect(output.frames.at(-1) ?? '').toContain('\u001b[?1049l')
  })

  it('restores the terminal even when startup fails after raw mode is entered', async () => {
    const { input, output } = makeTty()
    const write = output.write.bind(output)
    let writes = 0
    output.write = (chunk: string) => {
      writes += 1
      if (writes === 1) {
        write(chunk)
        throw new Error('forced render failure')
      }
      return write(chunk)
    }
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await expect(tui.start()).rejects.toThrow(/forced render failure/)
    expect(input.isRawMode).toBe(false)
  })

  it('restores raw mode when the alternate-screen write fails during startup', async () => {
    const { input, output } = makeTty()
    output.write = () => {
      throw new Error('alternate screen failed')
    }
    const tui = new TaskWraithTui({
      clientVersion: '0.1.0-test',
      demo: true,
      colorMode: 'none',
      animationEnabled: false,
      input: input as unknown as ReadStream,
      output: output as unknown as WriteStream
    })
    await expect(tui.start()).rejects.toThrow(/alternate screen failed/)
    expect(input.isRawMode).toBe(false)
  })
})

describe('TaskWraithTui reconnect revival', () => {
  it('re-arms the Host launcher after repeated failures and reconnects to the relaunched Host', async () => {
    const { host, userDataPath } = await setupHost()
    let revives = 0
    const { tui, output } = startTui(userDataPath, {
      reconnectBaseDelayMs: 20,
      reviveFailureThreshold: 2,
      reviveHost: async () => {
        revives += 1
        if (revives > 1) return { kind: 'existing' as const }
        const revived = new FakeHostV2(userDataPath, {
          snapshot: () =>
            makeHostSnapshot({
              threads: [
                {
                  id: 'thread-1',
                  workspaceId: 'ws-1',
                  title: 'Solo thread (relaunched)',
                  chatKind: 'single',
                  archived: false,
                  pinned: false,
                  updatedAt: 30,
                  messageCount: 1,
                  providerId: 'claude',
                  latestPreview: 'Back online',
                  previewTruncated: false
                }
              ]
            }),
          mutationMode: 'allow'
        })
        await revived.start()
        cleanup.push(() => revived.stop())
        return { kind: 'launched' as const, pid: process.pid }
      }
    })

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initially connected')

    // Kill the live Host mid-session so the TUI enters the reconnecting state.
    host.dropAllClients()
    await host.stop()

    // Same as above: the relaunched Host's own preview proves the reattachment,
    // and a reconnect deliberately no longer re-announces the thread title.
    await waitFor(
      () => output.lastFrame.includes('Back online'),
      'reconnected to the relaunched Host',
      10_000
    )
    expect(revives).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('does not invoke the launcher when no session was ever established', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-revive-offline-'))
    let revives = 0
    const { tui } = startTui(userDataPath, {
      reconnectBaseDelayMs: 20,
      reviveFailureThreshold: 1,
      reviveHost: async () => {
        revives += 1
        return { kind: 'existing' as const }
      }
    })
    await tui.start()
    // No Host exists here, so the TUI stays "offline · retrying": the revive
    // path requires everConnected and must never fire for a never-seen Host.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(revives).toBe(0)
    tui.stop()
  }, 10_000)

  it('opens the /git overlay with a calm unavailable state when the Host has no git capability', async () => {
    // The fake Host offers no workspace-git — a normal configuration, NOT an
    // error. RED at HEAD: /git was an unknown command and no overlay opened.
    const { userDataPath } = await setupHost(makeHostSnapshot())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread visible')
    feed(input, '/git\r')
    await waitFor(
      () => output.lastFrame.includes('git is unavailable on this Host'),
      'calm unavailable state'
    )
    expect(output.lastFrame).not.toContain('Unknown command')
    expect(output.lastFrame).not.toContain('failed')
  })

  it('renders branch and status rows when the Host serves workspace git reads', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-git-host-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [...SETUP_HOST_CAPABILITIES, 'workspace-git'],
      workspaceGitRead: (params) => {
        expect(params.workspaceId).toBe('ws-1')
        return {
          scope: 'status',
          branch: 'main',
          head: '0123456789abcdef0123456789abcdef01234567',
          truncated: false,
          files: [
            {
              path: 'src/tui/render.ts',
              index: 'M',
              workingTree: 'M',
              kind: 'modified',
              staged: false,
              unstaged: true
            },
            {
              path: 'src/tui/new-file.ts',
              index: 'A',
              workingTree: 'A',
              kind: 'created',
              staged: true,
              unstaged: false
            },
            {
              path: 'notes.txt',
              index: '?',
              workingTree: '?',
              kind: 'untracked',
              staged: false,
              unstaged: false
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread visible')
    feed(input, '/git\r')
    await waitFor(() => output.lastFrame.includes('main'), 'branch rendered')
    await waitFor(() => output.lastFrame.includes('src/tui/render.ts'), 'status row rendered')
    expect(output.lastFrame).toContain('0123456')
  })

  it('shows the truncation banner when the Host marks a diff truncated', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-git-truncated-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [...SETUP_HOST_CAPABILITIES, 'workspace-git'],
      workspaceGitRead: () => ({
        scope: 'diff',
        branch: 'main',
        head: '0123456789abcdef0123456789abcdef01234567',
        truncated: true,
        text: 'diff --git a/big.ts b/big.ts\n@@ -1 +1 @@\n+partial'
      })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread visible')
    feed(input, '/git diff\r')
    // A truncated diff rendered as complete is the failure the 128KiB cap
    // exists to prevent — the banner must be plainly visible.
    await waitFor(() => output.lastFrame.includes('truncated'), 'truncation banner')
    expect(output.lastFrame).toContain('partial')
  })

  it('shows a notice instead of fabricating git data in demo mode', async () => {
    const { input, output, tui } = startTui(join(tmpdir(), 'taskwraith-tui-git-demo-'), {
      demo: true
    })
    await tui.start()
    feed(input, '/git\r')
    await waitFor(() => output.lastFrame.includes('demo'), 'demo notice rendered')
    expect(output.lastFrame).not.toContain('main')
    expect(output.lastFrame).not.toContain('Unknown command')
  })

  it('drops a late git read dispatched for a different workspace after a thread switch', async () => {
    // A read dispatched for thread A/ws-1, then the user switches to thread B
    // (ws-2) and reopens /git; A's answer arriving LATE must never render
    // under B's header — that is another repository's diff. The pre-fix guard
    // checked only overlay+scope, so this lands A's data at HEAD.
    const late: { resolve?: (result: HostWorkspaceGitReadResult) => void } = {}
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-git-stale-thread-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () =>
        makeHostSnapshot({
          workspaces: [
            { id: 'ws-1', name: 'AGBench', path: '/tmp/agbench', pinned: true, updatedAt: 0 },
            { id: 'ws-2', name: 'Other repo', path: '/tmp/other', pinned: false, updatedAt: 1 }
          ],
          threads: [
            {
              id: 'thread-1',
              workspaceId: 'ws-1',
              title: 'Solo thread A',
              chatKind: 'single',
              archived: false,
              pinned: false,
              updatedAt: 20,
              messageCount: 1,
              providerId: 'claude',
              latestPreview: 'Hello TaskWraith',
              previewTruncated: false
            },
            {
              id: 'thread-2',
              workspaceId: 'ws-2',
              title: 'Solo thread B',
              chatKind: 'single',
              archived: false,
              pinned: false,
              updatedAt: 10,
              messageCount: 1,
              providerId: 'claude',
              latestPreview: 'Other repo thread',
              previewTruncated: false
            }
          ]
        }),
      capabilities: [...SETUP_HOST_CAPABILITIES, 'workspace-git'],
      workspaceGitRead: (params) => {
        if (params.workspaceId === 'ws-1') {
          return new Promise<HostWorkspaceGitReadResult>((resolve) => {
            late.resolve = resolve
          })
        }
        return {
          scope: 'status',
          branch: 'b-branch',
          head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          truncated: false,
          files: [
            {
              path: 'b-repo-file.ts',
              index: 'M',
              workingTree: 'M',
              kind: 'modified',
              staged: false,
              unstaged: true
            }
          ]
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread A'), 'thread A selected')
    feed(input, '/git\r')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(late.resolve).toBeTruthy()
    // Switch to thread B through the TUI's real openThread (it closes the
    // overlay), then reopen /git there — the composer is free once the
    // overlay is closed.
    await (tui as unknown as { openThread: (threadId: string) => Promise<void> }).openThread(
      'thread-2'
    )
    await waitFor(() => output.lastFrame.includes('Solo thread B'), 'thread B open')
    feed(input, '/git\r')
    await waitFor(() => output.lastFrame.includes('b-repo-file.ts'), 'B read landed')
    // Now A's answer arrives late — it must be dropped, never rendered.
    late.resolve?.({
      scope: 'status',
      branch: 'a-branch',
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      truncated: false,
      files: [
        {
          path: 'a-repo-file.ts',
          index: 'M',
          workingTree: 'M',
          kind: 'modified',
          staged: false,
          unstaged: true
        }
      ]
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(output.lastFrame).not.toContain('a-repo-file.ts')
    expect(output.lastFrame).not.toContain('a-branch')
    expect(output.lastFrame).toContain('b-repo-file.ts')
  })

  it('drops an out-of-order same-scope read when the path changed', async () => {
    // `/git diff a.ts` then `/git diff b.ts`: the older answer must not land
    // over the newer — same scope, different path. The second dispatch goes
    // through the TUI's real openGitOverlay — the same method the command
    // chain calls (the fake TTY's lone ESC is a no-op keypress: readline holds
    // it awaiting a sequence continuation, so it cannot close the overlay
    // here). At HEAD the guard checks only overlay+scope, so the stale a.ts
    // diff lands over b.ts.
    const late: { resolve?: (result: HostWorkspaceGitReadResult) => void } = {}
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-git-stale-path-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [...SETUP_HOST_CAPABILITIES, 'workspace-git'],
      workspaceGitRead: (params) => {
        if (params.path === 'a.ts') {
          return new Promise<HostWorkspaceGitReadResult>((resolve) => {
            late.resolve = resolve
          })
        }
        return {
          scope: 'diff',
          branch: 'main',
          head: '0123456789abcdef0123456789abcdef01234567',
          truncated: false,
          text: 'diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n+b-diff-data'
        }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread selected')
    feed(input, '/git diff a.ts\r')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(late.resolve).toBeTruthy()
    await (
      tui as unknown as {
        openGitOverlay: (scope: 'status' | 'diff' | 'log', path?: string) => Promise<void>
      }
    ).openGitOverlay('diff', 'b.ts')
    await waitFor(() => output.lastFrame.includes('b-diff-data'), 'b diff landed')
    late.resolve?.({
      scope: 'diff',
      branch: 'main',
      head: '0123456789abcdef0123456789abcdef01234567',
      truncated: false,
      text: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n+a-diff-data'
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(output.lastFrame).not.toContain('a-diff-data')
    expect(output.lastFrame).toContain('b-diff-data')
  })

  it('lands only the newest of two overlapping refreshes', async () => {
    // `r` then `r` again quickly: two identical dispatches race, and the SLOWER
    // older one must not overwrite the newer — a refresh exists to see new
    // state, and landing the older snapshot defeats it.
    const pending: Array<() => void> = []
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-git-stale-refresh-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [...SETUP_HOST_CAPABILITIES, 'workspace-git'],
      workspaceGitRead: () => {
        // The marker is captured at DISPATCH time — computing it at resolve
        // time would let a late answer impersonate the newer read.
        const marker = `refresh-${pending.length + 1}.ts`
        return new Promise<HostWorkspaceGitReadResult>((resolve) => {
          pending.push(() =>
            resolve({
              scope: 'status',
              branch: 'main',
              head: '0123456789abcdef0123456789abcdef01234567',
              truncated: false,
              files: [
                {
                  path: marker,
                  index: 'M',
                  workingTree: 'M',
                  kind: 'modified',
                  staged: false,
                  unstaged: true
                }
              ]
            })
          )
        })
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread selected')
    feed(input, '/git\r')
    await new Promise((resolve) => setTimeout(resolve, 50))
    feed(input, 'r')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pending).toHaveLength(2)
    // Resolve the NEWER refresh first, then the older one late.
    pending[1]()
    await waitFor(() => output.lastFrame.includes('refresh-2.ts'), 'newer refresh landed')
    pending[0]()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(output.lastFrame).not.toContain('refresh-1.ts')
    expect(output.lastFrame).toContain('refresh-2.ts')
  })

  it('banners a truncated status result too, not only diff/log', async () => {
    // The banner previously lived only in the diff/log branch — a truncated
    // status rendered as if it were the complete working tree.
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-git-truncated-status-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: [...SETUP_HOST_CAPABILITIES, 'workspace-git'],
      workspaceGitRead: () => ({
        scope: 'status',
        branch: 'main',
        head: '0123456789abcdef0123456789abcdef01234567',
        truncated: true,
        files: [
          {
            path: 'src/tui/render.ts',
            index: 'M',
            workingTree: 'M',
            kind: 'modified',
            staged: false,
            unstaged: true
          }
        ]
      })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Solo thread'), 'thread selected')
    feed(input, '/git\r')
    await waitFor(() => output.lastFrame.includes('truncated'), 'status truncation banner')
  })
})

/* -------------------------------------------------------------------------
 * Seat lens (/seats) — ensemble seat control over the Host command wire
 * ---------------------------------------------------------------------- */

describe('seat lens (/seats)', () => {
  const ENSEMBLE_CAPABILITIES: readonly HostCapability[] = [...SETUP_HOST_CAPABILITIES, 'ensemble']

  function seat(
    threadId: string,
    id: string,
    providerId: string,
    role: string,
    order: number,
    enabled: boolean,
    modelId?: string
  ): HostParticipantProjection {
    return {
      id,
      threadId,
      providerId,
      role,
      ...(modelId ? { modelId } : {}),
      order,
      enabled,
      active: false
    }
  }

  function makeEnsembleSnapshot(participants: HostParticipantProjection[]): HostSnapshot {
    return makeHostSnapshot({
      threads: [
        {
          id: 'thread-ens',
          workspaceId: 'ws-1',
          title: 'Ensemble thread',
          chatKind: 'ensemble',
          archived: false,
          pinned: false,
          updatedAt: 20,
          messageCount: 3,
          providerId: 'claude',
          latestPreview: 'Ensemble preview',
          previewTruncated: false
        },
        {
          id: 'thread-solo',
          workspaceId: 'ws-1',
          title: 'Solo thread',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 10,
          messageCount: 1,
          providerId: 'claude',
          latestPreview: 'Hello TaskWraith',
          previewTruncated: false
        }
      ],
      providers: [
        {
          providerId: 'claude',
          displayProvider: 'Claude',
          modelId: 'claude-opus-5',
          modelLabel: 'Opus 5',
          shortCode: 'CLD',
          hueKey: 'claude',
          available: true
        },
        {
          providerId: 'grok',
          displayProvider: 'Grok',
          modelId: 'grok-4.6',
          modelLabel: 'Grok 4.6',
          shortCode: 'GRK',
          hueKey: 'grok',
          available: true
        }
      ],
      participants
    })
  }

  it('opens the seat lens on an ensemble thread and toggles a seat through the Host', async () => {
    const participants = [
      seat('thread-ens', 'p-grok', 'grok', 'Reviewer', 0, false, 'grok-4.6'),
      seat('thread-ens', 'p-claude', 'claude', 'Captain', 1, true, 'claude-opus-5')
    ]
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-toggle-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeEnsembleSnapshot(participants),
      capabilities: ENSEMBLE_CAPABILITIES,
      seatToggle: (input) => {
        const participant = participants.find((candidate) => candidate.id === input.participantId)
        if (!participant || participant.threadId !== input.threadId) {
          return { kind: 'denied', reason: 'standalone_ensemble_participant_not_found' }
        }
        participant.enabled = input.enabled
        return { kind: 'succeeded' }
      }
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread'), 'ensemble thread selected')
    // The TUI must ASK for the ensemble capability: the fake intersects the
    // hello request with its own offer, so the welcome only carries 'ensemble'
    // when the client requested it.
    expect(host.helloCapabilities).toContain('ensemble')

    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('grok-4.6'), 'roster rendered')
    expect(output.lastFrame).toContain('claude-opus-5')
    expect(output.lastFrame).toContain('Reviewer')
    expect(output.lastFrame).toContain('Captain')
    expect(output.lastFrame).toContain('disabled')
    expect(output.lastFrame).toContain('enabled')
    // Round execution stays desktop-only; the lens must say so where a user
    // who can toggle seats would look.
    expect(output.lastFrame).toContain('rounds run in the desktop app')

    // Row 0 is the disabled Grok seat; Enter toggles it. The lens must show
    // the new state only from the authoritative post-mutation snapshot —
    // never an optimistic flip.
    feed(input, '\r')
    await waitFor(() => !output.lastFrame.includes('disabled'), 'seat enabled after refresh')
    const toggle = host.commands.find((command) => command.name === 'ensemble.seat.toggle')
    expect(toggle?.target.threadId).toBe('thread-ens')
    expect(toggle?.arguments).toMatchObject({ participantId: 'p-grok', enabled: true })
    expect(participants.find((candidate) => candidate.id === 'p-grok')?.enabled).toBe(true)
  })

  it('renders a calm unavailable state when the Host does not advertise ensemble', async () => {
    const participants = [seat('thread-ens', 'p-claude', 'claude', 'Captain', 0, true)]
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-unavailable-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeEnsembleSnapshot(participants),
      capabilities: SETUP_HOST_CAPABILITIES
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread'), 'ensemble thread selected')
    // Unavailable is not an error: no failure copy, no toggle dispatched.
    feed(input, '/seats\r')
    await waitFor(
      () => output.lastFrame.includes('seat control is unavailable on this Host'),
      'calm capability-unavailable state'
    )
    expect(output.lastFrame).not.toContain('failed')
    expect(output.lastFrame).not.toContain('solo-only')
    // The TUI asked for the capability; this Host simply does not serve it.
    expect(host.helloCapabilities).toContain('ensemble')
    expect(host.commands.find((command) => command.name === 'ensemble.seat.toggle')).toBeUndefined()
  })

  it('renders a genuine read failure as an error, distinct from unavailable', async () => {
    const participants = [seat('thread-ens', 'p-claude', 'claude', 'Captain', 0, true)]
    let failNext = false
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-error-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => {
        if (failNext) {
          failNext = false
          throw new Error('snapshot store unavailable')
        }
        return makeEnsembleSnapshot(participants)
      },
      capabilities: ENSEMBLE_CAPABILITIES
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread'), 'ensemble thread selected')
    failNext = true
    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('seat read failed'), 'error path rendered')
    expect(output.lastFrame).not.toContain('unavailable on this Host')
  })

  it('surfaces the Host last-seat refusal in plain language and never flips the row', async () => {
    const participants = [
      seat('thread-ens', 'p-claude', 'claude', 'Captain', 0, true, 'claude-opus-5'),
      seat('thread-ens', 'p-grok', 'grok', 'Reviewer', 1, false, 'grok-4.6')
    ]
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-last-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeEnsembleSnapshot(participants),
      capabilities: ENSEMBLE_CAPABILITIES,
      // The Host is the authority: it refuses to disable the last enabled
      // seat. The lens must surface that refusal, not mirror or pre-empt it.
      seatToggle: () => ({ kind: 'denied', reason: 'standalone_ensemble_last_seat_required' })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread'), 'ensemble thread selected')
    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('claude-opus-5'), 'roster rendered')

    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('at least one enabled seat'),
      'plain-language last-seat refusal'
    )
    // No optimistic flip: Claude's seat still renders enabled, Grok's
    // disabled, and the fake's authoritative roster is unchanged.
    expect(output.lastFrame).toContain('disabled')
    const toggle = host.commands.find((command) => command.name === 'ensemble.seat.toggle')
    expect(toggle?.arguments).toMatchObject({ participantId: 'p-claude', enabled: false })
    expect(participants.find((candidate) => candidate.id === 'p-claude')?.enabled).toBe(true)
  })

  it('surfaces the Host active-round refusal in plain language', async () => {
    const participants = [
      seat('thread-ens', 'p-claude', 'claude', 'Captain', 0, true, 'claude-opus-5'),
      seat('thread-ens', 'p-grok', 'grok', 'Reviewer', 1, true, 'grok-4.6')
    ]
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-round-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeEnsembleSnapshot(participants),
      capabilities: ENSEMBLE_CAPABILITIES,
      seatToggle: () => ({ kind: 'denied', reason: 'standalone_ensemble_round_active' })
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread'), 'ensemble thread selected')
    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('grok-4.6'), 'roster rendered')

    // Row 0 is Claude (enabled); disabling during a running round is refused.
    feed(input, '\r')
    await waitFor(
      () => output.lastFrame.includes('while a round is running'),
      'plain-language active-round refusal'
    )
    expect(participants.find((candidate) => candidate.id === 'p-claude')?.enabled).toBe(true)
  })

  it('never renders a roster read dispatched for another thread, even transiently', async () => {
    // A /seats read for thread A stays in flight; the user switches to thread
    // B and reopens the lens. A's late answer must never repoint B's lens at
    // A's roster — that invites toggling the WRONG participant, which the
    // Host would faithfully execute. The projection queue serializes the
    // reads, so the corruption without the guard is a TRANSIENT frame: scan
    // every frame, not just the last.
    const participants = [
      seat('thread-ensa', 'p-a', 'claude', 'Captain', 0, true, 'model-a-marker'),
      seat('thread-ensb', 'p-b', 'grok', 'Reviewer', 0, true, 'model-b-marker')
    ]
    const twoEnsembleSnapshot = (): HostSnapshot =>
      makeHostSnapshot({
        threads: [
          {
            id: 'thread-ensa',
            workspaceId: 'ws-1',
            title: 'Ensemble thread A',
            chatKind: 'ensemble',
            archived: false,
            pinned: false,
            updatedAt: 20,
            messageCount: 1,
            providerId: 'claude',
            latestPreview: 'Thread A preview',
            previewTruncated: false
          },
          {
            id: 'thread-ensb',
            workspaceId: 'ws-1',
            title: 'Ensemble thread B',
            chatKind: 'ensemble',
            archived: false,
            pinned: false,
            updatedAt: 10,
            messageCount: 1,
            providerId: 'grok',
            latestPreview: 'Thread B preview',
            previewTruncated: false
          }
        ],
        providers: [
          {
            providerId: 'claude',
            displayProvider: 'Claude',
            modelId: 'model-a-marker',
            modelLabel: 'Model A',
            shortCode: 'CLD',
            hueKey: 'claude',
            available: true
          },
          {
            providerId: 'grok',
            displayProvider: 'Grok',
            modelId: 'model-b-marker',
            modelLabel: 'Model B',
            shortCode: 'GRK',
            hueKey: 'grok',
            available: true
          }
        ],
        participants
      })
    let deferNext = false
    const deferred: Array<(snapshot: HostSnapshot) => void> = []
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-stale-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => {
        if (deferNext) {
          deferNext = false
          return new Promise<HostSnapshot>((resolve) => deferred.push(resolve))
        }
        return twoEnsembleSnapshot()
      },
      capabilities: ENSEMBLE_CAPABILITIES
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath, { projectionRefreshMs: 60_000 })
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread A'), 'thread A selected')

    deferNext = true
    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('reading seats'), 'lens loading on A')
    // The loading frame renders synchronously, before the read reaches the
    // fake — wait until the fake actually holds the deferred answer.
    await waitFor(() => deferred.length > 0, 'A roster read deferred')
    // Switch to B through the TUI's real local thread application (it closes
    // the overlay), then reopen the lens there. The fake TTY's lone ESC is a
    // no-op keypress in this harness, so the switch goes through the method.
    ;(tui as unknown as { applyLocalThread: (threadId: string) => void }).applyLocalThread(
      'thread-ensb'
    )
    feed(input, '/seats\r')
    // B's read is queued behind A's deferred one on the serial projection
    // queue, so resolve A's late answer now: its post-await write must be
    // dropped by the guard, then B's read lands.
    deferred.shift()?.(twoEnsembleSnapshot())
    await waitFor(() => output.lastFrame.includes('model-b-marker'), 'B roster landed')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(output.lastFrame).toContain('model-b-marker')
    expect(output.frames.some((frame) => stripAnsi(frame).includes('model-a-marker'))).toBe(false)
  })

  it('renders a calm solo-thread state when the selected thread is not an ensemble', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-solo-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeHostSnapshot(),
      capabilities: ENSEMBLE_CAPABILITIES
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'solo thread selected')
    feed(input, '/seats\r')
    await waitFor(
      () => output.lastFrame.includes('seats exist on ensemble threads'),
      'calm solo-thread state'
    )
    expect(output.lastFrame).not.toContain('failed')
    expect(host.commands.find((command) => command.name === 'ensemble.seat.toggle')).toBeUndefined()
  })

  it('shows a notice in demo mode and never fabricates a roster', async () => {
    const { input, output, tui } = startTui(join(tmpdir(), 'taskwraith-tui-seats-demo-'), {
      demo: true
    })
    await tui.start()
    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('demo session has none'), 'demo notice rendered')
    expect(output.lastFrame).not.toContain('Unknown command')
  })

  it('moves the seat selection with up/down, clamped to the roster', async () => {
    const participants = [
      seat('thread-ens', 'p-grok', 'grok', 'Reviewer', 0, false, 'grok-4.6'),
      seat('thread-ens', 'p-claude', 'claude', 'Captain', 1, true, 'claude-opus-5')
    ]
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-seats-nav-'))
    const host = new FakeHostV2(userDataPath, {
      snapshot: () => makeEnsembleSnapshot(participants),
      capabilities: ENSEMBLE_CAPABILITIES
    })
    await host.start()
    cleanup.push(() => host.stop())
    const { tui, input, output } = startTui(userDataPath)
    await tui.start()
    await waitFor(() => output.lastFrame.includes('Ensemble thread'), 'ensemble thread selected')
    feed(input, '/seats\r')
    await waitFor(() => output.lastFrame.includes('grok-4.6'), 'roster rendered')
    // The fake TTY's arrow sequences are unreliable in this harness, so drive
    // the overlay's real key handler directly.
    const seatsTui = tui as unknown as {
      handleSeatsKey: (key: { name?: string }) => void
      state: { overlayIndex: number }
    }
    expect(seatsTui.state.overlayIndex).toBe(0)
    seatsTui.handleSeatsKey({ name: 'down' })
    expect(seatsTui.state.overlayIndex).toBe(1)
    seatsTui.handleSeatsKey({ name: 'down' })
    expect(seatsTui.state.overlayIndex).toBe(1)
    seatsTui.handleSeatsKey({ name: 'up' })
    expect(seatsTui.state.overlayIndex).toBe(0)
  })
})

describe('animation frame gating', () => {
  it('requests fresh queue authority only for terminal-relevant run deltas', () => {
    const frame = (payload: Record<string, unknown>): HostDeltasFrame => ({
      type: 'host.deltas',
      protocolVersion: HOST_PROTOCOL_VERSION,
      result: {
        kind: 'deltas',
        generation: 3,
        fromCursor: 1,
        toCursor: 2,
        deltas: [
          {
            protocolVersion: HOST_PROTOCOL_VERSION,
            projectionVersion: HOST_PROJECTION_VERSION,
            generation: 3,
            previousCursor: 1,
            cursor: 2,
            kind: 'upsert',
            family: 'run',
            entityId: 'run-1',
            payload,
            at: new Date(0).toISOString()
          }
        ]
      }
    })
    expect(hostDeltasMayReleaseQueuedDraft(frame({ providerOutcome: 'running' }))).toBe(false)
    expect(
      hostDeltasMayReleaseQueuedDraft(frame({ providerOutcome: 'completed', endedAt: 4 }))
    ).toBe(true)
    expect(terminalRunIdsFromHostDeltas(frame({ providerOutcome: 'completed' }))).toEqual(
      new Set(['run-1'])
    )
    const removed = frame({ providerOutcome: 'running' })
    if (removed.result.kind === 'deltas') {
      removed.result.deltas[0] = {
        ...removed.result.deltas[0],
        kind: 'remove',
        payload: undefined
      }
    }
    expect(terminalRunIdsFromHostDeltas(removed)).toEqual(new Set(['run-1']))
  })

  const gate = (over: Partial<Parameters<typeof shouldAdvanceAnimationFrame>[0]>) =>
    shouldAdvanceAnimationFrame({
      working: false,
      homeFrame: false,
      tick: 1,
      stride: 2,
      ...over
    })

  it('advances every tick while a thread is working', () => {
    // The working shimmer is the faster of the two animations and must not be
    // subject to the banner's stride.
    for (const tick of [1, 2, 3, 4, 5]) {
      expect(gate({ working: true, tick })).toBe(true)
    }
  })

  it('advances the home frame only once per stride', () => {
    const advanced = [1, 2, 3, 4, 5, 6].filter((tick) => gate({ homeFrame: true, tick }))
    expect(advanced).toEqual([2, 4, 6])
  })

  it('stays still on a settled thread and behind any overlay', () => {
    // Not "no thread": the canvas only falls through to the banner while no
    // overlay is up, so a raised overlay must stop the sweep even at home.
    expect(gate({ working: false, homeFrame: false, tick: 2 })).toBe(false)
    expect(gate({ working: false, homeFrame: false, tick: 4 })).toBe(false)
  })

  it('never divides by a zero or negative stride', () => {
    expect(gate({ homeFrame: true, tick: 1, stride: 0 })).toBe(true)
    expect(gate({ homeFrame: true, tick: 1, stride: -3 })).toBe(true)
  })
})
