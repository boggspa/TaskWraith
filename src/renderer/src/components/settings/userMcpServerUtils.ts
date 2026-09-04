/**
 * User MCP server settings helpers — extracted from `../SettingsPanel.tsx`
 * (behavior-preserving move; `SettingsPanel.tsx` re-exports the public
 * surface so existing importers keep working).
 */
import type { UserMcpServerConfig, UserMcpServerTransport } from '../../../../main/store/types'
import { canPersistPlaintextFieldValue } from '../../../../shared/PlaintextSecretPolicy'

export type UserMcpServerFormState = {
  name: string
  description: string
  transport: UserMcpServerTransport
  command: string
  url: string
  argsText: string
  envText: string
  envSecretText: string
  headersText: string
  headerSecretText: string
  bearerTokenEnvVar: string
  enabled: boolean
}

export type UserMcpServerSecretValues = {
  env: Record<string, string>
  headers: Record<string, string>
}

export const USER_MCP_TRANSPORT_OPTIONS: Array<{ value: UserMcpServerTransport; label: string }> = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' }
]
const USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT: Record<UserMcpServerTransport, readonly string[]> = {
  stdio: ['Codex', 'Claude'],
  http: ['Codex', 'Claude'],
  sse: ['Claude']
}
export const USER_MCP_STDIO_HTTP_RUNTIME_LABEL =
  USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT.stdio.join(' + ')
const USER_MCP_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const USER_MCP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function emptyUserMcpServerForm(): UserMcpServerFormState {
  return {
    name: '',
    description: '',
    transport: 'stdio',
    command: '',
    url: '',
    argsText: '',
    envText: '',
    envSecretText: '',
    headersText: '',
    headerSecretText: '',
    bearerTokenEnvVar: '',
    enabled: false
  }
}

function formatUserMcpServerArgs(args?: string[]): string {
  return Array.isArray(args) ? args.join('\n') : ''
}

export function formatUserMcpServerEnv(env?: Record<string, string>): string {
  return env
    ? Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    : ''
}

function formatUserMcpServerHeaders(headers?: Record<string, string>): string {
  return headers
    ? Object.entries(headers)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    : ''
}

export function formatUserMcpServerSecretRefs(names?: string[]): string {
  return Array.isArray(names) && names.length > 0
    ? names
        .filter(Boolean)
        .map((name) => `${name}=`)
        .join('\n')
    : ''
}

export function omitSecretBackedFields(
  values: Record<string, string> | undefined,
  secretNames: readonly string[] | undefined
): Record<string, string> | undefined {
  if (!values) return undefined
  const secretSet = new Set(secretNames ?? [])
  const visible = Object.fromEntries(
    Object.entries(values).filter(([key]) => !secretSet.has(key))
  ) as Record<string, string>
  return Object.keys(visible).length > 0 ? visible : undefined
}

export function formFromUserMcpServer(server: UserMcpServerConfig): UserMcpServerFormState {
  return {
    name: server.name,
    description: server.description || '',
    transport: server.transport,
    command: server.command || '',
    url: server.url || '',
    argsText: formatUserMcpServerArgs(server.args),
    envText: formatUserMcpServerEnv(omitSecretBackedFields(server.env, server.secretRefs?.env)),
    envSecretText: formatUserMcpServerSecretRefs(server.secretRefs?.env),
    headersText: formatUserMcpServerHeaders(
      omitSecretBackedFields(server.headers, server.secretRefs?.headers)
    ),
    headerSecretText: formatUserMcpServerSecretRefs(server.secretRefs?.headers),
    bearerTokenEnvVar: server.bearerTokenEnvVar || '',
    enabled: server.enabled
  }
}

function parseUserMcpServerArgs(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 64)
}

export function parseUserMcpServerEnv(value: string): {
  env: Record<string, string>
  error?: string
} {
  const env: Record<string, string> = {}
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) return { env, error: 'Environment lines must use KEY=value.' }
    const key = line.slice(0, separatorIndex).trim()
    const val = line.slice(separatorIndex + 1)
    if (!USER_MCP_ENV_NAME_RE.test(key)) {
      return { env, error: `Invalid environment variable name: ${key}` }
    }
    env[key] = val
  }
  return { env }
}

