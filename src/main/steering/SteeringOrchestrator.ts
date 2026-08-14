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

import type { LiveSteerDeliveryHooks, LiveSteerTransport, RunManager } from '../RunManager'
import type {
  MidRunSteeringAuthorKind,
  MidRunSteeringEntry,
  MidRunSteeringRegistry
} from '../run/MidRunSteering'
import {
  midTurnSteeringCapabilityForProvider,
  planMidTurnSteeringDelivery
} from '../run/MidRunSteering'
import { createBrokerSteerTransport, formatBrokerSteeringElement } from './BrokerSteerTransport'
import type { ProviderId } from '../store/types'
import type {
  LiveSteeringDeliveryStatus,
  LiveSteeringInjectionResult
} from '../../shared/liveSteering'

export type SteeringDeliveryStatus = LiveSteeringDeliveryStatus

export interface SteeringAttemptResult extends LiveSteeringInjectionResult {}

export interface SteeringOrchestratorDeps {
  runManager: RunManager
  registry: MidRunSteeringRegistry
  /** Production gate. Off means every provider falls back to boundary delivery. */
  midTurnSteeringEnabled: boolean
  /** Pi retains its own emergency kill switch. */
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
  /** Called only when the transport has concrete provider delivery evidence. */
  deliveryHooks?: LiveSteerDeliveryHooks
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
  if (!session || session.appChatId !== chatId || session.provider !== provider) {
    return {
      status: 'boundary',
      strategy: 'boundary',
      entryId: entry.id,
      reason:
        'No matching active provider session for this chat; falling back to boundary delivery.'
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
      const sent = sendThroughTransport(transport, entry.text, input.deliveryHooks)
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
      // still in startup), there is no consumer for a deferred interrupt. Be
      // honest and keep the durable message on the boundary queue.
      const transport = session.liveSteerTransport
      if (transport) {
        const sent = sendThroughTransport(transport, entry.text, input.deliveryHooks)
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
      return {
        status: 'boundary',
        strategy: 'acp-interrupt',
        entryId: entry.id,
        reason: 'ACP session has no live steer transport yet.'
      }
    }

    case 'cooperative-cancel-resume': {
      // No production provider adapter consumes the historical interrupt
      // flags. Claiming "interrupting" here stranded the durable queue row in
      // steer_promoting. Until a provider registers an evidence-producing
      // transport, preserve the current run and release the message at its
      // natural boundary.
      return {
        status: 'boundary',
        strategy: 'cooperative-cancel-resume',
        entryId: entry.id,
        reason: midTool
          ? 'Provider is inside a tool call and has no safe live steer transport.'
          : 'Provider has no evidence-producing live steer transport.'
      }
    }

    case 'broker-injection': {
      // A main-side consumer drains the armed text at its next natural
      // boundary: the MCP broker's tools/call handler for Cursor, the
      // provider tool loop's next model request for Ollama. Auto-create the
      // transport on first use so launch sites don't need to know about
      // broker-injection plumbing.
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
      const sent = sendThroughTransport(
        session.liveSteerTransport,
        formatBrokerSteeringElement(entry.text, entry.authorKind),
        input.deliveryHooks
      )
      if (!sent) {
        return {
          status: 'boundary',
          strategy: 'broker-injection',
          entryId: entry.id,
          reason: 'Broker transport refused the steering text.'
        }
      }
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
  const session = deps.runManager.get(runId)
  const state = deps.runManager.getInterruptState(runId)
  const hasTransportPending = Boolean(session?.pendingSteerText)
  if (!state.interruptRequestedAt && !state.killAfterToolResult && !hasTransportPending) {
    return { cancelled: false, hadPending: false }
  }
  if (session?.liveSteerTransport?.cancel) {
    session.liveSteerTransport.cancel()
  }
  if (session) session.pendingSteerText = undefined
  // Note: we deliberately do NOT cancel the running turn here. Cancelling a
  // steer request means "stop trying to inject mid-turn"; the ordinary turn
  // continues and the appended transcript row will be delivered at the next
  // natural boundary.
  return { cancelled: true, hadPending: true }
}

function isActiveStatus(status: string): boolean {
  return status === 'starting' || status === 'running'
}

function sendThroughTransport(
  transport: LiveSteerTransport,
  text: string,
  hooks: LiveSteerDeliveryHooks | undefined
): boolean {
  return hooks ? transport.sendSteer(text, hooks) : transport.sendSteer(text)
}

/** Convenience lookup exported for tests and telemetry. */
export { midTurnSteeringCapabilityForProvider }
