import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  ParticipantPickerCluster,
  buildParticipantProviderModelPatch,
  buildParticipantPickerProviderGroups,
  buildParticipantReasoningSelectionPatch
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
  it('carries permissions and grants across providers while clearing runtime/session hygiene', () => {
    const patch = buildParticipantProviderModelPatch(
      participant({
        runtimeProfileId: 'claude-runtime',
        permissionPresetId: 'workspace_write',
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
      permissionPresetId: 'workspace_write',
      permissionOverrides: { approvalMode: 'full_access' },
      // Ultracode → nearest Codex stop on mini (xhigh ladder top for that row)
      reasoningEffort: 'xhigh',
      // Fast drops: gpt-5.4-mini is not Fast-capable
      fastModeEnabled: false,
      serviceTier: '',
      linkedProviderSessionId: null
    })
    expect(patch).toHaveProperty('runtimeProfileId', undefined)
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

  it('maps previous reasoning to the closest enabled ladder stop across providers', () => {
    expect(
      buildParticipantProviderModelPatch(
        participant({ reasoningEffort: 'high', permissionPresetId: 'read_only' }),
        'codex',
        'gpt-5.6-sol'
      )
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      permissionPresetId: 'read_only',
      reasoningEffort: 'high',
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
      serviceTier: 'fast',
      thinkingEnabled: true
    })
  })

  it('maps an existing AntiGravity participant to High when UltraTask is selected', () => {
    const source = participant({
      provider: 'antigravity',
      model: 'gemini-3.6-flash-medium'
    })
    const patch = buildParticipantReasoningSelectionPatch(
      source,
      'gemini-3.6-flash-medium',
      'ultraTask',
      [
        { id: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' },
        { id: 'gemini-3.6-flash-medium', label: 'gemini-3.6-flash-medium' },
        { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' }
      ]
    )

    expect(patch).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-3.6-flash-high',
      reasoningEffort: 'ultraTask'
    })
  })

  it('clears K2.7 UltraTask when the fixed Thinking stop is selected', () => {
    expect(
      buildParticipantReasoningSelectionPatch(
        participant({
          provider: 'kimi',
          model: 'kimi-k2.7-code',
          reasoningEffort: 'ultraTask',
          thinkingEnabled: true
        }),
        'kimi-k2.7-code',
        'on'
      )
    ).toEqual({ reasoningEffort: undefined, thinkingEnabled: true })
  })
})

