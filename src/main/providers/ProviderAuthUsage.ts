import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import os from 'os'
import { dirname, join } from 'path'
import {
  createBridgeApnsPusher,
  type BridgeApnsPusher
} from '../BridgeApnsPusher'
import {
  hasProviderUsageSnapshotContent,
  normalizeClaudeUsageSnapshot,
  normalizeCodexUsagePayload,
  normalizeKimiUsageSnapshot,
  projectStaleSnapshotForward,
  redactAccountId,
  type NormalizedProviderUsageSnapshot
} from '../ProviderQuotaSnapshots'
import {
  CURSOR_ACCESS_TOKEN_KEY,
  CURSOR_USAGE_ENDPOINT,
  cursorStateDbCandidates,
  loadCursorUsageSnapshot,
  type CursorUsageSnapshot
} from '../cursor/CursorUsage'
import { AppStore } from '../store'
import { looksLikeTailscaleOAuthClientSecret } from '../../shared/tailscaleAuthKey'
import type {
  GeminiAuthProfile,
  GeminiAuthProfileKind,
  GeminiAuthProfileSummary,
  GeminiAuthStatus,
  GeminiOAuthLoginStatus,
  ProviderId
} from '../store/types'

export interface CodexUsageCredential {
  accessToken: string
  accountId: string
  importedAt?: string
  source?: string
}

export interface ResolvedProviderBinary {
  binaryPath?: string
  error?: string
}

export interface GeminiAuthUsageDeps {
  resolveCliProviderBinary: (provider: 'gemini') => Promise<ResolvedProviderBinary>
  readResolvedCliVersion: (resolved: ResolvedProviderBinary) => Promise<string>
  createCliEnv: (
    extra: Record<string, string>,
    binaryPath?: string | null
  ) => Record<string, string>
}

export interface GeminiMcpProfileSettings {
  serverName: string
  command?: string
  args: string[]
  includeTools: string[]
}

export interface GeminiOAuthProfileSettingsOptions {
  includeMcp?: boolean
  mcp?: GeminiMcpProfileSettings
}

export interface ProviderAuthUsageHelpers {
  getGeminiAuthStatusSnapshot: () => Promise<GeminiAuthStatus>
  startGeminiOAuthLogin: (input: unknown) => Promise<GeminiOAuthLoginStatus>
  importCodexUsageCredential: (
    event: IpcMainInvokeEvent,
    requestedPath?: string | null
  ) => Promise<CodexUsageImportResult>
  fetchCodexUsageSnapshot: () => Promise<NormalizedProviderUsageSnapshot>
  fetchGeminiUsageSnapshot: () => Promise<NormalizedProviderUsageSnapshot>
  fetchClaudeUsageSnapshot: () => Promise<NormalizedProviderUsageSnapshot>
  fetchKimiUsageSnapshot: () => Promise<NormalizedProviderUsageSnapshot>
  fetchCursorUsageSnapshot: () => Promise<CursorUsageSnapshot | null>
}

export interface CodexUsageImportResult {
  imported: boolean
  cancelled?: boolean
  accountId?: string | null
  importedAt?: string
  source?: string
  encryptionAvailable?: boolean
  snapshot?: unknown
}

type GeminiOAuthLoginRun = GeminiOAuthLoginStatus & {
  child?: ChildProcess
  output?: string
}

interface ClaudeOAuthCredential {
  accessToken: string
  subscriptionType?: string
  expiresAt?: number
}

let inMemoryCodexUsageCredential: CodexUsageCredential | null = null
const geminiOAuthLoginRuns = new Map<string, GeminiOAuthLoginRun>()

export const DEFAULT_GEMINI_MCP_SERVER_NAME = 'TaskWraith'

