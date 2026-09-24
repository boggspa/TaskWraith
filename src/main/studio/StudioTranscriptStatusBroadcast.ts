import type { StudioTranscriptPublishOutcome } from './StudioTranscriptAdapter'
import {
  STUDIO_TRANSCRIPT_STATUS_CHANNEL,
  type StudioTranscriptStatus
} from '../../shared/studioTranscriptStatus'

export interface StudioTranscriptStatusWindow {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, status: StudioTranscriptStatus): void
  }
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

export function studioTranscriptPendingStatus(
  assetId: string,
  updatedAt = Date.now()
): StudioTranscriptStatus {
  return {
    schemaVersion: 1,
    assetId: bounded(assetId, 128),
    state: 'pending',
    code: null,
    message: 'Generating an on-device Studio transcript…',
    updatedAt
  }
}

export function studioTranscriptOutcomeStatus(
  assetId: string,
  outcome: StudioTranscriptPublishOutcome,
  updatedAt = Date.now()
): StudioTranscriptStatus {
  return outcome.ok
    ? {
        schemaVersion: 1,
        assetId: bounded(assetId, 128),
        state: 'available',
        code: null,
        message: 'Studio transcript ready (' + String(outcome.segmentCount) + ' segments).',
        updatedAt
      }
    : {
        schemaVersion: 1,
        assetId: bounded(assetId, 128),
        state: 'unavailable',
        code: bounded(outcome.code, 64),
        message: bounded(outcome.message || 'Studio transcript is unavailable.', 512),
        updatedAt
      }
}

export function broadcastStudioTranscriptStatus(
  windows: readonly StudioTranscriptStatusWindow[],
  status: StudioTranscriptStatus
): number {
  let sent = 0
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(STUDIO_TRANSCRIPT_STATUS_CHANNEL, status)
      sent += 1
    } catch {
      // A renderer may be destroyed between the checks and send. Status is
      // advisory UI; it must never change the already-successful media open.
    }
  }
  return sent
}

export class StudioTranscriptStatusCoordinator {
  private activeAssetId: string | null = null
  private activeOperationId: number | null = null

  constructor(private readonly getWindows: () => readonly StudioTranscriptStatusWindow[]) {}

  started(assetId: string, operationId: number, updatedAt = Date.now()): StudioTranscriptStatus {
    this.activeAssetId = assetId
    this.activeOperationId = operationId
    const status = studioTranscriptPendingStatus(assetId, updatedAt)
    broadcastStudioTranscriptStatus(this.getWindows(), status)
    return status
  }

  completed(
    assetId: string,
    operationId: number,
    outcome: StudioTranscriptPublishOutcome,
    updatedAt = Date.now()
  ): StudioTranscriptStatus | null {
    if (assetId !== this.activeAssetId || operationId !== this.activeOperationId) return null
    const status = studioTranscriptOutcomeStatus(assetId, outcome, updatedAt)
    broadcastStudioTranscriptStatus(this.getWindows(), status)
    return status
  }
}
