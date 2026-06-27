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
  supportedTransports: readonly UserMcpServerTransport[] = ['stdio', 'http', 'sse']
): UserMcpLaunchServer[] {
  if (!Array.isArray(servers)) return []
  const supported = new Set<UserMcpServerTransport>(supportedTransports)
  const usedNames = new Set<string>()
  const launchServers: UserMcpLaunchServer[] = []
  for (const server of servers) {
    if (!server.enabled || !supported.has(server.transport)) continue
    if (server.transport === 'stdio') {
      const command = server.command?.trim()
      if (!command) continue
      const serverName = buildUserMcpServerName(server, usedNames)
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
    servers.map((server) => [
      server.serverName,
      server.transport === 'stdio'
        ? {
            command: server.command,
            args: [...server.args],
            ...(server.env ? { env: { ...server.env } } : {})
          }
        : {
            url: server.url,
            ...(server.headers ? { headers: { ...server.headers } } : {})
          }
    ])
  )
}

export function buildUserMcpCursorAllowRules(
  servers: readonly UserMcpLaunchServer[]
): string[] {
  return servers.map((server) => `Mcp(${server.serverName}:*)`)
}
