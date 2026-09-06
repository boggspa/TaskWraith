import { describe, expect, it } from 'vitest'
import { TASKWRAITH_GATEWAY_MCP_PROFILE_NOTE } from '../PromptComposition'
import {
  buildCursorPathBLaunchPlan,
  resolveCursorPathBBrokerPolicy,
  type CursorPathBLaunchPlanInput
} from './CursorPathBLaunchPlan'
import type { EffectiveRunPermissions } from '../store/types'

const WORKSPACE = '/Users/test/repo'
const PROMPT = 'Review the workspace.'

function input(overrides: Partial<CursorPathBLaunchPlanInput> = {}): CursorPathBLaunchPlanInput {
  return {
    workspacePath: WORKSPACE,
    prompt: PROMPT,
    model: 'composer-1',
    reasoningEffort: null,
    fastMode: false,
    writeCapable: false,
    planSeat: false,
    brokerRequested: false,
    brokerOutcome: 'not-requested',
    taskWraithMcpProfileId: null,
    workspaceMcpAliasesGlobalRegistry: false,
    ...overrides
  }
}

describe('CursorPathBLaunchPlan', () => {
  it('builds the exact native-only read-only plan and defuses stale MCP claims', () => {
    const plan = buildCursorPathBLaunchPlan(
      input({
        prompt: `${TASKWRAITH_GATEWAY_MCP_PROFILE_NOTE}\n\n${PROMPT}`
      })
    )

    expect(plan.prompt).toBe(PROMPT)
    expect(plan.taskWraithMcpAdvertised).toBe(false)
    expect(plan.controls).toEqual({
      executionMode: 'ask',
      bridgeMode: 'none',
      brokerRegistration: 'none',
      forceMcpTools: false,
      approveMcpServers: false
    })
    expect(plan.argv).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--trust',
      '--sandbox',
      'enabled',
      '--mode',
      'ask',
      '--skip-worktree-setup',
      '--model',
      'composer-1',
      '--workspace',
      WORKSPACE
      // No `--` guard and no positional: the prompt goes to stdin.
    ])
  })

  it('builds a broker-active read-only plan with default mode and force', () => {
    const plan = buildCursorPathBLaunchPlan(
      input({
        brokerRequested: true,
        brokerOutcome: 'active',
        taskWraithMcpProfileId: 'taskwraith-gateway-v1'
      })
    )

    expect(plan.prompt).toContain(PROMPT)
    expect(plan.prompt).toContain('exact Cursor MCP server id `taskwraith-broker`')
    expect(plan.prompt).toContain('GetMcpTools')
    expect(plan.controls).toEqual({
      executionMode: 'contained-default',
      bridgeMode: 'safe-subset',
      brokerRegistration: 'global',
      forceMcpTools: true,
      approveMcpServers: true
    })
    expect(plan.argv).toContain('--force')
    expect(plan.argv).not.toContain('--mode')
    expect(plan.broker).toMatchObject({
      requested: true,
      outcome: 'active',
      serverName: 'taskwraith-broker',
      safeSubset: true,
      planSubset: false,
      gatewaySubset: true
    })
    expect(plan.broker.denyRules).toEqual(['Shell(**)', 'Write(**)'])
  })

  it('builds the plan-subset and full broker policies used by transient config', () => {
    const readOnlyPlan = resolveCursorPathBBrokerPolicy({
      writeCapable: false,
      planSeat: true,
      taskWraithMcpProfileId: 'taskwraith-gateway-v1'
    })
    const writePlan = resolveCursorPathBBrokerPolicy({
      writeCapable: true,
      planSeat: false,
      taskWraithMcpProfileId: 'taskwraith-full-v1'
    })

    expect(readOnlyPlan).toMatchObject({
      bridgeMode: 'plan-subset',
      denyRules: ['Shell(**)', 'Write(**)'],
      safeSubset: true,
      planSubset: true
    })
    expect(writePlan).toMatchObject({
      bridgeMode: 'full',
      denyRules: ['Shell(**)', 'Write(**)'],
      safeSubset: false,
      planSubset: false
    })
    expect(readOnlyPlan.allowRules.some((rule) => rule.includes('delegate_wave'))).toBe(false)
  })

  it.each([false, true])(
    'uses the solo birth profile for scoped broker rules with planSeat=%s',
    (planSeat) => {
      const policy = resolveCursorPathBBrokerPolicy({
        writeCapable: false,
        planSeat,
        taskWraithMcpProfileId: 'taskwraith-gateway-solo-v1'
      })

      for (const toolName of [
        'ensemble_await',
        'ensemble_lane_result',
        'image_view',
        'capability_search',
        'capability_invoke'
      ]) {
        expect(policy.allowRules).toContain(`Mcp(taskwraith-broker:${toolName})`)
      }
      for (const toolName of [
        'write_file',
        'delegate_wave',
        'ultra_task',
        'delegate_to_subthread'
      ]) {
        expect(policy.allowRules).not.toContain(`Mcp(taskwraith-broker:${toolName})`)
      }
      expect(policy.denyRules).toEqual(['Shell(**)', 'Write(**)'])
    }
  )

  it('adds exact delegation allow rules only for signed UltraTask Ask/Plan runs', () => {
    const effectivePermissions = {
      subThreadDelegationAutoAllowSource: 'ultratask'
    } as EffectiveRunPermissions
    for (const planSeat of [false, true]) {
      const policy = resolveCursorPathBBrokerPolicy({
        writeCapable: false,
        planSeat,
        taskWraithMcpProfileId: 'taskwraith-gateway-solo-v1',
        effectivePermissions
      })
      expect(policy.bridgeMode).toBe(planSeat ? 'plan-subset' : 'safe-subset')
      for (const toolName of ['delegate_wave', 'ultra_task', 'delegate_to_subthread']) {
        expect(policy.allowRules).toContain(`Mcp(taskwraith-broker:${toolName})`)
        expect(policy.allowRules).toContain(`Mcp(taskwraith-broker-${toolName})`)
      }
      expect(policy.allowRules).not.toContain('Mcp(taskwraith-broker:*)')
      expect(policy.denyRules).toEqual(['Shell(**)', 'Write(**)'])
    }

    const ordinary = resolveCursorPathBBrokerPolicy({
      writeCapable: false,
      planSeat: true,
      taskWraithMcpProfileId: 'taskwraith-gateway-solo-v1'
    })
    for (const toolName of ['delegate_wave', 'ultra_task', 'delegate_to_subthread']) {
      expect(ordinary.allowRules.some((rule) => rule.includes(toolName))).toBe(false)
    }
  })

  it('selects a visible native-only degradation before argv construction', () => {
    const plan = buildCursorPathBLaunchPlan(
      input({
        prompt: `${TASKWRAITH_GATEWAY_MCP_PROFILE_NOTE}\n\n${PROMPT}`,
        brokerRequested: true,
        brokerOutcome: 'native-only-degraded',
        taskWraithMcpProfileId: 'taskwraith-gateway-v1'
      })
    )

    expect(plan.prompt).toBe(PROMPT)
    expect(plan.broker.outcome).toBe('native-only-degraded')
    expect(plan.taskWraithMcpAdvertised).toBe(false)
    expect(plan.argv).not.toContain('--force')
    expect(plan.argv).toContain('ask')
  })

  it('keeps a sandboxed native write fallback when the exact broker is unavailable', () => {
    const degraded = buildCursorPathBLaunchPlan(
      input({
        writeCapable: true,
        brokerRequested: true,
        brokerOutcome: 'native-only-degraded',
        taskWraithMcpProfileId: 'taskwraith-full-v1'
      })
    )
    expect(degraded.controls.executionMode).toBe('contained-default')
    expect(degraded.argv).not.toContain('--force')
    expect(degraded.argv).not.toContain('ask')
    expect(degraded.broker.denyRules).toEqual([])
    expect(degraded.prompt).toContain('user-approved write posture remains active')
    expect(degraded.prompt).toContain('enabled workspace sandbox')
    expect(degraded.prompt).toContain('not a substitute for TaskWraith sub-thread')
    expect(degraded.prompt).not.toContain('delegate_to_subthread')
    expect(degraded.prompt).not.toContain('taskwraith__delegate_to_subthread')
    expect(degraded.taskWraithMcpAdvertised).toBe(false)

    const active = buildCursorPathBLaunchPlan(
      input({
        writeCapable: true,
        brokerRequested: true,
        brokerOutcome: 'active',
        taskWraithMcpProfileId: 'taskwraith-full-v1'
      })
    )
    expect(active.controls.executionMode).toBe('contained-default')
    expect(active.argv).toContain('--force')
    expect(active.broker.denyRules).toEqual(['Shell(**)', 'Write(**)'])
    expect(active.broker.allowRules).toEqual(
      expect.arrayContaining([`Mcp(taskwraith-broker:delegate_to_subthread)`])
    )
  })

  it('migrates a retired Grok 4.5 seat onto 4.6 rather than emitting a dead wire id', () => {
    // Cursor dropped the 4.5 family; a seat still pinned to it would otherwise
    // dispatch an id its CLI rejects outright. The plan migrates to 4.6, whose
    // ladder is a superset, so the seat keeps both its Grok intent and effort.
    const plan = buildCursorPathBLaunchPlan(
      input({
        model: 'grok-4.5',
        reasoningEffort: 'high',
        fastMode: true
      })
    )

    // The seat asked for high + Fast; migrating must not quietly drop either,
    // so it lands on the concrete 4.6 wire id carrying both.
    expect(plan.wireModel).toBe('cursor-grok-4.6-high-fast')
    expect(plan.reasoningEffort).toBe('high')
    expect(plan.fastMode).toBe(true)
    expect(plan.argv).toEqual(expect.arrayContaining(['--model', 'cursor-grok-4.6-high-fast']))
    expect(plan.argv.join(' ')).not.toContain('grok-4.5')
  })

  it('resolves Cursor Grok 4.6 Extra High Fast to its exact wire model', () => {
    const plan = buildCursorPathBLaunchPlan(
      input({
        model: 'grok-4.6',
        reasoningEffort: 'xhigh',
        fastMode: true
      })
    )

    expect(plan.wireModel).toBe('cursor-grok-4.6-xhigh-fast')
    expect(plan.reasoningEffort).toBe('xhigh')
    expect(plan.fastMode).toBe(true)
    expect(plan.argv).toEqual(expect.arrayContaining(['--model', 'cursor-grok-4.6-xhigh-fast']))
  })

  it('rejects contradictory broker outcomes and freezes the final plan', () => {
    expect(() =>
      buildCursorPathBLaunchPlan(
        input({
          brokerOutcome: 'active',
          taskWraithMcpProfileId: 'taskwraith-gateway-v1'
        })
      )
    ).toThrow(/requires broker intent/i)
    expect(() =>
      buildCursorPathBLaunchPlan(
        input({
          brokerRequested: true,
          brokerOutcome: 'not-requested'
        })
      )
    ).toThrow(/cannot carry broker intent/i)

    const plan = buildCursorPathBLaunchPlan(input())
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.argv)).toBe(true)
    expect(Object.isFrozen(plan.controls)).toBe(true)
    expect(Object.isFrozen(plan.broker)).toBe(true)
    expect(Object.isFrozen(plan.broker.allowRules)).toBe(true)
  })
})

// The prompt reaches cursor-agent over stdin, never argv (see the ceiling note
// in CursorCliArgs). The plan still carries the exact provider-visible prompt —
// runCursorProvider writes plan.prompt to the child's stdin — but argv must stay
// a bounded, closed set of TaskWraith-authored flags no matter how big it gets.
describe('Cursor Path-B launch plan keeps the prompt out of argv', () => {
  it('exposes the exact prompt while argv carries none of it', () => {
    const plan = buildCursorPathBLaunchPlan(input({}))
    expect(plan.prompt).toContain(PROMPT)
    expect(plan.argv).not.toContain(plan.prompt)
    expect(plan.argv).not.toContain('--')
    expect(Math.max(...plan.argv.map((token) => token.length))).toBeLessThan(512)
  })

  it('keeps argv bounded for a prompt far past the cursor-agent argv ceiling', () => {
    // 600KB — comfortably past the 465,459-byte total-argv ceiling at which
    // cursor-agent exits 0 with no output at all.
    const plan = buildCursorPathBLaunchPlan(input({ prompt: 'y'.repeat(600_000) }))
    expect(plan.prompt.length).toBeGreaterThan(465_459)
    expect(Math.max(...plan.argv.map((token) => token.length))).toBeLessThan(512)
  })
})
