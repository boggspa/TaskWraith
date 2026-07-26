import { spawn } from 'child_process'
import { delimiter, extname, join } from 'path'
import { cliBinaryNameCandidates, getCliSearchDirs } from './CliSearchDirs'
import { promises as fs } from 'fs'
import os from 'os'
import { GATEWAY_MCP_ADVERTISE_TOOLS } from '../mcp/McpToolProfiles'
import { buildProviderCapabilityContract } from '../ProviderCapabilities'
import { providerLabel } from '../ProviderAdapters'
import { AppStore } from '../store'
import { scrubCliEnv } from '../CliEnvSecurity'
import { approvalModeRank, coerceApprovalMode } from '../RunPermissionPosture'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import { buildUserMcpLaunchServers } from '../UserMcpServers'
import type { ExtensionSecretRef, ExtensionSecretResolution } from '../ExtensionSecretStore'
import type {
  AppSettings,
  AgenticServicePolicy,
  ChatScope,
  GeminiAuthStatus,
  GeminiMcpBridgeStatus,
  EffectiveRunPermissions,
  ProviderCapabilityContract,
  ProviderId,
  RuntimeProfile
} from '../store/types'
import type { RuntimeWorktreeIntent } from '../run/AgentRunTypes'

export const GEMINI_MCP_SERVER_NAME = 'TaskWraith' as const

export interface ResolvedProviderBinary {
  provider: ProviderId
  binaryPath: string | null
  source: 'runtime_profile' | 'settings' | 'path' | 'common' | 'missing'
  error?: string
}

export interface CliSpawnPlan {
  command: string
  args: string[]
  shell: boolean
}

export interface CapturedProcessOutput {
  stdout: string
  stderr: string
  code: number | null
  error?: string
  timedOut: boolean
}

export interface CliProviderRuntimeDependencies {
  env?: Readonly<Record<string, string | undefined>>
  getSettings?: () => AppSettings
  getRuntimeProfiles?: (provider?: ProviderId) => RuntimeProfile[]
  getGeminiAuthStatusSnapshot?: () => Promise<Pick<GeminiAuthStatus, 'authState'> | null>
  getGeminiMcpBridgeStatus?: (options?: {
    autoRepairIfEnabled?: boolean
  }) => Promise<GeminiMcpBridgeStatus>
  getCodexStatusSnapshot?: () => Promise<unknown>
  getCodexMcpStatusSnapshot?: () => Promise<unknown>
  getKimiStatusSnapshot?: () => Promise<Record<string, unknown>>
  resolveExtensionSecretValues?: (refs: ExtensionSecretRef[]) => ExtensionSecretResolution[]
}

export class RuntimeProfileEnvironmentResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeProfileEnvironmentResolutionError'
  }
}

export interface RuntimeProfilePayload {
  provider: ProviderId
  scope: ChatScope
  workspace?: string
  runtimeProfileId?: string
  runtimeProfile?: RuntimeProfile
  runtimeWorktree?: RuntimeWorktreeIntent
  approvalMode?: string
  model?: string | null
  effectivePermissions?: EffectiveRunPermissions
}

function runtimeSettingsFromDeps(deps?: CliProviderRuntimeDependencies): AppSettings {
  return deps?.getSettings ? deps.getSettings() : AppStore.getSettings()
}

function runtimeProfilesFromDeps(
  deps?: CliProviderRuntimeDependencies,
  provider?: ProviderId
): RuntimeProfile[] {
  return deps?.getRuntimeProfiles
    ? deps.getRuntimeProfiles(provider)
    : AppStore.getRuntimeProfiles(provider)
}

export function providerDisplayName(provider: ProviderId): string {
  return providerLabel(provider)
}

export function providerBinaryName(provider: ProviderId): string {
  if (provider === 'kimi') return 'kimi'
  if (provider === 'claude') return 'claude'
  // Managed Path-B launches resolve and spawn the official Cursor CLI.
  if (provider === 'cursor') return 'cursor-agent'
  return provider
}

