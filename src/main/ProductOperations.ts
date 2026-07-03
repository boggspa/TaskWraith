import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'

import type {
  AppSettings,
  ApprovalLedgerRecord,
  AuditRetentionPurgeReceipt,
  AuditRunRecord,
  CapabilityLedgerSnapshot,
  EvidencePackRecord,
  MessageFeedbackReceipt,
  GeminiMcpBridgeStatus,
  ProductAuditBundleFilter,
  ProductAuditBundleManifest,
  ProductAuditBundleSnapshot,
  ProductAuditBundleSignature,
  ProductBridgeHealthRecord,
  ProductCrashFilter,
  ProductCrashInput,
  ProductCrashRecord,
  ProductDiagnosticsSnapshot,
  ProductHealthCheck,
  ProductInstallRepairStatus,
  ProductOperationStatus,
  ProductOperationsStatus,
  ProductArchitectureCompatibilityStatus,
  ProductReleaseAutomationStatus,
  ProductUpdateChannel,
  RunQueueJob,
  RunRecoveryRecord,
  RunEventRecord,
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceChangeSet,
  WorkspaceRecord,
  ChatRecord
} from './store/types'
import type { UpdateArchitectureCompatibility } from './UpdateArchitecture'
import type { ExternalPublishReceipt } from './ExternalPublishReceiptLedger'
import type { UserMcpLaunchPolicyDecision } from './UserMcpServers'
import { createRunEventReplay } from './RunEventStore'

const MAX_CRASH_TEXT_CHARS = 12_000
const MAX_DIAGNOSTIC_RECORDS = 250

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /((?:api|access|auth|bearer|refresh|session|secret|token|password|passwd|pwd)[\w.-]*\s*[:=]\s*)["']?[^"'\s,;]+/gi
]

