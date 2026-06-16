import type {
  AppSettings,
  ApprovalLedgerRecord,
  GeminiMcpBridgeStatus,
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
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceChangeSet,
  WorkspaceRecord,
  ChatRecord
} from './store/types'
import type { UpdateArchitectureCompatibility } from './UpdateArchitecture'

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
  recentCrashes: ProductCrashRecord[]
  now?: string
}): ProductDiagnosticsSnapshot {
  return sanitizeDiagnosticsValue({
    schemaVersion: 1,
    generatedAt: input.now || new Date().toISOString(),
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
    workspaces: input.workspaces.slice(0, MAX_DIAGNOSTIC_RECORDS).map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
      displayName: workspace.displayName,
      lastOpenedAt: workspace.lastOpenedAt,
      pinned: workspace.pinned
    })),
    runQueue: input.runQueue.slice(0, MAX_DIAGNOSTIC_RECORDS),
    runRecovery: input.runRecovery.slice(0, MAX_DIAGNOSTIC_RECORDS),
    scheduledTasks: input.scheduledTasks
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeScheduledTaskForDiagnostics),
    workflows: input.workflows
      .slice(0, MAX_DIAGNOSTIC_RECORDS)
      .map(summarizeWorkflowForDiagnostics),
    approvalLedger: input.approvalLedger.slice(0, MAX_DIAGNOSTIC_RECORDS),
    workspaceChanges: input.workspaceChanges.slice(0, MAX_DIAGNOSTIC_RECORDS),
    recentCrashes: input.recentCrashes.slice(0, MAX_DIAGNOSTIC_RECORDS)
  }) as ProductDiagnosticsSnapshot
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
