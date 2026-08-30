import { describe, expect, it } from 'vitest'
import { buildCodexAppServerThreadLaunchPlan } from './CodexAppServerThreadLaunchPlan'

describe('Codex app-server immutable thread launch plan', () => {
  it('builds the exact fresh thread/start request with optional fields preserved', () => {
    const plan = buildCodexAppServerThreadLaunchPlan({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      serviceTier: 'fast',
      workspacePath: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      resumableThreadId: null
    })

    expect(plan.request).toEqual({
      method: 'thread/start',
      params: {
        cwd: '/workspace',
        model: 'gpt-5.6-terra',
        config: expect.objectContaining({ model_reasoning_effort: 'high' }),
        serviceTier: 'fast',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        experimentalRawEvents: false,
        persistExtendedHistory: true
      }
    })
    expect(plan.fallbackPolicy).toBe('forbid')
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.reasoning)).toBe(true)
    expect(Object.isFrozen(plan.reasoning.turnParams)).toBe(true)
    expect(Object.isFrozen(plan.reasoning.execConfigArgs)).toBe(true)
    expect(Object.isFrozen(plan.threadConfig)).toBe(true)
    expect(Object.isFrozen(plan.request)).toBe(true)
    expect(Object.isFrozen(plan.request.params)).toBe(true)
  })

  it('builds resume from the final continuity result and omits fresh-only controls', () => {
    const plan = buildCodexAppServerThreadLaunchPlan({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      serviceTier: null,
      workspacePath: '/workspace',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      resumableThreadId: '7b057c8b-33fa-4eca-9efe-3313a83669f4'
    })

    expect(plan.request).toEqual({
      method: 'thread/resume',
      params: {
        threadId: '7b057c8b-33fa-4eca-9efe-3313a83669f4',
        config: expect.objectContaining({ model_reasoning_effort: 'medium' }),
        persistExtendedHistory: true
      }
    })
    expect(plan.request.params).not.toHaveProperty('cwd')
    expect(plan.request.params).not.toHaveProperty('serviceTier')
    expect(plan.request.params).not.toHaveProperty('approvalPolicy')
    expect(plan.request.params).not.toHaveProperty('sandbox')
  })

  it('carries the shared Full Access sandbox onto a fresh thread request', () => {
    const plan = buildCodexAppServerThreadLaunchPlan({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      serviceTier: null,
      workspacePath: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      resumableThreadId: null
    })

    expect(plan.request).toMatchObject({
      method: 'thread/start',
      params: {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access'
      }
    })
  })
})
