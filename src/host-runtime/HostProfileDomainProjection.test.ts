import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import {
  createEmptyHostSnapshot,
  decodeHostSnapshot,
  HOST_PROTOCOL_MAX_COLLECTION
} from '../shared/hostProtocol'
import { HostProfileDomainStore } from './HostProfileDomainStore'
import {
  HOST_PROFILE_RUN_PROJECTION_LIMIT,
  projectHostProfileDomainSnapshot
} from './HostProfileDomainProjection'

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
  store.configureThread({
    threadId: thread.appChatId,
    providerId: 'codex',
    modelId: 'gpt-5.6',
    reasoningId: 'high',
    postureId: 'default'
  })
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
    threads: [
      {
        id: thread.appChatId,
        providerId: 'codex',
        modelId: 'gpt-5.6',
        reasoningEffort: 'high',
        permissionPresetId: 'default',
        chatKind: 'single'
      }
    ],
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

it('projects the latest run usage as an honest estimated thread meter', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-usage-projection-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-usage-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-usage'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Usage'
  })
  store.updateRun({
    threadId: thread.appChatId,
    runId: 'run-usage',
    status: 'running',
    provider: 'kimi',
    requestedModel: 'kimi-k3',
    phase: 'starting',
    startedAt: '2026-08-24T05:00:00.000Z'
  })
  store.updateRun({
    threadId: thread.appChatId,
    runId: 'run-usage',
    status: 'completed',
    provider: 'kimi',
    requestedModel: 'kimi-k3',
    startedAt: '2026-08-24T05:00:00.000Z',
    endedAt: '2026-08-24T05:01:00.000Z',
    usage: { inputTokens: 200_000, outputTokens: 20_000 }
  })

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    providers: []
  })
  expect(donor.threads).toEqual([
    expect.objectContaining({
      id: thread.appChatId,
      usage: { availability: 'estimated', tokens: 220_000, confidence: 'estimated' }
    })
  ])
  expect(donor.runs).toEqual([
    expect.objectContaining({
      runId: 'run-usage',
      usage: { availability: 'estimated', tokens: 220_000, confidence: 'estimated' }
    })
  ])
})

it('windows oversized run history by active-first recency without emitting a fatal truncation', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-run-window-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-run-window-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-run-window'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Run window'
  })
  const chatFile = join(profile, 'chats', `${thread.appChatId}.json`)
  const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
  const terminalRuns = Array.from({ length: HOST_PROTOCOL_MAX_COLLECTION + 10 }, (_, index) => ({
    runId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    status: index === 0 ? 'Cancelled' : 'success',
    startedAt: new Date(index * 1_000).toISOString(),
    endedAt: new Date(index * 1_000 + 500).toISOString()
  }))
  expect(terminalRuns.length).toBeGreaterThan(HOST_PROTOCOL_MAX_COLLECTION)
  raw.runs = [
    ...terminalRuns,
    {
      runId: 'ffffffff-ffff-4fff-8fff-fffffffffff0',
      status: 'sleeping',
      startedAt: new Date(1).toISOString()
    },
    {
      runId: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
      startedAt: new Date(2).toISOString()
    },
    {
      runId: 'ffffffff-ffff-4fff-8fff-fffffffffff2',
      status: 'unknown-legacy',
      endedAt: new Date(3).toISOString()
    }
  ]
  writeFileSync(chatFile, JSON.stringify(raw))
  chmodSync(chatFile, 0o600)

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    providers: []
  })

  expect(donor.runs).toHaveLength(HOST_PROFILE_RUN_PROJECTION_LIMIT)
  expect(donor.runs.map((run) => run.runId)).toEqual(
    expect.arrayContaining([
      'ffffffff-ffff-4fff-8fff-fffffffffff0',
      'ffffffff-ffff-4fff-8fff-fffffffffff1'
    ])
  )
  expect(donor.runs.map((run) => run.runId)).not.toContain(terminalRuns[0].runId)
  expect(donor.runs.find((run) => run.runId === terminalRuns.at(-1)?.runId)?.providerOutcome).toBe(
    'completed'
  )
  expect(donor.warnings).toContainEqual(
    expect.objectContaining({
      warningId: 'projection_windowed:runs',
      code: 'projection_windowed'
    })
  )
  const decoded = decodeHostSnapshot({
    ...createEmptyHostSnapshot({ generation: 1, cursor: 0 }),
    ...donor
  })
  expect(decoded.ok).toBe(true)
  if (decoded.ok) {
    expect(decoded.value.warnings.some((warning) => warning.code === 'projection_truncated')).toBe(
      false
    )
  }
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

