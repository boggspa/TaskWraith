import { describe, expect, it } from 'vitest'
import {
  ProviderPausedError,
  applyReroutePlanToPayload,
  isProviderPaused,
  resolveProviderDispatch,
  sanitizeProviderRunPauses
} from './ProviderRunPause'
import type { AppSettings, ProviderId } from './store/types'

const NOW = Date.parse('2026-06-13T12:00:00Z')

function settings(
  providerRunPauses: NonNullable<AppSettings['providerRunPauses']>
): Pick<AppSettings, 'providerRunPauses'> {
  return { providerRunPauses }
}

describe('ProviderRunPause', () => {
  it('ignores expired provider pauses', () => {
    const state = settings({
      codex: {
        paused: true,
        until: '2026-06-13T11:59:00.000Z'
      }
    })

    expect(isProviderPaused(state, 'codex', NOW)).toBe(false)
    expect(resolveProviderDispatch(state, 'codex', NOW)).toEqual({ provider: 'codex' })
  })

  it('throws a provider paused error when no reroute is available', () => {
    const state = settings({
      codex: {
        paused: true,
        reason: 'Quota is exhausted.'
      }
    })

    expect(() => resolveProviderDispatch(state, 'codex', NOW)).toThrow(ProviderPausedError)
    expect(() => resolveProviderDispatch(state, 'codex', NOW)).toThrow(
      'Codex is paused for new runs. Reason: Quota is exhausted.'
    )
  })

  it('reroutes paused providers to an available saved fallback', () => {
    const state = settings({
      codex: {
        paused: true,
        reason: 'Quota wall',
        reroute: {
          provider: 'ollama',
          selectedModelType: 'gpt-oss:20b',
          approvalMode: 'plan'
        }
      }
    })

    const resolution = resolveProviderDispatch(state, 'codex', NOW)
    expect(resolution.provider).toBe('ollama')
    expect(resolution.reroute).toEqual({
      from: 'codex',
      to: 'ollama',
      reason: 'provider-paused',
      savedAsDefault: true
    })

    const routedPayload = applyReroutePlanToPayload(
      {
        provider: 'codex' as ProviderId,
        scope: 'workspace' as const,
        workspace: '/tmp/project',
        prompt: 'Fix the test',
        approvalMode: 'default'
      },
      resolution
    )

    expect(routedPayload.provider).toBe('ollama')
    expect(routedPayload.providerReroute).toEqual(resolution.reroute)
    expect((routedPayload as { model?: string }).model).toBe('gpt-oss:20b')
    expect(routedPayload.approvalMode).toBe('plan')
  })

  it('does not let a reroute plan raise the payload approval mode', () => {
    const resolution = {
      provider: 'ollama' as ProviderId,
      reroute: {
        from: 'codex' as ProviderId,
        to: 'ollama' as ProviderId,
        reason: 'provider-paused' as const
      },
      reroutePlan: {
        provider: 'ollama' as ProviderId,
        approvalMode: 'full_access'
      }
    }

    const routedPayload = applyReroutePlanToPayload(
      {
        provider: 'codex' as ProviderId,
        prompt: 'Read only',
        approvalMode: 'plan'
      },
      resolution
    )

    expect(routedPayload.approvalMode).toBe('plan')
  })

  it('drops original-provider runtime posture when rerouting to another provider', () => {
    const resolution = {
      provider: 'ollama' as ProviderId,
      reroute: {
        from: 'codex' as ProviderId,
        to: 'ollama' as ProviderId,
        reason: 'provider-paused' as const
      },
      reroutePlan: {
        provider: 'ollama' as ProviderId
      }
    }

    const routedPayload = applyReroutePlanToPayload(
      {
        provider: 'codex' as ProviderId,
        prompt: 'Fallback',
        approvalMode: 'default',
        runtimeProfileId: 'codex-profile',
        effectivePermissions: { readOnly: false },
        effectivePermissionsSignature: 'abc'
      },
      resolution
    )

    expect((routedPayload as { runtimeProfileId?: string }).runtimeProfileId).toBeUndefined()
    expect((routedPayload as { effectivePermissions?: unknown }).effectivePermissions).toBeUndefined()
    expect(
      (routedPayload as { effectivePermissionsSignature?: string }).effectivePermissionsSignature
    ).toBeUndefined()
  })

  it('re-resolves active goals for the reroute target provider', () => {
    const resolution = {
      provider: 'grok' as ProviderId,
      reroute: {
        from: 'claude' as ProviderId,
        to: 'grok' as ProviderId,
        reason: 'provider-paused' as const
      },
      reroutePlan: {
        provider: 'grok' as ProviderId
      }
    }

    const routedPayload = applyReroutePlanToPayload(
      {
        provider: 'claude' as ProviderId,
        prompt: '<taskwraith_active_goal>old</taskwraith_active_goal>',
        approvalMode: 'default',
        activeGoal: {
          id: 'goal-1',
          objective: 'Keep goal state portable',
          status: 'active' as const,
          mode: 'taskwraith_steered' as const,
          provider: 'claude' as ProviderId,
          createdAt: '2026-06-22T12:00:00Z',
          updatedAt: '2026-06-22T12:00:00Z'
        }
      },
      resolution
    )

    expect(routedPayload.activeGoal).toMatchObject({
      id: 'goal-1',
      provider: 'grok',
      mode: 'grok_native'
    })
  })

  it('does not reroute into another active pause', () => {
    const state = settings({
      codex: {
        paused: true,
        reroute: { provider: 'ollama' }
      },
      ollama: {
        paused: true
      }
    })

    expect(() => resolveProviderDispatch(state, 'codex', NOW)).toThrow(ProviderPausedError)
  })

  it('sanitizes persisted provider pause settings', () => {
    const sanitized = sanitizeProviderRunPauses({
      codex: {
        paused: true,
        reason: '  Quota wall  ',
        until: 'not-a-date',
        reroute: {
          provider: 'ollama',
          selectedModelType: '  gpt-oss:20b  ',
          unknown: 'ignored'
        }
      },
      madeup: {
        paused: true
      }
    })

    expect(sanitized?.codex?.paused).toBe(true)
    expect(sanitized?.codex?.reason).toBe('Quota wall')
    expect(sanitized?.codex?.until).toBeUndefined()
    expect(sanitized?.codex?.reroute).toEqual({
      provider: 'ollama',
      selectedModelType: 'gpt-oss:20b'
    })
    expect((sanitized as Record<string, unknown>).madeup).toBeUndefined()
  })
})
