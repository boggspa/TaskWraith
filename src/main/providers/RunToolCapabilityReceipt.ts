import type { ChatRecord, EffectiveRunPermissions, ProviderId } from '../store/types'

export const RUN_TOOL_CAPABILITY_RECEIPT_TYPE = 'provider_tool_capability_receipt' as const
export const MAX_RECEIPT_TOOL_NAMES = 512
export const MAX_RECEIPT_REFUSALS = 64

export type ToolRefusalOrigin =
  | 'human'
  | 'host-policy'
  | 'host-containment'
  | 'approval-timeout'
  | 'system-cancelled'
  | 'tool-unavailable'
  | 'provider-native'
  | 'unknown'

export interface RunToolScope {
  kind: 'global' | 'workspace' | 'lane' | 'unknown'
  workspacePath: string | null
  intent?: 'none' | 'read' | 'write'
  paths: Array<{ kind: 'path' | 'glob' | 'workspace'; path?: string }>
  complete?: boolean
}

export interface RunToolCapabilityContext {
  runId: string
  chatId: string | null
  provider: ProviderId
  model: string | null
  transport: string
  participantId?: string | null
  laneId?: string | null
  providerSessionId?: string | null
  scope: RunToolScope
  effectivePermissions: Pick<
    EffectiveRunPermissions,
    'presetId' | 'readOnly' | 'agenticServices'
  > | null
}

export interface ToolCatalogueEvidence {
  names: string[]
  complete: boolean
  source:
    | 'host-config'
    | 'broker-served'
    | 'provider-catalogue'
    | 'extension-ready'
    | 'request-tools'
  namespace: string | null
  generation: number
}

export interface ToolRefusalReceipt {
  toolCallId: string | null
  toolName: string
  /** Host-selected operation identity; distinct calls must never share provenance. */
  operationId?: string
  origin: ToolRefusalOrigin
  reason: string
  approvalId?: string
  decisionSource: 'user' | 'system' | 'provider' | 'unknown'
  reply: 'host-result' | 'transport-written' | 'provider-observed' | 'not-sent'
  generation: number
}

export interface RunToolCapabilityReceipt extends RunToolCapabilityContext {
  schemaVersion: 1
  type: typeof RUN_TOOL_CAPABILITY_RECEIPT_TYPE
  generation: number
  revision: number
  timestamp: string
  permissionSource: 'host-resolved-run' | 'unknown'
  native: {
    advertised: ToolCatalogueEvidence | null
    served: ToolCatalogueEvidence | null
    attached: ToolCatalogueEvidence | null
    observed: ToolCatalogueEvidence | null
    executed: string[]
  }
  managed: {
    advertised: ToolCatalogueEvidence | null
    served: ToolCatalogueEvidence | null
    attached: ToolCatalogueEvidence | null
    observed: ToolCatalogueEvidence | null
    executed: string[]
  }
  connection: 'unknown' | 'configured' | 'ready' | 'unavailable'
  requiredManagedTools: string[]
  requiredManagedToolsComplete: boolean
  readiness: 'unverified' | 'available' | 'degraded'
  missingManagedTools: string[]
  missingManagedToolsComplete: boolean
  refusals: ToolRefusalReceipt[]
  refusalCount: number
  detailsTruncated: boolean
  blocker: string | null
  lifecycleSettled: boolean
}

function names(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 200)
    )
  ].slice(0, MAX_RECEIPT_TOOL_NAMES)
}

/** Leave room inside RunEventStore's 80,000-character envelope. Truncation is
 * explicit and never turns a partial list into proof that a tool is missing. */
