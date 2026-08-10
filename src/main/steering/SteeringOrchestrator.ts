/**
 * Unified mid-turn steering orchestration.
 *
 * Historically every provider except Pi had to wait for the next natural turn
 * boundary before a steering message reached the live model. This module is the
 * provider-agnostic router that decides, for a given running session, which
 * delivery strategy to attempt and then arms the right RunManager / transport
 * hook. Transport-specific implementations (ACP cancel+prompt, broker
 * injection, pi stdin frame) live in their provider modules; this file owns the
 * matrix and the fallback-to-boundary contract.
 */

import type { LiveSteerTransport, RunManager } from '../RunManager'
import type {
  MidRunSteeringAuthorKind,
  MidRunSteeringEntry,
  MidRunSteeringRegistry
} from '../run/MidRunSteering'
import {
  midTurnSteeringCapabilityForProvider,
  planMidTurnSteeringDelivery
} from '../run/MidRunSteering'
import { createBrokerSteerTransport } from './BrokerSteerTransport'
import type { ProviderId } from '../store/types'

export type SteeringDeliveryStatus =
  | 'injected'
  | 'interrupting'
  | 'boundary'
  | 'broker-pending'
  | 'failed'

export interface SteeringAttemptResult {
  status: SteeringDeliveryStatus
  strategy: string
  entryId: string
  reason?: string
}

export interface SteeringOrchestratorDeps {
  runManager: RunManager
  registry: MidRunSteeringRegistry
  /** Opt-in gate. Off means every provider falls back to boundary delivery. */
  midTurnSteeringEnabled: boolean
  /** Pi has its own env gate; keep it until the other strategies are proven. */
  piLiveSteerEnabled: boolean
}

export interface RouteSteerDeliveryInput {
  chatId: string
  runId: string
  entry: MidRunSteeringEntry
  /** Provider of the RUNNING session. */
  provider: ProviderId
  /** If true, the assistant is currently inside a tool call (for strategy C). */
  midTool?: boolean
}

/**
 * Decide how to deliver a steering message that has ALREADY been appended to
 * the transcript and registered in the MidRunSteeringRegistry. This function
 * is pure side-effectful only on RunManager / transport state owned by the
 * deps; it never touches the chat store.
 *
 * Returns:
 *   - `injected`: the transport confirmed it accepted the frame (pi only
 *     today). The registry entry should be marked delivered by the transport
 *     listener when it observes the provider's drain evidence.
 *   - `interrupting`: the orchestrator armed a safe interrupt and the provider
 *     will see the steering message after the current tool boundary.
 *   - `boundary`: the provider cannot accept mid-turn input; fall back to the
 *     existing append-now / deliver-at-boundary path.
 *   - `broker-pending`: broker-injection adapters are expected to pick up the
 *     flag set on the RunManager session (see `liveSteerTransport`).
 *   - `failed`: an unrecoverable internal error. The caller should still fall
 *     back to boundary delivery rather than drop the message.
 */