function boundedText(value: unknown, maxChars = MAX_CRASH_TEXT_CHARS): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value)
  const redacted = redactProductOperationsText(text)
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n...truncated...` : redacted
}

function normalizeStatus(statuses: ProductOperationStatus[]): ProductOperationStatus {
  if (statuses.includes('error')) return 'error'
  if (statuses.includes('warning')) return 'warning'
  if (statuses.includes('unknown')) return 'unknown'
  return 'ok'
}

function diagnosticsSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sanitizeDiagnosticsValue(value)))
    .digest('hex')
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
    .join(',')}}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function unsignedAuditBundleSnapshotForSignature(
  snapshot: ProductAuditBundleSnapshot
): ProductAuditBundleSnapshot {
  const { signature: _signature, ...manifest } = snapshot.manifest
  return {
    ...snapshot,
    manifest: {
      ...manifest,
      validation: {
        ...manifest.validation,
        tamperEvidence: 'local_hashes_signed'
      }
    }
  }
}

function auditBundleSignaturePayload(snapshot: ProductAuditBundleSnapshot): string {
  return stableJson(unsignedAuditBundleSnapshotForSignature(snapshot))
}

function expectedAuditBundleCounts(
  snapshot: ProductAuditBundleSnapshot
): ProductAuditBundleManifest['counts'] {
  const runEventCount = snapshot.sections.runEventReplays.reduce((total, replay) => {
    const count = typeof replay.count === 'number' && Number.isFinite(replay.count) ? replay.count : 0
    return total + count
  }, 0)
  return {
    approvalLedger: snapshot.sections.approvalLedger.length,
    runEventReplays: snapshot.sections.runEventReplays.length,
    runEvents: runEventCount,
    workspaceChanges: snapshot.sections.workspaceChanges.length,
    auditRuns: snapshot.sections.auditRuns.length,
    evidencePacks: snapshot.sections.evidencePacks.length,
    capabilityLedgerEntries: snapshot.sections.capabilityLedger.length,
    messageFeedback: snapshot.sections.messageFeedback.length,
    externalPublish: snapshot.sections.externalPublish.length,
    auditRetentionPurges: snapshot.sections.auditRetentionPurges.length,
    userMcpBlockedServers: snapshot.sections.userMcpBlockedServers.length
  }
}

function expectedAuditBundleHashes(
  snapshot: ProductAuditBundleSnapshot
): ProductAuditBundleManifest['hashes'] {
  return {
    approvalLedger: diagnosticsSha256(snapshot.sections.approvalLedger),
    runEventReplays: diagnosticsSha256(snapshot.sections.runEventReplays),
    workspaceChanges: diagnosticsSha256(snapshot.sections.workspaceChanges),
    auditRuns: diagnosticsSha256(snapshot.sections.auditRuns),
    evidencePacks: diagnosticsSha256(snapshot.sections.evidencePacks),
    capabilityLedger: diagnosticsSha256(snapshot.sections.capabilityLedger),
    messageFeedback: diagnosticsSha256(snapshot.sections.messageFeedback),
    externalPublish: diagnosticsSha256(snapshot.sections.externalPublish),
    auditRetentionPurges: diagnosticsSha256(snapshot.sections.auditRetentionPurges),
    userMcpBlockedServers: diagnosticsSha256(snapshot.sections.userMcpBlockedServers)
  }
}

function objectValuesMatch(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

function summarizeMessageFeedbackReceiptForDiagnostics(
  receipt: MessageFeedbackReceipt
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    receiptHash: diagnosticsSha256({
      id: receipt.id,
      chatId: receipt.chatId,
      messageId: receipt.messageId
    }),
    source: receipt.source,
    action: receipt.action,
    chatIdHash: diagnosticsSha256(receipt.chatId),
    ...(receipt.workspaceId ? { workspaceIdHash: diagnosticsSha256(receipt.workspaceId) } : {}),
    hasWorkspacePath: Boolean(receipt.workspacePath),
    messageIdHash: diagnosticsSha256(receipt.messageId),
    hasRunId: Boolean(receipt.runId),
    provider: receipt.provider,
    hasModel: Boolean(receipt.model),
    hasRole: Boolean(receipt.role),
    hasEnsembleAttribution: Boolean(
      receipt.ensembleParticipantId ||
        receipt.ensembleLaneId ||
        receipt.ensembleRole ||
        receipt.ensembleStageRole
    ),
    attributionSource: receipt.attributionSource,
    attributionComplete: receipt.attributionComplete,
    vote: receipt.vote,
    previousVote: receipt.previousVote,
    hasReason: Boolean(receipt.reason),
    hasSensitiveNote: Boolean(receipt.note)
  }
}

function summarizeExternalPublishReceiptForDiagnostics(
  receipt: ExternalPublishReceipt
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    id: receipt.id,
    origin: receipt.origin,
    action: receipt.action,
    decision: receipt.decision,
    reason: receipt.reason,
    requestedAt: receipt.requestedAt,
    completedAt: receipt.completedAt,
    outcome: receipt.outcome,
    workspaceId: receipt.workspaceId,
    hasWorkspacePath: Boolean(receipt.workspacePath),
    hasRepoPath: Boolean(receipt.repoPath),
    remote: receipt.remote,
    setUpstream: receipt.setUpstream,
    hasTitle: Boolean(receipt.title),
    draft: receipt.draft,
    commitSha: receipt.commitSha,
    hasPrUrl: Boolean(receipt.prUrl),
    hasError: Boolean(receipt.error),
    metadata: receipt.metadata
  }
}

function summarizeAuditRetentionPurgeReceiptForDiagnostics(
  receipt: AuditRetentionPurgeReceipt
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    idHash: hashId(receipt.id),
    generatedAt: receipt.generatedAt,
    dryRun: receipt.dryRun,
    enabled: receipt.enabled,
    surfaces: Object.fromEntries(
      Object.entries(receipt.counts || {}).map(([surface, counts]) => [
        surface,
        {
          scanned: counts.scanned,
          retained: counts.retained,
          deleted: counts.deleted
        }
      ])
    )
  }
}

function userMcpBlockedReasonCategory(reason: unknown): string {
  const text = typeof reason === 'string' ? reason : ''
  if (/^transport .* is not allowlisted$/i.test(text)) return 'transport_not_allowlisted'
  if (/^env key .* is not allowlisted$/i.test(text)) return 'env_key_not_allowlisted'
  if (/^header .* is not allowlisted$/i.test(text)) return 'header_not_allowlisted'
  if (/^command path is not allowlisted$/i.test(text)) return 'command_path_not_allowlisted'
  if (/^remote host is not allowlisted$/i.test(text)) return 'remote_host_not_allowlisted'
  if (/plugin id is not allowlisted$/i.test(text)) return 'plugin_id_not_allowlisted'
  if (/plugin provenance is required$/i.test(text)) return 'plugin_provenance_required'
  if (/^secret .* is /i.test(text)) return 'secret_resolution_failed'
  return text ? 'other' : 'unknown'
}

function summarizeUserMcpBlockedServerForDiagnostics(
  decision: UserMcpLaunchPolicyDecision
): Record<string, unknown> {
  return {
    decisionHash: diagnosticsSha256({
      serverId: decision.serverId,
      serverName: decision.serverName,
      transport: decision.transport,
      reason: decision.reason
    }),
    serverIdHash: hashId(decision.serverId),
    serverNameHash: hashId(decision.serverName),
    transport: decision.transport,
    allowed: false,
    reasonCategory: userMcpBlockedReasonCategory(decision.reason),
    reasonHash: hashId(decision.reason)
  }
}

function buildDiagnosticsAuditReceipts(input: {
  generatedAt: string
  approvalLedger: ApprovalLedgerRecord[]
  workspaceChanges: WorkspaceChangeSet[]
  messageFeedbackReceipts: MessageFeedbackReceipt[]
  externalPublishReceipts: ExternalPublishReceipt[]
  auditRetentionPurgeReceipts: AuditRetentionPurgeReceipt[]
  userMcpBlockedServers: UserMcpLaunchPolicyDecision[]
}) {
  const messageFeedback = input.messageFeedbackReceipts.map(
    summarizeMessageFeedbackReceiptForDiagnostics
  )
  const externalPublish = input.externalPublishReceipts.map(
    summarizeExternalPublishReceiptForDiagnostics
  )
  const auditRetentionPurges = input.auditRetentionPurgeReceipts.map(
    summarizeAuditRetentionPurgeReceiptForDiagnostics
  )
  const userMcpBlockedServers = input.userMcpBlockedServers.map(
    summarizeUserMcpBlockedServerForDiagnostics
  )
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    redactionMode: 'default',
    counts: {
      approvalLedger: input.approvalLedger.length,
      workspaceChanges: input.workspaceChanges.length,
      messageFeedback: input.messageFeedbackReceipts.length,
      externalPublish: input.externalPublishReceipts.length,
      auditRetentionPurges: input.auditRetentionPurgeReceipts.length,
      userMcpBlockedServers: input.userMcpBlockedServers.length
    },
    hashes: {
      approvalLedger: diagnosticsSha256(input.approvalLedger),
      workspaceChanges: diagnosticsSha256(input.workspaceChanges),
      messageFeedback: diagnosticsSha256(messageFeedback),
      externalPublish: diagnosticsSha256(externalPublish),
      auditRetentionPurges: diagnosticsSha256(auditRetentionPurges),
      userMcpBlockedServers: diagnosticsSha256(userMcpBlockedServers)
    },
    recent: {
      messageFeedback: messageFeedback.slice(-MAX_DIAGNOSTIC_RECORDS),
      externalPublish: externalPublish.slice(-MAX_DIAGNOSTIC_RECORDS),
      auditRetentionPurges: auditRetentionPurges.slice(-MAX_DIAGNOSTIC_RECORDS),
      userMcpBlockedServers: userMcpBlockedServers.slice(-MAX_DIAGNOSTIC_RECORDS)
    },
    validation: {
      sensitiveFeedbackNotes: 'redacted',
      runEventHashChains: 'not_included_in_diagnostics_export'
    }
  } as const
}

function hashId(value: unknown): string | undefined {
  return typeof value === 'string' && value ? diagnosticsSha256(value) : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function permissionPosture(value: unknown): Record<string, unknown> | undefined {
  const record = objectValue(value)
  const postureHash = record?.postureHash
  return typeof postureHash === 'string' && postureHash ? record : undefined
}

function permissionPostureFromApproval(record: ApprovalLedgerRecord): Record<string, unknown> | undefined {
  return permissionPosture(record.metadata?.permissionPosture)
}

function permissionPostureFromRunEvent(record: RunEventRecord): Record<string, unknown> | undefined {
  const payload = objectValue(record.payload)
  return permissionPosture(payload?.permissionPosture)
}

function summarizePermissionPostureForAuditBundle(
  posture: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!posture) return undefined
  return {
    postureHash: posture.postureHash,
    signaturePresent: posture.signaturePresent === true,
    approvalMode: typeof posture.approvalMode === 'string' ? posture.approvalMode : undefined,
    workflowMode: typeof posture.workflowMode === 'string' ? posture.workflowMode : undefined,
    presetId: typeof posture.presetId === 'string' ? posture.presetId : undefined,
    readOnly: typeof posture.readOnly === 'boolean' ? posture.readOnly : undefined,
    networkAccess: typeof posture.networkAccess === 'string' ? posture.networkAccess : undefined,
    externalPathGrantCount:
      typeof posture.externalPathGrantCount === 'number' ? posture.externalPathGrantCount : 0,
    workspaceGrantServiceCount: Array.isArray(posture.workspaceGrantServiceIds)
      ? posture.workspaceGrantServiceIds.length
      : 0,
    promptHash: objectValue(posture.context)?.promptHash
  }
}

function summarizeApprovalLedgerRecordForAuditBundle(
  record: ApprovalLedgerRecord
): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    idHash: hashId(record.id),
    approvalIdHash: hashId(record.approvalId),
    provider: record.provider,
    service: record.service,
    method: record.method,
    status: record.status,
    decision: record.decision,
    decisionSource: record.decisionSource,
    grantedScope: record.grantedScope,
    requestedAt: record.requestedAt,
    respondedAt: record.respondedAt,
    expirationMode: record.expiration?.mode,
    runIdHash: hashId(record.runId),
    chatIdHash: hashId(record.chatId),
    workspaceIdHash: hashId(record.workspaceId),
    hasWorkspacePath: Boolean(record.workspacePath),
    hasBody: Boolean(record.body),
    hasPreview: record.preview !== undefined,
    hasParams: record.params !== undefined,
    permissionPosture: summarizePermissionPostureForAuditBundle(permissionPostureFromApproval(record))
  }
}

function summarizeRunEventReplayForAuditBundle(
  runId: string,
  events: RunEventRecord[]
): Record<string, unknown> {
  const replay = createRunEventReplay(runId, events)
  return {
    runIdHash: hashId(runId),
    count: replay.count,
    lastSequence: replay.lastSequence,
    hashHead: replay.hashHead,
    hashChainValid: replay.hashChainValid,
    countsByKind: replay.countsByKind,
    approvalIdHashes: replay.approvalIds.map((id) => hashId(id)),
    startedAt: replay.startedAt,
    endedAt: replay.endedAt,
    timeline: replay.timeline.map((event) => ({
      sequence: event.sequence,
      timestamp: event.timestamp,
      kind: event.kind,
      phase: event.phase,
      source: event.source,
      hasSummary: Boolean(event.summary),
      summaryHash: hashId(event.summary),
      spanIdHash: hashId(event.spanId),
      parentSpanIdHash: hashId(event.parentSpanId),
      toolCallIdHash: hashId(event.toolCallId),
      approvalIdHash: hashId(event.approvalId),
      hasCommitSha: Boolean(event.commitSha),
      hasExternalUrl: Boolean(event.externalUrl),
      artifactCount: event.artifactIds?.length || 0,
      hash: event.hash
    }))
  }
}

function summarizeWorkspaceChangeForAuditBundle(change: WorkspaceChangeSet): Record<string, unknown> {
  return {
    schemaVersion: change.schemaVersion,
    idHash: hashId(change.id),
    source: change.source,
    status: change.status,
    titleHash: hashId(change.title),
    hasSummary: Boolean(change.summary),
    summaryHash: hashId(change.summary),
    workspaceIdHash: hashId(change.workspaceId),
    hasWorkspacePath: Boolean(change.workspacePath),
    chatIdHash: hashId(change.chatId),
    runIdHash: hashId(change.runId),
    provider: change.provider,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    fileCount: change.files.length,
    artifactCount: change.artifacts.length,
    stats: change.stats,
    files: change.files.map((file) => ({
      pathHash: hashId(file.path),
      origin: file.origin,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.isBinary
    }))
  }
}

function summarizeAuditRunForAuditBundle(run: AuditRunRecord): Record<string, unknown> {
  return {
    schemaVersion: run.schemaVersion,
    idHash: hashId(run.id),
    mode: run.mode,
    status: run.status,
    chatIdHash: hashId(run.chatId),
    workspaceIdHash: hashId(run.workspaceId),
    hasWorkspacePath: Boolean(run.workspacePath),
    phaseCount: run.phases.length,
    dimensionsCount: run.dimensions.length,
    participantCount: run.participants.length,
    findingCount: run.findings.length,
    verdictCount: run.verdicts.length,
    gateCount: run.gates.length,
    gateStatuses: run.gates.reduce<Record<string, number>>((counts, gate) => {
      counts[gate.status] = (counts[gate.status] || 0) + 1
      return counts
    }, {}),
    budget: run.budget,
    coverage: run.coverage,
    hasReport: Boolean(run.report),
    reportHash: hashId(run.report),
    hasError: Boolean(run.error),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt
  }
}

function summarizeEvidencePackForAuditBundle(pack: EvidencePackRecord): Record<string, unknown> {
  return {
    schemaVersion: pack.schemaVersion,
    idHash: hashId(pack.id),
    workspaceIdHash: hashId(pack.workspaceId),
    hasWorkspacePath: Boolean(pack.workspacePath),
    runIdHash: hashId(pack.runId),
    chatIdHash: hashId(pack.chatId),
    provider: pack.provider,
    capabilityCellCount: pack.capabilityCells.length,
    completionClaimCount: pack.completionClaims.length,
    diffTouchedFileCount: pack.diffTouchedFiles?.length || 0,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt
  }
}

function summarizeCapabilityLedgerForAuditBundle(
  snapshot: CapabilityLedgerSnapshot | undefined
): Array<Record<string, unknown>> {
  if (!snapshot) return []
  return snapshot.cells.map((cell) => ({
    capabilityKeyHash: hashId(cell.capabilityKey),
    titleHash: hashId(cell.title),
    status: cell.status,
    evidenceRefCount: cell.evidenceRefs.length,
    hasValidationCommand: Boolean(cell.validationCommand),
    unsupportedClaimCount: cell.unsupportedClaims?.length || 0,
    latestEvidencePackIdHash: hashId(cell.latestEvidencePackId),
    latestRunIdHash: hashId(cell.latestRunId),
    updatedAt: cell.updatedAt
  }))
}

function summarizeMessageFeedbackReceiptForAuditBundle(
  receipt: MessageFeedbackReceipt
): Record<string, unknown> {
  return summarizeMessageFeedbackReceiptForDiagnostics(receipt)
}

function summarizeExternalPublishReceiptForAuditBundle(
  receipt: ExternalPublishReceipt
): Record<string, unknown> {
  return {
    schemaVersion: receipt.schemaVersion,
    idHash: hashId(receipt.id),
    origin: receipt.origin,
    action: receipt.action,
    decision: receipt.decision,
    requestedAt: receipt.requestedAt,
    completedAt: receipt.completedAt,
    outcome: receipt.outcome,
    workspaceIdHash: hashId(receipt.workspaceId),
    hasWorkspacePath: Boolean(receipt.workspacePath),
    hasRepoPath: Boolean(receipt.repoPath),
    remoteHash: hashId(receipt.remote),
    setUpstream: receipt.setUpstream,
    hasTitle: Boolean(receipt.title),
    titleHash: hashId(receipt.title),
    draft: receipt.draft,
    hasCommitSha: Boolean(receipt.commitSha),
    hasPrUrl: Boolean(receipt.prUrl),
    prUrlHash: hashId(receipt.prUrl),
    hasError: Boolean(receipt.error),
    hasMetadata: Boolean(receipt.metadata && Object.keys(receipt.metadata).length > 0)
  }
}

function parseBuilderValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}:\\s*([^\\n]+)`))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
}

