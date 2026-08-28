import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { HostProjectionClient } from '../host-client/HostProjectionClient'
import {
  hostStandaloneAntigravityStatus,
  hostStandaloneComposedProviderIds
} from '../host-shared/HostStandaloneProviderMatrix'
import { HOST_PROFILE_AUTHORITY_LEASE_FILENAME } from '../host-runtime/HostProfileAuthorityLease'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../shared/retiredProviders'
import {
  taskWraithHostDiscoveryPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'

import { createHostNodeProductionServer } from './HostNodeProductionFactory'

const paths: string[] = []
afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('creates a production server for a cold profile without touching Desktop state', () => {
  const parent = mkdtempSync(join(tmpdir(), 'host-node-factory-'))
  paths.push(parent)
  const profile = join(parent, 'cold-profile')
  const server = createHostNodeProductionServer({
    profilePath: profile,
    env: { PATH: '' },
    temporaryParent: parent
  })
  expect(server.phase).toBe('idle')
})

it('composes all nine live providers on a cold profile', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'host-node-factory-nine-')))
  paths.push(parent)
  const profile = join(parent, 'cold-profile')
  const server = createHostNodeProductionServer({
    profilePath: profile,
    env: { PATH: '' },
    temporaryParent: parent
  })
  await server.start()
  const client = new HostProjectionClient({
    userDataPath: profile,
    client: { clientId: 'nine-client', clientClass: 'test', clientVersion: '1.0' },
    capabilities: [
      'bootstrap',
      'snapshot',
      'deltas',
      'provider-catalog',
      'provider-auth',
      'history',
      'workspace-git',
      'setup',
      'commands',
      'receipts',
      'health'
    ]
  })
  await client.connect()
  expect(client.welcome?.capabilities).not.toContain('workspace-git')
  const statuses = await client.getProviderStatuses()
  const ids = statuses.map((status) => status.providerId).sort()
  expect(ids).toEqual([...LIVE_SELECTABLE_PROVIDER_IDS].sort())
  expect(ids).toEqual([...hostStandaloneComposedProviderIds()].sort())
  expect(ids).not.toContain('antigravity')
  expect(hostStandaloneAntigravityStatus()).toMatchObject({
    providerId: 'antigravity',
    kind: 'conditional',
    standaloneHost: 'unavailable',
    run: 'unavailable'
  })
  // Missing binaries are unavailable, never omitted.
  for (const status of statuses) {
    expect(['ready', 'auth_required', 'unavailable', 'degraded']).toContain(status.status)
  }
  client.close()
  await server.stop()
})

it('probes Git once, advertises only when available, and serves a hardened workspace read', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'host-node-factory-git-')))
  paths.push(parent)
  const profile = join(parent, 'profile')
  const workspace = join(parent, 'workspace')
  const binary = join(parent, 'git-test')
  const counter = join(parent, 'git-calls')
  mkdirSync(workspace)
  mkdirSync(join(workspace, '.git'))
  writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `printf x >> "${counter}"`,
      'test -z "$GITHUB_TOKEN" || exit 9',
      'case "$*" in',
      '  *--version*) printf "git version test\\n" ;;',
      `  *--show-toplevel*) printf "%s\\n" "${workspace}" ;;`,
      '  *--show-current*) printf "main\\n" ;;',
      '  *"rev-parse HEAD"*) printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" ;;',
      '  *status*) printf "M  file.ts\\0" ;;',
      '  *) exit 1 ;;',
      'esac'
    ].join('\n')
  )
  chmodSync(binary, 0o700)

  const server = createHostNodeProductionServer({
    profilePath: profile,
    gitExecutable: binary,
    env: { PATH: '', GITHUB_TOKEN: 'must-not-reach-git' },
    temporaryParent: parent
  })
  await server.start()
  expect(readFileSync(counter, 'utf8')).toBe('x')

  const client = new HostProjectionClient({
    userDataPath: profile,
    client: { clientId: 'git-client', clientClass: 'test', clientVersion: '1.0' },
    capabilities: [
      'bootstrap',
      'snapshot',
      'deltas',
      'workspace-git',
      'setup',
      'commands',
      'receipts',
      'health'
    ]
  })
  await client.connect()
  expect(client.welcome?.capabilities).toContain('workspace-git')
  const register: HostCommand = {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'git-workspace-register',
    idempotencyKey: 'git-workspace-register-key',
    actor: { actorId: 'git-client', clientId: 'git-client', clientClass: 'test' },
    name: 'workspace.register',
    target: {},
    arguments: { path: workspace },
    issuedAt: '2026-08-28T00:00:00.000Z'
  }
  const receipt = await client.submitCommand(register)
  const workspaceId = receipt.resultRef?.kind === 'workspace' ? receipt.resultRef.workspaceId : ''
  const result = await (
    client as unknown as {
      request(
        kind: 'workspace.git.read',
        params: { workspaceId: string; scope: 'status' }
      ): Promise<{ kind: string; result: unknown }>
    }
  ).request('workspace.git.read', { workspaceId, scope: 'status' })
  expect(result).toMatchObject({
    kind: 'workspace.git.read',
    result: {
      scope: 'status',
      branch: 'main',
      head: 'a'.repeat(40),
      files: [{ path: 'file.ts', kind: 'modified' }],
      truncated: false
    }
  })
  expect(readFileSync(counter, 'utf8')).toBe('xxxxx')

  client.close()
  await server.stop()
})

