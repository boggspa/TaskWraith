import { describe, expect, it } from 'vitest'

import type { TuiHomeTuneProvider } from './state'
import {
  findTuiModelChoiceIndex,
  nextAvailableTuiPosture,
  resolveTuiHomePosture,
  resolveTuiHomePostureDetail,
  tuiModelChoices
} from './modelPicker'

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
      postures: [
        {
          postureId: 'default',
          label: 'Accept Edits',
          available: true,
          requiresExplicitConsent: false,
          ceiling: 'workspace_write'
        },
        {
          postureId: 'workspace_write',
          label: 'Full WS Access',
          available: true,
          requiresExplicitConsent: true,
          ceiling: 'workspace_write'
        }
      ]
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

  it('binds a Home permission choice to the selected provider and live offer', () => {
    expect(resolveTuiHomePosture(providers, 0)?.postureId).toBe('default')
    expect(
      resolveTuiHomePosture(providers, 0, {
        providerId: 'codex',
        postureId: 'workspace_write'
      })?.postureId
    ).toBe('workspace_write')
    expect(
      resolveTuiHomePosture(providers, 2, {
        providerId: 'codex',
        postureId: 'workspace_write'
      })
    ).toBeUndefined()
  })

  it('reports a lapsed Home tier instead of quietly substituting Accept Edits', () => {
    // The user picked Full WS Access while it was offered and a later refresh
    // withdrew it. Home's own thread creation looks for that exact posture and
    // refuses when it is gone, so resolving to `default` here advertised a tier
    // the very next send would decline.
    const withdrawn: TuiHomeTuneProvider[] = [
      {
        ...providers[0],
        offers: {
          ...providers[0].offers,
          postures: providers[0].offers.postures.map((posture) =>
            posture.postureId === 'workspace_write' ? { ...posture, available: false } : posture
          )
        }
      }
    ]
    const selection = { providerId: 'codex', postureId: 'workspace_write' }

    const lapsed = resolveTuiHomePostureDetail(withdrawn, 0, selection)
    expect(lapsed.posture).toBeUndefined()
    expect(lapsed.downgradedFrom).toBe('workspace_write')
    expect(resolveTuiHomePosture(withdrawn, 0, selection)).toBeUndefined()

    // A provider the user never chose a tier for is a resting state rather than
    // a discarded choice, so it still resolves to the standard edit posture.
    const untouched = resolveTuiHomePostureDetail(withdrawn, 0)
    expect(untouched.posture?.postureId).toBe('default')
    expect(untouched.downgradedFrom).toBeUndefined()
  })
})
