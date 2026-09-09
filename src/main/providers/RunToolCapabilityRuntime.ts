import type { AgentRunPayload } from '../run/AgentRunTypes'
import type {
  ApprovalLedgerRecord,
  ChatRecord,
  ChatRun,
  ProviderId,
  TaskWraithMcpProfileId
} from '../store/types'
import { taskWraithMcpAdvertisedToolNamesForProfile } from '../mcp/McpToolProfiles'
import { isReadOnlyAdvertisedTool, isPlanAdvertisedTool } from '../mcp/McpAutoAllowedTools'
import {
  createRunToolCapabilityReceipt,
  boundRunToolCapabilityReceipt,
  resolveRunToolScope,
  type RunToolCapabilityContext,
  type RunToolCapabilityReceipt,
  type ToolRefusalOrigin,
  type ToolRefusalReceipt
} from './RunToolCapabilityReceipt'
import { runToolCapabilityCache } from './RunToolCapabilityStore'

export type RunToolCapabilityReporter = ReturnType<typeof createRunToolCapabilityReceipt>
const reporters = new Map<string, RunToolCapabilityReporter>()
const key = (runId: string, chatId: string | null, provider: ProviderId) =>
  `${provider}\0${chatId ?? ''}\0${runId}`

export function createRuntimeToolCapabilityRecorder(deps: {
  getChat: (chatId: string) => ChatRecord | null
  record: (receipt: RunToolCapabilityReceipt) => void
}) {
  return (
    provider: ProviderId,
    route: { appRunId?: string; appChatId?: string },
    payload: Parameters<typeof createRunToolCapabilityReporter>[0]['payload'],
    transport: string
  ): RunToolCapabilityReporter | undefined => {
    if (!route.appRunId) return undefined
    return createRunToolCapabilityReporter({
      runId: route.appRunId,
      chatId: route.appChatId,
      provider,
      transport,
      payload,
      chat: route.appChatId ? deps.getChat(route.appChatId) : null,
      record: deps.record
    })
  }
}

export function createRunToolCapabilityReporter(input: {
  runId: string
  chatId?: string
  provider: ProviderId
  transport: string
  payload: Pick<
    AgentRunPayload,
    'model' | 'scope' | 'workspace' | 'effectivePermissions' | 'ensembleRun' | 'providerSessionId'
  >
  chat: ChatRecord | null
  record?: (receipt: RunToolCapabilityReceipt) => void
}): RunToolCapabilityReporter {
  const participantId = input.payload.ensembleRun?.participantId
  const laneId = input.payload.ensembleRun?.laneId
  const context: RunToolCapabilityContext = {
    runId: input.runId,
    chatId: input.chatId || null,
    provider: input.provider,
    transport: input.transport,
    model: input.payload.model || null,
    participantId: participantId || null,
    laneId: laneId || null,
    providerSessionId: input.payload.providerSessionId || null,
    scope: resolveRunToolScope({
      runId: input.runId,
      workspacePath: input.payload.workspace,
      scope: input.payload.scope,
      laneId,
      participantId,
      chat: input.chat
    }),
    effectivePermissions: input.payload.effectivePermissions
      ? {
          presetId: input.payload.effectivePermissions.presetId,
          readOnly: input.payload.effectivePermissions.readOnly,
          agenticServices: { ...input.payload.effectivePermissions.agenticServices }
        }
      : null
  }
  const reporter = createRunToolCapabilityReceipt(context, {
    onChange: (receipt) => {
      runToolCapabilityCache.put(receipt)
      input.record?.(receipt)
    }
  })
  const id = key(input.runId, input.chatId || null, input.provider)
  reporters.delete(id)
  reporters.set(id, reporter)
  while (reporters.size > 128) reporters.delete(reporters.keys().next().value!)
  reporter.connection('unknown')
  return reporter
}

export function getRunToolCapabilityReporter(
  runId: string,
  chatId: string | null,
  provider: ProviderId
): RunToolCapabilityReporter | null {
  return reporters.get(key(runId, chatId, provider)) || null
}

export function configureRunManagedToolReceipt(
  reporter: RunToolCapabilityReporter | undefined,
  input: {
    attached: boolean
    namespace: string | null
    profileId?: TaskWraithMcpProfileId
    safeSubset?: boolean
    planSubset?: boolean
    reason?: string
  }
): void {
  if (!reporter) return
  const policy = reporter.snapshot().effectivePermissions
  reporter.requireManagedTools(
    policy?.readOnly
      ? []
      : [
          ...(policy?.agenticServices.fileChanges && policy.agenticServices.fileChanges !== 'deny'
            ? ['replace']
            : []),
          ...(policy?.agenticServices.shellCommands &&
          policy.agenticServices.shellCommands !== 'deny'
            ? ['run_shell_command']
            : [])
        ]
  )
  const names =
    input.attached && input.profileId
      ? taskWraithMcpAdvertisedToolNamesForProfile(input.profileId).filter(
          (name) =>
            !input.safeSubset ||
            (input.planSubset ? isPlanAdvertisedTool(name) : isReadOnlyAdvertisedTool(name))
        )
      : []
  reporter.catalogue('managed', {
    names,
    complete: Boolean(input.profileId),
    source: 'host-config',
    namespace: input.namespace
  })
  reporter.connection(input.attached ? 'configured' : 'unavailable', input.reason)
}

