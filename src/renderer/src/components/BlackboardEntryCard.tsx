import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type {
  BlackboardEntry,
  ChatRecord,
  EnsembleParticipant,
  ProviderId
} from '../../../main/store/types'
import { providerDisplayName } from '../lib/AgentInvocationPresentation'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { BlackboardPollControls } from './BlackboardPollControls'
import { ProviderGlyph } from './icons/ProviderGlyph'
import { MarkdownMessage } from './MarkdownMessage'

/**
 * Unified Blackboard entry card — the ONE rendering of a blackboard entry,
 * shared by the right-dock Notes pane (PinnedMessagesPanel) and the composer
 * quick-glance popover (ComposerBlackboardButton). The surfaces keep their own
 * scroll containers, compose form, and trigger chrome; everything from the
 * category heading down (author chip, scope/time badges, key, body, seen-by
 * rail) renders through here so the two stay visually in lockstep.
 *
 * Author attribution resolves through the ensemble roster to a provider-hued
 * chip (role name + glyph + Bossman/Captain mark) instead of the raw
 * `ensemble-participant-N` id the surfaces used to print.
 */

export const BLACKBOARD_CATEGORY_ORDER: BlackboardEntry['category'][] = [
  'decision',
  'fact',
  'risk',
  'do-not-repeat',
  'note'
]

export const BLACKBOARD_CATEGORY_LABELS: Record<BlackboardEntry['category'], string> = {
  decision: 'Decisions',
  fact: 'Facts',
  risk: 'Risks',
  'do-not-repeat': 'Do not repeat',
  note: 'Notes'
}

export function sortBlackboardEntries(a: BlackboardEntry, b: BlackboardEntry): number {
  const categoryRank =
    BLACKBOARD_CATEGORY_ORDER.indexOf(a.category) - BLACKBOARD_CATEGORY_ORDER.indexOf(b.category)
  if (categoryRank !== 0) return categoryRank
  return (b.createdAt || '').localeCompare(a.createdAt || '')
}

export interface BlackboardGroup {
  category: BlackboardEntry['category']
  entries: BlackboardEntry[]
}

/** Category-grouped, canonically ordered view of a blackboard, with blank
 * key/value entries dropped. Shared by both surfaces. */
export function buildBlackboardGroups(entries: BlackboardEntry[]): BlackboardGroup[] {
  const visible = entries
    .filter((entry) => entry.key.trim() && entry.value.trim())
    .sort(sortBlackboardEntries)
  return BLACKBOARD_CATEGORY_ORDER.map((category) => ({
    category,
    entries: visible.filter((entry) => entry.category === category)
  })).filter((group) => group.entries.length > 0)
}

/**
 * Auto-minted fallback keys (`user-note-<stamp>` from the panel compose box,
 * `queued-note-<stamp>` from Steer → Add to Blackboard) exist only to satisfy
 * the (participantId, key, scope) upsert identity — they carry no meaning, so
 * the card suppresses them as titles. Agent-chosen slugs and the synthesizer's
 * `round-*` section keys still render.
 */
export function isGeneratedBlackboardKey(key: string): boolean {
  return /^(user-note|queued-note)-\d/.test(key.trim())
}