function parseUserMcpServerHeaders(value: string): {
  headers: Record<string, string>
  error?: string
} {
  const headers: Record<string, string> = {}
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) return { headers, error: 'Header lines must use Name=value.' }
    const key = line.slice(0, separatorIndex).trim()
    const val = line.slice(separatorIndex + 1)
    if (!USER_MCP_HEADER_NAME_RE.test(key)) {
      return { headers, error: `Invalid HTTP header name: ${key}` }
    }
    headers[key] = val
  }
  return { headers }
}

export function parseUserMcpServerSecretLines(
  value: string,
  kind: 'env' | 'header'
): { names: string[]; values: Record<string, string>; error?: string } {
  const names: string[] = []
  const values: Record<string, string> = {}
  const seen = new Set<string>()
  const namePattern = kind === 'env' ? USER_MCP_ENV_NAME_RE : USER_MCP_HEADER_NAME_RE
  const label = kind === 'env' ? 'environment variable' : 'HTTP header'
  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0)
      return { names, values, error: `Secret ${label} lines must use Name=value.` }
    const key = line.slice(0, separatorIndex).trim()
    const val = line.slice(separatorIndex + 1)
    if (!namePattern.test(key)) {
      return { names, values, error: `Invalid secret ${label} name: ${key}` }
    }
    if (seen.has(key)) return { names, values, error: `Duplicate secret ${label} name: ${key}` }
    seen.add(key)
    names.push(key)
    if (val.length > 0) values[key] = val
  }
  return { names, values }
}

function isValidUserMcpRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function hasRunnableUserMcpEndpoint(
  server: Pick<UserMcpServerConfig, 'transport' | 'command' | 'url'>
): boolean {
  if (server.transport === 'stdio') return Boolean(server.command?.trim())
  const url = server.url?.trim()
  return Boolean(url && isValidUserMcpRemoteUrl(url))
}

export function userMcpServerRuntimeLabel(server: Pick<UserMcpServerConfig, 'transport'>): string {
  const providers = USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT[server.transport]
  return providers.length > 0 ? `runtime: ${providers.join(' + ')}` : 'saved only'
}

type UserMcpServerReadinessState = 'ready' | 'disabled' | 'blocked'

export interface UserMcpServerReadiness {
  state: UserMcpServerReadinessState
  label: string
  providers: string[]
  blockers: string[]
  notes: string[]
}

export function userMcpServerStatusLabel(
  server: Pick<UserMcpServerConfig, 'enabled' | 'transport' | 'command' | 'url'>
): string {
  if (!hasRunnableUserMcpEndpoint(server)) {
    if (server.transport === 'stdio') return 'needs command'
    return server.url?.trim() ? 'needs valid URL' : 'needs URL'
  }
  return server.enabled ? 'enabled' : 'disabled'
}

export function userMcpServerReadiness(server: UserMcpServerConfig): UserMcpServerReadiness {
  const providers = [...USER_MCP_RUNTIME_PROVIDERS_BY_TRANSPORT[server.transport]]
  const blockers: string[] = []
  const notes: string[] = []
  if (server.transport === 'stdio') {
    if (!server.command?.trim()) blockers.push('Missing command')
  } else {
    const url = server.url?.trim()
    if (!url) blockers.push('Missing URL')
    else if (!isValidUserMcpRemoteUrl(url)) blockers.push('URL must use http:// or https://')
  }
  if (server.transport === 'sse') {
    notes.push('SSE attaches to Claude only')
  } else {
    notes.push(
      'Cursor JSON remains exportable; managed Path-B runs attach TaskWraith’s built-in broker separately and do not attach these user-server records'
    )
  }
  if (!server.enabled) {
    return {
      state: 'disabled',
      label: 'Disabled',
      providers: [],
      blockers: ['Enable this server before it attaches to provider launches'],
      notes
    }
  }
  if (blockers.length > 0) {
    return {
      state: 'blocked',
      label: 'Needs attention',
      providers: [],
      blockers,
      notes
    }
  }
  return {
    state: 'ready',
    label: `Ready for ${providers.join(' + ')}`,
    providers,
    blockers: [],
    notes
  }
}