export function expandHomePath(value?: string | null): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return join(os.homedir(), raw.slice(2))
  return raw
}

export async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

// Extracted to ./CliSearchDirs so electron-free modules (HostToolResolver, and
// through it NativeCapabilities) can use them without importing AppStore.
// Imported (not just re-exported) because this module calls both internally —
// a bare `export ... from` would not bind the names in local scope.
export { cliBinaryNameCandidates, getCliSearchDirs }

export function createCliSpawnPlan(command: string, args: string[]): CliSpawnPlan {
  const ext = extname(command).toLowerCase()
  const shell = process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')
  return { command, args, shell }
}

export function activeRuntimeProfileEnv(
  extra: Record<string, string>,
  deps?: CliProviderRuntimeDependencies
): Record<string, string> | null {
  const rawProfileId = extra.TASKWRAITH_RUNTIME_PROFILE_ID
  if (!rawProfileId) return null
  const profile = runtimeProfilesFromDeps(deps).find((item) => item.id === rawProfileId)
  return profile ? resolveRuntimeProfileEnv(profile, deps) : null
}

const RUNTIME_PROFILE_ENV_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function runtimeProfileEnvSecretRefs(profile: RuntimeProfile): ExtensionSecretRef[] {
  const env = Array.isArray(profile.secretRefs?.env)
    ? Array.from(
        new Set(
          profile.secretRefs.env.filter(
            (key): key is string => typeof key === 'string' && RUNTIME_PROFILE_ENV_REF_RE.test(key)
          )
        )
      ).slice(0, 64)
    : []
  return env.map((fieldName) => ({
    ownerKind: 'runtimeProfile' as const,
    ownerId: profile.id,
    fieldKind: 'env' as const,
    fieldName
  }))
}

export function resolveRuntimeProfileEnv(
  profile: RuntimeProfile,
  deps?: Pick<CliProviderRuntimeDependencies, 'resolveExtensionSecretValues'>
): Record<string, string> {
  const env = { ...(profile.env || {}) }
  const refs = runtimeProfileEnvSecretRefs(profile)
  if (refs.length === 0) return env

  const resolveSecretValues =
    deps?.resolveExtensionSecretValues ||
    ((items: ExtensionSecretRef[]) => AppStore.resolveExtensionSecretValues(items))
  const resolutions = resolveSecretValues(refs)
  refs.forEach((ref, index) => {
    const resolution = resolutions[index]
    const resolvedRef = resolution?.ref
    const matchesRef =
      resolvedRef?.ownerKind === ref.ownerKind &&
      resolvedRef.ownerId === ref.ownerId &&
      resolvedRef.fieldKind === ref.fieldKind &&
      resolvedRef.fieldName === ref.fieldName
    if (resolution?.status !== 'ok' || !matchesRef || typeof resolution.value !== 'string') {
      const status = resolution?.status || 'missing'
      throw new RuntimeProfileEnvironmentResolutionError(
        `Runtime profile ${profile.name || profile.id} cannot launch because encrypted env secret ${ref.fieldName} is ${status}.`
      )
    }
    env[ref.fieldName] = resolution.value
  })
  return env
}

/**
 * Resolve the environment for an opaque provider process from one authority
 * path: inherited host variables, selected runtime-profile env/secret refs,
 * caller-owned route variables, binary-aware PATH, then the shared scrubber.
 *
 * Both direct CLI launches and SDKs that spawn a provider CLI must use this
 * builder. Supplying an SDK `env` replaces the host environment entirely, so a
 * raw `process.env` spread at an SDK call site would bypass both profile
 * resolution and the credential scrubber.
 */
