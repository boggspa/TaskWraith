import { describe, expect, it, vi } from 'vitest'
import type { ProviderModelsMessage } from '../BridgeBroadcaster'
import {
  buildRemoteProviderModelsMessage,
  createRemoteProviderModelsPublisher,
  createReplayableTrigger
} from './RemoteProviderModels'

describe('buildRemoteProviderModelsMessage', () => {
  it('preserves Pi multi-segment ids and both AntiGravity catalog lanes', async () => {
    const message = await buildRemoteProviderModelsMessage(
      ['pi', 'antigravity'] as const,
      async (provider) =>
        provider === 'pi'
          ? [{ id: 'groq/openai/gpt-oss-120b', label: 'GPT OSS 120B' }]
          : [
              { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash High' },
              { id: 'gemini-api:gemini-2.5-flash', label: 'Gemini 2.5 Flash (API)' }
            ]
    )

    expect(message.providers.map((entry) => entry.provider)).toEqual(['pi', 'antigravity'])
    expect(message.providers[0].models[0].id).toBe('groq/openai/gpt-oss-120b')
    expect(message.providers[1].models.map((model) => model.id)).toEqual([
      'gemini-3.6-flash-high',
      'gemini-api:gemini-2.5-flash'
    ])
  })

  it('normalizes wire fields, filters invalid rows, and caps each provider at 40', async () => {
    const source = [
      null,
      { id: 7 },
      {
        id: 'first',
        isDefault: true,
        disabled: true,
        disabledReason: 'Unavailable',
        supportedReasoningEfforts: [
          null,
          { reasoningEffort: 3 },
          {
            reasoningEffort: 'high',
            description: 'Deep',
            disabled: true,
            disabledReason: 'Quota'
          }
        ],
        defaultReasoningEffort: 'high'
      },
      ...Array.from({ length: 45 }, (_, index) => ({ id: `model-${index}` }))
    ]
    const message = await buildRemoteProviderModelsMessage(['codex'], async () => source)
    const models = message.providers[0].models

    expect(models).toHaveLength(40)
    expect(models[0]).toEqual({
      id: 'first',
      label: 'first',
      isDefault: true,
      disabled: true,
      disabledReason: 'Unavailable',
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'high',
          description: 'Deep',
          disabled: true,
          disabledReason: 'Quota'
        }
      ],
      defaultReasoningEffort: 'high'
    })
  })

  it('isolates provider failures and omits empty catalogs', async () => {
    const message = await buildRemoteProviderModelsMessage(
      ['codex', 'pi', 'ollama'] as const,
      async (provider) => {
        if (provider === 'codex') throw new Error('offline')
        if (provider === 'pi') return []
        return [{ id: 'qwen3.5:9b' }]
      }
    )

    expect(message.providers).toEqual([
      {
        provider: 'ollama',
        models: [
          {
            id: 'qwen3.5:9b',
            label: 'qwen3.5:9b',
            isDefault: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null
          }
        ]
      }
    ])
  })
})

describe('createRemoteProviderModelsPublisher', () => {
  it('suppresses an older build that resolves after a newer generation', async () => {
    const resolveBuilds: Array<(message: ProviderModelsMessage) => void> = []
    const publish = vi.fn()
    const publisher = createRemoteProviderModelsPublisher({
      build: () =>
        new Promise<ProviderModelsMessage>((resolve) => {
          resolveBuilds.push(resolve)
        }),
      publish
    })

    const older = publisher.refresh()
    const newer = publisher.refresh()
    const latest = {
      providers: [{ provider: 'pi', models: [{ id: 'new', label: 'New' }] }]
    }
    resolveBuilds[1](latest)
    expect(await newer).toBe(true)
    resolveBuilds[0]({
      providers: [{ provider: 'pi', models: [{ id: 'old', label: 'Old' }] }]
    })
    expect(await older).toBe(false)
    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith(latest)
  })
})

describe('createReplayableTrigger', () => {
  it('coalesces pre-registration requests and runs later requests immediately', () => {
    const trigger = createReplayableTrigger()
    const run = vi.fn()

    trigger.request()
    trigger.request()
    expect(run).not.toHaveBeenCalled()
    trigger.register(run)
    expect(run).toHaveBeenCalledOnce()
    trigger.request()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