export function userMcpServerMatchesQuery(server: UserMcpServerConfig, query: string): boolean {
  const search = query.trim().toLowerCase()
  if (!search) return true
  const haystack = [
    server.name,
    server.description || '',
    server.transport,
    userMcpServerStatusLabel(server),
    userMcpServerReadiness(server).label,
    ...userMcpServerReadiness(server).blockers,
    ...userMcpServerReadiness(server).notes,
    server.command || '',
    server.url || '',
    ...(server.args ?? []),
    ...Object.keys(server.env ?? {}),
    ...(server.secretRefs?.env ?? []),
    ...Object.keys(userMcpServerRemoteHeaders(server, { redactValues: true }) ?? {}),
    ...(server.secretRefs?.headers ?? []),
    server.bearerTokenEnvVar || '',
    userMcpServerRuntimeLabel(server),
    ...userMcpServerProviderExportLabels(server)
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(search)
}

function makeUserMcpServerId(name: string): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'server'
  return `user-mcp-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function uniqueImportedUserMcpName(name: string, usedNames: Set<string>): string {
  const base = name.trim() || 'Imported MCP server'
  let candidate = base
  let suffix = 2
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}`
    suffix += 1
  }
  usedNames.add(candidate.toLowerCase())
  return candidate
}

function normalizeUserMcpServerName(value: string): string {
  return value.trim().toLowerCase()
}

export function hasUserMcpServerNameConflict(
  servers: readonly UserMcpServerConfig[],
  candidateName: string,
  candidateId?: string
): boolean {
  const normalized = normalizeUserMcpServerName(candidateName)
  if (!normalized) return false
  return servers.some(
    (server) => server.id !== candidateId && normalizeUserMcpServerName(server.name) === normalized
  )
}

export function buildUserMcpServerFromForm(
  form: UserMcpServerFormState,
  existing?: UserMcpServerConfig
): {
  server?: UserMcpServerConfig
  secretValues?: UserMcpServerSecretValues
  error?: string
} {
  const name = form.name.trim()
  if (!name) return { error: 'Server name is required.' }
  const args = form.transport === 'stdio' ? parseUserMcpServerArgs(form.argsText) : []
  const parsedEnv: { env: Record<string, string>; error?: string } =
    form.transport === 'stdio' ? parseUserMcpServerEnv(form.envText) : { env: {} }
  if (parsedEnv.error) return { error: parsedEnv.error }
  const parsedEnvSecrets =
    form.transport === 'stdio'
      ? parseUserMcpServerSecretLines(form.envSecretText, 'env')
      : { names: [], values: {} }
  if (parsedEnvSecrets.error) return { error: parsedEnvSecrets.error }
  const parsedHeaders: { headers: Record<string, string>; error?: string } =
    form.transport === 'stdio' ? { headers: {} } : parseUserMcpServerHeaders(form.headersText)
  if (parsedHeaders.error) return { error: parsedHeaders.error }
  const parsedHeaderSecrets =
    form.transport === 'stdio'
      ? { names: [], values: {} }
      : parseUserMcpServerSecretLines(form.headerSecretText, 'header')
  if (parsedHeaderSecrets.error) return { error: parsedHeaderSecrets.error }
  for (const key of parsedEnvSecrets.names) {
    if (key in parsedEnv.env) {
      return { error: `${key} is listed as both a plaintext and encrypted environment value.` }
    }
  }
  for (const key of parsedHeaderSecrets.names) {
    if (key in parsedHeaders.headers) {
      return { error: `${key} is listed as both a plaintext and encrypted HTTP header.` }
    }
  }
  const existingEnvSecrets = new Set(existing?.secretRefs?.env ?? [])
  for (const key of parsedEnvSecrets.names) {
    if (!(key in parsedEnvSecrets.values) && !existingEnvSecrets.has(key)) {
      return { error: `Secret environment variable ${key} needs a value before it can be saved.` }
    }
  }
  const existingHeaderSecrets = new Set(existing?.secretRefs?.headers ?? [])
  for (const key of parsedHeaderSecrets.names) {
    if (!(key in parsedHeaderSecrets.values) && !existingHeaderSecrets.has(key)) {
      return { error: `Secret HTTP header ${key} needs a value before it can be saved.` }
    }
  }
  const command = form.command.trim()
  const url = form.url.trim()
  const bearerTokenEnvVar = form.bearerTokenEnvVar.trim()
  if (
    form.transport !== 'stdio' &&
    bearerTokenEnvVar &&
    !USER_MCP_ENV_NAME_RE.test(bearerTokenEnvVar)
  ) {
    return { error: 'Bearer token environment variable must be a valid environment variable name.' }
  }
  if (form.transport === 'stdio' && form.enabled && !command) {
    return { error: 'A stdio server needs a command before it can be enabled.' }
  }
  if (form.transport !== 'stdio' && form.enabled && !url) {
    return { error: 'HTTP and SSE servers need a URL before they can be enabled.' }
  }
  if (form.transport !== 'stdio' && url) {
    if (!isValidUserMcpRemoteUrl(url)) {
      return { error: 'MCP server URL is not valid.' }
    }
  }
  const now = new Date().toISOString()
  const server: UserMcpServerConfig = {
    id: existing?.id || makeUserMcpServerId(name),
    name,
    enabled: form.enabled,
    transport: form.transport,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }
  const description = form.description.trim()
  if (description) server.description = description
  if (form.transport === 'stdio') {
    if (command) server.command = command
    if (args.length > 0) server.args = args
    if (Object.keys(parsedEnv.env).length > 0) server.env = parsedEnv.env
    if (parsedEnvSecrets.names.length > 0) {
      server.secretRefs = { env: parsedEnvSecrets.names }
    }
  } else {
    if (url) server.url = url
    if (Object.keys(parsedHeaders.headers).length > 0) server.headers = parsedHeaders.headers
    if (parsedHeaderSecrets.names.length > 0) {
      server.secretRefs = { headers: parsedHeaderSecrets.names }
    }
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar
  }
  return {
    server,
    secretValues: {
      env: parsedEnvSecrets.values,
      headers: parsedHeaderSecrets.values
    }
  }
}

