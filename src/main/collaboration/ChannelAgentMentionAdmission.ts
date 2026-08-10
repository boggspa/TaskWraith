import {
  CHANNEL_AGENT_REVIEW_ID,
  CHANNEL_AGENT_REVIEW_REQUIRED_CODE,
  channelAgentParticipationEnabled
} from '../../shared/collaboration/ChannelAgentReviewGate'
import type { ChannelMessage } from './ChannelMessageLog'
import type { AgentChannelMember, ChannelMember } from './ChannelStore'

const STRUCTURED_MENTION_RE = /<@([A-Za-z0-9][A-Za-z0-9._:-]{0,127})>/g
const PLAIN_MENTION_RE = new RegExp(
  String.raw`(^|[\s(\[{<>"'\x60!?,;:.])@([A-Za-z][A-Za-z0-9._#-]{0,32}(?:\s+[A-Za-z0-9#][A-Za-z0-9._#-]{0,32}){0,3})`,
  'g'
)
const TRAILING_PUNCTUATION_RE = /[!?;,.:]+$/

export interface ChannelAgentMentionTarget {
  readonly memberId: string
  readonly agentSeatId: string
  readonly keyGeneration: number
  readonly displayName: string
  readonly source: 'structured_member_id' | 'unique_alias'
}

export interface ChannelAgentMentionAmbiguity {
  readonly candidateMemberIds: readonly string[]
}

export interface ChannelAgentMentionResolution {
  readonly targets: readonly ChannelAgentMentionTarget[]
  readonly ambiguities: readonly ChannelAgentMentionAmbiguity[]
}

export type AcceptedChannelAgentMentionAdmission =
  | {
      readonly kind: 'ignored'
      readonly reason: 'not_human_text' | 'no_agent_mention'
      readonly ambiguities: readonly ChannelAgentMentionAmbiguity[]
    }
  | {
      readonly kind: 'rejected'
      readonly reason: 'author_not_active_human' | 'ambiguous_agent_mention'
      readonly ambiguities: readonly ChannelAgentMentionAmbiguity[]
    }
  | {
      readonly kind: 'review_required'
      readonly code: typeof CHANNEL_AGENT_REVIEW_REQUIRED_CODE
      readonly reviewId: typeof CHANNEL_AGENT_REVIEW_ID
      readonly targets: readonly ChannelAgentMentionTarget[]
      readonly ambiguities: readonly ChannelAgentMentionAmbiguity[]
    }
  | {
      readonly kind: 'admitted'
      readonly targets: readonly ChannelAgentMentionTarget[]
      readonly ambiguities: readonly ChannelAgentMentionAmbiguity[]
    }