export function createResolvedProviderEnv(
  extra: Record<string, string>,
  binaryPath?: string | null,
  deps?: CliProviderRuntimeDependencies,
  exactRuntimeProfile?: RuntimeProfile | null
): Record<string, string> {
  const inheritedEnv = deps?.env ?? process.env
  if (
    exactRuntimeProfile !== undefined &&
    exactRuntimeProfile !== null &&
    extra.TASKWRAITH_RUNTIME_PROFILE_ID !== exactRuntimeProfile.id
  ) {
    throw new RuntimeProfileEnvironmentResolutionError(
      'The resolved runtime profile does not match the launch environment identity.'
    )
  }
  const runtimeProfileEnv =
    exactRuntimeProfile === undefined
      ? activeRuntimeProfileEnv(extra, deps)
      : exactRuntimeProfile === null
        ? null
        : resolveRuntimeProfileEnv(exactRuntimeProfile, deps)
  return scrubCliEnv({
    ...inheritedEnv,
    PATH: getCliSearchDirs(binaryPath, inheritedEnv).join(delimiter),
    TERM: inheritedEnv.TERM || 'xterm-256color',
    COLORTERM: inheritedEnv.COLORTERM || 'truecolor',
    ...(runtimeProfileEnv || {}),
    ...extra
  })
}

export function createCliEnv(
  extra: Record<string, string>,
  binaryPath?: string | null,
  deps?: CliProviderRuntimeDependencies
): Record<string, string> {
  return createResolvedProviderEnv(extra, binaryPath, deps)
}

/**
 * Exact environment used by one-shot CLI provider dispatch. Keep this builder
 * shared with launch-authority evidence: a seal must bind the process env that
 * is actually handed to spawn, including its per-run routing identity.
 */
export function createCliProviderRunEnv(input: {
  provider: 'claude' | 'kimi' | 'grok' | 'cursor' | 'pi'
  command: string
  appRunId: string | null | undefined
  appChatId: string | null | undefined
  scope: ChatScope
  workspace: string | null | undefined
  runtimeProfileId: string | null | undefined
  auditRun?: boolean
  extraEnv?: Record<string, string>
  deps?: CliProviderRuntimeDependencies
}): Record<string, string> {
  return createCliEnv(
    {
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TASKWRAITH_RUNTIME_PROFILE_ID: input.runtimeProfileId || '',
      TASKWRAITH_PARENT_PROVIDER: input.provider,
      TASKWRAITH_RUN_ID: input.appRunId || '',
      TASKWRAITH_CHAT_ID: input.appChatId || '',
      TASKWRAITH_WORKSPACE_PATH: input.scope === 'global' ? '' : input.workspace || '',
      ...(input.auditRun ? { TASKWRAITH_MCP_AUDIT: '1' } : {}),
      ...(input.extraEnv || {})
    },
    input.command,
    input.deps
  )
}

export function runtimeSettings(base: AppSettings, profile?: RuntimeProfile | null): AppSettings {
  if (!profile?.agenticServices) return base
  return {
    ...base,
    agenticServices: {
      ...(base.agenticServices || {}),
      shellCommands: stricterServicePolicy(
        base.agenticServices?.shellCommands,
        profile.agenticServices.shellCommands
      ),
      fileChanges: stricterServicePolicy(
        base.agenticServices?.fileChanges,
        profile.agenticServices.fileChanges
      ),
      externalPublish: stricterServicePolicy(
        base.agenticServices?.externalPublish,
        profile.agenticServices.externalPublish
      ),
      mcpTools: stricterServicePolicy(
        base.agenticServices?.mcpTools,
        profile.agenticServices.mcpTools
      ),
      subThreadDelegation: stricterServicePolicy(
        base.agenticServices?.subThreadDelegation,
        profile.agenticServices.subThreadDelegation
      ),
      canvasInteraction: stricterServicePolicy(
        base.agenticServices?.canvasInteraction,
        profile.agenticServices.canvasInteraction
      ),
      crossThreadRead: stricterServicePolicy(
        base.agenticServices?.crossThreadRead,
        profile.agenticServices.crossThreadRead
      ),
      threadMessage: stricterServicePolicy(
        base.agenticServices?.threadMessage,
        profile.agenticServices.threadMessage
      ),
      mediaEditing: stricterServicePolicy(
        base.agenticServices?.mediaEditing,
        profile.agenticServices.mediaEditing
      ),
      mediaRecording: stricterServicePolicy(
        base.agenticServices?.mediaRecording,
        profile.agenticServices.mediaRecording
      ),
      canvasEval: stricterServicePolicy(
        base.agenticServices?.canvasEval,
        profile.agenticServices.canvasEval
      ),
      networkAccess:
        base.agenticServices?.networkAccess === 'deny'
          ? 'deny'
          : profile.agenticServices.networkAccess || base.agenticServices?.networkAccess || 'allow'
    }
  }
}