function normalizeImportedUserMcpEnv(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined
  const env: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!USER_MCP_ENV_NAME_RE.test(key) || typeof rawValue !== 'string') continue
    env[key] = rawValue
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function normalizeImportedUserMcpHeaders(value: unknown): Record<string, string> | undefined {
  if (!isPlainRecord(value)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!USER_MCP_HEADER_NAME_RE.test(key) || typeof rawValue !== 'string') continue
    headers[key] = rawValue
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function splitImportedUserMcpSecretFields(
  values: Record<string, string> | undefined,
  kind: 'env' | 'header'
): {
  plaintext?: Record<string, string>
  secretNames: string[]
  secretValues: Record<string, string>
} {
  const plaintext: Record<string, string> = {}
  const secretValues: Record<string, string> = {}
  for (const [key, value] of Object.entries(values ?? {})) {
    if (canPersistPlaintextFieldValue({ key, value, kind })) {
      plaintext[key] = value
    } else {
      secretValues[key] = value
    }
  }
  return {
    plaintext: Object.keys(plaintext).length > 0 ? plaintext : undefined,
    secretNames: Object.keys(secretValues),
    secretValues
  }
}

function normalizeImportedBearerTokenEnvVar(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && USER_MCP_ENV_NAME_RE.test(trimmed) ? trimmed : undefined
}

function normalizeImportedUserMcpArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const args = value
    .map((arg) => (typeof arg === 'string' ? arg.trim() : String(arg).trim()))
    .filter(Boolean)
    .slice(0, 64)
  return args.length > 0 ? args : undefined
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

function splitTomlTopLevel(value: string, separator: ',' | '.' = ','): string[] {
  const parts: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  let squareDepth = 0
  let braceDepth = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') squareDepth += 1
    else if (char === ']') squareDepth = Math.max(0, squareDepth - 1)
    else if (char === '{') braceDepth += 1
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === separator && squareDepth === 0 && braceDepth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  const tail = value.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function findTomlTopLevelEquals(value: string): number {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"') {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '=') return index
  }
  return -1
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return undefined
}

function formatTomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

function parseTomlKey(value: string): string | undefined {
  const trimmed = value.trim()
  const quoted = parseTomlString(trimmed)
  if (quoted !== undefined) return quoted
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined
}

function formatTomlKeyComponent(value: string): string {
  const trimmed = value.trim()
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : formatTomlBasicString(trimmed)
}

function parseTomlDottedPath(value: string): string[] | undefined {
  const parts = splitTomlTopLevel(value, '.').map(parseTomlKey)
  return parts.every((part): part is string => typeof part === 'string') ? parts : undefined
}

function parseTomlStringArray(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  const values = splitTomlTopLevel(inner).map(parseTomlString)
  return values.every((entry): entry is string => typeof entry === 'string') ? values : undefined
}

function formatTomlStringArray(values: readonly string[]): string {
  return `[${values.map(formatTomlBasicString).join(', ')}]`
}

function parseTomlStringInlineTable(value: string): Record<string, string> | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return {}
  const table: Record<string, string> = {}
  for (const pair of splitTomlTopLevel(inner)) {
    const separatorIndex = findTomlTopLevelEquals(pair)
    if (separatorIndex <= 0) return undefined
    const key = parseTomlKey(pair.slice(0, separatorIndex))
    const val = parseTomlString(pair.slice(separatorIndex + 1))
    if (key === undefined || val === undefined) return undefined
    table[key] = val
  }
  return table
}

