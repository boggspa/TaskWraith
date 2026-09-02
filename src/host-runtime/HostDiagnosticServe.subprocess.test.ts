import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  HostProjectionClient,
  HostProjectionTransportError
} from '../host-client/HostProjectionClient'
import { HOST_PROFILE_AUTHORITY_LEASE_FILENAME } from './HostProfileAuthorityLease'

const REPO_ROOT = resolve(process.cwd())
const CLI_PATH = resolve(REPO_ROOT, 'out/host/host-runtime/cli.js')
const profiles: string[] = []
const children: ChildProcess[] = []

function createProfile(): string {
  // Canonicalize the fixture root: win32 temp roots carry 8.3 short-name
  // segments that the Host and the client must agree on byte-for-byte.
  const profile = realpathSync(
    mkdtempSync(join(tmpdir(), 'taskwraith-diagnostic-host-subprocess-'))
  )
  profiles.push(profile)
  return profile
}

function outputOf(child: ChildProcess): { stdout: string; stderr: string } {
  return (
    (child as ChildProcess & { __diagnosticOutput?: { stdout: string; stderr: string } })
      .__diagnosticOutput ?? { stdout: '', stderr: '' }
  )
}

function spawnHost(profilePath: string, mode = 'diagnostic'): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      'serve',
      '--profile',
      profilePath,
      '--mode',
      mode,
      '--parent-pid',
      String(process.pid)
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const output = { stdout: '', stderr: '' }
  child.stdout?.on('data', (chunk) => {
    output.stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output.stderr += String(chunk)
  })
  ;(child as ChildProcess & { __diagnosticOutput?: typeof output }).__diagnosticOutput = output
  children.push(child)
  return child
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`diagnostic Host did not exit: ${JSON.stringify(outputOf(child))}`))
    }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/clean-host-output.cjs'], { cwd: REPO_ROOT })
  execFileSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', 'src/host-runtime/tsconfig.json'],
    {
      cwd: REPO_ROOT
    }
  )
  chmodSync(CLI_PATH, 0o755)
  // A full tsc compile of the Host runtime; vitest's default 10s hook budget is
  // exceeded on the loaded macOS Intel and Windows runners.
}, 120_000)

afterAll(async () => {
  const activeChildren = children.splice(0)
  for (const child of activeChildren) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  await Promise.all(activeChildren.map((child) => waitForExit(child).catch(() => undefined)))
  for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true })
})

describe('standalone diagnostic Host subprocess', () => {
  it('serves an authenticated degraded projection, rejects a duplicate profile, and cleans up', async () => {
    const profilePath = createProfile()
    const child = spawnHost(profilePath)
    const discoveryPath = join(profilePath, 'taskwraith-host-v2.json')
    const tokenPath = join(profilePath, 'taskwraith-host-v2.token')

    await waitFor(
      () => existsSync(discoveryPath) && existsSync(tokenPath),
      `diagnostic Host did not publish discovery: ${JSON.stringify(outputOf(child))}`
    )
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { socketPath: string }

    const client = new HostProjectionClient({
      client: {
        clientId: 'diagnostic-subprocess-client',
        clientClass: 'test',
        clientVersion: '1.0.0'
      },
      userDataPath: profilePath,
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000
    })
    try {
      const welcome = await client.connect()
      expect(welcome.capabilities).toEqual(['bootstrap', 'snapshot', 'health'])
      expect(welcome.capabilities).not.toContain('commands')
      expect(welcome.capabilities).not.toContain('provider-catalog')
      expect(welcome.capabilities).not.toContain('provider-auth')
      expect(welcome.capabilities).not.toContain('history')

      const snapshot = await client.getSnapshot()
      expect(snapshot.snapshot.health.hostStatus).toBe('degraded')
      expect(snapshot.snapshot.warnings).toEqual([
        expect.objectContaining({ code: 'diagnostic_mode', severity: 'warning' })
      ])
      await expect(
        client.submitCommand({
          type: 'host.command',
          protocolVersion: 2,
          commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          idempotencyKey: 'test:test:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          actor: {
            actorId: 'diagnostic-subprocess-client',
            clientId: 'diagnostic-subprocess-client',
            clientClass: 'test'
          },
          name: 'ping',
          target: {},
          arguments: {},
          issuedAt: '2026-08-24T00:00:00.000Z'
        })
      ).rejects.toBeInstanceOf(HostProjectionTransportError)
      await expect(client.getProviderStatuses()).rejects.toMatchObject({ code: 'unauthorized' })
      await expect(
        client.getThreadHistory({ threadId: 'diagnostic-thread', limit: 25 })
      ).rejects.toMatchObject({ code: 'unauthorized' })

      const duplicate = spawnHost(profilePath)
      await expect(waitForExit(duplicate)).resolves.not.toBe(0)
      expect(outputOf(duplicate).stderr).toMatch(/profile authority/i)
    } finally {
      client.close()
    }

    child.kill('SIGTERM')
    await expect(waitForExit(child)).resolves.toBe(0)
    expect(existsSync(discoveryPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(false)
    expect(existsSync(discovery.socketPath)).toBe(false)
    expect(existsSync(join(profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)

    // The compiled process is launched by Node and contains no Electron import.
    expect(readFileSync(CLI_PATH, 'utf8')).not.toMatch(
      /(?:require|from)\(['"]electron|from ['"]electron/
    )
  }, 20_000)

  it('fails closed before creating profile-owned artifacts for unavailable modes', async () => {
    for (const mode of ['production', 'read-only']) {
      const profilePath = createProfile()
      const child = spawnHost(profilePath, mode)

      await expect(waitForExit(child)).resolves.toBe(2)
      expect(outputOf(child).stderr).toMatch(/unavailable/i)
      expect(existsSync(join(profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
      expect(existsSync(join(profilePath, 'taskwraith-host-v2.json'))).toBe(false)
      expect(existsSync(join(profilePath, 'taskwraith-host-v2.token'))).toBe(false)
    }
  })
})
