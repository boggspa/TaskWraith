import { normalizeEnsembleAuthority } from './ensembleAuthority'

/**
 * Provider-neutral Ensemble address tokens that target roster groups instead
 * of one participant. These are presentation and routing identities, not
 * provider aliases: a seat named "All" must not be allowed to steal `@All`,
 * and `@BG` always means every enabled background-stage seat.
 */
export type EnsembleGroupMentionId =
  | 'all'
  | 'captains'
  | 'management'
  | 'scouts'
  | 'workers'
  | 'reviewers'
  | 'backgrounds'

export type EnsembleGroupMentionStageRole = 'scout' | 'worker' | 'reviewer' | 'background'
export type EnsembleGroupMentionAuthorityGroup = 'captains' | 'management'

export interface EnsembleGroupMentionParticipant {
  id: string
  enabled?: boolean
  order?: number
  stageRole?: string
}

export interface EnsembleGroupMentionAuthority {
  bossmanParticipantId?: unknown
  captainParticipantIds?: unknown
  secondInCommandParticipantId?: unknown
}

export interface EnsembleGroupMentionDefinition {
  id: EnsembleGroupMentionId
  /** Canonical visible/insertion form, including the leading `@`. */
  token: string
  /** Lowercase bare alias consumed by the mention parser. */
  alias: string
  /** Short provider-neutral explanation used by picker and accessibility UI. */
  description: string
  /** Stage selector; absent for @All and configured-authority groups. */
  stageRole?: EnsembleGroupMentionStageRole
  /** Configured authority membership; display-role text never grants it. */
  authorityGroup?: EnsembleGroupMentionAuthorityGroup
}

export const ENSEMBLE_GROUP_MENTIONS: readonly EnsembleGroupMentionDefinition[] = [
  {
    id: 'all',
    token: '@All',
    alias: 'all',
    description: 'All enabled participants'
  },
  {
    id: 'captains',
    token: '@Captains',
    alias: 'captains',
    description: 'All enabled Captains',
    authorityGroup: 'captains'
  },
  {
    id: 'management',
    token: '@Management',
    alias: 'management',
    description: 'Enabled Boss and Captains',
    authorityGroup: 'management'
  },
  {
    id: 'scouts',
    token: '@Scouts',
    alias: 'scouts',
    description: 'All enabled Scout-stage participants',
    stageRole: 'scout'
  },
  {
    id: 'workers',
    token: '@Workers',
    alias: 'workers',
    description: 'All enabled Worker-stage participants',
    stageRole: 'worker'
  },
  {
    id: 'reviewers',
    token: '@Reviewers',
    alias: 'reviewers',
    description: 'All enabled Reviewer-stage participants',
    stageRole: 'reviewer'
  },
  {
    id: 'backgrounds',
    token: '@BG',
    alias: 'bg',
    description: 'All enabled background participants',
    stageRole: 'background'
  }
]

const GROUP_MENTION_BY_ALIAS = new Map(
  ENSEMBLE_GROUP_MENTIONS.map((definition) => [definition.alias, definition] as const)
)

/** Resolve only the seven deliberate public tokens; near-matches stay plain. */
export function resolveEnsembleGroupMentionToken(
  token: string
): EnsembleGroupMentionDefinition | null {
  const alias = token
    .trim()
    .replace(/^@+/, '')
    .replace(/[.,!?;:]+$/, '')
    .toLowerCase()
  return GROUP_MENTION_BY_ALIAS.get(alias) || null
}

export function isEnsembleAuthorityGroupMention(group: EnsembleGroupMentionId): boolean {
  return Boolean(
    ENSEMBLE_GROUP_MENTIONS.find((definition) => definition.id === group)?.authorityGroup
  )
}

/**
 * Resolve one group against current roster membership. Authority groups use
 * configured/captured ids only: arbitrary participant role labels never grant
 * Boss or Captain membership, and `recoverBoss: false` prevents @Management
 * from silently inventing a fallback manager.
 */
export function resolveEnsembleGroupMentionParticipantIds(input: {
  group: EnsembleGroupMentionId
  participants: readonly EnsembleGroupMentionParticipant[]
  authority?: EnsembleGroupMentionAuthority
}): Set<string> {
  const definition = ENSEMBLE_GROUP_MENTIONS.find((candidate) => candidate.id === input.group)
  if (!definition) return new Set()
  const enabled = input.participants.filter((participant) => participant.enabled !== false)
  if (definition.id === 'all') return new Set(enabled.map((participant) => participant.id))
  if (definition.stageRole) {
    return new Set(
      enabled
        .filter((participant) => participant.stageRole === definition.stageRole)
        .map((participant) => participant.id)
    )
  }
  if (!definition.authorityGroup) return new Set()

  const authority = normalizeEnsembleAuthority({
    participants: input.participants,
    bossmanParticipantId: input.authority?.bossmanParticipantId,
    captainParticipantIds: input.authority?.captainParticipantIds,
    secondInCommandParticipantId: input.authority?.secondInCommandParticipantId,
    recoverBoss: false
  })
  const memberIds = new Set(authority.captainParticipantIds)
  if (definition.authorityGroup === 'management' && authority.bossmanParticipantId) {
    memberIds.add(authority.bossmanParticipantId)
  }
  return new Set(
    enabled
      .filter((participant) => memberIds.has(participant.id))
      .map((participant) => participant.id)
  )
}

export function ensembleGroupMentionMatchesStage(
  group: EnsembleGroupMentionId,
  stageRole: EnsembleGroupMentionStageRole | undefined
): boolean {
  const definition = ENSEMBLE_GROUP_MENTIONS.find((candidate) => candidate.id === group)
  if (!definition) return false
  return (
    definition.id === 'all' || Boolean(definition.stageRole && definition.stageRole === stageRole)
  )
}