export function createProviderAuthUsageHelpers(
  deps: GeminiAuthUsageDeps
): ProviderAuthUsageHelpers {
  return {
    getGeminiAuthStatusSnapshot: () => getGeminiAuthStatusSnapshot(deps),
    startGeminiOAuthLogin: (input) => startGeminiOAuthLogin(input, deps),
    importCodexUsageCredential,
    fetchCodexUsageSnapshot,
    fetchGeminiUsageSnapshot,
    fetchClaudeUsageSnapshot,
    fetchKimiUsageSnapshot,
    fetchCursorUsageSnapshot
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

function expandHomePath(value?: string | null): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return join(os.homedir(), raw.slice(2))
  return raw
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function parseCodexUsageCredential(raw: string, source: string): CodexUsageCredential {
  const parsed = JSON.parse(raw)
  const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : parsed
  const accessToken = String(tokens?.access_token || tokens?.accessToken || '').trim()
  const accountId = String(
    tokens?.account_id || tokens?.accountId || tokens?.accountID || ''
  ).trim()
  if (!accessToken) {
    throw new Error('Codex auth JSON did not contain an access_token.')
  }
  if (!accountId) {
    throw new Error('Codex auth JSON did not contain an account_id.')
  }
  return {
    accessToken,
    accountId,
    importedAt: new Date().toISOString(),
    source
  }
}

export function storedCodexUsageCredential(): CodexUsageCredential | null {
  if (inMemoryCodexUsageCredential) {
    return inMemoryCodexUsageCredential
  }
  const stored = AppStore.getSettings().codexUsageCredential
  if (!stored?.encryptedAccessToken || !stored.accountId || !safeStorage.isEncryptionAvailable()) {
    return null
  }
  try {
    const accessToken = safeStorage
      .decryptString(Buffer.from(stored.encryptedAccessToken, 'base64'))
      .trim()
    if (!accessToken) return null
    return {
      accessToken,
      accountId: stored.accountId,
      importedAt: stored.importedAt,
      source: stored.source
    }
  } catch {
    return null
  }
}

/**
 * Read the CURRENT Codex credential straight from `~/.codex/auth.json` on every
 * call. The Codex CLI rotates that file's access token regularly, so a one-time
 * imported/encrypted copy in settings goes stale within ~days and the usage
 * fetch then 401s — which froze the meters at 0%. Reading live (like Kimi reads
 * ~/.kimi and Gemini reads ~/.gemini) tracks the rotated token automatically.
 * Returns null if the file is absent/unparseable; callers fall back to the
 * stored import.
 */
export async function readCodexUsageCredentialLive(): Promise<CodexUsageCredential | null> {
  try {
    const raw = await fs.readFile(join(os.homedir(), '.codex', 'auth.json'), 'utf8')
    return parseCodexUsageCredential(raw, 'chatgpt-auth-live')
  } catch {
    return null
  }
}

export function encryptApiKey(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  return safeStorage.encryptString(trimmed).toString('base64')
}

export function decryptApiKey(stored?: string | null): string | null {
  if (!stored) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

export function getStoredClaudeApiKey(): string | null {
  return decryptApiKey(AppStore.getSettings().claudeApiKey)
}

export function getStoredKimiApiKey(): string | null {
  return decryptApiKey(AppStore.getSettings().kimiApiKey)
}

export function sanitizeGeminiAuthProfileKind(value: unknown): GeminiAuthProfileKind {
  return value === 'vertex-ai' || value === 'google-oauth' ? value : 'api-key'
}

export function getGeminiAuthProfiles(): GeminiAuthProfile[] {
  const profiles = AppStore.getSettings().geminiAuthProfiles
  return Array.isArray(profiles)
    ? profiles.filter((profile): profile is GeminiAuthProfile =>
        Boolean(profile && typeof profile.id === 'string')
      )
    : []
}

export function geminiAuthProfileDirName(profileId: string): string {
  return profileId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'profile'
}

export function geminiOAuthProfilesRoot(): string {
  return join(app.getPath('userData'), 'gemini-oauth-profiles')
}

export function geminiOAuthProfileHome(profileId: string): string {
  return join(geminiOAuthProfilesRoot(), geminiAuthProfileDirName(profileId), 'home')
}

export function geminiOAuthProfileGeminiDir(profileId: string): string {
  return join(geminiOAuthProfileHome(profileId), '.gemini')
}

export function geminiOAuthProfileSettingsPath(profileId: string): string {
  return join(geminiOAuthProfileGeminiDir(profileId), 'settings.json')
}

export function geminiOAuthProfileCredentialsPath(profileId: string): string {
  return join(geminiOAuthProfileGeminiDir(profileId), 'oauth_creds.json')
}

export function geminiOAuthProfileAccountsPath(profileId: string): string {
  return join(geminiOAuthProfileGeminiDir(profileId), 'google_accounts.json')
}

function readJsonFileSync(filePath: string): any | null {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function readGeminiOAuthProfileCredentialsSync(
  profileId: string
): { accessToken: string; refreshToken?: string; expiresAt?: number } | null {
  const parsed = readJsonFileSync(geminiOAuthProfileCredentialsPath(profileId))
  const accessToken = String(parsed?.access_token || '').trim()
  if (!accessToken) return null
  const refreshToken =
    typeof parsed?.refresh_token === 'string' ? parsed.refresh_token.trim() : undefined
  const expiryDate = Number(parsed?.expiry_date || 0)
  return {
    accessToken,
    refreshToken: refreshToken || undefined,
    expiresAt: Number.isFinite(expiryDate) && expiryDate > 0 ? expiryDate : undefined
  }
}

export function readGeminiOAuthProfileEmail(profileId: string): string | undefined {
  const parsed = readJsonFileSync(geminiOAuthProfileAccountsPath(profileId))
  const active = typeof parsed?.active === 'string' ? parsed.active.trim() : ''
  return active || undefined
}

export function getDefaultGeminiAuthProfileId(): string | null {
  const settings = AppStore.getSettings()
  const configured = optionalStringOrNull(settings.defaultGeminiAuthProfileId)
  if (!configured) return null
  return getGeminiAuthProfiles().some((profile) => profile.id === configured) ? configured : null
}

export function summarizeGeminiAuthProfile(
  profile: GeminiAuthProfile,
  defaultProfileId: string | null
): GeminiAuthProfileSummary {
  const hasApiKey = Boolean(decryptApiKey(profile.encryptedApiKey))
  const oauthConfigured =
    profile.kind === 'google-oauth'
      ? Boolean(readGeminiOAuthProfileCredentialsSync(profile.id))
      : undefined
  const configured =
    profile.kind === 'api-key'
      ? hasApiKey
      : profile.kind === 'vertex-ai'
        ? Boolean(profile.vertexProject?.trim())
        : Boolean(oauthConfigured)
  const login = geminiOAuthLoginRuns.get(profile.id)
  return {
    id: profile.id,
    label: profile.label || profile.kind,
    kind: profile.kind,
    configured,
    isDefault: profile.id === defaultProfileId,
    authState: configured
      ? profile.kind
      : profile.kind === 'google-oauth'
        ? 'oauth-login-required'
        : 'incomplete',
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastUsedAt: profile.lastUsedAt,
    vertexProject: profile.vertexProject,
    vertexLocation: profile.vertexLocation,
    ...(profile.kind === 'google-oauth'
      ? {
          oauthConfigured: Boolean(oauthConfigured),
          oauthEmail: readGeminiOAuthProfileEmail(profile.id),
          ...(login ? { oauthLogin: publicGeminiOAuthLoginStatus(login) } : {})
        }
      : {})
  }
}

export async function getGeminiAuthStatusSnapshot(
  deps: GeminiAuthUsageDeps
): Promise<GeminiAuthStatus> {
  const encryptionAvailable = safeStorage.isEncryptionAvailable()
  const resolved = await deps.resolveCliProviderBinary('gemini')
  const defaultProfileId = getDefaultGeminiAuthProfileId()
  const profiles = getGeminiAuthProfiles().map((profile) =>
    summarizeGeminiAuthProfile(profile, defaultProfileId)
  )
  const activeProfile = profiles.find((profile) => profile.id === defaultProfileId)
  const localOauthConfigured = await readGeminiOAuthCredentials()
    .then(Boolean)
    .catch(() => false)
  const apiKeyConfigured = Boolean(activeProfile?.configured && activeProfile.kind === 'api-key')
  const authState = activeProfile
    ? activeProfile.authState
    : localOauthConfigured
      ? 'google-oauth'
      : 'unknown'
  const version = resolved.binaryPath
    ? await deps.readResolvedCliVersion(resolved).catch(() => undefined)
    : undefined
  return {
    available: Boolean(resolved.binaryPath),
    authState,
    apiKeyConfigured,
    encryptionAvailable,
    version,
    binaryPath: resolved.binaryPath || null,
    activeProfileId: defaultProfileId,
    activeProfileLabel: activeProfile?.label,
    profiles,
    ...(defaultProfileId && geminiOAuthLoginRuns.has(defaultProfileId)
      ? { oauthLogin: publicGeminiOAuthLoginStatus(geminiOAuthLoginRuns.get(defaultProfileId)!) }
      : {})
  }
}

export function saveGeminiAuthProfile(input: unknown): GeminiAuthProfileSummary {
  const source = requireRecord(input, 'Gemini auth profile')
  const profiles = getGeminiAuthProfiles()
  const now = new Date().toISOString()
  const id = optionalString(source.id) || `gemini-auth-${randomBytes(8).toString('hex')}`
  const existing = profiles.find((profile) => profile.id === id)
  const kind = sanitizeGeminiAuthProfileKind(source.kind || existing?.kind)
  const label =
    optionalString(source.label) ||
    existing?.label ||
    (kind === 'api-key' ? 'Gemini API key' : kind === 'vertex-ai' ? 'Vertex AI' : 'Google login')
  const rawApiKey = optionalString(source.apiKey)
  const encryptedApiKey =
    kind === 'api-key'
      ? rawApiKey
        ? encryptApiKey(rawApiKey) || existing?.encryptedApiKey
        : existing?.encryptedApiKey
      : undefined
  const nextProfile: GeminiAuthProfile = {
    id,
    label,
    kind,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt,
    ...(encryptedApiKey ? { encryptedApiKey } : {}),
    ...(kind === 'vertex-ai'
      ? {
          vertexProject: optionalString(source.vertexProject) || existing?.vertexProject,
          vertexLocation:
            optionalString(source.vertexLocation) || existing?.vertexLocation || 'us-central1'
        }
      : {})
  }
  const nextProfiles = existing
    ? profiles.map((profile) => (profile.id === id ? nextProfile : profile))
    : [...profiles, nextProfile]
  const currentDefault = getDefaultGeminiAuthProfileId()
  const makeDefault =
    source.makeDefault !== false && (!currentDefault || source.makeDefault === true || !existing)
  const defaultGeminiAuthProfileId = makeDefault ? id : currentDefault
  AppStore.updateSettings({ geminiAuthProfiles: nextProfiles, defaultGeminiAuthProfileId })
  return summarizeGeminiAuthProfile(nextProfile, defaultGeminiAuthProfileId)
}

export async function deleteGeminiAuthProfile(profileId: unknown): Promise<boolean> {
  const id = requireNonEmptyString(profileId, 'Gemini auth profile id')
  const profiles = getGeminiAuthProfiles()
  const nextProfiles = profiles.filter((profile) => profile.id !== id)
  if (nextProfiles.length === profiles.length) return false
  const loginRun = geminiOAuthLoginRuns.get(id)
  if (loginRun?.status === 'running') {
    loginRun.child?.kill()
    geminiOAuthLoginRuns.set(id, {
      ...loginRun,
      child: undefined,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      message: 'Gemini Google login was cancelled because the profile was deleted.'
    })
  }
  const currentDefault = getDefaultGeminiAuthProfileId()
  AppStore.updateSettings({
    geminiAuthProfiles: nextProfiles,
    defaultGeminiAuthProfileId: currentDefault === id ? nextProfiles[0]?.id || null : currentDefault
  })
  await removeGeminiOAuthProfileFiles(id)
  return true
}

export function setDefaultGeminiAuthProfile(
  profileId: unknown
): GeminiAuthProfileSummary | null {
  const id = optionalStringOrNull(profileId)
  if (!id) {
    AppStore.updateSettings({ defaultGeminiAuthProfileId: null })
    return null
  }
  const profile = getGeminiAuthProfiles().find((candidate) => candidate.id === id)
  if (!profile) {
    throw new Error('Gemini auth profile was not found.')
  }
  AppStore.updateSettings({ defaultGeminiAuthProfileId: id })
  return summarizeGeminiAuthProfile(profile, id)
}

export function markGeminiAuthProfileUsed(profileId?: string | null): void {
  if (!profileId) return
  const profiles = getGeminiAuthProfiles()
  if (!profiles.some((profile) => profile.id === profileId)) return
  const now = new Date().toISOString()
  AppStore.updateSettings({
    geminiAuthProfiles: profiles.map((profile) =>
      profile.id === profileId ? { ...profile, lastUsedAt: now, updatedAt: now } : profile
    )
  })
}

export async function startGeminiOAuthLogin(
  input: unknown,
  deps: GeminiAuthUsageDeps
): Promise<GeminiOAuthLoginStatus> {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const requestedId = optionalString(source.profileId) || optionalString(source.id)
  const profiles = getGeminiAuthProfiles()
  let profile = requestedId ? profiles.find((candidate) => candidate.id === requestedId) : undefined
  if (profile && profile.kind !== 'google-oauth') {
    throw new Error('Selected Gemini auth profile is not a Google login profile.')
  }
  if (!profile) {
    const saved = saveGeminiAuthProfile({
      id: requestedId,
      label: optionalString(source.label) || 'Google login',
      kind: 'google-oauth',
      makeDefault: source.makeDefault !== false
    })
    profile = getGeminiAuthProfiles().find((candidate) => candidate.id === saved.id)
  } else if (source.makeDefault !== false) {
    AppStore.updateSettings({ defaultGeminiAuthProfileId: profile.id })
  }
  if (!profile) {
    throw new Error('Gemini Google login profile could not be created.')
  }

  const activeRun = geminiOAuthLoginRuns.get(profile.id)
  if (activeRun?.status === 'running') {
    return publicGeminiOAuthLoginStatus(activeRun)
  }

  const resolved = await deps.resolveCliProviderBinary('gemini')
  if (!resolved.binaryPath) {
    throw new Error(resolved.error || 'Gemini CLI is not configured.')
  }

  await ensureGeminiOAuthProfileSettings(profile.id)
  const startedAt = new Date().toISOString()
  const run: GeminiOAuthLoginRun = {
    profileId: profile.id,
    status: 'running',
    startedAt,
    message: 'Opening Google login in the browser.',
    output: ''
  }
  geminiOAuthLoginRuns.set(profile.id, run)

  const child = spawn(resolved.binaryPath, ['--list-sessions'], {
    cwd: app.getPath('home'),
    shell: false,
    env: deps.createCliEnv(
      {
        ...GEMINI_AUTH_CLEAR_ENV,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        GEMINI_CLI_HOME: geminiOAuthProfileHome(profile.id),
        GEMINI_DEFAULT_AUTH_TYPE: 'oauth-personal',
        GOOGLE_APPLICATION_CREDENTIALS: '',
        GOOGLE_GENAI_USE_GCA: 'true',
        TASKWRAITH_GEMINI_AUTH_PROFILE_ID: profile.id
      },
      resolved.binaryPath
    )
  })
  run.child = child

  const capture = (chunk: Buffer | string): void => {
    const text = chunk.toString()
    run.output = `${run.output || ''}${text}`.slice(-12_000)
    const urlMatch = text.match(/https:\/\/accounts\.google\.com\/[^\s]+/)
    if (urlMatch) {
      run.authUrl = urlMatch[0]
      run.message = 'Google login is waiting for browser approval.'
    }
  }

  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.stdin?.write('y\n')
  child.stdin?.end()
  child.on('error', (error) => {
    geminiOAuthLoginRuns.set(profile!.id, {
      ...run,
      child: undefined,
      status: 'error',
      finishedAt: new Date().toISOString(),
      message: `Failed to start Gemini Google login: ${error.message}`
    })
  })
  child.on('close', (code) => {
    const credentials = readGeminiOAuthProfileCredentialsSync(profile!.id)
    const email = readGeminiOAuthProfileEmail(profile!.id)
    const finishedAt = new Date().toISOString()
    if (credentials) {
      geminiOAuthLoginRuns.set(profile!.id, {
        ...run,
        child: undefined,
        status: 'success',
        finishedAt,
        exitCode: code,
        message: email ? `Signed in as ${email}.` : 'Google login completed.'
      })
      markGeminiAuthProfileUsed(profile!.id)
      return
    }
    const output = (run.output || '').trim()
    geminiOAuthLoginRuns.set(profile!.id, {
      ...run,
      child: undefined,
      status: code === null ? 'cancelled' : 'error',
      finishedAt,
      exitCode: code,
      message: output
        ? output.split(/\r?\n/).slice(-4).join(' ').slice(0, 500)
        : `Gemini Google login exited with code ${code ?? 'unknown'} before credentials were saved.`
    })
  })

  return publicGeminiOAuthLoginStatus(run)
}

export function getGeminiOAuthLoginStatus(profileId: unknown): GeminiOAuthLoginStatus | null {
  const id = optionalStringOrNull(profileId) || getDefaultGeminiAuthProfileId()
  if (!id) return null
  const run = geminiOAuthLoginRuns.get(id)
  return run ? publicGeminiOAuthLoginStatus(run) : null
}

export function cancelGeminiOAuthLogin(profileId: unknown): GeminiOAuthLoginStatus | null {
  const id = optionalStringOrNull(profileId) || getDefaultGeminiAuthProfileId()
  if (!id) return null
  const run = geminiOAuthLoginRuns.get(id)
  if (!run) return null
  if (run.status === 'running') {
    run.child?.kill()
    const next = {
      ...run,
      child: undefined,
      status: 'cancelled' as const,
      finishedAt: new Date().toISOString(),
      message: 'Gemini Google login was cancelled.'
    }
    geminiOAuthLoginRuns.set(id, next)
    return publicGeminiOAuthLoginStatus(next)
  }
  return publicGeminiOAuthLoginStatus(run)
}

export function publicGeminiOAuthLoginStatus(
  run: GeminiOAuthLoginRun
): GeminiOAuthLoginStatus {
  return {
    profileId: run.profileId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    message: run.message,
    authUrl: run.authUrl,
    exitCode: run.exitCode
  }
}

async function readJsonFile(filePath: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function writeJsonFile(filePath: string, value: any): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function withNestedValue(base: any, pathParts: string[], value: unknown): any {
  const root = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
  let cursor = root
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const key = pathParts[index]
    const existing = cursor[key]
    cursor[key] =
      existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {}
    cursor = cursor[key]
  }
  cursor[pathParts[pathParts.length - 1]] = value
  return root
}

export async function ensureGeminiOAuthProfileSettings(
  profileId: string,
  options: GeminiOAuthProfileSettingsOptions = {}
): Promise<void> {
  const settingsPath = geminiOAuthProfileSettingsPath(profileId)
  const existing = await readJsonFile(settingsPath)
  let next = withNestedValue(existing, ['security', 'auth', 'selectedType'], 'oauth-personal')
  if (options.includeMcp) {
    const mcp = options.mcp
    if (!mcp) {
      throw new Error('Gemini MCP profile settings were requested without MCP settings.')
    }
    next = {
      ...next,
      mcpServers: {
        ...(next.mcpServers &&
        typeof next.mcpServers === 'object' &&
        !Array.isArray(next.mcpServers)
          ? next.mcpServers
          : {}),
        [mcp.serverName]: {
          command: mcp.command || process.execPath,
          args: mcp.args,
          trust: true,
          includeTools: [...mcp.includeTools]
        }
      }
    }
  } else if (
    next.mcpServers &&
    typeof next.mcpServers === 'object' &&
    !Array.isArray(next.mcpServers)
  ) {
    const mcpServers = { ...next.mcpServers }
    delete mcpServers[options.mcp?.serverName || DEFAULT_GEMINI_MCP_SERVER_NAME]
    next = { ...next, mcpServers }
  }
  await writeJsonFile(settingsPath, next)
}

export async function removeGeminiOAuthProfileFiles(profileId: string): Promise<void> {
  await fs
    .rm(join(geminiOAuthProfilesRoot(), geminiAuthProfileDirName(profileId)), {
      recursive: true,
      force: true
    })
    .catch(() => {})
}

export async function ensureGeminiAuthProfileMaterialized(
  profileId?: string | null,
  options: GeminiOAuthProfileSettingsOptions = {}
): Promise<void> {
  const id = optionalStringOrNull(profileId) || getDefaultGeminiAuthProfileId()
  if (!id) return
  const profile = getGeminiAuthProfiles().find((candidate) => candidate.id === id)
  if (!profile || profile.kind !== 'google-oauth') return
  await ensureGeminiOAuthProfileSettings(profile.id, options)
}

export const GEMINI_AUTH_CLEAR_ENV: Record<string, string> = {
  GEMINI_API_KEY: '',
  GOOGLE_API_KEY: '',
  GOOGLE_GENAI_API_KEY: '',
  GOOGLE_GENAI_USE_VERTEXAI: '',
  GOOGLE_GENAI_USE_GCA: '',
  GOOGLE_CLOUD_PROJECT: '',
  GOOGLE_CLOUD_LOCATION: '',
  GOOGLE_CLOUD_REGION: ''
}

export function resolveGeminiAuthProfileEnv(profileId?: string | null): Record<string, string> {
  const id = optionalStringOrNull(profileId) || getDefaultGeminiAuthProfileId()
  if (!id) return {}
  const profile = getGeminiAuthProfiles().find((candidate) => candidate.id === id)
  if (!profile) return {}
  if (profile.kind === 'api-key') {
    const apiKey = decryptApiKey(profile.encryptedApiKey)
    return {
      ...GEMINI_AUTH_CLEAR_ENV,
      TASKWRAITH_GEMINI_AUTH_PROFILE_ID: profile.id,
      ...(apiKey ? { GEMINI_API_KEY: apiKey } : {})
    }
  }
  if (profile.kind === 'vertex-ai') {
    return {
      ...GEMINI_AUTH_CLEAR_ENV,
      TASKWRAITH_GEMINI_AUTH_PROFILE_ID: profile.id,
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      ...(profile.vertexProject ? { GOOGLE_CLOUD_PROJECT: profile.vertexProject } : {}),
      ...(profile.vertexLocation
        ? {
            GOOGLE_CLOUD_LOCATION: profile.vertexLocation,
            GOOGLE_CLOUD_REGION: profile.vertexLocation
          }
        : {})
    }
  }
  return {
    ...GEMINI_AUTH_CLEAR_ENV,
    TASKWRAITH_GEMINI_AUTH_PROFILE_ID: profile.id,
    GEMINI_CLI_HOME: geminiOAuthProfileHome(profile.id),
    GOOGLE_APPLICATION_CREDENTIALS: '',
    GOOGLE_GENAI_USE_GCA: 'true'
  }
}

// Matches ios/TaskWraithApp/project.yml PRODUCT_BUNDLE_IDENTIFIER — APNs
// rejects pushes whose topic doesn't match the app's real bundle id.
export const DEFAULT_APNS_BUNDLE_ID = 'com.taskwraith.companion'

export function decryptApnsAuthKey(): string | null {
  const config = AppStore.getSettings().apnsConfig
  if (!config?.encryptedAuthKey) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const pem = safeStorage.decryptString(Buffer.from(config.encryptedAuthKey, 'base64'))
    return pem && pem.includes('BEGIN PRIVATE KEY') ? pem : null
  } catch {
    return null
  }
}

/** QR-optional discovery (Slice 5d) — store the host-side Tailscale OAuth
 * client credentials. The secret is encrypted via `safeStorage` and NEVER
 * leaves this Mac; only an already-paired phone's discovery request makes the
 * host USE it (host = oracle). Mirrors the APNs custody stance: refuse to store
 * a non-OAuth value down the wrong path, refuse when encryption is unavailable
 * (don't persist a plaintext secret). */
export function setTailscaleOAuthCredentials(input: {
  clientId: string
  clientSecret: string
}): { ok: true } | { ok: false; error: string } {
  const clientId = (input?.clientId || '').trim()
  const clientSecret = (input?.clientSecret || '').trim()
  if (!clientId) return { ok: false, error: 'Tailscale OAuth client ID is required.' }
  if (!looksLikeTailscaleOAuthClientSecret(clientSecret)) {
    return {
      ok: false,
      error:
        'That does not look like a Tailscale OAuth client secret (expected a tskey-client-… value).'
    }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      error:
        'macOS Keychain encryption is unavailable; cannot safely store the Tailscale OAuth secret.'
    }
  }
  AppStore.updateSettings({
    tailscaleOAuth: {
      clientId,
      encryptedClientSecret: safeStorage.encryptString(clientSecret).toString('base64'),
      configuredAt: new Date().toISOString(),
      encryptionAvailable: true
    }
  })
  return { ok: true }
}

export function clearTailscaleOAuthCredentials(): void {
  AppStore.updateSettings({ tailscaleOAuth: undefined as any })
}

/** Status for the Settings UI — never returns the secret. */
export function tailscaleOAuthStatus(): {
  configured: boolean
  clientId: string | null
  encryptionAvailable: boolean
} {
  const cfg = AppStore.getSettings().tailscaleOAuth
  return {
    configured: Boolean(cfg?.clientId && cfg?.encryptedClientSecret),
    clientId: cfg?.clientId ?? null,
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

/** Decrypt-for-use accessor (the discovery oracle calls this). Degrades to null
 * — "not configured" — when nothing is stored, encryption is unavailable, or
 * the ciphertext won't decrypt to a plausible OAuth secret. Deliberately does
 * NOT fail loud (unlike RemoteIdentityStore): a missing/broken discovery
 * credential should disable discovery, not hold the whole bridge down. */
export function loadTailscaleOAuthCredentials(): {
  clientId: string
  clientSecret: string
} | null {
  const cfg = AppStore.getSettings().tailscaleOAuth
  if (!cfg?.clientId || !cfg?.encryptedClientSecret) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const clientSecret = safeStorage.decryptString(Buffer.from(cfg.encryptedClientSecret, 'base64'))
    return clientSecret && looksLikeTailscaleOAuthClientSecret(clientSecret)
      ? { clientId: cfg.clientId, clientSecret }
      : null
  } catch {
    return null
  }
}

export function buildBridgeApnsPusherFromSettings(): BridgeApnsPusher {
  const config = AppStore.getSettings().apnsConfig
  const log = (line: string) => {
    console.log(line)
  }
  if (config?.encryptedAuthKey && config.keyId && config.teamId) {
    const pem = decryptApnsAuthKey()
    if (pem) {
      return createBridgeApnsPusher({
        log,
        credentials: {
          authKeyPem: pem,
          keyId: config.keyId,
          teamId: config.teamId,
          bundleId: config.bundleId || DEFAULT_APNS_BUNDLE_ID
        }
      })
    }
    log(
      '[BridgeApnsPusher] apnsConfig is set but the encrypted auth-key failed to decrypt; falling back to env-var resolution.'
    )
  }
  return createBridgeApnsPusher({ log })
}

export function storeCodexUsageCredential(credential: CodexUsageCredential): void {
  inMemoryCodexUsageCredential = credential
  const encryptionAvailable = safeStorage.isEncryptionAvailable()
  const encryptedAccessToken = encryptionAvailable
    ? safeStorage.encryptString(credential.accessToken).toString('base64')
    : undefined
  AppStore.updateSettings({
    codexUsageCredential: {
      encryptedAccessToken,
      accountId: credential.accountId,
      importedAt: credential.importedAt || new Date().toISOString(),
      source: credential.source,
      encryptionAvailable
    }
  })
}

export function clearCodexUsageCredential(): void {
  inMemoryCodexUsageCredential = null
  AppStore.updateSettings({ codexUsageCredential: undefined as any })
}

export function cacheProviderUsageSnapshot(provider: ProviderId, snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== 'object') return
  if (!(snapshot as { error?: unknown }).error && hasProviderUsageSnapshotContent(snapshot)) {
    AppStore.storeProviderUsageSnapshot(provider, snapshot)
  }
}

export function usageSnapshotWithPersistedFallback(
  provider: ProviderId,
  fallback: NormalizedProviderUsageSnapshot
): NormalizedProviderUsageSnapshot {
  const cached = AppStore.getProviderUsageSnapshot(provider)
  if (hasProviderUsageSnapshotContent(cached)) {
    const projected = projectStaleSnapshotForward(cached)
    return {
      ...projected,
      provider,
      configured: fallback?.configured ?? projected.configured,
      source: projected.source ?? fallback?.source ?? null,
      stale: true,
      error: fallback?.error || projected.error
    }
  }
  return fallback
}

export async function resolveCodexUsageImportPath(
  event: IpcMainInvokeEvent,
  requestedPath?: string | null
): Promise<string | null> {
  const explicitPath = expandHomePath(requestedPath)
  if (explicitPath) return explicitPath
  const defaultPath = join(os.homedir(), '.codex', 'auth.json')
  if (await fileExists(defaultPath)) {
    return defaultPath
  }
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  const dialogOptions: OpenDialogOptions = {
    title: 'Import Codex usage session',
    message: 'Select Codex auth.json to import usage limits.',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}

export async function fetchCodexUsageSnapshot(): Promise<NormalizedProviderUsageSnapshot> {
  // Prefer the live, CLI-rotated token from ~/.codex/auth.json; fall back to the
  // one-time encrypted import only when the file is missing/unreadable.
  const credential = (await readCodexUsageCredentialLive()) ?? storedCodexUsageCredential()
  if (!credential) {
    const stored = AppStore.getSettings().codexUsageCredential
    return usageSnapshotWithPersistedFallback('codex', {
      provider: 'codex',
      configured: Boolean(stored?.accountId),
      source: stored?.source || null,
      accountId: redactAccountId(stored?.accountId),
      importedAt: stored?.importedAt,
      encryptionAvailable: stored?.encryptionAvailable ?? safeStorage.isEncryptionAvailable(),
      error: stored?.accountId
        ? 'Codex usage token is not available in this session. Re-import Codex auth to refresh usage.'
        : 'Codex usage import is not configured.'
    })
  }

  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'chatgpt-account-id': credential.accountId,
        Accept: 'application/json'
      }
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error('Imported Codex session is expired or not authorized.')
    }
    if (response.status === 429) {
      throw new Error('Codex usage endpoint is rate limited.')
    }
    if (!response.ok) {
      throw new Error(`Codex usage endpoint returned HTTP ${response.status}.`)
    }
    const payload = await response.json()
    const snapshot = normalizeCodexUsagePayload(payload, credential)
    cacheProviderUsageSnapshot('codex', snapshot)
    return snapshot
  } catch (error) {
    const fallback = usageSnapshotWithPersistedFallback('codex', {
      provider: 'codex',
      configured: true,
      source: 'chatgpt-wham',
      accountId: redactAccountId(credential.accountId),
      importedAt: credential.importedAt,
      error: error instanceof Error ? error.message : 'Codex usage fetch failed.'
    })
    if (hasProviderUsageSnapshotContent(fallback)) return fallback
    throw error
  }
}

