import { describe, expect, it } from 'vitest'

import type { TuiHomeTuneProvider } from './state'
import { findTuiModelChoiceIndex, nextAvailableTuiPosture, tuiModelChoices } from './modelPicker'

const providers: TuiHomeTuneProvider[] = [
  {
    status: { providerId: 'codex', status: 'ready', label: 'Codex' },
    offers: {
      providerId: 'codex',
      offerRevision: 'codex-rev',
      models: [
        { modelId: 'sol', label: 'Sol', available: true, reasoning: [] },
        { modelId: 'terra', label: 'Terra', available: true, default: true, reasoning: [] }
      ],
      postures: []
    }
  },
  {
    status: { providerId: 'claude', status: 'ready', label: 'Claude' },
    offers: {
      providerId: 'claude',
      offerRevision: 'claude-rev',
      models: [{ modelId: 'opus', label: 'Opus', available: true, reasoning: [] }],
      postures: []
    }
  }
]

describe('combined TUI model picker', () => {
  it('flattens every ready provider into one stable model list', () => {
    expect(tuiModelChoices(providers).map((choice) => choice.model.modelId)).toEqual([
      'sol',
      'terra',
      'opus'
    ])
    expect(findTuiModelChoiceIndex(tuiModelChoices(providers), 'claude', 'opus')).toBe(2)
  })

  it('cycles permission tiers in app order while skipping unavailable authority', () => {
    const postures = [
      {
        postureId: 'plan',
        label: 'Plan',
        available: true,
        requiresExplicitConsent: false,
        ceiling: 'read' as const
      },
      {
        postureId: 'read_only',
        label: 'Ask',
        available: true,
        requiresExplicitConsent: false,
        ceiling: 'read' as const
      },
      {
        postureId: 'default',
        label: 'Accept Edits',
        available: true,
        requiresExplicitConsent: false,
        ceiling: 'workspace_write' as const
      },
      {
        postureId: 'workspace_write',
        label: 'Full WS Access',
        available: true,
        requiresExplicitConsent: true,
        ceiling: 'workspace_write' as const
      },
      {
        postureId: 'full_access',
        label: 'Full Access (YOLO)',
        available: false,
        requiresExplicitConsent: true,
        ceiling: 'full_access' as const
      }
    ]
    expect(nextAvailableTuiPosture(postures, 'workspace_write')?.postureId).toBe('plan')
    expect(nextAvailableTuiPosture(postures, 'plan')?.postureId).toBe('read_only')
  })
})