function parseScriptEnvDefault(script: string | undefined, envName: string): string | undefined {
  if (!script) return undefined
  const defaultMatch = script.match(new RegExp(`${envName}=\\$\\{${envName}:-([^}\\s]+)\\}`))
  if (defaultMatch?.[1]) return defaultMatch[1]
  const directMatch = script.match(new RegExp(`${envName}=([^\\s]+)`))
  return directMatch?.[1]?.replace(/^['"]|['"]$/g, '')
}

function builderConfigIncludes(text: string | undefined, pattern: RegExp): boolean {
  return Boolean(text && pattern.test(text))
}

function listStatusChecks(checks: ProductHealthCheck[]): ProductOperationStatus {
  return normalizeStatus(checks.map((check) => check.status))
}

function buildArchitectureCompatibilityStatus(
  compatibility: UpdateArchitectureCompatibility | undefined,
  checkedAt: string
): ProductArchitectureCompatibilityStatus | undefined {
  if (!compatibility) return undefined
  const status: ProductOperationStatus = !compatibility.compatible
    ? 'error'
    : compatibility.artifactArch === 'unknown'
      ? 'warning'
      : 'ok'
  const target = `${compatibility.platform}-${compatibility.arch}`
  const artifact = compatibility.artifactName || 'unknown update artifact'
  const message = !compatibility.compatible
    ? compatibility.reason || `Update artifact ${artifact} is incompatible with ${target}.`
    : compatibility.artifactArch === 'unknown'
      ? compatibility.reason || `Update artifact architecture is unknown for ${artifact}.`
      : `Update artifact ${artifact} is compatible with ${target}.`
  return {
    checkedAt,
    status,
    hostPlatform: compatibility.platform,
    hostArch: compatibility.arch,
    ...(compatibility.artifactName ? { updateArtifactName: compatibility.artifactName } : {}),
    updateArtifactArch: compatibility.artifactArch,
    updateCompatible: compatibility.compatible,
    ...(compatibility.reason ? { reason: compatibility.reason } : {}),
    message
  }
}

export function redactProductOperationsText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) =>
      text.replace(pattern, (_match, prefix) => {
        return typeof prefix === 'string' && prefix ? `${prefix}[redacted]` : '[redacted]'
      }),
    value
  )
}

export function createProductCrashRecord(
  input: ProductCrashInput,
  context: { appVersion: string; platform: string; arch: string; now?: string }
): ProductCrashRecord {
  return {
    schemaVersion: 1,
    id: input.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    source: input.source || 'unknown',
    severity: input.severity || 'error',
    occurredAt: input.occurredAt || context.now || new Date().toISOString(),
    appVersion: input.appVersion || context.appVersion,
    platform: input.platform || context.platform,
    arch: input.arch || context.arch,
    ...(input.processType ? { processType: boundedText(input.processType, 240) } : {}),
    ...(input.reason ? { reason: boundedText(input.reason, 500) } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.name ? { name: boundedText(input.name, 240) } : {}),
    message: boundedText(input.message || input.reason || 'Unknown product operation failure.'),
    ...(input.stack ? { stack: boundedText(input.stack) } : {}),
    ...(input.metadata
      ? { metadata: sanitizeDiagnosticsValue(input.metadata) as Record<string, unknown> }
      : {})
  }
}