// Gemini is retired and reads only the user's OWN local token from
// ~/.gemini/oauth_creds.json. The maintainer-secret token-refresh path was
// removed, so no OAuth client id/secret is bundled into the build any more.
const GEMINI_QUOTA_FRESH_TTL_MS = 90_000
const GEMINI_QUOTA_STALE_TTL_MS = 30 * 60_000

let geminiQuotaCache: { snapshot: NormalizedProviderUsageSnapshot; fetchedAt: number } | null = null

export function geminiCliRootPath(): string {
  const configuredHome = process.env.GEMINI_CLI_HOME
  if (configuredHome && configuredHome.trim()) {
    return join(expandHomePath(configuredHome.trim()), '.gemini')
  }
  const configuredRoot = process.env.GEMINI_HOME
  return configuredRoot && configuredRoot.trim()
    ? expandHomePath(configuredRoot.trim())
    : join(os.homedir(), '.gemini')
}

export async function readGeminiOAuthCredentials(): Promise<{
  accessToken: string
  refreshToken?: string
  expiresAt?: number
} | null> {
  try {
    const raw = await fs.readFile(join(geminiCliRootPath(), 'oauth_creds.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const accessToken = String(parsed?.access_token || '').trim()
    if (!accessToken) return null
    const refreshToken =
      typeof parsed?.refresh_token === 'string' ? parsed.refresh_token.trim() : undefined
    const expiryDate = Number(parsed?.expiry_date || 0)
    return {
      accessToken,
      refreshToken: refreshToken || undefined,
      expiresAt: Number.isFinite(expiryDate) && expiryDate > 0 ? expiryDate : undefined
    }
  } catch {
    return null
  }
}

export async function getGeminiAccessToken(): Promise<string | null> {
  // No token refresh: Gemini is retired and TaskWraith no longer carries the
  // public Gemini CLI OAuth client metadata used by the old refresh path. Return
  // the user's own stored access token; an expired one just yields a 401 the
  // caller already handles via the persisted-usage fallback.
  const credentials = await readGeminiOAuthCredentials()
  return credentials?.accessToken ?? null
}

function parseGeminiQuotaReset(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function geminiQuotaPriority(modelId: string): number {
  const id = modelId.toLowerCase()
  const generation = id.includes('3.1')
    ? 0
    : id.includes('3-') || id.endsWith('-3')
      ? 10
      : id.includes('2.5')
        ? 20
        : 30
  const family = id.includes('flash-lite')
    ? 2
    : id.includes('flash')
      ? 1
      : id.includes('pro')
        ? 0
        : 3
  return generation + family
}

function geminiQuotaDisplayName(modelId: string): string {
  const id = modelId.toLowerCase()
  const family = id.includes('flash-lite')
    ? 'Flash Lite'
    : id.includes('flash')
      ? 'Flash'
      : id.includes('pro')
        ? 'Pro'
        : modelId
  const generation = id.includes('3.1')
    ? '3.1'
    : id.includes('3-') || id.endsWith('-3')
      ? '3'
      : id.includes('2.5')
        ? '2.5'
        : ''
  const base = [family, generation].filter(Boolean).join(' ')
  return id.includes('preview') ? `${base} (preview)` : base
}

export function normalizeGeminiQuotaSnapshot(payload: any): NormalizedProviderUsageSnapshot {
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets : []
  const sorted = buckets.slice().sort((a: any, b: any) => {
    const aModel = String(a?.modelId || '')
    const bModel = String(b?.modelId || '')
    const priorityDelta = geminiQuotaPriority(aModel) - geminiQuotaPriority(bModel)
    if (priorityDelta !== 0) return priorityDelta
    const aUsed = 1 - Number(a?.remainingFraction ?? 1)
    const bUsed = 1 - Number(b?.remainingFraction ?? 1)
    return bUsed - aUsed
  })
  const windows = sorted.flatMap((bucket: any, index: number) => {
    const modelId = String(bucket?.modelId || '').trim()
    const remainingFraction = Number(bucket?.remainingFraction)
    if (!modelId || !Number.isFinite(remainingFraction)) return []
    const remainingPercent = Math.max(0, Math.min(100, remainingFraction * 100))
    const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent))
    return [
      {
        id: `gemini-${modelId || index}`,
        label: geminiQuotaDisplayName(modelId),
        runs: 0,
        totalTokens: 0,
        limitLabel: `${Math.round(remainingPercent)}% remaining`,
        resetAt: parseGeminiQuotaReset(bucket?.resetTime),
        trackingOnly: false,
        usedPercent,
        remainingPercent,
        sourceModelId: modelId
      }
    ]
  })
  return {
    provider: 'gemini',
    source: 'gemini-live-quota',
    configured: true,
    fetchedAt: new Date().toISOString(),
    windows
  }
}

export async function fetchGeminiUsageSnapshot(): Promise<NormalizedProviderUsageSnapshot> {
  const now = Date.now()
  if (geminiQuotaCache && now - geminiQuotaCache.fetchedAt < GEMINI_QUOTA_FRESH_TTL_MS) {
    return geminiQuotaCache.snapshot
  }

  const accessToken = await getGeminiAccessToken()
  if (!accessToken) {
    return usageSnapshotWithPersistedFallback('gemini', {
      provider: 'gemini',
      source: 'gemini-live-quota',
      configured: false,
      error:
        'Gemini OAuth credentials were not found. Run Gemini CLI once to refresh ~/.gemini/oauth_creds.json.'
    })
  }

  try {
    const response = await fetch(
      'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ project: 'default' })
      }
    )
    if (!response.ok) {
      throw new Error(`Gemini live quota endpoint returned HTTP ${response.status}.`)
    }
    const payload = await response.json()
    const snapshot = normalizeGeminiQuotaSnapshot(payload)
    geminiQuotaCache = { snapshot, fetchedAt: Date.now() }
    cacheProviderUsageSnapshot('gemini', snapshot)
    return snapshot
  } catch (error) {
    if (geminiQuotaCache && now - geminiQuotaCache.fetchedAt < GEMINI_QUOTA_STALE_TTL_MS) {
      return {
        ...geminiQuotaCache.snapshot,
        stale: true,
        error: error instanceof Error ? error.message : 'Gemini live quota fetch failed.'
      }
    }
    return usageSnapshotWithPersistedFallback('gemini', {
      provider: 'gemini',
      source: 'gemini-live-quota',
      configured: true,
      error: error instanceof Error ? error.message : 'Gemini live quota fetch failed.'
    })
  }
}

