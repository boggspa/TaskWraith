import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { createEmptyHostSnapshot, decodeHostSnapshot } from '../shared/hostProtocol'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import { projectHostProfileDomainSnapshot } from './HostProfileDomainProjection'

const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('projects profile workspaces/threads/providers with honest empty unsupported families', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-projection-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-projection-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-1'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Thread'
  })
  store.configureThread({ threadId: thread.appChatId, providerId: 'codex', modelId: 'gpt-5.6' })
  const chatFile = join(profile, 'chats', `${thread.appChatId}.json`)
  const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
  raw.runs = [
    { runId: 'run-success', status: 'succeeded' },
    { runId: 'run-cancel', status: 'canceled' },
    { runId: 'run-active', status: 'queued' },
    { runId: 'run-unknown' }
  ]
  writeFileSync(chatFile, JSON.stringify(raw))
  chmodSync(chatFile, 0o600)
  const donor = projectHostProfileDomainSnapshot({
    store,
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    providers: [
      {
        providerId: 'codex',
        displayProvider: 'Codex',
        shortCode: 'codex',
        available: true
      }
    ]
  })
  expect(donor).toMatchObject({
    workspaces: [{ id: registered.id, name: 'Workspace' }],
    threads: [{ id: thread.appChatId, providerId: 'codex', chatKind: 'single' }],
    runs: [
      { runId: 'run-success', providerOutcome: 'completed' },
      { runId: 'run-cancel', providerOutcome: 'cancelled' },
      { runId: 'run-active', providerOutcome: 'running' },
      { runId: 'run-unknown', providerOutcome: 'unknown' }
    ],
    providers: [{ providerId: 'codex', available: true }],
    missions: [],
    rounds: [],
    participants: [],
    questions: [],
    approvals: [],
    schedules: [],
    artifacts: []
  })
  expect('position' in donor).toBe(false)
})

it('projects an ensemble thread kind and its persisted seat roster without synthesizing solos', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-ensemble-projection-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-ensemble-workspace-'))
  paths.push(profile, workspace)
  let id = 0
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => `projection-id-${++id}`
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const ensembleThread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Ensemble'
  })
  store.configureThread({ threadId: ensembleThread.appChatId, providerId: 'claude' })
  const current = store.getThread(ensembleThread.appChatId)!
  store.persistThreadRecord({
    threadId: current.appChatId,
    expectedRevision: current.persistenceRevision ?? 0,
    record: {
      ...current,
      chatKind: 'ensemble',
      ensemble: {
        activeRound: { activeParticipantId: 'seat-captain', status: 'running' },
        participants: [
          {
            id: 'seat-captain',
            provider: 'claude',
            role: 'Captain',
            model: 'claude-opus-5',
            reasoningEffort: 'high',
            thinkingEnabled: false,
            permissionPresetId: 'full_access',
            stageRole: 'worker',
            order: 0,
            enabled: true,
            status: 'running',
            active: false,
            instructions: ''
          },
          {
            id: 'seat-review',
            provider: 'grok',
            role: 'Reviewer',
            modelId: 'grok-4.6',
            reasoningEffort: 'max',
            permissionPresetId: 'read_only',
            stage: 'reviewer',
            order: 1,
            enabled: false,
            instructions: ''
          }
        ]
      }
    }
  })
  const soloThread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Solo'
  })
  store.configureThread({ threadId: soloThread.appChatId, providerId: 'codex' })

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    providers: []
  })

  expect(donor.threads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: ensembleThread.appChatId, chatKind: 'ensemble' }),
      expect.objectContaining({ id: soloThread.appChatId, chatKind: 'single' })
    ])
  )
  expect(donor.participants).toEqual([
    {
      id: 'seat-captain',
      threadId: ensembleThread.appChatId,
      providerId: 'claude',
      role: 'Captain',
      modelId: 'claude-opus-5',
      reasoningEffort: 'high',
      thinkingEnabled: false,
      permissionPresetId: 'full_access',
      stage: 'worker',
      order: 0,
      enabled: true,
      status: 'running',
      active: true
    },
    {
      id: 'seat-review',
      threadId: ensembleThread.appChatId,
      providerId: 'grok',
      role: 'Reviewer',
      modelId: 'grok-4.6',
      reasoningEffort: 'max',
      permissionPresetId: 'read_only',
      stage: 'reviewer',
      order: 1,
      enabled: false,
      active: false
    }
  ])
  expect(
    donor.participants.some((participant) => participant.threadId === soloThread.appChatId)
  ).toBe(false)
})

it('omits decoder-invalid seats so one malformed row cannot poison the snapshot', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-hostile-projection-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-hostile-workspace-'))
  paths.push(profile, workspace)
  let id = 0
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => `hostile-id-${++id}`
  })
  const registered = store.registerWorkspace({ path: workspace })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Hostile roster'
  })
  store.configureThread({ threadId: thread.appChatId, providerId: 'claude' })
  const current = store.getThread(thread.appChatId)!
  const base = {
    provider: 'claude',
    role: 'Seat',
    order: 0,
    enabled: true,
    instructions: ''
  }
  store.persistThreadRecord({
    threadId: current.appChatId,
    expectedRevision: current.persistenceRevision ?? 0,
    record: {
      ...current,
      chatKind: 'ensemble',
      ensemble: {
        participants: [
          { ...base, id: 'valid-seat' },
          { ...base, id: 'p'.repeat(490), order: 1 },
          { ...base, id: 'o'.repeat(513), order: 2 },
          { ...base, id: 'bad-stage', stage: 'generalissimo', order: 3 },
          { ...base, id: 'bad-status', status: 's'.repeat(201), order: 4 },
          { ...base, id: 'bad-enabled', enabled: 'yes', order: 5 },
          { ...base, id: 'bad\u0001control', order: 6 }
        ]
      }
    }
  })

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    providers: []
  })
  const decoded = decodeHostSnapshot({
    ...createEmptyHostSnapshot({ generation: 0, cursor: 0 }),
    ...donor
  })
  expect(decoded.ok).toBe(true)
  expect(donor.participants.map((participant) => participant.id)).toEqual(['valid-seat'])
  expect(donor.warnings).toEqual([
    expect.objectContaining({
      warningId: 'projection_rows_omitted:participants',
      severity: 'warning',
      code: 'projection_rows_omitted',
      message: 'family participants omitted 6 decoder-invalid rows'
    })
  ])
  if (decoded.ok) {
    expect(decoded.value.participants.map((participant) => participant.id)).toEqual(['valid-seat'])
    expect(decoded.value.threads).toEqual([
      expect.objectContaining({ id: thread.appChatId, chatKind: 'ensemble' })
    ])
  }
})
