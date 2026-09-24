import { describe, expect, it } from 'vitest'

import type { TuiHomeTuneProvider } from './state'
import {
  findTuiModelChoiceIndex,
  nextAvailableTuiPosture,
  resolveTuiHomePosture,
  resolveTuiHomePostureDetail,
  tuiModelChoices,
  tuiPostureCeilingNote,
  tuiProviderWriteDisclosure
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

describe('provider write-capability disclosure', () => {
  function providerWith(
    postures: TuiHomeTuneProvider['offers']['postures'],
    label = 'AntiGravity'
  ): TuiHomeTuneProvider {
    return {
      status: { providerId: 'antigravity', status: 'ready', label },
      offers: {
        providerId: 'antigravity',
        offerRevision: 'rev',
        models: [{ modelId: 'm', label: 'M', available: true, reasoning: [] }],
        postures
      }
    }
  }

  const planOnly = [
    {
      postureId: 'plan',
      label: 'Plan',
      available: true,
      requiresExplicitConsent: false,
      ceiling: 'read' as const
    },
    {
      postureId: 'default',
      label: 'Accept Edits',
      available: false,
      requiresExplicitConsent: false,
      ceiling: 'workspace_write' as const,
      detail: 'The standalone Host has not yet proved the agy write-approval bridge.'
    }
  ]

  it('discloses that a plan-only provider cannot modify files', () => {
    // A user can otherwise pick this provider, ask for an edit, and get only a
    // failure — the user's "turns fail with nothing evidently wrong".
    const disclosure = tuiProviderWriteDisclosure(providerWith(planOnly))

    expect(disclosure.canModifyFiles).toBe(false)
    expect(disclosure.notice).toContain('AntiGravity cannot modify files')
  })

  it("quotes the Host's own reason rather than inventing one", () => {
    const disclosure = tuiProviderWriteDisclosure(providerWith(planOnly))

    expect(disclosure.notice).toContain('agy write-approval bridge')
  })

  it('stays silent for a provider that really can edit', () => {
    const disclosure = tuiProviderWriteDisclosure(providers[0]!)

    expect(disclosure.canModifyFiles).toBe(true)
    expect(disclosure.notice).toBeUndefined()
  })

  it('treats an offered-but-unavailable editing tier as no capability', () => {
    // available:false is exactly how the Host withholds a tier, so ignoring the
    // flag would advertise write capability the provider does not have.
    expect(tuiProviderWriteDisclosure(providerWith(planOnly)).canModifyFiles).toBe(false)
  })

  it('claims nothing when no postures have been offered yet', () => {
    // Offers can be empty while still loading. Branding a provider read-only on
    // absent evidence is a false restriction — the opposite of the bug this
    // fixes — so silence is the only honest answer.
    const disclosure = tuiProviderWriteDisclosure(providerWith([]))

    expect(disclosure.canModifyFiles).toBe(true)
    expect(disclosure.notice).toBeUndefined()
  })

  it('does not claim incapability merely because a tier needs consent', () => {
    const consentOnly = [
      {
        postureId: 'workspace_write',
        label: 'Full WS Access',
        available: true,
        requiresExplicitConsent: true,
        ceiling: 'workspace_write' as const
      }
    ]

    expect(tuiProviderWriteDisclosure(providerWith(consentOnly)).canModifyFiles).toBe(true)
  })
})

describe('posture authority-ceiling disclosure', () => {
  const claudeTiers = [
    {
      postureId: 'plan',
      label: 'Plan',
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
    }
  ]

  it('says when the current tier shares its ceiling with another offered tier', () => {
    // The user said permissions are "switchable but I worry it doesn't work
    // properly". For Claude both editing tiers reach the CLI as acceptEdits —
    // deliberate and documented, so we disclose it rather than re-map it.
    const note = tuiPostureCeilingNote(claudeTiers, 'default')

    expect(note).toBe(
      'Accept Edits and Full WS Access share one authority ceiling (workspace write).'
    )
  })

  it('stays silent for a tier whose ceiling is unique', () => {
    expect(tuiPostureCeilingNote(claudeTiers, 'plan')).toBeUndefined()
  })

  it('ignores tiers the Host is not offering', () => {
    const withdrawn = claudeTiers.map((posture) =>
      posture.postureId === 'workspace_write' ? { ...posture, available: false } : posture
    )

    expect(tuiPostureCeilingNote(withdrawn, 'default')).toBeUndefined()
  })

  it('says nothing when the current posture is not offered at all', () => {
    expect(tuiPostureCeilingNote(claudeTiers, 'full_access')).toBeUndefined()
    expect(tuiPostureCeilingNote(claudeTiers, undefined)).toBeUndefined()
  })
})