export function formatBlackboardTimestamp(createdAt: string | undefined): string {
  if (!createdAt) return ''
  const parsed = new Date(createdAt)
  if (Number.isNaN(parsed.getTime())) return ''
  try {
    return parsed.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function BossmanCrownIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M5.4 20h13.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CaptainHatIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M6.8 14.8 8 9.7c.3-1.1 1.2-1.8 2.3-1.8h3.4c1.1 0 2 .7 2.3 1.8l1.2 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M9.3 8c.7-1.2 1.6-1.9 2.7-1.9s2 .7 2.7 1.9M10.1 11.4h3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4 16.4c1.9 1.3 4.6 2 8 2s6.1-.7 8-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

export interface BlackboardAuthor {
  /** Human label: participant role, provider brand, "You", "Synthesizer", … */
  label: string
  /** CSS hue class fed into `var(--provider-<hue>-color)` for chip tinting. */
  hueClass: string
  /** Provider for the glyph — absent for user/system/unresolved authors. */
  provider?: ProviderId
  isUser: boolean
  isBossman: boolean
  isCaptain: boolean
}

/** Resolve a blackboard `participantId` to display attribution through the
 * chat's ensemble roster. Falls back to friendly labels ("Agent 2") for ids
 * whose roster record is gone rather than leaking raw participant ids. */
export function resolveBlackboardAuthor(
  chat: ChatRecord | null,
  participantId: string
): BlackboardAuthor {
  const ensemble = chat?.ensemble
  if (participantId === 'user') {
    return { label: 'You', hueClass: 'user', isUser: true, isBossman: false, isCaptain: false }
  }
  const participant: EnsembleParticipant | undefined = ensemble?.participants?.find(
    (candidate) => candidate.id === participantId
  )
  const isBossman = Boolean(participantId && participantId === ensemble?.bossmanParticipantId)
  const isCaptain =
    !isBossman && Boolean(participantId && participantId === ensemble?.secondInCommandParticipantId)
  if (participant) {
    const label =
      participant.role.trim() ||
      resolveProviderBrandLabel(participant.provider, participant.model) ||
      (participant.provider === 'ollama' ? 'Ollama' : providerDisplayName(participant.provider))
    return {
      label,
      hueClass: resolveProviderHueClass(participant.provider, participant.model) || 'ensemble',
      provider: participant.provider,
      isUser: false,
      isBossman,
      isCaptain
    }
  }
  if (participantId === 'synthesizer' || participantId === 'system') {
    return {
      label: participantId === 'synthesizer' ? 'Synthesizer' : 'System',
      hueClass: 'ensemble',
      isUser: false,
      isBossman: false,
      isCaptain: false
    }
  }
  const ordinal = participantId.match(/^ensemble-participant-(\d+)$/)
  return {
    label: ordinal ? `Agent ${ordinal[1]}` : participantId,
    hueClass: 'ensemble',
    isUser: false,
    isBossman,
    isCaptain
  }
}

export function BlackboardParticipantChip({
  chat,
  participantId,
  size,
  titleSuffix
}: {
  chat: ChatRecord | null
  participantId: string
  size: 'md' | 'sm'
  /** e.g. " has seen this entry" for seen-rail chips. */
  titleSuffix?: string
}): ReactElement {
  const author = resolveBlackboardAuthor(chat, participantId)
  const rawHint = author.label === participantId ? '' : ` (${participantId})`
  const title = `${author.label}${rawHint}${titleSuffix || ''}`
  return (
    <span
      className={`blackboard-chip size-${size} provider-${author.hueClass}${
        author.isUser ? ' is-user' : ''
      }`}
      style={
        {
          '--blackboard-chip-color': `var(--provider-${author.hueClass}-color, var(--accent))`
        } as CSSProperties
      }
      title={title}
      aria-label={title}
    >
      {author.provider ? (
        <ProviderGlyph provider={author.provider} className="blackboard-chip-glyph" />
      ) : (
        <span className="blackboard-chip-initial" aria-hidden>
          {author.label.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="blackboard-chip-label">{author.label}</span>
      {author.isBossman && (
        <span className="blackboard-chip-mark" aria-hidden>
          <BossmanCrownIcon />
        </span>
      )}
      {author.isCaptain && (
        <span className="blackboard-chip-mark" aria-hidden>
          <CaptainHatIcon />
        </span>
      )}
    </span>
  )
}

/** "Seen" rail — every non-author participant this entry has been surfaced
 * to. The author is seeded into `seenBy` at post time, so they are excluded
 * here; their attribution chip in the card header already covers them. */
export function BlackboardSeenByRail({
  chat,
  entry
}: {
  chat: ChatRecord | null
  entry: BlackboardEntry
}): ReactElement | null {
  const seers = (entry.seenBy || []).filter(
    (participantId) => participantId && participantId !== entry.participantId
  )
  if (seers.length === 0) return null
  return (
    <div className="blackboard-seen-rail" aria-label="Seen by">
      <span className="blackboard-seen-kicker" aria-hidden>
        Seen
      </span>
      {seers.slice(0, 12).map((participantId) => (
        <BlackboardParticipantChip
          key={participantId}
          chat={chat}
          participantId={participantId}
          size="sm"
          titleSuffix=" has seen this entry"
        />
      ))}
      {seers.length > 12 && <span className="blackboard-seen-more">+{seers.length - 12}</span>}
    </div>
  )
}

export interface BlackboardEntryCardProps {
  chat: ChatRecord | null
  entry: BlackboardEntry
  /** popover = composer quick glance, panel = right-dock Notes. */
  variant: 'panel' | 'popover'
  /** Surface-owned trailing header controls (e.g. the panel's delete button). */
  actions?: ReactNode
  showSeenBy?: boolean
}

export function BlackboardEntryCard({
  chat,
  entry,
  variant,
  actions,
  showSeenBy
}: BlackboardEntryCardProps): ReactElement {
  const timestamp = formatBlackboardTimestamp(entry.createdAt)
  const showKey = !isGeneratedBlackboardKey(entry.key)
  return (
    <article
      className={`blackboard-card blackboard-cat-${entry.category}`}
      role={variant === 'popover' ? 'listitem' : undefined}
    >
      <header className="blackboard-card-head">
        <BlackboardParticipantChip chat={chat} participantId={entry.participantId} size="md" />
        <div className="blackboard-card-head-meta">
          {timestamp && (
            <time className="blackboard-card-time" dateTime={entry.createdAt} title={entry.createdAt}>
              {timestamp}
            </time>
          )}
          <span className={`blackboard-card-scope scope-${entry.scope}`}>{entry.scope}</span>
          {actions}
        </div>
      </header>
      {showKey && (
        <h4 className="blackboard-card-key" title={entry.key}>
          {entry.key}
        </h4>
      )}
      <div className="blackboard-card-body">
        <MarkdownMessage content={entry.value} chat={chat || undefined} allowSafeHtml />
      </div>
      {entry.poll && (
        <BlackboardPollControls
          chat={chat}
          entry={entry}
          variant={variant}
          renderVoter={(voterId, choice) => (
            <BlackboardParticipantChip
              chat={chat}
              participantId={voterId}
              size="sm"
              titleSuffix={` voted ${choice}`}
            />
          )}
        />
      )}
      {showSeenBy && <BlackboardSeenByRail chat={chat} entry={entry} />}
    </article>
  )
}

export interface BlackboardGroupedListProps {
  chat: ChatRecord | null
  groups: BlackboardGroup[]
  variant: 'panel' | 'popover'
  renderEntryActions?: (entry: BlackboardEntry) => ReactNode
  showSeenBy?: boolean
}

export function BlackboardGroupedList({
  chat,
  groups,
  variant,
  renderEntryActions,
  showSeenBy
}: BlackboardGroupedListProps): ReactElement {
  return (
    <>
      {groups.map((group) => (
        <section
          key={group.category}
          className={`blackboard-group blackboard-cat-${group.category}`}
        >
          <div className="blackboard-group-label">
            <span className="blackboard-group-dot" aria-hidden />
            {BLACKBOARD_CATEGORY_LABELS[group.category]}
          </div>
          {group.entries.map((entry) => (
            <BlackboardEntryCard
              key={entry.id}
              chat={chat}
              entry={entry}
              variant={variant}
              actions={renderEntryActions?.(entry)}
              showSeenBy={showSeenBy}
            />
          ))}
        </section>
      ))}
    </>
  )
}
