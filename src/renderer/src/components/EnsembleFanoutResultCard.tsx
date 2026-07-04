import type { ChatMessage, ChatRecord, ProviderId } from '../../../main/store/types'
import { shortModelName } from '../lib/composerChipFormat'
import { collectInlineImageRefIds } from '../lib/resolveMarkdownImageRef'
import { getProviderLabel } from '../lib/providerLabels'
import { LiveActivityViewport } from './LiveActivityViewport'
import { MarkdownMessage } from './MarkdownMessage'
import { ChatMessageMediaStrip, collectMessageMediaRefs, type ChatMediaRef } from './ChatMediaPanel'
import { ensembleFanoutLaneIntent } from './EnsembleFanoutResultCardModel'

interface EnsembleFanoutResultCardProps {
  message: ChatMessage
  chat?: ChatRecord
  workspacePath?: string
  streamRunId?: string
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
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
  const mediaRefs = collectMessageMediaRefs(message)
  const inlineImageIds = collectInlineImageRefIds(content, mediaRefs, workspacePath)
  const stripRefs = inlineImageIds.size
    ? mediaRefs.filter((ref) => !inlineImageIds.has(ref.id))
    : mediaRefs

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
          revision={`${message.id}:${content.length}:${mediaRefs.length}`}
          collapsedMaxHeight={240}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          label={`${role} fan-out result`}
          expandLabel="Expand result"
          collapseLabel="Collapse result"
          jumpLabel="Jump to latest result"
        >
          <div className="ensemble-fanout-result-body-inner">
            {content ? (
              <MarkdownMessage
                content={content}
                chat={chat}
                mediaRefs={mediaRefs}
                workspacePath={workspacePath}
                onPreviewImage={onPreviewImage}
                streamRunId={streamRunId}
              />
            ) : (
              <span className="ensemble-fanout-result-empty">No text output.</span>
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