export function filterProductCrashRecords(
  records: ProductCrashRecord[],
  filter: ProductCrashFilter = {}
): ProductCrashRecord[] {
  const sinceMs = filter.since ? new Date(filter.since).getTime() : Number.NaN
  const limit = Number.isFinite(filter.limit)
    ? Math.max(0, Math.trunc(Number(filter.limit)))
    : undefined
  const filtered = records
    .filter((record) => {
      if (filter.source && record.source !== filter.source) return false
      if (filter.severity && record.severity !== filter.severity) return false
      if (Number.isFinite(sinceMs) && new Date(record.occurredAt).getTime() < sinceMs) return false
      return true
    })
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
  return limit === undefined ? filtered : filtered.slice(0, limit)
}

export function createBridgeHealthRecord(
  status: GeminiMcpBridgeStatus | null | undefined,
  checkedAt = new Date().toISOString()
): ProductBridgeHealthRecord {
  if (!status) {
    return {
      provider: 'gemini',
      bridgeId: 'taskwraith',
      label: 'TaskWraith MCP bridge',
      status: 'unknown',
      checkedAt,
      enabled: false,
      installed: false,
      available: false,
      message: 'TaskWraith MCP bridge status has not been checked yet.'
    }
  }

  const health: ProductOperationStatus = status.enabled
    ? status.available
      ? 'ok'
      : 'warning'
    : status.installed && !status.available
      ? 'warning'
      : 'ok'

  return {
    provider: 'gemini',
    bridgeId: status.serverName || 'taskwraith',
    label: 'TaskWraith MCP bridge',
    status: health,
    checkedAt: status.checkedAt || checkedAt,
    enabled: Boolean(status.enabled),
    installed: Boolean(status.installed),
    available: Boolean(status.available),
    message:
      status.message ||
      status.error ||
      (status.available ? 'Bridge is available.' : 'Bridge is unavailable.'),
    rawStatus: status
  }
}

export function buildInstallRepairStatus(input: {
  appPath: string
  userDataPath: string
  now?: string
  userDataExists: boolean
  geminiBridgeStatus?: GeminiMcpBridgeStatus | null
}): ProductInstallRepairStatus {
  const checkedAt = input.now || new Date().toISOString()
  const bridgeStatus = input.geminiBridgeStatus
  const checks: ProductHealthCheck[] = [
    {
      id: 'user-data-directory',
      label: 'User data directory',
      status: input.userDataExists ? 'ok' : 'error',
      message: input.userDataExists
        ? `Writable app data directory is present at ${input.userDataPath}.`
        : `App data directory is missing or not writable at ${input.userDataPath}.`,
      repairAction: input.userDataExists ? 'none' : 'create_user_data_dir',
      checkedAt
    },
    {
      id: 'gemini-mcp-bridge',
      label: 'TaskWraith MCP bridge',
      status: bridgeStatus?.enabled ? (bridgeStatus.available ? 'ok' : 'warning') : 'ok',
      message: bridgeStatus?.enabled
        ? bridgeStatus.message || 'TaskWraith MCP bridge is enabled.'
        : 'TaskWraith MCP bridge is disabled by settings.',
      repairAction:
        bridgeStatus?.enabled && !bridgeStatus.available ? 'install_gemini_bridge' : 'none',
      checkedAt
    }
  ]

  return {
    checkedAt,
    status: listStatusChecks(checks),
    appPath: input.appPath,
    userDataPath: input.userDataPath,
    checks
  }
}

