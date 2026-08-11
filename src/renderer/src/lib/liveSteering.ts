import type {
  LiveSteeringInjectionRequest,
  LiveSteeringInjectionResult
} from '../../../shared/liveSteering'
import { liveSteeringAttemptAccepted } from '../../../shared/liveSteering'

export type LiveSteeringRendererOutcome =
  | { kind: 'accepted'; result: LiveSteeringInjectionResult }
  | { kind: 'boundary'; result: LiveSteeringInjectionResult }
  | { kind: 'unavailable'; error?: unknown }

export interface LiveSteeringRendererApi {
  injectSteering?: (input: LiveSteeringInjectionRequest) => Promise<LiveSteeringInjectionResult>
}

/**
 * Narrow preload seam for a prepared solo-steer barrier. Missing preload
 * support and IPC failures are reported as unavailable so the caller can
 * release the same durable row to its established boundary queue.
 */
export async function attemptLiveSteering(
  api: LiveSteeringRendererApi,
  input: LiveSteeringInjectionRequest
): Promise<LiveSteeringRendererOutcome> {
  if (typeof api.injectSteering !== 'function') return { kind: 'unavailable' }
  try {
    const result = await api.injectSteering(input)
    return liveSteeringAttemptAccepted(result)
      ? { kind: 'accepted', result }
      : { kind: 'boundary', result }
  } catch (error) {
    return { kind: 'unavailable', error }
  }
}
