import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostCommand
} from '../shared/hostProtocol'
import { HostProfileDomainStore } from '../host-runtime/HostProfileDomainStore'
import {
  hostThreadRecordTransferPath,
  publishHostThreadRecordTransfer
} from '../host-runtime/HostThreadRecordTransfer'
import type { MuseRunOutcome, MuseRunSpawnHandle } from '../main/muse/MuseRun'
import {
  museMeterSnapshotToProviderStats,
  unavailableMuseMeterSnapshot
} from '../main/muse/MuseUsage'
import { createHostNodeMuseProviderFactory } from './HostNodeMuseProvider'
import type { HostNodeProvider, HostNodeProviderInstance } from './HostNodeProvider'
import { HostNodeDomainPorts } from './HostNodeDomainPorts'

const paths: string[] = []
const actor = { actorId: 'actor-1', clientId: 'tui-1', clientClass: 'tui' as const }
const context = {
  actor,
  client: { clientId: 'tui-1', clientClass: 'tui' as const, clientVersion: '1.0.0' }
}
const desktopContext = {
  actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
  client: { ...TASKWRAITH_DESKTOP_HOST_ACTOR, clientVersion: '1.0.0' }
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

function desktopCommand(
  name: HostCommand['name'],
  commandId: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    ...command(name, commandId, target, arguments_),
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR }
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

const museOffers = {
  providerId: 'muse' as const,
  offerRevision: 'muse-offer-1',
  models: [
    {
      modelId: 'muse-spark-1.2',
      label: 'Muse Spark',
      available: true,
      default: true,
      reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
    }
  ],
  postures: [
    {
      postureId: 'workspace_write',
      label: 'Workspace write',
      available: true,
      requiresExplicitConsent: true,
      ceiling: 'workspace_write' as const
    }
  ]
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
  const museFactory = createHostNodeMuseProviderFactory({
    offers: museOffers,
    resources: {
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/muse' }),
      getTemporaryRoot: () => '/tmp',
      readAuthJsonText: async () => null,
      readMetaApiKeyEnv: () => (options.credential === false ? null : 'env-muse-secret'),
      spawn: () => spawnHandle(options.killReleases === false ? undefined : releaseRun)
    },
    manualAuthHandoff: options.manual
      ? {
          begin: manualBegin,
          cancel: async () => true
        }
      : undefined,
    now: () => Date.UTC(2026, 7, 24, 5, 0, 0),
    createSessionId: () => SESSION_ID,
    runMuseProvider: async (input) => {
      input.spawn({ binaryPath: '/usr/local/bin/muse', argv: [], cwd: workspace, env: {} })
      await waitForRun
      return outcome(input.shouldCancel?.() ? 'cancelled' : 'success')
    }
  })
  const domainOptions = {
    profilePath: profile,
    store,
    events: { publish: (_target, event) => events.push(event) },
    providers: [museFactory],
    health: () => ({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    })
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
  it('refuses unregistered or unclaimed Git workspace scope before the service can spawn', async () => {
    const { domainOptions, store, workspace } = open()
    const read = vi.fn().mockResolvedValue({
      scope: 'status',
      repositoryRoot: workspace,
      branch: 'main',
      head: 'a'.repeat(40),
      files: []
    })
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      gitReadService: { read }
    } as never)
    type TestContext = typeof context
    type TestRequest = { workspaceId?: string; threadId?: string; scope: 'status' }
    const gitRead = (context_: TestContext, request: TestRequest) =>
      (
        domain as unknown as {
          gitRead(context_: TestContext, request_: TestRequest): Promise<unknown>
        }
      ).gitRead(context_, request)

    await expect(
      Promise.resolve().then(() =>
        gitRead(context, { workspaceId: 'missing-workspace', scope: 'status' })
      )
    ).rejects.toThrow(/workspace.*unavailable/i)

    const globalThread = store.createThread({ scope: 'global' })
    await expect(
      Promise.resolve().then(() =>
        gitRead(context, { threadId: globalThread.appChatId, scope: 'status' })
      )
    ).rejects.toThrow(/workspace.*unavailable/i)

    const registered = store.registerWorkspace({ path: workspace })
    const iosContext = {
      actor: { actorId: 'ios-1', clientId: 'ios-1', clientClass: 'ios' as const },
      client: { clientId: 'ios-1', clientClass: 'ios' as const, clientVersion: '1.0.0' }
    }
    await expect(
      Promise.resolve().then(() =>
        gitRead(iosContext as unknown as typeof context, {
          workspaceId: registered.id,
          scope: 'status'
        })
      )
    ).rejects.toThrow(/workspace.*unavailable/i)
    expect(read).not.toHaveBeenCalled()
  })

  it('projects registered workspace and thread Git reads into the bounded wire result', async () => {
    const { domainOptions, store, workspace } = open()
    const read = vi.fn(async (input: { scope: 'status' | 'diff' | 'log' }) =>
      input.scope === 'status'
        ? {
            scope: 'status' as const,
            repositoryRoot: workspace,
            branch: 'main',
            head: 'a'.repeat(40),
            files: [
              {
                path: 'new.ts',
                originalPath: 'source.ts',
                index: 'A',
                workingTree: ' ',
                kind: 'copied' as const,
                staged: true,
                unstaged: false
              }
            ]
          }
        : {
            scope: 'diff' as const,
            repositoryRoot: workspace,
            branch: 'main',
            head: 'a'.repeat(40),
            text: {
              text: '\\'.repeat(128 * 1024),
              truncated: false,
              byteLength: 128 * 1024
            }
          }
    )
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      gitReadService: { read }
    } as never)
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })

    await expect(
      domain.gitRead(context, { workspaceId: registered.id, scope: 'status' })
    ).resolves.toMatchObject({
      scope: 'status',
      files: [{ path: 'new.ts', originalPath: 'source.ts', kind: 'created' }],
      truncated: false
    })
    const diff = await domain.gitRead(context, {
      threadId: thread.appChatId,
      scope: 'diff'
    })
    expect(diff).toMatchObject({ scope: 'diff', truncated: true })
    expect(diff.scope === 'diff' && diff.text.length).toBeLessThan(128 * 1024)
    expect(read).toHaveBeenNthCalledWith(1, {
      workspaceRealPath: registered.realPath,
      scope: 'status'
    })
    expect(read).toHaveBeenNthCalledWith(2, {
      workspaceRealPath: registered.realPath,
      scope: 'diff'
    })
  })

  it('allows a local actor to toggle only a seat on the targeted ensemble thread', async () => {
    const { domain, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const first = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const second = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    for (const thread of [first, second]) {
      store.configureThread({ threadId: thread.appChatId, providerId: 'muse' })
      store.setThreadKind({ threadId: thread.appChatId, targetKind: 'ensemble' })
    }
    const firstRecord = store.getThread(first.appChatId)!
    const secondRecord = store.getThread(second.appChatId)!
    const firstParticipants = (firstRecord.ensemble as { participants: Array<{ id: string }> })
      .participants
    const secondParticipants = (secondRecord.ensemble as { participants: Array<{ id: string }> })
      .participants
    const toggle = command(
      'ensemble.seat.toggle',
      'cmd-seat-toggle',
      { threadId: first.appChatId },
      { participantId: firstParticipants[0]!.id, enabled: false }
    )

    expect(domain.evaluateAuthority(context, toggle)).toEqual({ decision: 'allow' })
    await expect(domain.executeCommand(context, toggle, { id: 'tui-target' })).resolves.toEqual({
      status: 'succeeded',
      resultSummary: 'ensemble_seat_disabled'
    })
    expect(
      (
        store.getThread(first.appChatId)!.ensemble as {
          participants: Array<{ id: string; enabled: boolean }>
        }
      ).participants.find((participant) => participant.id === firstParticipants[0]!.id)
    ).toMatchObject({ enabled: false })

    const lastSeat = command(
      'ensemble.seat.toggle',
      'cmd-seat-last',
      { threadId: first.appChatId },
      { participantId: firstParticipants[1]!.id, enabled: false }
    )
    expect(domain.evaluateAuthority(context, lastSeat)).toEqual({
      decision: 'deny',
      reason: 'standalone_ensemble_last_seat_required'
    })

    const crossThread = command(
      'ensemble.seat.toggle',
      'cmd-seat-cross-thread',
      { threadId: first.appChatId },
      { participantId: secondParticipants[0]!.id, enabled: false }
    )
    expect(domain.evaluateAuthority(context, crossThread)).toEqual({
      decision: 'deny',
      reason: 'standalone_ensemble_participant_not_found'
    })

    const current = store.getThread(first.appChatId)!
    store.persistThreadRecord({
      threadId: current.appChatId,
      expectedRevision: current.persistenceRevision ?? 0,
      record: {
        ...current,
        ensemble: {
          ...(current.ensemble as Record<string, unknown>),
          activeRound: { status: 'running' }
        }
      }
    })
    const activeRoundToggle = command(
      'ensemble.seat.toggle',
      'cmd-seat-active-round',
      { threadId: first.appChatId },
      { participantId: firstParticipants[0]!.id, enabled: true }
    )
    expect(domain.evaluateAuthority(context, activeRoundToggle)).toEqual({
      decision: 'deny',
      reason: 'standalone_ensemble_round_active'
    })

    const ios = {
      actor: { actorId: 'ios-1', clientId: 'ios-1', clientClass: 'ios' as const },
      client: { clientId: 'ios-1', clientClass: 'ios' as const, clientVersion: '1.0.0' }
    }
    expect(
      domain.evaluateAuthority(ios, {
        ...toggle,
        actor: ios.actor
      })
    ).toEqual({
      decision: 'deny',
      reason: 'standalone_local_actor_required'
    })
  })

  it('refuses composer.send on an ensemble thread instead of running one provider', async () => {
    const { domain, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({ threadId: thread.appChatId, providerId: 'muse' })
    store.setThreadKind({ threadId: thread.appChatId, targetKind: 'ensemble' })
    const send = command(
      'composer.send',
      'cmd-ensemble-send',
      { threadId: thread.appChatId },
      { text: 'This must not masquerade as an ensemble round.' }
    )

    expect(domain.evaluateAuthority(context, send)).toEqual({
      decision: 'deny',
      reason: 'standalone_ensemble_round_unavailable'
    })
    await expect(domain.executeCommand(context, send, { id: 'tui-target' })).resolves.toEqual({
      status: 'failed',
      errorCode: 'authority_denied'
    })
    expect(store.getThread(thread.appChatId)?.runs ?? []).toEqual([])
  })

  it('allows only the exact Desktop Host actor to mutate workspace records', async () => {
    const { domain, store, workspace } = open()
    const upsert = desktopCommand(
      'workspace.record.upsert',
      'cmd-workspace-upsert',
      { workspaceId: 'workspace-desktop-1' },
      {
        path: workspace,
        displayName: 'Desktop workspace',
        createdAt: 10,
        lastOpenedAt: 20,
        pinned: false,
        branch: 'main'
      }
    )
    expect(domain.evaluateAuthority(desktopContext, upsert)).toEqual({ decision: 'allow' })
    await expect(
      domain.executeCommand(desktopContext, upsert, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'workspace_record_upserted' })
    expect(store.listWorkspaces()).toEqual([
      expect.objectContaining({ id: 'workspace-desktop-1', branch: 'main' })
    ])

    const tuiRemove = command(
      'workspace.record.remove',
      'cmd-workspace-remove-tui',
      { workspaceId: 'workspace-desktop-1' },
      {}
    )
    expect(domain.evaluateAuthority(context, tuiRemove)).toEqual({
      decision: 'deny',
      reason: 'standalone_desktop_actor_required'
    })

    const remove = desktopCommand(
      'workspace.record.remove',
      'cmd-workspace-remove',
      { workspaceId: 'workspace-desktop-1' },
      {}
    )
    await expect(
      domain.executeCommand(desktopContext, remove, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'workspace_record_removed' })

    const clear = desktopCommand('workspace.records.clear', 'cmd-workspaces-clear', {}, {})
    await expect(
      domain.executeCommand(desktopContext, clear, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'workspace_records_already_empty' })
  })

  it('executes chat-kind configuration against the standalone Host-owned thread store', async () => {
    const { domain, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({ threadId: thread.appChatId, providerId: 'muse' })

    await expect(
      domain.executeCommand(
        context,
        command(
          'thread.configure',
          'cmd-ensemble-on',
          { threadId: thread.appChatId },
          { chatKind: 'ensemble' }
        ),
        { id: 'tui-target' }
      )
    ).resolves.toMatchObject({ status: 'succeeded' })
    expect(store.getThread(thread.appChatId)).toMatchObject({ chatKind: 'ensemble' })

    await expect(
      domain.executeCommand(
        context,
        command(
          'thread.configure',
          'cmd-ensemble-off',
          { threadId: thread.appChatId },
          { chatKind: 'single', canonicalProviderId: 'muse' }
        ),
        { id: 'tui-target' }
      )
    ).resolves.toMatchObject({ status: 'succeeded' })
    expect(store.getThread(thread.appChatId)).toMatchObject({
      chatKind: 'single',
      provider: 'muse'
    })
  })

  it('persists whole thread records only for the exact authenticated Desktop Host actor', async () => {
    const { domain, domainOptions, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const descriptor = publishHostThreadRecordTransfer({
      profilePath: domainOptions.profilePath,
      transferId: '11111111-1111-4111-8111-111111111112',
      record: {
        ...thread,
        title: 'Host-mediated ensemble record',
        futureEnsembleField: { round: 'round-1', lanes: ['worker-1'] }
      }
    })
    const persist = desktopCommand(
      'thread.record.persist',
      'cmd-persist',
      { threadId: thread.appChatId },
      { ...descriptor, expectedRevision: thread.persistenceRevision ?? 0 }
    )

    expect(domain.evaluateAuthority(desktopContext, persist)).toEqual({ decision: 'allow' })

    const { profilePath: _profilePath, ...withoutProfilePath } = domainOptions
    const unwiredDomain = new HostNodeDomainPorts(withoutProfilePath)
    expect(unwiredDomain.evaluateAuthority(desktopContext, persist)).toEqual({
      decision: 'deny',
      reason: 'standalone_thread_record_persist_unavailable'
    })

    await expect(
      domain.executeCommand(desktopContext, persist, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'thread_record_persisted' })
    expect(store.getThread(thread.appChatId)).toMatchObject({
      title: 'Host-mediated ensemble record',
      persistenceRevision: 1,
      futureEnsembleField: { round: 'round-1', lanes: ['worker-1'] }
    })

    const current = store.getThread(thread.appChatId)!
    const deniedDescriptor = publishHostThreadRecordTransfer({
      profilePath: domainOptions.profilePath,
      transferId: '11111111-1111-4111-8111-111111111113',
      record: { ...current, title: 'TUI must not overwrite this record' }
    })
    const tuiPersist = command(
      'thread.record.persist',
      'cmd-persist-tui',
      { threadId: thread.appChatId },
      { ...deniedDescriptor, expectedRevision: current.persistenceRevision ?? 0 }
    )
    expect(domain.evaluateAuthority(context, tuiPersist)).toEqual({
      decision: 'deny',
      reason: 'standalone_desktop_actor_required'
    })
    await expect(domain.executeCommand(context, tuiPersist, { id: 'tui-target' })).resolves.toEqual(
      { status: 'failed', errorCode: 'authority_denied' }
    )
    expect(store.getThread(thread.appChatId)?.title).toBe('Host-mediated ensemble record')
    expect(
      existsSync(
        hostThreadRecordTransferPath(domainOptions.profilePath, deniedDescriptor.transferId)
      )
    ).toBe(true)
  })

  it('deletes a thread record only for the exact authenticated Desktop Host actor', async () => {
    const { domain, store } = open()
    const thread = store.createThread({ scope: 'global', title: 'Delete through Host' })
    const remove = desktopCommand(
      'thread.record.delete',
      'cmd-delete',
      { threadId: thread.appChatId },
      { expectedRevision: thread.persistenceRevision ?? 0 }
    )
    expect(domain.evaluateAuthority(desktopContext, remove)).toEqual({ decision: 'allow' })
    await expect(
      domain.executeCommand(desktopContext, remove, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'thread_record_deleted' })
    expect(store.getThread(thread.appChatId)).toBeNull()

    const protectedThread = store.createThread({ scope: 'global', title: 'Protected from TUI' })
    const tuiRemove = command(
      'thread.record.delete',
      'cmd-delete-tui',
      { threadId: protectedThread.appChatId },
      { expectedRevision: protectedThread.persistenceRevision ?? 0 }
    )
    expect(domain.evaluateAuthority(context, tuiRemove)).toEqual({
      decision: 'deny',
      reason: 'standalone_desktop_actor_required'
    })
    await expect(domain.executeCommand(context, tuiRemove, { id: 'tui-target' })).resolves.toEqual({
      status: 'failed',
      errorCode: 'authority_denied'
    })
    expect(store.getThread(protectedThread.appChatId)?.title).toBe('Protected from TUI')
  })

  it('maps missing, integrity, and optimistic-revision failures to distinct outcomes', async () => {
    const { domain, domainOptions, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const missing = desktopCommand(
      'thread.record.persist',
      'cmd-persist-missing',
      { threadId: thread.appChatId },
      {
        transferId: '11111111-1111-4111-8111-111111111114',
        sha256: 'a'.repeat(64),
        byteLength: 1,
        expectedRevision: thread.persistenceRevision ?? 0
      }
    )
    await expect(
      domain.executeCommand(desktopContext, missing, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'failed', errorCode: 'thread_record_transfer_missing' })

    const integrityDescriptor = publishHostThreadRecordTransfer({
      profilePath: domainOptions.profilePath,
      transferId: '11111111-1111-4111-8111-111111111115',
      record: { ...thread, title: 'Digest mismatch' }
    })
    const integrity = desktopCommand(
      'thread.record.persist',
      'cmd-persist-integrity',
      { threadId: thread.appChatId },
      {
        ...integrityDescriptor,
        sha256: 'b'.repeat(64),
        expectedRevision: thread.persistenceRevision ?? 0
      }
    )
    await expect(
      domain.executeCommand(desktopContext, integrity, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'failed', errorCode: 'thread_record_transfer_integrity' })
    expect(
      existsSync(
        hostThreadRecordTransferPath(domainOptions.profilePath, integrityDescriptor.transferId)
      )
    ).toBe(false)

    const conflictDescriptor = publishHostThreadRecordTransfer({
      profilePath: domainOptions.profilePath,
      transferId: '11111111-1111-4111-8111-111111111116',
      record: { ...thread, title: 'Stale update' }
    })
    const conflict = desktopCommand(
      'thread.record.persist',
      'cmd-persist-conflict',
      { threadId: thread.appChatId },
      {
        ...conflictDescriptor,
        expectedRevision: (thread.persistenceRevision ?? 0) + 1
      }
    )
    await expect(
      domain.executeCommand(desktopContext, conflict, { id: 'desktop-target' })
    ).resolves.toEqual({ status: 'failed', errorCode: 'thread_record_revision_conflict' })
    expect(store.getThread(thread.appChatId)?.title).not.toBe('Stale update')
  })

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
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'run_started' })
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
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'run_cancellation_requested' })
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
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'run_started' })
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

  it('admits thread.select for a live workspace thread and refuses unknown or archived threads', async () => {
    const { domain, workspace } = open()
    const workspaceResult = await domain.executeCommand(
      context,
      command('workspace.register', 'cmd-select-workspace', {}, { path: workspace }),
      { id: 'tui-target' }
    )
    const workspaceId = (workspaceResult.resultRef as { workspaceId: string }).workspaceId
    const threadResult = await domain.executeCommand(
      context,
      command('thread.create', 'cmd-select-thread', {}, { scope: 'workspace', workspaceId }),
      { id: 'tui-target' }
    )
    const threadId = (threadResult.resultRef as { threadId: string }).threadId
    console.log('DBG threadResult', JSON.stringify(threadResult))

    // The TUI acknowledges every thread switch with thread.select. The Host holds
    // no watched-thread state, so this validates and succeeds without mutating.
    expect(
      domain.evaluateAuthority(context, command('thread.select', 'cmd-select', { threadId }, {}))
    ).toEqual({ decision: 'allow' })
    await expect(
      domain.executeCommand(context, command('thread.select', 'cmd-select', { threadId }, {}), {
        id: 'tui-target'
      })
    ).resolves.toMatchObject({ status: 'succeeded' })

    expect(
      domain.evaluateAuthority(
        context,
        command('thread.select', 'cmd-select-missing', { threadId: 'id-absent' }, {})
      )
    ).toEqual({ decision: 'deny', reason: 'standalone_thread_required' })

    await expect(
      domain.executeCommand(
        context,
        command('thread.archive', 'cmd-select-archive', { threadId }, { archived: true }),
        { id: 'tui-target' }
      )
    ).resolves.toMatchObject({ status: 'succeeded' })
    expect(
      domain.evaluateAuthority(
        context,
        command('thread.select', 'cmd-select-archived', { threadId }, {})
      )
    ).toEqual({ decision: 'deny', reason: 'standalone_thread_required' })
  })

  it('projects curated thread offers for a configured thread and locks one with no provider', async () => {
    const { domain, workspace } = open()
    const workspaceResult = await domain.executeCommand(
      context,
      command('workspace.register', 'cmd-offers-workspace', {}, { path: workspace }),
      { id: 'tui-target' }
    )
    const workspaceId = (workspaceResult.resultRef as { workspaceId: string }).workspaceId
    const configured = (
      (
        await domain.executeCommand(
          context,
          command('thread.create', 'cmd-offers-thread', {}, { scope: 'workspace', workspaceId }),
          { id: 'tui-target' }
        )
      ).resultRef as { threadId: string }
    ).threadId
    await domain.executeCommand(
      context,
      command(
        'thread.configure',
        'cmd-offers-configure',
        { threadId: configured },
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

    const offers = await domain.threadOffers(configured)
    expect(offers.threadId).toBe(configured)
    expect(offers.source).toBe('curated')
    expect(offers.locked).toBeUndefined()
    expect(offers.currentModel).toBe('muse-spark-1.2')
    expect(offers.currentReasoningEffort).toBe('high')
    expect(offers.provider.runtimeProvider).toBe('muse')
    expect(offers.models.map((model) => model.id)).toEqual(['muse-spark-1.2'])
    const model = offers.models[0]
    expect(model.current).toBe(true)
    expect(model.isDefault).toBe(true)
    expect(model.disabled).toBeUndefined()
    expect(model.reasoningEfforts.map((effort) => effort.id)).toEqual(['high'])

    // A thread created by /new carries no provider until cold start configures it.
    // Offers must stay honest and locked rather than inventing a catalogue.
    const bare = (
      (
        await domain.executeCommand(
          context,
          command('thread.create', 'cmd-offers-bare', {}, { scope: 'workspace', workspaceId }),
          { id: 'tui-target' }
        )
      ).resultRef as { threadId: string }
    ).threadId
    const bareOffers = await domain.threadOffers(bare)
    expect(bareOffers.models).toEqual([])
    expect(bareOffers.locked).toBeTruthy()

    expect(() => domain.threadOffers('id-absent')).toThrow(/Unknown standalone thread/)
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
    const rejectingProvider: HostNodeProviderInstance = {
      providerId: 'muse',
      getStatus: async () => ({
        providerId: 'muse',
        status: 'ready',
        label: 'Muse'
      }),
      getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
      getAuthFlows: async () => [],
      beginAuth: async () => undefined,
      cancelAuth: async () => false,
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
      },
      cancel: () => true,
      shutdown: async () => undefined
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      providers: [
        {
          providerId: 'muse',
          displayProvider: 'Muse',
          shortCode: 'MUSE',
          offers: museOffers,
          supportsApprovals: false,
          supportsQuestions: false,
          create: () => rejectingProvider
        }
      ]
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
    ).resolves.toEqual({ status: 'succeeded', resultSummary: 'run_started' })
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
    const unprovableProvider: HostNodeProviderInstance = {
      providerId: 'muse',
      getStatus: async () => ({
        providerId: 'muse',
        status: 'ready',
        label: 'Muse'
      }),
      getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
      getAuthFlows: async () => [],
      beginAuth: async () => undefined,
      cancelAuth: async () => false,
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
        return { runId: input.runId, status: 'cancelled', sessionId: SESSION_ID, exitCode: null }
      },
      shutdown: async () => undefined
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      providers: [
        {
          providerId: 'muse',
          displayProvider: 'Muse',
          shortCode: 'MUSE',
          offers: museOffers,
          supportsApprovals: false,
          supportsQuestions: false,
          create: () => unprovableProvider
        }
      ]
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
    ).resolves.toEqual({ status: 'failed', errorCode: 'run_not_started' })
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
        warningSummaries: ['Provider running state recovered after Host restart.']
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

  it('proves advertised approvals resume exactly once through the awaitable seam', async () => {
    const { domainOptions } = open()
    const approvalProvider: HostNodeProvider = {
      providerId: 'muse',
      displayProvider: 'Muse',
      shortCode: 'MUSE',
      offers: museOffers,
      supportsApprovals: true,
      supportsQuestions: false,
      create: () => ({
        providerId: 'muse',
        getStatus: async () => ({ providerId: 'muse', status: 'ready', label: 'Muse' }),
        getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
        getAuthFlows: async () => [],
        beginAuth: async () => undefined,
        cancelAuth: async () => false,
        run: async () => ({ runId: 'run-1', status: 'completed' as const }),
        cancel: () => true,
        shutdown: async () => undefined
      })
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      providers: [approvalProvider]
    })
    // Set up a live run/thread that owns the pending card.
    const workspace = mkdtempSync(join(tmpdir(), 'host-node-domain-workspace-'))
    paths.push(workspace)
    const registered = domainOptions.store.registerWorkspace({ path: workspace })
    const thread = domainOptions.store.createThread({
      scope: 'workspace',
      workspaceId: registered.id
    })
    domainOptions.store.configureThread({
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'default',
      postureConsent: true
    })
    const begin = domain.runPort.beginRun({
      runId: 'run-1',
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    expect(begin.kind).toBe('started')
    // Verify the live run/thread is visible to the ownership check.
    expect(domain.runPort.getThread(thread.appChatId)).not.toBeNull()
    expect(domain.runPort.getThread(thread.appChatId)?.providerId).toBe('muse')
    expect(domain.runPort.hasBegun('run-1', thread.appChatId)).toBe(true)
    const settlement = domain.interactions.register({
      id: 'ap-1',
      kind: 'approval',
      providerId: 'muse',
      runId: 'run-1',
      threadId: thread.appChatId,
      title: 'Approve tool',
      summary: 'Allow tool execution',
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    const result = domain.interactions.decide({
      id: 'ap-1',
      decision: 'accept',
      actor: { clientId: 'tui-1', clientClass: 'tui', actorId: 'actor-1' }
    })
    expect(result.settled).toMatchObject({ id: 'ap-1', kind: 'approval' })
    await expect(settlement).resolves.toMatchObject({
      id: 'ap-1',
      kind: 'approval',
      decision: 'accept'
    })
    expect(
      domain.interactions.decide({
        id: 'ap-1',
        decision: 'decline',
        actor: { clientId: 'tui-1', clientClass: 'tui', actorId: 'actor-1' }
      }).settled
    ).toBeNull()
  })

  it('projects pending approvals and questions into snapshotDonor', async () => {
    const { domainOptions } = open()
    const approvalProvider: HostNodeProvider = {
      providerId: 'muse',
      displayProvider: 'Muse',
      shortCode: 'MUSE',
      offers: museOffers,
      supportsApprovals: true,
      supportsQuestions: true,
      create: () => ({
        providerId: 'muse',
        getStatus: async () => ({ providerId: 'muse', status: 'ready', label: 'Muse' }),
        getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
        getAuthFlows: async () => [],
        beginAuth: async () => undefined,
        cancelAuth: async () => false,
        run: async () => ({ runId: 'run-1', status: 'completed' as const }),
        cancel: () => true,
        shutdown: async () => undefined
      })
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      providers: [approvalProvider]
    })
    void domain.interactions.register({
      id: 'ap-1',
      kind: 'approval',
      providerId: 'muse',
      runId: 'run-1',
      threadId: 'thread-1',
      title: 'Approve tool',
      summary: 'Allow tool execution',
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    void domain.interactions.register({
      id: 'q-1',
      kind: 'question',
      providerId: 'muse',
      runId: 'run-1',
      threadId: 'thread-1',
      title: 'Choose option',
      summary: 'Pick one',
      options: ['a', 'b'],
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    const snapshot = domain.snapshotDonor()
    expect(snapshot.approvals).toHaveLength(1)
    expect(snapshot.approvals[0]).toMatchObject({
      approvalId: 'ap-1',
      threadId: 'thread-1',
      status: 'pending'
    })
    expect(snapshot.questions).toHaveLength(1)
    expect(snapshot.questions[0]).toMatchObject({
      questionId: 'q-1',
      threadId: 'thread-1',
      status: 'open'
    })
  })

  it('validates a decision command in authority evaluation without settling it', async () => {
    const { domainOptions } = open()
    const approvalProvider: HostNodeProvider = {
      providerId: 'muse',
      displayProvider: 'Muse',
      shortCode: 'MUSE',
      offers: museOffers,
      supportsApprovals: true,
      supportsQuestions: false,
      create: () => ({
        providerId: 'muse',
        getStatus: async () => ({ providerId: 'muse', status: 'ready', label: 'Muse' }),
        getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
        getAuthFlows: async () => [],
        beginAuth: async () => undefined,
        cancelAuth: async () => false,
        run: async () => ({ runId: 'run-1', status: 'completed' as const }),
        cancel: () => true,
        shutdown: async () => undefined
      })
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      providers: [approvalProvider]
    })
    // Set up a live run/thread that owns the pending card.
    const workspace = mkdtempSync(join(tmpdir(), 'host-node-domain-workspace-'))
    paths.push(workspace)
    const registered = domainOptions.store.registerWorkspace({ path: workspace })
    const thread = domainOptions.store.createThread({
      scope: 'workspace',
      workspaceId: registered.id
    })
    domainOptions.store.configureThread({
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'default',
      postureConsent: true
    })
    const begin = domain.runPort.beginRun({
      runId: 'run-1',
      threadId: thread.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    expect(begin.kind).toBe('started')
    const settlement = domain.interactions.register({
      id: 'ap-1',
      kind: 'approval',
      providerId: 'muse',
      runId: 'run-1',
      threadId: thread.appChatId,
      title: 'Approve tool',
      summary: 'Allow tool execution',
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    const command = {
      type: 'host.command' as const,
      protocolVersion: 2 as const,
      commandId: 'cmd-1',
      idempotencyKey: 'key-cmd-1',
      actor: { actorId: 'actor-1', clientId: 'tui-1', clientClass: 'tui' as const },
      name: 'approval.decide' as const,
      target: { approvalId: 'ap-1' },
      arguments: { decision: 'accept' },
      issuedAt: '2026-08-24T05:00:00.000Z'
    }
    const liveThread = domain.runPort.getThread(thread.appChatId)
    expect(liveThread).not.toBeNull()
    expect(liveThread?.providerId).toBe('muse')
    expect(domain.runPort.hasBegun('run-1', thread.appChatId)).toBe(true)
    const authority = domain.evaluateAuthority(context, command)
    expect(authority).toEqual({ decision: 'allow' })
    // Authority evaluation must NOT settle the interaction.
    expect(domain.interactions.listPending()).toHaveLength(1)
    // Execution settles exactly once.
    const result = await domain.executeCommand(context, command, { id: 'tui-1' })
    expect(result).toMatchObject({ status: 'succeeded' })
    await expect(settlement).resolves.toMatchObject({ id: 'ap-1', decision: 'accept' })
    expect(domain.interactions.listPending()).toHaveLength(0)
  })

  it('cancels matching interactions on run completion while unrelated runs survive', async () => {
    const { domainOptions, store, workspace } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const thread1 = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const thread2 = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread1.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'default',
      postureConsent: true
    })
    store.configureThread({
      threadId: thread2.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      postureId: 'default',
      postureConsent: true
    })
    const approvalProvider: HostNodeProvider = {
      providerId: 'muse',
      displayProvider: 'Muse',
      shortCode: 'MUSE',
      offers: museOffers,
      supportsApprovals: true,
      supportsQuestions: false,
      create: () => ({
        providerId: 'muse',
        getStatus: async () => ({ providerId: 'muse', status: 'ready', label: 'Muse' }),
        getAuthStatus: async () => ({ providerId: 'muse', state: 'authenticated' }),
        getAuthFlows: async () => [],
        beginAuth: async () => undefined,
        cancelAuth: async () => false,
        run: async () => ({ runId: 'run-1', status: 'completed' as const }),
        cancel: () => true,
        shutdown: async () => undefined
      })
    }
    const domain = new HostNodeDomainPorts({
      ...domainOptions,
      providers: [approvalProvider]
    })
    domain.runPort.beginRun({
      runId: 'run-1',
      threadId: thread1.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    domain.runPort.beginRun({
      runId: 'run-2',
      threadId: thread2.appChatId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    const run1 = domain.interactions.register({
      id: 'ap-1',
      kind: 'approval',
      providerId: 'muse',
      runId: 'run-1',
      threadId: thread1.appChatId,
      title: 'Approve tool',
      summary: 'Allow tool execution',
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    const run2 = domain.interactions.register({
      id: 'ap-2',
      kind: 'approval',
      providerId: 'muse',
      runId: 'run-2',
      threadId: thread2.appChatId,
      title: 'Approve tool',
      summary: 'Allow tool execution',
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    expect(domain.interactions.listPending()).toHaveLength(2)
    // Complete run-1; run-2 must survive.
    domain.interactions.cancelByRunId('run-1', 'test: run completed')
    await expect(run1).rejects.toThrow('test: run completed')
    expect(domain.interactions.listPending()).toHaveLength(1)
    expect(domain.interactions.listPending()[0].id).toBe('ap-2')
    // run-2 is still pending and resolvable.
    domain.interactions.decide({
      id: 'ap-2',
      decision: 'accept',
      actor: { clientId: 'tui-1', clientClass: 'tui', actorId: 'actor-1' }
    })
    await expect(run2).resolves.toMatchObject({ id: 'ap-2', decision: 'accept' })
  })
})