function servicePolicyRank(value: unknown): number {
  if (value === 'deny') return 0
  if (value === 'ask') return 1
  if (value === 'workspace') return 2
  if (value === 'allow') return 3
  return 1
}

function stricterServicePolicy(
  base: AgenticServicePolicy | undefined,
  profile: AgenticServicePolicy | undefined
): AgenticServicePolicy {
  const current = base || 'ask'
  if (profile === undefined) return current
  return servicePolicyRank(profile) <= servicePolicyRank(current) ? profile : current
}

export function resolveRuntimeProfileForPayload(
  payload: RuntimeProfilePayload,
  deps?: CliProviderRuntimeDependencies
): RuntimeProfile | undefined {
  if (!payload.runtimeProfileId) return undefined
  const preparedProfile = payload.runtimeProfile
  if (preparedProfile && preparedProfile.id !== payload.runtimeProfileId) {
    throw new Error(
      `Prepared runtime profile ${preparedProfile.id} does not match ${payload.runtimeProfileId}.`
    )
  }
  const profile =
    preparedProfile ||
    runtimeProfilesFromDeps(deps, payload.provider).find(
      (candidate) => candidate.id === payload.runtimeProfileId
    )
  if (!profile) {
    throw new Error(`Runtime profile was not found: ${payload.runtimeProfileId}`)
  }
  if (profile.provider !== payload.provider) {
    throw new Error(
      `Runtime profile ${profile.name} is for ${profile.provider}, not ${payload.provider}.`
    )
  }
  if (profile.scope === 'workspace' && payload.scope === 'global') {
    throw new Error(
      `Runtime profile ${profile.name} is workspace-scoped and cannot run a global chat.`
    )
  }
  if (profile.workspaceMode === 'container') {
    throw new Error(
      `Runtime profile ${profile.name} uses container execution, which is not enabled in this build yet.`
    )
  }
  return profile
}

