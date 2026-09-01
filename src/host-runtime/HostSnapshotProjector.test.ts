import { describe, expect, it } from 'vitest'
import {
  assertHostSnapshotFamilies,
  decodeHostSnapshot,
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_MAX_ID,
  HOST_PROTOCOL_MAX_GOAL_OBJECTIVE,
  HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW,
  HOST_PROTOCOL_MAX_WARNING,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostWorkspaceProjection
} from '../shared/hostProtocol'
import {
  boundHostPresentationText,
  inspectHostSnapshotPrivacy,
  projectHostSnapshot,
  type HostSnapshotProjectorInput
} from './HostSnapshotProjector'

const GENERATED_AT = '2026-08-03T21:00:00.000Z'
const GENERATED_AT_MS = Date.parse(GENERATED_AT)

function baseInput(
  overrides: Partial<HostSnapshotProjectorInput> = {}
): HostSnapshotProjectorInput {
  return {
    position: {
      generation: 7,
      cursor: 42,
      freshness: 'live',
      generatedAt: GENERATED_AT
    },
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [
      {
        id: 'ws-1',
        name: 'AGBench',
        path: '/Users/chrisizatt/Documents/AGBench',
        pinned: true,
        updatedAt: 1
      }
    ],
    threads: [
      {
        id: 'thread-1',
        workspaceId: 'ws-1',
        title: 'Host Arc',
        chatKind: 'ensemble',
        archived: false,
        pinned: true,
        updatedAt: 2,
        messageCount: 3,
        latestPreview: 'hello host',
        providerId: 'codex',
        missionOutcome: 'active',
        activeRoundId: 'round-1'
      }
    ],
    runs: [
      {
        runId: 'run-1',
        threadId: 'thread-1',
        providerId: 'codex',
        providerOutcome: 'completed',
        modelId: 'gpt-5.6',
        startedAt: 10,
        endedAt: 20,
        usage: { availability: 'available', tokens: 12, confidence: 'exact' }
      }
    ],
    missions: [
      {
        missionId: 'mission-1',
        threadId: 'thread-1',
        title: 'Host Arc',
        status: 'active',
        goalId: 'goal-1',
        updatedAt: 3,
        activeRoundId: 'round-1'
      }
    ],
    rounds: [
      {
        roundId: 'round-1',
        threadId: 'thread-1',
        status: 'cancelled',
        startedAt: 10,
        endedAt: 30,
        participantIds: ['p1'],
        providerRunIds: ['run-1'],
        routing: {
          mode: 'continuous',
          fanout: 'parallel',
          activeParticipantId: 'p1',
          bossParticipantId: 'p1',
          captainParticipantId: 'p12'
        },
        waves: [
          {
            waveId: 'wave-1',
            label: 'scout',
            status: 'done',
            participantIds: ['p1']
          }
        ]
      }
    ],
    participants: [
      {
        id: 'p1',
        threadId: 'thread-1',
        providerId: 'codex',
        role: 'Boss',
        modelId: 'gpt-5.6',
        reasoningEffort: 'xhigh',
        thinkingEnabled: false,
        permissionPresetId: 'full_access',
        stage: 'any',
        order: 1,
        enabled: true,
        active: true,
        status: 'idle'
      }
    ],
    providers: [
      {
        providerId: 'codex',
        displayProvider: 'Codex',
        modelId: 'gpt-5.6',
        modelLabel: 'GPT 5.6 Sol',
        shortCode: 'cdx',
        available: true,
        note: 'live'
      }
    ],
    routing: {
      mode: 'continuous',
      fanout: 'parallel',
      activeParticipantId: 'p1',
      continuationHops: 2,
      maxContinuationHops: 6,
      bossParticipantId: 'p1',
      captainParticipantId: 'p12'
    },
    questions: [
      {
        questionId: 'q-1',
        threadId: 'thread-1',
        status: 'open',
        promptPreview: 'Continue?',
        askedAt: 40
      }
    ],
    approvals: [
      {
        approvalId: 'appr-1',
        commandId: 'cmd-appr-1',
        threadId: 'thread-1',
        status: 'pending',
        actionKind: 'shellCommands',
        createdAt: 50,
        summary: 'npm test'
      }
    ],
    schedules: [
      {
        scheduleId: 'sched-1',
        title: 'Daily scan',
        enabled: true,
        nextFireAt: 60,
        threadId: 'thread-1'
      }
    ],
    channels: [
      {
        channelId: 'channel-1',
        threadId: 'thread-1',
        ownerMemberId: 'owner-1',
        title: 'Shared work',
        status: 'active',
        availability: 'ready',
        membershipRevision: 1,
        memberCount: 1,
        messageCount: 0,
        updatedAt: 65,
        members: [
          {
            memberId: 'owner-1',
            kind: 'human',
            displayName: 'Owner',
            status: 'active'
          }
        ]
      }
    ],
    usage: {
      availability: 'unavailable',
      confidence: 'unknown',
      band: 'unknown'
    },
    artifacts: [
      {
        artifactId: 'art-1',
        kind: 'export',
        threadId: 'thread-1',
        title: 'bundle',
        createdAt: 70,
        byteLength: 128,
        sha256: 'a'.repeat(64)
      }
    ],
    warnings: [
      {
        warningId: 'warn-1',
        severity: 'info',
        code: 'note',
        message: 'all good',
        at: 80,
        threadId: 'thread-1'
      }
    ],
    recovery: {
      reopenStatus: 'clean',
      lastGeneration: 7,
      lastCursor: 42,
      lastCheckpointAt: 90,
      detail: 'ok'
    },
    ...overrides
  }
}

