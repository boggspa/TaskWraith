import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildUserMcpCursorAllowRules,
  buildUserMcpCursorServerEntry,
  buildUserMcpLaunchServers,
  buildUserMcpServerName,
  buildUserMcpStdioLaunchServers,
  collectUserMcpProviderEnv,
  evaluateUserMcpLaunchPolicy
} from './UserMcpServers'
import type { ExtensionSecretRef, ExtensionSecretResolution } from './ExtensionSecretStore'
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

  it('resolves encrypted secret refs into launch env and remote headers at the launch boundary', () => {
    const resolveSecretValues = (refs: ExtensionSecretRef[]): ExtensionSecretResolution[] =>
      refs.map((ref) => ({
        ref,
        status: 'ok',
        value: `${ref.fieldName}-secret`
      }))

    const launchServers = buildUserMcpLaunchServers(
      [
        {
          id: 'filesystem',
          name: 'Filesystem',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/repo'],
          env: { PROJECT_ROOT: '/repo' },
          secretRefs: { env: ['FILESYSTEM_TOKEN'] }
        },
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: { 'X-Region': 'eu' },
          bearerTokenEnvVar: 'DOCS_TOKEN',
          secretRefs: {
            env: ['DOCS_TOKEN'],
            headers: ['X-API-Key']
          }
        }
      ],
      {
        supportedTransports: ['stdio', 'http'],
        resolveSecretValues
      }
    )

    expect(launchServers).toEqual([
      {
        serverName: 'user_filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '/repo'],
        env: {
          PROJECT_ROOT: '/repo',
          FILESYSTEM_TOKEN: 'FILESYSTEM_TOKEN-secret'
        }
      },
      {
        serverName: 'user_docs',
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {
          'X-Region': 'eu',
          'X-API-Key': 'X-API-Key-secret'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN',
        providerEnv: {
          DOCS_TOKEN: 'DOCS_TOKEN-secret'
        }
      }
    ])
    expect(collectUserMcpProviderEnv(launchServers)).toEqual({
      DOCS_TOKEN: 'DOCS_TOKEN-secret'
    })
  })

  it('blocks launch when a configured secret ref cannot be resolved', () => {
    const blocked: string[] = []

    expect(
      buildUserMcpLaunchServers(
        [
          {
            id: 'docs',
            name: 'Docs',
            enabled: true,
            transport: 'http',
            url: 'https://example.test/mcp',
            secretRefs: { headers: ['Authorization'] }
          }
        ],
        {
          supportedTransports: ['http'],
          resolveSecretValues: (refs) =>
            refs.map((ref) => ({
              ref,
              status: 'missing'
            })),
          onBlocked: (decision) => blocked.push(`${decision.serverName}:${decision.reason}`)
        }
      )
    ).toEqual([])
    expect(blocked).toEqual(['user_docs:secret header Authorization for docs is missing'])
  })

  it('applies enterprise allowlists to secret-ref env and header names before resolution', () => {
    const blocked: string[] = []

    expect(
      buildUserMcpLaunchServers(
        [
          {
            id: 'docs',
            name: 'Docs',
            enabled: true,
            transport: 'http',
            url: 'https://docs.example.test/mcp',
            secretRefs: {
              env: ['DOCS_TOKEN'],
              headers: ['X-API-Key']
            }
          }
        ],
        {
          supportedTransports: ['http'],
          allowlistPolicy: {
            allowedRemoteHosts: ['docs.example.test'],
            allowedHeaderNames: ['Authorization'],
            allowedEnvKeys: ['OTHER_TOKEN']
          },
          resolveSecretValues: () => {
            throw new Error('allowlist must run before secret resolution')
          },
          onBlocked: (decision) => blocked.push(`${decision.serverName}:${decision.reason}`)
        }
      )
    ).toEqual([])
    expect(blocked).toEqual(['user_docs:env key DOCS_TOKEN is not allowlisted'])
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

  it('can constrain managed remote MCP URLs by scheme, port, path, and userinfo', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test:8443/mcp/v1'
        },
        {
          allowedRemoteSchemes: ['https'],
          allowedRemoteHosts: ['docs.example.test'],
          allowedRemotePorts: [8443],
          allowedRemotePathPrefixes: ['/mcp']
        }
      ).allowed
    ).toBe(true)

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'userinfo',
          name: 'Userinfo',
          enabled: true,
          transport: 'http',
          url: 'https://user:pass@docs.example.test/mcp'
        },
        { allowedRemoteHosts: ['docs.example.test'] }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'remote URL userinfo is not allowed'
    })

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'wrong-path',
          name: 'Wrong Path',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test/private'
        },
        {
          allowedRemoteSchemes: ['https'],
          allowedRemoteHosts: ['docs.example.test'],
          allowedRemotePorts: [443],
          allowedRemotePathPrefixes: ['/mcp']
        }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'remote path is not allowlisted'
    })

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'wrong-segment',
          name: 'Wrong Segment',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test/mcp-evil'
        },
        {
          allowedRemotePathPrefixes: ['/mcp']
        }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'remote path is not allowlisted'
    })
  })

  it('can block private and local remote MCP hosts under managed policy', () => {
    for (const url of [
      'http://localhost/mcp',
      'http://127.0.0.1/mcp',
      'http://10.0.0.5/mcp',
      'http://172.16.0.5/mcp',
      'http://192.168.1.5/mcp',
      'http://169.254.169.254/mcp',
      'http://metadata/mcp',
      'http://metadata.google.internal/mcp',
      'http://instance-data/mcp',
      'http://instance-data.ec2.internal/mcp',
      'http://[::1]/mcp',
      'http://[::ffff:127.0.0.1]/mcp',
      'http://[64:ff9b::a9fe:a9fe]/mcp',
      'http://[64:ff9b:0:0:0:0:a9fe:a9fe]/mcp',
      'http://[fd00::1]/mcp',
      'http://[fe80::1]/mcp'
    ]) {
      expect(
        evaluateUserMcpLaunchPolicy(
          {
            id: 'private',
            name: 'Private',
            enabled: true,
            transport: 'http',
            url
          },
          { blockPrivateRemoteHosts: true }
        )
      ).toMatchObject({
        allowed: false,
        reason: 'remote host is private or local'
      })
    }

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://docs.example.test/mcp'
        },
        { blockPrivateRemoteHosts: true }
      ).allowed
    ).toBe(true)

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'public-nat64',
          name: 'Public NAT64',
          enabled: true,
          transport: 'http',
          url: 'https://[64:ff9b::0808:0808]/mcp'
        },
        { blockPrivateRemoteHosts: true }
      ).allowed
    ).toBe(true)
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

  it('can restrict stdio command arguments through managed prefix allowlists', () => {
    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'trusted-args',
          name: 'Trusted Args',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/server',
          args: ['--config=/opt/taskwraith/config/docs.json', '/opt/taskwraith/config/workspace']
        },
        {
          allowedCommandRoots: ['/opt/taskwraith/mcp'],
          allowedCommandArgPrefixes: ['--config=/opt/taskwraith/config/', '/opt/taskwraith/config/']
        }
      ).allowed
    ).toBe(true)

    expect(
      evaluateUserMcpLaunchPolicy(
        {
          id: 'unsafe-arg',
          name: 'Unsafe Arg',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/server',
          args: ['--config=/tmp/exfil.json']
        },
        {
          allowedCommandRoots: ['/opt/taskwraith/mcp'],
          allowedCommandArgPrefixes: ['--config=/opt/taskwraith/config/']
        }
      )
    ).toMatchObject({
      allowed: false,
      reason: 'command argument 1 is not allowlisted'
    })
  })

  it('resolves symlinked stdio commands before applying command-root allowlists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-user-mcp-'))
    try {
      const allowedRoot = path.join(tempDir, 'allowed')
      const outsideRoot = path.join(tempDir, 'outside')
      fs.mkdirSync(allowedRoot)
      fs.mkdirSync(outsideRoot)
      const outsideCommand = path.join(outsideRoot, 'server')
      fs.writeFileSync(outsideCommand, '#!/bin/sh\n')
      const symlinkedCommand = path.join(allowedRoot, 'server')
      fs.symlinkSync(outsideCommand, symlinkedCommand)

      expect(
        evaluateUserMcpLaunchPolicy(
          {
            id: 'symlink',
            name: 'Symlink',
            enabled: true,
            transport: 'stdio',
            command: symlinkedCommand
          },
          { allowedCommandRoots: [allowedRoot] }
        )
      ).toMatchObject({
        allowed: false,
        reason: 'command path is not allowlisted'
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
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

  it('blocks launch when a plugin provenance validator rejects the saved server', () => {
    const blocked: string[] = []
    expect(
      buildUserMcpLaunchServers(
        [
          {
            id: 'plugin-docs',
            name: 'Plugin Docs',
            enabled: true,
            transport: 'stdio',
            command: '/opt/taskwraith/mcp/docs',
            pluginProvenance: {
              pluginId: 'docs',
              publisher: 'acme',
              version: '1.0.0',
              source: 'builtin',
              namespace: 'plugin.acme.docs',
              manifestHash: 'sha256:abc123',
              kind: 'mcpServer',
              objectId: 'docs-stdio',
              materializedAt: '2026-07-03T12:00:00.000Z'
            }
          }
        ],
        {
          validatePluginProvenance: () => 'plugin provenance does not match the installed manifest',
          onBlocked: (decision) => blocked.push(`${decision.serverName}:${decision.reason}`)
        }
      )
    ).toEqual([])
    expect(blocked).toEqual([
      'user_plugin_docs:plugin provenance does not match the installed manifest'
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
