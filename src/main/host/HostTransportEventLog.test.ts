import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostLifecycleSnapshot } from '../../shared/hostLifecycle'
import {
  createHostTransportEventLog,
  redactHostTransportText,
  type HostTransportEventLog
} from './HostTransportEventLog'

const PREFIX = 'tw-host-transport-log-'
const created: string[] = []

/** Only ever the exact directory mkdtemp returned, asserted before removal. */
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), PREFIX))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    if (
      dir === tmpdir() ||
      !dir.startsWith(`${tmpdir()}${sep}`) ||
      !basename(dir).startsWith(PREFIX)
    ) {
      throw new Error(`refusing to remove ${dir}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function lines(log: HostTransportEventLog): Array<Record<string, unknown>> {
  const read = (path: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  return `${read(log.previousPath)}${read(log.path)}`
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function bytes(log: HostTransportEventLog): number {
  const size = (path: string): number => {
    try {
      return readFileSync(path).byteLength
    } catch {
      return 0
    }
  }
  return size(log.previousPath) + size(log.path)
}

describe('Host transport event log bound', () => {
  it('keeps at most maxEntries, newest last, across rotations', async () => {
    const log = createHostTransportEventLog({ profilePath: profile(), maxEntries: 10 })
    for (let index = 0; index < 35; index += 1) {
      log.record({ kind: 'client-connected', clientId: `client-${index}`, reconnect: index > 0 })
      if (index % 3 === 0) await log.flush()
    }
    await log.flush()
    const kept = lines(log)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThanOrEqual(10)
    expect(kept.at(-1)?.clientId).toBe('client-34')
    expect(kept.some((entry) => entry.clientId === 'client-0')).toBe(false)
  })

  it('keeps the files within maxBytes when entries are large', async () => {
    const log = createHostTransportEventLog({ profilePath: profile(), maxBytes: 8 * 1024 })
    for (let index = 0; index < 20; index += 1) {
      log.lifecycleFailure({
        reason: 'start-failed',
        error: new Error(`launch ${index} failed. stderr: ${'trace '.repeat(300)}end-${index}`)
      })
      await log.flush()
    }
    expect(bytes(log)).toBeLessThanOrEqual(8 * 1024)
    expect(String(lines(log).at(-1)?.stderrTail)).toContain('end-19')
  })

  it('writes queued entries synchronously on the exit path', () => {
    const log = createHostTransportEventLog({ profilePath: profile() })
    log.record({ kind: 'host-closing', clientId: 'desktop' })
    log.flushSync()
    expect(lines(log)).toEqual([expect.objectContaining({ kind: 'host-closing' })])
  })
})

describe('Host transport event log redaction', () => {
  it('never writes tokens, env values or bearer credentials', async () => {
    const log = createHostTransportEventLog({ profilePath: profile() })
    const secrets = [
      'f3a9c1d2e4b5a6978877665544332211aabbccdd',
      'sk-livekey1234567890abcdef',
      'hunter2',
      'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'org-not-a-secret-name'
    ]
    // Noise FIRST: the stderr tail is kept, so every secret must sit inside it
    // or this test would pass by truncation rather than by redaction.
    log.lifecycleFailure({
      reason: 'start-failed',
      error: new Error(
        `External Host exited 1 before readiness. stderr: ${'noise '.repeat(600)}` +
          `OPENAI_ORG=${secrets[4]} digest ${secrets[0]} key ${secrets[1]} ` +
          `password: ${secrets[2]} Authorization: Bearer ${secrets[3]} ` +
          'HostProjectionHandshakeClosedBeforeWelcomeError last line'
      )
    })
    log.clientEvent({ kind: 'disconnected', clientId: 'desktop', error: `token=${secrets[2]}` })
    await log.flush()
    const written = `${readFileSync(log.path, 'utf8')}`
    for (const secret of secrets) expect(written).not.toContain(secret)
    expect(written).toContain('[redacted]')
    const failure = lines(log)[0]
    expect(failure.kind).toBe('lifecycle-failure')
    expect(failure.error).toBe('External Host exited 1 before readiness.')
    // The TAIL survives the bound, so the last stderr line is kept.
    expect(String(failure.stderrTail).length).toBeLessThanOrEqual(2_000)
    expect(String(failure.stderrTail)).toContain(
      'HostProjectionHandshakeClosedBeforeWelcomeError last line'
    )
    expect(String(failure.stderrTail)).toContain('OPENAI_ORG=[redacted]')
  })

  it('bounds free text from the head unless asked for the tail', () => {
    expect(redactHostTransportText('a'.repeat(10) + 'END', 5)).toBe('aaaaa')
    expect(redactHostTransportText('START' + 'b'.repeat(10), 5, 'tail')).toBe('bbbbb')
  })
})

describe('Host transport event log recording', () => {
  it('records broker transport errors and lifecycle transitions with durations', async () => {
    const log = createHostTransportEventLog({ profilePath: profile() })
    log.transportError({
      code: 'unauthorized',
      operation: 'catalogue',
      clientId: 'desktop',
      connected: true
    })
    let listener: ((snapshot: HostLifecycleSnapshot) => void) | undefined
    const snapshot = (
      phase: HostLifecycleSnapshot['phase'],
      changedAt: string
    ): HostLifecycleSnapshot => ({
      revision: 1,
      phase,
      desired: 'running',
      reason: 'app-start',
      changedAt,
      ...(phase === 'running' ? { host: { pid: 4242, hostId: 'h', startedAt: changedAt } } : {})
    })
    log.observeLifecycle({
      getSnapshot: () => snapshot('stopped', '2026-10-07T15:53:50.000Z'),
      subscribe: (next) => {
        listener = next
        return () => undefined
      }
    })
    listener!(snapshot('starting', '2026-10-07T15:53:51.000Z'))
    listener!(snapshot('running', '2026-10-07T15:53:53.250Z'))
    await log.flush()
    expect(lines(log)).toEqual([
      expect.objectContaining({
        kind: 'transport-error',
        code: 'unauthorized',
        operation: 'catalogue',
        clientId: 'desktop',
        connected: true
      }),
      expect.objectContaining({
        kind: 'lifecycle',
        phase: 'starting',
        from: 'stopped',
        durationMs: 1000
      }),
      expect.objectContaining({
        kind: 'lifecycle',
        phase: 'running',
        from: 'starting',
        durationMs: 2250,
        hostPid: 4242
      })
    ])
  })

  it('never throws into its caller when the profile cannot hold the log', async () => {
    const dir = profile()
    // A FILE where the log directory belongs: every write fails.
    writeFileSync(join(dir, 'diagnostics'), 'not a directory')
    const log = createHostTransportEventLog({ profilePath: dir })
    expect(() => log.record({ kind: 'host-closing', clientId: 'desktop' })).not.toThrow()
    await expect(log.flush()).resolves.toBeUndefined()
    expect(() => {
      log.record({ kind: 'host-closing', clientId: 'desktop' })
      log.flushSync()
    }).not.toThrow()
    log.dispose()
  })
})
