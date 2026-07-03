import fs from 'node:fs'
import path from 'node:path'
import {
  extensionSecretKey,
  type ExtensionSecretRef,
  type ExtensionSecretResolution
} from './ExtensionSecretStore'
import type { UserMcpServerConfig, UserMcpServerTransport } from './store/types'

export interface UserMcpStdioLaunchServer {
  serverName: string
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  providerEnv?: Record<string, string>
}

export interface UserMcpRemoteLaunchServer {
  serverName: string
  transport: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
  providerEnv?: Record<string, string>
}

export type UserMcpLaunchServer = UserMcpStdioLaunchServer | UserMcpRemoteLaunchServer

export interface UserMcpLaunchAllowlistPolicy {
  allowedTransports?: readonly UserMcpServerTransport[]
  allowedCommandRoots?: readonly string[]
  allowedCommandArgPrefixes?: readonly string[]
  allowedRemoteSchemes?: readonly ('http' | 'https')[]
  allowedRemoteHosts?: readonly string[]
  allowedRemotePorts?: readonly number[]
  allowedRemotePathPrefixes?: readonly string[]
  allowedHeaderNames?: readonly string[]
  allowedEnvKeys?: readonly string[]
  requirePluginProvenance?: boolean
  allowedPluginIds?: readonly string[]
}

export interface UserMcpLaunchPolicyDecision {
  serverId: string
  serverName: string
  transport: UserMcpServerTransport
  allowed: boolean
  reason?: string
}

export interface BuildUserMcpLaunchServersOptions {
  supportedTransports?: readonly UserMcpServerTransport[]
  allowlistPolicy?: UserMcpLaunchAllowlistPolicy
  resolveSecretValues?: (refs: ExtensionSecretRef[]) => ExtensionSecretResolution[]
  validatePluginProvenance?: (server: UserMcpServerConfig) => string | undefined
  onBlocked?: (decision: UserMcpLaunchPolicyDecision) => void
}

type BuildUserMcpLaunchServersInput =
  | readonly UserMcpServerTransport[]
  | BuildUserMcpLaunchServersOptions
  | undefined

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
}

function uniqueValidEnvKeys(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
      )
    )
  ).slice(0, 64)
}

function uniqueValidHeaderNames(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(
    new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
      )
    )
  ).slice(0, 64)
}

function slugForMcpServer(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'server'
  )
}

function isValidUserMcpRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeBuildOptions(
  input: BuildUserMcpLaunchServersInput
): Required<Pick<BuildUserMcpLaunchServersOptions, 'supportedTransports'>> &
  Omit<BuildUserMcpLaunchServersOptions, 'supportedTransports'> {
  if (Array.isArray(input)) {
    return { supportedTransports: input as readonly UserMcpServerTransport[] }
  }
  const options = (input ?? {}) as BuildUserMcpLaunchServersOptions
  return { ...options, supportedTransports: options.supportedTransports ?? ['stdio', 'http', 'sse'] }
}

function normalizeCaseSet(values: readonly string[]): Set<string> {
  const normalized = values.map((value) => value.trim().toLowerCase()).filter(Boolean)
  return new Set(normalized)
}

function isAbsolutePathInside(command: string, root: string): boolean {
  const normalizedCommand = realpathOrResolved(command)
  const normalizedRoot = realpathOrResolved(root)
  if (normalizedCommand === normalizedRoot) return true
  const relative = path.relative(normalizedRoot, normalizedCommand)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function realpathOrResolved(value: string): string {
  try {
    return fs.realpathSync.native(value)
  } catch {
    return path.resolve(value)
  }
}

function isCommandAllowed(command: string, allowedCommandRoots: readonly string[]): boolean {
  if (!path.isAbsolute(command)) return false
  return allowedCommandRoots.some((root) => {
    const trimmed = root.trim()
    return trimmed && path.isAbsolute(trimmed) ? isAbsolutePathInside(command, trimmed) : false
  })
}

function isCommandArgAllowed(arg: string, allowedPrefixes: readonly string[]): boolean {
  return allowedPrefixes.some((prefix) => {
    const normalized = prefix.trim()
    return Boolean(normalized && arg.startsWith(normalized))
  })
}

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase()
  const normalizedPattern = pattern.trim().toLowerCase()
  if (!normalizedHost || !normalizedPattern) return false
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2)
    return normalizedHost.endsWith(`.${suffix}`) && normalizedHost !== suffix
  }
  return normalizedHost === normalizedPattern
}

function isRemoteHostAllowed(url: string, allowedRemoteHosts: readonly string[]): boolean {
  try {
    const hostname = new URL(url).hostname
    return allowedRemoteHosts.some((pattern) => hostMatchesPattern(hostname, pattern))
  } catch {
    return false
  }
}

function parseRemoteUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

function effectiveRemotePort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'http:' ? 80 : 443
}

function remotePathMatchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const normalized = prefix.trim()
    if (!normalized) return false
    const pathPrefix = normalized.startsWith('/') ? normalized : `/${normalized}`
    return (
      pathname === pathPrefix ||
      pathname.startsWith(pathPrefix.endsWith('/') ? pathPrefix : `${pathPrefix}/`)
    )
  })
}

function blockedDecision(
  server: UserMcpServerConfig,
  reason: string
): UserMcpLaunchPolicyDecision {
  return {
    serverId: server.id,
    serverName: server.name || server.id,
    transport: server.transport,
    allowed: false,
    reason
  }
}

export function evaluateUserMcpLaunchPolicy(
  server: UserMcpServerConfig,
  policy: UserMcpLaunchAllowlistPolicy | undefined
): UserMcpLaunchPolicyDecision {
  if (!policy) {
    return {
      serverId: server.id,
      serverName: server.name || server.id,
      transport: server.transport,
      allowed: true
    }
  }

  const allowedTransports = policy.allowedTransports
    ? new Set<UserMcpServerTransport>(policy.allowedTransports)
    : undefined
  if (allowedTransports && !allowedTransports.has(server.transport)) {
    return blockedDecision(server, `transport ${server.transport} is not allowlisted`)
  }

  if (policy.requirePluginProvenance && server.pluginProvenance?.kind !== 'mcpServer') {
    return blockedDecision(server, 'mcpServer plugin provenance is required')
  }

  if (policy.allowedPluginIds) {
    const allowedPluginIds = normalizeCaseSet(policy.allowedPluginIds)
    const pluginId = server.pluginProvenance?.pluginId?.trim().toLowerCase()
    if (
      server.pluginProvenance?.kind !== 'mcpServer' ||
      !pluginId ||
      !allowedPluginIds.has(pluginId)
    ) {
      return blockedDecision(server, 'plugin id is not allowlisted')
    }
  }

  if (policy.allowedEnvKeys) {
    const allowedEnvKeys = normalizeCaseSet(policy.allowedEnvKeys)
    const envKeys = Object.keys(server.env ?? {})
    envKeys.push(...uniqueValidEnvKeys(server.secretRefs?.env))
    const rawBearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
    if (rawBearerTokenEnvVar) envKeys.push(rawBearerTokenEnvVar)
    const blockedKey = envKeys.find((key) => !allowedEnvKeys.has(key.toLowerCase()))
    if (blockedKey) {
      return blockedDecision(server, `env key ${blockedKey} is not allowlisted`)
    }
  }

  if (server.transport === 'stdio') {
    if (policy.allowedCommandRoots) {
      const command = server.command?.trim()
      if (!command || !isCommandAllowed(command, policy.allowedCommandRoots)) {
        return blockedDecision(server, 'command path is not allowlisted')
      }
    }
    if (policy.allowedCommandArgPrefixes) {
      const args = Array.isArray(server.args) ? server.args : []
      const allowedPrefixes = policy.allowedCommandArgPrefixes
      const blockedIndex = args.findIndex((arg) => !isCommandArgAllowed(arg, allowedPrefixes))
      if (blockedIndex >= 0) {
        return blockedDecision(server, `command argument ${blockedIndex + 1} is not allowlisted`)
      }
    }
    return {
      serverId: server.id,
      serverName: server.name || server.id,
      transport: server.transport,
      allowed: true
    }
  }

  const parsedRemoteUrl = parseRemoteUrl(server.url?.trim())
  if (
    policy.allowedRemoteSchemes ||
    policy.allowedRemoteHosts ||
    policy.allowedRemotePorts ||
    policy.allowedRemotePathPrefixes ||
    server.url?.includes('@')
  ) {
    if (!parsedRemoteUrl) return blockedDecision(server, 'remote URL is invalid')
    if (parsedRemoteUrl.username || parsedRemoteUrl.password) {
      return blockedDecision(server, 'remote URL userinfo is not allowed')
    }
  }

  if (policy.allowedRemoteSchemes && parsedRemoteUrl) {
    const scheme = parsedRemoteUrl.protocol.replace(/:$/, '') as 'http' | 'https'
    if (!policy.allowedRemoteSchemes.includes(scheme)) {
      return blockedDecision(server, 'remote scheme is not allowlisted')
    }
  }

  if (policy.allowedRemoteHosts) {
    const url = server.url?.trim()
    if (!url || !isRemoteHostAllowed(url, policy.allowedRemoteHosts)) {
      return blockedDecision(server, 'remote host is not allowlisted')
    }
  }

  if (policy.allowedRemotePorts && parsedRemoteUrl) {
    const port = effectiveRemotePort(parsedRemoteUrl)
    if (!policy.allowedRemotePorts.includes(port)) {
      return blockedDecision(server, `remote port ${port} is not allowlisted`)
    }
  }

  if (
    policy.allowedRemotePathPrefixes &&
    parsedRemoteUrl &&
    !remotePathMatchesPrefix(parsedRemoteUrl.pathname, policy.allowedRemotePathPrefixes)
  ) {
    return blockedDecision(server, 'remote path is not allowlisted')
  }

  if (policy.allowedHeaderNames) {
    const allowedHeaderNames = normalizeCaseSet(policy.allowedHeaderNames)
    const headerNames = Object.keys(server.headers ?? {})
    headerNames.push(...uniqueValidHeaderNames(server.secretRefs?.headers))
    const rawBearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
    if (rawBearerTokenEnvVar && !hasAuthorizationHeader(server.headers)) {
      headerNames.push('Authorization')
    }
    const blockedHeader = headerNames.find(
      (header) => !allowedHeaderNames.has(header.toLowerCase())
    )
    if (blockedHeader) {
      return blockedDecision(server, `header ${blockedHeader} is not allowlisted`)
    }
  }

  return {
    serverId: server.id,
    serverName: server.name || server.id,
    transport: server.transport,
    allowed: true
  }
}