describe('ParticipantPickerCluster', () => {
  it('forwards one nested-layer class to both body-portaled pickers', () => {
    const source = readFileSync(new URL('./ParticipantPickerCluster.tsx', import.meta.url), 'utf8')
    expect(source.match(/popoverClassName=\{nestedPopoverClassName\}/g) || []).toHaveLength(2)
  })

  it('always offers live-selectable providers even when discovery omits them', () => {
    expect(
      buildParticipantPickerProviderGroups(
        true,
        true,
        { ready: true, providerIds: ['claude', 'cursor'] },
        'kimi'
      ).map((group) => group.provider)
    ).toEqual(['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama', 'pi', 'mistral', 'muse'])
  })

  it('uses authenticated AntiGravity models only from the configured snapshot', () => {
    const groups = buildParticipantPickerProviderGroups(
      false,
      false,
      {
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: {
          antigravity: [{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }]
        }
      },
      'claude'
    )

    // Live providers still show; AntiGravity carries its snapshot-authenticated
    // models and ranks above local Ollama (below the CLI lanes).
    expect(groups).toMatchObject([
      { provider: 'codex' },
      { provider: 'claude' },
      { provider: 'kimi' },
      { provider: 'cursor' },
      { provider: 'grok' },
      {
        provider: 'antigravity',
        modelOptions: [{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }]
      },
      { provider: 'ollama' },
      { provider: 'pi' },
      { provider: 'mistral' },
      { provider: 'muse' }
    ])
  })

  it('groups AntiGravity effort variants and preserves the selected tier in its row', () => {
    const groups = buildParticipantPickerProviderGroups(
      false,
      false,
      {
        ready: true,
        providerIds: ['antigravity'],
        modelsByProvider: {
          antigravity: [
            { id: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' },
            { id: 'gemini-3.6-flash-medium', label: 'gemini-3.6-flash-medium' },
            { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' }
          ]
        }
      },
      'antigravity',
      'gemini-3.6-flash-high'
    )

    expect(groups.find((group) => group.provider === 'antigravity')?.modelOptions).toMatchObject([
      { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash' }
    ])
  })

  it('keeps live providers visible while discovery is pending', () => {
    expect(
      buildParticipantPickerProviderGroups(
        true,
        true,
        { ready: false, providerIds: [] },
        'kimi'
      ).map((group) => group.provider)
    ).toEqual(['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama', 'pi', 'mistral', 'muse'])
  })

  it('never leaks retired or flag-gated providers through the configured snapshot', () => {
    // gemini (retired) cannot be smuggled in via the snapshot. Grok and Cursor
    // are no longer flag-gated — every statically live provider (including Pi
    // Mistral, and Muse) shows regardless of what the snapshot lists; only
    // antigravity stays conditional on the snapshot admitting it, and this
    // snapshot never does.
    expect(
      buildParticipantPickerProviderGroups(
        false,
        false,
        { ready: true, providerIds: ['gemini', 'grok', 'codex'] },
        'claude'
      ).map((group) => group.provider)
    ).toEqual(['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama', 'pi', 'mistral', 'muse'])
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
    // The model label is prefix-free ("Opus 4.8 1M Legacy") — the provider
    // span supplies "Claude", so the chip no longer reads "Claude Claude …".
    expect(html).toContain('Opus 4.8 1M Legacy')
    expect(html).not.toContain('Claude Opus 4.8 1M')
    expect(html).not.toContain('data-composer-control="provider"')
    expect(html).toContain('data-composer-control="permission"')
  })

  it.each([
    ['openrouter/cohere/north-mini-code:free', 'North Mini Code (OpenRouter Free)'],
    ['openrouter/minimax/minimax-m3:free', 'MiniMax M3 (OpenRouter Free)'],
    ['openrouter/thinkingmachines/inkling:free', 'Inkling (OpenRouter Free)'],
    ['openrouter/thinkingmachines/inkling-small:free', 'Inkling Small (OpenRouter Free)']
  ])('humanises the Pi Add Participant row for %s and starts it at High', (model, label) => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={
          participant({
            provider: 'pi',
            model,
            reasoningEffort: undefined,
            permissionPresetId: 'default'
          })
        }
        configuredProviderSnapshot={{ ready: true, providerIds: ['pi'] }}
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain(`composer-combined-picker-trigger-primary">${label}</span>`)
    expect(html).toContain('data-selected-reasoning="high"')
    expect(html).toContain('composer-combined-picker-trigger-suffix">High</span>')
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

  it('passes K3 Max to the reasoning ladder instead of its legacy thinking flag', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={
          participant({
            provider: 'kimi',
            model: 'kimi-k3',
            reasoningEffort: 'max',
            thinkingEnabled: true
          })
        }
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('data-selected-reasoning="max"')
    expect(html).toContain('K3')
    expect(html).toContain('>Max<')
    expect(html).not.toContain('data-selected-reasoning="on"')
  })

  it('keeps a K2.7 UltraTask selection above its fixed thinking stop', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={
          participant({
            provider: 'kimi',
            model: 'kimi-k2.7-code',
            reasoningEffort: 'ultraTask',
            thinkingEnabled: true
          })
        }
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('data-selected-reasoning="ultraTask"')
    expect(html).toContain('composer-combined-picker-trigger-suffix">UltraTask')
  })

  it('surfaces an Ollama participant boolean thinking selection', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={participant({
          provider: 'ollama',
          model: 'ornith:35b',
          reasoningEffort: 'on'
        })}
        composerStyle="default"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('data-selected-reasoning="on"')
    expect(html).toContain('composer-combined-picker-trigger-suffix">Thinking</span>')
    expect(html).toContain('Ornith 1.0 (35B Param)')
  })

  it('uses AntiGravity model variants as its selected reasoning tier', () => {
    const html = renderToStaticMarkup(
      <ParticipantPickerCluster
        participant={participant({
          provider: 'antigravity',
          model: 'gemini-3.6-flash-high'
        })}
        configuredProviderSnapshot={{
          ready: true,
          providerIds: ['antigravity'],
          modelsByProvider: {
            antigravity: [
              { id: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' },
              { id: 'gemini-3.6-flash-medium', label: 'gemini-3.6-flash-medium' },
              { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' }
            ]
          }
        }}
        composerStyle="gemini"
        grokAvailable
        cursorAvailable
        onPatch={() => undefined}
      />
    )

    expect(html).toContain('data-selected-reasoning="high"')
    expect(html).toContain('composer-combined-picker-trigger-suffix">High</span>')
    expect(html).toContain('Gemini 3.6 Flash')
  })
})