export function buildReleaseAutomationStatus(input: {
  now?: string
  updateChannel: ProductUpdateChannel
  packageJson?: { scripts?: Record<string, string>; version?: string; name?: string }
  builderConfigText?: string
  env?: Record<string, string | undefined>
  updateArchitecture?: UpdateArchitectureCompatibility
}): ProductReleaseAutomationStatus {
  const checkedAt = input.now || new Date().toISOString()
  const scripts = input.packageJson?.scripts || {}
  const buildScript = scripts.build
  const testScript = scripts.test
  const ciScript = scripts.ci
  const buildUnpackScript = scripts['build:unpack']
  const buildMacScript = scripts['build:mac']
  const buildMacNotarizedScript = scripts['build:mac:notarized']
  const buildWinScript = scripts['build:win']
  const buildWinUnpackScript = scripts['build:win:unpack']
  const buildWinSignedScript = scripts['build:win:signed']
  const debugScript = scripts['build:debug:mac']
  const debugNotarizedScript = scripts['build:debug:mac:notarized']
  const debugWinScript = scripts['build:debug:win']
  const notarizedScript = buildMacNotarizedScript || debugNotarizedScript
  const smokeNodePtyScript = scripts['smoke:node-pty']
  const smokePackageScript = scripts['smoke:package']
  const validateReleaseScript = scripts['validate:release']
  const validateMacUpdateFeedScript = scripts['validate:mac-update-feed']
  const validateWinUpdateFeedScript = scripts['validate:win-update-feed']
  const notarizedScriptName = buildMacNotarizedScript
    ? 'build:mac:notarized'
    : debugNotarizedScript
      ? 'build:debug:mac:notarized'
      : undefined
  const appId = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'appId')
    : undefined
  const productName = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'productName')
    : undefined
  const outputDirectory = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'output')
    : undefined
  const publishProvider = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'provider')
    : undefined
  const publishOwner = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'owner')
    : undefined
  const publishRepo = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'repo')
    : undefined
  const publishUrl = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'url')
    : undefined
  const afterPack = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'afterPack')
    : undefined
  const npmRebuild = input.builderConfigText
    ? parseBuilderValue(input.builderConfigText, 'npmRebuild')
    : undefined
  const hasNodePtyAsarUnpack = builderConfigIncludes(
    input.builderConfigText,
    /asarUnpack:[\s\S]*node_modules\/node-pty\/\*\*/
  )
  const env = input.env || {}
  const keychainProfile =
    env.APPLE_KEYCHAIN_PROFILE || parseScriptEnvDefault(notarizedScript, 'APPLE_KEYCHAIN_PROFILE')
  const signingIdentity =
    env.CSC_NAME || parseScriptEnvDefault(notarizedScript || debugScript, 'CSC_NAME')
  const windowsSigningConfigured = Boolean(
    buildWinSignedScript &&
      ((env.CSC_LINK && env.CSC_KEY_PASSWORD) ||
        (env.WINDOWS_CSC_LINK && env.WINDOWS_CSC_KEY_PASSWORD) ||
        buildWinSignedScript.includes('require-windows-signing-env'))
  )
  const hasNotarizeToggle = Boolean(notarizedScript?.includes('-c.mac.notarize=true'))
  const notarizationConfigured = Boolean(notarizedScript && hasNotarizeToggle && keychainProfile)
  const signingConfigured = Boolean(
    (notarizedScript || debugScript)?.includes('CSC_NAME=') ||
      signingIdentity ||
      windowsSigningConfigured
  )
  const nativeModulesConfigured = Boolean(
    smokeNodePtyScript &&
    smokePackageScript &&
    afterPack?.includes('validate-native-modules') &&
    hasNodePtyAsarUnpack &&
    npmRebuild === 'true'
  )
  const updateDistributionConfigured =
    publishProvider === 'github'
      ? Boolean(publishOwner && publishRepo)
      : publishProvider === 'generic'
        ? Boolean(publishUrl && !/example\.com/i.test(publishUrl))
        : Boolean(publishProvider)
  const architectureCompatibility = buildArchitectureCompatibilityStatus(
    input.updateArchitecture,
    checkedAt
  )
  const releaseSteps = [
    'npm run ci',
    'npm run build:unpack',
    'npm run build:mac:notarized',
    'npm run build:win:signed',
    'Verify packaged smoke/native module validation output',
    'Verify mac and Windows update feed compatibility',
    `Publish ${input.updateChannel} update artifacts`
  ]
  const statuses: ProductOperationStatus[] = [
    buildScript ? 'ok' : 'warning',
    testScript ? 'ok' : 'warning',
    ciScript ? 'ok' : 'warning',
    buildUnpackScript ? 'ok' : 'warning',
    buildWinScript && buildWinUnpackScript && buildWinSignedScript ? 'ok' : 'warning',
    smokeNodePtyScript && smokePackageScript ? 'ok' : 'warning',
    debugScript && debugWinScript ? 'ok' : 'warning',
    notarizationConfigured ? 'ok' : 'warning',
    signingConfigured ? 'ok' : 'warning',
    appId && productName ? 'ok' : 'warning',
    nativeModulesConfigured ? 'ok' : 'warning',
    validateMacUpdateFeedScript && validateWinUpdateFeedScript ? 'ok' : 'warning',
    updateDistributionConfigured ? 'ok' : 'warning',
    architectureCompatibility?.status || 'ok'
  ]

  return {
    checkedAt,
    status: normalizeStatus(statuses),
    updateChannel: input.updateChannel,
    appId,
    productName,
    outputDirectory,
    scripts: {
      build: buildScript,
      test: testScript,
      ci: ciScript,
      buildUnpack: buildUnpackScript,
      buildMac: buildMacScript,
      buildMacNotarized: buildMacNotarizedScript,
      buildDebugMac: debugScript,
      buildDebugMacNotarized: debugNotarizedScript,
      buildWin: buildWinScript,
      buildWinUnpack: buildWinUnpackScript,
      buildWinSigned: buildWinSignedScript,
      buildDebugWin: debugWinScript,
      smokeNodePty: smokeNodePtyScript,
      smokePackage: smokePackageScript,
      validateRelease: validateReleaseScript,
      validateMacUpdateFeed: validateMacUpdateFeedScript,
      validateWinUpdateFeed: validateWinUpdateFeedScript
    },
    nativeModules: {
      configured: nativeModulesConfigured,
      ...(afterPack ? { validationScript: afterPack } : {}),
      message: nativeModulesConfigured
        ? 'node-pty is rebuilt, unpacked, and validated during packaging.'
        : 'node-pty rebuild/unpack validation is incomplete.'
    },
    updateDistribution: {
      configured: updateDistributionConfigured,
      ...(publishProvider ? { provider: publishProvider } : {}),
      ...(publishOwner ? { owner: publishOwner } : {}),
      ...(publishRepo ? { repo: publishRepo } : {}),
      ...(publishUrl ? { url: publishUrl } : {}),
      message: updateDistributionConfigured
        ? publishProvider === 'github'
          ? `Updates are published through GitHub releases for ${publishOwner}/${publishRepo}.`
          : `Updates are published through ${publishProvider}.`
        : 'No real update publishing target was detected.'
    },
    notarization: {
      configured: notarizationConfigured,
      ...(keychainProfile ? { keychainProfile } : {}),
      ...(notarizedScriptName ? { scriptName: notarizedScriptName } : {}),
      message: notarizationConfigured
        ? `Notarized macOS build script is configured with keychain profile ${keychainProfile}.`
        : 'No complete notarized macOS build script/keychain profile was detected.'
    },
    signing: {
      configured: signingConfigured,
      ...(signingIdentity ? { identity: signingIdentity } : {}),
      message: signingConfigured
        ? windowsSigningConfigured
          ? 'Windows signing is configured through build:win:signed and signing secrets/environment.'
          : 'Codesigning identity is configured through the debug build scripts or environment.'
        : 'Codesigning identity was not detected in scripts or environment.'
    },
    ...(architectureCompatibility ? { architectureCompatibility } : {}),
    releaseSteps
  }
}

export function buildProductOperationsStatus(input: {
  now?: string
  updateChannel: ProductUpdateChannel
  appName: string
  appVersion: string
  isPackaged: boolean
  appPath: string
  userDataPath: string
  platform: string
  arch: string
  osRelease: string
  workspaces: WorkspaceRecord[]
  chats: ChatRecord[]
  runQueue: RunQueueJob[]
  runRecovery: RunRecoveryRecord[]
  approvalLedger: ApprovalLedgerRecord[]
  workspaceChanges: WorkspaceChangeSet[]
  scheduledTasks: ScheduledTask[]
  workflows?: WorkflowDefinition[]
  recentCrashes: ProductCrashRecord[]
  geminiBridgeStatus?: GeminiMcpBridgeStatus | null
  userDataExists: boolean
  packageJson?: { scripts?: Record<string, string>; version?: string; name?: string }
  builderConfigText?: string
  env?: Record<string, string | undefined>
  updateArchitecture?: UpdateArchitectureCompatibility
}): ProductOperationsStatus {
  const generatedAt = input.now || new Date().toISOString()
  const bridgeHealth = [createBridgeHealthRecord(input.geminiBridgeStatus, generatedAt)]
  const installRepair = buildInstallRepairStatus({
    appPath: input.appPath,
    userDataPath: input.userDataPath,
    userDataExists: input.userDataExists,
    geminiBridgeStatus: input.geminiBridgeStatus,
    now: generatedAt
  })
  const releaseAutomation = buildReleaseAutomationStatus({
    now: generatedAt,
    updateChannel: input.updateChannel,
    packageJson: input.packageJson,
    builderConfigText: input.builderConfigText,
    env: input.env,
    updateArchitecture: input.updateArchitecture
  })
  const activeRuns = input.runQueue.filter(
    (job) => job.status === 'active' || job.status === 'starting'
  ).length
  const queuedRuns = input.runQueue.filter(
    (job) => job.status === 'queued' || job.status === 'paused'
  ).length
  const overallStatus = normalizeStatus([
    ...bridgeHealth.map((item) => item.status),
    installRepair.status,
    releaseAutomation.status,
    input.recentCrashes.some((crash) => crash.severity === 'fatal')
      ? 'error'
      : input.recentCrashes.length > 0
        ? 'warning'
        : 'ok'
  ])

  return {
    generatedAt,
    updateChannel: input.updateChannel,
    overallStatus,
    app: {
      name: input.appName,
      version: input.appVersion,
      isPackaged: input.isPackaged,
      appPath: input.appPath,
      userDataPath: input.userDataPath
    },
    system: {
      platform: input.platform,
      arch: input.arch,
      osRelease: input.osRelease
    },
    bridgeHealth,
    installRepair,
    releaseAutomation,
    recentCrashes: input.recentCrashes.slice(0, 20),
    counts: {
      workspaces: input.workspaces.length,
      chats: input.chats.length,
      queuedRuns,
      activeRuns,
      interruptedRuns: input.runRecovery.length,
      approvalLedgerRecords: input.approvalLedger.length,
      workspaceChangeSets: input.workspaceChanges.length,
      scheduledTasks: input.scheduledTasks.length,
      workflows: input.workflows?.length
    }
  }
}

function summarizeScheduledTaskForDiagnostics(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    provider: task.provider,
    status: task.status,
    kind: task.kind || 'single',
    selectedModelType: task.selectedModelType,
    approvalMode: task.approvalMode,
    runAt: task.runAt,
    timezone: task.timezone,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    firedAt: task.firedAt,
    completedAt: task.completedAt,
    workflowId: task.workflowId,
    workflowExecutionId: task.workflowExecutionId,
    workflowOccurrenceAt: task.workflowOccurrenceAt,
    hasPrompt: Boolean(task.prompt),
    hasDisplayPrompt: Boolean(task.displayPrompt),
    imageAttachmentCount: task.imageAttachments?.length || 0,
    externalPathGrantCount: task.externalPathGrants?.length || 0,
    hasRuntimeProfile: Boolean(task.runtimeProfileId),
    hasGeminiAuthProfile: Boolean(task.geminiAuthProfileId),
    hasLastError: Boolean(task.lastError)
  }
}

