import type { ChatRecord, EffectiveRunPermissions, RunEventRecord } from '../store/types'
import { KIMI_ACP_DENY_TOOLS } from './KimiAcpContainment'
import type { KimiGatewayReceipt } from './KimiGatewayReadiness'

export interface KimiRunCapabilityContext {
  runId: string
  chatId?: string
  participantId?: string
  laneId?: string
  workspacePath?: string
  permissions?: EffectiveRunPermissions
  assignedScope: {
    kind: 'workspace' | 'lane' | 'unknown'
    intent?: 'none' | 'read' | 'write'
    paths: Array<{ kind: 'path' | 'glob' | 'workspace'; path?: string }>
  }
}

export interface KimiNativeRefusalReceipt {
  toolCallId: string | null
  toolName: string
  source: 'host-containment'
  decisionSource: 'system'
  userAsked: false
  timestamp: string
}

export interface KimiRunCapabilityReceipt {
  schemaVersion: 1
  runId: string
  chatId: string | null
  participantId: string | null
  laneId: string | null
  providerSessionId: string | null
  transport: 'kimi-acp-http'
  phase: 'starting' | 'recovering' | 'catalogue-served' | 'broker-used' | 'blocked' | 'settled'
  outcome: 'running' | 'blocked' | 'settled'
  lifecycleSettled: boolean
  workspacePath: string | null
  assignedScope: KimiRunCapabilityContext['assignedScope']
  effectivePermissions: Pick<
    EffectiveRunPermissions,
    'presetId' | 'readOnly' | 'agenticServices'
  > | null
  permissionSource: 'host-resolved-run' | 'unavailable'
  gateway: KimiGatewayReceipt
  brokerToolNames: string[]
  brokerToolNameSource: 'served-catalogue' | 'provider-tools-snapshot'
  modelToolVisibility: 'not-observed' | 'broker-call-observed' | 'provider-tools-snapshot'
  nativeTools: {
    catalogue: string[] | null
    catalogueObservedAt: string | null
    catalogueIsCurrent: boolean
    observedCalls: string[]
    intendedDenied: string[]
    enforcement: 'not-attested'
  }
  refusals: KimiNativeRefusalReceipt[]
  blocker: string | null
  timestamp: string
}

export function kimiAssignedRunScope(
  chat: ChatRecord | null,
  runId: string,
  laneId?: string,
  participantId?: string
): KimiRunCapabilityContext['assignedScope'] {
  if (!laneId) return { kind: 'workspace', paths: [{ kind: 'workspace' }] }
  const lane = chat?.ensemble?.activeRound?.lanes?.[laneId]
  if (!lane || lane.runId !== runId || lane.participantId !== participantId) {
    return { kind: 'unknown', paths: [] }
  }
  return {
    kind: 'lane',
    intent: lane.intent,
    paths: (lane.approvedWriteScopes ?? []).map(({ kind, path }) => ({
      kind,
      ...(path ? { path } : {})
    }))
  }
}

export function formatKimiRunCapabilityReceipt(receipt: KimiRunCapabilityReceipt): string {
  return [
    '[TaskWraith capability receipt]',
    JSON.stringify(receipt),
    'This is host-observed run state, not an additional grant. A served catalogue proves the HTTP response was sent; modelToolVisibility separately identifies evidence from a provider snapshot or broker call.',
    `The real workspace is ${receipt.workspacePath ? JSON.stringify(receipt.workspacePath) : 'unspecified for this global run'}. The provider cwd is private runtime storage, not the project root. Resolve project paths through the listed TaskWraith workspace tools and obey the assigned scope.`,
    'Use exact names from your current tool list. Kimi versions may spell a TaskWraith tool mcp__taskwraith__<name> or TaskWraith__<name>; a name in instructions cannot make an absent tool available.',
    'TaskWraith itself rejects native Bash/Edit/Write permission requests before a human is asked. For a receipt marked host-containment, generic provider wording about user rejection describes that transport refusal. An actual human refusal on the broker remains authoritative and must not be retried.',
    'If a required broker tool is absent, report that exact missing name and finish the lane with the completed design and evidence. Do not substitute a native tool or excavate private provider history to obtain a missing capability. The Captain can recover or reassign after this lane settles.',
    '[/TaskWraith capability receipt]'
  ].join('\n')
}

export function latestKimiRunCapabilityReceipt(
  events: readonly RunEventRecord[],
  runId: string,
  chatId: string
): KimiRunCapabilityReceipt | null {
  const candidates = events
    .filter(
      (event) =>
        event.runId === runId &&
        event.chatId === chatId &&
        event.provider === 'kimi' &&
        event.source === 'main' &&
        event.kind === 'lifecycle'
    )
    .sort((left, right) => right.sequence - left.sequence)
  for (const event of candidates) {
    const payload = event.payload as {
      type?: unknown
      capabilityReceipt?: KimiRunCapabilityReceipt
    } | null
    const receipt = payload?.capabilityReceipt
    if (
      payload?.type === 'kimi_capability_receipt' &&
      receipt?.schemaVersion === 1 &&
      receipt.runId === runId &&
      receipt.chatId === chatId &&
      receipt.transport === 'kimi-acp-http' &&
      Array.isArray(receipt.brokerToolNames) &&
      Array.isArray(receipt.refusals) &&
      receipt.gateway &&
      receipt.assignedScope
    )
      return receipt
  }
  return null
}

export function createKimiRunCapabilityReceipt(
  context: KimiRunCapabilityContext,
  gateway: KimiGatewayReceipt
): KimiRunCapabilityReceipt {
  return {
    schemaVersion: 1,
    runId: context.runId,
    chatId: context.chatId ?? null,
    participantId: context.participantId ?? null,
    laneId: context.laneId ?? null,
    providerSessionId: null,
    transport: 'kimi-acp-http',
    phase: 'starting',
    outcome: 'running',
    lifecycleSettled: false,
    workspacePath: context.workspacePath ?? null,
    assignedScope: context.assignedScope,
    effectivePermissions: context.permissions
      ? {
          presetId: context.permissions.presetId,
          readOnly: context.permissions.readOnly,
          agenticServices: { ...context.permissions.agenticServices }
        }
      : null,
    permissionSource: context.permissions ? 'host-resolved-run' : 'unavailable',
    gateway,
    brokerToolNames: [],
    brokerToolNameSource: 'served-catalogue',
    modelToolVisibility: 'not-observed',
    nativeTools: {
      catalogue: null,
      catalogueObservedAt: null,
      catalogueIsCurrent: false,
      observedCalls: [],
      intendedDenied: [...KIMI_ACP_DENY_TOOLS],
      enforcement: 'not-attested'
    },
    refusals: [],
    blocker: null,
    timestamp: new Date().toISOString()
  }
}
