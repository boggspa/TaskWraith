import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'module'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Host welcome probe (M1 harness binding) — the out-of-band live pin the
 * collector's expectedIdentity needs. Covered here:
 *
 *  1. discovery decode/read/poll — fail-closed, bounded reason codes, and
 *     `host_discovery_absent` at the deadline (host-unsupported, never
 *     host-quiet);
 *  2. ONE real hello → welcome → disconnect over a real unix socket — the
 *     exact production frame shape (smoke-packaged-host.cjs precedent), with
 *     and without a boot epoch;
 *  3. epoch strictness — a malformed welcome epoch FAILS the probe instead
 *     of silently dropping to the legacy path;
 *  4. TOKEN CONTAINMENT — the auth token never appears in any result,
 *     reason, or serialized output of this module, on success or on ANY
 *     failure path (timeout, refused hello, malformed frame, unreadable
 *     token). This is the named obligation from the wave-8 brief.
 */
const require = createRequire(import.meta.url)
const {
  HOST_DISCOVERY_FILE,
  HOST_BOOT_EPOCH_PATTERN,
  hostDiscoveryPath,
  decodeHostDiscovery,
  readHostDiscovery,
  waitForHostDiscovery,
  decodeProbedWelcome,
  requestHostWelcome,
  buildExpectedIdentity,
  probeHostBootstrapIdentity
} = require('./hostWelcomeProbe.cjs')

const VALID_EPOCH = 'ab'.repeat(32)
const TOKEN = 'f4k3-t0k3n-DO-NOT-LEAK-0123456789abcdef'

const scratchDirs: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'host-welcome-probe-'))
  scratchDirs.push(dir)
  return dir
}
afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const VALID_DISCOVERY = Object.freeze({
  protocolVersion: 2,
  socketPath: '/tmp/twh2-501-abc123/taskwraith-host-v2.sock',
  tokenPath: '/tmp/twh2-501-abc123/taskwraith-host-v2.token',
  pid: 4242,
  startedAt: '2026-09-09T03:00:00.000Z'
})

