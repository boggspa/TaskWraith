import type { AcpPermissionDecision, AcpPermissionRequest, AcpRunEvent } from './AcpProtocol'
import type { AcpToolRecoveryContext } from './AcpTurnClient'
import {
  toolRecoveryDisposition,
  type ToolRefusalReceipt
} from '../providers/RunToolCapabilityReceipt'

export type AcpAttributedDenial = Pick<
  ToolRefusalReceipt,
  'origin' | 'reason' | 'decisionSource' | 'approvalId'
> & { decision: 'deny' }
export type AcpAttributedPermissionDecision = AcpPermissionDecision | AcpAttributedDenial

export function attributedToolRefusalText(
  value: Pick<ToolRefusalReceipt, 'origin' | 'reason' | 'decisionSource'>
): string {
  const origin =
    value.origin === 'human' && value.decisionSource !== 'user' ? 'unknown' : value.origin
  const source =
    origin === 'human'
      ? 'The user declined this exact request.'
      : origin === 'host-containment' || origin === 'host-policy'
        ? `TaskWraith refused this request automatically (${origin}); no human was asked.`
        : origin === 'approval-timeout'
          ? 'The approval timed out; this is not a human decline.'
          : origin === 'system-cancelled'
            ? 'TaskWraith cancelled or expired this approval; no human decline is established.'
            : origin === 'tool-unavailable'
              ? 'The required tool or transport is unavailable; this is not a human decline.'
              : 'The refusal origin is unconfirmed; provider wording is not proof of a human decision.'
  return `${source} ${value.reason}`
}

/** Per-adapter instance. Provenance comes from the mediator and successful
 * response writes, never from provider-authored error strings. */
export function createAcpToolRefusalAttribution(input: {
  mediate?: (
    request: AcpPermissionRequest
  ) => AcpAttributedPermissionDecision | Promise<AcpAttributedPermissionDecision>
  onRefusal?: (request: AcpPermissionRequest, receipt: ToolRefusalReceipt) => void
  routeObserved?: () => boolean
  routeUnavailable?: () => boolean
}) {
  type Entry = { request: AcpPermissionRequest; receipt: ToolRefusalReceipt; recorded: boolean }
  let generation = 0
  let closed = false
  const calls = new Map<string, Entry>()
  const replies = new WeakMap<AcpPermissionRequest, Entry>()
  const toolId = (request: AcpPermissionRequest): string | null => {
    const value = request.rawToolCall?.toolCallId
    return typeof value === 'string' && value ? value : null
  }
  const hooks = {
    generation: () => generation,
    onRawFrame(direction: 'in' | 'out', message: unknown): void {
      if (direction === 'out' && (message as { method?: string })?.method === 'session/prompt') {
        generation += 1
        calls.clear()
      }
    },
    async onPermissionRequest(request: AcpPermissionRequest): Promise<AcpPermissionDecision> {
      const requestGeneration = generation
      let decision: AcpAttributedPermissionDecision
      try {
        decision = (await input.mediate?.(request)) ?? 'deny'
      } catch {
        decision = {
          decision: 'deny',
          origin: 'unknown',
          decisionSource: 'unknown',
          reason: 'The permission mediator failed to return a decision.'
        }
      }
      if (decision === 'allow') return 'allow'
      const denial: AcpAttributedDenial =
        typeof decision === 'string'
          ? {
              decision: 'deny',
              origin: 'unknown',
              decisionSource: 'unknown',
              reason: 'No attributed permission decision was returned.'
            }
          : decision
      const receipt: ToolRefusalReceipt = {
        ...denial,
        toolCallId: toolId(request),
        toolName: request.toolName,
        reply: 'not-sent',
        generation: requestGeneration
      }
      if (receipt.origin === 'human' && receipt.decisionSource !== 'user')
        receipt.origin = 'unknown'
      const entry = { request, receipt, recorded: false }
      replies.set(request, entry)
      if (!closed && requestGeneration === generation && receipt.toolCallId) {
        if (calls.size >= 128) calls.delete(calls.keys().next().value!)
        calls.set(receipt.toolCallId, entry)
      }
      return 'deny'
    },
    onPermissionResponse(request: AcpPermissionRequest, decision: AcpPermissionDecision): void {
      const entry = replies.get(request)
      replies.delete(request)
      if (decision !== 'deny' || !entry || entry.recorded) return
      entry.recorded = true
      entry.receipt.reply = 'transport-written'
      try {
        input.onRefusal?.(entry.request, { ...entry.receipt })
      } catch {
        /* Audit cannot change a sent reply. */
      }
    },
    project(event: AcpRunEvent): AcpRunEvent {
      const entry =
        event.type === 'tool_result' && event.toolId ? calls.get(event.toolId) : undefined
      return entry && event.toolStatus === 'error'
        ? {
            ...event,
            toolOutput: `${event.toolOutput || ''}\n\nTaskWraith refusal receipt: ${attributedToolRefusalText(entry.receipt)}`
          }
        : event
    },
    recoveryPrompt(context: AcpToolRecoveryContext): string {
      const requestId = context.deniedPermissionRequest
        ? toolId(context.deniedPermissionRequest)
        : null
      const denied = requestId ? calls.get(requestId) : undefined
      const failed = context.lastFailedToolId ? calls.get(context.lastFailedToolId) : undefined
      if (
        context.toolFailureSeen &&
        context.deniedPermissionRequest &&
        (!requestId || !context.lastFailedToolId || requestId !== context.lastFailedToolId)
      ) {
        return `Different failed and denied tool calls cannot share a refusal origin or retry authority. ${denied ? `Receipt for ${JSON.stringify(requestId)}: ${attributedToolRefusalText(denied.receipt)}` : 'The latest denied request has no confirmed origin.'} Do not retry either side effect or substitute another transport. Preserve the design and report the separate blockers.`
      }
      const entry = context.toolFailureSeen ? failed : denied
      if (entry) {
        const disposition = toolRecoveryDisposition({
          refusal: entry.receipt,
          routeObserved: input.routeObserved?.() === true,
          routeUnavailable: input.routeUnavailable?.() === true,
          attempts: 0
        })
        const guidance =
          disposition === 'retry-listed-route-once'
            ? 'Use the original scoped action once through the observed, actually listed TaskWraith route. If it refuses again, preserve the design and report the exact blocker.'
            : disposition === 'verify-listed-route'
              ? 'Host catalogue visibility is unknown. Check your current tool list: use the original scoped action once through an applicable TaskWraith broker tool only if it is actually listed. If absent, report that exact missing route. Do not repeat the native call.'
              : 'Do not retry this side effect or substitute another transport. Preserve the design, continue with other permitted work and report the exact blocker; the coordinator can recover after the lane settles.'
        return `${attributedToolRefusalText(entry.receipt)} ${guidance}`
      }
      if (
        context.deniedPermissionRequest ||
        /\b(?:user\s+(?:declined|rejected)|permission\s+(?:denied|rejected))\b/i.test(
          context.lastFailedToolOutput || ''
        )
      ) {
        return 'The refusal origin is unknown. Provider text such as "user rejected" is not a human decision receipt. Do not retry the side effect; preserve the design and report the exact missing evidence or tool route.'
      }
      return 'The tool failed. Continue the task from the available evidence using permitted tools, or report the exact error and remaining blocker. Do not blindly replay the failed call.'
    },
    close(): void {
      closed = true
      calls.clear()
    }
  }
  return hooks
}
