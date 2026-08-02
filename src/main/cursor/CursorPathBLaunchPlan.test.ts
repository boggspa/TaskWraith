import { describe, expect, it } from 'vitest'
import { TASKWRAITH_GATEWAY_MCP_PROFILE_NOTE } from '../PromptComposition'
import {
  buildCursorPathBLaunchPlan,
  resolveCursorPathBBrokerPolicy,
  type CursorPathBLaunchPlanInput
} from './CursorPathBLaunchPlan'

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
      WORKSPACE,
      '--',
      PROMPT
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

    expect(plan.prompt).toBe(PROMPT)
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

  it('keeps write seats native-read-only unless the exact broker is active', () => {
    const degraded = buildCursorPathBLaunchPlan(
      input({
        writeCapable: true,
        brokerRequested: true,
        brokerOutcome: 'native-only-degraded',
        taskWraithMcpProfileId: 'taskwraith-full-v1'
      })
    )
    expect(degraded.controls.executionMode).toBe('ask')
    expect(degraded.argv).toContain('ask')
    expect(degraded.argv).not.toContain('--force')

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
  })

  it('resolves Cursor Grok reasoning and fast controls into the wire model', () => {
    const plan = buildCursorPathBLaunchPlan(
      input({
        model: 'grok-4.5',
        reasoningEffort: 'high',
        fastMode: true
      })
    )

    expect(plan.wireModel).toBe('grok-4.5-fast-xhigh')
    expect(plan.reasoningEffort).toBe('high')
    expect(plan.fastMode).toBe(true)
    expect(plan.argv).toEqual(expect.arrayContaining(['--model', 'grok-4.5-fast-xhigh']))
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