it('serves an authenticated cold-profile setup/history workflow and cleans owned resources', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'host-node-factory-live-')))
  paths.push(parent)
  const profile = join(parent, 'cold-profile')
  const workspace = join(parent, 'workspace')
  const binary = join(parent, 'muse')
  mkdirSync(workspace)
  writeFileSync(binary, '#!/bin/sh\n')
  chmodSync(binary, 0o700)
  const server = createHostNodeProductionServer({
    profilePath: profile,
    museBinary: binary,
    env: { PATH: '', META_API_KEY: 'bounded-test-key' },
    temporaryParent: parent
  })
  await server.start()
  const client = new HostProjectionClient({
    userDataPath: profile,
    client: { clientId: 'integration-client', clientClass: 'test', clientVersion: '1.0' },
    capabilities: [
      'bootstrap',
      'snapshot',
      'deltas',
      'provider-catalog',
      'provider-auth',
      'history',
      'setup',
      'commands',
      'receipts',
      'health'
    ]
  })
  await client.connect()
  const make = (
    name: HostCommand['name'],
    target: Record<string, string>,
    arguments_: Record<string, unknown>,
    id: string
  ): HostCommand => ({
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: id,
    idempotencyKey: `key-${id}`,
    actor: { actorId: 'integration-client', clientId: 'integration-client', clientClass: 'test' },
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-08-24T00:00:00.000Z'
  })
  const ws = await client.submitCommand(
    make('workspace.register', {}, { path: workspace }, 'cmd-ws')
  )
  const workspaceId =
    ws.resultRef && ws.resultRef.kind === 'workspace' ? ws.resultRef.workspaceId : ''
  const threadReceipt = await client.submitCommand(
    make(
      'thread.create',
      {},
      { scope: 'workspace', workspaceId, title: 'Integration' },
      'cmd-thread'
    )
  )
  const threadId =
    threadReceipt.resultRef && threadReceipt.resultRef.kind === 'thread'
      ? threadReceipt.resultRef.threadId
      : ''
  const statuses = await client.getProviderStatuses()
  expect(statuses[0]?.providerId).toBe('muse')
  const offers = await client.getProviderOffers('muse')
  const configured = await client.submitCommand(
    make(
      'thread.configure',
      { threadId },
      {
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        postureId: 'default',
        offerRevision: offers.offerRevision
      },
      'cmd-config'
    )
  )
  expect(configured.status).toBe('succeeded')
  expect((await client.getSnapshot()).snapshot.threads).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: threadId })])
  )
  expect(await client.getThreadHistory({ threadId, limit: 10 })).toMatchObject({ threadId })
  expect(await client.lookupReceipt({ commandId: 'cmd-config' })).toMatchObject({
    commandId: 'cmd-config'
  })
  await expect(
    client.submitCommand(
      make(
        'thread.configure',
        { threadId },
        {
          providerId: 'muse',
          modelId: 'muse-spark-1.2',
          postureId: 'default',
          offerRevision: offers.offerRevision
        },
        'cmd-config'
      )
    )
  ).resolves.toMatchObject({ commandId: 'cmd-config' })
  client.close()
  await server.stop()
  expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
  expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
  expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
  expect(existsSync(join(profile, 'host-runtime', 'host-install-identity.json'))).toBe(true)
  expect(readdirSync(parent).filter((name) => name.startsWith('taskwraith-muse-'))).toEqual([])
})