const KIMI_USAGE_FRESH_TTL_MS = 90_000
const KIMI_USAGE_STALE_TTL_MS = 30 * 60_000

let kimiUsageCache: { snapshot: NormalizedProviderUsageSnapshot; fetchedAt: number } | null = null

export async function readKimiOAuthAccessToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      join(os.homedir(), '.kimi', 'credentials', 'kimi-code.json'),
      'utf8'
    )
    const parsed = JSON.parse(raw)
    const accessToken = String(parsed?.access_token || '').trim()
    if (!accessToken) return null
    const expiresAt = Number(parsed?.expires_at || 0)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= Date.now()) {
      return null
    }
    return accessToken
  } catch {
    return null
  }
}

export async function getKimiUsageAccessToken(): Promise<string | null> {
  return getStoredKimiApiKey() || (await readKimiOAuthAccessToken())
}

export async function fetchKimiUsageSnapshot(): Promise<NormalizedProviderUsageSnapshot> {
  const now = Date.now()
  if (kimiUsageCache && now - kimiUsageCache.fetchedAt < KIMI_USAGE_FRESH_TTL_MS) {
    return kimiUsageCache.snapshot
  }

  const accessToken = await getKimiUsageAccessToken()
  if (!accessToken) {
    return usageSnapshotWithPersistedFallback('kimi', {
      provider: 'kimi',
      source: 'kimi-live-usage',
      configured: false,
      error: 'Kimi credentials were not found. Run Kimi Code once or configure a Kimi API token.'
    })
  }

  try {
    const response = await fetch('https://api.kimi.com/coding/v1/usages', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new Error(`Kimi usage endpoint returned HTTP ${response.status}.`)
    }
    const payload = await response.json()
    const snapshot = normalizeKimiUsageSnapshot(payload)
    kimiUsageCache = { snapshot, fetchedAt: Date.now() }
    cacheProviderUsageSnapshot('kimi', snapshot)
    return snapshot
  } catch (error) {
    if (kimiUsageCache && now - kimiUsageCache.fetchedAt < KIMI_USAGE_STALE_TTL_MS) {
      return {
        ...kimiUsageCache.snapshot,
        stale: true,
        error: error instanceof Error ? error.message : 'Kimi usage fetch failed.'
      }
    }
    return usageSnapshotWithPersistedFallback('kimi', {
      provider: 'kimi',
      source: 'kimi-live-usage',
      configured: true,
      error: error instanceof Error ? error.message : 'Kimi usage fetch failed.'
    })
  }
}

