import { spawn } from 'child_process'
import { delimiter, dirname, extname, join } from 'path'
import { promises as fs } from 'fs'
import os from 'os'
import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'
import { buildProviderCapabilityContract } from '../ProviderCapabilities'
import { providerLabel } from '../ProviderAdapters'
import { AppStore } from '../store'
import { approvalModeRank, coerceApprovalMode } from '../RunPermissionPosture'
import type {
  AppSettings,
  AgenticServicePolicy,
  ChatScope,
  GeminiAuthStatus,
  GeminiMcpBridgeStatus,
  ProviderCapabilityContract,
  ProviderId,
  RuntimeProfile
} from '../store/types'

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
  getSettings?: () => AppSettings
  getRuntimeProfiles?: (provider?: ProviderId) => RuntimeProfile[]
  getGeminiAuthStatusSnapshot?: () => Promise<Pick<GeminiAuthStatus, 'authState'> | null>
  getGeminiMcpBridgeStatus?: (options?: {
    autoRepairIfEnabled?: boolean
  }) => Promise<GeminiMcpBridgeStatus>
  getCodexStatusSnapshot?: () => Promise<unknown>
  getCodexMcpStatusSnapshot?: () => Promise<unknown>
}

export interface RuntimeProfilePayload {
  provider: ProviderId
  scope: ChatScope
  runtimeProfileId?: string
  runtimeProfile?: RuntimeProfile
  approvalMode?: string
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
  // Cursor's CLI binary is `cursor-agent` (installed to ~/.local/bin); the
  // unconditional ~/.local/bin candidate below resolves it.
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

export function getCliSearchDirs(binaryPath?: string | null): string[] {
  const windowsDirs =
    process.platform === 'win32'
      ? [
          process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '',
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs') : '',
          process.env.USERPROFILE ? join(process.env.USERPROFILE, 'scoop', 'shims') : '',
          process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs') : '',
          process.env.ProgramData ? join(process.env.ProgramData, 'chocolatey', 'bin') : '',
          'C:\\Program Files\\nodejs',
          'C:\\ProgramData\\chocolatey\\bin'
        ]
      : []
  const dirs = [
    binaryPath ? dirname(binaryPath) : '',
    ...(process.env.PATH || '').split(delimiter),
    ...windowsDirs,
    join(os.homedir(), '.local', 'bin'),
    join(os.homedir(), '.npm-global', 'bin'),
    join(os.homedir(), '.bun', 'bin'),
    join(os.homedir(), '.cargo', 'bin'),
    '/opt/homebrew/opt/ripgrep/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/ripgrep/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].filter(Boolean)

  return Array.from(new Set(dirs))
}

export function cliBinaryNameCandidates(binaryName: string): string[] {
  if (process.platform !== 'win32' || extname(binaryName)) {
    return [binaryName]
  }
  const pathExts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  const candidates = [binaryName]
  for (const ext of pathExts) {
    candidates.push(`${binaryName}${ext}`)
  }
  return Array.from(new Set(candidates))
}

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
  return profile?.env || null
}

export function createCliEnv(
  extra: Record<string, string>,
  binaryPath?: string | null,
  deps?: CliProviderRuntimeDependencies
): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    PATH: getCliSearchDirs(binaryPath).join(delimiter),
    TERM: process.env.TERM || 'xterm-256color',
    COLORTERM: process.env.COLORTERM || 'truecolor',
    ...(activeRuntimeProfileEnv(extra, deps) || {}),
    ...extra
  }
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
  const profile = runtimeProfilesFromDeps(deps, payload.provider).find(
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
  payload.runtimeProfile = profile
  if (profile.approvalMode) {
    // SAFETY: a runtime profile must NOT silently LOOSEN an explicit read-only
    // ('plan') seat to write-capable. The builtin profiles carry
    // approvalMode:'default', which otherwise clobbered a user's explicit
    // "Plan / Read-only" composer choice and dropped the read-only posture
    // (observed live: a read-only Grok run went write-capable via
    // builtin:grok:global, so the deny rules + host read-only gate never engaged).
    // A profile MAY still tighten a non-read-only seat (including to 'plan').
    const incomingMode = coerceApprovalMode(payload.approvalMode) ?? 'default'
    const profileMode = coerceApprovalMode(profile.approvalMode) ?? 'default'
    if (approvalModeRank(profileMode) <= approvalModeRank(incomingMode)) {
      payload.approvalMode = profileMode
    }
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
  deps?: CliProviderRuntimeDependencies
): Promise<CapturedProcessOutput> {
  return new Promise((resolveCapture) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const plan = createCliSpawnPlan(command, args)
    const child = spawn(plan.command, plan.args, {
      cwd,
      shell: plan.shell,
      env: createCliEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }, command, deps)
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
  deps?: CliProviderRuntimeDependencies
): Promise<string> {
  if (!resolved.binaryPath) return 'missing'
  const output = await captureProcessOutput(resolved.binaryPath, ['--version'], undefined, 8_000, deps)
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
    appServer: provider === 'kimi' ? 'wire-supported' : 'sdk-or-cli',
    authState:
      provider === 'claude'
        ? await readClaudeAuthState(resolved, deps)
        : geminiAuth?.authState || 'unknown',
    setupRequired: false,
    binaryPath: resolved.binaryPath,
    binarySource: resolved.source,
    supportsSessions: true,
    supportsApprovals: provider === 'kimi',
    supportsQuota: false,
    supportsMcpStatus: false
  }
}

export function getCliProviderMcpStatus(
  provider: ProviderId,
  deps?: CliProviderRuntimeDependencies
) {
  const enabled = runtimeSettingsFromDeps(deps).geminiMcpBridgeEnabled
  return {
    provider,
    available: enabled,
    enabled,
    serverName: GEMINI_MCP_SERVER_NAME,
    tools: enabled ? [...TASKWRAITH_MCP_TOOLS] : [],
    sections: [],
    message: enabled
      ? `TaskWraith registers the ${GEMINI_MCP_SERVER_NAME} MCP bridge for ${providerDisplayName(provider)} runs at launch. Live provider-side MCP listing is provider-managed and not exposed through a safe structured API.`
      : `TaskWraith MCP bridge is disabled for ${providerDisplayName(provider)} runs.`
  }
}

export async function getAgentStatusSnapshotDirect(
  provider: ProviderId,
  deps?: CliProviderRuntimeDependencies
): Promise<unknown> {
  if (provider === 'codex') {
    if (!deps?.getCodexStatusSnapshot) {
      throw new Error('Codex status snapshot requires app-server runtime dependencies.')
    }
    return deps.getCodexStatusSnapshot()
  }
  if (
    provider === 'claude' ||
    provider === 'kimi' ||
    provider === 'grok' ||
    provider === 'cursor'
  ) {
    // Grok and Cursor are local CLI providers; route to the generic CLI
    // status instead of falling through to the Gemini-shaped snapshot below.
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
  if (provider === 'claude' || provider === 'kimi') {
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