it('projects the App-authored goal, bounding the objective and flagging the clip', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-goal-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-goal-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-goal'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Thread'
  })
  const chatFile = join(profile, 'chats', `${thread.appChatId}.json`)
  const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
  // The App writes the goal onto this record; the Host only ever reads it.
  raw.activeGoal = {
    id: 'goal-1',
    objective: 'o'.repeat(2_500),
    status: 'blocked',
    mode: 'taskwraith_steered',
    blockedReason: 'waiting on review',
    specification: { kind: 'prompt', acceptanceCriteria: ['Ship it.', ''] },
    runtimeLedger: {
      startedAt: '2026-08-29T10:00:00.000Z',
      endedAt: '2026-08-29T11:00:00.000Z',
      intervals: [
        {
          status: 'active',
          startedAt: '2026-08-29T10:00:00.000Z',
          endedAt: '2026-08-29T10:30:00.000Z'
        }
      ]
    }
  }
  writeFileSync(chatFile, JSON.stringify(raw))
  chmodSync(chatFile, 0o600)

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    providers: []
  })
  const goal = donor.threads[0]?.goal
  expect(goal?.id).toBe('goal-1')
  expect(goal?.status).toBe('blocked')
  expect(goal?.blockedReason).toBe('waiting on review')
  // Bounded: the thread list ships in every snapshot, so an unbounded
  // objective would put kilobytes per thread on the wire.
  expect(goal?.objective).toHaveLength(2_000)
  expect(goal?.objectiveTruncated).toBe(true)
  expect(goal?.acceptanceCriteria).toEqual(['Ship it.'])
  expect(goal?.wallMs).toBe(60 * 60 * 1000)
  expect(goal?.activeMs).toBe(30 * 60 * 1000)

  // The projection must survive the wire decoder, not merely the projector.
  const decoded = decodeHostSnapshot({
    ...createEmptyHostSnapshot({
      generation: 1,
      cursor: 1,
      freshness: 'live',
      generatedAt: new Date(0).toISOString()
    }),
    ...donor
  })
  expect(decoded.ok).toBe(true)
  if (decoded.ok) expect(decoded.value.threads[0]?.goal?.id).toBe('goal-1')
})

it('stops an open goal interval at the thread last activity', () => {
  // Nothing closes a goal interval but an explicit pause / block / complete, so
  // a goal left `active` on an abandoned thread counted forever. Measured on a
  // live profile: four such goals, one reading 18.8 days of "active" time on a
  // thread idle for 17.7 days, and one reading 12.8 days on a thread that had
  // never had a single run.
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-goal-zombie-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-goal-zombie-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-zombie-goal'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Thread'
  })
  const chatFile = join(profile, 'chats', `${thread.appChatId}.json`)
  const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
  raw.updatedAt = Date.parse('2026-08-11T10:30:00.000Z')
  raw.activeGoal = {
    id: 'goal-zombie',
    objective: 'Keep going',
    status: 'active',
    mode: 'taskwraith_steered',
    runtimeLedger: {
      startedAt: '2026-08-11T10:00:00.000Z',
      intervals: [{ status: 'active', startedAt: '2026-08-11T10:00:00.000Z' }]
    }
  }
  writeFileSync(chatFile, JSON.stringify(raw))
  chmodSync(chatFile, 0o600)

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    providers: []
  })
  const goal = donor.threads[0]?.goal
  expect(goal?.status).toBe('active')
  expect(goal?.wallMs).toBe(30 * 60 * 1000)
  expect(goal?.activeMs).toBe(30 * 60 * 1000)
})

it('omits a goal the decoder would reject rather than poisoning the thread row', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-goal-bad-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-goal-bad-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-bad-goal'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Thread'
  })
  const chatFile = join(profile, 'chats', `${thread.appChatId}.json`)
  const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
  raw.activeGoal = { id: 'goal-1', objective: 'x', status: 'nonsense', mode: 'taskwraith_steered' }
  writeFileSync(chatFile, JSON.stringify(raw))
  chmodSync(chatFile, 0o600)

  const donor = projectHostProfileDomainSnapshot({
    store,
    health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
    providers: []
  })
  expect(donor.threads).toHaveLength(1)
  expect(donor.threads[0]?.goal).toBeUndefined()
})