it('wires a real optional provider terminal launcher into production auth flows', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'host-node-factory-auth-launcher-')))
  paths.push(parent)
  const binDir = join(parent, 'bin')
  mkdirSync(binDir)
  for (const name of ['codex', 'kimi', 'vibe', 'grok']) {
    const binary = join(binDir, name)
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o700)
  }
  for (const name of ['claude', 'cursor-agent']) {
    const binary = join(binDir, name)
    writeFileSync(binary, '#!/bin/sh\nexit 1\n')
    chmodSync(binary, 0o700)
  }

  const previousPath = process.env.PATH
  const previousHome = process.env.HOME
  const previousCodexHome = process.env.CODEX_HOME
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  const previousXaiKey = process.env.XAI_API_KEY
  const previousGrokKey = process.env.GROK_API_KEY
  process.env.PATH = binDir
  process.env.HOME = join(parent, 'empty-home')
  process.env.CODEX_HOME = join(parent, 'empty-codex-home')
  delete process.env.OPENAI_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.GROK_API_KEY

  const domainFor = (server: unknown) =>
    (
      server as {
        domain: {
          registry: {
            getInstance(providerId: string): {
              getStatus(): Promise<{ status: string }>
              getAuthFlows(): Promise<readonly { flowId: string }[]>
              beginAuth(operationId: string): Promise<void>
            }
          }
        }
      }
    ).domain

  try {
    const detached = createHostNodeProductionServer({
      profilePath: join(parent, 'detached-profile'),
      env: { PATH: binDir },
      temporaryParent: parent
    })
    await detached.start()
    const detachedDomain = domainFor(detached)
    const detachedCodex = detachedDomain.registry.getInstance('codex')
    const detachedClaude = detachedDomain.registry.getInstance('claude')
    const detachedCursor = detachedDomain.registry.getInstance('cursor')
    const detachedGrok = detachedDomain.registry.getInstance('grok')
    await expect(detachedCodex.getStatus()).resolves.toMatchObject({ status: 'auth_required' })
    await expect(detachedClaude.getStatus()).resolves.toMatchObject({ status: 'auth_required' })
    await expect(detachedCursor.getStatus()).resolves.toMatchObject({ status: 'auth_required' })
    await expect(detachedCodex.getAuthFlows()).resolves.toEqual([])
    await expect(detachedClaude.getAuthFlows()).resolves.toEqual([])
    await expect(detachedCursor.getAuthFlows()).resolves.toEqual([])
    await expect(detachedGrok.getAuthFlows()).resolves.toEqual([])
    await detached.stop()

    const terminalLauncher = {
      launch: vi.fn(async () => undefined),
      launchForProvider: vi.fn(async () => undefined)
    }
    const interactive = createHostNodeProductionServer({
      profilePath: join(parent, 'interactive-profile'),
      env: { PATH: binDir },
      temporaryParent: parent,
      terminalLauncher
    })
    await interactive.start()
    const interactiveDomain = domainFor(interactive)
    const interactiveCodex = interactiveDomain.registry.getInstance('codex')
    const interactiveClaude = interactiveDomain.registry.getInstance('claude')
    const interactiveCursor = interactiveDomain.registry.getInstance('cursor')
    const interactiveGrok = interactiveDomain.registry.getInstance('grok')
    await expect(interactiveCodex.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({ flowId: 'codex:login' })
    ])
    await expect(interactiveClaude.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({ flowId: 'claude:login' })
    ])
    await expect(interactiveCursor.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({ flowId: 'cursor:login' })
    ])
    await expect(interactiveGrok.getAuthFlows()).resolves.toEqual([
      expect.objectContaining({
        flowId: 'grok:login',
        kind: 'manual',
        available: true
      })
    ])
    await interactiveCodex.beginAuth('factory-auth-1')
    await interactiveClaude.beginAuth('factory-auth-2')
    await interactiveCursor.beginAuth('factory-auth-3')
    await interactiveGrok.beginAuth('factory-auth-4')
    expect(terminalLauncher.launchForProvider).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ argv: [join(binDir, 'codex'), 'login'] })
    )
    expect(terminalLauncher.launchForProvider).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ argv: [join(binDir, 'claude'), 'auth', 'login'] })
    )
    expect(terminalLauncher.launchForProvider).toHaveBeenCalledWith(
      'cursor',
      expect.objectContaining({ argv: [join(binDir, 'cursor-agent'), 'login'] })
    )
    expect(terminalLauncher.launchForProvider).toHaveBeenCalledWith(
      'grok',
      expect.objectContaining({ argv: [join(binDir, 'grok'), 'login'] })
    )
    await interactive.stop()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXaiKey
    if (previousGrokKey === undefined) delete process.env.GROK_API_KEY
    else process.env.GROK_API_KEY = previousGrokKey
  }
})

it('disposes lease-late Muse resources when terminal handoff construction is invalid', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'host-node-factory-invalid-launcher-')))
  paths.push(parent)
  const profile = join(parent, 'cold-profile')
  const binary = join(parent, 'muse')
  writeFileSync(binary, '#!/bin/sh\n')
  chmodSync(binary, 0o700)
  const server = createHostNodeProductionServer({
    profilePath: profile,
    museBinary: binary,
    env: { PATH: '' },
    temporaryParent: parent,
    terminalLauncher: {} as never
  })
  await expect(server.start()).rejects.toThrow('handoff')
  expect(readdirSync(parent).filter((name) => name.startsWith('taskwraith-muse-'))).toEqual([])
})
