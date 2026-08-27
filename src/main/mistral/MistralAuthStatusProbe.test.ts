import type { ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MISTRAL_AUTH_STATUS_METHOD,
  normalizeMistralVibeAuthStatus,
  probeMistralVibeAuthStatus,
  type SpawnMistralAuthProbeProcess
} from './MistralAuthStatusProbe'

interface FakeVibeProcess {
  child: ChildProcessWithoutNullStreams
  kill: ReturnType<typeof vi.fn>
  requests: Array<Record<string, unknown>>
}

function fakeVibeProcess(
  respond: (
    request: Record<string, unknown>,
    send: (response: Record<string, unknown>) => void
  ) => void
): FakeVibeProcess {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kill = vi.fn(() => true)
  const requests: Array<Record<string, unknown>> = []
  let carry = ''

  stdin.on('data', (chunk) => {
    carry += chunk.toString()
    const lines = carry.split('\n')
    carry = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const request = JSON.parse(line) as Record<string, unknown>
      requests.push(request)
      respond(request, (response) => stdout.write(`${JSON.stringify(response)}\n`))
    }
  })

  const child = events as unknown as ChildProcessWithoutNullStreams
  Object.assign(child, { stdin, stdout, stderr, kill })
  return { child, kill, requests }
}

function spawnFake(fake: FakeVibeProcess): SpawnMistralAuthProbeProcess {
  return vi.fn(() => fake.child)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('normalizeMistralVibeAuthStatus', () => {
  it("trusts only Vibe's boolean and retains only documented source metadata", () => {
    expect(
      normalizeMistralVibeAuthStatus({ authenticated: true, authState: 'os_keyring' })
    ).toEqual({
      authState: 'authenticated',
      credentialPresent: true,
      authSource: 'os_keyring',
      probeStatus: 'verified'
    })
    expect(
      normalizeMistralVibeAuthStatus({ authenticated: true, authState: 'secret-value' }).authSource
    ).toBeNull()
  })

  it('distinguishes an authoritative signed-out result from a failed probe', () => {
    expect(
      normalizeMistralVibeAuthStatus({ authenticated: false, authState: 'signed_out' })
    ).toEqual({
      authState: 'missing',
      credentialPresent: false,
      authSource: 'signed_out',
      probeStatus: 'verified'
    })
    expect(normalizeMistralVibeAuthStatus({ authState: 'os_keyring' })).toMatchObject({
      authState: 'unknown',
      credentialPresent: null,
      probeStatus: 'failed'
    })
  })
})

describe('probeMistralVibeAuthStatus', () => {
  it('initializes Vibe, requests only credential-opaque auth status, and returns green evidence', async () => {
    const fake = fakeVibeProcess((request, send) => {
      if (request.id === 1) {
        send({
          jsonrpc: '2.0',
          id: 1,
          result: { agentInfo: { name: '@mistralai/mistral-vibe', version: '2.24.3' } }
        })
      } else if (request.id === 2) {
        send({
          jsonrpc: '2.0',
          id: 2,
          result: {
            authenticated: true,
            authState: 'os_keyring',
            signOutAvailable: true,
            customDomain: null
          }
        })
      }
    })

    await expect(
      probeMistralVibeAuthStatus({
        binaryPath: '/opt/vibe-acp',
        env: { PATH: '/opt' },
        clientVersion: '1.2.3',
        spawnProcess: spawnFake(fake)
      })
    ).resolves.toEqual({
      authState: 'authenticated',
      credentialPresent: true,
      authSource: 'os_keyring',
      version: '2.24.3',
      probeStatus: 'verified'
    })

    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'taskwraith', version: '1.2.3' } }
    })
    expect(fake.requests[1]).toMatchObject({ method: MISTRAL_AUTH_STATUS_METHOD, params: {} })
    expect(fake.requests.some((request) => request.method === 'session/new')).toBe(false)
    expect(fake.requests.some((request) => request.method === 'authenticate')).toBe(false)
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('returns an explicit missing credential when Vibe reports signed out', async () => {
    const fake = fakeVibeProcess((request, send) => {
      if (request.id === 1) {
        send({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version: '2.24.3' } } })
      } else if (request.id === 2) {
        send({
          jsonrpc: '2.0',
          id: 2,
          result: { authenticated: false, authState: 'signed_out' }
        })
      }
    })

    await expect(
      probeMistralVibeAuthStatus({
        binaryPath: '/opt/vibe-acp',
        env: {},
        spawnProcess: spawnFake(fake)
      })
    ).resolves.toMatchObject({
      authState: 'missing',
      credentialPresent: false,
      authSource: 'signed_out',
      probeStatus: 'verified'
    })
  })

  it('keeps older Vibe builds yellow when the auth-status extension is unsupported', async () => {
    const fake = fakeVibeProcess((request, send) => {
      if (request.id === 1) {
        send({ jsonrpc: '2.0', id: 1, result: { agentInfo: { version: '2.23.0' } } })
      } else if (request.id === 2) {
        send({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32601, message: 'Method not found' }
        })
      }
    })

    await expect(
      probeMistralVibeAuthStatus({
        binaryPath: '/opt/vibe-acp',
        env: {},
        spawnProcess: spawnFake(fake)
      })
    ).resolves.toEqual({
      authState: 'unknown',
      credentialPresent: null,
      authSource: null,
      version: '2.23.0',
      probeStatus: 'unsupported'
    })
  })

  it('fails boundedly when Vibe never answers', async () => {
    vi.useFakeTimers()
    const fake = fakeVibeProcess(() => {})
    const probe = probeMistralVibeAuthStatus({
      binaryPath: '/opt/vibe-acp',
      env: {},
      timeoutMs: 100,
      spawnProcess: spawnFake(fake)
    })

    await vi.advanceTimersByTimeAsync(100)
    await expect(probe).resolves.toEqual({
      authState: 'unknown',
      credentialPresent: null,
      authSource: null,
      version: null,
      probeStatus: 'failed'
    })
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