const CURSOR_USAGE_FRESH_TTL_MS = 2 * 60_000
const CURSOR_USAGE_STALE_TTL_MS = 4 * 60 * 60_000
let cursorUsageCache: { snapshot: CursorUsageSnapshot; fetchedAt: number } | null = null

function runCursorSqliteScalar(dbPath: string, query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const opts = { timeout: 8_000, maxBuffer: 1024 * 1024 }
    execFile('/usr/bin/sqlite3', ['-readonly', dbPath, query], opts, (err, stdout) => {
      if (!err) {
        const value = String(stdout || '').trim()
        resolve(value || null)
        return
      }
      void (async () => {
        let tmpDir: string | null = null
        try {
          tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'cursor-usage-'))
          const tmpDb = join(tmpDir, 'state.vscdb')
          await fs.copyFile(dbPath, tmpDb)
          execFile('/usr/bin/sqlite3', ['-readonly', tmpDb, query], opts, (err2, stdout2) => {
            const dir = tmpDir
            if (dir) void fs.rm(dir, { recursive: true, force: true }).catch(() => {})
            if (err2) {
              resolve(null)
              return
            }
            resolve(String(stdout2 || '').trim() || null)
          })
        } catch {
          if (tmpDir) void fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
          resolve(null)
        }
      })()
    })
  })
}