function formatTomlStringInlineTable(
  value: Record<string, string>,
  options: { redactValues?: boolean } = {}
): string {
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const rawValue = options.redactValues ? '[stored in TaskWraith settings]' : value[key]
      return `${formatTomlKeyComponent(key)} = ${formatTomlBasicString(rawValue ?? '')}`
    })
  return `{ ${entries.join(', ')} }`
}

function parseTomlBoolean(value: string): boolean | undefined {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  return undefined
}

function parseCodexMcpServersToml(text: string): Record<string, Record<string, unknown>> | null {
  const servers: Record<string, Record<string, unknown>> = {}
  let currentServerName: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    const tableMatch = line.match(/^\[(.+)]$/)
    if (tableMatch) {
      const path = parseTomlDottedPath(tableMatch[1])
      currentServerName = path && path.length === 2 && path[0] === 'mcp_servers' ? path[1] : null
      if (currentServerName && !servers[currentServerName]) servers[currentServerName] = {}
      continue
    }
    if (!currentServerName) continue
    const separatorIndex = findTomlTopLevelEquals(line)
    if (separatorIndex <= 0) continue
    const key = parseTomlKey(line.slice(0, separatorIndex))
    if (!key) continue
    const rawValue = line.slice(separatorIndex + 1).trim()
    const entry = servers[currentServerName]
    if (key === 'args') {
      const args = parseTomlStringArray(rawValue)
      if (args) entry.args = args
    } else if (key === 'env' || key === 'headers' || key === 'http_headers') {
      const table = parseTomlStringInlineTable(rawValue)
      if (table) entry[key] = table
    } else if (key === 'enabled' || key === 'disabled') {
      const boolValue = parseTomlBoolean(rawValue)
      if (boolValue !== undefined) entry[key] = boolValue
    } else {
      const stringValue = parseTomlString(rawValue)
      if (stringValue !== undefined) entry[key] = stringValue
    }
  }
  return Object.keys(servers).length > 0 ? servers : null
}

function normalizeImportedUserMcpTransport(entry: Record<string, unknown>): UserMcpServerTransport {
  const raw = String(entry.type || entry.transport || '')
    .trim()
    .toLowerCase()
  if (raw === 'sse') return 'sse'
  if (
    raw === 'http' ||
    raw === 'streamable_http' ||
    raw === 'streamable-http' ||
    raw === 'streamablehttp'
  ) {
    return 'http'
  }
  return typeof entry.url === 'string' && entry.url.trim() ? 'http' : 'stdio'
}

