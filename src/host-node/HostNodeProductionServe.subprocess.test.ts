import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { HostProjectionClient } from '../host-client/HostProjectionClient'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import {
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { HOST_PROFILE_AUTHORITY_LEASE_FILENAME } from '../host-runtime/HostProfileAuthorityLease'

const paths: string[] = []

afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

function waitFor(check: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}`))
      }
    }, 25)
    timer.unref?.()
  })
}

async function waitForAsync(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 12_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('production Host did not exit')), 10_000)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function command(
  name: HostCommand['name'],
  id: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: id,
    idempotencyKey: `key-${id}`,
    actor: { actorId: 'subprocess-client', clientId: 'subprocess-client', clientClass: 'test' },
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-08-24T00:00:00.000Z'
  }
}

describe('production Host CLI subprocess', () => {
  it('owns a cold profile, serves the production capability floor, rejects a duplicate lease, and cleans up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-production-subprocess-'))
    paths.push(root)
    const outDir = join(root, 'out')
    const profile = join(root, 'profile')
    const workspace = join(root, 'workspace')
    const muse = join(root, 'muse')
    const exerciseMuse = process.platform !== 'win32'
    mkdirSync(workspace)
    if (exerciseMuse) {
      writeFileSync(
        muse,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"schema_version":1,"id":"22222222-2222-2222-2222-222222222222","stream":{"kind":"session","id":"subprocess-muse-session"},"sequence":1,"recorded_at":1780531400000000,"record_type":"event","payload_type":"run.terminal.completed","payload":{"kind":"run_terminal_completed","terminal":"completed","text":"subprocess muse completed"}}\'\n'
      )
      chmodSync(muse, 0o700)
    }
    const compile = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
        '--outDir',
        outDir
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(compile.status).toBe(0)
    const cli = join(outDir, 'host-runtime', 'cli.js')
    expect(existsSync(cli)).toBe(true)
    const args = [
      cli,
      'serve',
      '--mode',
      'production',
      '--profile',
      profile,
      ...(exerciseMuse ? ['--muse-binary', muse] : [])
    ]
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        ...(exerciseMuse ? { META_API_KEY: 'subprocess-test-key' } : {}),
        PATH: ''
      },
      stdio: 'ignore'
    })
    let client: HostProjectionClient | null = null
    let reconnected: HostProjectionClient | null = null
    try {
      await waitFor(
        () =>
          existsSync(taskWraithHostDiscoveryPath(profile)) &&
          existsSync(taskWraithHostTokenPath(profile)),
        'production discovery'
      )
      const duplicate = spawnSync(process.execPath, args, {
        env: {
          ...process.env,
          ...(exerciseMuse ? { META_API_KEY: 'subprocess-test-key' } : {}),
          PATH: ''
        },
        encoding: 'utf8',
        timeout: 5_000
      })
      expect(duplicate.error).toBeUndefined()
      expect(duplicate.signal).toBeNull()
      expect(duplicate.status).not.toBe(0)
      expect(`${duplicate.stdout || ''}${duplicate.stderr || ''}`).toMatch(
        /profile|authority|lease/i
      )

      client = new HostProjectionClient({
        userDataPath: profile,
        client: { clientId: 'subprocess-client', clientClass: 'test', clientVersion: '1.0' },
        capabilities: [
          'bootstrap',
          'commands',
          'receipts',
          'setup',
          'provider-catalog',
          'provider-auth',
          'history',
          'health'
        ]
      })
      const welcome = await client.connect()
      expect(welcome.hostVersion).toBe('node-host-v1')
      expect(welcome.capabilities).toEqual(
        expect.arrayContaining([
          'commands',
          'receipts',
          'setup',
          'provider-catalog',
          'provider-auth',
          'history',
          'health'
        ])
      )
      const ws = await client.submitCommand(
        command('workspace.register', 'cmd-ws', {}, { path: workspace })
      )
      const workspaceId = ws.resultRef?.kind === 'workspace' ? ws.resultRef.workspaceId : ''
      const thread = await client.submitCommand(
        command('thread.create', 'cmd-thread', {}, { scope: 'workspace', workspaceId })
      )
      const threadId = thread.resultRef?.kind === 'thread' ? thread.resultRef.threadId : ''
      if (exerciseMuse) {
        const offers = await client.getProviderOffers('muse')
        const configured = await client.submitCommand(
          command(
            'thread.configure',
            'cmd-config',
            { threadId },
            {
              providerId: 'muse',
              modelId: 'muse-spark-1.2',
              postureId: 'default',
              offerRevision: offers.offerRevision
            }
          )
        )
        expect(configured.status).toBe('succeeded')
        const sent = await client.submitCommand(
          command('composer.send', 'cmd-send', { threadId }, { text: 'execute Muse' })
        )
        expect(sent.status).toBe('succeeded')
        await waitForAsync(async () => {
          const history = await client.getThreadHistory({ threadId, limit: 20 })
          return history.entries.some((entry) => entry.text === 'subprocess muse completed')
        }, 'Muse assistant transcript')
        await waitForAsync(async () => {
          const snapshot = await client.getSnapshot()
          return snapshot.snapshot.runs.some(
            (run) => run.runId === 'cmd-send' && run.providerOutcome === 'completed'
          )
        }, 'Muse terminal projection')
        expect(await client.getThreadHistory({ threadId, limit: 10 })).toMatchObject({ threadId })
        await expect(client.lookupReceipt({ commandId: 'cmd-config' })).resolves.toMatchObject({
          commandId: 'cmd-config'
        })
        client.close()
        const reconnected = new HostProjectionClient({
          userDataPath: profile,
          client: { clientId: 'subprocess-client', clientClass: 'test', clientVersion: '1.0' },
          capabilities: [
            'bootstrap',
            'commands',
            'receipts',
            'setup',
            'provider-catalog',
            'provider-auth',
            'history',
            'health'
          ]
        })
        await reconnected.connect()
        await expect(reconnected.lookupReceipt({ commandId: 'cmd-send' })).resolves.toMatchObject({
          commandId: 'cmd-send'
        })
        await expect(reconnected.getThreadHistory({ threadId, limit: 20 })).resolves.toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({ text: 'subprocess muse completed' })
          ])
        })
        reconnected.close()
      } else {
        await expect(client.lookupReceipt({ commandId: 'cmd-thread' })).resolves.toMatchObject({
          commandId: 'cmd-thread'
        })
      }
    } finally {
      client?.close()
      reconnected?.close()
      const graceful = spawnSync(
        process.execPath,
        [cli, 'stop', '--profile', realpathSync(profile)],
        {
          env: { ...process.env, PATH: '' },
          encoding: 'utf8',
          timeout: 10_000
        }
      )
      if (graceful.status === 0) {
        await waitForExit(child)
        expect(child.exitCode).toBe(0)
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await waitForExit(child)
      }
      expect(graceful.status, `${graceful.stdout || ''}${graceful.stderr || ''}`).toBe(0)
    }
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
    expect(existsSync(join(profile, 'host-runtime', 'host-install-identity.json'))).toBe(true)
  }, 30_000)
})