function secretRefsForServer(
  server: UserMcpServerConfig,
  fieldKind: 'env' | 'header'
): ExtensionSecretRef[] {
  const names =
    fieldKind === 'env'
      ? uniqueValidEnvKeys(server.secretRefs?.env)
      : uniqueValidHeaderNames(server.secretRefs?.headers)
  return names.map((fieldName) => ({
    ownerKind: 'userMcpServer' as const,
    ownerId: server.id,
    fieldKind,
    fieldName
  }))
}

function resolveSecretMap(
  server: UserMcpServerConfig,
  refs: ExtensionSecretRef[],
  resolver: BuildUserMcpLaunchServersOptions['resolveSecretValues']
): { values: Record<string, string>; error?: string } {
  if (refs.length === 0) return { values: {} }
  if (!resolver) return { values: {}, error: 'secret resolver is unavailable' }
  const resolutions = resolver(refs)
  const byKey = new Map<string, ExtensionSecretResolution>()
  for (const resolution of resolutions) {
    if (resolution.ref) byKey.set(extensionSecretKey(resolution.ref), resolution)
  }
  const values: Record<string, string> = {}
  for (const ref of refs) {
    const resolution = byKey.get(extensionSecretKey(ref))
    if (!resolution || resolution.status !== 'ok' || typeof resolution.value !== 'string') {
      return {
        values: {},
        error: `secret ${ref.fieldKind} ${ref.fieldName} for ${server.id} is ${resolution?.status ?? 'missing'}`
      }
    }
    values[ref.fieldName] = resolution.value
  }
  return { values }
}