interface StructuredRange {
  readonly start: number
  readonly end: number
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeAlias(value: string): string {
  return value.toLowerCase().trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

function activeAgentMembers(
  channelId: string,
  members: readonly ChannelMember[]
): AgentChannelMember[] {
  return members.filter(
    (member): member is AgentChannelMember =>
      member.channelId === channelId && member.kind === 'agent' && member.status === 'active'
  )
}

function activeChannelMembers(
  channelId: string,
  members: readonly ChannelMember[]
): ChannelMember[] {
  return members.filter((member) => member.channelId === channelId && member.status === 'active')
}

function target(
  member: AgentChannelMember,
  source: ChannelAgentMentionTarget['source']
): ChannelAgentMentionTarget {
  return {
    memberId: member.memberId,
    agentSeatId: member.agentSeatId,
    keyGeneration: member.keyGeneration,
    displayName: member.displayName,
    source
  }
}

function addTarget(
  targets: Map<string, ChannelAgentMentionTarget>,
  member: AgentChannelMember,
  source: ChannelAgentMentionTarget['source']
): void {
  const existing = targets.get(member.memberId)
  if (!existing || source === 'structured_member_id') {
    targets.set(member.memberId, target(member, source))
  }
}

function aliasMap(members: readonly ChannelMember[]): Map<string, ChannelMember[]> {
  const aliases = new Map<string, ChannelMember[]>()
  for (const member of members) {
    for (const raw of [member.displayName, member.memberId]) {
      const alias = normalizeAlias(raw)
      if (alias.length < 2) continue
      const candidates = aliases.get(alias) ?? []
      candidates.push(member)
      aliases.set(alias, candidates)
    }
  }
  return aliases
}

function structuredRangeContains(ranges: readonly StructuredRange[], index: number): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function plainMentionCandidates(
  phrase: string,
  aliases: ReadonlyMap<string, ChannelMember[]>
): ChannelMember[] | null {
  const words = phrase.split(/\s+/)
  for (let length = words.length; length >= 1; length -= 1) {
    const candidate = words.slice(0, length).join(' ').replace(TRAILING_PUNCTUATION_RE, '')
    const normalized = normalizeAlias(candidate)
    const matches = aliases.get(normalized)
    if (matches?.length) return matches
  }
  return null
}

/**
 * Resolve only active agent members from accepted Channel text. A structured
 * `<@member-id>` token is authoritative; a human-readable `@Display Name`
 * alias is accepted only when exactly one active Channel member owns it and
 * that member is an agent. Unknown human mentions and email addresses are
 * ignored rather than widened heuristically.
 */
export function resolveChannelAgentMentions(
  channelId: string,
  content: string,
  members: readonly ChannelMember[]
): ChannelAgentMentionResolution {
  const agents = activeAgentMembers(channelId, members)
  if (agents.length === 0 || typeof content !== 'string' || !content.includes('@')) {
    return { targets: [], ambiguities: [] }
  }

  const byMemberId = new Map(agents.map((agent) => [agent.memberId, agent] as const))
  const targets = new Map<string, ChannelAgentMentionTarget>()
  const structuredRanges: StructuredRange[] = []
  STRUCTURED_MENTION_RE.lastIndex = 0
  let structured: RegExpExecArray | null
  while ((structured = STRUCTURED_MENTION_RE.exec(content)) !== null) {
    structuredRanges.push({ start: structured.index, end: STRUCTURED_MENTION_RE.lastIndex })
    const agent = byMemberId.get(structured[1])
    if (agent) addTarget(targets, agent, 'structured_member_id')
  }

  const aliases = aliasMap(activeChannelMembers(channelId, members))
  const ambiguities = new Map<string, ChannelAgentMentionAmbiguity>()
  PLAIN_MENTION_RE.lastIndex = 0
  let plain: RegExpExecArray | null
  while ((plain = PLAIN_MENTION_RE.exec(content)) !== null) {
    const atIndex = plain.index + plain[1].length
    if (structuredRangeContains(structuredRanges, atIndex)) continue
    const candidates = plainMentionCandidates(plain[2], aliases)
    if (!candidates) continue
    const unique = [
      ...new Map(candidates.map((member) => [member.memberId, member])).values()
    ].sort((left, right) => compareText(left.memberId, right.memberId))
    if (unique.length !== 1) {
      const candidateMemberIds = unique.map((agent) => agent.memberId)
      ambiguities.set(candidateMemberIds.join('\u0000'), { candidateMemberIds })
      continue
    }
    if (unique[0].kind === 'agent') addTarget(targets, unique[0], 'unique_alias')
  }

  return {
    targets: [...targets.values()],
    ambiguities: [...ambiguities.values()]
  }
}

/**
 * Production admission boundary for a record that the append-only log has
 * already fsynced. Pre-review it can resolve/audit intent, but it cannot spend
 * a signed grant or reach a provider: the source-only gate stops here.
 */
export function admitAcceptedChannelAgentMentions(args: {
  record: ChannelMessage
  members: readonly ChannelMember[]
}): AcceptedChannelAgentMentionAdmission {
  if (args.record.kind !== 'human.text') {
    return { kind: 'ignored', reason: 'not_human_text', ambiguities: [] }
  }
  const author = args.members.find(
    (member) =>
      member.channelId === args.record.channelId && member.memberId === args.record.authorMemberId
  )
  if (!author || author.kind !== 'human' || author.status !== 'active') {
    return { kind: 'rejected', reason: 'author_not_active_human', ambiguities: [] }
  }
  const resolution = resolveChannelAgentMentions(
    args.record.channelId,
    args.record.content,
    args.members
  )
  if (resolution.targets.length === 0) {
    return resolution.ambiguities.length > 0
      ? {
          kind: 'rejected',
          reason: 'ambiguous_agent_mention',
          ambiguities: resolution.ambiguities
        }
      : { kind: 'ignored', reason: 'no_agent_mention', ambiguities: [] }
  }
  if (channelAgentParticipationEnabled()) {
    return {
      kind: 'admitted',
      targets: resolution.targets,
      ambiguities: resolution.ambiguities
    }
  }
  return {
    kind: 'review_required',
    code: CHANNEL_AGENT_REVIEW_REQUIRED_CODE,
    reviewId: CHANNEL_AGENT_REVIEW_ID,
    targets: resolution.targets,
    ambiguities: resolution.ambiguities
  }
}
