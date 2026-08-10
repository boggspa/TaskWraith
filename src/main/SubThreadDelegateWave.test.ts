import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_WAVE_AGENTS,
  DELEGATE_WAVE_EPHEMERAL_MIN_WORKERS,
  DELEGATE_WAVE_MAX_WORKERS,
  DELEGATE_WAVE_MIN_WORKERS,
  buildDelegateWaveApprovalCopy,
  clampMaxWaveAgents,
  createDelegateWaveId,
  executeDelegateWaveTool,
  isDelegateWaveBossOrCaptain,
  parseDelegateWaveArgs,
  reserveDelegateWaveBudgetSlots,
  resolveDelegateWaveJoinPolicy,
  shapeDelegateWaveResult,
  shouldSkipDelegateWaveApproval,
  stripParentWaveDelegationCard
} from './SubThreadDelegateWave'
import { MAX_SUBTHREAD_JOIN_QUORUM } from './SubThreadJoinPolicy'

const nowMs = Date.parse('2026-08-08T01:00:00.000Z')
const parentChatId = 'parent-chat-1'
const parentAppRunId = 'parent-run-abc'

const allowed = new Set(['codex', 'claude', 'kimi', 'cursor', 'grok', 'pi', 'mistral'])

function isAllowedProvider(provider: string): boolean {
  return allowed.has(provider)
}

function twoWorkers(overrides: Record<string, unknown> = {}) {
  return {
    workers: [
      { provider: 'codex', prompt: 'Scout A' },
      { provider: 'claude', prompt: 'Scout B' }
    ],
    ...overrides
  }
}