export function applyRuntimeProfileToPayload(
  payload: RuntimeProfilePayload,
  deps?: CliProviderRuntimeDependencies
): RuntimeProfilePayload {
  const profile = resolveRuntimeProfileForPayload(payload, deps)
  if (!profile) return payload
  const incomingMode = coerceApprovalMode(payload.approvalMode) ?? 'default'
  payload.runtimeProfile = profile
  if (profile.workspaceMode === 'worktree' && payload.scope === 'workspace') {
    const existing = payload.runtimeWorktree
    const selectedPath = existing?.effectiveWorkspacePath
    payload.runtimeWorktree = {
      requested: true,
      source: existing?.source || 'runtimeProfile',
      profileId: profile.id,
      profileName: profile.name,
      baseWorkspacePath: existing?.baseWorkspacePath || payload.workspace,
      effectiveWorkspacePath: selectedPath,
      status: selectedPath ? 'selected' : 'selection-required'
    }
  }
  if (profile.approvalMode) {
    // SAFETY: a runtime profile must NOT silently LOOSEN an explicit read-only
    // ('plan') seat to write-capable. The builtin profiles carry
    // approvalMode:'default', which otherwise clobbered a user's explicit
    // "Plan / Read-only" composer choice and dropped the read-only posture
    // (observed live: a read-only Grok run went write-capable via
    // builtin:grok:global, so the deny rules + host read-only gate never engaged).
    // A profile MAY still tighten a non-read-only seat (including to 'plan').
    const profileMode = coerceApprovalMode(profile.approvalMode) ?? 'default'
    if (approvalModeRank(profileMode) <= approvalModeRank(incomingMode)) {
      payload.approvalMode = profileMode
    }
  }
  const effectiveMode = coerceApprovalMode(payload.approvalMode) ?? 'default'
  if (
    payload.effectivePermissions &&
    approvalModeRank(effectiveMode) < approvalModeRank(incomingMode)
  ) {
    // A profile-imposed mode cap changes more than the provider argv. The signed
    // service map must describe that same lower-authority posture before the
    // main dispatch wrapper re-signs it; retaining a full-access/workspace-write
    // map under `default` or `plan` would make the signature internally
    // contradictory and could restore auto-allow at the action-time gate.
    payload.effectivePermissions = resolveEffectiveRunPermissions({
      provider: payload.provider,
      workspacePath: payload.scope === 'global' ? undefined : payload.workspace,
      model: payload.model,
      settings: runtimeSettings(runtimeSettingsFromDeps(deps), profile),
      presetId: effectiveMode === 'plan' ? 'read_only' : 'default'
    })
  }
  return payload
}

export async function resolveCliProviderBinary(
  provider: ProviderId,
  runtimeProfile?: RuntimeProfile | null,
  deps?: CliProviderRuntimeDependencies
): Promise<ResolvedProviderBinary> {
  const binaryName = providerBinaryName(provider)
  const settings = runtimeSettingsFromDeps(deps)
  const profilePath = expandHomePath(runtimeProfile?.binaryPath)
  if (profilePath) {
    if (await fileExists(profilePath)) {
      return { provider, binaryPath: profilePath, source: 'runtime_profile' }
    }
    return {
      provider,
      binaryPath: null,
      source: 'runtime_profile',
      error: `Runtime profile ${runtimeProfile?.name || runtimeProfile?.id || ''} binary was not found: ${profilePath}`
    }
  }
  const configured =
    provider === 'claude'
      ? settings.claudeBinaryPath
      : provider === 'kimi'
        ? settings.kimiBinaryPath
        : ''
  const configuredPath = expandHomePath(configured)

  if (configuredPath) {
    if (await fileExists(configuredPath)) {
      return { provider, binaryPath: configuredPath, source: 'settings' }
    }
    return {
      provider,
      binaryPath: null,
      source: 'settings',
      error: `Configured ${providerDisplayName(provider)} binary was not found: ${configuredPath}`
    }
  }

  const binaryCandidates = cliBinaryNameCandidates(binaryName)
  const pathCandidates = getCliSearchDirs().flatMap((entry) =>
    binaryCandidates.map((name) => join(entry, name))
  )
  const commonCandidates = [
    // Grok installs to ~/.grok/bin by default; check it first so the gated
    // Grok runtime resolves even in a limited-PATH (packaged) context.
    ...(provider === 'grok'
      ? binaryCandidates.map((name) => join(os.homedir(), '.grok', 'bin', name))
      : []),
    // Kimi Code (the kimi-cli successor) installs its binary at
    // ~/.kimi-code/bin/kimi and only exposes that dir via a ~/.zshrc PATH
    // export, so a packaged (launchd-PATH) launch never sees it. Mirror the
    // Grok case so Kimi resolves in a limited-PATH context. Resolving the
    // binary is necessary but NOT sufficient: managed execution is ACP-only
    // and still requires exact descriptor-bound runtime admission plus the
    // contained synthetic-cwd/authenticated-gateway launch composition.
    ...(provider === 'kimi'
      ? binaryCandidates.map((name) => join(os.homedir(), '.kimi-code', 'bin', name))
      : []),
    ...binaryCandidates.flatMap((name) => [
      join(os.homedir(), '.local', 'bin', name),
      join(os.homedir(), '.npm-global', 'bin', name),
      join(os.homedir(), '.bun', 'bin', name),
      join(os.homedir(), '.cargo', 'bin', name),
      join('/opt/homebrew/bin', name),
      join('/usr/local/bin', name)
    ])
  ]
  const seen = new Set<string>()
  for (const candidate of [...pathCandidates, ...commonCandidates]) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (await fileExists(candidate)) {
      return {
        provider,
        binaryPath: candidate,
        source: pathCandidates.includes(candidate) ? 'path' : 'common'
      }
    }
  }

  return {
    provider,
    binaryPath: null,
    source: 'missing',
    error: `${providerDisplayName(provider)} CLI was not found on PATH or common local install locations.`
  }
}

