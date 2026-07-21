import { captureProcessOutput } from '../providers/CliProviderRuntime'
import {
  ScheduledOccurrenceAuthorityRootStore,
  type ScheduledOccurrenceAuthoritySafeStorage
} from '../ScheduledOccurrenceAuthorityRootStore'
import { createScheduledOccurrencePostureVerifier } from '../ScheduledOccurrencePostureAuthority'
import type { RunPermissionPostureContext } from '../RunPermissionPosture'
import { AppStore } from '../store'
import type { EffectiveRunPermissions } from '../store/types'
import type { UnattendedElevationAck } from '../UnattendedPostureGate'
import { ScheduledOccurrenceSealService } from './ScheduledOccurrenceSealService'

/**
 * Stage-2 construction for the first live seal lane. Only Cursor is admitted:
 * its contained argv and inherited environment are both re-derived from the
 * exact provider dispatch helpers. Other providers deliberately remain
 * unsealed until their dispatch-owned evidence can be supplied exactly.
 */
export function createCursorScheduledOccurrenceSealService(input: {
  userDataPath: string
  safeStorage: ScheduledOccurrenceAuthoritySafeStorage
  mainPostureSecret: Buffer | string
  appVersion: string
  canonicalizePath(value: string): string
  signRunPermissionPosture(
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ): string
  resolveUnattendedElevation(taskId: string): { ack: UnattendedElevationAck } | null
}): ScheduledOccurrenceSealService {
  const authorityRoot = new ScheduledOccurrenceAuthorityRootStore({
    userDataPath: input.userDataPath,
    safeStorage: input.safeStorage
  }).loadOrCreate()
  const postureVerifier = createScheduledOccurrencePostureVerifier(input.mainPostureSecret)

  return new ScheduledOccurrenceSealService({
    authorityRoot,
    postureVerifier,
    appVersion: input.appVersion,
    isSoloProviderSealWired: (provider) => provider === 'cursor',
    getSettings: () => AppStore.getSettings(),
    canonicalizePath: input.canonicalizePath,
    signRunPermissionPosture: input.signRunPermissionPosture,
    resolveUnattendedElevation: input.resolveUnattendedElevation,
    getChat: (chatId) => AppStore.getChat(chatId),
    getRuntimeProfile: (id) =>
      AppStore.getRuntimeProfiles().find((profile) => profile.id === id) ?? null,
    getScheduledTask: (taskId) =>
      AppStore.getScheduledTasks().find((task) => task.id === taskId) ?? null,
    persistOccurrenceSeal: (taskId, ownerRunId, occurrenceSeal) => {
      const current = AppStore.getScheduledTasks().find((task) => task.id === taskId)
      if (!current || current.status !== 'running' || current.runId !== ownerRunId) return null
      return AppStore.updateScheduledTask(taskId, { occurrenceSeal })
    },
    // These are unreachable while only Cursor is admitted. Keeping the future
    // service shape explicit makes accidental provider enablement fail closed.
    codexMcpConfig: () => null,
    codexApprovalPolicyForMode: () => 'never',
    codexSandboxPolicyForMode: () => ({}),
    claudeMcpFacts: () => ({ mcpServers: null, allowedTools: null }),
    claudeSdkPackageJsonPath: () => '',
    claudeSdkBundledCliPath: () => '',
    storedClaudeApiKeyConfigured: () => false,
    claudeSpawnEnv: () => ({}),
    grokAcpEnabled: () => false,
    grokMcpServerEntry: () => null,
    kimiAdmission: async () => {
      throw new Error('Kimi scheduled occurrence seals are not wired yet.')
    },
    probeCliVersion: async (binaryPath) => {
      const result = await captureProcessOutput(binaryPath, ['--version'])
      const output = (result.stdout || result.stderr || result.error || '').trim()
      return output ? output.split('\n')[0] : null
    }
  })
}