describe('SubThreadDelegateWave pure helpers', () => {
  it('decouples wave max from join quorum while both sit at 64', () => {
    expect(DELEGATE_WAVE_MIN_WORKERS).toBe(2)
    expect(DELEGATE_WAVE_EPHEMERAL_MIN_WORKERS).toBe(1)
    expect(DELEGATE_WAVE_MAX_WORKERS).toBe(64)
    expect(MAX_SUBTHREAD_JOIN_QUORUM).toBe(64)
  })

  it('rejects fewer than two durable workers before any join is resolved', () => {
    const result = parseDelegateWaveArgs(
      { workers: [{ provider: 'codex', prompt: 'alone' }] },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider, parentProvider: 'codex' }
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/durable workers must contain at least 2/)
  })

  it('allows a singleton ephemeral worker and inherits omitted provider', () => {
    const result = parseDelegateWaveArgs(
      { lifecycle: 'ephemeral', workers: [{ prompt: 'alone scout', role: 'scout' }] },
      {
        parentChatId,
        parentAppRunId,
        nowMs,
        isAllowedProvider,
        parentProvider: 'codex',
        createWaveId: () => 'wave-solo'
      }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lifecycle).toBe('ephemeral')
    expect(result.value.workers).toEqual([
      { provider: 'codex', prompt: 'alone scout', role: 'scout' }
    ])
  })

  it('rejects mixed providers unless allowMultiProvider is true', () => {
    const mixed = parseDelegateWaveArgs(twoWorkers(), {
      parentChatId,
      parentAppRunId,
      nowMs,
      isAllowedProvider,
      parentProvider: 'codex',
      createWaveId: () => 'wave-mixed'
    })
    expect(mixed.ok).toBe(false)
    if (mixed.ok) return
    expect(mixed.message).toMatch(/allowMultiProvider=true/)

    const allowedMixed = parseDelegateWaveArgs(twoWorkers({ allowMultiProvider: true }), {
      parentChatId,
      parentAppRunId,
      nowMs,
      isAllowedProvider,
      parentProvider: 'codex',
      createWaveId: () => 'wave-mixed-ok'
    })
    expect(allowedMixed.ok).toBe(true)
  })

  it('rejects more than DELEGATE_WAVE_MAX_WORKERS workers', () => {
    const workers = Array.from({ length: DELEGATE_WAVE_MAX_WORKERS + 1 }, (_, i) => ({
      provider: 'codex',
      prompt: `w${i}`
    }))
    const result = parseDelegateWaveArgs(
      { workers },
      {
        parentChatId,
        parentAppRunId,
        nowMs,
        isAllowedProvider,
        parentProvider: 'codex',
        maxWorkers: DELEGATE_WAVE_MAX_WORKERS
      }
    )
    expect(result.ok).toBe(false)
  })

  it('clamps maxWaveAgents to 2–64 with default 8', () => {
    expect(clampMaxWaveAgents(undefined)).toBe(DEFAULT_MAX_WAVE_AGENTS)
    expect(clampMaxWaveAgents(8)).toBe(8)
    expect(clampMaxWaveAgents(20)).toBe(20)
    expect(clampMaxWaveAgents(64)).toBe(DELEGATE_WAVE_MAX_WORKERS)
    expect(clampMaxWaveAgents(99)).toBe(DELEGATE_WAVE_MAX_WORKERS)
    expect(clampMaxWaveAgents(null)).toBe(8)
    expect(clampMaxWaveAgents('nope')).toBe(8)
    expect(clampMaxWaveAgents(1)).toBe(2)
    expect(clampMaxWaveAgents(8.9)).toBe(8)
  })

  it('honours maxWorkers from settings when parsing a wave', () => {
    const workers = Array.from({ length: 9 }, (_, i) => ({
      provider: 'codex',
      prompt: `w${i}`
    }))
    const overSetting = parseDelegateWaveArgs(
      { workers },
      {
        parentChatId,
        parentAppRunId,
        nowMs,
        isAllowedProvider,
        parentProvider: 'codex',
        maxWorkers: 8
      }
    )
    expect(overSetting.ok).toBe(false)
    if (!overSetting.ok) expect(overSetting.message).toMatch(/at most 8/i)

    const ok = parseDelegateWaveArgs(
      { workers: workers.slice(0, 8) },
      {
        parentChatId,
        parentAppRunId,
        nowMs,
        isAllowedProvider,
        parentProvider: 'codex',
        maxWorkers: 8
      }
    )
    expect(ok.ok).toBe(true)
  })

  it('defaults maxWorkers to 8 when omitted — 9 workers fail, 8 succeed', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      provider: 'codex',
      prompt: `w${i}`
    }))
    const overDefault = parseDelegateWaveArgs(
      { workers: nine },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider, parentProvider: 'codex' }
    )
    expect(overDefault.ok).toBe(false)
    if (!overDefault.ok) expect(overDefault.message).toMatch(/at most 8/i)

    const atDefault = parseDelegateWaveArgs(
      { workers: nine.slice(0, 8) },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider, parentProvider: 'codex' }
    )
    expect(atDefault.ok).toBe(true)
  })

  it('allows 12 workers when maxWorkers is 12', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      provider: 'codex',
      prompt: `w${i}`
    }))
    const ok = parseDelegateWaveArgs(
      { workers: twelve },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider, maxWorkers: 12 }
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.workers).toHaveLength(12)

    const thirteen = [...twelve, { provider: 'codex', prompt: 'w12' }]
    const over = parseDelegateWaveArgs(
      { workers: thirteen },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider, maxWorkers: 12 }
    )
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.message).toMatch(/at most 12/i)
  })

  it('falls back to maxWorkers 8 when the option is missing or non-finite', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({
      provider: 'codex',
      prompt: `w${i}`
    }))
    const base = { parentChatId, parentAppRunId, nowMs, isAllowedProvider }

    // Omitted maxWorkers → DEFAULT_MAX_WAVE_AGENTS (8).
    const omitted = parseDelegateWaveArgs({ workers: nine }, base)
    expect(omitted.ok).toBe(false)
    if (!omitted.ok) expect(omitted.message).toMatch(/at most 8/i)

    // Non-finite / non-number values clamp to DEFAULT_MAX_WAVE_AGENTS (8).
    for (const maxWorkers of [null, 'nope', NaN, Infinity] as const) {
      const result = parseDelegateWaveArgs(
        { workers: nine },
        { ...base, maxWorkers: maxWorkers as unknown as number }
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toMatch(/at most 8/i)
    }

    // Finite but below the floor clamps to 2 (not the default 8).
    const belowFloor = parseDelegateWaveArgs({ workers: nine }, { ...base, maxWorkers: -1 })
    expect(belowFloor.ok).toBe(false)
    if (!belowFloor.ok) expect(belowFloor.message).toMatch(/at most 2/i)
  })

  it('skips delegate_wave approval for Boss + default (Accept Edits)', () => {
    expect(
      shouldSkipDelegateWaveApproval({ isBossOrCaptain: true, permissionPresetId: 'default' })
    ).toBe(true)
  })

  it('skips delegate_wave approval for Boss + workspace_write (Full WS Access)', () => {
    expect(
      shouldSkipDelegateWaveApproval({
        isBossOrCaptain: true,
        permissionPresetId: 'workspace_write'
      })
    ).toBe(true)
  })

  it('skips delegate_wave approval for Boss + full_access', () => {
    expect(
      shouldSkipDelegateWaveApproval({
        isBossOrCaptain: true,
        permissionPresetId: 'full_access'
      })
    ).toBe(true)
  })

  it('prompts for Boss + read_only (Ask)', () => {
    expect(
      shouldSkipDelegateWaveApproval({ isBossOrCaptain: true, permissionPresetId: 'read_only' })
    ).toBe(false)
  })

  it('prompts for Boss + plan', () => {
    expect(
      shouldSkipDelegateWaveApproval({ isBossOrCaptain: true, permissionPresetId: 'plan' })
    ).toBe(false)
  })

  it('prompts for Boss + custom', () => {
    expect(
      shouldSkipDelegateWaveApproval({ isBossOrCaptain: true, permissionPresetId: 'custom' })
    ).toBe(false)
  })

  it('prompts for non-Boss on default / workspace_write / full_access', () => {
    expect(
      shouldSkipDelegateWaveApproval({ isBossOrCaptain: false, permissionPresetId: 'default' })
    ).toBe(false)
    expect(
      shouldSkipDelegateWaveApproval({
        isBossOrCaptain: false,
        permissionPresetId: 'workspace_write'
      })
    ).toBe(false)
    expect(
      shouldSkipDelegateWaveApproval({
        isBossOrCaptain: false,
        permissionPresetId: 'full_access'
      })
    ).toBe(false)
  })

  it('skips delegate_wave approval for Boss/Captain on Accept Edits / Full WS / Full Access', () => {
    for (const permissionPresetId of ['default', 'workspace_write', 'full_access'] as const) {
      expect(shouldSkipDelegateWaveApproval({ isBossOrCaptain: true, permissionPresetId })).toBe(
        true
      )
    }
    // Plan / Ask / custom always prompt — even for configured authority.
    for (const permissionPresetId of ['plan', 'read_only', 'custom'] as const) {
      expect(shouldSkipDelegateWaveApproval({ isBossOrCaptain: true, permissionPresetId })).toBe(
        false
      )
    }
    // Non-authority seats always prompt regardless of preset.
    for (const permissionPresetId of [
      'default',
      'workspace_write',
      'full_access',
      'plan',
      'read_only'
    ] as const) {
      expect(shouldSkipDelegateWaveApproval({ isBossOrCaptain: false, permissionPresetId })).toBe(
        false
      )
    }
  })

  it('rejects empty prompts and disallowed providers', () => {
    const emptyPrompt = parseDelegateWaveArgs(
      {
        workers: [
          { provider: 'codex', prompt: 'ok' },
          { provider: 'claude', prompt: '   ' }
        ]
      },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider }
    )
    expect(emptyPrompt.ok).toBe(false)
    if (!emptyPrompt.ok) expect(emptyPrompt.message).toMatch(/prompt/i)

    const badProvider = parseDelegateWaveArgs(
      {
        workers: [
          { provider: 'codex', prompt: 'ok' },
          { provider: 'ollama', prompt: 'nope' }
        ]
      },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider }
    )
    expect(badProvider.ok).toBe(false)
    if (!badProvider.ok) expect(badProvider.message).toMatch(/provider/i)
  })

  it('rejects recall fields — waves are spawn-only', () => {
    const topLevel = parseDelegateWaveArgs(
      { ...twoWorkers(), subThreadId: 'sub-1' },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider }
    )
    expect(topLevel.ok).toBe(false)
    if (!topLevel.ok) expect(topLevel.message).toMatch(/spawn-only|recall|subThreadId/i)

    const perWorker = parseDelegateWaveArgs(
      {
        workers: [
          { provider: 'codex', prompt: 'A', subThreadId: 'sub-1' },
          { provider: 'claude', prompt: 'B' }
        ]
      },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider }
    )
    expect(perWorker.ok).toBe(false)
    if (!perWorker.ok) expect(perWorker.message).toMatch(/spawn-only|recall|subThreadId/i)
  })

  it('rejects returnResult=false because waves always return results to the parent', () => {
    const result = parseDelegateWaveArgs(
      { ...twoWorkers(), returnResult: false },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/returnResult/i)
  })

  it('rejects a non-object join payload', () => {
    const result = parseDelegateWaveArgs(
      { ...twoWorkers(), join: 'required' },
      { parentChatId, parentAppRunId, nowMs, isAllowedProvider }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/join must be an object/i)
  })

  it('binds wave join groupId to a fresh waveId, never parent appRunId or caller groupId', () => {
    const waveId = createDelegateWaveId(parentChatId, {
      nowMs,
      randomId: () => 'fixedwave'
    })
    expect(waveId).toBe('wave-parent-chat-1-fixedwave')
    expect(waveId).not.toBe(parentAppRunId)

    const policy = resolveDelegateWaveJoinPolicy(
      {
        required: true,
        quorum: 2,
        deadlineMs: 60_000,
        debounceMs: 0,
        // @ts-expect-error — callers may smuggle groupId; it must be ignored
        groupId: parentAppRunId
      },
      waveId,
      nowMs
    )

    expect(policy.groupId).toBe(waveId)
    expect(policy.groupId).not.toBe(parentAppRunId)
    expect(policy.required).toBe(true)
    expect(policy.quorum).toBe(2)

    const parsed = parseDelegateWaveArgs(
      {
        ...twoWorkers(),
        join: { required: false, quorum: 1, groupId: parentAppRunId }
      },
      {
        parentChatId,
        parentAppRunId,
        nowMs,
        isAllowedProvider,
        createWaveId: () => waveId
      }
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.waveId).toBe(waveId)
    expect(parsed.value.returnResultToParent).toBe(true)
    expect(parsed.value.joinPolicy.groupId).toBe(waveId)
    expect(parsed.value.joinPolicy.groupId).not.toBe(parentAppRunId)
    expect(parsed.value.joinPolicy.required).toBe(false)
    expect(parsed.value.joinPolicy.quorum).toBe(1)
    expect(parsed.value.workers).toEqual([
      { provider: 'codex', prompt: 'Scout A' },
      { provider: 'claude', prompt: 'Scout B' }
    ])
  })

  it('preserves optional model / reasoningEffort / kimiThinking on workers', () => {
    const parsed = parseDelegateWaveArgs(
      {
        workers: [
          {
            provider: 'codex',
            prompt: 'A',
            model: 'gpt-5.6-terra',
            reasoningEffort: 'high'
          },
          {
            provider: 'kimi',
            prompt: 'B',
            kimiThinking: true
          }
        ]
      },
      {
        parentChatId,
        parentAppRunId,
        nowMs,
        isAllowedProvider,
        createWaveId: () => 'wave-test'
      }
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.workers[0]).toMatchObject({
      provider: 'codex',
      prompt: 'A',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high'
    })
    expect(parsed.value.workers[1]).toMatchObject({
      provider: 'kimi',
      prompt: 'B',
      kimiThinking: true
    })
  })

  it('shapes the agent-facing wave result with spawned children', () => {
    const shaped = shapeDelegateWaveResult({
      waveId: 'wave-x',
      children: [
        { subThreadId: 'sub-1', provider: 'codex' },
        { subThreadId: 'sub-2', provider: 'claude' }
      ]
    })
    expect(shaped).toEqual({
      waveId: 'wave-x',
      children: [
        { subThreadId: 'sub-1', provider: 'codex', status: 'spawned' },
        { subThreadId: 'sub-2', provider: 'claude', status: 'spawned' }
      ]
    })
  })

  it('recognises Boss / Captain ids and rejects solo or missing callers', () => {
    expect(
      isDelegateWaveBossOrCaptain({
        callerParticipantId: 'boss-1',
        bossmanParticipantId: 'boss-1',
        captainParticipantIds: ['cap-1']
      })
    ).toBe(true)
    expect(
      isDelegateWaveBossOrCaptain({
        callerParticipantId: 'cap-1',
        bossmanParticipantId: 'boss-1',
        captainParticipantIds: ['cap-1', 'cap-2']
      })
    ).toBe(true)
    expect(
      isDelegateWaveBossOrCaptain({
        callerParticipantId: 'legacy-cap',
        bossmanParticipantId: 'boss-1',
        secondInCommandParticipantId: 'legacy-cap'
      })
    ).toBe(true)
    expect(
      isDelegateWaveBossOrCaptain({
        callerParticipantId: 'worker-1',
        bossmanParticipantId: 'boss-1',
        captainParticipantIds: ['cap-1']
      })
    ).toBe(false)
    expect(
      isDelegateWaveBossOrCaptain({
        callerParticipantId: null,
        bossmanParticipantId: 'boss-1'
      })
    ).toBe(false)
  })

  it('reserves N budget slots only when remaining covers the whole wave', () => {
    let consumed = 0
    const short = reserveDelegateWaveBudgetSlots({
      workerCount: 3,
      remaining: 2,
      tryConsume: () => {
        consumed += 1
        return 'allowed'
      }
    })
    expect(short).toEqual({ ok: false, reason: 'insufficient' })
    expect(consumed).toBe(0)

    const ok = reserveDelegateWaveBudgetSlots({
      workerCount: 3,
      remaining: 3,
      tryConsume: () => {
        consumed += 1
        return 'allowed'
      }
    })
    expect(ok).toEqual({ ok: true })
    expect(consumed).toBe(3)
  })

  function trackingBudgetPorts() {
    let consumed = 0
    let released = 0
    return {
      get netConsumed() {
        return consumed - released
      },
      get consumed() {
        return consumed
      },
      get released() {
        return released
      },
      tryConsumeBudgetSlot: (): 'allowed' | 'exhausted' => {
        consumed += 1
        return 'allowed'
      },
      releaseBudgetSlots: (count: number) => {
        released += Math.max(0, Math.floor(count))
      }
    }
  }

  it('executeDelegateWaveTool is all-or-nothing and rolls back partial spawns', async () => {
    const rolledBack: Array<{
      subThreadId: string
      provider: string
      title: string
      runId: string
    }> = []
    let spawnCalls = 0
    const budget = trackingBudgetPorts()
    const outcome = await executeDelegateWaveTool({
      args: twoWorkers(),
      parentChatId,
      parentAppRunId,
      parentProviderLabel: 'Codex',
      maxWorkers: 8,
      isAllowedProvider,
      isBossOrCaptain: true,
      permissionPresetId: 'default',
      budgetRemaining: 10,
      tryConsumeBudgetSlot: budget.tryConsumeBudgetSlot,
      releaseBudgetSlots: budget.releaseBudgetSlots,
      budgetCap: 20,
      requestApproval: async () => true,
      assertParentStillValid: () => undefined,
      resolveWorkerSettings: () => ({
        ok: true,
        value: {
          requestedModel: 'cli-default',
          runPayload: {},
          providerMetadataPatch: {}
        }
      }),
      spawnWorker: async ({ worker }) => {
        spawnCalls += 1
        if (spawnCalls === 2) {
          throw new Error('second worker failed')
        }
        return {
          subThreadId: `sub-${worker.provider}`,
          provider: worker.provider,
          title: `Sub-thread (${worker.provider})`,
          runId: `run-${worker.provider}`
        }
      },
      rollbackWorker: (child) => {
        rolledBack.push(child)
      },
      providerLabel: (provider) => provider,
      createWaveId: () => 'wave-rollback',
      nowMs
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.text).toMatch(/second worker failed/)
    expect(rolledBack).toEqual([
      {
        subThreadId: 'sub-codex',
        provider: 'codex',
        title: 'Sub-thread (codex)',
        runId: 'run-codex'
      }
    ])
    // Spawn-failure rollback must refund the reserved wave slots (not leave N burned).
    expect(budget.consumed).toBe(2)
    expect(budget.netConsumed).toBe(0)
  })

  it('executeDelegateWaveTool skips approval for Boss+default but still consumes budget', async () => {
    let approvalCalls = 0
    const budget = trackingBudgetPorts()
    const outcome = await executeDelegateWaveTool({
      args: twoWorkers(),
      parentChatId,
      parentAppRunId,
      parentProviderLabel: 'Claude',
      maxWorkers: 8,
      isAllowedProvider,
      isBossOrCaptain: true,
      permissionPresetId: 'workspace_write',
      budgetRemaining: 5,
      tryConsumeBudgetSlot: budget.tryConsumeBudgetSlot,
      releaseBudgetSlots: budget.releaseBudgetSlots,
      budgetCap: 20,
      subThreadDelegationPolicy: 'ask',
      requestApproval: async () => {
        approvalCalls += 1
        return true
      },
      assertParentStillValid: () => undefined,
      resolveWorkerSettings: () => ({
        ok: true,
        value: {
          requestedModel: 'cli-default',
          runPayload: {},
          providerMetadataPatch: {}
        }
      }),
      spawnWorker: async ({ worker }) => ({
        subThreadId: `sub-${worker.provider}`,
        provider: worker.provider,
        title: `Sub-thread (${worker.provider})`,
        runId: `run-${worker.provider}`
      }),
      rollbackWorker: () => undefined,
      providerLabel: (provider) => provider,
      createWaveId: () => 'wave-skip-approval',
      nowMs
    })
    expect(outcome.ok).toBe(true)
    expect(approvalCalls).toBe(0)
    expect(budget.consumed).toBe(2)
    expect(budget.netConsumed).toBe(2)
    if (!outcome.ok) return
    expect(outcome.result.waveId).toBe('wave-skip-approval')
    expect(outcome.result.children).toHaveLength(2)
  })

  it('authority card-skip still honors subThreadDelegation deny (no spawn)', async () => {
    let approvalCalls = 0
    let spawnCalls = 0
    const budget = trackingBudgetPorts()
    const outcome = await executeDelegateWaveTool({
      args: twoWorkers(),
      parentChatId,
      parentAppRunId,
      parentProviderLabel: 'Claude',
      maxWorkers: 8,
      isAllowedProvider,
      isBossOrCaptain: true,
      permissionPresetId: 'full_access',
      budgetRemaining: 5,
      tryConsumeBudgetSlot: budget.tryConsumeBudgetSlot,
      releaseBudgetSlots: budget.releaseBudgetSlots,
      budgetCap: 20,
      subThreadDelegationPolicy: 'deny',
      requestApproval: async () => {
        approvalCalls += 1
        return true
      },
      assertParentStillValid: () => undefined,
      resolveWorkerSettings: () => ({
        ok: true,
        value: {
          requestedModel: 'cli-default',
          runPayload: {},
          providerMetadataPatch: {}
        }
      }),
      spawnWorker: async ({ worker }) => {
        spawnCalls += 1
        return {
          subThreadId: `sub-${worker.provider}`,
          provider: worker.provider,
          title: `Sub-thread (${worker.provider})`,
          runId: `run-${worker.provider}`
        }
      },
      rollbackWorker: () => undefined,
      providerLabel: (provider) => provider,
      createWaveId: () => 'wave-deny-skip',
      nowMs
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.text).toMatch(/declined by TaskWraith policy/)
    expect(approvalCalls).toBe(0)
    expect(spawnCalls).toBe(0)
    // Policy deny after reserve must refund — otherwise the agent cannot retry this turn.
    expect(budget.consumed).toBe(2)
    expect(budget.netConsumed).toBe(0)
  })

  it('ask-path decline refunds reserved budget slots and never spawns', async () => {
    let spawnCalls = 0
    const budget = trackingBudgetPorts()
    const outcome = await executeDelegateWaveTool({
      args: twoWorkers(),
      parentChatId,
      parentAppRunId,
      parentProviderLabel: 'Codex',
      maxWorkers: 8,
      isAllowedProvider,
      isBossOrCaptain: false,
      permissionPresetId: 'default',
      budgetRemaining: 5,
      tryConsumeBudgetSlot: budget.tryConsumeBudgetSlot,
      releaseBudgetSlots: budget.releaseBudgetSlots,
      budgetCap: 20,
      subThreadDelegationPolicy: 'ask',
      requestApproval: async () => false,
      assertParentStillValid: () => undefined,
      resolveWorkerSettings: () => ({
        ok: true,
        value: {
          requestedModel: 'cli-default',
          runPayload: {},
          providerMetadataPatch: {}
        }
      }),
      spawnWorker: async ({ worker }) => {
        spawnCalls += 1
        return {
          subThreadId: `sub-${worker.provider}`,
          provider: worker.provider,
          title: `Sub-thread (${worker.provider})`,
          runId: `run-${worker.provider}`
        }
      },
      rollbackWorker: () => undefined,
      providerLabel: (provider) => provider,
      createWaveId: () => 'wave-ask-deny',
      nowMs
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.text).toMatch(/declined by TaskWraith policy/)
    expect(spawnCalls).toBe(0)
    expect(budget.consumed).toBe(2)
    expect(budget.netConsumed).toBe(0)
  })

  it('stripParentWaveDelegationCard removes only the matching projection card', () => {
    const messages = [
      { id: 'keep-user', role: 'user', metadata: undefined },
      {
        id: 'wave-card-a',
        role: 'system',
        metadata: { kind: 'subThreadDelegation', subThreadId: 'sub-a' }
      },
      {
        id: 'wave-card-b',
        role: 'system',
        metadata: { kind: 'subThreadDelegation', subThreadId: 'sub-b' }
      },
      {
        id: 'return-a',
        role: 'tool',
        metadata: { kind: 'subThreadReturn', subThreadId: 'sub-a' }
      }
    ]
    const next = stripParentWaveDelegationCard(messages, 'sub-a')
    expect(next.map((message) => message.id)).toEqual(['keep-user', 'wave-card-b', 'return-a'])
  })

  it('approval copy discloses ephemeral lifecycle, roles/labels, postures, and multi-provider', () => {
    const joinPolicy = resolveDelegateWaveJoinPolicy(
      { required: true, quorum: 2 },
      'wave-copy',
      nowMs
    )
    const { body } = buildDelegateWaveApprovalCopy({
      parentProviderLabel: 'Codex',
      waveId: 'wave-copy',
      workers: [
        {
          provider: 'codex',
          prompt: 'Map the auth surface',
          role: 'scout',
          label: 'Auth scout'
        },
        {
          provider: 'claude',
          prompt: 'Implement the fix',
          role: 'worker',
          label: 'Fixer'
        },
        {
          provider: 'codex',
          prompt: 'Review the diff',
          role: 'reviewer'
        },
        {
          provider: 'codex',
          prompt: 'Default role omitted'
        }
      ],
      joinPolicy,
      providerLabel: (provider) => provider,
      lifecycle: 'ephemeral',
      allowMultiProvider: true
    })
    expect(body).toMatch(/Lifecycle:\s*ephemeral \(die-on-return\)/i)
    expect(body).toMatch(/Multi-provider:\s*allowed/i)
    expect(body).toMatch(/role=scout/i)
    expect(body).toMatch(/label=Auth scout/)
    expect(body).toMatch(/role=worker/i)
    expect(body).toMatch(/label=Fixer/)
    expect(body).toMatch(/role=reviewer/i)
    expect(body).toMatch(/posture=read_only/)
    expect(body).toMatch(/posture=capped inherit or worktree when available \(never Full Access\)/)
    // Default / scout / reviewer are read_only; only the worker line carries capped inherit.
    const workerLine = body
      .split('\n')
      .find((line) => /role=worker/i.test(line) && /label=Fixer/.test(line))
    expect(workerLine).toBeTruthy()
    expect(workerLine).toMatch(
      /posture=capped inherit or worktree when available \(never Full Access\)/
    )
    expect(workerLine).not.toMatch(/same-checkout/)
    expect(workerLine).not.toMatch(/posture=read_only/)
  })

  it('approval copy discloses durable lifecycle and omits multi-provider unless requested', () => {
    const joinPolicy = resolveDelegateWaveJoinPolicy(undefined, 'wave-durable', nowMs)
    const { body } = buildDelegateWaveApprovalCopy({
      parentProviderLabel: 'Claude',
      waveId: 'wave-durable',
      workers: [
        { provider: 'claude', prompt: 'A' },
        { provider: 'claude', prompt: 'B', role: 'scout', label: 'S1' }
      ],
      joinPolicy,
      providerLabel: (provider) => provider,
      lifecycle: 'durable',
      allowMultiProvider: false
    })
    expect(body).toMatch(/Lifecycle:\s*durable\b/i)
    expect(body).not.toMatch(/die-on-return/i)
    expect(body).not.toMatch(/Multi-provider:/i)
    expect(body).toMatch(/role=scout/i)
    expect(body).toMatch(/label=S1/)
    expect(body).toMatch(/posture=read_only/)
  })

  it('executeDelegateWaveTool threads lifecycle + allowMultiProvider into the approval card', async () => {
    let approvalBody = ''
    const budget = trackingBudgetPorts()
    const outcome = await executeDelegateWaveTool({
      args: {
        lifecycle: 'ephemeral',
        allowMultiProvider: true,
        workers: [
          {
            provider: 'codex',
            prompt: 'Scout the tree',
            role: 'scout',
            label: 'Tree scout'
          },
          {
            provider: 'claude',
            prompt: 'Apply the patch',
            role: 'worker',
            label: 'Patcher'
          }
        ]
      },
      parentChatId,
      parentAppRunId,
      parentProvider: 'codex',
      parentProviderLabel: 'Codex',
      maxWorkers: 8,
      isAllowedProvider,
      isBossOrCaptain: false,
      permissionPresetId: 'default',
      budgetRemaining: 5,
      tryConsumeBudgetSlot: budget.tryConsumeBudgetSlot,
      releaseBudgetSlots: budget.releaseBudgetSlots,
      budgetCap: 20,
      subThreadDelegationPolicy: 'ask',
      requestApproval: async (preview) => {
        approvalBody = preview.body
        return false
      },
      assertParentStillValid: () => undefined,
      resolveWorkerSettings: () => ({
        ok: true,
        value: {
          requestedModel: 'cli-default',
          runPayload: {},
          providerMetadataPatch: {}
        }
      }),
      spawnWorker: async ({ worker }) => ({
        subThreadId: `sub-${worker.provider}`,
        provider: worker.provider,
        title: `Sub-thread (${worker.provider})`,
        runId: `run-${worker.provider}`
      }),
      rollbackWorker: () => undefined,
      providerLabel: (provider) => provider,
      createWaveId: () => 'wave-approval-thread',
      nowMs
    })
    expect(outcome.ok).toBe(false)
    expect(approvalBody).toMatch(/Lifecycle:\s*ephemeral \(die-on-return\)/i)
    expect(approvalBody).toMatch(/Multi-provider:\s*allowed/i)
    expect(approvalBody).toMatch(/role=scout/i)
    expect(approvalBody).toMatch(/label=Tree scout/)
    expect(approvalBody).toMatch(/role=worker/i)
    expect(approvalBody).toMatch(/label=Patcher/)
    expect(approvalBody).toMatch(
      /posture=capped inherit or worktree when available \(never Full Access\)/
    )
    expect(approvalBody).not.toMatch(/same-checkout/)
    // Decline still refunds — preserve budget invariant.
    expect(budget.consumed).toBe(2)
    expect(budget.netConsumed).toBe(0)
  })
})
