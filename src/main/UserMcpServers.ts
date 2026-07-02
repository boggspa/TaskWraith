import path from 'node:path'
import type { UserMcpServerConfig, UserMcpServerTransport } from './store/types'

export interface UserMcpStdioLaunchServer {
  serverName: string
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface UserMcpRemoteLaunchServer {
  serverName: string
  transport: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
}

export type UserMcpLaunchServer = UserMcpStdioLaunchServer | UserMcpRemoteLaunchServer

export interface UserMcpLaunchAllowlistPolicy {
  allowedTransports?: readonly UserMcpServerTransport[]
  allowedCommandRoots?: readonly string[]
  allowedRemoteHosts?: readonly string[]
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
  onBlocked?: (decision: UserMcpLaunchPolicyDecision) => void
}

type BuildUserMcpLaunchServersInput =
  | readonly UserMcpServerTransport[]
  | BuildUserMcpLaunchServersOptions
  | undefined

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
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
    return { supportedTransports: input }
  }
  return { ...input, supportedTransports: input?.supportedTransports ?? ['stdio', 'http', 'sse'] }
}

function normalizeCaseSet(values: readonly string[]): Set<string> {
  const normalized = values.map((value) => value.trim().toLowerCase()).filter(Boolean)
  return new Set(normalized)
}

function isAbsolutePathInside(command: string, root: string): boolean {
  const normalizedCommand = path.resolve(command)
  const normalizedRoot = path.resolve(root)
  if (normalizedCommand === normalizedRoot) return true
  const relative = path.relative(normalizedRoot, normalizedCommand)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isCommandAllowed(command: string, allowedCommandRoots: readonly string[]): boolean {
  if (!path.isAbsolute(command)) return false
  return allowedCommandRoots.some((root) => {
    const trimmed = root.trim()
    return trimmed && path.isAbsolute(trimmed) ? isAbsolutePathInside(command, trimmed) : false
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
    return {
      serverId: server.id,
      serverName: server.name || server.id,
      transport: server.transport,
      allowed: true
    }
  }

  if (policy.allowedRemoteHosts) {
    const url = server.url?.trim()
    if (!url || !isRemoteHostAllowed(url, policy.allowedRemoteHosts)) {
      return blockedDecision(server, 'remote host is not allowlisted')
    }
  }

  if (policy.allowedHeaderNames) {
    const allowedHeaderNames = normalizeCaseSet(policy.allowedHeaderNames)
    const headerNames = Object.keys(server.headers ?? {})
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
      launchServers.push({
        serverName,
        transport: 'stdio',
        command,
        args,
        ...(env && Object.keys(env).length > 0 ? { env } : {})
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
    const rawBearerTokenEnvVar = server.bearerTokenEnvVar?.trim()
    const bearerTokenEnvVar =
      rawBearerTokenEnvVar && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rawBearerTokenEnvVar)
        ? rawBearerTokenEnvVar
        : undefined
    launchServers.push({
      serverName,
      transport: server.transport,
      url,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {})
    })
  }
  return launchServers
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
