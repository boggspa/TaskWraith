import type {
  ChatMessage,
  ChatRecord,
  DiffFileSummary,
  ProviderId
} from '../../../main/store/types'
import { shortModelName } from '../lib/composerChipFormat'
import { collectInlineImageRefIds } from '../lib/resolveMarkdownImageRef'
import { getProviderLabel } from '../lib/providerLabels'
import { ActivityStack } from './ActivityStack'
import { LiveActivityViewport } from './LiveActivityViewport'
import { MarkdownMessage } from './MarkdownMessage'
import { ChatMessageMediaStrip, collectMessageMediaRefs, type ChatMediaRef } from './ChatMediaPanel'
import {
  ensembleFanoutLaneIntent,
  readEnsembleFanoutTranscriptParts
} from './EnsembleFanoutResultCardModel'

interface EnsembleFanoutResultCardProps {
  message: ChatMessage
  chat?: ChatRecord
  workspacePath?: string
  streamRunId?: string
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  compactDensity?: boolean
  expandedActivityIds?: Set<string>
  onExpandedActivityIdsChange?: (next: Set<string>) => void
  onOpenFileChangeInWorkbench?: (summary: DiffFileSummary) => void
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

export function EnsembleFanoutResultCard({
  message,
  chat,
  workspacePath,
  streamRunId,
  expanded,
  onExpandedChange,
  compactDensity = false,
  expandedActivityIds,
  onExpandedActivityIdsChange,
  onOpenFileChangeInWorkbench,
  onPreviewImage,
  onDetachToPane
}: EnsembleFanoutResultCardProps) {
  const metadata = message.metadata || {}
  const provider = textValue(metadata.ensembleProvider) as ProviderId | undefined
  const providerLabel = provider ? getProviderLabel(provider) : 'Participant'
  const role = textValue(metadata.ensembleRole) || providerLabel
  const model = textValue(metadata.ensembleModel)
  const modelBadge = provider && model ? shortModelName(provider, '', model) : model
  const laneId = textValue(metadata.ensembleLaneId)
  const order = numberValue(metadata.ensembleOrder)
  const content = message.content || ''
  const transcriptParts = readEnsembleFanoutTranscriptParts(message)
  const activities = message.toolActivities || []
  const mediaRefs = collectMessageMediaRefs(message)
  const inlineImageIds = collectInlineImageRefIds(content, mediaRefs, workspacePath)
  const stripRefs = inlineImageIds.size
    ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id))
    : mediaRefs
  const revisionParts = transcriptParts
    .map((part) =>
      part.kind === 'content'
        ? `${part.id}:c:${part.content.length}`
        : `${part.id}:t:${part.toolActivities.length}:${part.toolActivities
            .map(
              (activity) =>
                `${activity.id}:${activity.status}:${(activity.resultSummary || activity.outputPreview || '').length}`
            )
            .join(',')}`
    )
    .join('|')
  const activityRevision = activities
    .map(
      (activity) =>
        `${activity.id}:${activity.status}:${(activity.resultSummary || activity.outputPreview || '').length}`
    )
    .join(',')
  const revision = `${message.id}:${content.length}:${mediaRefs.length}:${revisionParts}:${activityRevision}`
  const hasTranscriptParts = transcriptParts.length > 0
  const hasDisplayableParts = hasTranscriptParts
    ? transcriptParts.some(
        (part) =>
          (part.kind === 'content' && part.content.trim()) ||
          (part.kind === 'tools' && part.toolActivities.length > 0)
      )
    : Boolean(content || activities.length > 0)

  return (
    <article className={`ensemble-fanout-result-card provider-${provider || 'unknown'}`}>
      <header className="ensemble-fanout-result-header">
        <div className="ensemble-fanout-result-heading">
          <span aria-hidden="true" className="ensemble-fanout-result-glyph">
            ↠
          </span>
          <span className="ensemble-fanout-result-label">{laneLabel(message)}</span>
          <span className={`ensemble-fanout-result-provider provider-${provider || 'unknown'}`}>
            {providerLabel}
          </span>
          <strong className="ensemble-fanout-result-title">{role}</strong>
          {modelBadge && (
            <span
              className="ensemble-fanout-result-model"
              title={`Model: ${modelBadge}`}
              aria-label={`Model ${modelBadge}`}
            >
              {modelBadge}
            </span>
          )}
          {typeof order === 'number' && (
            <span className="ensemble-fanout-result-order" title={`Participant order ${order}`}>
              #{order}
            </span>
          )}
        </div>
      </header>
      <div className="ensemble-fanout-result-body">
        <LiveActivityViewport
          className="ensemble-fanout-result-viewport"
          revision={revision}
          collapsedMaxHeight={240}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          label={`${role} fan-out result`}
          expandLabel="Expand result"
          collapseLabel="Collapse result"
          jumpLabel="Jump to latest result"
        >
          <div className="ensemble-fanout-result-body-inner">
            {hasTranscriptParts ? (
              <>
                {transcriptParts.map((part) =>
                  part.kind === 'content' && part.content.trim() ? (
                    <div key={part.id} className="ensemble-fanout-result-part">
                      <MarkdownMessage
                        content={part.content}
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
                      <ActivityStack
                        activities={part.toolActivities}
                        workspacePath={workspacePath}
                        provider={provider}
                        chatId={chat?.appChatId}
                        runId={streamRunId || message.runId}
                        chat={chat}
                        compactDensity={compactDensity}
                        liveActivityViewport={false}
                        expandedActivityIds={expandedActivityIds}
                        onExpandedActivityIdsChange={onExpandedActivityIdsChange}
                        onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
                      />
                    </div>
                  ) : null
                )}
                {!hasDisplayableParts && (
                  <span className="ensemble-fanout-result-empty">No text output.</span>
                )}
              </>
            ) : content ? (
              <div className="ensemble-fanout-result-part">
                <MarkdownMessage
                  content={content}
                  chat={chat}
                  mediaRefs={mediaRefs}
                  workspacePath={workspacePath}
                  onPreviewImage={onPreviewImage}
                  streamRunId={streamRunId}
                />
              </div>
            ) : activities.length > 0 ? (
              <div className="ensemble-fanout-result-part ensemble-fanout-result-tools">
                <ActivityStack
                  activities={activities}
                  workspacePath={workspacePath}
                  provider={provider}
                  chatId={chat?.appChatId}
                  runId={streamRunId || message.runId}
                  chat={chat}
                  compactDensity={compactDensity}
                  liveActivityViewport={false}
                  expandedActivityIds={expandedActivityIds}
                  onExpandedActivityIdsChange={onExpandedActivityIdsChange}
                  onOpenFileChangeInWorkbench={onOpenFileChangeInWorkbench}
                />
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
