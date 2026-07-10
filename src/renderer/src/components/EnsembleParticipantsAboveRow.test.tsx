import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_CHIP_GRID_TRACKS,
  EnsembleParticipantAuthorityControls,
  EnsembleParticipantStageControl,
  EnsembleParticipantsAboveRow,
  buildEnsembleAddProviderGroups,
  buildEnsembleParticipantAddition,
  computeEnsembleChipGridSpans,
  computeEnsembleChipRowDistribution,
  createEnsembleParticipantAddConfiguration,
  resolveEnsembleAddProviderGroups,
  resolveEnsembleParticipantAuthorityPatch,
  resolveParticipantSelectionAfterRemoval
} from './EnsembleParticipantsAboveRow'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

function makeParticipant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: 'ensemble-claude',
    provider: 'claude',
    enabled: true,
    role: 'Explorer',
    instructions: '',
    order: 1,
    model: 'claude-opus-4-7',
    permissionPresetId: 'read_only',
    ...overrides
  }
}

function makeChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    provider: 'claude',
    title: 'New Ensemble',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      participants
    }
  }
}

describe('EnsembleParticipantsAboveRow', () => {
  describe('participant authority controls', () => {
    const autoApprovals = {
      enabled: true,
      mode: 'permission_preset_once' as const,
      confirmedAt: '2026-07-10T03:00:00.000Z'
    }

    it('moves Boss and Captain atomically while preserving thread-wide consent', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            secondInCommandParticipantId: 'captain',
            bossmanAutoApprovals: autoApprovals
          },
          'captain',
          'boss'
        )
      ).toEqual({
        bossmanParticipantId: 'captain',
        secondInCommandParticipantId: undefined,
        bossmanAutoApprovals: autoApprovals
      })

      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            secondInCommandParticipantId: 'captain',
            bossmanAutoApprovals: autoApprovals
          },
          'boss',
          'captain'
        )
      ).toEqual({
        bossmanParticipantId: undefined,
        secondInCommandParticipantId: 'boss',
        bossmanAutoApprovals: autoApprovals
      })
    })

    it('clears only this participant authority and drops consent after the final leader', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            secondInCommandParticipantId: 'captain',
            bossmanAutoApprovals: autoApprovals
          },
          'boss',
          'agent'
        )
      ).toEqual({
        bossmanParticipantId: undefined,
        secondInCommandParticipantId: 'captain',
        bossmanAutoApprovals: autoApprovals
      })

      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: undefined,
            secondInCommandParticipantId: 'captain',
            bossmanAutoApprovals: autoApprovals
          },
          'captain',
          'agent'
        )
      ).toEqual({
        bossmanParticipantId: undefined,
        secondInCommandParticipantId: undefined,
        bossmanAutoApprovals: undefined
      })
    })

    it('normalizes malformed legacy authority overlap', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'leader',
            secondInCommandParticipantId: 'leader',
            bossmanAutoApprovals: autoApprovals
          },
          'agent',
          'agent'
        )
      ).toEqual({
        bossmanParticipantId: 'leader',
        secondInCommandParticipantId: undefined,
        bossmanAutoApprovals: autoApprovals
      })
    })

    it('renders shared pill toggles and one three-way radio control without checkboxes', () => {
      const html = renderToStaticMarkup(
        <EnsembleParticipantAuthorityControls
          participantLabel="Claude Fable 5"
          enabled
          authority="agent"
          hasLeadership
          autoApprovalsEnabled
          locked={false}
          onEnabledChange={() => undefined}
          onAuthorityChange={() => undefined}
          onAutoApprovalsChange={() => undefined}
        />
      )

      expect(html).not.toContain('type="checkbox"')
      expect(html).toContain('segmented-control-action')
      expect(html).toContain('>Enabled</button>')
      expect(html).toContain('>Auto</button>')
      expect(html.match(/aria-pressed="true"/g) || []).toHaveLength(2)
      expect(html).toContain('role="radiogroup"')
      expect(html.match(/role="radio"/g) || []).toHaveLength(3)
      expect(html).toContain('>Boss</span>')
      expect(html).toContain('>Captain</span>')
      expect(html).toContain('aria-checked="true"')
      expect(html).toContain('>Agent</button>')
    })

    it('disables and visually normalizes global Auto when no leader exists', () => {
      const html = renderToStaticMarkup(
        <EnsembleParticipantAuthorityControls
          participantLabel="Codex"
          enabled={false}
          authority="agent"
          hasLeadership={false}
          autoApprovalsEnabled
          locked={false}
          onEnabledChange={() => undefined}
          onAuthorityChange={() => undefined}
          onAutoApprovalsChange={() => undefined}
        />
      )

      expect(html).toContain('aria-label="Thread-wide Auto Approvals"')
      expect(html).toContain('aria-pressed="false"')
      expect(html).toContain('Assign a Boss or Captain before enabling Auto Approvals.')
      expect(html).toMatch(/aria-label="Thread-wide Auto Approvals"[^>]*disabled=""/)
    })

    it('renders Stage as a four-way shared control with compact labels', () => {
      const html = renderToStaticMarkup(
        <EnsembleParticipantStageControl
          participantLabel="Claude Fable 5"
          stageRole="worker"
          locked={false}
          onStageRoleChange={() => undefined}
        />
      )

      expect(html).not.toContain('<select')
      expect(html).toContain('>Stage</span>')
      expect(html).toContain('role="radiogroup"')
      expect(html).toContain('aria-label="Stage for Claude Fable 5"')
      expect(html.match(/role="radio"/g) || []).toHaveLength(4)
      expect(html).toContain('>Any</button>')
      expect(html).toContain('>Scout</button>')
      expect(html).toContain('>Work</button>')
      expect(html).toContain('>Review</button>')
      expect(html).toMatch(
        /aria-checked="true"[^>]*data-segmented-control-value="worker"/
      )
    })
  })

  describe('resolveParticipantSelectionAfterRemoval', () => {
    const participants = [
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Planner', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Builder', order: 2 }),
      makeParticipant({ id: 'ensemble-kimi', provider: 'kimi', role: 'Reviewer', order: 3 })
    ]

    it('selects the participant immediately before a selected removed chip', () => {
      expect(
        resolveParticipantSelectionAfterRemoval(participants, 'ensemble-kimi', 'ensemble-kimi')
      ).toBe('ensemble-codex')
    })

    it('falls forward when the first selected participant is removed', () => {
      expect(
        resolveParticipantSelectionAfterRemoval(participants, 'ensemble-claude', 'ensemble-claude')
      ).toBe('ensemble-codex')
    })

    it('preserves the current selection when another participant is removed', () => {
      expect(
        resolveParticipantSelectionAfterRemoval(participants, 'ensemble-codex', 'ensemble-kimi')
      ).toBe('ensemble-kimi')
    })
  })

  describe('unified add-participant draft', () => {
    it('uses the existing provider order and omits synthetic custom models', () => {
      expect(buildEnsembleAddProviderGroups(false, false).map((group) => group.provider)).toEqual([
        'codex',
        'claude',
        'kimi',
        'ollama'
      ])
      const expanded = buildEnsembleAddProviderGroups(true, true)
      expect(expanded.map((group) => group.provider)).toEqual([
        'codex',
        'claude',
        'kimi',
        'grok',
        'cursor',
        'ollama'
      ])
      expect(
        expanded.every((group) => group.modelOptions.every((model) => model.id !== 'custom'))
      ).toBe(true)
    })

    it('normalizes provider-specific reasoning, thinking, and Fast defaults', () => {
      expect(
        createEnsembleParticipantAddConfiguration('codex', 'gpt-5.6-sol')
      ).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'low',
        fastModeEnabled: false,
        serviceTier: ''
      })
      expect(
        createEnsembleParticipantAddConfiguration('cursor', 'composer-2.5-fast')
      ).toMatchObject({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        fastModeEnabled: true
      })
      expect(createEnsembleParticipantAddConfiguration('cursor', 'composer-2.5')).toMatchObject({
        provider: 'cursor',
        model: 'composer-2.5',
        fastModeEnabled: false
      })
      expect(createEnsembleParticipantAddConfiguration('kimi')).toMatchObject({
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        thinkingEnabled: true,
        reasoningEffort: undefined
      })
      expect(createEnsembleParticipantAddConfiguration('claude', 'claude-haiku-4-5')).toMatchObject(
        {
          model: 'claude-haiku-4-5',
          reasoningEffort: undefined,
          fastModeEnabled: false
        }
      )
    })

    it('keeps live models and honors their reasoning metadata', () => {
      const providerGroups = [
        {
          provider: 'codex' as const,
          label: 'Codex',
          modelOptions: [
            {
              id: 'gpt-next-live',
              label: 'GPT Next Live',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                {
                  reasoningEffort: 'high',
                  disabled: true,
                  disabledReason: 'Not available for this account'
                }
              ],
              defaultReasoningEffort: 'high',
              additionalSpeedTiers: ['fast']
            }
          ],
          fastModeCapableModelIds: new Set(['gpt-next-live'])
        }
      ]

      expect(
        createEnsembleParticipantAddConfiguration(
          'codex',
          'gpt-next-live',
          providerGroups
        )
      ).toEqual({
        provider: 'codex',
        model: 'gpt-next-live',
        reasoningEffort: 'low',
        fastModeEnabled: false,
        thinkingEnabled: undefined,
        serviceTier: ''
      })
    })

    it('preserves supplied live provider order and Fast sets while removing custom rows', () => {
      const fastModels = new Set(['claude-live'])
      const groups = resolveEnsembleAddProviderGroups(
        [
          {
            provider: 'claude',
            label: 'Claude',
            modelOptions: [
              { id: 'custom', label: 'Custom…' },
              { id: 'claude-live', label: 'Claude Live' }
            ],
            fastModeCapableModelIds: fastModels
          },
          {
            provider: 'codex',
            label: 'Codex',
            modelOptions: [{ id: 'gpt-live', label: 'GPT Live' }]
          }
        ],
        false,
        false
      )

      expect(groups.map((group) => group.provider)).toEqual(['claude', 'codex'])
      expect(groups[0].modelOptions.map((model) => model.id)).toEqual(['claude-live'])
      expect(groups[0].fastModeCapableModelIds).toBe(fastModels)
    })

    it('materializes the chosen execution settings without inheriting seat identity or grants', () => {
      const participants = [
        makeParticipant({
          id: 'ensemble-claude',
          provider: 'claude',
          role: 'Claude',
          order: 1
        }),
        makeParticipant({
          id: 'ensemble-codex',
          provider: 'codex',
          role: 'Builder',
          order: 2,
          runtimeProfileId: 'codex-runtime',
          permissionPresetId: 'read_only',
          permissionOverrides: { approvalMode: 'never' },
          linkedProviderSessionId: 'codex-session'
        }),
        makeParticipant({ id: 'ensemble-kimi', provider: 'kimi', role: 'Reviewer', order: 3 })
      ]
      const { participant, insertIndex } = buildEnsembleParticipantAddition(
        participants,
        'ensemble-codex',
        {
          provider: 'claude',
          model: 'claude-opus-4-8-1m',
          reasoningEffort: 'high',
          fastModeEnabled: true
        }
      )

      expect(insertIndex).toBe(2)
      expect(participant).toMatchObject({
        id: 'ensemble-participant-4',
        provider: 'claude',
        enabled: true,
        role: 'Claude 2',
        instructions: 'Contribute as Claude for this ensemble.',
        order: 4,
        model: 'claude-opus-4-8-1m',
        permissionPresetId: 'default',
        reasoningEffort: 'high',
        fastModeEnabled: true,
        geminiAuthProfileId: null
      })
      expect(participant.runtimeProfileId).toBeUndefined()
      expect(participant.permissionOverrides).toBeUndefined()
      expect(participant.linkedProviderSessionId).toBeUndefined()
      expect(participant.stageRole).toBeUndefined()
    })

    it('materializes Codex Fast as both the participant flag and service tier', () => {
      const config = createEnsembleParticipantAddConfiguration('codex', 'gpt-5.5')
      config.fastModeEnabled = true
      config.serviceTier = 'fast'
      const { participant } = buildEnsembleParticipantAddition([], null, config)
      expect(participant.fastModeEnabled).toBe(true)
      expect(participant.serviceTier).toBe('fast')
      expect(participant.permissionPresetId).toBe('default')
    })
  })

  it('returns null for non-ensemble chats', () => {
    const chat: ChatRecord = {
      appChatId: 'solo-chat',
      chatKind: 'single',
      scope: 'workspace',
      provider: 'claude',
      title: 'Solo',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: []
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toBe('')
  })

  it('renders a chip per participant with role + idle status by default', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('Explorer')
    expect(html).toContain('Worker')
    expect(html).toContain('aria-haspopup="dialog"')
    // Two `status-idle` pills should appear (one per participant when no
    // active round).
    const idleHits = html.match(/status-idle/g) || []
    expect(idleHits.length).toBeGreaterThanOrEqual(2)
  })

  it('marks the active participant as speaking + others by their round status', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Plan and implement.',
      startedAt: '2026-05-25T15:00:00.000Z',
      activeParticipantId: 'ensemble-codex',
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'answered'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'running'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('status-speaking')
    expect(html).toContain('status-answered')
  })

  it('shows a Skip reads action for active read fan-out lanes without an active speaker', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Read in parallel.',
      startedAt: '2026-05-25T15:00:00.000Z',
      lanes: {
        'lane-round-1-ensemble-claude-1': {
          laneId: 'lane-round-1-ensemble-claude-1',
          participantId: 'ensemble-claude',
          provider: 'claude',
          status: 'running',
          intent: 'read',
          startedAt: '2026-05-25T15:00:00.000Z'
        }
      },
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'running'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'idle'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
        onSkipReadFanout={() => undefined}
      />
    )
    expect(html).toContain('Skip reads')
  })

  it('renders sleeping participant chips for scheduled wakeups', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Wait for external input.',
      startedAt: '2026-05-25T15:00:00.000Z',
      sleepingParticipantIds: ['ensemble-claude'],
      pendingWakeupIds: ['wakeup-1'],
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'sleeping',
          reason: '[wakeup:wakeup-1 until 2026-05-25T15:05:00.000Z]'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'answered'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('status-sleeping')
    expect(html).toContain('sleeping — [wakeup:wakeup-1')
  })

  it('dims disabled participants but still renders them', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', enabled: true, role: 'Explorer' }),
      makeParticipant({
        id: 'ensemble-gemini',
        provider: 'gemini',
        enabled: false,
        role: 'Researcher',
        order: 2
      })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('Researcher')
    expect(html).toContain('is-dimmed')
  })

  // Slice F v2 (1.0.3) — clicking a chip selects it; the parent
  // (App.tsx) passes selectedParticipantId in and the component
  // applies an `.is-selected` class for the visual treatment.
  it('marks the selected participant chip with is-selected', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('is-selected')
    // Only one chip is selected. Count the class hits in chip class
    // strings (the substring also appears inside aria attributes etc.,
    // so this is a heuristic check).
    const selectedHits = html.match(/class="ensemble-above-chip[^"]*is-selected/g) || []
    expect(selectedHits.length).toBe(1)
  })

  it('leaves orchestration controls out of the participant row', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.orchestrationMode = 'continuous'
    chat.ensemble!.maxContinuationHops = 6
    chat.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Keep going.',
      startedAt: '2026-05-25T15:00:00.000Z',
      orchestrationMode: 'continuous',
      continuationHops: 2,
      maxContinuationHops: 6,
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'answered'
        },
        {
          participantId: 'ensemble-codex',
          provider: 'codex',
          role: 'Worker',
          order: 2,
          status: 'running'
        }
      ]
    }

    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).not.toContain('Continuous')
    expect(html).not.toContain('2/6 hops')
    expect(html).not.toContain('ensemble-above-mode-button')
  })

  it('renders the add-participant affordance while the roster is below the cap', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])

    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).toContain('ensemble-above-add-participant')
    expect(html).toContain('Add Ensemble participant')
  })

  it('keeps the unified add trigger disabled at the roster cap', () => {
    const chat = makeChat(
      Array.from({ length: 20 }, (_, index) =>
        makeParticipant({
          id: `ensemble-participant-${index + 1}`,
          provider: 'codex',
          role: `Agent ${index + 1}`,
          order: index + 1
        })
      )
    )
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-participant-20"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).toMatch(/class="ensemble-above-add-participant"[^>]*disabled=""/)
    expect(html).toContain('Ensembles support up to 20 participants.')
  })

  it('keeps the unified add trigger disabled while an Ensemble round is live', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-live',
      status: 'running',
      prompt: 'Work together.',
      startedAt: '2026-07-10T10:00:00.000Z',
      participants: [
        {
          participantId: 'ensemble-claude',
          provider: 'claude',
          role: 'Explorer',
          order: 1,
          status: 'running'
        }
      ]
    }
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="ensemble-claude"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).toMatch(/class="ensemble-above-add-participant"[^>]*disabled=""/)
    expect(html).toContain('Participant changes are locked while a round is running.')
  })

  // Boss — a gold crown renders before the assigned participant's role,
  // and "Boss" is woven into the chip's accessible name/title. The crown
  // glyph itself is decorative (aria-hidden).
  it('renders a Boss crown on the assigned participant only', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    // Exactly one crown, on the Boss chip.
    const crownHits = html.match(/ensemble-above-chip-crown/g) || []
    expect(crownHits.length).toBe(1)
    // "Boss" appears in the accessible name (aria-label) of the chip.
    expect(html).toContain('aria-label="Boss Explorer"')
    // The crown glyph is decorative.
    expect(html).toContain('aria-hidden="true"')
  })

  it('renders no crown when no Boss is assigned', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 2 })
    ])
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).not.toContain('ensemble-above-chip-crown')
    expect(html).not.toContain('Boss')
  })

  it('renders a silver Captain hat separately from Boss', () => {
    const chat = makeChat([
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Bossman', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Deputy', order: 2 })
    ])
    chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
    chat.ensemble!.secondInCommandParticipantId = 'ensemble-codex'
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    const bossCrownHits = html.match(/ensemble-above-chip-crown/g) || []
    expect(bossCrownHits.length).toBe(1)
    expect(html).toContain('ensemble-above-chip-captain-hat')
    expect(html).toContain('aria-label="Boss Bossman"')
    expect(html).toContain('aria-label="Captain Deputy"')
  })

  describe('computeEnsembleChipRowDistribution', () => {
    it('matches the balanced ≤5-per-row product spec for every count up to the 20 cap', () => {
      // Verbatim from the product spec: rows only expand to accommodate
      // participants; remainder lands on the LATER rows.
      const expected: Record<number, number[]> = {
        1: [1],
        2: [2],
        3: [3],
        4: [4],
        5: [5],
        6: [3, 3],
        7: [3, 4],
        8: [4, 4],
        9: [4, 5],
        10: [5, 5],
        11: [3, 4, 4],
        12: [4, 4, 4],
        13: [4, 4, 5],
        14: [4, 5, 5],
        15: [5, 5, 5],
        16: [4, 4, 4, 4],
        17: [4, 4, 4, 5],
        18: [4, 4, 5, 5],
        19: [4, 5, 5, 5],
        20: [5, 5, 5, 5]
      }
      for (const [count, rows] of Object.entries(expected)) {
        expect(computeEnsembleChipRowDistribution(Number(count)), `count ${count}`).toEqual(rows)
      }
    })

    it('yields index-aligned grid spans that fill each 60-track row exactly', () => {
      for (let count = 6; count <= 20; count++) {
        const spans = computeEnsembleChipGridSpans(count)
        expect(spans.length, `count ${count}`).toBe(count)
        // Every span divides the track count exactly (3→20, 4→15, 5→12)…
        for (const span of spans) {
          expect([12, 15, 20]).toContain(span)
        }
        // …and the spans of each row sum to exactly one full 60-track line,
        // so grid-auto-flow breaks precisely at the intended boundaries.
        let lineTotal = 0
        for (const span of spans) {
          lineTotal += span
          expect(lineTotal, `count ${count}`).toBeLessThanOrEqual(ENSEMBLE_CHIP_GRID_TRACKS)
          if (lineTotal === ENSEMBLE_CHIP_GRID_TRACKS) lineTotal = 0
        }
        expect(lineTotal, `count ${count} must end on a full row`).toBe(0)
      }
    })
  })

  it('renders wrapped chips with balanced-row grid spans at 6+ participants', () => {
    const providers = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'ollama', 'claude'] as const
    const chat = makeChat(
      providers.map((provider, index) =>
        makeParticipant({
          id: `ensemble-${provider}-${index}`,
          provider,
          role: `Seat ${index + 1}`,
          order: index + 1
        })
      )
    )
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('is-wrapped')
    // 7 participants → 3 + 4: three span-20 chips then four span-15 chips.
    expect(html.match(/grid-column:span 20/g) || []).toHaveLength(3)
    expect(html.match(/grid-column:span 15/g) || []).toHaveLength(4)
  })

  it('keeps the content-width flex layout (no spans) below the wrap threshold', () => {
    const chat = makeChat(
      ['claude', 'codex', 'kimi', 'grok', 'cursor'].map((provider, index) =>
        makeParticipant({
          id: `ensemble-${provider}`,
          provider: provider as EnsembleParticipant['provider'],
          role: `Seat ${index + 1}`,
          order: index + 1
        })
      )
    )
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).not.toContain('is-wrapped')
    expect(html).not.toContain('grid-column:span')
  })
})