export function captureProcessOutput(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 8_000,
  deps?: CliProviderRuntimeDependencies,
  extraEnv: Record<string, string> = {}
): Promise<CapturedProcessOutput> {
  return new Promise((resolveCapture) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const plan = createCliSpawnPlan(command, args)
    const child = spawn(plan.command, plan.args, {
      cwd,
      shell: plan.shell,
      env: createCliEnv({ FORCE_COLOR: '0', NO_COLOR: '1', ...extraEnv }, command, deps)
    })
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolveCapture({ stdout, stderr, code: null, timedOut: true, error: 'Timed out.' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 80_000) stdout = stdout.slice(-80_000)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 80_000) stderr = stderr.slice(-80_000)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveCapture({ stdout, stderr, code: null, timedOut: false, error: error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveCapture({ stdout, stderr, code, timedOut: false })
    })
  })
}

export async function readResolvedCliVersion(
  resolved: ResolvedProviderBinary,
  deps?: CliProviderRuntimeDependencies,
  extraEnv: Record<string, string> = {}
): Promise<string> {
  if (!resolved.binaryPath) return 'missing'
  const output = await captureProcessOutput(
    resolved.binaryPath,
    ['--version'],
    undefined,
    8_000,
    deps,
    extraEnv
  )
  return (
    (output.stdout || output.stderr || output.error || 'unknown').trim().split('\n')[0] || 'unknown'
  )
}

export async function readClaudeAuthState(
  resolved: ResolvedProviderBinary,
  deps?: CliProviderRuntimeDependencies
): Promise<string> {
  if (!resolved.binaryPath) return 'unknown'
  const output = await captureProcessOutput(
    resolved.binaryPath,
    ['auth', 'status'],
    undefined,
    8_000,
    deps
  )
  if (output.code === 0) return 'authenticated'
  const combined = (output.stdout + output.stderr).toLowerCase()
  if (
    combined.includes('not logged') ||
    combined.includes('not authenticated') ||
    combined.includes('unauthenticated') ||
    combined.includes('login required') ||
    combined.includes('please log') ||
    combined.includes('api key') ||
    combined.includes('apikey') ||
    combined.includes('not')
  )
    return 'missing'
  return process.env.ANTHROPIC_API_KEY ? 'api-key' : 'unknown'
}

