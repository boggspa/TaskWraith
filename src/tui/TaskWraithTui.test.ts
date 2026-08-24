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
  type HostDeltasSinceResult,
  type HostResultRef,
  type HostSnapshot
} from '../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportHostFrame
} from '../shared/hostProtocolTransport'
import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import type { TaskWraithControlThreadOffers } from '../shared/taskWraithControlProtocol'
import { taskWraithHostSocketPath } from '../shared/taskWraithHostPaths.node'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import { stripAnsi } from './ansi'
import { TaskWraithTui } from './TaskWraithTui'

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
  snapshot: () => HostSnapshot
  offers?: (threadId: string) => TaskWraithControlThreadOffers
  capabilities?: readonly HostCapability[]
  providerStatuses?: () => readonly HostProviderStatusProjection[]
  providerOffers?: (providerId: string) => HostProviderOffersProjection
  providerAuthFlows?: (providerId: string) => readonly HostProviderAuthFlowProjection[]
  providerAuthStatus?: (providerId: string) => HostProviderAuthStatusProjection
  threadHistory?: (request: HostThreadHistoryRequest) => HostThreadHistoryPage
  historySince?: (request: HostHistorySinceRequest) => HostHistorySinceResult
  resultRef?: (command: HostCommand) => HostResultRef | undefined
  /** allow = immediate succeeded; defer = pending ask until approval.decide */
  mutationMode?: MutationMode
}

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
        startedAt: new Date(0).toISOString()
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
      const base = this.handlers.snapshot()
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
      return
    }
    if (kind === 'command.submit') {
      const command = message.params as HostCommand
      const receipt = this.handleCommand(command)
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
        result: { kind: 'provider.auth.status', status: this.handlers.providerAuthStatus(providerId) }
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
    if (command.name === 'approval.decide') {
      return this.handleApprovalDecide(command)
    }
    if (command.name === 'question.answer' && command.target.questionId) {
      this.answeredProjectionQuestions.add(command.target.questionId)
    }
    const mode = this.handlers.mutationMode ?? 'allow'
    if (mode === 'allow' || command.name === 'ping') {
      const resultRef = this.handlers.resultRef?.(command)
      const receipt = this.makeReceipt(command, {
        status: 'succeeded',
        authority: { decision: 'allow' },
        ...(resultRef ? { resultRef } : {})
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
      Partial<Pick<HostCommandReceipt, 'errorCode' | 'errorMessage' | 'resultRef'>>
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
      ...(overrides.resultRef ? { resultRef: overrides.resultRef } : {})
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
  options: { projectionRefreshMs?: number } & Partial<ConstructorParameters<typeof TaskWraithTui>[0]> = {}
) {
  const { input, output } = makeTty()
  const tui = new TaskWraithTui({
    clientVersion: '0.1.0-test',
    userDataPath,
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
    expect(output.lastFrame).toContain('continuous · fan-out read_only')
    expect(output.lastFrame).toContain('CLD · Lead · running')
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

    feed(input, '/cancel\r')
    await waitFor(
      () => output.lastFrame.includes('Host accepted run.cancel'),
      'run.cancel succeeded',
      5_000
    )

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
    await waitFor(
      () => output.lastFrame.includes('Solo thread (revived)'),
      'reconnected to the revived Host',
      5_000
    )
  }, 12_000)

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
    await waitFor(() => output.lastFrame.includes('Current bounded history entry'), 'initial history page')
    feed(input, '\u001b[5~')
    await waitFor(() => historyRequests >= 2, 'older history page request')
    await waitFor(() => output.lastFrame.includes('Older bounded history entry'), 'older history render')
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
    await waitFor(() => output.lastFrame.includes('absolute workspace path'), 'workspace setup prompt')
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
    await waitFor(() => output.lastFrame.includes('Workspace write · acknowledged'), 'posture acknowledgement')
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
    await waitFor(() => output.lastFrame.includes('absolute workspace path'), 'workspace setup prompt')
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
    await waitFor(() => output.lastFrame.includes('Authentication is still pending'), 'pending auth status')

    feed(input, '\r')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(host.commands.filter((command) => command.name === 'provider.auth.begin')).toHaveLength(1)

    host.dropAllClients()
    await waitFor(() => host.welcomeCount >= 2, 'Host reconnect')
    feed(input, '\r')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(host.commands.filter((command) => command.name === 'provider.auth.begin')).toHaveLength(1)

    authenticated = true
    feed(input, '\r')
    await waitFor(() => output.lastFrame.includes('create a thread'), 'authenticated provider offers')
    expect(host.commands.filter((command) => command.name === 'provider.auth.begin')).toHaveLength(1)
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
        if (revives > 1) return
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
      }
    })

    await tui.start()
    await waitFor(() => output.lastFrame.includes('Hello TaskWraith'), 'initially connected')

    // Kill the live Host mid-session so the TUI enters the reconnecting state.
    host.dropAllClients()
    await host.stop()

    await waitFor(
      () => output.lastFrame.includes('Solo thread (relaunched)'),
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
      }
    })
    await tui.start()
    // No Host exists here, so the TUI stays "offline · retrying": the revive
    // path requires everConnected and must never fire for a never-seen Host.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(revives).toBe(0)
    tui.stop()
  })
})
