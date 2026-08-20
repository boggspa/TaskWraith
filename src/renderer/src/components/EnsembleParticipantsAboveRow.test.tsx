import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BOSS_AUTO_APPROVAL_CONSENT_MESSAGE,
  ENSEMBLE_CHIP_GRID_TRACKS,
  EnsembleAddParticipantFields,
  EnsembleParticipantDuplicateRow,
  EnsembleParticipantAuthorityControls,
  EnsembleParticipantStageControl,
  EnsembleParticipantsAboveRow,
  buildEnsembleAddProviderGroups,
  buildEnsembleParticipantAddition,
  computeEnsembleChipGridSpans,
  computeEnsembleChipRowDistribution,
  createEnsembleParticipantAddConfiguration,
  createEnsembleParticipantAddDetails,
  createEnsembleParticipantDuplicateDraft,
  getEnsembleAddReasoningOptions,
  resolveEnsembleAddProviderGroups,
  resolveEnsembleParticipantAddAuthorityPatch,
  resolveEnsembleParticipantAuthorityPatch,
  resolveParticipantSelectionAfterRemoval,
  retargetEnsembleParticipantAddDetails
} from './EnsembleParticipantsAboveRow'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../../shared/ensembleLimits'
import { groupAntigravityModelRows } from '../../../shared/antigravityAgyModelGrouping'
import { CODEX_DEFAULT_MODELS } from '../lib/providerModelDefaults'

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
  it('discloses the read-only Boss review race in Auto Approvals consent', () => {
    expect(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE).toContain(
      'eligible shell/file request still opens a modal'
    )
    expect(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE).toContain(
      'read-only Boss/Captain review turn'
    )
    expect(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE).toContain(
      'the first human, authority, or timeout decision wins'
    )
    expect(BOSS_AUTO_APPROVAL_CONSENT_MESSAGE).toContain(
      'This will not grant session/workspace approval'
    )
  })

  describe('participant authority controls', () => {
    const autoApprovals = {
      enabled: true,
      mode: 'permission_preset_once' as const,
      confirmedAt: '2026-07-10T03:00:00.000Z'
    }

    const authorityParticipants = [
      makeParticipant({ id: 'boss', order: 1 }),
      makeParticipant({ id: 'captain-1', order: 2 }),
      makeParticipant({ id: 'captain-2', order: 3 }),
      makeParticipant({ id: 'captain-3', order: 4 }),
      makeParticipant({ id: 'agent', order: 5 })
    ]

    it('moves Boss atomically while preserving the other Captains and consent', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            captainParticipantIds: ['captain-1', 'captain-2'],
            secondInCommandParticipantId: 'captain-1',
            bossmanAutoApprovals: autoApprovals
          },
          'captain-1',
          'boss',
          authorityParticipants
        )
      ).toEqual({
        bossmanParticipantId: 'captain-1',
        captainParticipantIds: ['captain-2'],
        secondInCommandParticipantId: 'captain-2',
        bossmanAutoApprovals: autoApprovals
      })
    })

    it('keeps exactly one Boss when a single-seat edit tries to demote it', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            captainParticipantIds: ['captain-1'],
            secondInCommandParticipantId: 'captain-1',
            bossmanAutoApprovals: autoApprovals
          },
          'boss',
          'agent',
          authorityParticipants
        )
      ).toEqual({
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-1'],
        secondInCommandParticipantId: 'captain-1',
        bossmanAutoApprovals: autoApprovals
      })
    })

    it('adds Captains up to three, rejects a fourth, and mirrors roster order', () => {
      const third = resolveEnsembleParticipantAuthorityPatch(
        {
          bossmanParticipantId: 'boss',
          captainParticipantIds: ['captain-2', 'captain-1'],
          secondInCommandParticipantId: 'captain-2',
          bossmanAutoApprovals: autoApprovals
        },
        'captain-3',
        'captain',
        authorityParticipants
      )
      expect(third).toEqual({
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-1', 'captain-2', 'captain-3'],
        secondInCommandParticipantId: 'captain-1',
        bossmanAutoApprovals: autoApprovals
      })
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          third,
          'agent',
          'captain',
          authorityParticipants
        )
      ).toEqual(third)
    })

    it('lets a Captain clear itself without disturbing the other Captains', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            captainParticipantIds: ['captain-1', 'captain-2', 'captain-3'],
            secondInCommandParticipantId: 'captain-1',
            bossmanAutoApprovals: autoApprovals
          },
          'captain-2',
          'agent',
          authorityParticipants
        )
      ).toEqual({
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-1', 'captain-3'],
        secondInCommandParticipantId: 'captain-1',
        bossmanAutoApprovals: autoApprovals
      })
    })

    it('lets an explicit empty Captain array beat a stale scalar', () => {
      expect(
        resolveEnsembleParticipantAuthorityPatch(
          {
            bossmanParticipantId: 'boss',
            captainParticipantIds: [],
            secondInCommandParticipantId: 'captain-1',
            bossmanAutoApprovals: autoApprovals
          },
          'agent',
          'agent',
          authorityParticipants
        )
      ).toEqual({
        bossmanParticipantId: 'boss',
        captainParticipantIds: [],
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
      expect(html).toContain('Assign a Boss before enabling Auto Approvals.')
      expect(html).toMatch(/aria-label="Thread-wide Auto Approvals"[^>]*disabled=""/)
    })

    it('disables Boss and Captain assignment for a background seat', () => {
      const html = renderToStaticMarkup(
        <EnsembleParticipantAuthorityControls
          participantLabel="Background shell"
          enabled
          authority="agent"
          backgroundRestricted
          hasLeadership={false}
          autoApprovalsEnabled={false}
          locked={false}
          onEnabledChange={() => undefined}
          onAuthorityChange={() => undefined}
          onAutoApprovalsChange={() => undefined}
        />
      )

      expect(html).toMatch(/data-segmented-control-value="boss"[^>]*disabled=""/)
      expect(html).toMatch(/data-segmented-control-value="captain"[^>]*disabled=""/)
      expect(html).toMatch(/data-segmented-control-value="agent"(?![^>]*disabled)/)
      expect(html).toContain('BG seats cannot own Boss or Captain authority.')
    })

    it('renders Stage as a five-way shared control with compact labels', () => {
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
      expect(html.match(/role="radio"/g) || []).toHaveLength(5)
      expect(html).toContain('>Any</button>')
      expect(html).toContain('>Scout</button>')
      expect(html).toContain('>Work</button>')
      expect(html).toContain('>Review</button>')
      expect(html).toContain('>BG</button>')
      expect(html).toMatch(/aria-checked="true"[^>]*data-segmented-control-value="worker"/)
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

  describe('roster floor', () => {
    const twoSeats = [
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Planner', order: 1 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Builder', order: 2 })
    ]

    it('keeps remove live at the floor and explains that it ends Ensemble mode', () => {
      const html = renderToStaticMarkup(
        <EnsembleParticipantsAboveRow
          chat={makeChat(twoSeats)}
          selectedParticipantId="ensemble-codex"
          onSelectParticipant={() => undefined}
          onChatChange={() => undefined}
          onCollapseToSolo={() => undefined}
        />
      )
      const removeButton = html.slice(html.indexOf('ensemble-above-remove-participant'))
      expect(removeButton.slice(0, removeButton.indexOf('>'))).not.toContain('disabled')
      expect(html).toContain('the thread switches Ensemble off')
    })

    it('disables remove at the floor when the mode change is not wired', () => {
      // Harness/side-chat mounts pass no `onCollapseToSolo`; without it the only
      // honest outcome would be a one-seat roster, so the button must not act.
      const html = renderToStaticMarkup(
        <EnsembleParticipantsAboveRow
          chat={makeChat(twoSeats)}
          selectedParticipantId="ensemble-codex"
          onSelectParticipant={() => undefined}
          onChatChange={() => undefined}
        />
      )
      const removeButton = html.slice(html.indexOf('ensemble-above-remove-participant'))
      expect(removeButton.slice(0, removeButton.indexOf('>'))).toContain('disabled')
    })
  })

  describe('unified add-participant draft', () => {
    it('creates unique participant details without losing existing Auto consent', () => {
      const participants = [
        makeParticipant({ id: 'claude-1', provider: 'claude', role: 'Claude', order: 1 })
      ]
      const details = createEnsembleParticipantAddDetails('claude', participants, {
        enabled: true,
        mode: 'permission_preset_once',
        confirmedAt: '2026-07-10T16:00:00.000Z'
      })

      expect(details).toEqual({
        enabled: true,
        authority: 'agent',
        autoApprovalsEnabled: true,
        autoApprovalsConfirmedAt: '2026-07-10T16:00:00.000Z',
        stageRole: undefined,
        role: 'Claude 2',
        instructions: 'Contribute as Claude for this ensemble.'
      })
    })

    it('retargets untouched provider defaults without erasing authored details', () => {
      const participants = [
        makeParticipant({ id: 'claude-1', provider: 'claude', role: 'Claude', order: 1 })
      ]
      const defaults = createEnsembleParticipantAddDetails('claude', participants)
      expect(
        retargetEnsembleParticipantAddDetails(defaults, 'claude', 'codex', participants)
      ).toMatchObject({
        role: 'Codex',
        instructions: 'Contribute as Codex for this ensemble.'
      })

      expect(
        retargetEnsembleParticipantAddDetails(
          {
            ...defaults,
            stageRole: 'reviewer',
            role: 'Release reviewer',
            instructions: 'Review the final diff.'
          },
          'claude',
          'codex',
          participants
        )
      ).toMatchObject({
        stageRole: 'reviewer',
        role: 'Release reviewer',
        instructions: 'Review the final diff.'
      })
    })

    it('duplicates every picker-visible setting into a fresh, uniquely named draft', () => {
      const participant = makeParticipant({
        id: 'reviewer-1',
        provider: 'codex',
        enabled: false,
        role: 'Release reviewer',
        instructions: 'Review the final diff.',
        model: 'gpt-5.6-sol',
        stageRole: 'reviewer',
        reasoningEffort: 'high',
        fastModeEnabled: true,
        serviceTier: 'fast'
      })
      const autoApprovals = {
        enabled: true,
        mode: 'permission_preset_once' as const,
        confirmedAt: '2026-08-11T20:00:00.000Z'
      }

      expect(
        createEnsembleParticipantDuplicateDraft(
          participant,
          [participant],
          'captain',
          autoApprovals
        )
      ).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        fastModeEnabled: true,
        serviceTier: 'fast',
        enabled: false,
        authority: 'captain',
        autoApprovalsEnabled: true,
        autoApprovalsConfirmedAt: '2026-08-11T20:00:00.000Z',
        stageRole: 'reviewer',
        role: 'Release reviewer 2',
        instructions: 'Review the final diff.'
      })
    })

    it('falls back from a legacy duplicated model to a visible live-catalog default', () => {
      const participant = makeParticipant({
        provider: 'claude',
        model: 'auto-claude-3',
        role: 'Legacy reviewer'
      })

      expect(
        createEnsembleParticipantDuplicateDraft(
          participant,
          [participant],
          'agent',
          undefined,
          [
            {
              provider: 'claude',
              modelOptions: [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }]
            }
          ]
        ).model
      ).toBe('claude-sonnet-5')
    })

    it('renders the existing participants as a horizontally scrollable duplicate rail', () => {
      const participants = [
        makeParticipant({ id: 'planner', role: 'Planner', model: 'claude-opus-4-7' }),
        makeParticipant({
          id: 'builder',
          provider: 'codex',
          role: 'Builder',
          model: 'gpt-5.6-sol',
          order: 2
        })
      ]
      const html = renderToStaticMarkup(
        <EnsembleParticipantDuplicateRow
          participants={participants}
          selectedSourceId="builder"
          duplicableProviderIds={new Set(['claude', 'codex'])}
          disabled={false}
          onDuplicate={() => undefined}
        />
      )

      expect(html).toContain('>Duplicate</span>')
      expect(html).toContain('aria-label="Duplicate configuration from Planner"')
      expect(html).toContain('aria-label="Duplicate configuration from Builder"')
      expect(html).toMatch(/data-participant-id="builder"[^>]*aria-pressed="true"/)
      expect(html).toContain('>GPT-5.6-Sol</span>')
    })

    it('keeps unavailable legacy providers visible but disables their duplicate action', () => {
      const html = renderToStaticMarkup(
        <EnsembleParticipantDuplicateRow
          participants={[
            makeParticipant({ id: 'legacy-gemini', provider: 'gemini', role: 'Legacy Gemini' })
          ]}
          selectedSourceId={null}
          duplicableProviderIds={new Set(['codex'])}
          disabled={false}
          onDuplicate={() => undefined}
        />
      )

      expect(html).toContain('data-participant-id="legacy-gemini"')
      expect(html).toContain('disabled=""')
      expect(html).toContain('Cannot duplicate configuration from Legacy Gemini: provider unavailable')
    })

    it('renders every participant field in the Add-only top section', () => {
      const participants = [makeParticipant({ id: 'claude-1', order: 1 })]
      const html = renderToStaticMarkup(
        <EnsembleAddParticipantFields
          provider="claude"
          participants={participants}
          details={{
            enabled: true,
            authority: 'agent',
            autoApprovalsEnabled: false,
            stageRole: undefined,
            role: 'Release reviewer',
            instructions: 'Review the final diff.'
          }}
          rolePresetId="custom"
          hasLeadership={false}
          captainAssignmentDisabled={false}
          disabled={false}
          onDetailsChange={() => undefined}
          onRolePresetIdChange={() => undefined}
          onAutoApprovalsChange={() => undefined}
        />
      )

      expect(html).toContain('class="ensemble-add-participant-fields"')
      expect(html).toContain('>Enabled</button>')
      expect(html).toContain('>Auto</button>')
      expect(html.match(/role="radio"/g) || []).toHaveLength(8)
      expect(html).toContain('>Boss</span>')
      expect(html).toContain('>Captain</span>')
      expect(html).toContain('>Any</button>')
      expect(html).toContain('>Scout</button>')
      expect(html).toContain('>Work</button>')
      expect(html).toContain('>Review</button>')
      expect(html).toContain('>BG</button>')
      expect(html).toContain('<option value="custom" selected="">Custom…</option>')
      expect(html).toContain('value="Release reviewer"')
      expect(html).toContain('Brief preset…')
      expect(html).toContain('>Save preset</button>')
      expect(html).toContain('>Rename</button>')
      expect(html).toContain('Review the final diff.')
      expect(html).not.toContain('>Save</button>')
      expect(html).not.toContain('Model, provider, reasoning, fast mode')
    })

    it('prevents Boss or Captain authority on a background addition', () => {
      const html = renderToStaticMarkup(
        <EnsembleAddParticipantFields
          provider="codex"
          participants={[]}
          details={{
            enabled: true,
            authority: 'agent',
            autoApprovalsEnabled: false,
            stageRole: 'background',
            role: 'Background worker',
            instructions: ''
          }}
          rolePresetId="custom"
          hasLeadership={false}
          captainAssignmentDisabled={false}
          disabled={false}
          onDetailsChange={() => undefined}
          onRolePresetIdChange={() => undefined}
          onAutoApprovalsChange={() => undefined}
        />
      )

      expect(html).toMatch(/data-segmented-control-value="boss"[^>]*disabled=""/)
      expect(html).toMatch(/data-segmented-control-value="captain"[^>]*disabled=""/)
    })

    it('scopes the four-part layout to the Ensemble Add picker', () => {
      const css = readFileSync(
        new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
        'utf8'
      )
      expect(css).toContain(
        '.composer-combined-picker-popover.is-unified-provider-picker.has-top-content.is-ensemble-add-participant'
      )
      expect(css).toContain('grid-template-columns: minmax(0, 1fr) 124px')
      expect(css).toContain('grid-template-rows: minmax(0, 38fr) minmax(0, 62fr) auto')
      expect(css).toContain('height: min(570px, calc(100dvh - 16px))')
      expect(css).toContain('.is-ensemble-add-participant > .composer-combined-picker-top-content')
      expect(css).toContain('border-bottom: 1px solid')
      expect(css).toContain('.ensemble-add-participant-fields-primary')
      expect(css).toContain('border-right: 1px solid')
      expect(css).toContain('.ensemble-add-participant-brief .ensemble-brief-textarea-wrap')
      expect(css).toContain(
        '.is-ensemble-add-participant > .composer-combined-picker-bottom-content'
      )
      expect(css).toContain('.composer-combined-picker-confirm-actions')
      expect(css).toContain('.ensemble-add-participant-duplicate-list')
      expect(css).toContain('overflow-x: auto')
      expect(css).toContain('height: 100%')
    })

    it('uses the live provider order and omits retired providers and synthetic custom models', () => {
      // Every statically live provider shows regardless of which ids the
      // discovery snapshot lists (resolveProviderRows never hides a live
      // provider) — only the retired/gemini id and the ungranted antigravity
      // id are ever absent. The snapshot's providerIds below are intentionally
      // narrower than the full live set to prove that.
      expect(
        buildEnsembleAddProviderGroups(false, false, {
          snapshot: { ready: true, providerIds: ['codex', 'claude', 'kimi', 'ollama'] }
        }).map((group) => group.provider)
      ).toEqual(['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama', 'pi', 'mistral', 'muse'])
      const expanded = buildEnsembleAddProviderGroups(true, true, {
        snapshot: {
          ready: true,
          providerIds: ['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama']
        }
      })
      expect(expanded.map((group) => group.provider)).toEqual([
        'codex',
        'claude',
        'kimi',
        'cursor',
        'grok',
        'ollama',
        'pi',
        'mistral',
        'muse'
      ])
      expect(
        expanded.every((group) => group.modelOptions.every((model) => model.id !== 'custom'))
      ).toBe(true)
    })

    it('normalizes provider-specific reasoning, thinking, and Fast defaults', () => {
      expect(createEnsembleParticipantAddConfiguration('codex', 'gpt-5.6-sol')).toMatchObject({
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
        fastModeEnabled: false,
        thinkingEnabled: true,
        reasoningEffort: 'on',
        serviceTier: 'standard'
      })
      expect(createEnsembleParticipantAddConfiguration('kimi', 'kimi-k3')).toMatchObject({
        provider: 'kimi',
        model: 'kimi-k3',
        reasoningEffort: 'max',
        thinkingEnabled: true,
        fastModeEnabled: false,
        serviceTier: 'standard'
      })
      expect(createEnsembleParticipantAddConfiguration('ollama', 'ornith-1.5:35b')).toMatchObject({
        provider: 'ollama',
        model: 'ornith-1.5:35b',
        reasoningEffort: 'on'
      })
      expect(createEnsembleParticipantAddConfiguration('ollama', 'gpt-oss:20b')).toMatchObject({
        provider: 'ollama',
        model: 'gpt-oss:20b',
        reasoningEffort: 'high'
      })
      expect(createEnsembleParticipantAddConfiguration('ollama', 'gemma3:4b')).toMatchObject({
        provider: 'ollama',
        model: 'gemma3:4b',
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

    it('offers the full Spark ladder in the Add Participant popover fallback', () => {
      const providerGroups = [
        {
          provider: 'codex' as const,
          label: 'Codex',
          modelOptions: CODEX_DEFAULT_MODELS.filter((model) => model.id === 'gpt-5.3-codex-spark')
        }
      ]

      expect(
        getEnsembleAddReasoningOptions('codex', 'gpt-5.3-codex-spark', providerGroups).map(
          (option) => option.value
        )
      ).toEqual(['low', 'medium', 'high', 'xhigh'])
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
        createEnsembleParticipantAddConfiguration('codex', 'gpt-next-live', providerGroups)
      ).toEqual({
        provider: 'codex',
        model: 'gpt-next-live',
        reasoningEffort: 'low',
        fastModeEnabled: false,
        thinkingEnabled: undefined,
        serviceTier: ''
      })
    })

    it('uses AntiGravity model variants as an effort ladder and preserves the selected wire id', () => {
      const providerGroups = [
        {
          provider: 'antigravity' as const,
          label: 'AntiGravity',
          modelOptions: groupAntigravityModelRows([
            { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
            { id: 'gemini-3.6-flash-medium', label: 'gemini-3.6-flash-medium' },
            { id: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' }
          ])
        }
      ]

      expect(
        getEnsembleAddReasoningOptions('antigravity', 'gemini-3.6-flash-medium', providerGroups)
      ).toEqual([
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ])
      expect(
        createEnsembleParticipantAddConfiguration(
          'antigravity',
          'gemini-3.6-flash-medium',
          providerGroups
        )
      ).toMatchObject({
        provider: 'antigravity',
        model: 'gemini-3.6-flash-medium',
        reasoningEffort: undefined
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

    it('preserves an explicitly empty connected-provider catalog without falling back', () => {
      expect(resolveEnsembleAddProviderGroups([], true, true)).toEqual([])
      expect(resolveEnsembleAddProviderGroups(undefined, true, true)).toEqual([])
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

    it('materializes the participant fields chosen in the Add picker', () => {
      const { participant } = buildEnsembleParticipantAddition([], null, {
        provider: 'claude',
        model: 'claude-sonnet-5',
        enabled: false,
        authority: 'agent',
        autoApprovalsEnabled: false,
        stageRole: 'reviewer',
        role: 'Release reviewer',
        instructions: 'Review the final diff and call out regressions.'
      })

      expect(participant).toMatchObject({
        enabled: false,
        stageRole: 'reviewer',
        role: 'Release reviewer',
        instructions: 'Review the final diff and call out regressions.'
      })
    })

    it('applies new authority and Auto consent as one ensemble patch', () => {
      const existingConsent = {
        enabled: true,
        mode: 'permission_preset_once' as const,
        confirmedAt: '2026-07-10T16:00:00.000Z'
      }
      const participants = [
        makeParticipant({ id: 'old-boss', order: 1 }),
        makeParticipant({ id: 'captain', order: 2 }),
        makeParticipant({ id: 'new-boss', order: 3 }),
        makeParticipant({ id: 'new-agent', order: 4 })
      ]

      expect(
        resolveEnsembleParticipantAddAuthorityPatch(
          {
            bossmanParticipantId: 'old-boss',
            captainParticipantIds: ['captain'],
            secondInCommandParticipantId: 'captain',
            bossmanAutoApprovals: existingConsent
          },
          'new-boss',
          'boss',
          participants,
          existingConsent
        )
      ).toEqual({
        bossmanParticipantId: 'new-boss',
        captainParticipantIds: ['captain'],
        secondInCommandParticipantId: 'captain',
        bossmanAutoApprovals: existingConsent
      })

      expect(
        resolveEnsembleParticipantAddAuthorityPatch(
          {
            bossmanParticipantId: 'old-boss',
            captainParticipantIds: [],
            secondInCommandParticipantId: undefined,
            bossmanAutoApprovals: undefined
          },
          'new-agent',
          'agent',
          participants,
          undefined
        )
      ).toEqual({
        bossmanParticipantId: 'old-boss',
        captainParticipantIds: [],
        secondInCommandParticipantId: undefined,
        bossmanAutoApprovals: undefined
      })
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
      makeParticipant({ id: 'ensemble-claude', provider: 'claude', role: 'Explorer', order: 2 }),
      makeParticipant({ id: 'ensemble-codex', provider: 'codex', role: 'Worker', order: 1 })
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
    expect(html).toContain('data-participant-id="ensemble-codex" data-turn-order="1"')
    expect(html).toContain('data-participant-id="ensemble-claude" data-turn-order="2"')
    expect(html).toContain('aria-description="Turn 1 in roster order"')
    expect(html.indexOf('data-participant-id="ensemble-codex"')).toBeLessThan(
      html.indexOf('data-participant-id="ensemble-claude"')
    )
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

  it('keeps selection separate while a serial speaker re-enters after fan-out', () => {
    const chat = makeChat([
      makeParticipant({ id: 'work-1', provider: 'codex', role: 'Work1', order: 1 }),
      makeParticipant({ id: 'advisor', provider: 'codex', role: 'Advisor', order: 2 })
    ])
    chat.ensemble!.activeRound = {
      roundId: 'round-continuous',
      status: 'running',
      prompt: 'Continue the mission.',
      startedAt: '2026-08-16T16:00:00.000Z',
      activeParticipantId: 'advisor',
      orchestrationMode: 'continuous',
      participants: [
        {
          participantId: 'work-1',
          provider: 'codex',
          role: 'Work1',
          order: 1,
          status: 'answered'
        },
        {
          participantId: 'advisor',
          provider: 'codex',
          role: 'Advisor',
          order: 2,
          status: 'running'
        }
      ],
      lanes: {
        'lane-round-continuous-advisor-1': {
          laneId: 'lane-round-continuous-advisor-1',
          participantId: 'advisor',
          provider: 'codex',
          status: 'completed',
          intent: 'read',
          startedAt: '2026-08-16T16:00:00.000Z',
          endedAt: '2026-08-16T16:01:00.000Z'
        }
      }
    }

    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId="work-1"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    const advisorStart = html.indexOf('data-participant-id="advisor"')
    const work1Markup = html.slice(0, advisorStart)
    const advisorMarkup = html.slice(advisorStart)

    expect(work1Markup).toContain('is-selected')
    expect(work1Markup).not.toContain('is-live-shimmer')
    expect(advisorMarkup).not.toContain('is-selected')
    expect(advisorMarkup).toContain('is-live-shimmer')
    expect(advisorMarkup).toContain('status-speaking')
    expect(advisorMarkup).toContain('aria-label="speaking"')
  })

  it('shows a Skip action for active read fan-out lanes without an active speaker', () => {
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
    expect(html).toContain('>Skip</button>')
    expect(html).not.toContain('Skip reads')
  })

  it('prioritizes the contextual Skip action in the stacked six-participant rail', () => {
    const participants = Array.from({ length: 6 }, (_, index) =>
      makeParticipant({
        id: `ensemble-participant-${index + 1}`,
        provider: 'codex',
        role: `Worker ${index + 1}`,
        order: index + 1
      })
    )
    const chat = makeChat(participants)
    chat.ensemble!.activeRound = {
      roundId: 'round-wrapped',
      status: 'running',
      prompt: 'Implement in sequence.',
      startedAt: '2026-07-12T10:00:00.000Z',
      activeParticipantId: participants[0].id,
      lanes: {
        'lane-round-wrapped-read': {
          laneId: 'lane-round-wrapped-read',
          participantId: participants[1].id,
          provider: participants[1].provider,
          status: 'running',
          intent: 'read',
          startedAt: '2026-07-12T10:00:00.000Z'
        }
      },
      participants: participants.map((participant, index) => ({
        participantId: participant.id,
        provider: participant.provider,
        role: participant.role,
        order: participant.order,
        status: index < 2 ? 'running' : 'idle'
      }))
    }

    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
        onSkipActive={() => undefined}
        onSkipReadFanout={() => undefined}
      />
    )

    expect(html).toContain('ensemble-above-row-chips is-wrapped')
    expect(html).toContain('ensemble-above-row-controls is-stacked')
    expect(html).toContain('>Skip</button>')
    expect(html).not.toContain('Skip reads')

    const fallbackHtml = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
        onSkipActive={() => undefined}
      />
    )
    expect(fallbackHtml).toContain('>Skip</button>')
    expect(fallbackHtml).not.toContain('Skip reads')

    const css = readFileSync(
      new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
      'utf8'
    )
    expect(css).toMatch(
      /\.ensemble-above-row-controls\.is-stacked\s*\{[^}]*grid-template-columns: 72px;[^}]*flex: 0 0 72px;/
    )
    expect(css).toMatch(
      /\.ensemble-above-row-controls\.is-stacked \.ensemble-above-row-actions\s*\{[^}]*grid-row: 1;/
    )
    expect(css).toMatch(
      /\.ensemble-above-row-controls\.is-stacked \.ensemble-above-row-roster-actions\s*\{[^}]*grid-row: 2;/
    )
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
    // The wakeup reason rides the status pill's accessible name (the
    // visual tooltip moved to the chip's custom 500ms hover card,
    // which is hover-state-gated and thus absent from static markup).
    expect(html).toContain('sleeping: [wakeup:wakeup-1')
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

  it('tints AntiGravity participant names with the provider theme token', () => {
    const chat = makeChat([
      makeParticipant({
        id: 'ensemble-antigravity',
        provider: 'antigravity',
        role: 'SolomanBG'
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
    const css = readFileSync(
      new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
      'utf8'
    )

    expect(html).toContain('ensemble-above-chip provider-antigravity')
    expect(css).toMatch(
      /\.ensemble-above-chip\.provider-antigravity \.ensemble-above-chip-role\s*\{\s*color: var\(--provider-antigravity-color\);/
    )
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
      Array.from({ length: MAX_ENSEMBLE_PARTICIPANTS }, (_, index) =>
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
        selectedParticipantId={`ensemble-participant-${MAX_ENSEMBLE_PARTICIPANTS}`}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )

    expect(html).toMatch(/class="ensemble-above-add-participant"[^>]*disabled=""/)
    expect(html).toContain(
      `Ensembles support up to ${MAX_ENSEMBLE_PARTICIPANTS} participants.`
    )
  })

  it('keeps live roster controls available while an Ensemble round is running', () => {
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
          participantProjection={chat.ensemble!.participants.map((participant) =>
            participant.id === 'ensemble-codex'
              ? { ...participant, role: 'Pending role' }
              : participant
          )}
          selectedParticipantId="ensemble-codex"
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
        onPatchParticipant={() => undefined}
        onLiveRosterMutation={() => undefined}
        providerGroups={buildEnsembleAddProviderGroups(false, false, {
          snapshot: { ready: true, providerIds: ['codex'] }
        })}
      />
    )

    expect(html).toMatch(/class="ensemble-above-add-participant"(?![^>]*disabled)/)
    expect(html).toMatch(/class="ensemble-above-remove-participant"(?![^>]*disabled)/)
    expect(html).toContain('Pending role')
    expect(html).toContain('Add this participant to the remaining live roster.')
    expect(html).not.toContain('Participant changes are locked while a round is running.')
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

  it('recovers a single Boss crown for legacy config with no assigned Boss', () => {
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
    expect(html.match(/ensemble-above-chip-crown/g) || []).toHaveLength(1)
    expect(html).toContain('aria-label="Boss Explorer"')
  })

  it('renders a badged glyph per stage, including a terminal for BG, and no slot for Any', () => {
    const chat = makeChat([
      makeParticipant({
        id: 'ensemble-any',
        provider: 'claude',
        role: 'Any stage',
        order: 1,
        stageRole: undefined
      }),
      makeParticipant({
        id: 'ensemble-scout',
        provider: 'codex',
        role: 'Scout stage',
        order: 2,
        stageRole: 'scout'
      }),
      makeParticipant({
        id: 'ensemble-worker',
        provider: 'kimi',
        role: 'Work stage',
        order: 3,
        stageRole: 'worker'
      }),
      makeParticipant({
        id: 'ensemble-reviewer',
        provider: 'grok',
        role: 'Review stage',
        order: 4,
        stageRole: 'reviewer'
      }),
      makeParticipant({
        id: 'ensemble-background',
        provider: 'cursor',
        role: 'BG stage',
        order: 5,
        stageRole: 'background'
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

    expect(html.match(/ensemble-above-chip-stage-icon/g) || []).toHaveLength(4)
    expect(html).toContain('ensemble-above-chip-stage-badge is-scout')
    expect(html).toContain('ensemble-above-chip-stage-badge is-worker')
    expect(html).toContain('ensemble-above-chip-stage-badge is-reviewer')
    expect(html).toContain('ensemble-above-chip-stage-badge is-background')
    expect(html).toContain('ensemble-above-chip-stage-icon is-background')
    expect(html).not.toContain('ensemble-above-chip-stage-pill')
    expect(html).toContain('title="Scout — investigates at round start"')
    expect(html).toContain('title="BG — async, only when delegated"')
    expect(html).not.toMatch(/ensemble-above-chip-stage-icon is-(?:file|edit|search)/)
    expect(
      html.match(
        /ensemble-above-chip-stage-icon is-(?:scout|worker|reviewer|background)" width="14" height="14"[^>]*fill="none" stroke="currentColor"[^>]*aria-hidden="true" focusable="false"/g
      ) || []
    ).toHaveLength(4)

    const css = readFileSync(
      new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
      'utf8'
    )
    expect(css).toMatch(
      /\.ensemble-above-chip-stage-icon\s*\{[^}]*flex: 0 0 auto;[^}]*color: var\(--text-primary\);/
    )
    expect(css).toMatch(
      /\.ensemble-above-chip-stage-badge\s*\{[^}]*color-mix\(in srgb, currentColor 12%, transparent\);/
    )
    expect(css).not.toContain('.ensemble-above-chip-stage-pill')
  })

  it('keeps the four stage-role design sources theme-aware and monoline', () => {
    const assets = [
      'scout-magnifier.svg',
      'worker-wrench.svg',
      'reviewer-glasses.svg',
      'background-terminal.svg'
    ]

    for (const asset of assets) {
      const svg = readFileSync(
        new URL(`../../../../design-assets/ensemble-stage-roles/icons/${asset}`, import.meta.url),
        'utf8'
      )
      expect(svg).toContain('viewBox="0 0 24 24"')
      expect(svg).toContain('fill="none"')
      expect(svg).toContain('stroke="currentColor"')
      expect(svg).toContain('stroke-linecap="round"')
      expect(svg).toContain('stroke-linejoin="round"')
      expect(svg).toContain('<title')
      expect(svg).toContain('<desc')
    }
  })

  it('renders all three Captain hats separately from Boss', () => {
    const chat = makeChat([
      makeParticipant({
        id: 'ensemble-claude',
        provider: 'claude',
        role: 'Bossman',
        order: 1,
        stageRole: 'scout'
      }),
      makeParticipant({
        id: 'ensemble-codex',
        provider: 'codex',
        role: 'Deputy',
        order: 2,
        stageRole: 'reviewer'
      }),
      makeParticipant({
        id: 'ensemble-kimi',
        provider: 'kimi',
        role: 'Deputy 2',
        order: 3
      }),
      makeParticipant({
        id: 'ensemble-cursor',
        provider: 'cursor',
        role: 'Deputy 3',
        order: 4
      })
    ])
    chat.ensemble!.bossmanParticipantId = 'ensemble-claude'
    chat.ensemble!.captainParticipantIds = [
      'ensemble-codex',
      'ensemble-kimi',
      'ensemble-cursor'
    ]
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
    expect(html.match(/ensemble-above-chip-captain-hat/g) || []).toHaveLength(3)
    expect(html).not.toContain('ensemble-above-chip-stage-icon')
    expect(html).toContain('aria-label="Boss Bossman"')
    expect(html).toContain('aria-label="Captain Deputy"')
    expect(html).toContain('aria-label="Captain Deputy 2"')
    expect(html).toContain('aria-label="Captain Deputy 3"')
  })

  describe('computeEnsembleChipRowDistribution', () => {
    it('matches the balanced ≤5-per-row product spec through the roster cap', () => {
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
        20: [5, 5, 5, 5],
        21: [4, 4, 4, 4, 5],
        22: [4, 4, 4, 5, 5],
        23: [4, 4, 5, 5, 5],
        24: [4, 5, 5, 5, 5],
        25: [5, 5, 5, 5, 5],
        26: [4, 4, 4, 4, 5, 5],
        27: [4, 4, 4, 5, 5, 5],
        28: [4, 4, 5, 5, 5, 5],
        29: [4, 5, 5, 5, 5, 5],
        30: [5, 5, 5, 5, 5, 5],
        31: [4, 4, 4, 4, 5, 5, 5],
        32: [4, 4, 4, 5, 5, 5, 5],
        33: [4, 4, 5, 5, 5, 5, 5],
        34: [4, 5, 5, 5, 5, 5, 5],
        35: [5, 5, 5, 5, 5, 5, 5],
        36: [4, 4, 4, 4, 5, 5, 5, 5],
        37: [4, 4, 4, 5, 5, 5, 5, 5],
        38: [4, 4, 5, 5, 5, 5, 5, 5],
        39: [4, 5, 5, 5, 5, 5, 5, 5],
        40: [5, 5, 5, 5, 5, 5, 5, 5],
        41: [4, 4, 4, 4, 5, 5, 5, 5, 5],
        42: [4, 4, 4, 5, 5, 5, 5, 5, 5],
        43: [4, 4, 5, 5, 5, 5, 5, 5, 5],
        44: [4, 5, 5, 5, 5, 5, 5, 5, 5],
        45: [5, 5, 5, 5, 5, 5, 5, 5, 5],
        46: [4, 4, 4, 4, 5, 5, 5, 5, 5, 5],
        47: [4, 4, 4, 5, 5, 5, 5, 5, 5, 5],
        48: [4, 4, 5, 5, 5, 5, 5, 5, 5, 5],
        49: [4, 5, 5, 5, 5, 5, 5, 5, 5, 5],
        50: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]
      }
      expect(Object.keys(expected)).toHaveLength(MAX_ENSEMBLE_PARTICIPANTS)
      for (const [count, rows] of Object.entries(expected)) {
        expect(computeEnsembleChipRowDistribution(Number(count)), `count ${count}`).toEqual(rows)
      }
    })

    it('yields index-aligned grid spans that fill each 60-track row exactly', () => {
      // Past 50 (MAX_ENSEMBLE_PARTICIPANTS) on purpose: the spans are keyed off
      // models PLUS externals now, and external seats are not capped, so counts
      // above the model limit reach this helper for the first time.
      for (let count = 6; count <= 60; count++) {
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

  it('spans every chip when an external seat is what pushed the strip into the grid', () => {
    // Five models is the FLEX strip. One human joining makes six seats, which is
    // the wrapped 60-track grid — so all six chips, the human's included, must
    // carry a span. A span-less chip takes one track of sixty.
    //
    // At HEAD the mode was chosen on the merged count while the spans were
    // computed on the model-only count, so this configuration wrapped with NO
    // spans at all and every chip, models included, collapsed to a sliver.
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
        externalSeats={[{ shareId: 'share-1', collaboratorId: 'collab-1', displayName: 'Dana' }]}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    // The anti-cheat: making the strip stop wrapping would also green a naive
    // span assertion. It must wrap AND span.
    expect(html).toContain('is-wrapped')
    // 6 seats → 3 + 3 → six span-20 chips, the external among them.
    expect(html.match(/grid-column:span 20/g) || []).toHaveLength(6)
    expect(html).toMatch(/ensemble-above-chip--external"[^>]*style="[^"]*grid-column:span 20/)
  })

  it('stacks the control rail on the same count that wraps the chips', () => {
    // The rail exists to stop the columns jumping when the strip wraps, so it
    // has to switch on the same number. Gated on models only, a 5-model panel
    // plus one human wrapped the chips and left the rail in its single-row form.
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
        externalSeats={[{ shareId: 'share-1', collaboratorId: 'collab-1', displayName: 'Dana' }]}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('ensemble-above-row-controls is-stacked')
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
    expect(html).toContain('class="ensemble-above-row-controls"')
  })
})

describe('seat-change failure supersede display', () => {
  const failedLaneRound = (
    laneOverrides: Partial<import('../../../main/store/types').ConcurrentLane> = {}
  ): NonNullable<ChatRecord['ensemble']>['activeRound'] => ({
    roundId: 'round-1',
    status: 'completed',
    prompt: 'Fan out.',
    startedAt: '2026-08-05T00:00:00.000Z',
    endedAt: '2026-08-05T00:05:00.000Z',
    participants: [
      {
        participantId: 'ensemble-claude',
        provider: 'claude',
        role: 'Explorer',
        order: 1,
        status: 'idle'
      }
    ],
    lanes: {
      'lane-round-1-ensemble-claude-1': {
        laneId: 'lane-round-1-ensemble-claude-1',
        participantId: 'ensemble-claude',
        provider: 'claude',
        status: 'failed',
        intent: 'read',
        startedAt: '2026-08-05T00:01:00.000Z',
        reason: 'Lane dispatch failed.',
        ...laneOverrides
      }
    }
  })

  it('still paints an ordinary failed lane as failed (baseline)', () => {
    const chat = makeChat([makeParticipant({ id: 'ensemble-claude', role: 'Explorer' })])
    chat.ensemble!.activeRound = failedLaneRound()
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('status-failed')
    expect(html).toContain('is-failed-accent')
    expect(html).toContain('failed: Lane dispatch failed.')
  })

  it('drops the failed paint for a lane superseded by an authoritative seat change', () => {
    const chat = makeChat([makeParticipant({ id: 'ensemble-claude', role: 'Explorer' })])
    chat.ensemble!.activeRound = failedLaneRound({
      failureSupersededBySeatChangeAt: '2026-08-05T00:30:00.000Z'
    })
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    // The cleared round state (idle) shows; neither the red accent nor the
    // stale lane failure reason survives the seat change.
    expect(html).not.toContain('status-failed')
    expect(html).not.toContain('is-failed-accent')
    expect(html).not.toContain('Lane dispatch failed.')
    expect(html).toContain('status-idle')
  })

  it('keeps live lane paint intact for superseded-marker-free running lanes', () => {
    const chat = makeChat([makeParticipant({ id: 'ensemble-claude', role: 'Explorer' })])
    chat.ensemble!.activeRound = failedLaneRound({ status: 'running', reason: undefined })
    chat.ensemble!.activeRound!.status = 'running'
    const html = renderToStaticMarkup(
      <EnsembleParticipantsAboveRow
        chat={chat}
        selectedParticipantId={null}
        onSelectParticipant={() => undefined}
        onChatChange={() => undefined}
      />
    )
    expect(html).toContain('status-speaking')
  })
})