function summarizeWorkflowForDiagnostics(workflow: WorkflowDefinition): Record<string, unknown> {
  return {
    id: workflow.id,
    name: workflow.name,
    workspaceId: workflow.workspaceId,
    enabled: workflow.enabled,
    trigger: workflow.trigger,
    missedRunPolicy: workflow.missedRunPolicy,
    concurrencyPolicy: workflow.concurrencyPolicy,
    limits: workflow.limits,
    nextRunAt: workflow.nextRunAt,
    lastRunAt: workflow.lastRunAt,
    lastCompletedAt: workflow.lastCompletedAt,
    lastStatus: workflow.lastStatus,
    hasLastError: Boolean(workflow.lastError),
    failureStreak: workflow.failureStreak,
    activeExecutionId: workflow.activeExecutionId,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    template: {
      provider: workflow.template.provider,
      selectedModelType: workflow.template.selectedModelType,
      approvalMode: workflow.template.approvalMode,
      sessionTrust: workflow.template.sessionTrust,
      kind: workflow.template.kind || 'single',
      hasPrompt: Boolean(workflow.template.prompt),
      hasDisplayPrompt: Boolean(workflow.template.displayPrompt),
      imageAttachmentCount: workflow.template.imageAttachments?.length || 0,
      externalPathGrantCount: workflow.template.externalPathGrants?.length || 0,
      hasRuntimeProfile: Boolean(workflow.template.runtimeProfileId),
      hasGeminiAuthProfile: Boolean(workflow.template.geminiAuthProfileId)
    },
    history: workflow.history.map((execution) => ({
      id: execution.id,
      status: execution.status,
      plannedFor: execution.plannedFor,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      hasError: Boolean(execution.error)
    }))
  }
}

function summarizeRunQueueRequestForDiagnostics(
  request: RunQueueJob['request'] | undefined
): Record<string, unknown> | undefined {
  if (!request) return undefined
  return {
    scope: request.scope,
    selectedModelType: request.selectedModelType,
    hasCustomModel: Boolean(request.customModel),
    approvalMode: request.approvalMode,
    workflowMode: request.workflowMode,
    sessionTrust: request.sessionTrust,
    imageAttachmentCount: request.imageAttachments?.length || 0,
    externalPathGrantCount: request.externalPathGrants?.length || 0,
    hasPrompt: Boolean(request.prompt),
    promptHash: hashId(request.prompt),
    hasDisplayPrompt: Boolean(request.displayPrompt),
    displayPromptHash: hashId(request.displayPrompt),
    hasDiscordContextSelection: Boolean(request.discordContextSelection),
    hasRuntimeProfile: Boolean(request.runtimeProfileId),
    hasGeminiAuthProfile: Boolean(request.geminiAuthProfileId),
    hasRemoteComposer: Boolean(request.remoteComposer),
    remoteComposer: request.remoteComposer
      ? {
          workspaceIdHash: hashId(request.remoteComposer.workspaceId),
          threadIdHash: hashId(request.remoteComposer.threadId),
          provider: request.remoteComposer.provider,
          approvalMode: request.remoteComposer.approvalMode,
          workflowMode: request.remoteComposer.workflowMode,
          hasModel: Boolean(request.remoteComposer.model),
          reasoningEffort: request.remoteComposer.reasoningEffort,
          claudeReasoningEffort: request.remoteComposer.claudeReasoningEffort,
          contextTurns: request.remoteComposer.contextTurns,
          extraWorkspaceCount: request.remoteComposer.extraWorkspaceIds?.length || 0,
          hasText: Boolean(request.remoteComposer.text),
          textHash: hashId(request.remoteComposer.text)
        }
      : undefined
  }
}

function summarizeRunQueueDispatchReceiptForDiagnostics(
  receipt: RunQueueJob['dispatchReceipt'] | undefined
): Record<string, unknown> | undefined {
  if (!receipt) return undefined
  return {
    schemaVersion: receipt.schemaVersion,
    generatedAt: receipt.generatedAt,
    receiptHash: receipt.receiptHash,
    runId: receipt.runId,
    provider: receipt.provider,
    source: receipt.source,
    scope: receipt.scope,
    workspaceId: receipt.workspaceId,
    chatIdHash: hashId(receipt.chatId),
    ensembleParticipantId: receipt.ensembleParticipantId,
    ensembleLaneId: receipt.ensembleLaneId,
    ensembleRole: receipt.ensembleRole,
    ensembleStageRole: receipt.ensembleStageRole,
    approvalMode: receipt.approvalMode,
    workflowMode: receipt.workflowMode,
    permissionPresetId: receipt.permissionPresetId,
    readOnly: receipt.readOnly,
    permissionPostureHash: receipt.permissionPostureHash,
    permissionPostureSignaturePresent: receipt.permissionPostureSignaturePresent,
    remoteComposer: receipt.remoteComposer
      ? {
          workspaceIdHash: hashId(receipt.remoteComposer.workspaceId),
          threadIdHash: hashId(receipt.remoteComposer.threadId),
          provider: receipt.remoteComposer.provider,
          approvalMode: receipt.remoteComposer.approvalMode,
          workflowMode: receipt.remoteComposer.workflowMode
        }
      : undefined,
    remoteAllowlist: receipt.remoteAllowlist
      ? {
          decision: receipt.remoteAllowlist.decision,
          capability: receipt.remoteAllowlist.capability,
          provider: receipt.remoteAllowlist.provider,
          approvalMode: receipt.remoteAllowlist.approvalMode,
          policyFingerprint: receipt.remoteAllowlist.policyFingerprint,
          evaluatedAt: receipt.remoteAllowlist.evaluatedAt
        }
      : undefined
  }
}

function summarizeRunQueueJobForDiagnostics(job: RunQueueJob): Record<string, unknown> {
  return {
    id: job.id,
    runId: job.runId,
    provider: job.provider,
    ensembleParticipantId: job.ensembleParticipantId,
    ensembleRole: job.ensembleRole,
    ensembleStageRole: job.ensembleStageRole,
    scope: job.scope,
    workspaceId: job.workspaceId,
    hasWorkspacePath: Boolean(job.workspacePath),
    chatIdHash: hashId(job.chatId),
    source: job.source,
    status: job.status,
    priority: job.priority,
    attempt: job.attempt,
    hasPromptPreview: Boolean(job.promptPreview),
    promptPreviewHash: hashId(job.promptPreview),
    request: summarizeRunQueueRequestForDiagnostics(job.request),
    permissionPosture: summarizePermissionPostureForAuditBundle(
      job.permissionPosture as unknown as Record<string, unknown> | undefined
    ),
    dispatchReceipt: summarizeRunQueueDispatchReceiptForDiagnostics(job.dispatchReceipt),
    hasProviderSessionId: Boolean(job.providerSessionId),
    hasProviderRunId: Boolean(job.providerRunId),
    hasProcessCommand: Boolean(job.processCommand),
    hasRuntimeProfile: Boolean(job.runtimeProfileId),
    hasOrphanProcess: Boolean(job.orphanProcess),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    statusReason: job.statusReason,
    hasLastError: Boolean(job.lastError),
    recoveryReason: job.recoveryReason,
    resumeAvailable: job.resumeAvailable
  }
}