function boundedSnapshot(receipt: RunToolCapabilityReceipt): RunToolCapabilityReceipt {
  const out = structuredClone(receipt)
  while (JSON.stringify(out).length > 64_000) {
    const candidates: Array<{ size: number; trim: () => void }> = []
    for (const surface of [out.native, out.managed]) {
      for (const field of ['advertised', 'served', 'attached', 'observed'] as const) {
        const catalogue = surface[field]
        if (!catalogue?.names.length) continue
        const optional = catalogue.names.filter((name) => !out.requiredManagedTools.includes(name))
        if (!optional.length) continue
        candidates.push({
          size: JSON.stringify(optional).length,
          trim: () => {
            const remove = new Set(optional.slice(0, Math.max(1, Math.ceil(optional.length / 2))))
            catalogue.names = catalogue.names.filter((name) => !remove.has(name))
            catalogue.complete = false
          }
        })
      }
      if (surface.executed.length)
        candidates.push({
          size: JSON.stringify(surface.executed).length,
          trim: () => {
            surface.executed = surface.executed.slice(
              Math.max(1, Math.ceil(surface.executed.length / 2))
            )
          }
        })
    }
    if (out.refusals.length > 1)
      candidates.push({
        size: JSON.stringify(out.refusals).length,
        trim: () => {
          out.refusals = out.refusals.slice(Math.ceil(out.refusals.length / 2))
        }
      })
    if (out.scope.paths.length)
      candidates.push({
        size: JSON.stringify(out.scope.paths).length,
        trim: () => {
          out.scope.paths = out.scope.paths.slice(0, Math.floor(out.scope.paths.length / 2))
          out.scope.complete = false
        }
      })
    if (out.requiredManagedTools.length)
      candidates.push({
        size: JSON.stringify(out.requiredManagedTools).length,
        trim: () => {
          out.requiredManagedTools = out.requiredManagedTools.slice(
            0,
            Math.floor(out.requiredManagedTools.length / 2)
          )
          out.requiredManagedToolsComplete = false
          if (out.readiness === 'available') out.readiness = 'unverified'
        }
      })
    if (out.missingManagedTools.length)
      candidates.push({
        size: JSON.stringify(out.missingManagedTools).length,
        trim: () => {
          out.missingManagedTools = out.missingManagedTools.slice(
            0,
            Math.floor(out.missingManagedTools.length / 2)
          )
          out.missingManagedToolsComplete = false
        }
      })
    candidates.sort((a, b) => b.size - a.size)
    if (!candidates[0]) break
    candidates[0].trim()
    out.detailsTruncated = true
  }
  return out
}

/** Scope is resolved from the exact current lane, never from a sibling's role
 * or from the presence/absence of a manual work marker. */
export function resolveRunToolScope(input: {
  runId: string
  workspacePath?: string | null
  scope?: 'workspace' | 'global'
  laneId?: string | null
  participantId?: string | null
  chat?: ChatRecord | null
}): RunToolScope {
  const workspacePath = input.workspacePath || null
  if (input.laneId) {
    const lane = input.chat?.ensemble?.activeRound?.lanes?.[input.laneId]
    if (!lane || lane.runId !== input.runId || lane.participantId !== input.participantId) {
      return { kind: 'unknown', workspacePath, paths: [] }
    }
    return {
      kind: 'lane',
      workspacePath,
      intent: lane.intent,
      paths: (lane.approvedWriteScopes ?? []).map(({ kind, path }) => ({
        kind,
        ...(path ? { path } : {})
      }))
    }
  }
  return input.scope === 'global' || !workspacePath
    ? { kind: 'global', workspacePath: null, paths: [] }
    : { kind: 'workspace', workspacePath, paths: [{ kind: 'workspace' }] }
}

export type ToolRecoveryDisposition =
  | 'retry-listed-route-once'
  | 'report-blocker'
  | 'respect-human-decision'

/** Evidence only. This helper never changes a grant or executes a retry. */
export function toolRecoveryDisposition(input: {
  refusal: Pick<ToolRefusalReceipt, 'origin' | 'decisionSource' | 'reply'>
  routeObserved: boolean
  attempts: number
}): ToolRecoveryDisposition {
  if (input.refusal.origin === 'human' && input.refusal.decisionSource === 'user') {
    return 'respect-human-decision'
  }
  return input.refusal.origin === 'host-containment' &&
    input.refusal.decisionSource === 'system' &&
    (input.refusal.reply === 'host-result' || input.refusal.reply === 'transport-written') &&
    input.routeObserved &&
    input.attempts === 0
    ? 'retry-listed-route-once'
    : 'report-blocker'
}

