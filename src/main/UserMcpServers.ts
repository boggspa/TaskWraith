import type { UserMcpServerConfig } from './store/types'

export interface UserMcpStdioLaunchServer {
  serverName: string
  command: string
  args: string[]
  env?: Record<string, string>
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

export function buildUserMcpStdioLaunchServers(
  servers: readonly UserMcpServerConfig[] | undefined
): UserMcpStdioLaunchServer[] {
  if (!Array.isArray(servers)) return []
  const usedNames = new Set<string>()
  const launchServers: UserMcpStdioLaunchServer[] = []
  for (const server of servers) {
    if (!server.enabled || server.transport !== 'stdio') continue
    const command = server.command?.trim()
    if (!command) continue
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
      serverName: buildUserMcpServerName(server, usedNames),
      command,
      args,
      ...(env && Object.keys(env).length > 0 ? { env } : {})
    })
  }
  return launchServers
}