/** fs fake exposing exactly readFileSync over a path→content map. */
function fakeFs(files: Record<string, string>) {
  return {
    readFileSync(path: string, _encoding?: string): string {
      if (Object.prototype.hasOwnProperty.call(files, path)) return files[path]
      const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file ${path}`)
      error.code = 'ENOENT'
      throw error
    }
  }
}

/** A welcome frame server: writes `frames` in order on connect, records the hello. */
function startWelcomeServer(
  respond: (helloLine: string | null, socket: Socket) => void
): Promise<{ server: Server; socketPath: string; hellos: string[]; close: () => Promise<void> }> {
  const dir = scratchDir()
  const socketPath = join(dir, 'host.sock')
  const hellos: string[] = []
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += String(chunk)
        const newline = buffer.indexOf('\n')
        if (newline >= 0) {
          const line = buffer.slice(0, newline)
          hellos.push(line)
          buffer = buffer.slice(newline + 1)
          respond(line, socket)
        }
      })
      socket.on('error', () => {})
    })
    server.on('error', reject)
    server.listen(socketPath, () => {
      resolve({
        server,
        socketPath,
        hellos,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          })
      })
    })
  })
}

function welcomeFrame(welcome: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'welcome', welcome })}\n`
}

function validWelcome(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostId: 'host-live-01',
    hostVersion: '1.8.6',
    sessionId: 'sess-01',
    generation: 7,
    cursor: { sequence: 1 },
    client: { clientId: 'x', clientClass: 'test', clientVersion: '1.0.0' },
    capabilities: ['bootstrap'],
    freshness: { mode: 'live' },
    ...extra
  }
}

describe('hostWelcomeProbe — discovery decode/read/poll', () => {
  it('decodes a valid discovery record and refuses every malformed shape with a bounded field reason', () => {
    expect(decodeHostDiscovery(VALID_DISCOVERY)).toEqual({ ok: true, discovery: VALID_DISCOVERY })
    const cases: Array<[string, unknown, string]> = [
      ['shape', null, 'shape'],
      ['protocolVersion', { ...VALID_DISCOVERY, protocolVersion: 1 }, 'protocolVersion'],
      ['socketPath relative', { ...VALID_DISCOVERY, socketPath: 'relative.sock' }, 'socketPath'],
      ['tokenPath empty', { ...VALID_DISCOVERY, tokenPath: '' }, 'tokenPath'],
      ['pid zero', { ...VALID_DISCOVERY, pid: 0 }, 'pid'],
      ['pid fractional', { ...VALID_DISCOVERY, pid: 42.5 }, 'pid'],
      ['startedAt non-canonical', { ...VALID_DISCOVERY, startedAt: '2026-09-09' }, 'startedAt'],
      ['hostId wrong type', { ...VALID_DISCOVERY, hostId: 42 }, 'hostId']
    ]
    for (const [label, value, field] of cases) {
      const result = decodeHostDiscovery(value)
      expect(result.ok, label).toBe(false)
      expect(result.reason, label).toBe(`host_discovery_invalid: ${field}`)
    }
  })

  it('reads the discovery file at <userData>/taskwraith-host-v2.json and names absence vs parse failure', () => {
    const userData = scratchDir()
    expect(hostDiscoveryPath(userData)).toBe(join(userData, HOST_DISCOVERY_FILE))
    const missing = readHostDiscovery(userData, { fs: fakeFs({}) })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toBe('host_discovery_absent')

    const discoveryPath = hostDiscoveryPath(userData)
    const garbled = readHostDiscovery(userData, {
      fs: fakeFs({ [discoveryPath]: '{"protocolVersion": 2,' })
    })
    expect(garbled.ok).toBe(false)
    expect(garbled.reason).toBe('host_discovery_invalid: parse_error')

    writeFileSync(discoveryPath, JSON.stringify(VALID_DISCOVERY))
    const real = readHostDiscovery(userData)
    expect(real.ok).toBe(true)
    expect(real.discovery).toEqual(VALID_DISCOVERY)
  })

  it('polls until the discovery appears and returns the LAST reason at the deadline', async () => {
    const userData = scratchDir()
    const discoveryPath = hostDiscoveryPath(userData)
    let clock = 0
    let reads = 0
    const fsImpl = {
      readFileSync(path: string, encoding?: string): string {
        reads += 1
        if (path !== discoveryPath) throw Object.assign(new Error('x'), { code: 'ENOENT' })
        if (reads < 3) {
          // First two attempts: mid-write garbage; third: valid.
          if (reads === 1) throw Object.assign(new Error('x'), { code: 'ENOENT' })
          return '{"protocolVersion":'
        }
        return nodeFs.readFileSync(path, encoding ?? 'utf8')
      }
    }
    writeFileSync(discoveryPath, JSON.stringify(VALID_DISCOVERY))
    const slept: number[] = []
    const appeared = await waitForHostDiscovery(userData, {
      fs: fsImpl,
      maxWaitMs: 10_000,
      intervalMs: 500,
      sleep: async (ms: number) => {
        slept.push(ms)
        clock += ms
      },
      nowMs: () => clock
    })
    expect(appeared.ok).toBe(true)
    expect(appeared.discovery).toEqual(VALID_DISCOVERY)
    expect(slept).toEqual([500, 500])

    const never = await waitForHostDiscovery(userData, {
      fs: fakeFs({}),
      maxWaitMs: 0,
      sleep: async () => {},
      nowMs: () => 0
    })
    expect(never.ok).toBe(false)
    expect(never.reason).toBe('host_discovery_absent')
    expect(never.timedOut).toBe(true)
  })
})

describe('hostWelcomeProbe — welcome decode and expectedIdentity', () => {
  it('keeps a valid epoch, refuses a malformed one, and never drops it to undefined', () => {
    const withEpoch = decodeProbedWelcome(validWelcome({ bootEpoch: VALID_EPOCH }))
    expect(withEpoch.ok).toBe(true)
    expect(withEpoch.welcome.bootEpoch).toBe(VALID_EPOCH)

    const without = decodeProbedWelcome(validWelcome())
    expect(without.ok).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(without.welcome, 'bootEpoch')).toBe(false)

    for (const bad of [
      'AB'.repeat(32),
      'a'.repeat(63),
      'a'.repeat(65),
      'g'.repeat(64),
      '',
      42,
      null
    ]) {
      const result = decodeProbedWelcome(validWelcome({ bootEpoch: bad }))
      expect(result.ok, String(bad)).toBe(false)
      expect(result.reason, String(bad)).toBe('host_welcome_invalid: bootEpoch')
    }
    expect(decodeProbedWelcome(validWelcome({ hostId: '' })).reason).toBe(
      'host_welcome_invalid: hostId'
    )
    expect(decodeProbedWelcome(validWelcome({ generation: -1 })).reason).toBe(
      'host_welcome_invalid: generation'
    )
  })

  it('builds the collector pin from welcome + discovery pid, epoch conditional', () => {
    const welcome = { hostId: 'host-live-01', generation: 7, bootEpoch: VALID_EPOCH }
    expect(buildExpectedIdentity(welcome, VALID_DISCOVERY)).toEqual({
      instanceId: 'host-live-01',
      generation: 7,
      pid: 4242,
      bootEpoch: VALID_EPOCH
    })
    const legacy = buildExpectedIdentity({ hostId: 'h', generation: 0 }, VALID_DISCOVERY)
    expect(Object.prototype.hasOwnProperty.call(legacy, 'bootEpoch')).toBe(false)
    expect(() => buildExpectedIdentity(welcome, { pid: 0 })).toThrow(/positive pid/)
  })
})