export async function readCursorEditorAccessToken(): Promise<string | null> {
  const query = `SELECT value FROM ItemTable WHERE key='${CURSOR_ACCESS_TOKEN_KEY}' LIMIT 1;`
  for (const dbPath of cursorStateDbCandidates(os.homedir())) {
    try {
      await fs.access(dbPath)
    } catch {
      continue
    }
    const token = await runCursorSqliteScalar(dbPath, query)
    if (token) return token
  }
  return null
}

export async function fetchCursorUsageRpc(token: string): Promise<unknown> {
  const response = await fetch(CURSOR_USAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: '{}'
  })
  if (!response.ok) {
    throw new Error(`Cursor usage endpoint returned HTTP ${response.status}.`)
  }
  return response.json()
}

export async function fetchCursorUsageSnapshot(): Promise<CursorUsageSnapshot | null> {
  const now = Date.now()
  if (cursorUsageCache && now - cursorUsageCache.fetchedAt < CURSOR_USAGE_FRESH_TTL_MS) {
    return cursorUsageCache.snapshot
  }
  const snapshot = await loadCursorUsageSnapshot({
    readAccessToken: readCursorEditorAccessToken,
    fetchUsageRpc: fetchCursorUsageRpc,
    now: () => Date.now()
  })
  if (snapshot.configured && !snapshot.error) {
    cursorUsageCache = { snapshot, fetchedAt: Date.now() }
    return snapshot
  }
  if (cursorUsageCache && now - cursorUsageCache.fetchedAt < CURSOR_USAGE_STALE_TTL_MS) {
    return { ...cursorUsageCache.snapshot, stale: true, error: snapshot.error }
  }
  return snapshot
}