describe('HostSnapshotProjector', () => {
  it('projects every required family into a structural HostSnapshot', () => {
    const result = projectHostSnapshot(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const snapshot = result.value
    expect(assertHostSnapshotFamilies(snapshot)).toEqual({ ok: true, value: true })
    expect(snapshot.protocolVersion).toBe(HOST_PROTOCOL_VERSION)
    expect(snapshot.projectionVersion).toBe(HOST_PROJECTION_VERSION)
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.threads).toHaveLength(1)
    expect(snapshot.runs).toHaveLength(1)
    expect(snapshot.missions).toHaveLength(1)
    expect(snapshot.rounds).toHaveLength(1)
    expect(snapshot.participants).toHaveLength(1)
    expect(snapshot.participants[0]).toMatchObject({
      reasoningEffort: 'xhigh',
      thinkingEnabled: false,
      permissionPresetId: 'full_access'
    })
    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.questions).toHaveLength(1)
    expect(snapshot.approvals).toHaveLength(1)
    expect(snapshot.schedules).toHaveLength(1)
    expect(snapshot.channels).toHaveLength(1)
    expect(snapshot.artifacts).toHaveLength(1)
    expect(snapshot.warnings).toHaveLength(1)
    expect(snapshot.routing?.mode).toBe('continuous')
    expect(snapshot.health.hostStatus).toBe('ok')
    expect(snapshot.recovery.reopenStatus).toBe('clean')
  })

  it('preserves injected generation/cursor/freshness exactly', () => {
    const result = projectHostSnapshot(
      baseInput({
        position: {
          generation: 99,
          cursor: 1234,
          freshness: 'cached',
          generatedAt: GENERATED_AT
        },
        health: {
          hostStatus: 'degraded',
          connectionPhase: 'reconnecting',
          supervised: false,
          freshness: 'cached'
        }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.generation).toBe(99)
    expect(result.value.cursor).toBe(1234)
    expect(result.value.freshness).toBe('cached')
    expect(result.value.generatedAt).toBe(GENERATED_AT)
    expect(result.value.health.freshness).toBe('cached')
    expect(result.value.health.connectionPhase).toBe('reconnecting')
  })

  it('keeps provider / round / mission / connection outcomes distinct', () => {
    const result = projectHostSnapshot(baseInput())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.runs[0]?.providerOutcome).toBe('completed')
    expect(result.value.rounds[0]?.status).toBe('cancelled')
    expect(result.value.missions[0]?.status).toBe('active')
    expect(result.value.health.connectionPhase).toBe('live')
  })

  it('omits tokens/cost for unavailable usage instead of publishing zero', () => {
    const result = projectHostSnapshot(
      baseInput({
        usage: {
          availability: 'unavailable',
          tokens: 0,
          costText: '$0.00',
          confidence: 'unknown',
          band: 'unknown'
        }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.usage.availability).toBe('unavailable')
    expect(result.value.usage.tokens).toBeUndefined()
    expect(result.value.usage.costText).toBeUndefined()
    expect(assertHostSnapshotFamilies(result.value).ok).toBe(true)
  })

  it('preserves available usage tokens when present', () => {
    const result = projectHostSnapshot(
      baseInput({
        usage: {
          availability: 'available',
          tokens: 9001,
          costText: '$0.12',
          confidence: 'exact',
          band: 'low'
        }
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.usage).toEqual({
      availability: 'available',
      tokens: 9001,
      costText: '$0.12',
      confidence: 'exact',
      band: 'low'
    })
  })

  it('sorts collections deterministically and caps at HOST_PROTOCOL_MAX_COLLECTION with warnings', () => {
    const workspaces: HostWorkspaceProjection[] = []
    for (let i = HOST_PROTOCOL_MAX_COLLECTION + 5; i >= 0; i -= 1) {
      workspaces.push({
        id: `ws-${String(i).padStart(4, '0')}`,
        name: `W${i}`,
        path: `/tmp/${i}`,
        pinned: false,
        updatedAt: i
      })
    }
    const result = projectHostSnapshot(baseInput({ workspaces }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.workspaces).toHaveLength(HOST_PROTOCOL_MAX_COLLECTION)
    expect(result.value.workspaces[0]?.id).toBe('ws-0000')
    expect(result.value.workspaces[1]?.id).toBe('ws-0001')
    expect(result.value.workspaces.at(-1)?.id).toBe(
      `ws-${String(HOST_PROTOCOL_MAX_COLLECTION - 1).padStart(4, '0')}`
    )

    const trunc = result.value.warnings.find((w) => w.code === 'projection_truncated')
    expect(trunc).toBeDefined()
    expect(trunc?.warningId).toBe('projection_truncated:workspaces')
    expect(trunc?.message).toContain('workspaces')
    expect(trunc?.message).toContain(String(HOST_PROTOCOL_MAX_COLLECTION))
    expect(trunc?.at).toBe(GENERATED_AT_MS)
  })

  it('bounds thread previews and sets previewTruncated', () => {
    const long = 'x'.repeat(HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW + 50)
    const result = projectHostSnapshot(
      baseInput({
        threads: [
          {
            id: 'thread-long',
            workspaceId: null,
            title: 'Long',
            chatKind: 'single',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 1,
            latestPreview: long
          }
        ]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const preview = result.value.threads[0]?.latestPreview ?? ''
    expect(preview.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_TRANSCRIPT_PREVIEW)
    expect(result.value.threads[0]?.previewTruncated).toBe(true)
    expect(assertHostSnapshotFamilies(result.value).ok).toBe(true)
  })

  it('carries the configured model, reasoning and permission tier onto the wire thread row', () => {
    // The domain projection publishes these display facts and the client
    // decoder accepts them; the wire projector between them must not drop
    // them, or every client falls back to the provider inventory's first
    // model and labels a thread with a model it never ran.
    const result = projectHostSnapshot(
      baseInput({
        threads: [
          {
            id: 'thread-configured',
            workspaceId: 'ws-1',
            title: 'Configured',
            chatKind: 'single',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 1,
            providerId: 'mistral',
            modelId: 'mistral-medium-3.5',
            reasoningEffort: 'xhigh',
            permissionPresetId: 'workspace_write'
          }
        ]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.threads[0]).toMatchObject({
      providerId: 'mistral',
      modelId: 'mistral-medium-3.5',
      reasoningEffort: 'xhigh',
      permissionPresetId: 'workspace_write'
    })
    const decoded = decodeHostSnapshot(result.value)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.value.threads[0]).toMatchObject({
      modelId: 'mistral-medium-3.5',
      reasoningEffort: 'xhigh',
      permissionPresetId: 'workspace_write'
    })
  })

  it('carries the thread goal through, bounding the objective and its criteria', () => {
    const long = 'g'.repeat(HOST_PROTOCOL_MAX_GOAL_OBJECTIVE + 50)
    const result = projectHostSnapshot(
      baseInput({
        threads: [
          {
            id: 'thread-goal',
            workspaceId: null,
            title: 'Goal',
            chatKind: 'single',
            archived: false,
            pinned: false,
            updatedAt: 1,
            messageCount: 1,
            goal: {
              id: 'goal-1',
              objective: long,
              status: 'active',
              mode: 'taskwraith_steered',
              acceptanceCriteria: ['Ship it.'],
              wallMs: 1_000,
              activeMs: 500
            }
          }
        ]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // This projector rebuilds every thread row field by field, so a family it
    // forgets to copy reaches no client however faithfully the donor sent it.
    const goal = result.value.threads[0]?.goal
    expect(goal?.id).toBe('goal-1')
    expect(goal?.objective.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_GOAL_OBJECTIVE)
    expect(goal?.objectiveTruncated).toBe(true)
    expect(goal?.acceptanceCriteria).toEqual(['Ship it.'])
    expect(goal?.wallMs).toBe(1_000)
    expect(assertHostSnapshotFamilies(result.value).ok).toBe(true)
  })

  it('rejects missing projection families instead of fabricating empty arrays', () => {
    const missingHealth = projectHostSnapshot(
      baseInput({ health: undefined as unknown as HostSnapshotProjectorInput['health'] })
    )
    expect(missingHealth).toMatchObject({
      ok: false,
      error: 'missing projection family: health'
    })

    const missingThreads = projectHostSnapshot(
      baseInput({ threads: undefined as unknown as HostSnapshotProjectorInput['threads'] })
    )
    expect(missingThreads).toMatchObject({
      ok: false,
      error: 'missing projection family: threads'
    })

    const missingUsage = projectHostSnapshot(
      baseInput({ usage: undefined as unknown as HostSnapshotProjectorInput['usage'] })
    )
    expect(missingUsage).toMatchObject({
      ok: false,
      error: 'missing projection family: usage'
    })

    const missingRecovery = projectHostSnapshot(
      baseInput({ recovery: undefined as unknown as HostSnapshotProjectorInput['recovery'] })
    )
    expect(missingRecovery).toMatchObject({
      ok: false,
      error: 'missing projection family: recovery'
    })
  })

  it.each([
    {
      family: 'workspaces',
      input: () =>
        baseInput({
          workspaces: [
            baseInput().workspaces[0]!,
            {
              ...baseInput().workspaces[0]!,
              id: ''
            }
          ]
        })
    },
    {
      family: 'threads',
      input: () =>
        baseInput({
          threads: [
            baseInput().threads[0]!,
            {
              ...baseInput().threads[0]!,
              workspaceId: ''
            }
          ]
        })
    },
    {
      family: 'runs',
      input: () =>
        baseInput({
          runs: [
            baseInput().runs[0]!,
            {
              ...baseInput().runs[0]!,
              runId: ''
            }
          ]
        })
    },
    {
      family: 'providers',
      input: () =>
        baseInput({
          providers: [
            baseInput().providers[0]!,
            {
              ...baseInput().providers[0]!,
              available: 'yes' as never
            }
          ]
        })
    },
    {
      family: 'participants',
      input: () =>
        baseInput({
          participants: [
            baseInput().participants[0]!,
            {
              ...baseInput().participants[0]!,
              threadId: 't'.repeat(300),
              id: 'p'.repeat(300)
            }
          ]
        })
    }
  ] as const)(
    'quarantines one decoder-invalid $family row without losing the snapshot',
    ({ family, input }) => {
      const result = projectHostSnapshot(input())
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.value[family]).toHaveLength(1)
      expect(result.value.questions).toHaveLength(1)
      expect(result.value.approvals).toHaveLength(1)
      expect(decodeHostSnapshot(result.value).ok).toBe(true)

      const warning = result.value.warnings.find(
        (candidate) => candidate.warningId === `projection_rows_omitted:${family}`
      )
      expect(warning).toMatchObject({
        severity: 'warning',
        code: 'projection_rows_omitted',
        at: GENERATED_AT_MS
      })
      expect(warning?.message).toContain(`family ${family}`)
      expect(warning?.message).toContain('omitted 1')
      expect(
        result.value.warnings.filter(
          (candidate) => candidate.warningId === `projection_rows_omitted:${family}`
        )
      ).toHaveLength(1)
    }
  )

  it('aggregates repeated row omissions into one bounded family warning', () => {
    const invalidRuns = Array.from({ length: 50 }, () => ({
      ...baseInput().runs[0]!,
      runId: ''
    }))
    const result = projectHostSnapshot(
      baseInput({
        runs: [baseInput().runs[0]!, ...invalidRuns]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const warnings = result.value.warnings.filter(
      (candidate) => candidate.warningId === 'projection_rows_omitted:runs'
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('omitted 50')
    expect(warnings[0]?.message.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_WARNING)
    expect(result.value.runs.map((run) => run.runId)).toEqual(['run-1'])
    expect(decodeHostSnapshot(result.value).ok).toBe(true)
  })

  it('never truncates an invalid identifier into a different identity', () => {
    const invalidId = 'r'.repeat(HOST_PROTOCOL_MAX_ID + 1)
    const result = projectHostSnapshot(
      baseInput({
        runs: [
          baseInput().runs[0]!,
          {
            ...baseInput().runs[0]!,
            runId: invalidId
          }
        ]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.runs.map((run) => run.runId)).toEqual(['run-1'])
    expect(result.value.runs.some((run) => run.runId.startsWith('r'.repeat(100)))).toBe(false)
    expect(result.value.warnings).toContainEqual(
      expect.objectContaining({
        warningId: 'projection_rows_omitted:runs',
        code: 'projection_rows_omitted'
      })
    )
  })

  it('rejects privacy key sentinels in donor payloads', () => {
    const withSecret = projectHostSnapshot(
      baseInput({
        health: {
          hostStatus: 'ok',
          connectionPhase: 'live',
          supervised: true,
          freshness: 'live',
          // smuggle via extra field on a plain object cast
          ...({ apiKey: 'sk-secret-should-never-project' } as object)
        } as HostSnapshotProjectorInput['health']
      })
    )
    expect(withSecret.ok).toBe(false)
    if (withSecret.ok) return
    expect(withSecret.error).toMatch(/privacy key sentinel/i)

    const withDiff = inspectHostSnapshotPrivacy({
      tool_output: 'cat secrets',
      nested: { password: 'hunter2' }
    })
    expect(withDiff.ok).toBe(false)
  })

  it('rejects privacy value sentinels in presentation fields', () => {
    const result = projectHostSnapshot(
      baseInput({
        approvals: [
          {
            approvalId: 'appr-bad',
            commandId: 'cmd-appr-bad',
            status: 'pending',
            actionKind: 'shellCommands',
            createdAt: 1,
            summary: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789'
          }
        ]
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/privacy value sentinel/i)
  })

  it('quarantines artifact body smuggling without projecting it', () => {
    const result = projectHostSnapshot(
      baseInput({
        artifacts: [
          baseInput().artifacts[0]!,
          {
            artifactId: 'art-bad',
            kind: 'blob',
            title: 'raw',
            createdAt: 1,
            ...({ bytes: Buffer.from('secret').toString('base64') } as object)
          } as HostSnapshotProjectorInput['artifacts'][number]
        ]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.artifacts.map((artifact) => artifact.artifactId)).toEqual(['art-1'])
    expect(result.value.warnings).toContainEqual(
      expect.objectContaining({
        warningId: 'projection_rows_omitted:artifacts',
        code: 'projection_rows_omitted'
      })
    )
    expect(decodeHostSnapshot(result.value).ok).toBe(true)
  })

  it('rejects invalid position freshness/generation', () => {
    expect(
      projectHostSnapshot(
        baseInput({
          position: {
            generation: -1,
            cursor: 0,
            freshness: 'live',
            generatedAt: GENERATED_AT
          }
        })
      )
    ).toMatchObject({ ok: false, error: 'position.generation/cursor invalid' })

    expect(
      projectHostSnapshot(
        baseInput({
          position: {
            generation: 1,
            cursor: 0,
            freshness: 'not-a-freshness' as 'live',
            generatedAt: GENERATED_AT
          }
        })
      )
    ).toMatchObject({ ok: false, error: 'position.freshness is invalid' })
  })

  it('exports presentation truncation helper with truncated indicator', () => {
    const short = boundHostPresentationText('ok', 10)
    expect(short).toEqual({ text: 'ok', truncated: false })
    const long = boundHostPresentationText('abcdefghij', 5)
    expect(long.truncated).toBe(true)
    expect(long.text.endsWith('…')).toBe(true)
    expect(long.text.length).toBe(5)
  })

  it('does not invent routing when omitted', () => {
    const input = baseInput()
    delete input.routing
    const result = projectHostSnapshot(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.routing).toBeUndefined()
  })

  it('passes assertHostSnapshotFamilies structural validation on projected empty families', () => {
    const result = projectHostSnapshot(
      baseInput({
        workspaces: [],
        threads: [],
        runs: [],
        missions: [],
        rounds: [],
        participants: [],
        providers: [],
        questions: [],
        approvals: [],
        schedules: [],
        artifacts: [],
        warnings: [],
        routing: undefined
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Empty arrays are valid when the family is present — missing is the error case.
    expect(assertHostSnapshotFamilies(result.value)).toEqual({ ok: true, value: true })
    expect(result.value.workspaces).toEqual([])
    expect(result.value.threads).toEqual([])
  })
})