function summarizeRunRecoveryRecordForDiagnostics(record: RunRecoveryRecord): Record<string, unknown> {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    runId: record.runId,
    jobId: record.jobId,
    provider: record.provider,
    ensembleParticipantId: record.ensembleParticipantId,
    ensembleRole: record.ensembleRole,
    chatIdHash: hashId(record.chatId),
    workspaceId: record.workspaceId,
    hasWorkspacePath: Boolean(record.workspacePath),
    previousStatus: record.previousStatus,
    recoveredStatus: record.recoveredStatus,
    action: record.action,
    reason: record.reason,
    recoveredAt: record.recoveredAt,
    resumeAvailable: record.resumeAvailable,
    hasResumeHint: Boolean(record.resumeHint),
    process: record.process
      ? {
          checkedAt: record.process.checkedAt,
          alive: record.process.alive,
          detection: record.process.detection,
          action: record.process.action,
          hasCommand: Boolean(record.process.command),
          hasError: Boolean(record.process.errorCode || record.process.errorMessage)
        }
      : undefined,
    jobSnapshot: {
      hasProviderSessionId: Boolean(record.jobSnapshot.providerSessionId),
      hasProviderRunId: Boolean(record.jobSnapshot.providerRunId),
      hasPromptPreview: Boolean(record.jobSnapshot.promptPreview),
      promptPreviewHash: hashId(record.jobSnapshot.promptPreview),
      startedAt: record.jobSnapshot.startedAt,
      updatedAt: record.jobSnapshot.updatedAt,
      hasProcessCommand: Boolean(record.jobSnapshot.processCommand)
    }
  }
}

export function buildDiagnosticsSnapshot(input: {
  status: ProductOperationsStatus
  settings: AppSettings
  workspaces: WorkspaceRecord[]
  runQueue: RunQueueJob[]
  runRecovery: RunRecoveryRecord[]
  scheduledTasks: ScheduledTask[]
  workflows: WorkflowDefinition[]
  approvalLedger: ApprovalLedgerRecord[]
  workspaceChanges: WorkspaceChangeSet[]
  messageFeedbackReceipts?: MessageFeedbackReceipt[]
  externalPublishReceipts?: ExternalPublishReceipt[]
  auditRetentionPurgeReceipts?: AuditRetentionPurgeReceipt[]
  userMcpBlockedServers?: UserMcpLaunchPolicyDecision[]
  managedPolicy?: Record<string, unknown>
  recentCrashes: ProductCrashRecord[]
  now?: string
}): ProductDiagnosticsSnapshot {
  const generatedAt = input.now || new Date().toISOString()
  return sanitizeDiagnosticsValue({
    schemaVersion: 1,
    generatedAt,
    status: input.status,
    settings: {
      activeProvider: input.settings.activeProvider,
      updateChannel: input.settings.updateChannel,
      storeLocalChatHistory: input.settings.storeLocalChatHistory,
      storeRawEvents: input.settings.storeRawEvents,
      agenticServices: input.settings.agenticServices,
      geminiMcpBridgeEnabled: input.settings.geminiMcpBridgeEnabled,
      codexSandboxFallback: input.settings.codexSandboxFallback
    },
    ...(input.managedPolicy
      ? {
          managedPolicy: {
            active: input.managedPolicy.active === true,
            source: input.managedPolicy.source,
            hasOrganizationName: Boolean(input.managedPolicy.organizationName),
            lockedSettings: Array.isArray(input.managedPolicy.lockedSettings)
              ? input.managedPolicy.lockedSettings
              : [],
            enforcedSettings: Array.isArray(input.managedPolicy.enforcedSettings)
              ? input.managedPolicy.enforcedSettings
              : [],
            hasUserMcpLaunchAllowlist: isPlainRecord(input.managedPolicy.userMcpLaunchAllowlist),
            userMcpLaunchAllowlist: isPlainRecord(input.managedPolicy.userMcpLaunchAllowlist)
              ? input.managedPolicy.userMcpLaunchAllowlist
              : undefined,
            errorCount: Array.isArray(input.managedPolicy.errors)
              ? input.managedPolicy.errors.length
              : 0
          }
        }
      : {}),
    workspaces: input.workspaces.slice(0, MAX_DIAGNOSTIC_RECORDS).map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      displayName: workspace.displayName,
      lastOpenedAt: workspace.lastOpenedAt,
      pinned: workspace.pinned
    })),
    runQueue: input.runQueue
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeRunQueueJobForDiagnostics),
    runRecovery: input.runRecovery
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeRunRecoveryRecordForDiagnostics),
    scheduledTasks: input.scheduledTasks
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeScheduledTaskForDiagnostics),
    workflows: input.workflows
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeWorkflowForDiagnostics),
    approvalLedger: input.approvalLedger
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeApprovalLedgerRecordForAuditBundle),
    workspaceChanges: input.workspaceChanges
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeWorkspaceChangeForAuditBundle),
    auditReceipts: buildDiagnosticsAuditReceipts({
      generatedAt,
      approvalLedger: input.approvalLedger,
      workspaceChanges: input.workspaceChanges,
      messageFeedbackReceipts: input.messageFeedbackReceipts || [],
      externalPublishReceipts: input.externalPublishReceipts || [],
      auditRetentionPurgeReceipts: input.auditRetentionPurgeReceipts || [],
      userMcpBlockedServers: input.userMcpBlockedServers || []
    }),
    recentCrashes: input.recentCrashes.slice(0, MAX_DIAGNOSTIC_RECORDS)
  }) as ProductDiagnosticsSnapshot
}

function matchesAuditBundleFilter(
  record: {
    workspaceId?: string
    workspacePath?: string
    chatId?: string
    runId?: string
  },
  filter: ProductAuditBundleFilter = {}
): boolean {
  if (filter.workspaceId && record.workspaceId !== filter.workspaceId) return false
  if (filter.workspacePath && record.workspacePath !== filter.workspacePath) return false
  if (filter.chatId && record.chatId !== filter.chatId) return false
  if (filter.runId && record.runId !== filter.runId) return false
  return true
}

function uniqueRunIds(events: RunEventRecord[]): string[] {
  return Array.from(new Set(events.map((event) => event.runId).filter(Boolean)))
}