const CLAUDE_USAGE_FRESH_TTL_MS = 2 * 60_000
const CLAUDE_USAGE_STALE_TTL_MS = 4 * 60 * 60_000
let claudeUsageCache: { snapshot: NormalizedProviderUsageSnapshot; fetchedAt: number } | null = null

export async function readClaudeCredentialsFile(): Promise<ClaudeOAuthCredential | null> {
  const candidates = [
    join(os.homedir(), '.claude', '.credentials.json'),
    join(os.homedir(), '.claude', 'credentials.json'),
    join(os.homedir(), '.config', 'claude', 'credentials.json')
  ]
  for (const path of candidates) {
    try {
      const raw = await fs.readFile(path, 'utf8')
      const parsed = JSON.parse(raw)
      const inner = parsed?.claudeAiOauth || parsed?.claude_ai_oauth || parsed
      const accessToken = String(inner?.accessToken || inner?.access_token || '').trim()
      if (!accessToken) continue
      const expiresAt = Number(inner?.expiresAt || inner?.expires_at || 0)
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
        continue
      }
      const subscriptionType =
        String(inner?.subscriptionType || inner?.subscription_type || '').toLowerCase() || undefined
      return {
        accessToken,
        subscriptionType,
        expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined
      }
    } catch {
      continue
    }
  }
  return null
}