function buildImportedUserMcpServer(
  name: string,
  value: unknown,
  usedNames: Set<string>
): { server: UserMcpServerConfig; secretValues: UserMcpServerSecretValues } | null {
  if (!isPlainRecord(value)) return null
  const transport = normalizeImportedUserMcpTransport(value)
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  if (transport === 'stdio' && !command) return null
  if (transport !== 'stdio' && !url) return null
  if (transport !== 'stdio' && !isValidUserMcpRemoteUrl(url)) return null
  const serverName = uniqueImportedUserMcpName(name, usedNames)
  const now = new Date().toISOString()
  const server: UserMcpServerConfig = {
    id: makeUserMcpServerId(serverName),
    name: serverName,
    enabled:
      typeof value.enabled === 'boolean'
        ? value.enabled
        : typeof value.disabled === 'boolean'
          ? !value.disabled
          : true,
    transport,
    createdAt: now,
    updatedAt: now
  }
  if (typeof value.description === 'string' && value.description.trim()) {
    server.description = value.description.trim()
  }
  if (command) server.command = command
  if (url) server.url = url
  const args = normalizeImportedUserMcpArgs(value.args)
  if (args) server.args = args
  const env = normalizeImportedUserMcpEnv(value.env)
  const envSplit = splitImportedUserMcpSecretFields(env, 'env')
  if (envSplit.plaintext) server.env = envSplit.plaintext
  if (envSplit.secretNames.length > 0) {
    server.secretRefs = { ...(server.secretRefs || {}), env: envSplit.secretNames }
  }
  const secretValues: UserMcpServerSecretValues = {
    env: envSplit.secretValues,
    headers: {}
  }
  if (transport !== 'stdio') {
    const headers =
      normalizeImportedUserMcpHeaders(value.headers) ??
      normalizeImportedUserMcpHeaders(value.http_headers)
    const headerSplit = splitImportedUserMcpSecretFields(headers, 'header')
    if (headerSplit.plaintext) server.headers = headerSplit.plaintext
    if (headerSplit.secretNames.length > 0) {
      server.secretRefs = { ...(server.secretRefs || {}), headers: headerSplit.secretNames }
      secretValues.headers = headerSplit.secretValues
    }
    const bearerTokenEnvVar =
      normalizeImportedBearerTokenEnvVar(value.bearerTokenEnvVar) ??
      normalizeImportedBearerTokenEnvVar(value.bearer_token_env_var)
    if (bearerTokenEnvVar) server.bearerTokenEnvVar = bearerTokenEnvVar
  }
  return { server, secretValues }
}

export function parseUserMcpServersImportJson(
  text: string,
  existingServers: readonly UserMcpServerConfig[] = []
): {
  servers: UserMcpServerConfig[]
  skipped: number
  secretValuesByServerId: Record<string, UserMcpServerSecretValues>
  error?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const tomlServers = parseCodexMcpServersToml(text)
    if (tomlServers) {
      parsed = { mcpServers: tomlServers }
    } else {
      return {
        servers: [],
        skipped: 0,
        secretValuesByServerId: {},
        error: 'Paste valid JSON or Codex MCP TOML before importing.'
      }
    }
  }
  if (!isPlainRecord(parsed)) {
    return {
      servers: [],
      skipped: 0,
      secretValuesByServerId: {},
      error: 'MCP import config must be an object.'
    }
  }
  const rawServers = isPlainRecord(parsed.mcpServers) ? parsed.mcpServers : parsed
  const usedNames = new Set(existingServers.map((server) => server.name.trim().toLowerCase()))
  const servers: UserMcpServerConfig[] = []
  const secretValuesByServerId: Record<string, UserMcpServerSecretValues> = {}
  let skipped = 0
  for (const [name, value] of Object.entries(rawServers)) {
    const result = buildImportedUserMcpServer(name, value, usedNames)
    if (result) {
      servers.push(result.server)
      if (
        Object.keys(result.secretValues.env).length > 0 ||
        Object.keys(result.secretValues.headers).length > 0
      ) {
        secretValuesByServerId[result.server.id] = result.secretValues
      }
    } else {
      skipped += 1
    }
  }
  if (servers.length === 0) {
    return {
      servers,
      skipped,
      secretValuesByServerId,
      error: 'No supported MCP servers found. Import entries need either command or url.'
    }
  }
  return { servers, skipped, secretValuesByServerId }
}

function userMcpServerAuditKey(server: UserMcpServerConfig): string {
  return server.name.trim() || server.id
}

