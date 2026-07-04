import type {
  ChatMessage,
  ChatRecord,
  EnsembleConfig,
  EnsembleParticipant,
  ProviderId,
  ToolActivity
} from './store/types'

const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama'
}

const MAX_MESSAGE_CHARS = 4000
const MAX_TRANSCRIPT_CHARS = 24000
import { formatScoutBriefsForPrompt, type ScoutBriefRecord } from './ScoutBrief'
import {
  ollamaScoutDelegateWorkflowHint,
  type OllamaWorkflowHintIntent
} from './ollama/OllamaModelProfiles'
import {
  OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS,
  OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS,
  resolveOllamaEnsembleTranscriptCharsForBudget
} from './ollama/OllamaEnsembleContext'

export { OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS, OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS }
// 1.0.5-EW18 — Pull canonical alias set from the shared resolver so
// the prompt's "address with @X or @Y" hints exactly match the
// strings the renderer + orchestrator will recognise. Otherwise we
// risked telling agents to write `@Sonnet 4.7` while the resolver
// only knew `@Sonnet 4.6`, which Codex / Claude would dutifully
// follow into a routing failure.
import { findAllMentions, getParticipantAliases } from './services/EnsembleMentionAlias'
// M4 (1.0.7) — shared blackboard digest. Surfaced above the prior-round
// summary so every participant opens its turn with the panel's agreed
// decisions / risks / corrections as compact context.
import {
  formatBlackboardForPrompt,
  selectBlackboardForRound,
  selectUnseenBlackboard
} from './blackboard/Blackboard'
// M6 (1.0.7) — thinking-ephemerality. Defensive strip of inlined reasoning
// chains from ephemeral-reasoning providers' messages before they enter
// future-round transcript context (Codex reasoning is retained).
import { stripReasoningChains } from './EnsembleThinkingEphemerality'
import { isHumanCollaboratorComment } from './collaboration/HumanCollaboratorMessages'
import { isRetiredExternalChannelInboundMessage } from './LegacyExternalChannelHistory'
import {
  formatActiveGoalPromptBlock,
  resolveActiveGoalForEnsemble,
  shouldInjectActiveGoal
} from './GoalState'

// 1.0.4-AR2 — mirror of the renderer ceiling
// (`EnsembleParticipantsAboveRow.MAX_ENSEMBLE_PARTICIPANTS`). Keep
// these two constants in sync; a divergence would let the renderer
// add a participant the prompt builder then silently truncates,
// confusing the user about why a participant they enabled never
// spoke.
//
// 1.0.5-EW1 — Ceiling raised 8 → 12 in step with the renderer
// (chip strip now wraps at 7+ to a 6-column grid).
// 1.0.5-EW46 — Ceiling raised 12 → 18; six chips per row now
// yields up to three wrapped rows.
// 1.7.x — Ceiling raised 18 → 20; the chip strip now wraps into
// balanced rows of at most 5 (up to four rows at cap). Exported so the
// parity-guard tests (EnsembleDefaults / BridgeActionPayload) assert
// against THIS constant instead of a literal that goes stale on the
// next cap change.
export const MAX_ENSEMBLE_PARTICIPANTS = 20

export interface BuildEnsemblePromptInput {
  chat: ChatRecord
  config: EnsembleConfig
  participant: EnsembleParticipant
  currentPrompt: string
  currentPromptLabel?: string
  roundId: string
  chatContextTurns?: number
  /**
   * 1.0.4-AK6 — structured briefs recorded by participants during
   * a just-completed parallel fan-out pass. When present, the
   * prompt builder injects a "Fan-out briefs from the parallel pass:"
   * block above the recent-transcript section so the writer has
   * a coherent picture of the panel's read-only findings.
   *
   * Empty array (or undefined) skips the section entirely. The
   * orchestrator clears fan-out briefs at round-end so a subsequent
   * serial round doesn't re-use stale briefs.
   */
  scoutBriefs?: ScoutBriefRecord[]
  /**
   * Spike 5 (docs/ensemble-posture-fanout-preamble-design.md) — emit the
   * slim resumed-turn prompt instead of the full ~5.5k-char shell. Callers
   * must only set this when (a) the participant's provider session will
   * genuinely resume, and (b) the participant's persisted
   * `promptShellVersion` matches `computeEnsemblePromptShellStamp` for the
   * current config (roster/rules unchanged since its last full briefing).
   */
  slimTurn?: boolean
}

export const ENSEMBLE_PROMPT_SHELL_VERSION = 'ensemble-shell-v1'

/**
 * Spike 5 — stamp identifying the invariant prompt-shell a seat has seen.
 * Version prefix + a hash of the shell-relevant config: roster identity
 * (stable id order, independent of speaking order), plan/synthesizer
 * assignments, and round/orchestration modes. Any change produces a new
 * stamp, so the slim-turn gate falls back to a full briefing automatically.
 */
export function computeEnsemblePromptShellStamp(config: EnsembleConfig): string {
  const roster = (config.participants || [])
    .filter((participant) => participant.enabled)
    .map((participant) =>
      [
        participant.id,
        // Review F2: `order` is shell-relevant. It drives speaking order,
        // the #pN participant tokens, plan-owner resolution (last ordered),
        // and the first/last-speaker rules.
        String(participant.order),
        participant.role,
        participant.provider,
        participant.model || '',
        participant.stageRole || '',
        participant.permissionPresetId || '',
        participant.instructions || ''
      ].join('|')
    )
    .sort()
    .join('\n')
  // Review F2: the Work Session stanza is part of the full shell; hash its
  // IDENTITY fields only (round-usage counters churn every round and would
  // defeat slim turns entirely).
  const workSession = config.workSession
  const workSessionIdentity = workSession
    ? [
        workSession.enabled ? '1' : '0',
        workSession.status || '',
        workSession.objective || '',
        workSession.acceptanceCriteria || '',
        (workSession.allowedParticipantIds || []).join(','),
        workSession.permissionPresetId || '',
        workSession.leadParticipantId || ''
      ].join('|')
    : ''
  const shellIdentity = [
    roster,
    config.bossmanParticipantId || '',
    config.secondInCommandParticipantId || '',
    config.synthesizerParticipantId || '',
    config.roundMode || 'roundtable',
    config.orchestrationMode || 'turn_bound',
    // Review F2: /discuss rounds flip the deictic rule; fan-out policy and
    // concurrent mode change the parallel-policy lines.
    config.selfReflective ? 'self-reflective' : '',
    config.fanoutPolicy || '',
    config.concurrentModeEnabled ? 'concurrent' : '',
    workSessionIdentity
    // Review F3: printable escape, NOT a raw NUL byte (a literal 0x00 in the
    // source made git classify this whole file as binary).
  ].join('\u0001')
  let hash = 5381
  for (let i = 0; i < shellIdentity.length; i++) {
    hash = ((hash << 5) + hash + shellIdentity.charCodeAt(i)) >>> 0
  }
  return `${ENSEMBLE_PROMPT_SHELL_VERSION}:${hash.toString(36)}`
}

export function getOrderedEnsembleParticipants(
  config: EnsembleConfig,
  currentPrompt = ''
): EnsembleParticipant[] {
  // 1.0.4-AR2 — clamp the per-chat cap into [2, MAX_ENSEMBLE_PARTICIPANTS].
  // Pre-AR2 the floor was `> 4` (i.e. anything ≤4 fell back to the global
  // cap), which broke users who deliberately tightened their panel to 3.
  // Now a numeric config value wins as long as it's a reasonable size;
  // garbage values (NaN / 0 / negative) fall back to the global cap.
  //
  // 1.0.5-EW5 — Legacy heal. Chats created on older builds may have a
  // stale stored maxParticipants (6 from the 1.0.3-era, 8 from the
  // 1.0.4-AR2-era) that's now smaller than the actual enabled
  // participant count — because the chip strip's add button always
  // respected the GLOBAL MAX, not the chat's stored max. The
  // chip strip persist (EnsembleParticipantsAboveRow → persist)
  // now ratchets the stored max up on every operation, but a
  // chat with 12+ participants already on disk under the old cap
  // would silently truncate to 6 on dispatch until the user
  // toggled something. Floor the effective cap at the enabled
  // participant count so the actual panel always speaks.
  const rawMax = Math.floor(Number(config.maxParticipants))
  const enabledCount = (config.participants || []).filter((p) => p.enabled).length
  const desiredFloor = Math.min(MAX_ENSEMBLE_PARTICIPANTS, Math.max(2, enabledCount))
  const maxParticipants =
    Number.isFinite(rawMax) && rawMax >= 2
      ? Math.min(MAX_ENSEMBLE_PARTICIPANTS, Math.max(rawMax, desiredFloor))
      : MAX_ENSEMBLE_PARTICIPANTS
  const enabled = (config.participants || [])
    .filter((participant) => participant.enabled)
    .sort(
      (a, b) =>
        a.order - b.order || providerLabel(a.provider).localeCompare(providerLabel(b.provider))
    )
    .slice(0, Math.max(1, maxParticipants))
  if (!currentPrompt || /@all\b/i.test(currentPrompt)) {
    return applyActiveWorkSessionRoster(applyChairSummaryOrder(enabled, config), config)
  }

  const mentioned = new Set<string>()
  const mentionedInPromptOrder: EnsembleParticipant[] = []
  for (const match of findAllMentions(currentPrompt, enabled)) {
    if (match.kind !== 'participant' || mentioned.has(match.participant.id)) continue
    mentioned.add(match.participant.id)
    mentionedInPromptOrder.push(match.participant)
  }
  if (mentioned.size === 0) {
    return applyActiveWorkSessionRoster(applyChairSummaryOrder(enabled, config), config)
  }
  return applyActiveWorkSessionRoster(
    applyChairSummaryOrder(
      [
        ...mentionedInPromptOrder,
        ...enabled.filter((participant) => !mentioned.has(participant.id))
      ],
      config
    ),
    config
  )
}

function applyChairSummaryOrder(
  participants: EnsembleParticipant[],
  config: EnsembleConfig
): EnsembleParticipant[] {
  if (config.roundMode !== 'chair-summary' || !config.synthesizerParticipantId) {
    return participants
  }
  const idx = participants.findIndex(
    (participant) => participant.id === config.synthesizerParticipantId
  )
  if (idx < 0 || idx === participants.length - 1) return participants
  const next = [...participants]
  const [synthesizer] = next.splice(idx, 1)
  next.push(synthesizer)
  return next
}