export async function readClaudeKeychainCredential(): Promise<ClaudeOAuthCredential | null> {
  if (process.platform !== 'darwin') return null
  return new Promise((resolve) => {
    try {
      const proc = spawn('security', [
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w'
      ])
      let out = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      proc.on('error', () => resolve(null))
      proc.on('close', (code: number) => {
        if (code !== 0) return resolve(null)
        const raw = out.trim()
        if (!raw) return resolve(null)
        try {
          const parsed = JSON.parse(raw)
          const inner = parsed?.claudeAiOauth || parsed?.claude_ai_oauth || parsed
          const accessToken = String(inner?.accessToken || inner?.access_token || raw).trim()
          if (!accessToken) return resolve(null)
          const expiresAt = Number(inner?.expiresAt || inner?.expires_at || 0)
          if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()) {
            return resolve(null)
          }
          const subscriptionType =
            String(inner?.subscriptionType || inner?.subscription_type || '').toLowerCase() ||
            undefined
          resolve({
            accessToken,
            subscriptionType,
            expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined
          })
        } catch {
          resolve({ accessToken: raw })
        }
      })
    } catch {
      resolve(null)
    }
  })
}

export async function readClaudeLegacyTokenFile(): Promise<ClaudeOAuthCredential | null> {
  try {
    const raw = await fs.readFile(join(os.homedir(), '.claude', '.oauth_token'), 'utf8')
    const token = raw.trim()
    if (!token) return null
    return { accessToken: token }
  } catch {
    return null
  }
}

export async function getClaudeOAuthCredential(): Promise<ClaudeOAuthCredential | null> {
  return (
    (await readClaudeCredentialsFile()) ||
    (await readClaudeKeychainCredential()) ||
    (await readClaudeLegacyTokenFile())
  )
}

export async function fetchClaudeUsageSnapshot(): Promise<NormalizedProviderUsageSnapshot> {
  const now = Date.now()
  if (claudeUsageCache && now - claudeUsageCache.fetchedAt < CLAUDE_USAGE_FRESH_TTL_MS) {
    return claudeUsageCache.snapshot
  }

  const credential = await getClaudeOAuthCredential()
  if (!credential) {
    return usageSnapshotWithPersistedFallback('claude', {
      provider: 'claude',
      source: 'claude-oauth-usage',
      configured: false,
      error:
        'Claude OAuth credentials were not found. Run Claude Code once to populate ~/.claude/.credentials.json.'
    })
  }

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json'
      }
    })
    if (!response.ok) {
      throw new Error(`Claude OAuth usage endpoint returned HTTP ${response.status}.`)
    }
    const payload = await response.json()
    const snapshot = normalizeClaudeUsageSnapshot(payload, credential)
    claudeUsageCache = { snapshot, fetchedAt: Date.now() }
    cacheProviderUsageSnapshot('claude', snapshot)
    return snapshot
  } catch (error) {
    if (claudeUsageCache && now - claudeUsageCache.fetchedAt < CLAUDE_USAGE_STALE_TTL_MS) {
      return {
        ...claudeUsageCache.snapshot,
        stale: true,
        error: error instanceof Error ? error.message : 'Claude OAuth usage fetch failed.'
      }
    }
    return usageSnapshotWithPersistedFallback('claude', {
      provider: 'claude',
      source: 'claude-oauth-usage',
      configured: true,
      error: error instanceof Error ? error.message : 'Claude OAuth usage fetch failed.'
    })
  }
}

export async function importCodexUsageCredential(
  event: IpcMainInvokeEvent,
  requestedPath?: string | null
): Promise<CodexUsageImportResult> {
  const credentialPath = await resolveCodexUsageImportPath(event, requestedPath)
  if (!credentialPath) {
    return { imported: false, cancelled: true }
  }
  const raw = await fs.readFile(credentialPath, 'utf8')
  const credential = parseCodexUsageCredential(raw, credentialPath)
  storeCodexUsageCredential(credential)
  let snapshot: unknown = null
  try {
    snapshot = await fetchCodexUsageSnapshot()
  } catch (error) {
    snapshot = {
      configured: true,
      source: 'chatgpt-wham',
      accountId: redactAccountId(credential.accountId),
      importedAt: credential.importedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  return {
    imported: true,
    accountId: redactAccountId(credential.accountId),
    importedAt: credential.importedAt,
    source: credentialPath,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    snapshot
  }
}
