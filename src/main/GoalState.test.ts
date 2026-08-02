import { describe, expect, it } from 'vitest'
import {
  activeGoalModeLabel,
  computeGoalRuntimeTiming,
  createActiveGoal,
  createGoalRuntimeLedger,
  formatActiveGoalPromptBlock,
  MAX_ACTIVE_GOAL_OBJECTIVE_CHARS,
  normalizeActiveGoalObjective,
  resolveActiveGoalForEnsemble,
  resolveActiveGoalForProvider,
  resolveActiveGoalMode,
  shouldMintFreshGoalIdentity,
  shouldInjectActiveGoal,
  transitionGoalRuntimeLedger,
  updateActiveGoalLifecycle
} from './GoalState'

const MINUTE = 60_000

describe('shouldMintFreshGoalIdentity (C2 P2 — fresh goal identity)', () => {
  const prior = createActiveGoal('claude', 'Ship the quota failover', {
    now: new Date('2026-07-12T09:00:00Z')
  })

  it('mints fresh when there is no prior goal', () => {
    expect(shouldMintFreshGoalIdentity(null, 'anything')).toBe(true)
    expect(shouldMintFreshGoalIdentity(undefined, 'anything')).toBe(true)
  })

  it('mints fresh when the prior goal is completed (even for the same objective)', () => {
    const completed = updateActiveGoalLifecycle(prior, 'completed')
    expect(shouldMintFreshGoalIdentity(completed, prior.objective)).toBe(true)
  })

  it('mints fresh when the objective materially changes', () => {
    expect(shouldMintFreshGoalIdentity(prior, 'A completely different objective')).toBe(true)
  })

  it('PRESERVES identity when re-setting the SAME objective on an active goal', () => {
    expect(shouldMintFreshGoalIdentity(prior, prior.objective)).toBe(false)
  })

  it('PRESERVES identity for the same objective with only whitespace differences (normalized)', () => {
    expect(shouldMintFreshGoalIdentity(prior, `   ${prior.objective}   `)).toBe(false)
  })
})