export async function getCliProviderStatus(
  provider: ProviderId,
  deps?: CliProviderRuntimeDependencies
) {
  // Cursor is a normal CLI provider now (no per-build fingerprint gate): it falls
  // through to generic binary resolution + status below. Its run is contained at
  // spawn by the --sandbox argv (runCursorProvider), not a status gate.
  if (provider === 'kimi' && deps?.getKimiStatusSnapshot) {
    return deps.getKimiStatusSnapshot()
  }
  if (provider === 'kimi') {
    // A PATH hit or an independently executed `--version` is not Kimi runtime
    // admission. Production injects getKimiStatusSnapshot from the reviewed
    // descriptor-bound admission seam; generic callers fail closed and start
    // no provider process.
    return {
      provider,
      label: providerDisplayName(provider),
      available: false,
      version: 'admission-required',
      appServer: 'acp-admission-required',
      authState: 'unknown',
      setupRequired: true,
      binaryPath: null,
      binarySource: 'unqualified',
      error: 'Kimi status requires reviewed ACP runtime admission; no Kimi process was started.',
      supportsSessions: false,
      supportsApprovals: false,
      supportsQuota: false,
      supportsMcpStatus: false
    }
  }
  const resolved = await resolveCliProviderBinary(provider, undefined, deps)
  if (!resolved.binaryPath) {
    return {
      provider,
      label: providerDisplayName(provider),
      available: false,
      version: 'missing',
      appServer: 'unsupported',
      authState: 'unknown',
      setupRequired: true,
      binaryPath: null,
      binarySource: resolved.source,
      error: resolved.error
    }
  }

  const geminiAuth =
    provider === 'gemini' && deps?.getGeminiAuthStatusSnapshot
      ? await deps.getGeminiAuthStatusSnapshot().catch(() => null)
      : null
  return {
    provider,
    label: providerDisplayName(provider),
    available: true,
    version: await readResolvedCliVersion(resolved, deps),
    appServer: 'sdk-or-cli',
    authState:
      provider === 'claude'
        ? await readClaudeAuthState(resolved, deps)
        : geminiAuth?.authState || 'unknown',
    setupRequired: false,
    binaryPath: resolved.binaryPath,
    binarySource: resolved.source,
    supportsSessions: true,
    supportsApprovals: false,
    supportsQuota: false,
    supportsMcpStatus: false
  }
}

export function getCliProviderMcpStatus(
  provider: ProviderId,
  deps?: CliProviderRuntimeDependencies
) {
  if (provider === 'cursor') {
    return {
      provider,
      available: false,
      enabled: false,
      source: 'provider-managed',
      serverName: null,
      tools: [],
      sections: [],
      message:
        'Cursor exposes no safe static MCP status probe. Path-B runs keep provider-managed native tools inside the OS sandbox; when setup succeeds, TaskWraith also attaches its governed broker. This status cannot report a particular run’s attachment.'
    }
  }
  const settings = runtimeSettingsFromDeps(deps)
  const bridgeEnabled = Boolean(settings.geminiMcpBridgeEnabled)
  const userMcpServers =
    provider === 'claude' ? buildUserMcpLaunchServers(settings.userMcpServers) : []
  const userServerCount = userMcpServers.length
  const available = bridgeEnabled || userServerCount > 0
  return {
    provider,
    available,
    enabled: available,
    source: bridgeEnabled ? 'bridge' : userServerCount > 0 ? 'provider' : 'bridge',
    serverName:
      bridgeEnabled || userServerCount === 0 ? GEMINI_MCP_SERVER_NAME : 'User MCP servers',
    tools: bridgeEnabled ? [...GATEWAY_MCP_ADVERTISE_TOOLS] : [],
    sections: [],
    message: bridgeEnabled
      ? userServerCount > 0
        ? `TaskWraith registers the ${GEMINI_MCP_SERVER_NAME} MCP bridge plus ${userServerCount} user-managed MCP server${userServerCount === 1 ? '' : 's'} for ${providerDisplayName(provider)} runs at launch. Live provider-side MCP listing is provider-managed and not exposed through a safe structured API.`
        : `TaskWraith registers the ${GEMINI_MCP_SERVER_NAME} MCP bridge for ${providerDisplayName(provider)} runs at launch. Live provider-side MCP listing is provider-managed and not exposed through a safe structured API.`
      : userServerCount > 0
        ? `${userServerCount} user-managed MCP server${userServerCount === 1 ? '' : 's'} will attach to ${providerDisplayName(provider)} runs at launch. The built-in TaskWraith MCP bridge is disabled, so TaskWraith bridge tools are not advertised.`
        : `TaskWraith MCP bridge is disabled for ${providerDisplayName(provider)} runs.`
  }
}

