import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import { HostProfileDomainStore } from '../host-runtime/HostProfileDomainStore'
import type { MuseRunOutcome, MuseRunSpawnHandle } from '../main/muse/MuseRun'
import {
  museMeterSnapshotToProviderStats,
  unavailableMuseMeterSnapshot
} from '../main/muse/MuseUsage'
import { HostNodeDomainPorts } from './HostNodeDomainPorts'

const paths: string[] = []
const actor = { actorId: 'actor-1', clientId: 'tui-1', clientClass: 'tui' as const }
const context = {
  actor,
  client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
}
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

function command(
  name: HostCommand['name'],
  commandId: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey: `key-${commandId}`,
    actor,
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-08-24T05:00:00.000Z'
  }
}

function spawnHandle(onKill?: () => void): MuseRunSpawnHandle {
  return {
    pid: 7,
    kill() {
      onKill?.()
    },
    onStdout(listener) {
      void listener
    },
    onStderr(listener) {
      void listener
    },
    async wait() {
      return { code: 0, signal: null }
    }
  }
}

function outcome(status: MuseRunOutcome['status']): MuseRunOutcome {
  const meter = unavailableMuseMeterSnapshot(SESSION_ID)
  return {
    status,
    sessionId: SESSION_ID,
    exitCode: status === 'success' ? 0 : null,
    assistantText: status === 'success' ? 'Muse terminal answer' : '',
    events: [],
    meter,
    providerStats: museMeterSnapshotToProviderStats(meter),
    warnings: [],
    argv: ['exec', '--json'],
    effort: 'high',
    writeCapable: true,
    skillPinHash: 'a'.repeat(64),
    leasePath: '/tmp/muse-lease'
  }
}

function open(options: { credential?: boolean; manual?: boolean; killReleases?: boolean } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'host-node-domain-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-node-domain-workspace-'))
  paths.push(profile, workspace)
  let id = 0
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: {
      assertProfileAuthority() {
        return undefined
      }
    },
    now: () => Date.UTC(2026, 7, 24, 5, 0, 0),
    idFactory: () => `id-${++id}`
  })
  let releaseRun: (() => void) | undefined
  const waitForRun = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  const events: unknown[] = []
  const manualBegin = vi.fn()
  const domainOptions = {
    store,
    events: { publish: (_target, event) => events.push(event) },
    museResources: {
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/muse' }),
      getTemporaryRoot: () => '/tmp',
      readAuthJsonText: async () => null,
      readMetaApiKeyEnv: () => (options.credential === false ? null : 'env-muse-secret'),
      spawn: () => spawnHandle(options.killReleases === false ? undefined : releaseRun)
    },
    museProviderOptions: {
      now: () => Date.UTC(2026, 7, 24, 5, 0, 0),
      createSessionId: () => SESSION_ID,
      runMuseProvider: async (input) => {
        input.spawn({ binaryPath: '/usr/local/bin/muse', argv: [], cwd: workspace, env: {} })
        await waitForRun
        return outcome(input.shouldCancel?.() ? 'cancelled' : 'success')
      }
    },
    museOffers: {
      providerId: 'muse',
      offerRevision: 'muse-offer-1',
      models: [
        {
          modelId: 'muse-spark-1.2',
          label: 'Muse Spark',
          available: true,
          reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
        }
      ],
      postures: [
        {
          postureId: 'workspace_write',
          label: 'Workspace write',
          available: true,
          requiresExplicitConsent: true,
          ceiling: 'workspace_write'
        }
      ]
    },
    health: () => ({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    }),
    providerInventory: () => [
      { providerId: 'muse', displayProvider: 'Muse', shortCode: 'MUSE', available: true }
    ],
    ...(options.manual
      ? {
          manualAuthHandoff: {
            begin: manualBegin,
            cancel: async () => true
          }
        }
      : {})
  } satisfies ConstructorParameters<typeof HostNodeDomainPorts>[0]
  const domain = new HostNodeDomainPorts(domainOptions)
  return {
    domain,
    domainOptions,
    store,
    workspace,
    events,
    manualBegin,
    releaseRun: () => releaseRun?.()
  }
}

afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