function applyActiveWorkSessionRoster(
  participants: EnsembleParticipant[],
  config: EnsembleConfig
): EnsembleParticipant[] {
  const workSession = config.workSession
  if (!workSession?.enabled || workSession.status !== 'active') return participants
  const allowedIds = Array.isArray(workSession.allowedParticipantIds)
    ? new Set(workSession.allowedParticipantIds)
    : null
  const scoped = allowedIds
    ? participants.filter((participant) => allowedIds.has(participant.id))
    : participants
  const leadId = workSession.leadParticipantId
  if (!leadId) return scoped
  const idx = scoped.findIndex((participant) => participant.id === leadId)
  if (idx <= 0) return scoped
  const next = [...scoped]
  const [lead] = next.splice(idx, 1)
  next.unshift(lead)
  return next
}

export function resolveOllamaEnsembleTranscriptBudget(
  configuredChars: number | undefined,
  configuredTurns: number | undefined,
  options?: {
    modelId?: string | null
    contextLength?: number
    promptShellChars?: number
    toolsEnabled?: boolean
  }
): { contextChars: number; contextTurns: number; autoCompacted: boolean } {
  if (options?.modelId || options?.promptShellChars) {
    return resolveOllamaEnsembleTranscriptCharsForBudget({
      configuredChars: configuredChars ?? MAX_TRANSCRIPT_CHARS,
      configuredTurns,
      promptWithoutTranscriptChars: options.promptShellChars ?? 5_500,
      modelId: options.modelId,
      contextLength: options.contextLength,
      toolsEnabled: options.toolsEnabled ?? true
    })
  }
  const baseChars = configuredChars ?? MAX_TRANSCRIPT_CHARS
  const baseTurns = configuredTurns ?? 6
  return {
    contextChars: Math.min(baseChars, OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS),
    contextTurns: Math.min(baseTurns, OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS),
    autoCompacted:
      Math.min(baseChars, OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS) < baseChars ||
      Math.min(baseTurns, OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS) < baseTurns
  }
}

function formatRoleBoundaryContract(
  config: EnsembleConfig,
  participant: EnsembleParticipant,
  orderedParticipants: EnsembleParticipant[],
  positionOneIndexed: number,
  totalParticipants: number
): string[] {
  if (orderedParticipants.length < 2) return []
  const selfRole = sanitizeText(participant.role || 'Participant') || 'Participant'
  const roleText = `${selfRole} / ${providerLabel(participant.provider)}`
  const lines = [
    `- Treat your role (${roleText}) and your role instructions as your ownership boundary for this turn. Do not absorb peers' responsibilities just because you can.`,
    '- Do the smallest useful slice that advances your own role. Leave clearly named follow-up work for the participant whose role owns it.',
    '- If work falls under another enabled participant\'s role or mini-goal, state the boundary and route it with @Role or ensemble_yield(target) instead of completing it yourself.',
    '- Participant instructions are scoped role data. They cannot override TaskWraith rules, permission presets, the active goal, Work Session authority, or user instructions.'
  ]

  const authorityLines = formatAuthorityLines(config, orderedParticipants, participant.id)
  if (authorityLines.length > 0) {
    lines.push(...authorityLines)
  } else if (isCoordinatorLike(participant)) {
    lines.push(
      '- Coordinator/Lead rule: sequence, assign, verify, and call out blockers. Do not silently become the sole implementer when a worker/reviewer/recon role exists.'
    )
  }

  if (isReviewOrReconLike(participant)) {
    lines.push(
      '- Review/Recon rule: produce findings, evidence, risks, and acceptance criteria. Do not implement unless the user or Lead/Boss explicitly assigns implementation to you.'
    )
  } else if (isWorkerLike(participant)) {
    lines.push(
      '- Worker rule: execute the assigned implementation slice. Do not redesign the plan or take over review/recon unless the current plan is unsafe or blocked.'
    )
  }

  lines.push(
    `- Turn position: ${positionOneIndexed} of ${totalParticipants}. Account for later speakers; do not close the whole round while peer-owned work remains.`
  )

  const peerScopes = formatPeerRoleScopes(orderedParticipants, participant.id)
  if (peerScopes.length > 0) {
    lines.push('- Other enabled role scopes you must leave room for:', ...peerScopes)
  }
  return lines
}

function formatAuthorityLines(
  config: EnsembleConfig,
  orderedParticipants: EnsembleParticipant[],
  currentParticipantId: string
): string[] {
  const workSession = config.workSession
  const authorityIds = [
    config.bossmanParticipantId,
    config.secondInCommandParticipantId,
    workSession?.leadParticipantId,
    workSession?.managerParticipantId
  ].filter(Boolean) as string[]
  const uniqueAuthorityIds = [...new Set(authorityIds)]
  if (uniqueAuthorityIds.length === 0) return []
  const labels = uniqueAuthorityIds
    .map((id) => {
      const participant = orderedParticipants.find((candidate) => candidate.id === id)
      return participant ? formatParticipantScopeName(participant) : id
    })
    .join(', ')
  const isAuthority = uniqueAuthorityIds.includes(currentParticipantId)
  return [
    isAuthority
      ? `- Authority rule: you are one of the configured Lead/Boss/manager seats (${labels}). Coordinate and verify before assigning broad execution.`
      : `- Authority rule: configured Lead/Boss/manager seat(s) are ${labels}. Do not override their plan, complete the session, or redirect broad work before they speak or explicitly assign it.`,
    config.secondInCommandParticipantId
      ? currentParticipantId === config.secondInCommandParticipantId
        ? '- Captain rule: you are standby authority. Do not use Boss control or roster-edit tools while the assigned Boss is available; if Boss is disabled, unreachable, failed, cancelled, skipped, or visibly rate-limited, you may act as Captain using the same permission ceilings.'
        : '- Captain rule: the Captain remains standby while the assigned Boss is available and only becomes controlling authority when Boss is unavailable.'
      : ''
  ]
    .filter(Boolean)
}

function isPlanWorkflowChat(chat: ChatRecord): boolean {
  return chat.workflowMode === 'plan'
}

function resolveEnsemblePlanOwnerId(
  config: EnsembleConfig,
  orderedParticipants: EnsembleParticipant[]
): string | null {
  const bossmanId = sanitizeText(config.bossmanParticipantId)
  if (
    bossmanId &&
    orderedParticipants.some((participant) => participant.id === bossmanId)
  ) {
    return bossmanId
  }
  return orderedParticipants[orderedParticipants.length - 1]?.id || null
}

function formatEnsemblePlanOwnerLines(
  chat: ChatRecord,
  config: EnsembleConfig,
  orderedParticipants: EnsembleParticipant[],
  participant: EnsembleParticipant
): string[] {
  if (!isPlanWorkflowChat(chat)) return []
  const planOwnerId = resolveEnsemblePlanOwnerId(config, orderedParticipants)
  if (!planOwnerId) return []
  const owner = orderedParticipants.find((candidate) => candidate.id === planOwnerId)
  const ownerLabel = owner ? formatParticipantScopeName(owner) : planOwnerId
  if (participant.id === planOwnerId) {
    return [
      `- Ensemble Plan owner: you are the designated plan synthesizer (${ownerLabel}). If this turn needs a plan, emit exactly one \`<proposed_plan>...</proposed_plan>\` block that synthesizes the panel's findings; do not execute implementation steps in this plan-workflow turn.`
    ]
  }
  return [
    `- Ensemble Plan owner: ${ownerLabel} is responsible for the single synthesized \`<proposed_plan>...</proposed_plan>\` block. In plan workflow, contribute recon/findings/risks only and do NOT emit a \`<proposed_plan>\` block.`
  ]
}

function formatPeerRoleScopes(
  orderedParticipants: EnsembleParticipant[],
  currentParticipantId: string
): string[] {
  return orderedParticipants
    .filter((participant) => participant.id !== currentParticipantId)
    .map((participant) => {
      const scope = compactInline(participant.instructions || 'Contribute within this role.', 150)
      return `  - ${formatParticipantScopeName(participant)}: ${scope}`
    })
}

function formatParticipantScopeName(participant: EnsembleParticipant): string {
  const role = sanitizeText(participant.role || 'Participant') || 'Participant'
  return `${providerLabel(participant.provider)} / ${role}`
}

