import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  ParticipantPickerCluster,
  buildParticipantProviderModelPatch,
  buildParticipantPickerProviderGroups
} from './ParticipantPickerCluster'

function participant(
  overrides: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id: 'participant-1',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    instructions: 'Review the work.',
    order: 1,
    model: 'claude-opus-4-8-1m',
    permissionPresetId: 'full_access',
    ...overrides
  }
}

describe('buildParticipantProviderModelPatch', () => {
  it('atomically resets provider-scoped configuration and normalizes the chosen model', () => {
    const patch = buildParticipantProviderModelPatch(
      participant({
        runtimeProfileId: 'claude-runtime',
        permissionOverrides: { approvalMode: 'full_access' },
        linkedProviderSessionId: 'claude-session',
        reasoningEffort: 'ultracode',
        fastModeEnabled: true
      }),
      'codex',
      'gpt-5.4-mini'
    )

    expect(patch).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.4-mini',
      permissionPresetId: 'default',
      reasoningEffort: 'medium',
      fastModeEnabled: false,
      serviceTier: '',
      linkedProviderSessionId: null
    })
    expect(patch).toHaveProperty('runtimeProfileId', undefined)
    expect(patch).toHaveProperty('permissionOverrides', undefined)
  })

  it('preserves runtime and permission settings on a same-provider model change', () => {
    const patch = buildParticipantProviderModelPatch(
      participant({
        runtimeProfileId: 'claude-runtime',
        permissionOverrides: { approvalMode: 'full_access' },
        reasoningEffort: 'ultracode',
        fastModeEnabled: true
      }),
      'claude',
      'claude-haiku-4-5'
    )

    expect(patch).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-4-5',
      reasoningEffort: undefined,
      fastModeEnabled: false
    })
    expect(patch).not.toHaveProperty('runtimeProfileId')
    expect(patch).not.toHaveProperty('permissionPresetId')
    expect(patch).not.toHaveProperty('permissionOverrides')
  })

  it('uses the selected model default when switching providers', () => {
    expect(
      buildParticipantProviderModelPatch(participant(), 'codex', 'gpt-5.6-sol')
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
      fastModeEnabled: false,
      serviceTier: ''
    })
  })

  it('treats Cursor Composer plain and Fast model rows as explicit speed choices', () => {
    const source = participant({ provider: 'cursor', model: 'composer-2.5-fast' })

    expect(
      buildParticipantProviderModelPatch(source, 'cursor', 'composer-2.5')
    ).toMatchObject({ model: 'composer-2.5', fastModeEnabled: false })
    expect(
      buildParticipantProviderModelPatch(source, 'cursor', 'composer-2.5-fast')
    ).toMatchObject({ model: 'composer-2.5-fast', fastModeEnabled: true })
  })

  it('preserves a selected Kimi HighSpeed tier across its K2.7 model row', () => {
    const source = participant({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      fastModeEnabled: true,
      serviceTier: 'fast',
      thinkingEnabled: true
    })

    const patch = buildParticipantProviderModelPatch(source, 'kimi', 'kimi-k2.7-code')

    expect(patch).toMatchObject({
      model: 'kimi-k2.7-code',
      fastModeEnabled: true,
      serviceTier: 'fast'
    })
    expect(patch).not.toHaveProperty('thinkingEnabled')
  })
})

describe('ParticipantPickerCluster', () => {
  it('limits provider choices to the ready connected snapshot', () => {
    expect(
      buildParticipantPickerProviderGroups(
        true,
        true,
        { ready: true, providerIds: ['claude', 'cursor'] },
        'kimi'
      ).map((group) => group.provider)
    ).toEqual(['claude', 'cursor'])
  })

  it('keeps only the current provider while discovery is pending', () => {
    expect(
      buildParticipantPickerProviderGroups(
        true,
        true,
        { ready: false, providerIds: [] },
        'kimi'
      ).map((group) => group.provider)
    ).toEqual(['kimi'])
  })

  it('never leaks retired, missing, or runtime-unavailable providers', () => {
    expect(
      buildParticipantPickerProviderGroups(
        false,
        false,
        { ready: true, providerIds: ['gemini', 'grok', 'codex'] },
        'claude'
      ).map((group) => group.provider)
    ).toEqual(['codex'])
  })

  it('keeps an existing disconnected participant visible and editable', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={
          participant({
            provider: 'kimi',
            model: 'kimi-k2.7-code',
            thinkingEnabled: true
          })
        }
        configuredProviderSnapshot={{ ready: true, providerIds: ['codex'] }}
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('Kimi')
    expect(html).toContain('K2.7 Coding')
    expect(html).toContain('data-composer-control="permission"')
  })

  it('renders one unified provider/model trigger plus the permissions picker', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={participant()}
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('data-composer-control="model"')
    expect(html).toContain('composer-combined-picker-trigger-provider')
    expect(html).toContain('Claude')
    expect(html).toContain('Claude Opus 4.8 1M')
    expect(html).not.toContain('data-composer-control="provider"')
    expect(html).toContain('data-composer-control="permission"')
  })

  it('marks a HighSpeed Kimi participant as Fast while retaining the K2.7 model row', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={
          participant({
            provider: 'kimi',
            model: 'kimi-k2.7-code',
            fastModeEnabled: true,
            serviceTier: 'fast',
            thinkingEnabled: true
          })
        }
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('data-fast-mode-active="true"')
    expect(html).toContain('K2.7 Coding')
  })
})
