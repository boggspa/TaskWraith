import type { ChatMessage, ProviderId } from '../../../main/store/types'
import type { MouseEvent } from 'react'
import {
  formatProviderRunFailureTimestamp,
  type ProviderRunFailureLine
} from '../lib/providerRunFailureSnippet'
import { getProviderLabel } from '../lib/providerLabels'
import { MessageActionsChip } from './MessageActionsChip'

interface ProviderRunFailureCardProps {
  message: ChatMessage
  onCopy: (messageId: string, content: string) => void
  onAddToPrompt?: (messageId: string, content: string) => void
  onContextMenu?: (event: MouseEvent<HTMLDivElement>, copyText: string) => void
  copied?: boolean
}

export function ProviderRunFailureCard({
  message,
  onCopy,
  onAddToPrompt,
  onContextMenu,
  copied = false
}: ProviderRunFailureCardProps): React.JSX.Element | null {
  const metadata = message.metadata
  if (!metadata || metadata.kind !== 'providerRunFailure') return null

  const provider = (metadata.provider as ProviderId | undefined) || 'gemini'
  const exitCode = typeof metadata.exitCode === 'number' ? metadata.exitCode : null
  const headline =
    typeof metadata.headline === 'string' && metadata.headline.trim()
      ? metadata.headline
      : exitCode === 130
        ? `${getProviderLabel(provider)} cancelled`
        : `${getProviderLabel(provider)} failed`
  const failureAt =
    typeof metadata.failureAt === 'string' ? metadata.failureAt : message.timestamp || ''
  const lines: ProviderRunFailureLine[] = []
  if (Array.isArray(metadata.lines)) {
    for (const line of metadata.lines) {
      if (!line || typeof line !== 'object') continue
      const record = line as { text?: unknown; timestamp?: unknown }
      const text = typeof record.text === 'string' ? record.text.trim() : ''
      if (!text) continue
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined
      lines.push({ text, timestamp })
    }
  }
  const hint = typeof metadata.hint === 'string' && metadata.hint.trim() ? metadata.hint : ''
  const copyText =
    typeof message.content === 'string' && message.content.trim()
      ? message.content
      : lines
          .map((line) =>
            line.timestamp
              ? `[${formatProviderRunFailureTimestamp(line.timestamp)}] ${line.text}`
              : line.text
          )
          .join('\n')

  return (
    <div
      className={`provider-run-failure-card provider-${provider}${exitCode === 130 ? ' is-cancelled' : ''}`}
      role="alert"
      aria-label={headline}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, copyText) : undefined}
    >
      <div className="provider-run-failure-card-header">
        <span className="provider-run-failure-card-kicker">stderr</span>
        <span className="provider-run-failure-card-title">{headline}</span>
        {failureAt && (
          <time className="provider-run-failure-card-time" dateTime={failureAt}>
            {formatProviderRunFailureTimestamp(failureAt)}
          </time>
        )}
      </div>
      <pre className="provider-run-failure-card-body">
        {lines.map((line, index) => (
          <div key={`${line.text}-${index}`} className="provider-run-failure-card-line">
            {line.timestamp && (
              <span className="provider-run-failure-card-line-time">
                {formatProviderRunFailureTimestamp(line.timestamp)}
              </span>
            )}
            <span className="provider-run-failure-card-line-text">{line.text}</span>
          </div>
        ))}
      </pre>
      {hint && <div className="provider-run-failure-card-hint">{hint}</div>}
      <MessageActionsChip
        onCopy={() => onCopy(message.id, copyText)}
        onAddToPrompt={
          onAddToPrompt && copyText.trim() ? () => onAddToPrompt(message.id, copyText) : undefined
        }
        label="provider failure"
        copied={copied}
      />
    </div>
  )
}
