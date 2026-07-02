import { describe, expect, it } from 'vitest'
import {
  buildUserMcpCursorAllowRules,
  buildUserMcpCursorServerEntry,
  buildUserMcpLaunchServers,
  buildUserMcpServerName,
  buildUserMcpStdioLaunchServers,
  evaluateUserMcpLaunchPolicy
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
      },
      {
        id: 'bad-remote',
        name: 'Bad Remote',
        enabled: true,
        transport: 'http',
        url: 'ftp://example.test/mcp'
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

  it('filters launch servers through an optional enterprise allowlist policy', () => {
    const blocked: string[] = []
    const servers: UserMcpServerConfig[] = [
      {
        id: 'trusted-fs',
        name: 'Trusted FS',
        enabled: true,
        transport: 'stdio',
        command: '/opt/taskwraith/mcp/filesystem',
        args: ['/repo'],
        env: {
          PROJECT_ROOT: '/repo'
        }
      },
      {
        id: 'relative-command',
        name: 'Relative Command',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        env: {
          PROJECT_ROOT: '/repo'
        }
      },
      {
        id: 'wrong-env',
        name: 'Wrong Env',
        enabled: true,
        transport: 'stdio',
        command: '/opt/taskwraith/mcp/other',
        env: {
          UNAPPROVED_TOKEN: 'secret'
        }
      },
      {
        id: 'docs',
        name: 'Docs',
        enabled: true,
        transport: 'http',
        url: 'https://docs.example.test/mcp',
        headers: {
          'X-Workspace': 'engineering'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      },
      {
        id: 'evil',
        name: 'Evil',
        enabled: true,
        transport: 'http',
        url: 'https://evil.example.test/mcp',
        headers: {
          Authorization: 'Bearer ${EVIL_TOKEN}'
        },
        bearerTokenEnvVar: 'EVIL_TOKEN'
      },
      {
        id: 'legacy',
        name: 'Legacy SSE',
        enabled: true,
        transport: 'sse',
        url: 'https://docs.example.test/sse'
      }
    ]

    expect(
      buildUserMcpLaunchServers(servers, {
        allowlistPolicy: {
          allowedTransports: ['stdio', 'http'],
          allowedCommandRoots: ['/opt/taskwraith/mcp'],
          allowedRemoteHosts: ['docs.example.test'],
          allowedHeaderNames: ['Authorization', 'X-Workspace'],
          allowedEnvKeys: ['PROJECT_ROOT', 'DOCS_TOKEN']
        },
        onBlocked: (decision) => blocked.push(`${decision.serverId}:${decision.reason}`)
      })
    ).toEqual([
      {
        serverName: 'user_trusted_fs',
        transport: 'stdio',
        command: '/opt/taskwraith/mcp/filesystem',
        args: ['/repo'],
        env: {
          PROJECT_ROOT: '/repo'
        }
      },
      {
        serverName: 'user_docs',
        transport: 'http',
        url: 'https://docs.example.test/mcp',
        headers: {
          'X-Workspace': 'engineering'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      }
    ])
    expect(blocked).toEqual([
      'relative-command:command path is not allowlisted',
      'wrong-env:env key UNAPPROVED_TOKEN is not allowlisted',
      'evil:env key EVIL_TOKEN is not allowlisted',
      'legacy:transport sse is not allowlisted'
    ])
  })

  it('supports exact and wildcard remote host allowlists', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://api.docs.example.test/mcp'
        },
        { allowedRemoteHosts: ['*.docs.example.test'] }
      ).allowed
    ).toBe(true)
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'root',
          name: 'Root',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test/mcp'
        },
        { allowedRemoteHosts: ['*.docs.example.test'] }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'remote host is not allowlisted'
    })
  })

  it('treats bearer token env vars as synthesized Authorization headers for policy', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test/mcp',
          bearerTokenEnvVar: 'DOCS_TOKEN'
        },
        {
          allowedHeaderNames: ['X-Workspace'],
          allowedEnvKeys: ['DOCS_TOKEN']
        }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'header Authorization is not allowlisted'
    })
  })

  it('treats empty allowlist arrays as allow-none policies', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test/mcp',
          headers: {
            'X-Workspace': 'engineering'
          }
        },
        { allowedHeaderNames: [] }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'header X-Workspace is not allowlisted'
    })

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'plugin-docs',
          name: 'Plugin Docs',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/docs',
          pluginProvenance: {
            pluginId: 'docs',
            publisher: 'taskwraith',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.taskwraith.docs',
            manifestHash: 'abc123',
            kind: 'mcpServer',
            objectId: 'docs',
            materializedAt: '2026-07-03T12:00:00.000Z'
          }
        },
        { allowedPluginIds: [] }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'plugin id is not allowlisted'
    })
  })

  it('reserves provider-facing names for policy-blocked servers', () => {
    const blocked: string[] = []

    expect(
      buildUserMcpLaunchServers(
        [
          {
            id: 'blocked',
            name: 'Docs',
            enabled: true,
            transport: 'stdio',
            command: '/opt/taskwraith/mcp/docs',
            env: {
              UNAPPROVED_TOKEN: 'secret'
            }
          },
          {
            id: 'allowed',
            name: 'Docs',
            enabled: true,
            transport: 'stdio',
            command: '/opt/taskwraith/mcp/docs'
          }
        ],
        {
          allowlistPolicy: {
            allowedEnvKeys: []
          },
          onBlocked: (decision) => blocked.push(`${decision.serverName}:${decision.reason}`)
        }
      )
    ).toEqual([
      {
        serverName: 'user_docs_2',
        transport: 'stdio',
        command: '/opt/taskwraith/mcp/docs',
        args: []
      }
    ])
    expect(blocked).toEqual(['user_docs:env key UNAPPROVED_TOKEN is not allowlisted'])
  })

  it('requires absolute command roots when command-root policy is set', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'relative-root',
          name: 'Relative Root',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/server'
        },
        { allowedCommandRoots: ['opt/taskwraith/mcp'] }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'command path is not allowlisted'
    })
  })

  it('can require plugin provenance and restrict materialized plugin ids', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'manual',
          name: 'Manual',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/manual'
        },
        { requirePluginProvenance: true }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'mcpServer plugin provenance is required'
    })

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'workflow-template',
          name: 'Workflow Template',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/docs',
          pluginProvenance: {
            pluginId: 'docs',
            publisher: 'taskwraith',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.taskwraith.docs',
            manifestHash: 'abc123',
            kind: 'workflowTemplate',
            objectId: 'docs',
            materializedAt: '2026-07-03T12:00:00.000Z'
          }
        },
        { allowedPluginIds: ['docs'] }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'plugin id is not allowlisted'
    })

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'plugin-docs',
          name: 'Plugin Docs',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/docs',
          pluginProvenance: {
            pluginId: 'docs',
            publisher: 'taskwraith',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.taskwraith.docs',
            manifestHash: 'abc123',
            kind: 'mcpServer',
            objectId: 'docs',
            materializedAt: '2026-07-03T12:00:00.000Z'
          }
        },
        { allowedPluginIds: ['docs'] }
      ).allowed
    ).toBe(true)
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
          Authorization: 'Bearer ${DOCS_TOKEN}',
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