describe('HostNodeDomainPorts', () => {
  it('runs setup to a configured Muse thread, acknowledges composer after durable start, then records cancellation/history', async () => {
    const { domain, store, workspace, events } = open()
    const workspaceResult = await domain.executeCommand(
      context,
      command('workspace.register', 'cmd-workspace', {}, { path: workspace }),
      { id: 'tui-target' }
    )
    const workspaceId = (workspaceResult.resultRef as { workspaceId: string }).workspaceId
    const threadResult = await domain.executeCommand(
      context,
      command('thread.create', 'cmd-thread', {}, { scope: 'workspace', workspaceId }),
      { id: 'tui-target' }
    )
    const threadId = (threadResult.resultRef as { threadId: string }).threadId
    await expect(
      domain.executeCommand(
        context,
        command(
          'thread.configure',
          'cmd-configure',
          { threadId },
          {
            providerId: 'muse',
            modelId: 'muse-spark-1.2',
            reasoningId: 'high',
            postureId: 'workspace_write',
            offerRevision: 'muse-offer-1',
            postureConsent: true
          }
        ),
        { id: 'tui-target' }
      )
    ).resolves.toMatchObject({ status: 'succeeded' })

    await expect(
      domain.executeCommand(
        context,
        command('composer.send', 'run-1', { threadId }, { text: 'Run the Muse task' }),
        { id: 'disconnected-client' }
      )
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'muse_run_started' })
    expect(store.getThread(threadId)?.runs).toEqual([
      expect.objectContaining({ runId: 'run-1', status: 'running' })
    ])
    expect(store.getThread(threadId)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-1', role: 'user', content: 'Run the Muse task' })
      ])
    )
    await expect(
      domain.executeCommand(context, command('run.cancel', 'cmd-cancel', { threadId }, {}), {
        id: 'disconnected-client'
      })
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'muse_run_cancellation_requested' })
    await vi.waitFor(() =>
      expect(store.getThread(threadId)?.runs).toEqual([
        expect.objectContaining({ runId: 'run-1', status: 'cancelled' })
      ])
    )

    await expect(
      domain.executeCommand(
        context,
        command(
          'composer.send',
          'run-2',
          { threadId },
          { text: 'Complete a background Muse turn' }
        ),
        { id: 'disconnected-client' }
      )
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'muse_run_started' })
    await vi.waitFor(() =>
      expect(store.getThread(threadId)?.runs).toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: 'run-2', status: 'completed' })])
      )
    )

    expect(domain.snapshotDonor()).toMatchObject({
      workspaces: [{ id: workspaceId }],
      threads: [{ id: threadId, providerId: 'muse' }],
      runs: [
        { runId: 'run-1', providerOutcome: 'cancelled' },
        { runId: 'run-2', providerOutcome: 'completed' }
      ]
    })
    expect(
      domain.threadHistory({ threadId, limit: 20 }).entries.map((entry) => entry.role)
    ).toEqual(expect.arrayContaining(['user', 'assistant']))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run.status', status: 'cancelled' })
    )
  })

  it('denies iOS and unsupported mutations, and fails stale/absent-consent Muse configuration', async () => {
    const { domain, workspace } = open()
    const register = await domain.executeCommand(
      context,
      command('workspace.register', 'cmd-workspace-2', {}, { path: workspace }),
      { id: 'target' }
    )
    const workspaceId = (register.resultRef as { workspaceId: string }).workspaceId
    const created = await domain.executeCommand(
      context,
      command('thread.create', 'cmd-thread-2', {}, { scope: 'workspace', workspaceId }),
      { id: 'target' }
    )
    const threadId = (created.resultRef as { threadId: string }).threadId
    const noConsent = command(
      'thread.configure',
      'cmd-no-consent',
      { threadId },
      {
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        postureId: 'workspace_write',
        offerRevision: 'muse-offer-1'
      }
    )
    await expect(domain.executeCommand(context, noConsent, { id: 'target' })).resolves.toEqual({
      status: 'failed',
      errorCode: 'setup_consent_required'
    })
    await expect(
      domain.executeCommand(
        context,
        command(
          'thread.configure',
          'cmd-stale',
          { threadId },
          { ...noConsent.arguments, offerRevision: 'stale' }
        ),
        { id: 'target' }
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_stale_offer' })
    const ios = {
      actor: { actorId: 'ios', clientId: 'ios', clientClass: 'ios' as const },
      client: { clientId: 'ios', clientClass: 'ios' as const, clientVersion: '1.0.0' }
    }
    expect(domain.evaluateAuthority(ios, noConsent)).toMatchObject({ decision: 'deny' })
    expect(
      domain.evaluateAuthority(
        context,
        command('question.answer', 'cmd-question', { questionId: 'q' }, { decision: 'dismiss' })
      )
    ).toEqual({ decision: 'deny', reason: 'standalone_command_unsupported' })
    await expect(
      domain.executeCommand(
        context,
        command('thread.create', 'cmd-global', {}, { scope: 'global' }),
        { id: 'target' }
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'setup_execution_failed' })
  })

  it('waits for tracked provider completion during shutdown before reporting stopped', async () => {
    const { domain, store, workspace, releaseRun } = open({ killReleases: false })
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'workspace_write',
      postureConsent: true
    })
    await expect(
      domain.executeCommand(
        context,
        command(
          'composer.send',
          'run-shutdown-wait',
          { threadId: thread.appChatId },
          { text: 'wait' }
        ),
        { id: 'target' }
      )
    ).resolves.toMatchObject({ status: 'succeeded' })

    let settled = false
    const stopping = domain.shutdown().then((result) => {
      settled = true
      return result
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseRun()
    await expect(stopping).resolves.toEqual({
      stopped: true,
      alreadyStopped: false,
      cancelledRuns: 1
    })
    await expect(domain.shutdown()).resolves.toEqual({
      stopped: true,
      alreadyStopped: true,
      cancelledRuns: 0
    })
  })

  it('terminalizes a run when a provider promise rejects after composer acceptance', async () => {
    const { domainOptions, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'workspace_write',
      postureConsent: true
    })
    let rejectRun: ((error: Error) => void) | undefined
    const rejected = new Promise<void>((_, reject) => {
      rejectRun = reject
    })
    const holder: { domain?: HostNodeDomainPorts } = {}
    const rejectingProvider = {
      getStatus: async () => ({
        providerId: 'muse' as const,
        available: true,
        setupRequired: false,
        authState: 'authenticated' as const,
        binaryAvailable: true,
        credentialPresent: true,
        configured: true,
        checkedAt: '2026-08-24T05:00:00.000Z'
      }),
      run: async (input: { runId: string; threadId: string; prompt: string }) => {
        holder.domain!.runPort.beginRun({
          runId: input.runId,
          threadId: input.threadId,
          providerId: 'muse',
          modelId: 'muse-spark-1.2',
          startedAt: '2026-08-24T05:00:00.000Z'
        })
        holder.domain!.runPort.appendTranscript({
          threadId: input.threadId,
          runId: input.runId,
          role: 'user',
          text: input.prompt,
          createdAt: '2026-08-24T05:00:00.000Z'
        })
        await rejected
        throw new Error('late provider failure')
      }
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      museProvider: rejectingProvider as unknown as HostNodeDomainPorts['museProvider']
    })
    holder.domain = domain

    await expect(
      domain.executeCommand(
        context,
        command(
          'composer.send',
          'run-rejected',
          { threadId: thread.appChatId },
          { text: 'reject later' }
        ),
        { id: 'target' }
      )
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'muse_run_started' })
    rejectRun?.(new Error('late provider failure'))
    await vi.waitFor(() =>
      expect(store.getThread(thread.appChatId)?.runs).toEqual([
        expect.objectContaining({
          runId: 'run-rejected',
          status: 'failed',
          errorCode: 'provider_failed'
        })
      ])
    )
  })

  it('cancels an unprovable start once and keeps shutdown waiting for its tracked completion', async () => {
    const { domainOptions, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'workspace_write',
      postureConsent: true
    })
    let releaseRun: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    let cancellationCalls = 0
    const holder: { domain?: HostNodeDomainPorts } = {}
    const unprovableProvider = {
      getStatus: async () => ({
        providerId: 'muse' as const,
        available: true,
        setupRequired: false,
        authState: 'authenticated' as const,
        binaryAvailable: true,
        credentialPresent: true,
        configured: true,
        checkedAt: '2026-08-24T05:00:00.000Z'
      }),
      cancel: () => {
        cancellationCalls += 1
        return true
      },
      run: async (input: { runId: string; threadId: string }) => {
        holder.domain!.runPort.beginRun({
          runId: input.runId,
          threadId: input.threadId,
          providerId: 'muse',
          modelId: 'muse-spark-1.2',
          startedAt: '2026-08-24T05:00:00.000Z'
        })
        await pending
        return outcome('cancelled')
      }
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      museProvider: unprovableProvider as unknown as HostNodeDomainPorts['museProvider']
    })
    holder.domain = domain

    await expect(
      domain.executeCommand(
        context,
        command(
          'composer.send',
          'run-unprovable',
          { threadId: thread.appChatId },
          { text: 'same text' }
        ),
        { id: 'target' }
      )
    ).resolves.toEqual({ status: 'failed', errorCode: 'muse_run_not_started' })
    expect(cancellationCalls).toBe(1)
    let stopped = false
    const shutdown = domain.shutdown().then((result) => {
      stopped = true
      return result
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseRun?.()
    await expect(shutdown).resolves.toEqual({
      stopped: true,
      alreadyStopped: false,
      cancelledRuns: 0
    })
    expect(cancellationCalls).toBe(1)
  })

  it('recovers only persisted running Muse rows on a fresh domain-port lease', () => {
    const { domainOptions, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const museThread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const foreignThread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: museThread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'workspace_write',
      postureConsent: true
    })
    store.configureThread({
      threadId: foreignThread.appChatId,
      providerId: 'codex',
      modelId: 'gpt-5.6'
    })
    store.updateRun({
      threadId: museThread.appChatId,
      runId: 'run-crashed-muse',
      status: 'running',
      provider: 'muse',
      requestedModel: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    store.updateRun({
      threadId: foreignThread.appChatId,
      runId: 'run-foreign',
      status: 'running',
      provider: 'codex',
      requestedModel: 'gpt-5.6',
      startedAt: '2026-08-24T05:00:00.000Z'
    })

    new HostNodeDomainPorts(domainOptions)

    expect(store.getThread(museThread.appChatId)?.runs).toEqual([
      expect.objectContaining({
        runId: 'run-crashed-muse',
        status: 'failed',
        errorCode: 'provider_failed',
        warningSummaries: ['Muse running state recovered after Host restart.']
      })
    ])
    expect(store.getThread(foreignThread.appChatId)?.runs).toEqual([
      expect.objectContaining({ runId: 'run-foreign', status: 'running', provider: 'codex' })
    ])
  })

  it('reports provider auth honestly without inventing an authenticated state', async () => {
    const { domain, manualBegin } = open({ credential: false, manual: true })
    await expect(domain.providerAuthStatus('muse')).resolves.toEqual({
      providerId: 'muse',
      state: 'unauthenticated'
    })
    await expect(domain.providerAuthFlows('muse')).resolves.toEqual([
      expect.objectContaining({ flowId: 'muse.manual-login', kind: 'manual', available: true })
    ])
    await expect(
      domain.setupExecutor.execute(
        command(
          'provider.auth.begin',
          'cmd-auth',
          { providerId: 'muse' },
          { flowId: 'muse.manual-login' }
        ),
        context
      )
    ).resolves.toEqual({
      status: 'succeeded',
      resultRef: { kind: 'provider-auth', providerId: 'muse', operationId: 'cmd-auth' }
    })
    expect(manualBegin).toHaveBeenCalledWith({ providerId: 'muse', operationId: 'cmd-auth' })
    await expect(domain.providerAuthStatus('muse')).resolves.toMatchObject({
      state: 'unauthenticated'
    })
  })

  it('cancels registered active runs once during idempotent shutdown and leaves terminal runs alone', async () => {
    const { domain, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const first = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const second = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    for (const thread of [first, second]) {
      store.configureThread({
        threadId: thread.appChatId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        postureId: 'workspace_write',
        postureConsent: true
      })
    }
    const startedAt = '2026-08-24T05:00:00.000Z'
    for (const [runId, threadId] of [
      ['run-shutdown-1', first.appChatId],
      ['run-shutdown-2', second.appChatId]
    ] as const) {
      domain.runPort.beginRun({
        runId,
        threadId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        startedAt
      })
    }
    let firstCancelled = 0
    let secondCancelled = 0
    domain.runPort.registerCancel('run-shutdown-1', () => {
      firstCancelled += 1
    })
    domain.runPort.registerCancel('run-shutdown-2', () => {
      secondCancelled += 1
    })
    domain.runPort.finishRun({
      runId: 'run-shutdown-2',
      status: 'completed',
      finishedAt: startedAt,
      warningSummaries: []
    })

    await expect(domain.shutdown()).resolves.toEqual({
      stopped: true,
      alreadyStopped: false,
      cancelledRuns: 1
    })
    await expect(domain.shutdown()).resolves.toEqual({
      stopped: true,
      alreadyStopped: true,
      cancelledRuns: 0
    })
    expect(firstCancelled).toBe(1)
    expect(secondCancelled).toBe(0)
  })
})
