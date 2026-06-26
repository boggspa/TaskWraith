import { describe, expect, it } from 'vitest'
import { buildUserMcpServerName, buildUserMcpStdioLaunchServers } from './UserMcpServers'
import type { UserMcpServerConfig } from './store/types'

describe('buildUserMcpStdioLaunchServers', () => {
  it('keeps enabled stdio servers and drops disabled or remote transports', () => {
    const servers: UserMcpServerConfig[] = [
      {
        id: 'filesystem',
        name: 'Filesystem',
        enabled: true,
        transport: 'stdio',
        command: ' npx ',
        args: [' @modelcontextprotocol/server-filesystem ', '/repo'],
        env: {
          PROJECT_ROOT: '/repo',
          'bad-key': 'drop'
        }
      },
      {
        id: 'remote',
        name: 'Remote MCP',
        enabled: true,
        transport: 'http',
        url: 'http://127.0.0.1:3000/mcp'
      },
      {
        id: 'disabled',
        name: 'Disabled',
        enabled: false,
        transport: 'stdio',
        command: 'node'
      }
    ]

    expect(buildUserMcpStdioLaunchServers(servers)).toEqual([
      {
        serverName: 'user_filesystem',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '/repo'],
        env: {
          PROJECT_ROOT: '/repo'
        }
      }
    ])
  })

  it('deduplicates provider-facing names without changing the saved server ids', () => {
    const used = new Set<string>()

    expect(buildUserMcpServerName({ id: 'a', name: 'Docs Search' }, used)).toBe(
      'user_docs_search'
    )
    expect(buildUserMcpServerName({ id: 'b', name: 'Docs Search' }, used)).toBe(
      'user_docs_search_2'
    )
  })
})
