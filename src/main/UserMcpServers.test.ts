import { describe, expect, it } from 'vitest'
import {
  buildUserMcpCursorAllowRules,
  buildUserMcpCursorServerEntry,
  buildUserMcpLaunchServers,
  buildUserMcpServerName,
  buildUserMcpStdioLaunchServers
} from './UserMcpServers'
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
        transport: 'stdio',
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

  it('keeps enabled remote servers when their transport is supported', () => {
    const servers: UserMcpServerConfig[] = [
      {
        id: 'docs',
        name: 'Docs',
        enabled: true,
        transport: 'http',
        url: ' https://example.test/mcp ',
        headers: {
          Authorization: 'Bearer ${DOCS_TOKEN}',
          'bad header': 'drop'
        },
        bearerTokenEnvVar: ' DOCS_TOKEN '
      },
      {
        id: 'legacy',
        name: 'Legacy SSE',
        enabled: true,
        transport: 'sse',
        url: 'https://example.test/sse',
        headers: {
          'X-Region': 'eu'
        }
      }
    ]

    expect(buildUserMcpLaunchServers(servers, ['stdio', 'http'])).toEqual([
      {
        serverName: 'user_docs',
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {
          Authorization: 'Bearer ${DOCS_TOKEN}'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      }
    ])
    expect(buildUserMcpLaunchServers(servers, ['sse'])).toEqual([
      {
        serverName: 'user_legacy_sse',
        transport: 'sse',
        url: 'https://example.test/sse',
        headers: {
          'X-Region': 'eu'
        }
      }
    ])
  })

  it('builds Cursor mcp.json entries and allow rules from sanitized launch servers', () => {
    const launchServers = buildUserMcpLaunchServers(
      [
        {
          id: 'filesystem',
          name: 'Filesystem',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/repo'],
          env: { PROJECT_ROOT: '/repo' }
        },
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: {
            'X-Region': 'eu'
          },
          bearerTokenEnvVar: 'DOCS_TOKEN'
        }
      ],
      ['stdio', 'http']
    )

    const entry = buildUserMcpCursorServerEntry(launchServers)
    expect(entry).toEqual({
      user_filesystem: {
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '/repo'],
        env: { PROJECT_ROOT: '/repo' }
      },
      user_docs: {
        url: 'https://example.test/mcp',
        headers: {
          'X-Region': 'eu'
        }
      }
    })
    expect(buildUserMcpCursorAllowRules(launchServers)).toEqual([
      'Mcp(user_filesystem:*)',
      'Mcp(user_docs:*)'
    ])
  })
})