export function buildAuditBundleSnapshot(input: {
  approvalLedger: ApprovalLedgerRecord[]
  runEvents: RunEventRecord[]
  workspaceChanges: WorkspaceChangeSet[]
  auditRuns: AuditRunRecord[]
  evidencePacks: EvidencePackRecord[]
  capabilityLedger?: CapabilityLedgerSnapshot
  messageFeedbackReceipts: MessageFeedbackReceipt[]
  externalPublishReceipts: ExternalPublishReceipt[]
  auditRetentionPurgeReceipts?: AuditRetentionPurgeReceipt[]
  userMcpBlockedServers?: UserMcpLaunchPolicyDecision[]
  filter?: ProductAuditBundleFilter
  now?: string
}): ProductAuditBundleSnapshot {
  const generatedAt = input.now || new Date().toISOString()
  const filter = input.filter || {}
  const approvalLedger = input.approvalLedger.filter((record) => matchesAuditBundleFilter(record, filter))
  const runEvents = input.runEvents.filter((event) => matchesAuditBundleFilter(event, filter))
  const workspaceChanges = input.workspaceChanges.filter((change) =>
    matchesAuditBundleFilter(change, filter)
  )
  const auditRuns = input.auditRuns.filter((run) => matchesAuditBundleFilter(run, filter))
  const evidencePacks = input.evidencePacks.filter((pack) => matchesAuditBundleFilter(pack, filter))
  const messageFeedback = input.messageFeedbackReceipts.filter((receipt) =>
    matchesAuditBundleFilter(receipt, filter)
  )
  const externalPublish = input.externalPublishReceipts.filter((receipt) =>
    matchesAuditBundleFilter(receipt, filter)
  )
  const auditRetentionPurges = input.auditRetentionPurgeReceipts || []
  const userMcpBlockedServers = input.userMcpBlockedServers || []
  const runEventReplays = uniqueRunIds(runEvents).map((runId) =>
    summarizeRunEventReplayForAuditBundle(runId, runEvents)
  )
  const capabilityLedger = summarizeCapabilityLedgerForAuditBundle(input.capabilityLedger)
  const sections = {
    approvalLedger: approvalLedger.map(summarizeApprovalLedgerRecordForAuditBundle),
    runEventReplays,
    workspaceChanges: workspaceChanges.map(summarizeWorkspaceChangeForAuditBundle),
    auditRuns: auditRuns.map(summarizeAuditRunForAuditBundle),
    evidencePacks: evidencePacks.map(summarizeEvidencePackForAuditBundle),
    capabilityLedger,
    messageFeedback: messageFeedback.map(summarizeMessageFeedbackReceiptForAuditBundle),
    externalPublish: externalPublish.map(summarizeExternalPublishReceiptForAuditBundle),
    auditRetentionPurges: auditRetentionPurges.map(
      summarizeAuditRetentionPurgeReceiptForDiagnostics
    ),
    userMcpBlockedServers: userMcpBlockedServers.map(
      summarizeUserMcpBlockedServerForDiagnostics
    )
  }
  const runEventChains = runEventReplays.map((replay) => replay.hashChainValid === true)
  const permissionPostureProofs = {
    approvalLedger: approvalLedger.filter((record) => permissionPostureFromApproval(record)).length,
    runEvents: runEvents.filter((event) => permissionPostureFromRunEvent(event)).length,
    auditRuns: 0
  }
  return sanitizeDiagnosticsValue({
    schemaVersion: 1,
    generatedAt,
    manifest: {
      schemaVersion: 1,
      generatedAt,
      redactionMode: 'default',
      filters: filter,
      counts: {
        approvalLedger: approvalLedger.length,
        runEventReplays: runEventReplays.length,
        runEvents: runEvents.length,
        workspaceChanges: workspaceChanges.length,
        auditRuns: auditRuns.length,
        evidencePacks: evidencePacks.length,
        capabilityLedgerEntries: capabilityLedger.length,
        messageFeedback: messageFeedback.length,
        externalPublish: externalPublish.length,
        auditRetentionPurges: auditRetentionPurges.length,
        userMcpBlockedServers: userMcpBlockedServers.length
      },
      hashes: {
        approvalLedger: diagnosticsSha256(sections.approvalLedger),
        runEventReplays: diagnosticsSha256(sections.runEventReplays),
        workspaceChanges: diagnosticsSha256(sections.workspaceChanges),
        auditRuns: diagnosticsSha256(sections.auditRuns),
        evidencePacks: diagnosticsSha256(sections.evidencePacks),
        capabilityLedger: diagnosticsSha256(sections.capabilityLedger),
        messageFeedback: diagnosticsSha256(sections.messageFeedback),
        externalPublish: diagnosticsSha256(sections.externalPublish),
        auditRetentionPurges: diagnosticsSha256(sections.auditRetentionPurges),
        userMcpBlockedServers: diagnosticsSha256(sections.userMcpBlockedServers)
      },
      validation: {
        sensitiveFields: 'redacted',
        tamperEvidence: 'local_hashes_unsigned',
        retention: {
          approvalLedger: 'retained_capped',
          runEvents: 'retained_per_run_files',
          workspaceChanges: 'retained_capped_and_pruned',
          auditRuns: 'retained_capped',
          messageFeedback: 'retained_hard_capped_local',
          externalPublish: 'retained_capped'
        },
        runEventHashChains: {
          checked: runEventChains.length,
          valid: runEventChains.filter(Boolean).length,
          invalid: runEventChains.filter((valid) => !valid).length
        },
        permissionPostureProofs
      }
    },
    sections
  }) as ProductAuditBundleSnapshot
}

export interface AuditBundleSnapshotSigner {
  keyId: string
  publicKeyDerBase64: string
  signedAt?: string
  signPayload: (payload: Buffer) => Buffer
}

export interface ProductAuditBundleSignatureVerification {
  ok: boolean
  signaturePresent: boolean
  payloadHashValid: boolean
  signatureValid: boolean
  sectionHashesValid: boolean
  countsValid: boolean
  keyId?: string
  reason?: string
}

export function signAuditBundleSnapshot(
  snapshot: ProductAuditBundleSnapshot,
  signer: AuditBundleSnapshotSigner
): ProductAuditBundleSnapshot {
  const signedSnapshot = unsignedAuditBundleSnapshotForSignature(snapshot)
  const payload = auditBundleSignaturePayload(signedSnapshot)
  const signature: ProductAuditBundleSignature = {
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId: signer.keyId,
    publicKeyDerBase64: signer.publicKeyDerBase64,
    signedAt: signer.signedAt || new Date().toISOString(),
    payloadHash: sha256Utf8(payload),
    signatureBase64: signer.signPayload(Buffer.from(payload, 'utf8')).toString('base64')
  }
  return sanitizeDiagnosticsValue({
    ...signedSnapshot,
    manifest: {
      ...signedSnapshot.manifest,
      signature
    }
  }) as ProductAuditBundleSnapshot
}

export function verifyAuditBundleSnapshotSignature(
  snapshot: ProductAuditBundleSnapshot
): ProductAuditBundleSignatureVerification {
  const signature = snapshot.manifest.signature
  const countsValid = objectValuesMatch(snapshot.manifest.counts, expectedAuditBundleCounts(snapshot))
  const sectionHashesValid = objectValuesMatch(
    snapshot.manifest.hashes,
    expectedAuditBundleHashes(snapshot)
  )
  if (!signature) {
    return {
      ok: false,
      signaturePresent: false,
      payloadHashValid: false,
      signatureValid: false,
      sectionHashesValid,
      countsValid,
      reason: 'missing_signature'
    }
  }
  if (signature.algorithm !== 'ed25519') {
    return {
      ok: false,
      signaturePresent: true,
      payloadHashValid: false,
      signatureValid: false,
      sectionHashesValid,
      countsValid,
      keyId: signature.keyId,
      reason: 'unsupported_algorithm'
    }
  }
  const payload = auditBundleSignaturePayload(snapshot)
  const payloadHash = sha256Utf8(payload)
  const payloadHashValid = signature.payloadHash === payloadHash
  let signatureValid = false
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(signature.publicKeyDerBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    signatureValid = verifySignature(
      null,
      Buffer.from(payload, 'utf8'),
      publicKey,
      Buffer.from(signature.signatureBase64, 'base64')
    )
  } catch {
    signatureValid = false
  }
  const ok = payloadHashValid && signatureValid && sectionHashesValid && countsValid
  return {
    ok,
    signaturePresent: true,
    payloadHashValid,
    signatureValid,
    sectionHashesValid,
    countsValid,
    keyId: signature.keyId,
    ...(ok ? {} : { reason: 'signature_verification_failed' })
  }
}

export function serializeAuditBundleSnapshot(snapshot: ProductAuditBundleSnapshot): string {
  return `${JSON.stringify(sanitizeDiagnosticsValue(snapshot), null, 2)}\n`
}

export function serializeDiagnosticsSnapshot(snapshot: ProductDiagnosticsSnapshot): string {
  return `${JSON.stringify(sanitizeDiagnosticsValue(snapshot), null, 2)}\n`
}

export function sanitizeDiagnosticsValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return boundedText(value, 40_000)
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnosticsValue)
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const output: Record<string, unknown> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (/(credential|token|secret|password|authorization|cookie|bookmark|encrypted)/i.test(key)) {
      output[key] = '[redacted]'
    } else {
      output[key] = sanitizeDiagnosticsValue(rawValue)
    }
  }
  return output
}