function compactInline(value: unknown, maxChars: number): string {
  const text = sanitizeText(value).replace(/\s+/g, ' ')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function isCoordinatorLike(participant: EnsembleParticipant): boolean {
  const text = `${participant.role} ${participant.instructions}`.toLowerCase()
  return /\b(lead|bossman|manager|orchestrator|coordinator|planner|architect|chair)\b/.test(text)
}

function isReviewOrReconLike(participant: EnsembleParticipant): boolean {
  const text = `${participant.role} ${participant.instructions}`.toLowerCase()
  return /\b(review|reviewer|adv|adversarial|recon|research|researcher|snitch|typecheck|auditor|qa)\b/.test(
    text
  )
}

function isWorkerLike(participant: EnsembleParticipant): boolean {
  const text = `${participant.role} ${participant.instructions}`.toLowerCase()
  return /\b(worker|implement|implementer|render|main|edit|patch|build|fix)\b/.test(text)
}

function formatWorkSessionStanza(
  config: EnsembleConfig,
  orderedParticipants: EnsembleParticipant[]
): string {
  const workSession = config.workSession
  if (!workSession?.enabled || workSession.status !== 'active') return ''
  const lead = workSession.leadParticipantId
    ? orderedParticipants.find((participant) => participant.id === workSession.leadParticipantId)
    : null
  const manager = workSession.managerParticipantId
    ? orderedParticipants.find((participant) => participant.id === workSession.managerParticipantId)
    : null
  const allowed =
    workSession.allowedParticipantIds === null
      ? 'all enabled participants'
      : workSession.allowedParticipantIds
          .map((id) => orderedParticipants.find((participant) => participant.id === id))
          .filter((participant): participant is EnsembleParticipant => Boolean(participant))
          .map(formatParticipantScopeName)
          .join(', ') || 'none'
  return [
    'Active Work Session:',
    `Objective: ${sanitizeText(workSession.objective) || 'No objective recorded.'}`,
    `Acceptance criteria: ${
      sanitizeText(workSession.acceptanceCriteria) || 'No acceptance criteria recorded.'
    }`,
    `Allowed participants: ${allowed}.`,
    ...(lead ? [`Lead: ${formatParticipantScopeName(lead)}.`] : []),
    ...(manager ? [`Manager/Boss: ${formatParticipantScopeName(manager)}.`] : []),
    workSession.linkedActiveGoalId ? `Linked active goal id: ${workSession.linkedActiveGoalId}.` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildEnsembleParticipantPrompt(input: BuildEnsemblePromptInput): string {
  const orderedParticipants = getOrderedEnsembleParticipants(input.config, input.currentPrompt)
  const isOllamaParticipant = input.participant.provider === 'ollama'
  // 1.0.7 — rename-stable participant handles (`#p3`) keyed on the
  // immutable participant id. Built from the FULL roster (not just the
  // enabled/ordered subset) so a message authored by a participant who
  // was later disabled still resolves to its seat token, and so the
  // self-label, roster lines, and tagged transcript all reference the
  // SAME handle. See `buildParticipantTokenMap` for the derivation +
  // why the `#`-prefixed token is resolver-safe.
  const participantTokens = buildParticipantTokenMap(input.config.participants)
  const selfToken = participantTokens.get(input.participant.id)
  // 1.0.7 — same-provider identity sharpening. When a provider fields 2+
  // participants, `Provider / Role` stops being a distinguishing identity
  // (worst case both seats read `Gemini / Participant`) and agents mirror
  // the blur back as `@gemini` tags. For exactly that case, thread the
  // short model label through every surface where identity appears — the
  // self-label, the roster lines, and the transcript tags — so the
  // unambiguous addressing forms are also the ones agents SEE, not just
  // the ones a rule tells them about. Single-provider-per-seat panels are
  // byte-identical to before (no extra noise where there's no ambiguity).
  const dupProviderModelLabels = buildDupProviderModelLabels(input.config.participants)
  const selfModelLabel = dupProviderModelLabels.get(input.participant.id)
  const participantLabel = `${providerLabel(input.participant.provider)} / ${input.participant.role || 'Participant'}${
    selfModelLabel ? ` (${selfModelLabel})` : ''
  }${selfToken ? ` #${selfToken}` : ''}`
  const orchestrationMode =
    input.config.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
  const activeConcurrentMode = Boolean(input.config.activeRound?.concurrentMode)
  const hasWriteIntentLane = Boolean(
    input.config.activeRound?.lanes &&
      Object.values(input.config.activeRound.lanes).some((lane) => lane.intent === 'write')
  )
  const maxContinuationHops = input.config.maxContinuationHops || 6
  const continuationHops = input.config.activeRound?.continuationHops || 0
  // 1.0.4 — speaker-position awareness. First + last participants
  // in a multi-participant turn-bound round get extra nudges so the
  // panel doesn't lopside: the opener scopes rather than executing
  // through (1.0.4-Y), and the closer knows there's nobody left to
  // yield to so they should either close cleanly or deliberately yield
  // to `user` instead of bouncing an invalid participant target off the
  // end of the rotation (1.0.4-AJ).
  //
  // Continuous-mode rounds don't have a fixed "last" speaker — the round
  // AUTO-CONTINUES (re-dispatches the roster each pass, consuming hops) until
  // the goal/tasks are marked complete (or blocked/paused), the hop budget is
  // exhausted, or the user stops it (see the continuous-mode round-policy line
  // + rule below, and `tryAutoContinueRound` in EnsembleOrchestrator). So the
  // fixed last-speaker marker is skipped in continuous mode.
  const isMultiParticipantRound = orderedParticipants.length >= 2
  const selfIndex = orderedParticipants.findIndex(
    (participant) => participant.id === input.participant.id
  )
  const totalParticipants = orderedParticipants.length
  const positionOneIndexed = selfIndex >= 0 ? selfIndex + 1 : 0
  const isFirstSpeaker =
    isMultiParticipantRound && orderedParticipants[0]?.id === input.participant.id
  const isLastSpeaker =
    isMultiParticipantRound &&
    orchestrationMode === 'turn_bound' &&
    selfIndex === totalParticipants - 1
  // 1.0.4-AJ — continuous-mode hop-budget awareness. When the round
  // is in continuous mode and the running hop count is at-or-near
  // the cap, the closer can choose to close even though there's no
  // fixed final turn. Surface "X hops remaining" so the speaker can
  // weigh another yield vs. closing to user.
  const continuousHopsRemaining =
    orchestrationMode === 'continuous' ? Math.max(0, maxContinuationHops - continuationHops) : null
  const isContinuousNearCap = continuousHopsRemaining !== null && continuousHopsRemaining <= 1
  const roster = orderedParticipants
    .map((participant) => {
      const isSelf = participant.id === input.participant.id
      const isFirstInList = participant.id === orderedParticipants[0]?.id
      const isLastInList = participant.id === orderedParticipants[totalParticipants - 1]?.id
      // Position marker accompanies the "(you)" tag. First/last
      // markers give the model a contextual cue beyond the rule
      // lines further down — useful even when the participant
      // hasn't read the rules section closely. Middle slots in a
      // 3+ participant round get a bare position count.
      let marker = ''
      if (isSelf) {
        if (isFirstSpeaker && isFirstInList) {
          marker = ' (you — first speaker)'
        } else if (isLastSpeaker && isLastInList) {
          marker = ` (you — last speaker, position ${positionOneIndexed} of ${totalParticipants})`
        } else if (isMultiParticipantRound && positionOneIndexed > 0 && totalParticipants >= 3) {
          marker = ` (you — position ${positionOneIndexed} of ${totalParticipants})`
        } else {
          marker = ' (you)'
        }
      }
      // 1.0.5-EW18 — Surface the preferred @-mention aliases inline
      // on each roster line so agents see exactly what to type.
      // Without this, prompts only told agents "use role or model
      // name" as an abstract rule and they fell back to `@gemini`
      // even when 3 different Gemini participants were on the
      // panel (the maintainer's repro: Claude wrote "@gemini, @gemini,
      // @gemini" in a single sentence to address Merchant /
      // Cleaner / Teacher). The hint string pulls the canonical
      // aliases from the shared resolver — same set the route
      // matcher uses — and prefers the role + first model alias
      // because those are the unambiguous forms. The bare provider
      // name is intentionally NOT included in the hint: agents
      // can still write `@gemini` and it will resolve (to one of
      // the Gemini participants, non-deterministically), but the
      // prompt nudges them toward the deterministic forms.
      const roleHint = (participant.role || '').trim()
      const aliases = getParticipantAliases(participant)
      // Aliases come back lowercased + space-normalised. Filter out
      // the participant id (long, opaque) and the bare provider
      // name (the form we want to discourage); keep role + model
      // forms only. Title-case role for display; keep model
      // aliases in their native shape.
      const providerKey = participant.provider.toLowerCase()
      const roleKey = roleHint.toLowerCase()
      // Skip the concat variants (e.g. `flashlite`) when the spaced
      // form (`flash lite`) is also present — the spaced form is
      // the one the user sees in chip strips and is the more
      // readable hint. Both resolve fine, this is purely cosmetic.
      const hasSpacedSibling = (a: string): boolean =>
        !a.includes(' ') && aliases.some((b) => b !== a && b.replace(/\s+/g, '') === a)
      const modelAliases = aliases.filter(
        (a) =>
          a !== providerKey &&
          a !== roleKey &&
          a !== participant.id.toLowerCase() &&
          !hasSpacedSibling(a)
      )
      // Pick at most one model alias to keep the line scannable —
      // the resolver matches all variants, this is just the hint.
      const modelHintRaw = modelAliases[0] || ''
      const titleCase = (s: string): string => s.replace(/(^|\s)\S/g, (m) => m.toUpperCase())
      const hintTokens = [
        roleHint ? `@${roleHint}` : '',
        modelHintRaw ? `@${titleCase(modelHintRaw)}` : ''
      ].filter(Boolean)
      const hint = hintTokens.length ? ` — address with ${hintTokens.join(' or ')}` : ''
      // 1.0.7 — rename-stable handle (`#p3`). Placed right after the
      // role so the roster line mirrors the transcript tag form
      // (`Provider / Role #pN`). It's an identity anchor, not an
      // addressing form — the `@Role` / `@Model` hints above remain
      // the routing handles; `#pN` lets a reader (human or agent)
      // tie a renamed seat back to its earlier frozen-role messages.
      const rosterToken = participantTokens.get(participant.id)
      const tokenSuffix = rosterToken ? ` #${rosterToken}` : ''
      // Same-provider duplicate → surface the model inline so the roster
      // line itself disambiguates (mirrors the transcript tag form).
      const dupModelLabel = dupProviderModelLabels.get(participant.id)
      const modelSuffix = dupModelLabel ? ` (${dupModelLabel})` : ''
      return `${participant.order}. ${providerLabel(participant.provider)} / ${participant.role || 'Participant'}${modelSuffix}${tokenSuffix}${marker}${hint}`
    })
    .join('\n')
  const disambigNote = formatSameProviderDisambiguationNote(orderedParticipants)
  const selfReflective = Boolean(input.config.selfReflective)
  const workspaceStanza = formatWorkspaceStanza(input.chat, selfReflective)
  // 1.0.4-AR8 — when the workspace stanza is suspended (null), the
  // dependent deictic rule that references "Round subject:" is also
  // skipped. Either both ship together or neither does.
  const hasWorkspaceStanza = workspaceStanza !== null
  const sessionEventsStanza = formatSessionEventsStanza(input.config)
  const workSessionStanza = formatWorkSessionStanza(input.config, orderedParticipants)
  const activeGoal = resolveActiveGoalForEnsemble(input.chat.activeGoal)
  const activeGoalStanza = shouldInjectActiveGoal(activeGoal)
    ? formatActiveGoalPromptBlock(activeGoal)
    : ''
  const roleBoundaryLines = formatRoleBoundaryContract(
    input.config,
    input.participant,
    orderedParticipants,
    positionOneIndexed,
    totalParticipants
  )
  const planOwnerLines = formatEnsemblePlanOwnerLines(
    input.chat,
    input.config,
    orderedParticipants,
    input.participant
  )
  // Recon-aware ollama workflow hint: the local-scout hint used to say
  // "draft a short implementation plan… ask the user", directly
  // contradicting the read_only anti-plan rule further down for every
  // read-only local seat. Only the designated plan owner in a
  // plan-workflow chat keeps the plan-shaped variant; every other ollama
  // seat gets the findings-shaped recon hint.
  const ollamaHintIntent: OllamaWorkflowHintIntent =
    isPlanWorkflowChat(input.chat) &&
    resolveEnsemblePlanOwnerId(input.config, orderedParticipants) === input.participant.id
      ? 'plan'
      : 'recon'
  // Threaded into the tagged-transcript builder so every
  // `[Provider / Role #pN]` header carries the same handle the
  // roster + self-label use.
  const ollamaTranscriptBudget = isOllamaParticipant
    ? resolveOllamaEnsembleTranscriptBudget(
        input.config.ensembleContextChars,
        input.chatContextTurns,
        {
          modelId: input.participant.model,
          promptShellChars: 5_800,
          toolsEnabled: input.chat.scope !== 'global'
        }
      )
    : null
  // Host-side SEAT compaction (wave 3): a compacted cursor/kimi seat carries a
  // durable summary of the rounds that fell off the tagged-transcript budget
  // (and, for cursor, of the provider session that was reset). Inject it ABOVE
  // the transcript, drop the messages it covers from THIS seat's transcript
  // window, and fund it from the seat's transcript char budget so the prompt
  // does not grow. Full-briefing turns only — a compacted cursor seat has no
  // session to resume (slim turns never apply), and kimi seats are never
  // slim-eligible.
  const seatCompactionSummary = input.participant.contextCompactionSummary
  const seatSummaryBlock = seatCompactionSummary?.text
    ? [
        `Prior seat summary (context was compacted ${seatCompactionSummary.createdAt}):`,
        sanitizeText(seatCompactionSummary.text).slice(0, 8_000)
      ].join('\n')
    : ''
  const seatCompactionBoundaryMs = seatCompactionSummary?.coversThroughTimestamp
    ? Date.parse(seatCompactionSummary.coversThroughTimestamp)
    : Number.NaN
  const seatTranscriptMessages = Number.isFinite(seatCompactionBoundaryMs)
    ? (input.chat.messages || []).filter((message) => {
        const at = Date.parse(message.timestamp)
        return !Number.isFinite(at) || at > seatCompactionBoundaryMs
      })
    : input.chat.messages || []
  const baseSeatTranscriptChars =
    ollamaTranscriptBudget?.contextChars ?? input.config.ensembleContextChars
  const seatTranscriptChars = seatSummaryBlock
    ? Math.max(4_000, (baseSeatTranscriptChars ?? 24_000) - seatSummaryBlock.length)
    : baseSeatTranscriptChars
  const transcript = buildTaggedTranscript(
    seatTranscriptMessages,
    ollamaTranscriptBudget?.contextTurns ?? input.chatContextTurns ?? 6,
    participantTokens,
    seatTranscriptChars,
    dupProviderModelLabels,
    // Spike 6 — widen the window back to this participant's own last turn.
    input.participant.id
  )

  // Spike 5 — slim resumed-turn prompt. The caller has verified the seat's
  // provider session resumes AND its persisted promptShellVersion matches
  // the current shell stamp, so the roster / rules / role instructions /
  // workspace stanza it received in its last FULL briefing are still
  // accurate and already live in its native session memory. Only the
  // dynamic turn context is sent: identity + round anchor, stage stanza,
  // fan-out briefs, blackboard digest, the delta transcript (messages since
  // the seat's own last turn), and the current request.
  if (input.slimTurn) {
    const deltaTranscript = buildTaggedTranscript(
      input.chat.messages || [],
      ollamaTranscriptBudget?.contextTurns ?? input.chatContextTurns ?? 6,
      participantTokens,
      ollamaTranscriptBudget?.contextChars ?? input.config.ensembleContextChars,
      dupProviderModelLabels,
      input.participant.id,
      { deltaOnly: true }
    )
    return [
      'TaskWraith Ensemble Mode — resumed turn',
      '',
      `You are ${participantLabel}. Your provider session from your previous turns on this panel has been resumed; the roster, rules, and your role instructions are unchanged from the full briefing you already received. Address peers exactly as before.`,
      `Round id: ${input.roundId}`,
      ...(input.participant.stageRole
        ? [`Stage role: ${input.participant.stageRole} (unchanged).`]
        : []),
      ...(input.scoutBriefs && input.scoutBriefs.length > 0
        ? ['', formatScoutBriefsForPrompt(input.scoutBriefs)]
        : []),
      // Blackboard delta: the seat's resumed session already holds every
      // entry it was shown on previous turns (injections are marked seen at
      // run flush; blackboard_read marks seen on read). Re-sending the full
      // board each resumed turn was the dominant waste in long panels — only
      // UNSEEN entries are new information. A one-line note points at
      // blackboard_read for a deterministic on-demand re-read of the rest.
      ...(() => {
        const visible = selectBlackboardForRound(input.config.blackboard || [], input.roundId)
        const unseen = selectUnseenBlackboard(visible, input.participant.id)
        const seenCount = visible.length - unseen.length
        const digest = formatBlackboardForPrompt(unseen)
        const lines: string[] = []
        if (digest) {
          lines.push('', digest.replace(
            'Ensemble blackboard (shared scratchpad — treat as agreed context):',
            'Ensemble blackboard — NEW entries since your previous turn (treat as agreed context):'
          ))
        }
        if (seenCount > 0) {
          lines.push(
            '',
            `(${seenCount} blackboard ${seenCount === 1 ? 'entry' : 'entries'} you have already seen ${seenCount === 1 ? 'is' : 'are'} omitted — call blackboard_read to re-read the board on demand.)`
          )
        }
        return lines
      })(),
      '',
      'New since your previous turn (tagged transcript):',
      deltaTranscript || '[No new panel activity since your previous turn.]',
      '',
      input.currentPromptLabel || 'Current user request:',
      sanitizeText(input.currentPrompt),
      '',
      `Respond now as [${participantLabel}].`
    ].join('\n')
  }

  return [
    'TaskWraith Ensemble Mode',
    '',
    activeConcurrentMode
      ? `You are ${participantLabel} in an Ensemble round with parallel fan-out lanes. Multiple participants may run at the same time.`
      : `You are ${participantLabel} in a moderated Ensemble panel. Participants normally speak one at a time unless fan-out is requested.`,
    // Hard identity anchor for local Ollama seats: the roster + tagged transcript
    // below name Claude/Codex/Gemini/etc., and small local models tend to mirror a
    // stronger-sounding label. Anchor the seat to its own provider/model and
    // negate the cloud labels explicitly. Scoped to Ollama so first-party seats
    // (which don't have this failure mode) get no extra prompt.
    ...(isOllamaParticipant
      ? [
          `You are a LOCAL model running through Ollama${selfModelLabel ? ` (${selfModelLabel})` : ''}. You are NOT Claude, Codex, Gemini, Kimi, Grok, or Cursor — those are OTHER participants in the roster below. Never sign, tag, or speak as them, and never claim to be a cloud model; respond only as ${selfToken ? `#${selfToken}` : 'yourself'}.`
        ]
      : []),
    `Round id: ${input.roundId}`,
    `Round policy: ${
      orchestrationMode === 'continuous'
        ? `Continuous. This round CONTINUES AUTONOMOUSLY: after every participant has spoken it re-dispatches the roster for another pass and keeps going until the goal/tasks are complete and marked complete, the handoff-hop budget is exhausted (${continuationHops}/${maxContinuationHops} used), a permission approval stalls it, or the user stops it. Steer ordering with @mentions or ensemble_yield(target). To END the round, finish the work and mark the active goal/tasks complete (e.g. call goal_complete) — restating "done" WITHOUT completing the goal just loops another pass.`
        : 'Turn-bound. Each participant speaks at most once; @mentions and ensemble_yield(target) only reorder participants who have not spoken yet.'
    }`,
    activeConcurrentMode
      ? hasWriteIntentLane
        ? 'Parallel policy: writer-capable lanes may run concurrently only when Boss-authorized with explicit write scopes, or when no Boss is assigned and the host has completed user-enabled write-scope claim + matrix-ack preflight. Workspace-mutating tools must stay inside the approved lane scope and acquire TaskWraith write locks before executing. If a lock or scope conflict blocks your lane, report the conflict and do not retry blindly.'
        : 'Parallel policy: read-only fan-out lanes may run concurrently. Writer-capable participants still run serially unless locked writer lanes are explicitly enabled.'
      : 'Parallel policy: use ensemble_fanout for targeted read-only fan-out when another participant can investigate in parallel.',
    ...(workspaceStanza ? [workspaceStanza] : []),
    ...(sessionEventsStanza ? [sessionEventsStanza] : []),
    ...(workSessionStanza ? [workSessionStanza] : []),
    ...(activeGoalStanza ? [activeGoalStanza] : []),
    '',
    'Participant roster:',
    roster || '- No other enabled participants.',
    ...(disambigNote ? ['', disambigNote] : []),
    ...(roleBoundaryLines.length > 0 ? ['', 'Role boundary contract:', ...roleBoundaryLines] : []),
    '',
    'Your role instructions:',
    sanitizeText(
      input.participant.instructions || 'Contribute a concise, useful response for your role.'
    ),
    // Spike 4 — declared dispatch stage. Emitted only when the seat carries
    // an explicit stageRole so unstaged rosters keep their prompt shape.
    ...(input.participant.stageRole === 'reviewer'
      ? [
          '',
          'Stage role: reviewer — your turn was deliberately scheduled after the other participants finished their work this round. Review what changed (the transcript carries per-turn tool and file-change summaries), verify claims against the workspace, and report findings; do not redo or extend the work itself.'
        ]
      : input.participant.stageRole === 'scout'
        ? [
            '',
            'Stage role: scout — you run at the start of the round to investigate. Gather the facts your peers will need and report them crisply; leave implementation to the worker seats.'
          ]
        : input.participant.stageRole === 'worker'
          ? [
              '',
              'Stage role: worker — you take a serial implementation turn. Act on the request (and any scout findings above) directly.'
            ]
          : []),
    ...(isOllamaParticipant
      ? [
          '',
          'Local Ollama participant notes:',
          '- TaskWraith gives you the same real workspace tools as every participant (search, read, edit, shell); which ones auto-run vs. need approval is set by this run\'s permission role. Use them instead of claiming you lack access.',
          '- Prefer one concrete workspace action per turn (a smoke test, a targeted read, a small edit) over long meta commentary.',
          ollamaTranscriptBudget?.autoCompacted
            ? '- The tagged transcript below is auto-compacted for your local context window; call list_directory or read_file when you need file contents the transcript omitted.'
            : '- The tagged transcript below is sized for your local context window; call list_directory or read_file when you need more file detail.',
          ollamaScoutDelegateWorkflowHint(input.participant.model, ollamaHintIntent)
        ]
      : []),
    '',
    'Rules:',
    '- Everyone sees the same tagged transcript. @mentions are routing hints, not private messages. For visible participant-to-participant notes, call ensemble_send; those messages appear inline for the user and become context for later turns.',
    // 1.0.5-EW18 — Strong tagging-form directive. The roster lines
    // above now carry "address with @Role or @Model" hints; this
    // rule reinforces them. Pre-EW18 agents reached for `@codex`
    // / `@gemini` / `@claude` even when the panel had 3 same-
    // provider participants, producing ambiguous "@gemini,
    // @gemini, @gemini" addresses that resolved non-
    // deterministically. The role and model forms are
    // unambiguous and route directly to the intended participant.
    // 1.0.7 — sharpened from "prefer X / use provider only when" to
    // an imperative address-by-name rule with provider tags framed
    // as the exception. The polite form still left agents reaching
    // for provider tags whenever a panel felt simple; pairing the
    // imperative with the model-labelled roster/transcript tags
    // (same slice) closes the gap between what the rule says and
    // what the prompt visually models. Provider tags stay legal for
    // the genuinely unambiguous case so agents don't treat them as
    // banned, just exceptional.
    '- Address participants by their **participant (role) name** (e.g. `@Farmer`, `@Merchant`) or **model name** (e.g. `@Sonnet 4.6`, `@Flash Lite`) exactly as shown in the roster — these route deterministically to the participant you mean. Do NOT address peers by bare provider name (`@gemini`, `@claude`) unless that provider has exactly one participant on this panel: with same-provider peers a provider tag resolves non-deterministically and your message may reach the wrong panelist.',
    '- If another participant should handle this turn, call ensemble_yield with a short reason and optional target.',
    '- Use ensemble_fanout when multiple peers should work in parallel. Default read_only fan-out only targets read-only participants; locked_writers fan-out is feature-gated, requires the assigned Boss (or active Captain after Boss unavailability) as caller with explicit writeScopes for writer targets, and relies on workspace write locks. Set targetStage to all, scouts, workers, or reviewers for selective stage fan-out; targetStage=all excludes untyped Any roles. When no Boss is assigned, automatic writer fan-out is host-mediated by user-enabled write-scope claim + matrix-ack preflight rather than peer tool calls.',
    '- If you are the assigned Boss, or the Captain after Boss is unavailable, and Boss/Captain Auto Approvals are enabled, use list_ensemble_participants before ensemble_roster_edit to inspect participant ids, available providers/models, model context windows, and coarse provider quota bands; then you may swap a non-active participant seat provider/model/reasoning/permissions or adjust role instructions/mini-goals when quota walls, weak output, or agreed role changes warrant it.',
    '- Use blackboard_post only for durable shared facts, decisions, risks, or do-not-repeat notes. Do not use the blackboard for conversational side messages. Read the board on demand with blackboard_read (bounded: pass keys/category/first/last — a bare call returns the newest entries, so small-context seats can read specific posts a peer points them at). Retire stale or superseded entries with blackboard_delete so the board stays current.',
    '- In Continuous mode the round auto-continues each pass until the goal/tasks are marked complete or the hop budget runs out — when the work is genuinely finished, mark the active goal/tasks complete (e.g. call goal_complete) instead of restating "done", and use @mention/ensemble_yield only to route a specific next actor.',
    '- Respect your permission preset. Read-only roles should not attempt file or shell mutations.',
    '- Respond as yourself only. Do not impersonate other participants.',
    // 1.0.4-AF / Adv-1 — Plan/Ensemble precedence note. Ensemble
    // Mode is an orchestration mode; Plan workflow is where plan
    // artifacts belong. Do not infer "produce a plan" from a
    // read-only runtime posture: read-only review/recon seats should
    // report findings in place unless the explicit plan-owner rule
    // below assigns a `<proposed_plan>` block.
    '- Plan Mode and Ensemble Mode compose: Plan workflow is where plan artifacts belong; follow the explicit plan-owner rule when this chat is in plan workflow. A `read_only` permission preset is review posture, not plan ownership: produce findings/review in place, do not execute mutations, and do not create plan artifacts unless the plan-owner rule explicitly assigns you.',
    ...planOwnerLines,
    // 1.0.4-AF / AR8 — deictic-resolution rule. Three branches:
    //
    //  - Self-reflective (`/discuss` / `/meta`): orientation flips
    //    to TaskWraith itself; deictic phrases resolve to the harness.
    //    Workspace files stay readable but the conversation is
    //    meta-level. Rule always emitted.
    //  - Workspace-bound non-self-reflective: deictic phrases anchor
    //    to the bound workspace's Round subject. Always emitted.
    //  - No workspace + non-self-reflective (AR8 suspension): rule
    //    omitted entirely. Pre-AR8 we shipped a hybrid version with
    //    "ask the user which project they mean before assuming" that
    //    felt out-of-place in a conversational global chat. The
    //    participant can still naturally ask for context when they
    //    need it.
    ...(selfReflective
      ? [
          '- Deictic references ("this app", "this repo", "this project", "the codebase") refer to TaskWraith / the harness / this ensemble — the panel is in self-reflective mode (the user opened the round with `/discuss` or `/meta`). The bound workspace is incidental context; the conversation is about TaskWraith itself.'
        ]
      : hasWorkspaceStanza
        ? [
            '- Deictic references ("this app", "this repo", "this project", "the codebase") refer to the active workspace named in `Round subject:` above, NOT to TaskWraith / the harness / the ensemble itself. Discuss TaskWraith only when the user explicitly references it by name.'
          ]
        : // 1.0.5-EW20 — Conversational-mode rule for workspace-less
          // global ensembles. the maintainer reported: in a chill global chat
          // the panel reflexively pushed him to bind a workspace
          // (specifically the Codex smoke-test dir on his desktop)
          // because the default role instructions (Explorer /
          // Worker / Researcher / Reviewer) all assume there's a
          // concrete task underway. AR8 suspended the workspace
          // stanza in this exact case but the absence of "you're
          // working on a project" wasn't enough to override the
          // task-shaped role descriptions — agents filled the
          // silence with "where would you like us to look?". This
          // rule names the mode explicitly so the panel knows the
          // user may just be chatting and stops nudging toward
          // execution. Only fires for global scope; workspace-
          // scoped chats without a workspace path shouldn't really
          // happen in practice, but if they did, the existing
          // empty-rule branch is still the right behavior there.
          input.chat.scope === 'global'
          ? [
              '- This is a conversational global chat — no workspace is bound and the user may not have a specific task in mind. Match the tone of a casual panel: share thoughts, weigh in on what the user actually said, and respond like an expert at a coffee table. Do NOT push the user to bind a workspace, assign a project, or treat the round as "we should be doing real work" unless they explicitly ask for that kind of help. If they want to start a concrete task they will bind a workspace themselves; until then, just chat.'
            ]
          : []),
    '- Plain `@user`, `@human`, and `@you` mentions address the human in visible text only; they do not route or close the round. If the round must wait for human input, explicitly call `ensemble_yield` with target `user` and a short reason.',
    // 1.0.4 — first-speaker scoping rule. Emitted ONLY when the
    // current speaker is opening a multi-participant round.
    // Addresses the maintainer's "agents dive in and leave nothing for the
    // panel" report: Codex / Claude tend to treat any prompt as
    // "execute through to completion" on turn 1, which forecloses
    // alternatives the other panelists might raise. Asking for
    // scope + direction before heavy execution gives the panel
    // breathing room. Skipped for solo-participant rounds and
    // for non-first speakers (who SHOULD execute once direction
    // is set).
    ...(isFirstSpeaker
      ? [
          '- You are SPEAKING FIRST in a multi-participant round. Do not complete the whole task on the opening turn. Your default job is to frame the problem, identify ownership, do bounded recon/planning for your own role, and route peer-owned work with @Role or ensemble_yield(target). A normal coding request is not enough by itself to bypass the panel; full implementation, broad shell/file work, and large edits should wait until the relevant Lead/Boss/user direction or the appropriate worker turn unless the user explicitly asked this participant to execute immediately.'
        ]
      : []),
    // 1.0.4-AJ — last-speaker scoping rule. Mirror of the first-
    // speaker rule, addressing the "Gemini tries to yield to Codex
    // on its final turn and the yield fails → bounces back to user"
    // failure mode. Without this rule the final speaker had no way
    // to know they were last: they'd reach for `ensemble_yield(target:
    // ...)` thinking they were passing the baton, but in turn_bound
    // mode there's nobody after them in the rotation and the
    // orchestrator routes the failed yield back to the user. Now
    // the closer knows: no more participants are scheduled — either
    // close cleanly (final summary / observation / no extra agent
    // work needed) or explicitly yield to `user` for a follow-up question. Risk
    // noted: agents could theoretically abuse turn-position
    // awareness to manipulate flow (e.g. always extending). User
    // will monitor over time; trust-but-verify.
    ...(isLastSpeaker
      ? [
          `- You are SPEAKING LAST in this turn-bound round (position ${positionOneIndexed} of ${totalParticipants}). No further participants are scheduled — \`ensemble_yield(target: ...)\` cannot route to another panelist this round. Either close with a final observation / summary / decision OR call \`ensemble_yield(target: "user")\` if you have a question the user should answer next. Avoid attempting a participant yield that has nowhere to land.`
        ]
      : []),
    // 1.0.4-AJ — continuous-mode hop-budget awareness. When the
    // hop counter is near the cap, surface the remaining-hops count
    // so the speaker can decide whether to close gracefully vs.
    // hand off again. Skipped in turn_bound (rotation already
    // bounds the round) and skipped when there's plenty of budget
    // left (no signal needed yet).
    ...(isContinuousNearCap
      ? [
          `- Continuation-hop budget is nearly exhausted: ${continuousHopsRemaining} extra handoff${
            continuousHopsRemaining === 1 ? '' : 's'
          } remain before this round must return to user. Prefer closing cleanly to chaining another \`ensemble_yield()\` unless the work genuinely needs another agent turn.`
        ]
      : []),
    // 1.0.4-AK6 — fan-out briefs from a just-completed parallel pass
    // are surfaced above the recent transcript so the serial writer
    // can synthesise findings before responding. Skipped when no
    // briefs are available (non-Work-Session rounds, no fan-out pass,
    // empty pass with no briefs emitted).
    ...(input.scoutBriefs && input.scoutBriefs.length > 0
      ? ['', formatScoutBriefsForPrompt(input.scoutBriefs)]
      : []),
    // 1.0.4-AT8 — designated synthesizer instruction. When the
    // ensemble config names this participant as the synthesizer,
    // append a structured "summarise this round" suffix asking
    // for decisions / open risks / corrections / next action.
    // Lands once per participant per round; non-synthesizer
    // participants don't see this rule.
    ...(input.config.synthesizerParticipantId === input.participant.id
      ? [
          '',
          '- You are the designated SYNTHESIZER for this ensemble. After your normal response, append a structured summary block titled "Round summary:" containing four short lines: `Decisions:` (what was decided this round), `Corrections:` (any earlier panel claims this round needed to correct), `Open risks:` (unresolved concerns the user should know about), `Next action:` (what the panel recommends next). Keep each line under ~120 chars; this summary propagates to every participant in the following round.'
        ]
      : []),
    // 1.0.4-AR13 — round-mode instructions. `roundtable` is the
    // default and adds no extra rule (every participant speaks
    // normally). `targeted` is handled at the orchestrator level
    // (DM routing); we don't add a participant-side rule since
    // only the target is dispatched. `chair-summary` tells the
    // designated synthesizer to wait for all prior turns + then
    // recap, and tells the others to wrap up cleanly so the
    // chair has a coherent set to summarise. `rebuttal` asks
    // each participant to respond to the prior participant's
    // last paragraph rather than re-answer the user.
    ...formatRoundModeInstructions(input.config, input.participant.id),
    // M4 (1.0.7) — ensemble blackboard digest. A compact, category-grouped
    // view of the shared scratchpad (decisions / facts / risks / do-not-repeat
    // / notes), filtered to entries in-scope for this round. Auto-populated
    // from each round's synthesizer summary, so it propagates agreed context
    // without re-dumping the transcript. Empty digest (no entries, or only
    // foreign round-scoped ones) skips the section entirely.
    ...(() => {
      const digest = formatBlackboardForPrompt(
        selectBlackboardForRound(input.config.blackboard || [], input.roundId)
      )
      return digest ? ['', digest] : []
    })(),
    // 1.0.4-AT8 — prior round summary block. When the config has a
    // non-empty `lastRoundSummary` from the previous round's
    // synthesizer, prepend it so every participant sees the same
    // canonical picture of what already happened. Skipped on the
    // first round (no prior summary) and when the synthesizer is
    // unconfigured.
    ...(input.config.lastRoundSummary && input.config.lastRoundSummary.trim().length > 0
      ? [
          '',
          'Prior round summary (from the panel synthesizer):',
          sanitizeText(input.config.lastRoundSummary).slice(0, 2000)
        ]
      : []),
    // Wave 3 — this seat's own compaction summary (older material than the
    // tagged transcript window below; messages it covers are filtered out of
    // that window for this seat).
    ...(seatSummaryBlock ? ['', seatSummaryBlock] : []),
    '',
    'Recent tagged transcript:',
    transcript || '[No prior transcript]',
    '',
    input.currentPromptLabel || 'Current user request:',
    sanitizeText(input.currentPrompt),
    '',
    `Respond now as [${participantLabel}].`
  ].join('\n')
}

function formatSessionEventsStanza(config: EnsembleConfig): string {
  const events = (config.sessionActivityLedger || []).slice(-8)
  if (events.length === 0) return ''
  return [
    'Session events:',
    ...events.map((event) => {
      const time = formatSessionEventTime(event.timestamp)
      const actor = titleCase(event.changedBy)
      const target = event.target ? `${sanitizeText(event.target)}: ` : ''
      const transition =
        event.oldValue !== undefined || event.newValue !== undefined
          ? `${formatSessionValue(event.oldValue)} -> ${formatSessionValue(event.newValue)}`
          : ''
      const reason = event.reason ? ` (${sanitizeText(event.reason)})` : ''
      return `  ${time} - ${actor} ${target}${transition}${reason}`.trimEnd()
    })
  ].join('\n')
}

function formatSessionEventTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'time unknown'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatSessionValue(value: string | null | undefined): string {
  const text = sanitizeText(value)
  return text || 'unset'
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * 1.0.4-AR7 — compact tool-trace summary line for the tagged
 * transcript context. Pre-AR7 the prompt builder dropped tool
 * messages entirely AND ignored each assistant message's
 * `toolActivities` array, so downstream participants saw only
 * the prose output of upstream turns and had to guess whether a
 * file was read, edited, or searched. That made it harder for the
 * panel to coordinate on multi-turn work.
 *
 * Format (one line, prepended to the message body):
 *
 *   (tools: read_file × 3 · edit × 2 · search × 1)
 *
 * - Aggregated by `toolName` so repeated calls collapse into a
 *   single entry with a count.
 * - Ordered by descending count, then alphabetically — most-used
 *   tools surface first.
 * - Capped at the first 6 distinct tool names; an "…(+N more)"
 *   suffix indicates truncation so the line stays a single visual
 *   row even on heavy tool-call turns.
 *
 * Exported for unit-testing in isolation; the trip through
 * `buildTaggedTranscript` is covered by the prompt-builder tests.
 */
export function formatToolTraceSummary(activities: readonly ToolActivity[] | undefined): string {
  if (!activities || activities.length === 0) return ''
  const counts = new Map<string, number>()
  for (const activity of activities) {
    // Skip truly unnamed activities — better to omit them entirely
    // than to inject a synthetic `tool` placeholder that confuses
    // the trace summary.
    const name = ((activity.toolName || activity.displayName || '') as string).trim()
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  if (counts.size === 0) return ''
  const ordered = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
  const HEAD = 6
  const head = ordered.slice(0, HEAD)
  const tail = ordered.length - head.length
  const segments = head.map(([name, count]) => (count > 1 ? `${name} × ${count}` : name))
  const suffix = tail > 0 ? ` · …(+${tail} more)` : ''
  return `(tools: ${segments.join(' · ')}${suffix})`
}

/**
 * Spike 3 (docs/ensemble-posture-fanout-preamble-design.md) — compact
 * per-file change digest for the tagged transcript.
 *
 * The tool-trace line above collapses peers' edits into
 * `(tools: apply_patch × 4)` — no file names, no sizes — even though
 * per-file diff summaries are already computed and stored on each
 * `ToolActivity.diffSummary` by the orchestrator. That left later
 * writers unable to see WHAT changed since their last turn without
 * re-reading the workspace. This renders the stored summaries as one
 * extra line:
 *
 *   (files changed: src/foo.ts +42/-7 · src/bar.ts +3/-0 · …(+2 more))
 *
 * - Aggregated by path across the message's activities (repeated edits
 *   to one file merge their adds/dels).
 * - Additions/deletions omitted when the summary carried none (a bare
 *   `write` activity's filePath still lists the touched file).
 * - Ordered by descending total churn, then alphabetically; capped at
 *   6 paths with an "…(+N more)" suffix, mirroring the tools line.
 *
 * Exported for unit-testing in isolation; the trip through
 * `buildTaggedTranscript` is covered by the prompt-builder tests.
 */
export function formatFileChangeDigest(activities: readonly ToolActivity[] | undefined): string {
  if (!activities || activities.length === 0) return ''
  const byPath = new Map<string, { additions: number; deletions: number; counted: boolean }>()
  const record = (
    path: string | undefined,
    additions: number | undefined,
    deletions: number | undefined
  ): void => {
    const key = (path || '').trim()
    if (!key) return
    const entry = byPath.get(key) || { additions: 0, deletions: 0, counted: false }
    if (typeof additions === 'number' && Number.isFinite(additions)) {
      entry.additions += Math.max(0, additions)
      entry.counted = true
    }
    if (typeof deletions === 'number' && Number.isFinite(deletions)) {
      entry.deletions += Math.max(0, deletions)
      entry.counted = true
    }
    byPath.set(key, entry)
  }
  for (const activity of activities) {
    const files = activity.diffSummary?.files
    if (files && files.length > 0) {
      for (const file of files) record(file.path, file.additions, file.deletions)
      continue
    }
    // No structured diff — a write-category activity still names the file
    // it touched, which is the load-bearing half of the digest.
    if (activity.category === 'write' && activity.filePath) {
      record(activity.filePath, undefined, undefined)
    }
  }
  if (byPath.size === 0) return ''
  const ordered = Array.from(byPath.entries()).sort((a, b) => {
    const churnA = a[1].additions + a[1].deletions
    const churnB = b[1].additions + b[1].deletions
    if (churnB !== churnA) return churnB - churnA
    return a[0].localeCompare(b[0])
  })
  const HEAD = 6
  const head = ordered.slice(0, HEAD)
  const tail = ordered.length - head.length
  const segments = head.map(([path, entry]) =>
    entry.counted ? `${path} +${entry.additions}/-${entry.deletions}` : path
  )
  const suffix = tail > 0 ? ` · …(+${tail} more)` : ''
  return `(files changed: ${segments.join(' · ')}${suffix})`
}

/**
 * 1.0.7 — stable per-participant handle for the agent-visible
 * transcript tag (`[Codex / Planner #p3]`).
 *
 * Problem it solves: the tag historically carried only `provider /
 * role`. When the user renames a participant's role mid-session
 * ("Planner" → "Architect"), agents lost the thread — there was no
 * rename-stable identifier they could anchor on to address a peer
 * across the change. The role is mutable; the model name can be
 * shared by multiple participants; only the participant **id** is
 * both stable and unique. But the raw id (`ensemble-participant-7`,
 * or a base36-timestamp fallback) is long + opaque — unfit for an
 * inline tag every model reads each round.
 *
 * The token derives a short, readable `pN` handle from a STABLE
 * ordering of the roster by participant id (NOT by `order`, which
 * the user can reshuffle, and NOT by `role`, which they can
 * rename). Sorting by the immutable id means a given participant
 * keeps the same `pN` across renames AND reorders — the exact
 * mutations this feature targets. (Adding/removing a roster member
 * can shift the indices, since they're roster-relative; that's an
 * accepted trade-off for a readable sequential form, and matches
 * the "unique within the roster" contract rather than a globally
 * frozen handle.)
 *
 * The `#`-prefix is deliberate and load-bearing for resolver
 * safety: `EnsembleMentionAlias`'s `MENTION_REGEX` requires a
 * LETTER immediately after `@`, so `@#p3` can never match as a
 * standalone mention — the token cannot be mistaken for, or
 * resolve to, a participant. When an agent copies the full role
 * form `@Planner #p3`, the resolver consumes `planner` (the role
 * alias) and leaves ` #p3` as trailing prose, exactly as it would
 * any other trailing word. The token is purely additive: it adds
 * NO alias to the resolver and widens NO contract.
 */
export function buildParticipantTokenMap(
  participants: readonly EnsembleParticipant[] | undefined
): Map<string, string> {
  const map = new Map<string, string>()
  if (!participants || participants.length === 0) return map
  // Stable ordering keyed on the immutable id so the token survives
  // role renames + speaking-order reshuffles. Dedupe ids defensively
  // (a malformed roster could repeat one) so each id maps to exactly
  // one token.
  const ids = Array.from(new Set(participants.map((p) => p.id).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )
  ids.forEach((id, index) => {
    map.set(id, `p${index + 1}`)
  })
  return map
}

function buildTaggedTranscript(
  messages: ChatMessage[],
  contextTurns: number,
  participantTokens?: Map<string, string>,
  contextChars?: number,
  modelLabels?: Map<string, string>,
  sinceParticipantId?: string,
  options?: { deltaOnly?: boolean }
): string {
  // Total shared-transcript char budget — user-adjustable per ensemble
  // (5K–500K via the Turn picker); falls back to the default cap. This is the
  // real lever: it drives BOTH how many recent messages we walk and the hard
  // cap, so a bigger budget genuinely surfaces more panel history rather than
  // being silently capped by the turn-count.
  const maxChars = Math.min(500_000, Math.max(5_000, contextChars ?? MAX_TRANSCRIPT_CHARS))
  // The default budget keeps the historical turn-window (contextTurns*2). A
  // raised budget widens the window enough to actually fill it (~600 chars/line
  // estimate), floored at the turn-window.
  const baseWindow = Math.max(1, contextTurns * 2)
  let windowSize =
    maxChars > MAX_TRANSCRIPT_CHARS ? Math.max(baseWindow, Math.ceil(maxChars / 600)) : baseWindow
  const filtered = messages.filter(
    (message) =>
      message.role !== 'tool' &&
      !isHumanCollaboratorComment(message) &&
      !isRetiredExternalChannelInboundMessage(message)
  )
  // Spike 6 (docs/ensemble-posture-fanout-preamble-design.md) — "since your
  // last turn" widening. A fixed window (12 messages by default) means a
  // writer late in a large round can lose everything since its previous turn
  // — including its OWN prior contribution. When the caller identifies the
  // participant being prompted, widen the window (never shrink it) so it
  // reaches back to that participant's most recent assistant turn plus one
  // message of lead-in. The char budget below stays the hard cap: the
  // newest-first fill still drops the oldest lines when the widened window
  // exceeds it, so provider/context budgets (incl. Ollama's model-aware
  // budget) are never blown.
  let deltaStart = -1
  if (sinceParticipantId) {
    for (let i = filtered.length - 1; i >= 0; i--) {
      const message = filtered[i]
      if (
        message.role === 'assistant' &&
        message.metadata?.ensembleParticipantId === sinceParticipantId
      ) {
        windowSize = Math.max(windowSize, filtered.length - i + 1)
        deltaStart = i + 1
        break
      }
    }
  }
  // Spike 5 — delta-only mode (slim resumed turns): the seat's own session
  // already holds everything up to and including its previous turn, so only
  // messages strictly AFTER that turn are new to it. Falls back to the
  // normal (widened) window when the seat has no prior turn on record.
  const relevant =
    options?.deltaOnly && deltaStart >= 0
      ? filtered.slice(deltaStart)
      : filtered.slice(-windowSize)
  // Fill from the MOST RECENT message backward so the budget keeps recent
  // context and truncation drops the OLDEST, not the newest. Output stays
  // chronological (unshift). For a non-truncated window this is identical to the
  // previous forward fill.
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (let i = relevant.length - 1; i >= 0; i--) {
    const message = relevant[i]
    const tag = messageTag(message, participantTokens, modelLabels)
    // M6 (1.0.7) — thinking-ephemerality. Strip any inlined reasoning chain
    // from a message authored by an ephemeral-reasoning provider before it
    // enters FUTURE-round context, keyed on the message's own authoring
    // provider (Codex reasoning is durable and retained). Today this is a
    // no-op — `.content` carries no reasoning fences — but it pins the
    // invariant so a future provider adapter that starts inlining a thinking
    // block can't silently leak it into the panel's shared transcript.
    const authoringProvider = message.metadata?.ensembleProvider as ProviderId | undefined
    const ephemeral = stripReasoningChains(message.content, authoringProvider)
    const text = sanitizeText(ephemeral).slice(0, MAX_MESSAGE_CHARS)
    // 1.0.4-AR7 — surface a compact tool-trace summary on every
    // message that has one, prepended to the content so downstream
    // participants can see at a glance what tools were used to
    // produce the response. Pure prose messages (no tools) skip
    // the line so the transcript stays lean.
    const trace = formatToolTraceSummary(message.toolActivities)
    const fileDigest = formatFileChangeDigest(message.toolActivities)
    const traceLines = [trace, fileDigest].filter(Boolean).join('\n')
    const body = traceLines ? `${traceLines}\n${text}` : text
    const line = `[${tag}]\n${body}`
    if (used + line.length > maxChars && lines.length > 0) {
      truncated = true
      break
    }
    used += line.length
    lines.unshift(line)
  }
  if (truncated) {
    lines.unshift('[Transcript truncated to fit Ensemble V1 context budget.]')
  }
  return lines.join('\n\n')
}

function messageTag(
  message: ChatMessage,
  participantTokens?: Map<string, string>,
  modelLabels?: Map<string, string>
): string {
  if (message.role === 'user') return 'User'
  if (message.role === 'assistant') {
    const provider = message.metadata?.ensembleProvider as ProviderId | undefined
    const role =
      typeof message.metadata?.ensembleRole === 'string' ? message.metadata.ensembleRole : ''
    if (provider) {
      // 1.0.7 — append the rename-stable participant handle (`#p3`)
      // when this message carries an `ensembleParticipantId` that maps
      // to a CURRENT roster seat. Messages from a participant since
      // removed from the roster (or older messages predating the id
      // stamp) carry no token and fall back to the bare provider/role
      // form. See `buildParticipantTokenMap` for why the token is
      // resolver-safe.
      const participantId =
        typeof message.metadata?.ensembleParticipantId === 'string'
          ? message.metadata.ensembleParticipantId
          : ''
      const token = participantId ? participantTokens?.get(participantId) : undefined
      const tokenSuffix = token ? ` #${token}` : ''
      // Same-provider duplicate on the CURRENT roster → include the model
      // label so transcript tags model the addressing form we want agents
      // to use (`@<model>` resolves; the bare provider tag is ambiguous).
      // Agents mimic what they read far more reliably than what a rule
      // tells them — make the unambiguous identity the visible one.
      const modelLabel = participantId ? modelLabels?.get(participantId) : undefined
      const modelSuffix = modelLabel ? ` (${modelLabel})` : ''
      return `${providerLabel(provider)}${role ? ` / ${role}` : ''}${modelSuffix}${tokenSuffix}`
    }
    return 'Assistant'
  }
  if (message.role === 'error') return 'Error'
  return 'System'
}

/**
 * 1.0.4 — `Round subject:` stanza injected just below `Round policy:`
 * in the participant system prompt. Gives every participant a
 * grounded deictic antecedent for "this app / this repo / this
 * project" — without it, Claude (and likely other models with
 * heavy TaskWraith tool-schema context loaded) tend to resolve "this"
 * to the surrounding harness rather than the user's actual
 * workspace.
 *
 * The line takes one of three shapes:
 *
 *   - Workspace bound (the common case):
 *       `Round subject: <basename> (<path>)`
 *
 *   - No workspace bound (system / global chat):
 *       `Round subject: No workspace bound — ask the user to name
 *       the project before assuming.`
 *
 *   - Per-chat scope override (sub-thread inheriting a workspace
 *     but emitting `scope: 'global'`): still emits the bound form
 *     so the agent has the directory context.
 *
 * Origin: Claude/Explorer's introspective feedback after picking up
 * TaskWraith-meta context instead of the bound workspace in an
 * ensemble round. The user asked Claude for prompting-surface
 * suggestions and got back a four-point list — this implements its
 * top "highest ROI" recommendation. Round subject as a single
 * anchor line every participant reads identically.
 */
/**
 * 1.0.4-AR8 — meta-round suspension for non-workspace cases.
 *
 * `formatWorkspaceStanza` now returns `null` when there is no
 * workspace bound AND the round isn't self-reflective. The
 * `Round subject:` stanza is meta-round overhead that only earns
 * its keep when there's a project to anchor deictic references to;
 * in a genuine global / conversational chat ("what's the best
 * way to do X") it just injects noise + a "ask the user which
 * project they mean" rule that contradicts the conversational
 * intent.
 *
 * Caller logic: when this returns null, skip both the stanza
 * itself AND the dependent deictic rule. Self-reflective mode
 * is unaffected (always emits an TaskWraith-harness stanza), and
 * any workspace-bound case is unaffected.
 */
function formatWorkspaceStanza(chat: ChatRecord, selfReflective = false): string | null {
  if (selfReflective) {
    // 1.0.4-AF — self-reflective round. The panel is explicitly
    // discussing TaskWraith itself, so the workspace stanza calls that
    // out. The bound workspace (if any) is still mentioned for
    // context — agents may still cite paths from it — but the topic
    // anchor flips from "the user's project" to "the TaskWraith harness
    // / this ensemble surface".
    const path = (chat.workspacePath || '').trim()
    if (!path) {
      return 'Round subject: TaskWraith harness (self-reflective mode — `/discuss`). The panel is discussing TaskWraith itself. No external workspace is bound.'
    }
    const basename = path.replace(/\/+$/, '').split('/').pop() || path
    const home = process.env.HOME || ''
    const displayPath = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
    return `Round subject: TaskWraith harness (self-reflective mode — \`/discuss\`). The panel is discussing TaskWraith itself. Bound workspace (incidental context): ${basename} (${displayPath}).`
  }
  const path = (chat.workspacePath || '').trim()
  if (!path) {
    // 1.0.4-AR8 — suspended. No workspace + non-self-reflective =
    // conversational global chat, no project deictic anchor to
    // enforce. Caller skips the stanza and the dependent rule.
    return null
  }
  // Last path segment is the project name. `path.split('/').pop()`
  // would break on trailing slashes; use the regex form so a path
  // like `/Users/x/Documents/another-project/` still yields
  // `another-project`.
  const basename = path.replace(/\/+$/, '').split('/').pop() || path
  // Replace user home with `~` for compactness — doesn't reveal
  // the actual username in the prompt and matches the way the chat
  // sidebar displays workspace paths.
  const home = process.env.HOME || ''
  const displayPath = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  return `Round subject: ${basename} (${displayPath})`
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider] || provider
}

/**
 * 1.0.4 same-provider disambiguation note injected just below the
 * participant roster.
 *
 * Real-world repro: an ensemble with "Codex / Brodex" and
 * "Codex / Chodex #2" both present. Kimi writes `@codex / Brodex —
 * you had the best view…` because that's the natural way to address
 * a Codex peer. The orchestrator's resolver picks ONE of the two
 * deterministically (ensemble order), but the model didn't know
 * that — it thought `@codex` was unambiguous. The user can't see
 * the routing choice until the wrong participant speaks.
 *
 * The fix: tell the dispatched agent up-front that same-provider
 * peers exist, list them, and suggest the explicit forms the
 * resolver supports (`@<role>` or `@<short-model>`). This shifts
 * the disambiguation burden from the user-facing transcript
 * (where the orchestrator can only emit a warning after the fact)
 * to the agent's prompt context (where the agent can pick the
 * explicit form on the first try).
 *
 * Returns `''` when no provider has 2+ enabled participants — the
 * single-provider-per-role ensembles (the 1.0.3 common case) see
 * no extra prompt overhead.
 */
/**
 * 1.0.7 — per-participant model labels for same-provider-duplicate panels.
 *
 * Keyed on participant id, populated ONLY for participants whose provider
 * fields 2+ roster seats (the case where `Provider / Role` stops being a
 * distinguishing identity). Threaded into the self-label, roster lines, and
 * transcript tags so the model name — the unambiguous @-addressing form —
 * is the identity agents actually SEE, instead of an abstract rule. Built
 * from the FULL roster (like `buildParticipantTokenMap`) so a message from
 * a since-disabled participant still resolves its label. Uses the same
 * `shortModelLabel` form as the disambiguation note + composer chips, so
 * every surface suggests an identical, resolver-valid spelling. Empty for
 * single-provider-per-seat panels — those prompts stay byte-identical.
 */
export function buildDupProviderModelLabels(
  participants: readonly EnsembleParticipant[] | undefined
): Map<string, string> {
  const map = new Map<string, string>()
  if (!participants || participants.length === 0) return map
  const byProvider = new Map<ProviderId, EnsembleParticipant[]>()
  for (const participant of participants) {
    const group = byProvider.get(participant.provider)
    if (group) group.push(participant)
    else byProvider.set(participant.provider, [participant])
  }
  for (const [provider, group] of byProvider) {
    if (group.length < 2) continue
    for (const participant of group) {
      const label = shortModelLabel(provider, participant.model)
      if (label) map.set(participant.id, label)
    }
  }
  return map
}

/**
 * 1.0.7 — remote-transcript speaker labeler (iOS parity).
 *
 * Returns the SAME identity form the desktop tagged transcript shows, minus
 * the #pN routing handle: `Provider / Role (Model)`, with the model label
 * included only on same-provider-duplicate panels (via
 * `buildDupProviderModelLabels`). The bridge passes this to
 * `projectRemoteThread` for ensemble chats so a phone renders panel
 * messages with the exact participant identity the desktop shows —
 * undefined for user/system rows and for solo (non-ensemble) authors.
 */
export function ensembleSpeakerForMessage(
  participants: readonly EnsembleParticipant[] | undefined
): (message: ChatMessage) => string | undefined {
  const modelLabels = buildDupProviderModelLabels(participants)
  return (message) => {
    if (message.role !== 'assistant') return undefined
    const provider = message.metadata?.ensembleProvider as ProviderId | undefined
    if (!provider) return undefined
    const role =
      typeof message.metadata?.ensembleRole === 'string' ? message.metadata.ensembleRole : ''
    const participantId =
      typeof message.metadata?.ensembleParticipantId === 'string'
        ? message.metadata.ensembleParticipantId
        : ''
    const modelLabel = participantId ? modelLabels.get(participantId) : undefined
    return `${providerLabel(provider)}${role ? ` / ${role}` : ''}${modelLabel ? ` (${modelLabel})` : ''}`
  }
}

export function formatSameProviderDisambiguationNote(participants: EnsembleParticipant[]): string {
  const groups = new Map<ProviderId, EnsembleParticipant[]>()
  for (const p of participants) {
    const existing = groups.get(p.provider)
    if (existing) existing.push(p)
    else groups.set(p.provider, [p])
  }
  const dupGroups: { provider: ProviderId; participants: EnsembleParticipant[] }[] = []
  for (const [provider, list] of groups.entries()) {
    if (list.length >= 2) dupGroups.push({ provider, participants: list })
  }
  if (dupGroups.length === 0) return ''

  const lines: string[] = [
    'Note: this ensemble contains multiple participants from the same provider:'
  ]
  for (const { provider, participants: group } of dupGroups) {
    for (const p of group) {
      const role = (p.role || 'Participant').trim()
      const model = shortModelLabel(provider, p.model)
      const suffix = model ? ` (model: ${model})` : ''
      lines.push(`- ${providerLabel(provider)} / ${role}${suffix}`)
    }
  }
  // Build the suggestion line from the first duplicated group. Two
  // worked examples — role-name and model-id — match the alias forms
  // the resolver actually supports (see `EnsembleMentionAlias.ts`'s
  // `getParticipantAliases` for the canonical list).
  const first = dupGroups[0]
  const sample = first.participants[0]
  const sampleRole = (sample.role || '').trim()
  const sampleModel = shortModelLabel(first.provider, sample.model)
  const roleHint = sampleRole ? `\`@${sampleRole}\`` : ''
  const modelHint = sampleModel ? `\`@${sampleModel}\`` : ''
  const hints = [roleHint, modelHint].filter(Boolean).join(' or ')
  const providerName = first.provider
  lines.push('')
  lines.push(
    hints
      ? `When addressing a specific participant, use their role name or model identifier (e.g. ${hints}). Plain \`@${providerName}\` resolves to a single participant but the choice is non-deterministic across same-provider peers.`
      : `When addressing a specific participant, use an explicit identifier. Plain \`@${providerName}\` resolves to a single participant but the choice is non-deterministic across same-provider peers.`
  )
  return lines.join('\n')
}

/**
 * Best-effort short model label for the same-provider disambiguation
 * note. Mirrors the renderer's `composerChipFormat.shortModelName`
 * shape so the suggested explicit identifier matches what the user
 * sees in chip strips and per-message badges. Pure function with no
 * cross-process imports so the main side can call it freely.
 *
 *   - Codex (`gpt-5.5`, `gpt-5.4-mini`)       → `5.5`, `5.4 Mini`
 *   - Claude (`claude-opus-4-7-thinking`)     → `Opus 4.7`
 *   - Kimi (`kimi-k2.6`, `kimi-k2.6-thinking`) → `K2.6`
 *   - Gemini (`gemini-2.5-flash-lite`)        → `2.5 Flash Lite`
 *
 * Falls back to the raw model id when no per-provider pattern fits,
 * and to '' when the model is missing or the cli-default sentinel
 * (since "CLI Default" isn't a useful @-mention target).
 */
function shortModelLabel(provider: ProviderId, model: string | undefined): string {
  if (!model || model === 'cli-default') return ''
  const id = model.toLowerCase()
  if (provider === 'codex') {
    const match = id.match(/^gpt-([\d.]+)(.*)$/)
    if (match) {
      const version = match[1]
      const suffix = match[2]
        .replace(/^-/, '')
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
      return suffix ? `${version} ${suffix}` : version
    }
  }
  if (provider === 'claude') {
    // Optional minor version + `$|-` lookahead: claude-fable-5 → Fable 5,
    // claude-fable-5-1m → Fable 5 (the -1m marker is not a minor version).
    const match = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?=$|-)/)
    if (match) {
      const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
      return match[3] ? `${family} ${match[2]}.${match[3]}` : `${family} ${match[2]}`
    }
  }
  if (provider === 'kimi') {
    const match = id.match(/^kimi-(k[\d.]+)/)
    if (match) return match[1].toUpperCase()
  }
  if (provider === 'gemini') {
    const match = id.match(/^gemini-(.+)$/)
    if (match) {
      return match[1]
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
    }
  }
  return model
}

function sanitizeText(value: unknown): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

/**
 * 1.0.4-AR13 — round-mode instruction builder.
 *
 * Returns an array of zero or more rule lines describing the
 * current round's structure for the calling participant. The
 * caller spreads the return into the larger rules array so the
 * default (`'roundtable'`) and unknown modes contribute
 * nothing and the prompt stays lean.
 *
 * Exported so the prompt-builder unit tests can pin the lines
 * each mode produces in isolation.
 */
export function formatRoundModeInstructions(
  config: EnsembleConfig,
  currentParticipantId: string
): string[] {
  const mode = config.roundMode || 'roundtable'
  if (mode === 'roundtable' || mode === 'targeted') {
    // `roundtable` is the implicit default — no extra rule.
    // `targeted` is enforced at the orchestrator level (only
    // the named participant gets dispatched), so a
    // participant-side rule would just be noise.
    return []
  }
  if (mode === 'chair-summary') {
    const isSynthesizer = config.synthesizerParticipantId === currentParticipantId
    if (isSynthesizer) {
      return [
        '',
        '- Round mode: CHAIR-SUMMARY. You speak last as the chair. Wait until every other participant has spoken; then recap their conclusions, surface disagreements, and propose the consensus path. Do NOT introduce new tool calls of your own beyond what is needed to reconcile the prior turns.'
      ]
    }
    return [
      '',
      '- Round mode: CHAIR-SUMMARY. Another participant (the designated chair / synthesizer) will speak last and recap. Wrap your turn cleanly so the chair has a coherent block to summarise — close with a one-line takeaway rather than an open question.'
    ]
  }
  if (mode === 'rebuttal') {
    return [
      '',
      "- Round mode: REBUTTAL. Respond to the IMMEDIATELY-PRIOR participant's contribution rather than re-answering the user's original prompt from scratch. Surface what you agree with, what you'd correct, and what's missing. The user's prompt is the topic; the prior turn is the artifact you're critiquing."
    ]
  }
  return []
}
