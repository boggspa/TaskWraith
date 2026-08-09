import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import type {
  ChatMessage,
  ChatRecord,
  DiffFileSummary,
  ProviderId,
  ToolActivity
} from '../../../main/store/types'
import { shortModelName } from '../lib/composerChipFormat'
import { collectInlineImageRefIds } from '../lib/resolveMarkdownImageRef'
import { getProviderLabel } from '../lib/providerLabels'
import { providerAccentVar, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { ActivityStack, type ThinkingTraceActionsConfig } from './ActivityStack'
import { CollapsedActivityStackRow } from './CollapsedTranscriptRow'
import { LiveActivityViewport } from './LiveActivityViewport'
import { SeatStateChips, seatAccentVar } from './SeatChangeRow'
import { composedSeatRole, seatFromEnsembleMetadata } from '../lib/transcriptSeat'
import { ParticipantRoleIcon, participantRoleIconTitle } from './icons/ParticipantRoleIcon'
import { MarkdownMessage } from './MarkdownMessage'
import { ChatMessageMediaStrip, collectMessageMediaRefs, type ChatMediaRef } from './ChatMediaPanel'
import {
  ensembleFanoutLaneIntent,
  fanoutActivityPartExpansionId,
  shouldCollapseFanoutActivityPart,
  type EnsembleFanoutTranscriptPart,
  readEnsembleFanoutTranscriptParts
} from './EnsembleFanoutResultCardModel'

const COLLAPSED_FANOUT_PART_LIMIT = 24
// Collapsed height cap for the outer result body. Longer outputs scroll within
// this window (with an edge fade) until the card is expanded; shorter ones size
// to fit. 331 = the original 240 grown ~20% (→288) then a further ~15% so more
// of a long lane is visible at rest without dominating the transcript.
const COLLAPSED_FANOUT_RESULT_VIEWPORT_HEIGHT = 331
const COLLAPSED_FANOUT_TOOL_VIEWPORT_HEIGHT = 184
const COLLAPSED_FANOUT_MARKDOWN_LIMIT = 6_000
const COLLAPSED_FANOUT_PREVIEW_CHARS = 2_400

interface EnsembleFanoutResultCardProps {
  message: ChatMessage
  chat?: ChatRecord
  workspacePath?: string
  streamRunId?: string
  /**
   * This lane's seat is currently working. Drives the rim shimmer, which exists
   * so a straggler is findable at a glance when several lanes run at once.
   * Supplied by the caller from the working-indicator presentations so it turns
   * off at exactly the moment the seat's "working…" row does.
   */
  working?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  compactDensity?: boolean
  expandedActivityIds?: Set<string>
  onExpandedActivityIdsChange?: (next: Set<string>) => void
  onOpenFileChangeInWorkbench?: (summary: DiffFileSummary) => void
  thinkingTraceActions?: ThinkingTraceActionsConfig
  onPreviewImage: (ref: ChatMediaRef) => void
  onDetachToPane?: (ref: ChatMediaRef) => void
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function laneLabel(message: ChatMessage): string {
  const intent = ensembleFanoutLaneIntent(message)
  if (intent === 'write') return 'Writer fan-out'
  if (intent === 'read') return 'Reader fan-out'
  return 'Fan-out lane'
}

function fanoutRevisionToken(input: {
  messageId: string
  content: string
  mediaCount: number
  transcriptParts: readonly EnsembleFanoutTranscriptPart[]
  activities: readonly NonNullable<ChatMessage['toolActivities']>[number][]
}): string {
  let hash = 2166136261
  const add = (token: string): void => {
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
  }
  add(`${input.messageId}:${input.content.length}:${input.mediaCount}`)
  for (const part of input.transcriptParts) {
    if (part.kind === 'content') {
      add(`c:${part.id}:${part.content.length}`)
      continue
    }
    add(`t:${part.id}:${part.toolActivities.length}`)
    for (const activity of part.toolActivities) {
      add(
        `${activity.id}:${activity.status || ''}:${(activity.resultSummary || activity.outputPreview || '').length}`
      )
    }
  }
  for (const activity of input.activities) {
    add(
      `${activity.id}:${activity.status || ''}:${(activity.resultSummary || activity.outputPreview || '').length}`
    )
  }
  return `${input.transcriptParts.length}:${input.activities.length}:${(hash >>> 0).toString(36)}`
}

function FanoutContentPart({
  content,
  collapsed,
  chat,
  mediaRefs,
  workspacePath,
  onPreviewImage,
  streamRunId
}: {
  content: string
  collapsed: boolean
  chat?: ChatRecord
  mediaRefs: readonly ChatMediaRef[]
  workspacePath?: string
  onPreviewImage: (ref: ChatMediaRef) => void
  streamRunId?: string
}) {
  if (!collapsed || content.length <= COLLAPSED_FANOUT_MARKDOWN_LIMIT) {
    return (
      <MarkdownMessage
        content={content}
        chat={chat}
        mediaRefs={mediaRefs}
        workspacePath={workspacePath}
        onPreviewImage={onPreviewImage}
        streamRunId={streamRunId}
      />
    )
  }

  const preview =
    content.length > COLLAPSED_FANOUT_PREVIEW_CHARS
      ? `${content.slice(0, COLLAPSED_FANOUT_PREVIEW_CHARS).trimEnd()}\n...`
      : content
  return (
    <div className="ensemble-fanout-result-preview" aria-label="Collapsed fan-out result preview">
      <MarkdownMessage
        content={preview}
        chat={chat}
        mediaRefs={mediaRefs}
        workspacePath={workspacePath}
        onPreviewImage={onPreviewImage}
        streamRunId={streamRunId}
      />
      <div className="ensemble-fanout-result-preview-note">
        Full lane output is rendered when expanded.
      </div>
    </div>
  )
}

export function EnsembleFanoutResultCard({
  message,
  chat,
  workspacePath,
  streamRunId,
  working = false,
  expanded,
  onExpandedChange,
  compactDensity = false,
  expandedActivityIds,
  onExpandedActivityIdsChange,
  onOpenFileChangeInWorkbench,
  thinkingTraceActions,
  onPreviewImage,
  onDetachToPane
}: EnsembleFanoutResultCardProps) {
  const metadata = message.metadata || {}
  const provider = textValue(metadata.ensembleProvider) as ProviderId | undefined
  const providerLabel = provider ? getProviderLabel(provider) : 'Participant'
  const role = textValue(metadata.ensembleRole) || providerLabel
  const model = textValue(metadata.ensembleModel)
  // Each fan-out card wears the accent of the participant that produced it,
  // not the pane/host accent. `resolveProviderHueClass` maps (provider, model)
  // to a CSS hue class — the same helper the @-mention chips + above-row use —
  // so an Ollama-backed model spoofs its upstream brand (e.g. Qwen → Alibaba
  // purple) instead of generic Ollama green. The card's `--accent` is pinned
  // to that brand token here (falling back to the global accent when unknown);
  // the card CSS derives its border, glyph, gradient, and provider badge from
  // it, so the container is self-contained rather than inheriting whatever
  // provider the surrounding transcript happens to be tinted with.
  const hueClass = resolveProviderHueClass(provider, model) || 'unknown'
  const cardAccent = providerAccentVar(hueClass)
  const cardAccentStyle = cardAccent ? ({ '--accent': cardAccent } as CSSProperties) : undefined
  const modelBadge = provider && model ? shortModelName(provider, '', model) : model
  const laneId = textValue(metadata.ensembleLaneId)
  const chatId = textValue(chat?.appChatId)
  const canSkipLane = Boolean(working && chatId && laneId)
  const skipFanoutLane = (): void => {
    if (!chatId || !laneId) return
    void window.api.skipEnsembleFanoutLane(chatId, laneId)
  }
  const order = numberValue(metadata.ensembleOrder)
  // The lane's seat, decoded from the snapshot captured when the row was
  // written — so a lane read back later still shows what it actually ran as.
  //
  // This used to be gated on the snapshot EXISTING rather than on a seat
  // resolving, because the element resolved an absent preset to `'default'`
  // and would have claimed "Accept Edits" for a lane that may have run
  // read-only. But the snapshot only started being written when the lane card
  // was folded onto the seat element, so EVERY older row fell back to the
  // pills — measured on a real chat: 1734 of 1741 lane rows, across every
  // provider. The element now omits the permission chip when the tier is
  // unknown, so those rows can render the seat honestly: same provider, model,
  // role and #N the pills carried, minus a claim nobody can make.
  const seat = useMemo(() => seatFromEnsembleMetadata(metadata), [metadata])
  const seatRole = composedSeatRole(seat)
  const content = message.content || ''
  const transcriptParts = useMemo(() => readEnsembleFanoutTranscriptParts(message), [message])
  const activities = useMemo(() => message.toolActivities || [], [message.toolActivities])
  const mediaRefs = useMemo(() => collectMessageMediaRefs(message), [message])
  const inlineImageIds = useMemo(
    () => collectInlineImageRefIds(content, mediaRefs, workspacePath),
    [content, mediaRefs, workspacePath]
  )
  const stripRefs = useMemo(
    () =>
      inlineImageIds.size ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id)) : mediaRefs,
    [inlineImageIds, mediaRefs]
  )
  const revision = useMemo(
    () =>
      fanoutRevisionToken({
        messageId: message.id,
        content,
        mediaCount: mediaRefs.length,
        transcriptParts,
        activities
      }),
    [activities, content, mediaRefs.length, message.id, transcriptParts]
  )
  const hasTranscriptParts = transcriptParts.length > 0
  const hasDisplayableParts = hasTranscriptParts
    ? transcriptParts.some(
        (part) =>
          (part.kind === 'content' && part.content.trim()) ||
          (part.kind === 'tools' && part.toolActivities.length > 0)
      )
    : Boolean(content || activities.length > 0)
  const expandedResult = Boolean(expanded)
  const renderedTranscriptParts =
    hasTranscriptParts && !expandedResult && transcriptParts.length > COLLAPSED_FANOUT_PART_LIMIT
      ? transcriptParts.slice(-COLLAPSED_FANOUT_PART_LIMIT)
      : transcriptParts
  const hiddenTranscriptPartCount = transcriptParts.length - renderedTranscriptParts.length
  const toolViewportLabel = `${role} fan-out tool calls`
  const controlledToolViewportExpanded = onExpandedChange ? expandedResult : undefined
  const collapsedResult = !expandedResult
  const [localExpandedPartIds, setLocalExpandedPartIds] = useState<Set<string>>(() => new Set())
  const effectiveExpandedActivityIds = expandedActivityIds ?? localExpandedPartIds
  const latestDisplayablePartId = [...renderedTranscriptParts]
    .reverse()
    .find(
      (part) =>
        (part.kind === 'content' && part.content.trim()) ||
        (part.kind === 'tools' && part.toolActivities.length > 0)
    )?.id

  const setActivityPartExpanded = (partId: string, nextExpanded: boolean): void => {
    const expansionId = fanoutActivityPartExpansionId(partId)
    const next = new Set(effectiveExpandedActivityIds)
    if (nextExpanded) next.add(expansionId)
    else next.delete(expansionId)
    if (onExpandedActivityIdsChange) onExpandedActivityIdsChange(next)
    else setLocalExpandedPartIds(next)
  }

  const renderActivityPart = (
    partId: string,
    partActivities: ToolActivity[],
    isLatestPart: boolean
  ): ReactElement => {
    const activityStack = (
      <ActivityStack
        activities={partActivities}
        workspacePath={workspacePath}
        provider={provider}
        providerHueClass={hueClass}
        chatId={chat?.appChatId}
        runId={streamRunId || message.runId}
        chat={chat}
        compactDensity={compactDensity}
        liveActivityViewport
        liveActivityViewportClassName="ensemble-fanout-tools-viewport"
        liveActivityViewportCollapsedMaxHeight={COLLAPSED_FANOUT_TOOL_VIEWPORT_HEIGHT}
        liveActivityViewportLabel={toolViewportLabel}
        liveActivityViewportExpandLabel="Expand tool calls"
        liveActivityViewportCollapseLabel="Collapse tool calls"
        liveActivityViewportJumpLabel="Jump to latest tool call"
        liveActivityViewportExpanded={controlledToolViewportExpanded}
        onLiveActivityViewportExpandedChange={onExpandedChange}
        expandedActivityIds={expandedActivityIds}
        onExpandedActivityIdsChange={onExpandedActivityIdsChange}
        onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
        thinkingTraceActions={thinkingTraceActions}
      />
    )
    if (
      !shouldCollapseFanoutActivityPart({
        activities: partActivities,
        isLatestPart,
        laneWorking: working
      })
    ) {
      return activityStack
    }
    const expansionId = fanoutActivityPartExpansionId(partId)
    return (
      <CollapsedActivityStackRow
        header={null}
        activities={partActivities}
        providerHueClass={hueClass}
        expanded={effectiveExpandedActivityIds.has(expansionId)}
        onToggle={(nextExpanded) => setActivityPartExpanded(partId, nextExpanded)}
      >
        {activityStack}
      </CollapsedActivityStackRow>
    )
  }

  return (
    <article
      className={`ensemble-fanout-result-card provider-${hueClass}${working ? ' is-working' : ''}`}
      style={cardAccentStyle}
      data-lane-working={working ? 'true' : undefined}
    >
      {working && (
        <span className="ensemble-fanout-result-rim" aria-hidden="true">
          <span className="ensemble-fanout-result-rim-sweep" />
        </span>
      )}
      <header className="ensemble-fanout-result-header">
        <div className="ensemble-fanout-result-heading">
          <span aria-hidden="true" className="ensemble-fanout-result-glyph">
            ↠
          </span>
          <span className="ensemble-fanout-result-label">{laneLabel(message)}</span>
          {seat ? (
            <>
              {/* Role first, as on the peer-message card: a reader scanning a
                  column of lanes wants WHO before what they were running.
                  `#N` is kept here and dropped there — this lane sits in the
                  reader's own roster, so its seat number names something they
                  can actually see. */}
              {seatRole && (
                <strong
                  className="ensemble-fanout-result-title ensemble-fanout-result-seat-role"
                  style={{ color: seatAccentVar(seat) }}
                  title={
                    [participantRoleIconTitle(seat.authority, seat.stageRole), seatRole]
                      .filter(Boolean)
                      .join(' · ') || undefined
                  }
                >
                  <ParticipantRoleIcon
                    authority={seat.authority}
                    stageRole={seat.stageRole}
                    className="seat-role-icon"
                  />
                  {seatRole}
                </strong>
              )}
              <SeatStateChips seat={seat} className="ensemble-fanout-result-seat" />
            </>
          ) : (
            <>
              {/* Rows written before the seat snapshot existed keep the original
                  pills — a lane with no resolvable model must not render an
                  identity-shaped strip that says nothing. */}
              <span
                className={`segmented-control-action segmented-control-action--compact segmented-control-action--primary ensemble-fanout-result-provider provider-${hueClass}`}
              >
                {providerLabel}
              </span>
              <strong className="segmented-control-action segmented-control-action--compact ensemble-fanout-result-title">
                {role}
              </strong>
              {modelBadge && (
                <span
                  className="segmented-control-action segmented-control-action--compact ensemble-fanout-result-model"
                  title={`Model: ${modelBadge}`}
                  aria-label={`Model ${modelBadge}`}
                >
                  {modelBadge}
                </span>
              )}
              {typeof order === 'number' && (
                <span
                  className="segmented-control-action segmented-control-action--compact ensemble-fanout-result-order"
                  title={`Participant order ${order}`}
                >
                  #{order}
                </span>
              )}
            </>
          )}
        </div>
      </header>
      <div className="ensemble-fanout-result-body">
        <LiveActivityViewport
          className="ensemble-fanout-result-viewport"
          revision={revision}
          collapsedMaxHeight={COLLAPSED_FANOUT_RESULT_VIEWPORT_HEIGHT}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          label={`${role} fan-out result`}
          expandLabel="Expand result"
          collapseLabel="Collapse result"
          jumpLabel="Jump to latest result"
          active={working}
          onSkip={canSkipLane ? skipFanoutLane : undefined}
          skipTitle="Stop this fan-out lane only. Remaining lanes and the round continue; Stop still cancels the whole round."
        >
          <div className="ensemble-fanout-result-body-inner">
            {hasTranscriptParts ? (
              <>
                {hiddenTranscriptPartCount > 0 && (
                  <div className="ensemble-fanout-result-truncated">
                    {hiddenTranscriptPartCount} earlier parts hidden while collapsed.
                  </div>
                )}
                {renderedTranscriptParts.map((part) =>
                  part.kind === 'content' && part.content.trim() ? (
                    <div key={part.id} className="ensemble-fanout-result-part">
                      <FanoutContentPart
                        content={part.content}
                        collapsed={collapsedResult}
                        chat={chat}
                        mediaRefs={mediaRefs}
                        workspacePath={workspacePath}
                        onPreviewImage={onPreviewImage}
                        streamRunId={streamRunId}
                      />
                    </div>
                  ) : part.kind === 'tools' && part.toolActivities.length > 0 ? (
                    <div
                      key={part.id}
                      className="ensemble-fanout-result-part ensemble-fanout-result-tools"
                    >
                      {renderActivityPart(
                        part.id,
                        part.toolActivities,
                        part.id === latestDisplayablePartId
                      )}
                    </div>
                  ) : null
                )}
                {!hasDisplayableParts && (
                  <span className="ensemble-fanout-result-empty">No text output.</span>
                )}
              </>
            ) : content ? (
              <div className="ensemble-fanout-result-part">
                <FanoutContentPart
                  content={content}
                  collapsed={collapsedResult}
                  chat={chat}
                  mediaRefs={mediaRefs}
                  workspacePath={workspacePath}
                  onPreviewImage={onPreviewImage}
                  streamRunId={streamRunId}
                />
              </div>
            ) : activities.length > 0 ? (
              <div className="ensemble-fanout-result-part ensemble-fanout-result-tools">
                {renderActivityPart(message.id, activities, true)}
              </div>
            ) : (
              !hasDisplayableParts && (
                <span className="ensemble-fanout-result-empty">No text output.</span>
              )
            )}
            {stripRefs.length > 0 && (
              <ChatMessageMediaStrip
                refs={stripRefs}
                workspacePath={workspacePath}
                onPreviewImage={onPreviewImage}
                onDetachToPane={onDetachToPane}
              />
            )}
          </div>
        </LiveActivityViewport>
      </div>
      {laneId && <span className="sr-only">Lane {laneId}</span>}
    </article>
  )
}