export async function getAgentStatusSnapshotDirect(
  provider: ProviderId,
  deps?: CliProviderRuntimeDependencies
): Promise<unknown> {
  if (provider === 'cursor') {
    // Cursor is a normal CLI provider now: generic status (binary resolution +
    // version + availability), contained at spawn by the --sandbox argv.
    return getCliProviderStatus(provider, deps)
  }
  if (provider === 'codex') {
    if (!deps?.getCodexStatusSnapshot) {
      throw new Error('Codex status snapshot requires app-server runtime dependencies.')
    }
    return deps.getCodexStatusSnapshot()
  }
  if (provider === 'claude' || provider === 'kimi' || provider === 'grok' || provider === 'pi') {
    // Route live local CLIs to generic status instead of the Gemini-shaped
    // snapshot below.
    return getCliProviderStatus(provider, deps)
  }
  const geminiStatus = await getCliProviderStatus('gemini', deps)
  return {
    ...geminiStatus,
    appServer: 'unsupported',
    supportsMcpStatus: false
  }
}

export async function getAgentMcpStatusSnapshotDirect(
  provider: ProviderId,
  deps?: CliProviderRuntimeDependencies
): Promise<unknown> {
  if (provider === 'claude' || provider === 'kimi' || provider === 'cursor') {
    return getCliProviderMcpStatus(provider, deps)
  }
  if (provider !== 'codex') {
    return null
  }
  if (!deps?.getCodexMcpStatusSnapshot) {
    throw new Error('Codex MCP status snapshot requires app-server runtime dependencies.')
  }
  return deps.getCodexMcpStatusSnapshot()
}

export async function getProviderCapabilityContractDirect(
  provider: ProviderId,
  workspacePath?: string,
  approvalMode?: string,
  deps?: CliProviderRuntimeDependencies
): Promise<ProviderCapabilityContract> {
  const settings = runtimeSettingsFromDeps(deps)
  const [status, mcpStatus, geminiBridgeStatus] = await Promise.all([
    getAgentStatusSnapshotDirect(provider, deps).catch((error) => ({
      provider,
      available: false,
      setupRequired: true,
      error: error instanceof Error ? error.message : String(error)
    })),
    getAgentMcpStatusSnapshotDirect(provider, deps).catch((error) => ({
      provider,
      available: false,
      error: error instanceof Error ? error.message : String(error)
    })),
    provider === 'gemini'
      ? deps?.getGeminiMcpBridgeStatus
        ? deps.getGeminiMcpBridgeStatus({ autoRepairIfEnabled: true }).catch(
            (error) =>
              ({
                checkedAt: new Date().toISOString(),
                enabled: Boolean(settings.geminiMcpBridgeEnabled),
                installed: false,
                available: false,
                serverName: GEMINI_MCP_SERVER_NAME,
                error: error instanceof Error ? error.message : String(error),
                message: 'TaskWraith MCP bridge status check failed.'
              }) satisfies GeminiMcpBridgeStatus
          )
        : Promise.resolve({
            checkedAt: new Date().toISOString(),
            enabled: Boolean(settings.geminiMcpBridgeEnabled),
            installed: false,
            available: false,
            serverName: GEMINI_MCP_SERVER_NAME,
            message: 'TaskWraith MCP bridge status dependencies are not wired.'
          } satisfies GeminiMcpBridgeStatus)
      : Promise.resolve(null)
  ])

  return buildProviderCapabilityContract({
    provider,
    settings,
    workspacePath,
    approvalMode,
    status,
    mcpStatus,
    geminiMcpBridgeStatus: geminiBridgeStatus
  })
}
