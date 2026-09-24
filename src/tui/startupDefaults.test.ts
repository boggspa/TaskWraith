import { describe, expect, it } from 'vitest'
import type {
  HostProviderModelOffer,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import {
  resolveStartupModel,
  resolveStartupPosture,
  resolveStartupProvider,
  resolveStartupReasoning,
  resolveStartupWorkspaceId
} from './startupDefaults'

function provider(
  providerId: string,
  status: HostProviderStatusProjection['status']
): HostProviderStatusProjection {
  return { providerId, status, label: providerId }
}

function model(
  modelId: string,
  options: Partial<HostProviderModelOffer> = {}
): HostProviderModelOffer {
  return {
    modelId,
    label: modelId,
    available: true,
    reasoning: [],
    ...options
  }
}

function offers(
  overrides: Partial<HostProviderOffersProjection> = {}
): HostProviderOffersProjection {
  return {
    providerId: 'claude',
    offerRevision: 'revision-1',
    models: [],
    postures: [],
    ...overrides
  }
}

describe('TUI startup defaults', () => {
  it('prefers a saved ready provider, then ready Claude, then the first ready provider', () => {
    const statuses = [
      provider('codex', 'ready'),
      provider('claude', 'ready'),
      provider('grok', 'ready')
    ]

    expect(resolveStartupProvider(statuses, 'grok')?.providerId).toBe('grok')
    expect(resolveStartupProvider(statuses, 'missing')?.providerId).toBe('claude')
    expect(
      resolveStartupProvider([provider('codex', 'ready'), provider('claude', 'unavailable')])
        ?.providerId
    ).toBe('codex')
  })

  it('does not auto-select auth-required or unavailable providers', () => {
    const statuses = [provider('claude', 'auth_required'), provider('codex', 'ready')]

    expect(resolveStartupProvider(statuses, 'claude')?.providerId).toBe('codex')
    expect(resolveStartupProvider([provider('claude', 'auth_required')])).toBeUndefined()
  })

  it('prefers an available saved model, then the advertised default, then the first available', () => {
    const projected = offers({
      models: [
        model('unavailable-saved', { available: false }),
        model('first'),
        model('host-default', { default: true }),
        model('saved')
      ]
    })

    expect(resolveStartupModel(projected, 'saved')?.modelId).toBe('saved')
    expect(resolveStartupModel(projected, 'unavailable-saved')?.modelId).toBe('host-default')
    expect(
      resolveStartupModel(offers({ models: [model('first'), model('second')] }))?.modelId
    ).toBe('first')
    expect(resolveStartupModel(offers())).toBeUndefined()
  })

  it('requires the exact available default posture for lazy startup', () => {
    const projected = offers({
      postures: [
        {
          postureId: 'read_only',
          label: 'Read only',
          available: true,
          requiresExplicitConsent: false,
          ceiling: 'read'
        },
        {
          postureId: 'default',
          label: 'Accept edits',
          available: true,
          requiresExplicitConsent: false,
          ceiling: 'workspace_write'
        }
      ]
    })

    expect(resolveStartupPosture(projected)?.postureId).toBe('default')
    expect(
      resolveStartupPosture(offers({ postures: projected.postures.slice(0, 1) }))
    ).toBeUndefined()
    expect(
      resolveStartupPosture(offers({ postures: [{ ...projected.postures[1], available: false }] }))
    ).toBeUndefined()
  })

  it('retains saved reasoning only while the selected model offers it', () => {
    const selected = model('model-1', {
      reasoning: [
        { reasoningId: 'medium', label: 'Medium', available: true },
        { reasoningId: 'high', label: 'High', available: false }
      ]
    })

    expect(resolveStartupReasoning(selected, 'medium')?.reasoningId).toBe('medium')
    expect(resolveStartupReasoning(selected, 'high')).toBeUndefined()
    expect(resolveStartupReasoning(selected, 'missing')).toBeUndefined()
    expect(resolveStartupReasoning(selected)).toBeUndefined()
  })

  it('resolves workspace memory, then the current thread, then the most recent workspace', () => {
    const workspaces = [
      { id: 'older', updatedAt: 10 },
      { id: 'newest', updatedAt: 30 },
      { id: 'current', updatedAt: 20 }
    ]

    expect(
      resolveStartupWorkspaceId({
        workspaces,
        savedWorkspaceId: 'older',
        currentThreadWorkspaceId: 'current'
      })
    ).toBe('older')
    expect(
      resolveStartupWorkspaceId({
        workspaces,
        savedWorkspaceId: 'missing',
        currentThreadWorkspaceId: 'current'
      })
    ).toBe('current')
    expect(
      resolveStartupWorkspaceId({
        workspaces,
        savedWorkspaceId: 'missing',
        currentThreadWorkspaceId: 'missing'
      })
    ).toBe('newest')
    expect(resolveStartupWorkspaceId({ workspaces: [] })).toBeUndefined()
  })
})