describe('GoalState', () => {
  it('retains an explicit objective source without guessing for legacy callers', () => {
    const userGoal = createActiveGoal('codex', 'Ship the safe continuation checkpoint', {
      now: new Date('2026-08-02T10:00:00Z'),
      objectiveSource: 'user'
    })
    const legacyGoal = createActiveGoal('codex', 'Legacy goal', {
      now: new Date('2026-08-02T10:00:00Z')
    })

    expect(userGoal.objectiveSource).toBe('user')
    expect(legacyGoal.objectiveSource).toBeUndefined()
  })

  it('creates provider-aware goals without treating todos as the objective', () => {
    const goal = createActiveGoal('ollama', 'Fix the failing parser test', {
      now: new Date('2026-06-13T12:00:00Z')
    })

    expect(goal.status).toBe('active')
    expect(goal.mode).toBe('ollama_harness')
    expect(activeGoalModeLabel(goal.mode)).toBe('Ollama managed')
    expect(goal.objective).toBe('Fix the failing parser test')
    expect(goal.runtimeLedger).toEqual({
      startedAt: '2026-06-13T12:00:00.000Z',
      intervals: [{ status: 'active', startedAt: '2026-06-13T12:00:00.000Z' }]
    })
  })

  it('limits active goal objectives to 4000 characters', () => {
    const overLimit = ` ${'x'.repeat(MAX_ACTIVE_GOAL_OBJECTIVE_CHARS + 20)} `

    expect(normalizeActiveGoalObjective(overLimit)).toHaveLength(MAX_ACTIVE_GOAL_OBJECTIVE_CHARS)

    const goal = createActiveGoal('codex', overLimit, {
      now: new Date('2026-06-13T12:00:00Z')
    })
    expect(goal.objective).toHaveLength(MAX_ACTIVE_GOAL_OBJECTIVE_CHARS)
  })

  it('tracks active, paused, resumed, blocked, and completed goal runtime', () => {
    let ledger = createGoalRuntimeLedger('2026-06-13T12:00:00.000Z')

    ledger = transitionGoalRuntimeLedger(ledger, 'paused', '2026-06-13T12:10:00.000Z')
    expect(computeGoalRuntimeTiming(ledger, '2026-06-13T12:15:00.000Z')).toEqual({
      activeMs: 10 * MINUTE,
      wallMs: 15 * MINUTE,
      pausedMs: 5 * MINUTE,
      blockedMs: 0
    })

    ledger = transitionGoalRuntimeLedger(ledger, 'active', '2026-06-13T12:20:00.000Z')
    ledger = transitionGoalRuntimeLedger(ledger, 'blocked', '2026-06-13T12:30:00.000Z')
    expect(computeGoalRuntimeTiming(ledger, '2026-06-13T12:35:00.000Z')).toEqual({
      activeMs: 20 * MINUTE,
      wallMs: 35 * MINUTE,
      pausedMs: 10 * MINUTE,
      blockedMs: 5 * MINUTE
    })

    ledger = transitionGoalRuntimeLedger(ledger, 'active', '2026-06-13T12:40:00.000Z')
    ledger = transitionGoalRuntimeLedger(ledger, 'completed', '2026-06-13T12:45:00.000Z')

    expect(ledger).toEqual({
      startedAt: '2026-06-13T12:00:00.000Z',
      endedAt: '2026-06-13T12:45:00.000Z',
      endStatus: 'completed',
      intervals: [
        {
          status: 'active',
          startedAt: '2026-06-13T12:00:00.000Z',
          endedAt: '2026-06-13T12:10:00.000Z'
        },
        {
          status: 'paused',
          startedAt: '2026-06-13T12:10:00.000Z',
          endedAt: '2026-06-13T12:20:00.000Z'
        },
        {
          status: 'active',
          startedAt: '2026-06-13T12:20:00.000Z',
          endedAt: '2026-06-13T12:30:00.000Z'
        },
        {
          status: 'blocked',
          startedAt: '2026-06-13T12:30:00.000Z',
          endedAt: '2026-06-13T12:40:00.000Z'
        },
        {
          status: 'active',
          startedAt: '2026-06-13T12:40:00.000Z',
          endedAt: '2026-06-13T12:45:00.000Z'
        }
      ]
    })
    expect(computeGoalRuntimeTiming(ledger, '2026-06-13T13:00:00.000Z')).toEqual({
      activeMs: 25 * MINUTE,
      wallMs: 45 * MINUTE,
      pausedMs: 10 * MINUTE,
      blockedMs: 10 * MINUTE
    })
  })

  it('freezes runtime timing when a goal runtime ledger is cancelled', () => {
    let ledger = createGoalRuntimeLedger('2026-06-13T12:00:00.000Z')
    ledger = transitionGoalRuntimeLedger(ledger, 'paused', '2026-06-13T12:05:00.000Z')
    ledger = transitionGoalRuntimeLedger(ledger, 'cancelled', '2026-06-13T12:08:00.000Z')

    expect(ledger.endStatus).toBe('cancelled')
    expect(ledger.endedAt).toBe('2026-06-13T12:08:00.000Z')
    expect(transitionGoalRuntimeLedger(ledger, 'cancelled', '2026-06-13T12:30:00.000Z')).toEqual(
      ledger
    )
    expect(computeGoalRuntimeTiming(ledger, '2026-06-13T12:30:00.000Z')).toEqual({
      activeMs: 5 * MINUTE,
      wallMs: 8 * MINUTE,
      pausedMs: 3 * MINUTE,
      blockedMs: 0
    })
  })

  it('keeps repeated non-terminal runtime transitions from duplicating intervals', () => {
    const initial = createGoalRuntimeLedger('2026-06-13T12:00:00.000Z')
    const paused = transitionGoalRuntimeLedger(initial, 'paused', '2026-06-13T12:05:00.000Z')
    const repeated = transitionGoalRuntimeLedger(paused, 'paused', '2026-06-13T12:06:00.000Z')

    expect(initial.intervals).toEqual([{ status: 'active', startedAt: '2026-06-13T12:00:00.000Z' }])
    expect(paused.intervals).toEqual([
      {
        status: 'active',
        startedAt: '2026-06-13T12:00:00.000Z',
        endedAt: '2026-06-13T12:05:00.000Z'
      },
      { status: 'paused', startedAt: '2026-06-13T12:05:00.000Z' }
    ])
    expect(repeated.intervals).toEqual(paused.intervals)
  })

  it('updates the active goal runtime ledger through lifecycle changes', () => {
    const goal = createActiveGoal('codex', 'Track elapsed work', {
      now: new Date('2026-06-13T12:00:00.000Z')
    })

    const paused = updateActiveGoalLifecycle(
      goal,
      'paused',
      undefined,
      new Date('2026-06-13T12:05:00.000Z')
    )
    const resumed = updateActiveGoalLifecycle(
      paused,
      'active',
      undefined,
      new Date('2026-06-13T12:07:00.000Z')
    )
    const completed = updateActiveGoalLifecycle(
      resumed,
      'completed',
      'done',
      new Date('2026-06-13T12:10:00.000Z')
    )

    expect(computeGoalRuntimeTiming(completed.runtimeLedger)).toEqual({
      activeMs: 8 * MINUTE,
      wallMs: 10 * MINUTE,
      pausedMs: 2 * MINUTE,
      blockedMs: 0
    })
  })

  it('distinguishes native and steered provider modes', () => {
    expect(resolveActiveGoalMode('codex')).toBe('taskwraith_steered')
    expect(resolveActiveGoalMode('codex', { codexNativeAvailable: true })).toBe('codex_native')
    expect(resolveActiveGoalMode('claude')).toBe('taskwraith_steered')
    expect(resolveActiveGoalMode('claude', { claudeNativeAvailable: true })).toBe('claude_native')
    expect(resolveActiveGoalMode('grok')).toBe('taskwraith_steered')
    expect(resolveActiveGoalMode('grok', { grokNativeAvailable: true })).toBe('grok_native')
  })

  it('can disable provider-native modes for ensemble-owned goals', () => {
    expect(
      resolveActiveGoalMode('grok', {
        grokNativeAvailable: true,
        allowProviderNative: false
      })
    ).toBe('taskwraith_steered')
    expect(
      resolveActiveGoalMode('codex', {
        codexNativeAvailable: true,
        allowProviderNative: false
      })
    ).toBe('taskwraith_steered')
    expect(resolveActiveGoalMode('ollama', { allowProviderNative: false })).toBe(
      'taskwraith_steered'
    )
  })

  it('resolves stored goals against the provider handling the next turn', () => {
    const goal = createActiveGoal('codex', 'Keep the objective portable', {
      now: new Date('2026-06-13T12:00:00Z'),
      codexNativeAvailable: true
    })

    const ollamaGoal = resolveActiveGoalForProvider(goal, 'ollama')
    expect(ollamaGoal?.provider).toBe('ollama')
    expect(ollamaGoal?.mode).toBe('ollama_harness')
    expect(goal.provider).toBe('codex')
    expect(goal.mode).toBe('codex_native')

    expect(resolveActiveGoalForProvider(goal, 'gemini')?.mode).toBe('taskwraith_steered')
    expect(
      resolveActiveGoalForProvider(goal, 'claude', { claudeNativeAvailable: true })?.mode
    ).toBe('claude_native')
    expect(resolveActiveGoalForProvider(goal, 'grok', { grokNativeAvailable: true })?.mode).toBe(
      'grok_native'
    )
  })

  it('injects active and blocked goals, not paused or completed goals', () => {
    const goal = createActiveGoal('codex', 'Ship the goal control', {
      now: new Date('2026-06-13T12:00:00Z')
    })

    expect(shouldInjectActiveGoal(goal)).toBe(true)
    expect(shouldInjectActiveGoal(updateActiveGoalLifecycle(goal, 'blocked', 'Need tests'))).toBe(
      true
    )
    expect(shouldInjectActiveGoal(updateActiveGoalLifecycle(goal, 'paused'))).toBe(false)
    expect(shouldInjectActiveGoal(updateActiveGoalLifecycle(goal, 'completed'))).toBe(false)
  })

  it('does not inject native provider goals that are handled by provider runtime state', () => {
    const goal = createActiveGoal('codex', 'Let Codex own the native goal', {
      now: new Date('2026-06-13T12:00:00Z'),
      codexNativeAvailable: true
    })

    expect(goal.mode).toBe('codex_native')
    expect(shouldInjectActiveGoal(goal)).toBe(false)
    expect(shouldInjectActiveGoal(updateActiveGoalLifecycle(goal, 'blocked', 'Need input'))).toBe(
      false
    )
  })

  it('does not inject native Grok goals that are handled by the Grok runtime', () => {
    const goal = createActiveGoal('grok', 'Let Grok own the native goal', {
      now: new Date('2026-06-22T12:00:00Z'),
      grokNativeAvailable: true
    })

    expect(goal.mode).toBe('grok_native')
    expect(activeGoalModeLabel(goal.mode)).toBe('Native Grok goal')
    expect(shouldInjectActiveGoal(goal)).toBe(false)
    expect(shouldInjectActiveGoal(updateActiveGoalLifecycle(goal, 'blocked', 'Need input'))).toBe(
      false
    )
  })

  it('normalizes provider-native goals when an ensemble owns the prompt', () => {
    const nativeGoal = createActiveGoal('grok', 'Keep the ensemble objective visible', {
      now: new Date('2026-06-22T12:00:00Z'),
      grokNativeAvailable: true
    })

    const ensembleGoal = resolveActiveGoalForEnsemble(nativeGoal)

    expect(nativeGoal.mode).toBe('grok_native')
    expect(ensembleGoal?.provider).toBe('grok')
    expect(ensembleGoal?.mode).toBe('taskwraith_steered')
    expect(shouldInjectActiveGoal(ensembleGoal)).toBe(true)
  })

  it('formats steering rules for provider prompts', () => {
    const goal = createActiveGoal('codex', 'Implement /goal without replacing todo_write', {
      now: new Date('2026-06-13T12:00:00Z')
    })
    const block = formatActiveGoalPromptBlock(goal)

    expect(block).toContain('<taskwraith_active_goal>')
    expect(block).toContain('Guided by TaskWraith')
    expect(block).toContain('todo_write may publish visible steps')
    expect(block).toContain('Use goal_read to inspect')
  })
})