export function routeSteerDelivery(
  deps: SteeringOrchestratorDeps,
  input: RouteSteerDeliveryInput
): SteeringAttemptResult {
  const { runManager, piLiveSteerEnabled } = deps
  const { chatId, runId, entry, provider, midTool } = input

  const session = runManager.get(runId)
  if (!session || session.appChatId !== chatId) {
    return {
      status: 'boundary',
      strategy: 'boundary',
      entryId: entry.id,
      reason: 'No matching active session for this chat; falling back to boundary delivery.'
    }
  }

  const strategy = planMidTurnSteeringDelivery({
    enabled: deps.midTurnSteeringEnabled,
    provider,
    text: entry.text,
    authorKind: entry.authorKind as MidRunSteeringAuthorKind,
    hasLiveTransport: Boolean(session.liveSteerTransport),
    runSettled: !isActiveStatus(session.status)
  })

  switch (strategy.kind) {
    case 'pi-live-frame': {
      // Keep the existing proven pi gate until the unified feature flag is
      // exercised end-to-end. Pi still requires its own opt-in.
      if (!piLiveSteerEnabled) {
        return {
          status: 'boundary',
          strategy: 'pi-live-frame',
          entryId: entry.id,
          reason: 'Pi live steering is not enabled.'
        }
      }
      const transport = session.liveSteerTransport
      if (!transport) {
        return {
          status: 'boundary',
          strategy: 'pi-live-frame',
          entryId: entry.id,
          reason: 'No live transport registered for pi session.'
        }
      }
      const sent = transport.sendSteer(entry.text)
      if (!sent) {
        return {
          status: 'boundary',
          strategy: 'pi-live-frame',
          entryId: entry.id,
          reason: 'Live transport refused the steer frame.'
        }
      }
      return {
        status: 'injected',
        strategy: 'pi-live-frame',
        entryId: entry.id
      }
    }

    case 'acp-interrupt': {
      // Transport-first: ACP providers register a `steer()`-backed live
      // transport at turn launch (AcpTurnClient). When it is present, the
      // steering text is delivered into the SAME session — session/cancel
      // closes the in-flight prompt and the provider is re-prompted with the
      // steering text as the user's next message. Without a transport (turn
      // still in startup) arm the interrupt flag so the launch seam can pick
      // it up, and report 'interrupting' either way: delivery evidence is the
      // provider streaming again, which the caller observes on the transcript.
      const transport = session.liveSteerTransport
      if (transport) {
        const sent = transport.sendSteer(entry.text)
        if (!sent) {
          return {
            status: 'boundary',
            strategy: 'acp-interrupt',
            entryId: entry.id,
            reason: 'ACP live transport refused the steer (no in-flight prompt).'
          }
        }
        return {
          status: 'injected',
          strategy: 'acp-interrupt',
          entryId: entry.id
        }
      }
      runManager.requestInterrupt(runId)
      return {
        status: 'interrupting',
        strategy: 'acp-interrupt',
        entryId: entry.id
      }
    }

    case 'cooperative-cancel-resume': {
      // Never interrupt a tool's filesystem mutation. If we are mid-tool,
      // arm a kill that fires on the next tool_result boundary; otherwise it
      // is safe to request an immediate cooperative interrupt.
      if (midTool) {
        runManager.armKillAfterToolResult(runId)
      } else {
        runManager.requestInterrupt(runId)
      }
      return {
        status: 'interrupting',
        strategy: 'cooperative-cancel-resume',
        entryId: entry.id
      }
    }

    case 'broker-injection': {
      // The broker adapter watches `liveSteerTransport` on the session and
      // injects the next tool result with `{"type":"steering","text":...}`.
      // Auto-create the transport on first use so the Cursor launch site
      // doesn't need to know about broker-injection plumbing.
      if (!session.liveSteerTransport) {
        const transport = createBrokerSteerTransport(
          (text) => {
            session.pendingSteerText = text
          },
          () => session.pendingSteerText ?? null
        )
        session.liveSteerTransport = transport as LiveSteerTransport
      }
      // Sending through the broker transport arms the injection.
      session.liveSteerTransport.sendSteer(entry.text)
      return {
        status: 'broker-pending',
        strategy: 'broker-injection',
        entryId: entry.id
      }
    }

    case 'boundary':
    default:
      return {
        status: 'boundary',
        strategy: 'boundary',
        entryId: entry.id
      }
  }
}

export function cancelPendingSteer(
  deps: SteeringOrchestratorDeps,
  runId: string
): { cancelled: boolean; hadPending: boolean } {
  const state = deps.runManager.getInterruptState(runId)
  if (!state.interruptRequestedAt && !state.killAfterToolResult) {
    return { cancelled: false, hadPending: false }
  }
  const session = deps.runManager.get(runId)
  if (session?.liveSteerTransport?.cancel) {
    session.liveSteerTransport.cancel()
  }
  deps.runManager.unregisterLiveSteerTransport(runId)
  // Note: we deliberately do NOT cancel the running turn here. Cancelling a
  // steer request means "stop trying to inject mid-turn"; the ordinary turn
  // continues and the appended transcript row will be delivered at the next
  // natural boundary.
  return { cancelled: true, hadPending: true }
}

function isActiveStatus(status: string): boolean {
  return status === 'starting' || status === 'running'
}

/** Convenience lookup exported for tests and telemetry. */
export { midTurnSteeringCapabilityForProvider }