describe('hostWelcomeProbe — real socket handshake and token containment', () => {
  it('completes hello → welcome → disconnect with an epoch; the token authenticates but NEVER surfaces', async () => {
    const dir = scratchDir()
    const handled = await startWelcomeServer((_hello, socket) => {
      socket.write(welcomeFrame(validWelcome({ bootEpoch: VALID_EPOCH })))
    })
    try {
      const tokenPath = join(dir, 'host.token')
      writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 })
      const discovery = {
        ...VALID_DISCOVERY,
        socketPath: handled.socketPath,
        tokenPath,
        hostId: 'host-live-01'
      }
      const result = await requestHostWelcome({ discovery, timeoutMs: 2000 })
      expect(result.ok).toBe(true)
      expect(result.welcome).toEqual({
        hostId: 'host-live-01',
        hostVersion: '1.8.6',
        generation: 7,
        bootEpoch: VALID_EPOCH
      })

      // The server saw exactly one hello carrying the real token (wire use).
      expect(handled.hellos.length).toBe(1)
      const hello = JSON.parse(handled.hellos[0])
      expect(hello.type).toBe('hello')
      expect(hello.transportVersion).toBe(1)
      expect(hello.token).toBe(TOKEN)
      expect(hello.hello.type).toBe('host.hello')
      expect(hello.hello.protocolVersion).toBe(2)
      expect(hello.hello.projectionVersion).toBe(2)
      expect(hello.hello.capabilities).toEqual(['bootstrap'])

      // TOKEN CONTAINMENT (success path): the serialized result must not
      // carry the token, the tokenPath, or the socketPath.
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(TOKEN)
      expect(serialized).not.toContain(tokenPath)
      expect(HOST_BOOT_EPOCH_PATTERN.test(result.welcome.bootEpoch)).toBe(true)
    } finally {
      await handled.close()
    }
  })

  it('fails closed on a malformed welcome epoch rather than dropping it to the legacy path', async () => {
    const dir = scratchDir()
    const handled = await startWelcomeServer((_hello, socket) => {
      socket.write(welcomeFrame(validWelcome({ bootEpoch: 'AB'.repeat(32) })))
    })
    try {
      const tokenPath = join(dir, 'host.token')
      writeFileSync(tokenPath, TOKEN)
      const result = await requestHostWelcome({
        discovery: { ...VALID_DISCOVERY, socketPath: handled.socketPath, tokenPath },
        timeoutMs: 2000
      })
      expect(result).toEqual({ ok: false, reason: 'host_welcome_invalid: bootEpoch' })
    } finally {
      await handled.close()
    }
  })

  it('names every failure path with a bounded reason that never echoes frames or the token', async () => {
    const dir = scratchDir()
    const tokenPath = join(dir, 'host.token')
    writeFileSync(tokenPath, TOKEN)

    // (a) refused hello → error frame
    const refused = await startWelcomeServer((_hello, socket) => {
      socket.write(`${JSON.stringify({ type: 'error', error: `bad token ${TOKEN}` })}\n`)
    })
    try {
      const result = await requestHostWelcome({
        discovery: { ...VALID_DISCOVERY, socketPath: refused.socketPath, tokenPath },
        timeoutMs: 2000
      })
      expect(result).toEqual({ ok: false, reason: 'host_hello_refused' })
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    } finally {
      await refused.close()
    }

    // (b) malformed frame — the raw line (token-bearing bait) is never echoed
    const malformed = await startWelcomeServer((_hello, socket) => {
      socket.write(`not-json ${TOKEN}\n`)
    })
    try {
      const result = await requestHostWelcome({
        discovery: { ...VALID_DISCOVERY, socketPath: malformed.socketPath, tokenPath },
        timeoutMs: 2000
      })
      expect(result).toEqual({ ok: false, reason: 'host_frame_malformed' })
      expect(JSON.stringify(result)).not.toContain(TOKEN)
    } finally {
      await malformed.close()
    }

    // (c) silent server → timeout, socket destroyed
    const silent = await startWelcomeServer(() => {})
    try {
      const started = Date.now()
      const result = await requestHostWelcome({
        discovery: { ...VALID_DISCOVERY, socketPath: silent.socketPath, tokenPath },
        timeoutMs: 80
      })
      expect(result).toEqual({ ok: false, reason: 'host_welcome_timeout' })
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await silent.close()
    }

    // (d) missing token file / empty token
    const missingToken = await requestHostWelcome({
      discovery: { ...VALID_DISCOVERY, tokenPath: join(dir, 'absent.token') },
      timeoutMs: 100
    })
    expect(missingToken).toEqual({ ok: false, reason: 'host_token_unreadable: ENOENT' })
    const emptyTokenPath = join(dir, 'empty.token')
    writeFileSync(emptyTokenPath, '   \n')
    const emptyToken = await requestHostWelcome({
      discovery: { ...VALID_DISCOVERY, tokenPath: emptyTokenPath },
      timeoutMs: 100
    })
    expect(emptyToken).toEqual({ ok: false, reason: 'host_token_empty' })

    // (e) dead socket → connect failure or immediate close, both bounded
    const dead = await requestHostWelcome({
      discovery: { ...VALID_DISCOVERY, socketPath: join(dir, 'nothing.sock'), tokenPath },
      timeoutMs: 500
    })
    expect(dead.ok).toBe(false)
    expect(['host_socket_error', 'host_socket_connect_failed']).toContain(dead.reason)
    expect(JSON.stringify(dead)).not.toContain(TOKEN)
  })

  it('composes discovery + welcome into the expectedIdentity pin; absence and refusal keep their stages', async () => {
    const dir = scratchDir()
    const handled = await startWelcomeServer((_hello, socket) => {
      socket.write(welcomeFrame(validWelcome({ bootEpoch: VALID_EPOCH })))
    })
    try {
      const tokenPath = join(dir, 'host.token')
      writeFileSync(tokenPath, TOKEN)
      const discovery = {
        ...VALID_DISCOVERY,
        socketPath: handled.socketPath,
        tokenPath,
        hostId: 'host-live-01'
      }
      writeFileSync(hostDiscoveryPath(dir), JSON.stringify(discovery))

      const ok = await probeHostBootstrapIdentity({
        userDataPath: dir,
        maxWaitMs: 0,
        timeoutMs: 2000,
        sleep: async () => {}
      })
      expect(ok.ok).toBe(true)
      expect(ok.expectedIdentity).toEqual({
        instanceId: 'host-live-01',
        generation: 7,
        pid: 4242,
        bootEpoch: VALID_EPOCH
      })
      // The composed result carries the bounded discovery subset only —
      // never socketPath, never tokenPath, never the token.
      const serialized = JSON.stringify(ok)
      expect(serialized).not.toContain(TOKEN)
      expect(serialized).not.toContain(tokenPath)
      expect(serialized).not.toContain(handled.socketPath)
      expect(ok.discovery).toEqual({
        pid: 4242,
        startedAt: '2026-09-09T03:00:00.000Z',
        hostId: 'host-live-01'
      })

      // host-unsupported: no discovery anywhere → stage 'discovery'
      const absent = await probeHostBootstrapIdentity({
        userDataPath: scratchDir(),
        maxWaitMs: 0,
        sleep: async () => {},
        nowMs: () => 0
      })
      expect(absent).toEqual({ ok: false, stage: 'discovery', reason: 'host_discovery_absent' })

      // live host refusing hello → stage 'welcome', discovery pid retained
      const refused = await startWelcomeServer((_hello, socket) => {
        socket.write(`${JSON.stringify({ type: 'error' })}\n`)
      })
      try {
        const refusalDir = scratchDir()
        writeFileSync(join(refusalDir, 'host.token'), TOKEN)
        writeFileSync(
          hostDiscoveryPath(refusalDir),
          JSON.stringify({
            ...VALID_DISCOVERY,
            socketPath: refused.socketPath,
            tokenPath: join(refusalDir, 'host.token')
          })
        )
        const refusedResult = await probeHostBootstrapIdentity({
          userDataPath: refusalDir,
          maxWaitMs: 0,
          timeoutMs: 2000,
          sleep: async () => {}
        })
        expect(refusedResult.ok).toBe(false)
        expect(refusedResult.stage).toBe('welcome')
        expect(refusedResult.reason).toBe('host_hello_refused')
        expect(refusedResult.discovery.pid).toBe(4242)
        expect(JSON.stringify(refusedResult)).not.toContain(TOKEN)
      } finally {
        await refused.close()
      }
    } finally {
      await handled.close()
    }
  })
})
