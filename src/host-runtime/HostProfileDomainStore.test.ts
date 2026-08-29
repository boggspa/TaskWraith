import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HOST_PROFILE_WORKSPACES_FILENAME,
  HostProfileDomainStore
} from './HostProfileDomainStore'
import { isPlaceholderThreadTitle } from '../shared/threadTitles'

const profiles: string[] = []

function open() {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-domain-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-workspace-'))
  profiles.push(profile, workspace)
  const authority = { assertProfileAuthority: vi.fn() }
  let sequence = 0
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority,
    now: () => 100,
    idFactory: () => `id-${++sequence}`
  })
  return { profile, workspace, authority, store }
}

function seedMessages(profile: string, threadId: string, messages: readonly unknown[]): void {
  const chatPath = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
  const record = JSON.parse(readFileSync(chatPath, 'utf8')) as Record<string, unknown>
  record.messages = [...messages]
  writeFileSync(chatPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

describe('HostProfileDomainStore', () => {
  it('tightens a legacy process-umask chats directory to owner-only during Host takeover', () => {
    const profile = mkdtempSync(join(tmpdir(), 'host-profile-domain-legacy-mode-'))
    profiles.push(profile)
    const chats = join(profile, HOST_PROFILE_CHATS_DIRECTORY)
    mkdirSync(chats, { mode: 0o755 })
    if (process.platform !== 'win32') chmodSync(chats, 0o755)
    const authority = { assertProfileAuthority: vi.fn() }

    expect(() => new HostProfileDomainStore({ profilePath: profile, authority })).not.toThrow()
    if (process.platform !== 'win32') {
      expect(lstatSync(chats).mode & 0o7777).toBe(0o700)
    }
    expect(authority.assertProfileAuthority).toHaveBeenCalled()
  })

  it('asserts authority before profile access and canonicalizes workspace aliases idempotently', () => {
    const { store, workspace, authority } = open()
    const first = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
    const alias = join(workspace, '.')
    const second = store.registerWorkspace({ path: alias, pinned: true })
    expect(second.id).toBe(first.id)
    expect(second.realPath).toBe(first.realPath)
    expect(store.listWorkspaces()).toHaveLength(1)
    expect(authority.assertProfileAuthority).toHaveBeenCalled()
  })

  it('upserts, removes, and clears Desktop workspace records through Host-owned semantics', () => {
    const { store, workspace } = open()
    const created = store.upsertWorkspaceRecord({
      workspaceId: 'workspace-desktop-1',
      record: {
        path: workspace,
        displayName: 'Desktop workspace',
        createdAt: 10,
        lastOpenedAt: 20,
        pinned: false,
        branch: 'main',
        geminiWorktree: { enabled: true, name: 'agy' }
      }
    })
    expect(created).toMatchObject({
      id: 'workspace-desktop-1',
      path: workspace,
      realPath: realpathSync(workspace),
      pinned: false,
      branch: 'main',
      geminiWorktree: { enabled: true, name: 'agy' }
    })
    const updated = store.upsertWorkspaceRecord({
      workspaceId: created.id,
      record: {
        path: workspace,
        displayName: 'Desktop workspace',
        createdAt: 10,
        lastOpenedAt: 30,
        pinned: true,
        branch: 'feature'
      }
    })
    expect(updated).toMatchObject({
      pinned: true,
      branch: 'feature',
      lastOpenedAt: 30,
      geminiWorktree: { enabled: true, name: 'agy' }
    })
    expect(store.removeWorkspaceRecord(created.id)).toBe(true)
    expect(store.removeWorkspaceRecord(created.id)).toBe(false)

    store.upsertWorkspaceRecord({
      workspaceId: 'workspace-desktop-2',
      record: {
        path: workspace,
        displayName: 'Second',
        createdAt: 40,
        lastOpenedAt: 50,
        pinned: false
      }
    })
    expect(store.clearWorkspaceRecords()).toBe(1)
    expect(store.listWorkspaces()).toEqual([])
  })

  it('preserves unknown workspace/chat fields across narrow updates and restart', () => {
    const { profile, workspace, authority, store } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const workspaceFile = join(profile, HOST_PROFILE_WORKSPACES_FILENAME)
    const workspaces = JSON.parse(readFileSync(workspaceFile, 'utf8')) as Array<
      Record<string, unknown>
    >
    workspaces[0].unknownWorkspaceField = 'retain'
    writeFileSync(workspaceFile, JSON.stringify(workspaces))
    chmodSync(workspaceFile, 0o600)
    expect(store.registerWorkspace({ path: workspace }).unknownWorkspaceField).toBe('retain')

    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    raw.unknownChatField = { preserve: true }
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)
    store.configureThread({ threadId: thread.appChatId, title: 'Renamed' })
    const restarted = new HostProfileDomainStore({
      profilePath: profile,
      authority,
      now: () => 101
    })
    expect(restarted.getThread(thread.appChatId)).toMatchObject({
      title: 'Renamed',
      unknownChatField: { preserve: true }
    })
  })

  it('loads legacy workspace rows without realPath/pinned and adopts them idempotently', () => {
    const { profile, workspace, store } = open()
    const registered = store.registerWorkspace({ path: workspace })
    const workspaceFile = join(profile, HOST_PROFILE_WORKSPACES_FILENAME)
    const legacy = JSON.parse(readFileSync(workspaceFile, 'utf8')) as Array<Record<string, unknown>>
    delete legacy[0].realPath
    delete legacy[0].pinned
    delete legacy[0].updatedAt
    writeFileSync(workspaceFile, JSON.stringify(legacy))
    chmodSync(workspaceFile, 0o600)
    const adopted = store.registerWorkspace({ path: join(workspace, '.') })
    expect(adopted.id).toBe(registered.id)
    expect(adopted.realPath).toBe(registered.realPath)
    expect(adopted.pinned).toBe(false)
  })

  it('gives an untitled thread a default the shared placeholder predicate recognises', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global' })
    // The invariant, not the spelling: a Host-created thread must be a title the
    // first-prompt gates and the repair pass are allowed to overwrite. The
    // predicate is case-sensitive after whitespace collapse, so a lowercase
    // default silently made every TUI-born thread keep its title forever.
    expect(isPlaceholderThreadTitle(thread.title)).toBe(true)
    // An explicit title still wins and is never treated as a placeholder.
    const named = store.createThread({ scope: 'global', title: 'Persistence review' })
    expect(isPlaceholderThreadTitle(named.title)).toBe(false)
  })

  it('fences setup/archive while a run is active and supports bounded history pages', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global' })
    store.appendTranscript({ threadId: thread.appChatId, role: 'user', content: 'one' })
    store.appendTranscript({ threadId: thread.appChatId, role: 'assistant', content: 'two' })
    store.appendTranscript({ threadId: thread.appChatId, role: 'system', content: 'three' })
    expect(store.threadHistory({ threadId: thread.appChatId, limit: 2 })).toMatchObject({
      cursor: 3,
      entries: [{ text: 'two' }, { text: 'three' }],
      nextBefore: { generation: 3, cursor: 1 }
    })
    store.updateRun({ threadId: thread.appChatId, runId: 'run-1', status: 'running' })
    expect(() => store.archiveThread(thread.appChatId, true)).toThrow('active')
    expect(() => store.configureThread({ threadId: thread.appChatId, title: 'Nope' })).toThrow(
      'active'
    )
    expect(
      store.historySince({ threadId: thread.appChatId, since: { generation: 4, cursor: 3 } })
    ).toMatchObject({ kind: 'full_resnapshot_required', reason: 'retention_gap' })
    expect(() =>
      store.threadHistory({
        threadId: thread.appChatId,
        limit: 1,
        before: { generation: 3, cursor: 1 }
      })
    ).toThrow('generation')
  })

  it('fails closed on corrupt or symlinked profile artifacts', () => {
    const { profile, workspace, store } = open()
    store.registerWorkspace({ path: workspace })
    const workspaceFile = join(profile, HOST_PROFILE_WORKSPACES_FILENAME)
    writeFileSync(workspaceFile, '{')
    chmodSync(workspaceFile, 0o600)
    expect(() => store.listWorkspaces()).toThrow()

    const { profile: symlinkProfile, workspace: symlinkWorkspace, store: symlinkStore } = open()
    symlinkStore.registerWorkspace({ path: symlinkWorkspace })
    const target = join(symlinkProfile, 'other.json')
    writeFileSync(target, '[]')
    chmodSync(target, 0o600)
    rmSync(join(symlinkProfile, HOST_PROFILE_WORKSPACES_FILENAME))
    symlinkSync(target, join(symlinkProfile, HOST_PROFILE_WORKSPACES_FILENAME))
    expect(() => symlinkStore.listWorkspaces()).toThrow('Unsafe')
  })

  it('leaves the prior authoritative record intact when atomic publication faults', () => {
    const { profile, authority, store } = open()
    const thread = store.createThread({ scope: 'global', title: 'Before' })
    const faulting = new HostProfileDomainStore({
      profilePath: profile,
      authority,
      beforeAtomicPublish: () => {
        throw new Error('injected publish fault')
      }
    })
    expect(() => faulting.configureThread({ threadId: thread.appChatId, title: 'After' })).toThrow(
      'injected publish fault'
    )
    expect(store.getThread(thread.appChatId)?.title).toBe('Before')
  })

  it('clears stale provider/MCP sessions on provider switch and enforces run transitions', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    raw.provider = 'claude'
    raw.linkedProviderSessionId = 'provider-session'
    raw.linkedGeminiSessionId = 'gemini-session'
    raw.taskWraithMcpProfileReceipt = { opaque: true }
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)
    const switched = store.configureThread({ threadId: thread.appChatId, providerId: 'codex' })
    expect(switched).not.toHaveProperty('linkedProviderSessionId')
    expect(switched).not.toHaveProperty('linkedGeminiSessionId')
    expect(switched).not.toHaveProperty('taskWraithMcpProfileReceipt')
    expect(() =>
      store.updateRun({ threadId: thread.appChatId, runId: 'run-1', status: 'completed' })
    ).toThrow('begin')
    store.updateRun({ threadId: thread.appChatId, runId: 'run-1', status: 'running' })
    const completed = store.updateRun({
      threadId: thread.appChatId,
      runId: 'run-1',
      status: 'completed'
    })
    const endedAt = completed.runs?.[0].endedAt
    expect(
      store.updateRun({
        threadId: thread.appChatId,
        runId: 'run-1',
        status: 'completed',
        endedAt
      })
    ).toMatchObject({ runs: [{ runId: 'run-1', status: 'completed' }] })
    expect(() =>
      store.updateRun({ threadId: thread.appChatId, runId: 'run-1', status: 'running' })
    ).toThrow('Terminal run cannot change state')
    expect(() =>
      store.updateRun({ threadId: thread.appChatId, runId: 'run-1', status: 'failed' })
    ).toThrow('Terminal run cannot change state')
  })

  it('collapses an idle Ensemble onto the selected provider and restores the stashed roster', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    raw.chatKind = 'ensemble'
    raw.provider = 'codex'
    raw.linkedProviderSessionId = 'top-level-session'
    raw.taskWraithMcpProfileReceipt = { opaque: true }
    raw.ensemble = {
      enabled: true,
      participants: [
        {
          id: 'kimi-boss',
          provider: 'kimi',
          enabled: true,
          role: 'Boss',
          instructions: '',
          order: 1,
          model: 'kimi-k3',
          reasoningEffort: 'high',
          permissionPresetId: 'plan',
          linkedProviderSessionId: 'kimi-session',
          taskWraithMcpProfileReceipt: { opaque: true }
        },
        {
          id: 'codex-worker',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: '',
          order: 2,
          model: 'gpt-5.6'
        }
      ],
      bossmanParticipantId: 'kimi-boss'
    }
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)

    const collapsed = store.setThreadKind({
      threadId: thread.appChatId,
      targetKind: 'single',
      canonicalProviderId: 'kimi'
    })
    expect(collapsed).toMatchObject({
      chatKind: 'single',
      provider: 'kimi',
      providerMetadata: {
        selectedModelType: 'kimi-k3',
        approvalMode: 'plan',
        workflowMode: 'plan',
        kimiReasoningEffort: 'high'
      }
    })
    expect(collapsed).not.toHaveProperty('ensemble')
    expect(collapsed).not.toHaveProperty('linkedProviderSessionId')
    expect(collapsed).not.toHaveProperty('taskWraithMcpProfileReceipt')
    const stash = collapsed.providerMetadata?.stashedEnsemble as {
      config?: { participants?: Array<Record<string, unknown>> }
      provider?: string
    }
    expect(stash.provider).toBe('kimi')
    expect(stash.config?.participants?.[0]).toMatchObject({
      id: 'kimi-boss',
      linkedProviderSessionId: null
    })
    expect(stash.config?.participants?.[0]).not.toHaveProperty('taskWraithMcpProfileReceipt')

    const restored = store.setThreadKind({
      threadId: thread.appChatId,
      targetKind: 'ensemble'
    })
    expect(restored.chatKind).toBe('ensemble')
    expect(
      (restored.ensemble as { participants: Array<{ id: string }> }).participants.map(
        (participant) => participant.id
      )
    ).toEqual(['kimi-boss', 'codex-worker'])
    expect(restored.providerMetadata).not.toHaveProperty('stashedEnsemble')
  })

  it('refuses to collapse while an Ensemble round still has live dispatch evidence', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    raw.chatKind = 'ensemble'
    raw.provider = 'codex'
    raw.ensemble = {
      participants: [
        {
          id: 'codex-seat',
          provider: 'codex',
          enabled: true,
          role: 'Codex',
          instructions: '',
          order: 1
        }
      ],
      activeRound: {
        status: 'running',
        activeParticipantId: 'codex-seat',
        participants: [
          {
            participantId: 'codex-seat',
            provider: 'codex',
            role: 'Codex',
            order: 1,
            status: 'running'
          }
        ]
      }
    }
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)

    expect(() =>
      store.setThreadKind({
        threadId: thread.appChatId,
        targetKind: 'single',
        canonicalProviderId: 'codex'
      })
    ).toThrow('active')
  })

  it('persists run-correlated transcript and full lifecycle metadata across restart', () => {
    const { profile, authority, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const startedAt = '2026-08-24T05:00:00.000Z'
    const endedAt = '2026-08-24T05:01:00.000Z'
    store.appendTranscript({
      threadId: thread.appChatId,
      runId: 'run-1',
      role: 'user',
      content: 'Run-correlated user message',
      timestamp: startedAt
    })
    store.updateRun({
      threadId: thread.appChatId,
      runId: 'run-1',
      status: 'running',
      provider: 'muse',
      requestedModel: 'muse-spark-1.2',
      phase: 'starting',
      startedAt
    })
    store.updateRun({
      threadId: thread.appChatId,
      runId: 'run-1',
      status: 'running',
      phase: 'streaming'
    })
    store.updateRun({
      threadId: thread.appChatId,
      runId: 'run-1',
      status: 'failed',
      endedAt,
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      usage: { inputTokens: 11, outputTokens: 13, estimatedCostUsd: 0.001 },
      warningSummaries: ['Muse reported stderr during the run.'],
      errorCode: 'provider_failed'
    })
    const restarted = new HostProfileDomainStore({
      profilePath: profile,
      authority,
      now: () => 200
    })
    expect(restarted.getThread(thread.appChatId)).toMatchObject({
      messages: [{ runId: 'run-1', content: 'Run-correlated user message' }],
      runs: [
        {
          runId: 'run-1',
          status: 'failed',
          phase: 'streaming',
          startedAt,
          endedAt,
          providerSessionId: '11111111-1111-4111-8111-111111111111',
          usage: { inputTokens: 11, outputTokens: 13, estimatedCostUsd: 0.001 },
          warningSummaries: ['Muse reported stderr during the run.'],
          errorCode: 'provider_failed'
        }
      ]
    })
    expect(
      restarted.updateRun({
        threadId: thread.appChatId,
        runId: 'run-1',
        status: 'failed',
        endedAt,
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        usage: { inputTokens: 11, outputTokens: 13, estimatedCostUsd: 0.001 },
        warningSummaries: ['Muse reported stderr during the run.'],
        errorCode: 'provider_failed'
      })
    ).toMatchObject({ runs: [{ runId: 'run-1', status: 'failed' }] })
    expect(() =>
      restarted.updateRun({ threadId: thread.appChatId, runId: 'run-1', status: 'cancelled' })
    ).toThrow('Terminal run cannot change state')
  })

  it('persists explicit workspace-write posture consent and clears it for a lower posture', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global' })
    expect(() =>
      store.configureThread({ threadId: thread.appChatId, postureId: 'workspace_write' })
    ).toThrow('requires explicit consent')
    const consented = store.configureThread({
      threadId: thread.appChatId,
      postureId: 'workspace_write',
      postureConsent: true
    })
    expect(consented.providerMetadata).toMatchObject({
      permissionPresetId: 'workspace_write',
      explicitConsentAcknowledged: true
    })
    const lowered = store.configureThread({ threadId: thread.appChatId, postureId: 'read_only' })
    expect(lowered.providerMetadata).toMatchObject({ permissionPresetId: 'read_only' })
    expect(lowered.providerMetadata).not.toHaveProperty('explicitConsentAcknowledged')
  })

  it('retains legacy tool/error message carriers inertly while excluding them from history', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    raw.messages = [
      { id: 'tool-1', role: 'tool', content: '', timestamp: 'legacy' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'visible',
        timestamp: '2026-08-24T00:00:00.000Z'
      }
    ]
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)
    expect(store.threadHistory({ threadId: thread.appChatId, limit: 10 }).entries).toEqual([
      expect.objectContaining({ entryId: 'assistant-1', text: 'visible' })
    ])
    const updated = store.configureThread({ threadId: thread.appChatId, title: 'Updated' })
    expect(updated.messages).toHaveLength(2)
  })

  it('fails closed on a chat symlink or unexpected directory entry', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const target = join(profile, 'chat-target.json')
    writeFileSync(target, readFileSync(chatFile))
    chmodSync(target, 0o600)
    rmSync(chatFile)
    symlinkSync(target, chatFile)
    expect(() => store.listThreads()).toThrow('Unsafe')
  })

  it('treats missing legacy run status as active until an end timestamp exists and ignores AppStore temp artifacts', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    raw.runs = [{ runId: 'legacy-run' }]
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)
    writeFileSync(
      join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json.123.job-1.tmp`),
      '{}'
    )
    chmodSync(
      join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json.123.job-1.tmp`),
      0o600
    )
    expect(() => store.configureThread({ threadId: thread.appChatId, title: 'Blocked' })).toThrow(
      'active'
    )
    raw.runs = [{ runId: 'legacy-run', endedAt: '2026-08-24T00:00:00.000Z' }]
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)
    expect(store.configureThread({ threadId: thread.appChatId, title: 'Allowed' }).title).toBe(
      'Allowed'
    )
    expect(store.listThreads()).toHaveLength(1)

    raw.runs = [{ runId: 'legacy-run', status: 'future-state', endedAt: 'not-an-iso-date' }]
    writeFileSync(chatFile, JSON.stringify(raw))
    chmodSync(chatFile, 0o600)
    expect(() =>
      store.configureThread({ threadId: thread.appChatId, title: 'Still blocked' })
    ).toThrow('active')
  })

  it('creates a thread record via optimistic persist with expectedRevision 0', () => {
    const { store } = open()
    const record = {
      appChatId: 'id-new-thread',
      scope: 'global',
      title: 'Persisted create',
      archived: false,
      messages: [],
      updatedAt: 1000,
      unknownChatField: { preserved: true }
    }
    const persisted = store.persistThreadRecord({
      threadId: 'id-new-thread',
      record,
      expectedRevision: 0
    })
    expect(persisted.appChatId).toBe('id-new-thread')
    expect(persisted.title).toBe('Persisted create')
    expect(persisted.persistenceRevision).toBe(0)
    expect(persisted.unknownChatField).toEqual({ preserved: true })
    expect(store.getThread('id-new-thread')).toMatchObject({
      title: 'Persisted create',
      persistenceRevision: 0
    })
  })

  it('updates a thread record via optimistic persist and advances the Host-owned revision', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global', title: 'Before' })
    const record = {
      ...thread,
      title: 'After',
      ensemble: {
        participants: [
          {
            id: 'seat-1',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: '',
            order: 1
          }
        ]
      },
      unknownChatField: { kept: true }
    }
    const persisted = store.persistThreadRecord({
      threadId: thread.appChatId,
      record,
      expectedRevision: 0
    })
    expect(persisted.title).toBe('After')
    expect(persisted.persistenceRevision).toBe(1)
    expect(persisted.ensemble).toEqual(record.ensemble)
    expect(persisted.unknownChatField).toEqual({ kept: true })
    const reloaded = store.getThread(thread.appChatId)
    expect(reloaded?.title).toBe('After')
    expect(reloaded?.persistenceRevision).toBe(1)
  })

  it('preserves ensemble state across a later updateRun after persistThreadRecord', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global' })
    const record = {
      ...thread,
      ensemble: {
        participants: [
          {
            id: 'seat-1',
            provider: 'kimi',
            enabled: true,
            role: 'Boss',
            instructions: '',
            order: 1
          }
        ]
      }
    }
    store.persistThreadRecord({
      threadId: thread.appChatId,
      record,
      expectedRevision: 0
    })
    store.updateRun({
      threadId: thread.appChatId,
      runId: 'run-1',
      status: 'running'
    })
    const updated = store.updateRun({
      threadId: thread.appChatId,
      runId: 'run-1',
      status: 'completed'
    })
    expect(updated.ensemble).toEqual(record.ensemble)
    expect(updated.persistenceRevision).toBe(3)
  })

  it('rejects a persist when the record identity does not match the target thread', () => {
    const { store } = open()
    expect(() =>
      store.persistThreadRecord({
        threadId: 'id-wanted',
        record: {
          appChatId: 'id-actual',
          scope: 'global',
          title: 'Mismatch',
          archived: false,
          messages: [],
          updatedAt: 1
        },
        expectedRevision: 0
      })
    ).toThrow('identity')
  })

  it('rejects a persist with an invalid or negative expected revision', () => {
    const { store } = open()
    expect(() =>
      store.persistThreadRecord({
        threadId: 'id-thread',
        record: {
          appChatId: 'id-thread',
          scope: 'global',
          title: 'Bad revision',
          archived: false,
          messages: [],
          updatedAt: 1
        },
        expectedRevision: -1
      })
    ).toThrow('Invalid expected revision')
  })

  it('rejects an update when the thread does not exist and expectedRevision is not 0', () => {
    const { store } = open()
    expect(() =>
      store.persistThreadRecord({
        threadId: 'id-missing',
        record: {
          appChatId: 'id-missing',
          scope: 'global',
          title: 'Missing',
          archived: false,
          messages: [],
          updatedAt: 1
        },
        expectedRevision: 5
      })
    ).toThrow('not found')
  })

  it('rejects a persist when the current revision does not match the expected revision', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global' })
    expect(() =>
      store.persistThreadRecord({
        threadId: thread.appChatId,
        record: { ...thread, title: 'Lost race' },
        expectedRevision: 99
      })
    ).toThrow('revision mismatch')
  })

  it('deletes a thread record at the expected revision and is idempotent once absent', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global', title: 'Delete me' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    expect(store.deleteThreadRecord({ threadId: thread.appChatId, expectedRevision: 0 })).toBe(true)
    expect(store.getThread(thread.appChatId)).toBeNull()
    expect(store.listThreads()).toEqual([])
    expect(() => readFileSync(chatFile, 'utf8')).toThrow()
    expect(store.deleteThreadRecord({ threadId: thread.appChatId, expectedRevision: 0 })).toBe(
      false
    )
  })

  it('preserves the thread when delete expectedRevision is stale', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global', title: 'Keep me' })
    expect(() =>
      store.deleteThreadRecord({ threadId: thread.appChatId, expectedRevision: 1 })
    ).toThrow('revision mismatch')
    expect(store.getThread(thread.appChatId)?.title).toBe('Keep me')
  })

  it('models truncate as a complete optimistic persist rather than a second Host command', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global', title: 'Keep identity' })
    store.appendTranscript({
      threadId: thread.appChatId,
      role: 'user',
      content: 'Remove this history',
      timestamp: '2026-08-24T00:00:00.000Z'
    })
    const current = store.getThread(thread.appChatId)!
    const truncated = store.persistThreadRecord({
      threadId: thread.appChatId,
      record: { ...current, messages: [], runs: [] },
      expectedRevision: current.persistenceRevision ?? 0
    })
    expect(truncated).toMatchObject({
      appChatId: thread.appChatId,
      title: 'Keep identity',
      messages: [],
      runs: []
    })
  })

  it('models scoped/global clear as repeated deletes over a frozen thread-id set', () => {
    const { store } = open()
    const first = store.createThread({ scope: 'global', title: 'First target' })
    const second = store.createThread({ scope: 'global', title: 'Second target' })
    const survivor = store.createThread({ scope: 'global', title: 'Survivor' })
    for (const thread of [first, second]) {
      expect(
        store.deleteThreadRecord({
          threadId: thread.appChatId,
          expectedRevision: thread.persistenceRevision ?? 0
        })
      ).toBe(true)
    }
    expect(store.listThreads().map((thread) => thread.appChatId)).toEqual([survivor.appChatId])
  })

  it('refuses to follow a substituted symlink while deleting a thread record', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const victim = join(profile, 'victim.json')
    writeFileSync(victim, JSON.stringify({ keep: true }))
    chmodSync(victim, 0o600)
    rmSync(chatFile)
    symlinkSync(victim, chatFile)
    expect(() =>
      store.deleteThreadRecord({
        threadId: thread.appChatId,
        expectedRevision: thread.persistenceRevision ?? 0
      })
    ).toThrow()
    expect(JSON.parse(readFileSync(victim, 'utf8'))).toEqual({ keep: true })
  })

  it('persists a record larger than 256 KB without inlining it in a control frame', () => {
    const { store } = open()
    const bigContent = 'x'.repeat(300_000)
    const record = {
      appChatId: 'id-big',
      scope: 'global',
      title: 'Big record',
      archived: false,
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: bigContent,
          timestamp: '2026-08-24T00:00:00.000Z'
        }
      ],
      updatedAt: 1000
    }
    const persisted = store.persistThreadRecord({
      threadId: 'id-big',
      record,
      expectedRevision: 0
    })
    expect(persisted.messages[0].content).toHaveLength(300_000)
    expect(Buffer.byteLength(JSON.stringify(persisted), 'utf8')).toBeGreaterThan(256_000)
    const reloaded = store.getThread('id-big')
    expect(reloaded?.messages[0].content).toHaveLength(300_000)
  })

  it('skips a record past the read cap instead of failing the whole listing', () => {
    const { profile, store } = open()
    const kept = store.createThread({ scope: 'global', title: 'kept' })
    const oversized = store.createThread({ scope: 'global', title: 'oversized' })
    // Sparse: far past the cap at no disk cost, and its contents are no longer
    // parseable JSON — so any pass that actually READ it would throw.
    truncateSync(
      join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${oversized.appChatId}.json`),
      65 * 1024 * 1024
    )

    const listed = store.listThreads()

    expect(listed.map((thread) => thread.appChatId)).toEqual([kept.appChatId])
  })

  it('reports a skipped oversized record rather than dropping it silently', () => {
    const { profile, store } = open()
    const oversized = store.createThread({ scope: 'global' })
    truncateSync(
      join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${oversized.appChatId}.json`),
      65 * 1024 * 1024
    )

    store.listThreads()

    expect(store.quarantinedThreadIds).toEqual([oversized.appChatId])
  })

  it('still fails closed on a structurally unsafe entry rather than quarantining it', () => {
    const { profile, store } = open()
    store.createThread({ scope: 'global' })
    writeFileSync(join(profile, HOST_PROFILE_CHATS_DIRECTORY, 'not-a-chat.txt'), 'x', {
      mode: 0o600
    })

    expect(() => store.listThreads()).toThrow('Unsafe')
    expect(store.quarantinedThreadIds).toEqual([])
  })

  it('stops quarantining a record once it is back under the cap', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    const chatPath = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    const original = readFileSync(chatPath, 'utf8')
    truncateSync(chatPath, 65 * 1024 * 1024)
    expect(store.listThreads()).toEqual([])
    expect(store.quarantinedThreadIds).toEqual([thread.appChatId])

    writeFileSync(chatPath, original, { mode: 0o600 })

    expect(store.listThreads().map((item) => item.appChatId)).toEqual([thread.appChatId])
    expect(store.quarantinedThreadIds).toEqual([])
  })

  it('announces a quarantined record once, not on every listing', () => {
    const profile = mkdtempSync(join(tmpdir(), 'host-profile-domain-quarantine-'))
    profiles.push(profile)
    const onThreadQuarantined = vi.fn()
    const store = new HostProfileDomainStore({
      profilePath: profile,
      authority: { assertProfileAuthority: vi.fn() },
      now: () => 100,
      idFactory: () => 'id-1',
      onThreadQuarantined
    })
    const thread = store.createThread({ scope: 'global' })
    truncateSync(
      join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`),
      65 * 1024 * 1024
    )

    store.listThreads()
    store.listThreads()
    store.listThreads()

    // Silent skips are what made the original whole-Host failure invisible, so
    // the skip must announce itself — but once, not once per reconciler tick.
    expect(onThreadQuarantined).toHaveBeenCalledTimes(1)
    expect(onThreadQuarantined).toHaveBeenCalledWith(thread.appChatId, 'record-too-large')
  })

  it('serves an unchanged thread summary from cache instead of re-parsing it every listing', () => {
    const { store } = open()
    store.createThread({ scope: 'global', title: 'one' })
    store.createThread({ scope: 'global', title: 'two' })
    store.createThread({ scope: 'global', title: 'three' })

    const first = store.listThreadSummaries()
    const readsAfterFirst = store.threadRecordReads
    const second = store.listThreadSummaries()

    // The reconciler calls this once per second. Re-reading the whole corpus
    // every pass is what saturated the Host's event loop.
    expect(readsAfterFirst).toBe(3)
    expect(store.threadRecordReads).toBe(3)
    expect(second).toEqual(first)
  })

  it('summarizes a thread without carrying its messages', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global', title: 'kept' })
    seedMessages(profile, thread.appChatId, [
      { id: 'm1', role: 'user', content: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'm2', role: 'tool', content: 'noise', timestamp: '2026-01-01T00:00:01.000Z' }
    ])

    const [summary] = store.listThreadSummaries()

    // Retaining the messages array is the whole cost the summary exists to
    // avoid: a real corpus is 95% messages by bytes.
    expect(summary).toBeDefined()
    expect(summary!.messages).toBeUndefined()
    expect(summary!.messageCount).toBe(2)
    expect(summary!.appChatId).toBe(thread.appChatId)
    expect(summary!.title).toBe('kept')
    expect(summary!.scope).toBe('global')
    expect(summary!.updatedAt).toBe(thread.updatedAt)
  })

  it('previews the newest readable message, walking back past tool rows', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    seedMessages(profile, thread.appChatId, [
      { id: 'm1', role: 'user', content: 'older question', timestamp: '2026-01-01T00:00:01.000Z' },
      {
        id: 'm2',
        role: 'assistant',
        content: 'the answer worth showing',
        timestamp: '2026-01-01T00:00:02.000Z'
      },
      {
        id: 'm3',
        role: 'tool',
        content: 'tool output nobody reads',
        timestamp: '2026-01-01T00:00:03.000Z'
      },
      { id: 'm4', role: 'tool', content: 'more tool output', timestamp: '2026-01-01T00:00:04.000Z' }
    ])

    const [summary] = store.listThreadSummaries()

    expect(summary!.latestPreview).toBe('the answer worth showing')
  })

  it('omits a preview when no message is terminal-safe', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    seedMessages(profile, thread.appChatId, [
      {
        id: 'm1',
        role: 'assistant',
        content: 'bel\u0007ringer',
        timestamp: '2026-01-01T00:00:00.000Z'
      }
    ])

    const [summary] = store.listThreadSummaries()

    expect(summary!.latestPreview).toBeUndefined()
  })

  it('re-reads a record the store itself rewrote', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global', title: 'before' })
    store.listThreadSummaries()
    const readsAfterFirst = store.threadRecordReads

    store.configureThread({ threadId: thread.appChatId, title: 'after' })
    const listed = store.listThreadSummaries()

    expect(listed.map((item) => item.title)).toEqual(['after'])
    expect(store.threadRecordReads).toBe(readsAfterFirst + 1)
  })

  it('re-reads a record replaced in place behind the store', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global', title: 'before' })
    const chatPath = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`)
    store.listThreadSummaries()

    // Same inode, same byte length, rewritten underneath the cache. Identity
    // must include a sub-millisecond write clock or this reads back stale.
    const rewritten = readFileSync(chatPath, 'utf8').replace('"before"', '"aftera"')
    writeFileSync(chatPath, rewritten, { mode: 0o600 })

    expect(store.listThreadSummaries().map((item) => item.title)).toEqual(['aftera'])
  })

  it('still refuses a cached record whose mode was widened underneath it', () => {
    const { profile, store } = open()
    const thread = store.createThread({ scope: 'global' })
    store.listThreadSummaries()

    chmodSync(join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${thread.appChatId}.json`), 0o644)

    // The owner-only guard used to live inside the read. A cache that skips
    // the read must not also skip the guard.
    if (process.platform !== 'win32') {
      expect(() => store.listThreadSummaries()).toThrow('owner-only')
    }
  })

  it('drops a deleted record from the cache instead of retaining it forever', () => {
    const { profile, store } = open()
    const kept = store.createThread({ scope: 'global', title: 'kept' })
    const removed = store.createThread({ scope: 'global', title: 'removed' })
    store.listThreadSummaries()
    const bothResident = store.cachedThreadSummaryBytes

    rmSync(join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${removed.appChatId}.json`))

    expect(store.listThreadSummaries().map((item) => item.appChatId)).toEqual([kept.appChatId])
    expect(store.cachedThreadSummaryBytes).toBeLessThan(bothResident)
  })

  it('covers a corpus whose records dwarf the cache budget, because it holds summaries', () => {
    const profile = mkdtempSync(join(tmpdir(), 'host-profile-domain-summary-budget-'))
    profiles.push(profile)
    let sequence = 0
    const store = new HostProfileDomainStore({
      profilePath: profile,
      authority: { assertProfileAuthority: vi.fn() },
      now: () => 100,
      idFactory: () => `id-${++sequence}`,
      threadCacheMaxBytes: 64 * 1024
    })
    for (const title of ['one', 'two', 'three']) {
      const thread = store.createThread({ scope: 'global', title })
      seedMessages(
        profile,
        thread.appChatId,
        Array.from({ length: 400 }, (_unused, index) => ({
          id: `m${index}`,
          role: 'assistant',
          content: 'x'.repeat(400),
          timestamp: '2026-01-01T00:00:00.000Z'
        }))
      )
    }
    const chats = join(profile, HOST_PROFILE_CHATS_DIRECTORY)
    const sourceBytes = readdirSync(chats).reduce(
      (total, name) => total + lstatSync(join(chats, name)).size,
      0
    )

    store.listThreadSummaries()
    const readsAfterFirst = store.threadRecordReads
    store.listThreadSummaries()

    // A record cache budgeted in source bytes could not hold this corpus at
    // all. Summaries are ~5% of it, so the same budget covers everything.
    expect(sourceBytes).toBeGreaterThan(64 * 1024)
    expect(readsAfterFirst).toBe(3)
    expect(store.threadRecordReads).toBe(3)
    expect(store.cachedThreadSummaryBytes).toBeLessThan(64 * 1024)
  })

  it('stays correct and bounded when even the summaries do not fit', () => {
    const profile = mkdtempSync(join(tmpdir(), 'host-profile-domain-budget-'))
    profiles.push(profile)
    let sequence = 0
    const store = new HostProfileDomainStore({
      profilePath: profile,
      authority: { assertProfileAuthority: vi.fn() },
      now: () => 100,
      idFactory: () => `id-${++sequence}`,
      threadCacheMaxBytes: 1
    })
    const titles = ['one', 'two', 'three']
    for (const title of titles) store.createThread({ scope: 'global', title })

    const first = store.listThreadSummaries()
    const second = store.listThreadSummaries()

    // A budget too small to hold anything must degrade to today's behaviour,
    // never to a wrong answer.
    expect(second).toEqual(first)
    expect(second.map((item) => item.title).sort()).toEqual([...titles].sort())
    expect(store.cachedThreadSummaryBytes).toBe(0)
    expect(store.threadRecordReads).toBe(6)
  })

  it('does not let a full cache thrash on the sweep that fills it', () => {
    const profile = mkdtempSync(join(tmpdir(), 'host-profile-domain-thrash-'))
    profiles.push(profile)
    let sequence = 0
    const openStore = (threadCacheMaxBytes: number) =>
      new HostProfileDomainStore({
        profilePath: profile,
        authority: { assertProfileAuthority: vi.fn() },
        now: () => 100,
        idFactory: () => `id-${++sequence}`,
        threadCacheMaxBytes
      })
    // Equal-length titles so every summary is the same size and the budget
    // below holds an exact number of them.
    const seed = openStore(64 * 1024)
    for (const title of ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff']) {
      seed.createThread({ scope: 'global', title })
    }
    seed.listThreadSummaries()
    const summaryBytes = seed.cachedThreadSummaryBytes
    expect(summaryBytes % 6).toBe(0)
    // Room for exactly half the corpus, so admission has to evict on the very
    // sweep that fills it — the case an access-ordered policy gets wrong.
    const store = openStore((summaryBytes / 6) * 3)

    store.listThreadSummaries()
    const firstPassReads = store.threadRecordReads
    store.listThreadSummaries()
    const secondPassReads = store.threadRecordReads - firstPassReads
    store.listThreadSummaries()
    const thirdPassReads = store.threadRecordReads - firstPassReads - secondPassReads

    expect(firstPassReads).toBe(6)
    // Least-recently-USED eviction would evict each entry immediately before
    // its next use and re-read all six every pass, forever. Write-ordered
    // eviction converges: the three newest stay resident and stay resident.
    expect(secondPassReads).toBe(3)
    expect(thirdPassReads).toBe(3)
  })

  it('still hands whole records to listThreads for callers that need them', () => {
    const { store } = open()
    const thread = store.createThread({ scope: 'global', title: 'full' })
    store.appendTranscript({ threadId: thread.appChatId, role: 'user', content: 'body' })

    const [record] = store.listThreads()

    expect(record!.messages.map((message) => message.content)).toEqual(['body'])
  })
})
