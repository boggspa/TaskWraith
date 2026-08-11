export type LiveSteeringDeliveryStatus =
  | 'injected'
  | 'interrupting'
  | 'boundary'
  | 'broker-pending'
  | 'failed'

export interface LiveSteeringInjectionRequest {
  chatId: string
  activeRunId: string
  queuedRunId: string
  ownerToken: string
}

export interface LiveSteeringInjectionResult {
  status: LiveSteeringDeliveryStatus
  strategy: string
  entryId: string
  reason?: string
}

export interface LiveSteeringCancelRequest {
  chatId: string
  runId: string
}

export interface LiveSteeringCancelResult {
  cancelled: boolean
  hadPending: boolean
}

export function liveSteeringAttemptAccepted(
  result: LiveSteeringInjectionResult | null | undefined
): boolean {
  return result?.status === 'injected' || result?.status === 'broker-pending'
}