export function createRunToolCapabilityReceipt(
  context: RunToolCapabilityContext,
  options: { onChange?: (receipt: RunToolCapabilityReceipt) => void; now?: () => number } = {}
) {
  const now = options.now ?? Date.now
  const receipt: RunToolCapabilityReceipt = {
    ...structuredClone(context),
    schemaVersion: 1,
    type: RUN_TOOL_CAPABILITY_RECEIPT_TYPE,
    generation: 1,
    revision: 0,
    timestamp: new Date(now()).toISOString(),
    permissionSource: context.effectivePermissions ? 'host-resolved-run' : 'unknown',
    native: { advertised: null, served: null, attached: null, observed: null, executed: [] },
    managed: { advertised: null, served: null, attached: null, observed: null, executed: [] },
    connection: 'unknown',
    requiredManagedTools: [],
    requiredManagedToolsComplete: true,
    readiness: 'unverified',
    missingManagedTools: [],
    missingManagedToolsComplete: true,
    refusals: [],
    refusalCount: 0,
    detailsTruncated: false,
    blocker: null,
    lifecycleSettled: false
  }
  const snapshot = (): RunToolCapabilityReceipt => boundedSnapshot(receipt)
  const publish = (): void => {
    receipt.revision += 1
    receipt.timestamp = new Date(now()).toISOString()
    try {
      options.onChange?.(snapshot())
    } catch {
      /* Reporting cannot change run authority. */
    }
  }
  const current = (generation: number): boolean =>
    !receipt.lifecycleSettled && generation === receipt.generation
  const assess = (): void => {
    const observed = receipt.managed.observed ?? receipt.managed.attached
    receipt.missingManagedTools = observed?.complete
      ? receipt.requiredManagedTools.filter((name) => !observed.names.includes(name))
      : []
    receipt.readiness =
      receipt.connection === 'unavailable' || receipt.missingManagedTools.length > 0
        ? 'degraded'
        : observed &&
            receipt.requiredManagedToolsComplete &&
            (receipt.requiredManagedTools.length > 0
              ? receipt.requiredManagedTools.every((name) => observed.names.includes(name))
              : observed.complete)
          ? 'available'
          : 'unverified'
  }
  return {
    snapshot,
    beginGeneration(providerSessionId?: string | null): number {
      if (receipt.lifecycleSettled) return receipt.generation
      receipt.generation += 1
      if (providerSessionId !== undefined) receipt.providerSessionId = providerSessionId
      receipt.native.observed = null
      receipt.managed.observed = null
      receipt.native.served = null
      receipt.managed.served = null
      receipt.native.attached = null
      receipt.managed.attached = null
      receipt.native.executed = []
      receipt.managed.executed = []
      receipt.connection = 'unknown'
      receipt.blocker = null
      assess()
      publish()
      return receipt.generation
    },
    catalogue(
      surface: 'native' | 'managed',
      evidence: Omit<ToolCatalogueEvidence, 'generation'>,
      generation = receipt.generation
    ): boolean {
      if (!current(generation)) return false
      const values = names(evidence.names)
      const normalized: ToolCatalogueEvidence = {
        ...evidence,
        names: values,
        generation,
        complete: evidence.complete && values.length === new Set(evidence.names).size
      }
      const field =
        evidence.source === 'host-config'
          ? 'advertised'
          : evidence.source === 'broker-served'
            ? 'served'
            : evidence.source === 'provider-catalogue'
              ? 'observed'
              : 'attached'
      receipt[surface][field] = normalized
      assess()
      publish()
      return true
    },
    requireManagedTools(required: readonly string[]): void {
      if (receipt.lifecycleSettled) return
      receipt.requiredManagedTools = names(required)
      receipt.requiredManagedToolsComplete =
        receipt.requiredManagedTools.length === new Set(required).size
      assess()
      publish()
    },
    connection(
      status: RunToolCapabilityReceipt['connection'],
      reason?: string,
      generation = receipt.generation
    ): boolean {
      if (!current(generation)) return false
      receipt.connection = status
      if (reason) receipt.blocker = reason.slice(0, 2_000)
      assess()
      publish()
      return true
    },
    executed(
      surface: 'native' | 'managed',
      toolName: string,
      generation = receipt.generation
    ): boolean {
      if (!current(generation)) return false
      receipt[surface].executed = names([...receipt[surface].executed, toolName])
      // One successful call proves that tool executed, not that a whole catalogue exists.
      publish()
      return true
    },
    refusal(
      value: Omit<ToolRefusalReceipt, 'generation'>,
      generation = receipt.generation
    ): boolean {
      const confirmedHistorical =
        generation > 0 &&
        generation <= receipt.generation &&
        (value.reply === 'transport-written' || value.reply === 'host-result') &&
        (value.decisionSource === 'user' || value.decisionSource === 'system')
      if (!current(generation) && !confirmedHistorical) return false
      const origin =
        value.origin === 'human' && value.decisionSource !== 'user' ? 'unknown' : value.origin
      receipt.refusals = [
        ...receipt.refusals,
        { ...value, origin, reason: value.reason.slice(0, 2_000), generation }
      ].slice(-MAX_RECEIPT_REFUSALS)
      receipt.refusalCount += 1
      if (receipt.refusalCount > receipt.refusals.length) receipt.detailsTruncated = true
      publish()
      return true
    },
    settle(): void {
      if (receipt.lifecycleSettled) return
      receipt.lifecycleSettled = true
      publish()
    }
  }
}

export function formatRunToolCapabilityReceipt(receipt: RunToolCapabilityReceipt): string {
  return [
    '[TaskWraith run tool receipt]',
    JSON.stringify(receipt),
    'This receipt reports evidence, not a new permission grant. Configuration, observed catalogues and executed tools are separate facts. Unknown availability is not user refusal.',
    'Use exact names actually present in your tool list. Respect human and scope/policy refusals. If an authorized route is missing or a refusal repeats without new evidence, preserve the design, report the exact blocker and finish available work; the coordinator can recover after the lane settles.',
    '[/TaskWraith run tool receipt]'
  ].join('\n')
}
