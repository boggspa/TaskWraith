/**
 * Provider-neutral Ensemble address tokens that target roster groups instead
 * of one participant. These are presentation and routing identities, not
 * provider aliases: a seat named "All" must not be allowed to steal `@All`,
 * and `@BG` always means every enabled background-stage seat.
 */
export type EnsembleGroupMentionId = 'all' | 'scouts' | 'workers' | 'reviewers' | 'backgrounds'

export type EnsembleGroupMentionStageRole = 'scout' | 'worker' | 'reviewer' | 'background'

export interface EnsembleGroupMentionDefinition {
  id: EnsembleGroupMentionId
  /** Canonical visible/insertion form, including the leading `@`. */
  token: string
  /** Lowercase bare alias consumed by the mention parser. */
  alias: string
  /** Short provider-neutral explanation used by picker and accessibility UI. */
  description: string
  /** `undefined` means every enabled roster participant. */
  stageRole?: EnsembleGroupMentionStageRole
}

export const ENSEMBLE_GROUP_MENTIONS: readonly EnsembleGroupMentionDefinition[] = [
  {
    id: 'all',
    token: '@All',
    alias: 'all',
    description: 'All enabled participants'
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

/** Resolve only the five deliberate public tokens; near-matches stay plain. */
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

export function ensembleGroupMentionMatchesStage(
  group: EnsembleGroupMentionId,
  stageRole: EnsembleGroupMentionStageRole | undefined
): boolean {
  const definition = ENSEMBLE_GROUP_MENTIONS.find((candidate) => candidate.id === group)
  if (!definition) return false
  return definition.stageRole === undefined || definition.stageRole === stageRole
}