function uniqueUserMcpServerAuditKey(server: UserMcpServerConfig, usedKeys: Set<string>): string {
  const base = userMcpServerAuditKey(server)
  let candidate = base
  let suffix = 2
  while (usedKeys.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}`
    suffix += 1
  }
  usedKeys.add(candidate.toLowerCase())
  return candidate
}

function slugForUserMcpProviderName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'server'
  )
}

function userMcpServerProviderKey(
  server: Pick<UserMcpServerConfig, 'id' | 'name'>,
  usedKeys: Set<string>
): string {
  const base = `user_${slugForUserMcpProviderName(server.name || server.id)}`
  let candidate = base
  let suffix = 2
  while (usedKeys.has(candidate) || candidate === 'TaskWraith') {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  usedKeys.add(candidate)
  return candidate
}

function userMcpServerAuditEntry(server: UserMcpServerConfig): Record<string, unknown> {
  const env =
    server.env && Object.keys(server.env).length > 0
      ? Object.fromEntries(
          Object.keys(server.env)
            .sort()
            .map((key) => [key, '[stored in TaskWraith settings]'])
        )
      : undefined
  const headers =
    server.headers && Object.keys(server.headers).length > 0
      ? Object.fromEntries(
          Object.keys(server.headers)
            .sort()
            .map((key) => [key, '[stored in TaskWraith settings]'])
        )
      : undefined
  const entry =
    server.transport === 'stdio'
      ? {
          type: 'stdio',
          command: server.command || '',
          ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
          ...(env ? { env } : {})
        }
      : {
          type: server.transport,
          url: server.url || '',
          ...(headers ? { headers } : {}),
          ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
          ...(env ? { env } : {})
        }
  return entry
}

export function formatUserMcpServerAuditJson(server: UserMcpServerConfig): string {
  return JSON.stringify(
    {
      mcpServers: {
        [userMcpServerAuditKey(server)]: userMcpServerAuditEntry(server)
      },
      taskwraith: {
        id: server.id,
        enabled: server.enabled,
        ...(server.pluginProvenance ? { pluginProvenance: server.pluginProvenance } : {})
      }
    },
    null,
    2
  )
}

export function formatUserMcpServersAuditJson(servers: readonly UserMcpServerConfig[]): string {
  const usedKeys = new Set<string>()
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        servers.map((server) => [
          uniqueUserMcpServerAuditKey(server, usedKeys),
          userMcpServerAuditEntry(server)
        ])
      ),
      taskwraith: {
        servers: servers.map((server) => ({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          ...(server.pluginProvenance ? { pluginProvenance: server.pluginProvenance } : {})
        }))
      }
    },
    null,
    2
  )
}

export function isCodexExportableUserMcpServer(server: UserMcpServerConfig): boolean {
  return server.enabled && server.transport !== 'sse' && hasRunnableUserMcpEndpoint(server)
}

export function isClaudeExportableUserMcpServer(server: UserMcpServerConfig): boolean {
  return server.enabled && hasRunnableUserMcpEndpoint(server)
}

export function isCursorExportableUserMcpServer(server: UserMcpServerConfig): boolean {
  return server.enabled && server.transport !== 'sse' && hasRunnableUserMcpEndpoint(server)
}

export function userMcpServerProviderExportLabels(server: UserMcpServerConfig): string[] {
  const labels: string[] = []
  if (isCodexExportableUserMcpServer(server)) labels.push('Codex TOML')
  if (isClaudeExportableUserMcpServer(server)) labels.push('Claude JSON')
  if (isCursorExportableUserMcpServer(server)) labels.push('Cursor mcp.json')
  return labels
}

function hasUserMcpAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
}

function userMcpServerRemoteHeaders(
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): Record<string, string> | undefined {
  const headers: Record<string, string> =
    server.headers && Object.keys(server.headers).length > 0
      ? Object.fromEntries(
          Object.keys(server.headers)
            .sort()
            .map((key) => [
              key,
              options.redactValues ? '[stored in TaskWraith settings]' : server.headers?.[key] || ''
            ])
        )
      : {}
  const bearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
  if (bearerTokenEnvVar && !hasUserMcpAuthorizationHeader(server.headers)) {
    headers.Authorization = options.redactValues
      ? '[stored in TaskWraith settings]'
      : `Bearer \${${bearerTokenEnvVar}}`
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function userMcpServerProviderEntry(
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const env =
      server.env && Object.keys(server.env).length > 0
        ? Object.fromEntries(
            Object.keys(server.env)
              .sort()
              .map((key) => [
                key,
                options.redactValues ? '[stored in TaskWraith settings]' : server.env?.[key] || ''
              ])
          )
        : undefined
    return {
      type: 'stdio',
      command: server.command?.trim() || '',
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(env ? { env } : {})
    }
  }
  const headers = userMcpServerRemoteHeaders(server, options)
  return {
    type: server.transport,
    url: server.url?.trim() || '',
    ...(headers ? { headers } : {})
  }
}

function findUserMcpServerProviderKey(
  servers: readonly UserMcpServerConfig[],
  targetServer: UserMcpServerConfig,
  isExportable: (server: UserMcpServerConfig) => boolean
): string | null {
  const usedKeys = new Set<string>()
  for (const server of servers) {
    if (!isExportable(server)) continue
    const key = userMcpServerProviderKey(server, usedKeys)
    if (server.id === targetServer.id) return key
  }
  return null
}

export function formatUserMcpServersClaudeJson(
  servers: readonly UserMcpServerConfig[],
  options: { redactValues?: boolean } = {}
): string {
  const usedKeys = new Set<string>()
  const mcpServers = Object.fromEntries(
    servers
      .filter(isClaudeExportableUserMcpServer)
      .map((server) => [
        userMcpServerProviderKey(server, usedKeys),
        userMcpServerProviderEntry(server, options)
      ])
  )
  return JSON.stringify({ mcpServers }, null, 2)
}

export function formatUserMcpServerClaudeJsonSnippet(
  servers: readonly UserMcpServerConfig[],
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): string {
  const providerKey = findUserMcpServerProviderKey(servers, server, isClaudeExportableUserMcpServer)
  if (!providerKey) return ''
  return JSON.stringify(
    { mcpServers: { [providerKey]: userMcpServerProviderEntry(server, options) } },
    null,
    2
  )
}

function userMcpServerCursorEntry(
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const env =
      server.env && Object.keys(server.env).length > 0
        ? Object.fromEntries(
            Object.keys(server.env)
              .sort()
              .map((key) => [
                key,
                options.redactValues ? '[stored in TaskWraith settings]' : server.env?.[key] || ''
              ])
          )
        : undefined
    return {
      command: server.command?.trim() || '',
      args: [...(server.args ?? [])],
      ...(env ? { env } : {})
    }
  }
  const headers = userMcpServerRemoteHeaders(server, options)
  return {
    url: server.url?.trim() || '',
    ...(headers ? { headers } : {})
  }
}

export function formatUserMcpServersCursorJson(
  servers: readonly UserMcpServerConfig[],
  options: { redactValues?: boolean } = {}
): string {
  const usedKeys = new Set<string>()
  const mcpServers = Object.fromEntries(
    servers
      .filter(isCursorExportableUserMcpServer)
      .map((server) => [
        userMcpServerProviderKey(server, usedKeys),
        userMcpServerCursorEntry(server, options)
      ])
  )
  return JSON.stringify({ mcpServers }, null, 2)
}

export function formatUserMcpServerCursorJsonSnippet(
  servers: readonly UserMcpServerConfig[],
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): string {
  const providerKey = findUserMcpServerProviderKey(servers, server, isCursorExportableUserMcpServer)
  if (!providerKey) return ''
  return JSON.stringify(
    { mcpServers: { [providerKey]: userMcpServerCursorEntry(server, options) } },
    null,
    2
  )
}

function formatUserMcpServerCodexTomlEntry(
  server: UserMcpServerConfig,
  providerKey: string,
  options: { redactValues?: boolean } = {}
): string {
  const tableKey = formatTomlKeyComponent(providerKey)
  const lines = [`[mcp_servers.${tableKey}]`]
  if (server.transport === 'stdio') {
    lines.push(`command = ${formatTomlBasicString(server.command?.trim() || '')}`)
    if (server.args && server.args.length > 0) {
      lines.push(`args = ${formatTomlStringArray(server.args)}`)
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = ${formatTomlStringInlineTable(server.env, options)}`)
    }
  } else {
    lines.push(`url = ${formatTomlBasicString(server.url?.trim() || '')}`)
    if (server.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${formatTomlBasicString(server.bearerTokenEnvVar)}`)
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`http_headers = ${formatTomlStringInlineTable(server.headers, options)}`)
    }
  }
  return lines.join('\n')
}

export function formatUserMcpServersCodexToml(
  servers: readonly UserMcpServerConfig[],
  options: { redactValues?: boolean } = {}
): string {
  const usedKeys = new Set<string>()
  const entries: string[] = []
  for (const server of servers) {
    if (!isCodexExportableUserMcpServer(server)) continue
    entries.push(
      formatUserMcpServerCodexTomlEntry(server, userMcpServerProviderKey(server, usedKeys), options)
    )
  }
  return entries.length > 0 ? entries.join('\n\n') : '# No enabled Codex-compatible MCP servers.'
}

export function formatUserMcpServerCodexTomlSnippet(
  servers: readonly UserMcpServerConfig[],
  server: UserMcpServerConfig,
  options: { redactValues?: boolean } = {}
): string {
  const providerKey = findUserMcpServerProviderKey(servers, server, isCodexExportableUserMcpServer)
  return providerKey ? formatUserMcpServerCodexTomlEntry(server, providerKey, options) : ''
}