export function buildUserMcpServerName(
  server: Pick<UserMcpServerConfig, 'id' | 'name'>,
  usedNames: Set<string>
): string {
  const base = `user_${slugForMcpServer(server.name || server.id)}`
  let candidate = base
  let suffix = 2
  while (usedNames.has(candidate) || candidate === 'TaskWraith') {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  usedNames.add(candidate)
  return candidate
}

export function buildUserMcpLaunchServers(
  servers: readonly UserMcpServerConfig[] | undefined,
  optionsInput?: BuildUserMcpLaunchServersInput
): UserMcpLaunchServer[] {
  if (!Array.isArray(servers)) return []
  const options = normalizeBuildOptions(optionsInput)
  const supported = new Set<UserMcpServerTransport>(options.supportedTransports)
  const usedNames = new Set<string>()
  const launchServers: UserMcpLaunchServer[] = []
  for (const server of servers) {
    if (!server.enabled || !supported.has(server.transport)) continue
    if (server.transport === 'stdio') {
      const command = server.command?.trim()
      if (!command) continue
      const serverName = buildUserMcpServerName(server, usedNames)
      const policyDecision = evaluateUserMcpLaunchPolicy(server, options.allowlistPolicy)
      if (!policyDecision.allowed) {
        options.onBlocked?.({ ...policyDecision, serverName })
        continue
      }
      const pluginProvenanceError = options.validatePluginProvenance?.(server)
      if (pluginProvenanceError) {
        options.onBlocked?.({
          serverId: server.id,
          serverName,
          transport: server.transport,
          allowed: false,
          reason: pluginProvenanceError
        })
        continue
      }
      const secretEnv = resolveSecretMap(
        server,
        secretRefsForServer(server, 'env'),
        options.resolveSecretValues
      )
      if (secretEnv.error) {
        options.onBlocked?.({
          serverId: server.id,
          serverName,
          transport: server.transport,
          allowed: false,
          reason: secretEnv.error
        })
        continue
      }
      const args = Array.isArray(server.args)
        ? server.args.map((arg) => arg.trim()).filter(Boolean)
        : []
      const env =
        server.env && Object.keys(server.env).length > 0
          ? Object.fromEntries(
              Object.entries(server.env).filter(
                (entry): entry is [string, string] =>
                  /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && typeof entry[1] === 'string'
              )
            )
          : undefined
      const mergedEnv = {
        ...(env ?? {}),
        ...secretEnv.values
      }
      launchServers.push({
        serverName,
        transport: 'stdio',
        command,
        args,
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {})
      })
      continue
    }
    const url = server.url?.trim()
    if (!url || !isValidUserMcpRemoteUrl(url)) continue
    const serverName = buildUserMcpServerName(server, usedNames)
    const policyDecision = evaluateUserMcpLaunchPolicy(server, options.allowlistPolicy)
    if (!policyDecision.allowed) {
      options.onBlocked?.({ ...policyDecision, serverName })
      continue
    }
    const pluginProvenanceError = options.validatePluginProvenance?.(server)
    if (pluginProvenanceError) {
      options.onBlocked?.({
        serverId: server.id,
        serverName,
        transport: server.transport,
        allowed: false,
        reason: pluginProvenanceError
      })
      continue
    }
    const secretHeaders = resolveSecretMap(
      server,
      secretRefsForServer(server, 'header'),
      options.resolveSecretValues
    )
    if (secretHeaders.error) {
      options.onBlocked?.({
        serverId: server.id,
        serverName,
        transport: server.transport,
        allowed: false,
        reason: secretHeaders.error
      })
      continue
    }
    const secretProviderEnv = resolveSecretMap(
      server,
      secretRefsForServer(server, 'env'),
      options.resolveSecretValues
    )
    if (secretProviderEnv.error) {
      options.onBlocked?.({
        serverId: server.id,
        serverName,
        transport: server.transport,
        allowed: false,
        reason: secretProviderEnv.error
      })
      continue
    }
    const headers =
      server.headers && Object.keys(server.headers).length > 0
        ? Object.fromEntries(
            Object.entries(server.headers).filter(
              (entry): entry is [string, string] =>
                /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry[0]) &&
                typeof entry[1] === 'string'
            )
          )
        : undefined
    const mergedHeaders = {
      ...(headers ?? {}),
      ...secretHeaders.values
    }
    const rawBearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
    const bearerTokenEnvVar =
      rawBearerTokenEnvVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawBearerTokenEnvVar)
        ? rawBearerTokenEnvVar
        : undefined
    launchServers.push({
      serverName,
      transport: server.transport,
      url,
      ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
      ...(Object.keys(secretProviderEnv.values).length > 0
        ? { providerEnv: secretProviderEnv.values }
        : {})
    })
  }
  return launchServers
}

export function collectUserMcpProviderEnv(
  servers: readonly UserMcpLaunchServer[] | undefined
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const server of servers ?? []) {
    Object.assign(env, server.providerEnv ?? {})
  }
  return env
}

export function buildUserMcpRemoteHeaders(
  server: Pick<UserMcpRemoteLaunchServer, 'headers' | 'bearerTokenEnvVar'>
): Record<string, string> | undefined {
  const headers = server.headers ? { ...server.headers } : {}
  const bearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
  if (
    bearerTokenEnvVar &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar) &&
    !hasAuthorizationHeader(headers)
  ) {
    headers.Authorization = `Bearer \${${bearerTokenEnvVar}}`
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

export function buildUserMcpStdioLaunchServers(
  servers: readonly UserMcpServerConfig[] | undefined
): UserMcpStdioLaunchServer[] {
  return buildUserMcpLaunchServers(servers, ['stdio']).filter(
    (server): server is UserMcpStdioLaunchServer => server.transport === 'stdio'
  )
}

export function buildUserMcpCursorServerEntry(
  servers: readonly UserMcpLaunchServer[]
): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((server) => {
      if (server.transport === 'stdio') {
        return [
          server.serverName,
          {
            command: server.command,
            args: [...server.args],
            ...(server.env ? { env: { ...server.env } } : {})
          }
        ]
      }
      const headers = buildUserMcpRemoteHeaders(server)
      return [
        server.serverName,
        {
          url: server.url,
          ...(headers ? { headers } : {})
        }
      ]
    })
  )
}

export function buildUserMcpCursorAllowRules(
  servers: readonly UserMcpLaunchServer[]
): string[] {
  return servers.map((server) => `Mcp(${server.serverName}:*)`)
}
