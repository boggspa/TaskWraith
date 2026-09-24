import type { CSSProperties, ReactElement } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import type { WorkingIndicatorPresentation } from '../lib/workingIndicatorPresentation'
import type { WorkingIndicatorTokenTarget } from '../lib/workingIndicatorTelemetry'
import { MemoizedParticipantWorkingTelemetry } from './ParticipantWorkingTelemetry'

export function workingStatusLabel(presentation: WorkingIndicatorPresentation): string {
  if (presentation.statusLabel) return presentation.statusLabel
  const activity = presentation.activity === 'compacting' ? 'compacting context' : 'working'
  return presentation.roleLabel
    ? `${presentation.roleLabel} (${presentation.providerLabel || 'Agent'}) ${activity}`
    : `${presentation.providerLabel || 'Agent'} ${activity}`
}

export function workingIndicatorLabel(presentation: WorkingIndicatorPresentation): string {
  if (presentation.statusLabel) return presentation.statusLabel
  return presentation.activity === 'compacting' ? 'Compacting' : 'Working'
}

export function workingIndicatorKey(
  presentation: WorkingIndicatorPresentation,
  index: number
): string {
  return [
    presentation.participantId || '',
    presentation.runId || '',
    presentation.startedAt || '',
    presentation.providerClass || presentation.provider || 'agent',
    presentation.roleLabel || '',
    presentation.modelBadge || '',
    presentation.statusLabel || '',
    index
  ].join(':')
}

export function workingAccentStyle(
  presentation: WorkingIndicatorPresentation
): CSSProperties | undefined {
  const providerClass = (presentation.providerClass || presentation.provider || '').replace(
    /[^a-z0-9-]/gi,
    ''
  )
  if (!providerClass) return undefined
  return {
    '--message-working-accent': `var(--provider-${providerClass}-color, var(--accent))`
  } as CSSProperties
}

export function workingSeatNumber(
  chat: ChatRecord | null | undefined,
  participantId: string | null
): number | null {
  if (!participantId) return null
  const rosterSeats = chat?.ensemble?.participants || []
  const rosterIndex = rosterSeats.findIndex((seat) => seat.id === participantId)
  const roundSeats = chat?.ensemble?.activeRound?.participants || []
  const roundIndex = roundSeats.findIndex((seat) => seat.participantId === participantId)
  const rosterUsesLegacyZeroBasedOrder = rosterSeats.some((seat) => seat.order === 0)
  if (roundIndex >= 0) {
    if (rosterIndex >= 0 && rosterUsesLegacyZeroBasedOrder) return rosterIndex + 1
    const roundOrder = roundSeats[roundIndex]?.order
    if (typeof roundOrder === 'number' && roundOrder > 0) return roundOrder
  }
  if (rosterIndex >= 0) {
    const rosterOrder = rosterSeats[rosterIndex]?.order
    return typeof rosterOrder === 'number' && rosterOrder > 0 ? rosterOrder : rosterIndex + 1
  }
  return roundIndex >= 0 ? roundIndex + 1 : null
}

export function formatWorkingSeatLabel({
  seatNumber,
  roleLabel,
  providerLabel
}: {
  seatNumber: number | null
  roleLabel: string | null
  providerLabel: string
}): string {
  const role = roleLabel?.trim() || providerLabel.trim() || 'Agent'
  return seatNumber && seatNumber > 0 ? `#${seatNumber} ${role}` : role
}

export function WorkingIndicatorTelemetryReadout({
  presentation,
  tokenTarget,
  index
}: {
  presentation: WorkingIndicatorPresentation
  tokenTarget: WorkingIndicatorTokenTarget | undefined
  index: number
}): ReactElement | null {
  if (presentation.activity === 'transitioning') return null
  return (
    <MemoizedParticipantWorkingTelemetry
      runId={presentation.runId}
      startedAt={presentation.startedAt}
      provider={presentation.provider}
      tokenEpochKey={
        tokenTarget?.tokenEpochKey ||
        JSON.stringify([
          presentation.participantId || 'solo',
          presentation.provider || 'unknown-provider',
          presentation.modelId || 'unknown-model'
        ])
      }
      tokenEpochObservedAt={tokenTarget?.tokenEpochObservedAt ?? null}
      contextBaselineTokens={tokenTarget?.contextBaselineTokens ?? 0}
      contextBaselineAvailable={tokenTarget?.contextBaselineAvailable ?? false}
      contextState={tokenTarget?.contextState ?? 'unavailable'}
      fallbackTargetTokens={tokenTarget?.targetTokens ?? 0}
      estimatedCurrentTurnTokens={tokenTarget?.estimatedCurrentTurnTokens ?? 0}
      estimatedToolResultTokens={tokenTarget?.estimatedToolResultTokens ?? 0}
      key={
        presentation.runId ||
        presentation.startedAt ||
        presentation.participantId ||
        `working-${index}`
      }
    />
  )
}