/** Old runs still get the common shape, with missing observations explicitly
 * unknown. Saved settings are never substituted for the recorded run posture. */
export function recordedRunToolCapabilityReceipt(
  run: ChatRun,
  chat: ChatRecord,
  provider: ProviderId
): RunToolCapabilityReceipt {
  const posture = run.permissionPosture
  const laneId = posture?.context?.ensembleLaneId
  const participantId = posture?.context?.ensembleParticipantId
  const reporter = createRunToolCapabilityReceipt({
    runId: run.runId,
    chatId: chat.appChatId,
    provider,
    model: run.actualModel || run.requestedModel || null,
    transport: 'unobserved',
    providerSessionId: run.providerThreadId || null,
    laneId,
    participantId,
    scope: resolveRunToolScope({
      runId: run.runId,
      scope: chat.scope,
      workspacePath: run.effectiveWorkspacePath || chat.workspacePath,
      laneId,
      participantId,
      chat
    }),
    effectivePermissions:
      posture?.presetId && typeof posture.readOnly === 'boolean' && posture.agenticServices
        ? {
            presetId: posture.presetId,
            readOnly: posture.readOnly,
            agenticServices: { ...posture.agenticServices }
          }
        : null
  })
  if (run.endedAt) reporter.settle()
  return reporter.snapshot()
}

export function approvalRecordToolRefusal(
  record: ApprovalLedgerRecord,
  generation: number
): ToolRefusalReceipt | null {
  if (!['denied', 'cancelled', 'expired'].includes(record.status)) return null
  const metadata = record.metadata || {}
  const declared = metadata.refusalOrigin
  const knownOrigins: ToolRefusalOrigin[] = [
    'host-policy',
    'host-containment',
    'approval-timeout',
    'system-cancelled',
    'tool-unavailable'
  ]
  let origin: ToolRefusalOrigin = 'unknown'
  if (record.decisionSource === 'user' && ['decline', 'cancel'].includes(record.decision || ''))
    origin = 'human'
  else if (record.decisionSource === 'policy' || record.decisionSource === 'host_destructive')
    origin = 'host-policy'
  else if (record.decisionSource === 'system')
    origin =
      metadata.autoDeniedByTimeout === true
        ? 'approval-timeout'
        : knownOrigins.includes(declared as ToolRefusalOrigin)
          ? (declared as ToolRefusalOrigin)
          : 'system-cancelled'
  return {
    toolCallId: typeof metadata.toolCallId === 'string' ? metadata.toolCallId : null,
    toolName: typeof metadata.toolName === 'string' ? metadata.toolName : record.method,
    origin,
    reason: (typeof metadata.rationale === 'string' ? metadata.rationale : record.title).slice(
      0,
      2_000
    ),
    approvalId: record.approvalId,
    decisionSource: origin === 'human' ? 'user' : record.decisionSource ? 'system' : 'unknown',
    reply: 'host-result',
    generation:
      typeof metadata.generation === 'number' && Number.isSafeInteger(metadata.generation)
        ? metadata.generation
        : generation
  }
}

export function withRunToolApprovalRefusals(
  receipt: RunToolCapabilityReceipt,
  records: readonly ApprovalLedgerRecord[]
): RunToolCapabilityReceipt {
  const out = structuredClone(receipt)
  const existing = new Set(out.refusals.map((row) => row.approvalId).filter(Boolean))
  for (const record of [...records].reverse()) {
    if (
      record.runId !== out.runId ||
      record.chatId !== out.chatId ||
      record.provider !== out.provider ||
      existing.has(record.approvalId)
    )
      continue
    const refusal = approvalRecordToolRefusal(record, out.generation)
    if (!refusal) continue
    const sameCall = out.refusals.findIndex(
      (row) =>
        row.toolCallId &&
        row.toolCallId === refusal.toolCallId &&
        typeof record.metadata?.generation === 'number' &&
        row.generation === refusal.generation
    )
    if (sameCall >= 0) {
      out.refusals[sameCall] = { ...out.refusals[sameCall], approvalId: record.approvalId }
      existing.add(record.approvalId)
      continue
    }
    out.refusals.push(refusal)
    existing.add(record.approvalId)
  }
  out.refusalCount = Math.max(out.refusalCount, out.refusals.length)
  // The live detail window and ledger query may each omit different history.
  // Their union is a lower bound, not an invented exact total.
  out.refusalCountIsLowerBound = true
  if (out.refusals.length > 16) {
    out.refusals = out.refusals.slice(-16)
    out.detailsTruncated = true
  }
  return boundRunToolCapabilityReceipt(out)
}
