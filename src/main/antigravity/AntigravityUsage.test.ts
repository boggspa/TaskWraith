import { describe, expect, it, vi } from 'vitest'
import {
  AGY_USAGE_COMMAND,
  AGY_USAGE_TUI_ARGS,
  fetchAuthenticatedAgyQuotaSnapshot,
  parseAgyUsagePanel,
  stripAgyUsageTerminalControls,
  type AgyPtyLike,
  type AgyUsageProbeDependencies
,
  agyUsageProbeDecision,
  AGY_USAGE_MANUAL_MIN_INTERVAL_MS
} from './AntigravityUsage'
import { isAuthenticatedAgyRateLimitConnection } from './AntigravityCombinedModelCatalog'

const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }
const now = () => '2026-07-23T12:00:00.000Z'

function observedPanel(): string {
  return [
    '\u001b[1mUsage & quota\u001b[0m',
    'Plan: Antigravity Starter',
    'Gemini models',
    '85% remaining',
    'Refreshes: 2026-07-24T12:00:00.000Z',
    'Claude + GPT models',
    'Remaining: 20%',
    'Next reset: Jul 30, 09:00 UTC'
  ].join('\n')
}

function ptyThatRenders(panel: string): { pty: AgyPtyLike; writes: string[]; killed: () => boolean } {
  let onData: ((data: string) => void) | null = null
  let onExit: ((event: { exitCode: number }) => void) | null = null
  let killed = false
  const writes: string[] = []
  return {
    pty: {
      onData: (listener) => {
        onData = listener
      },
      onExit: (listener) => {
        onExit = listener
      },
      write: (data) => {
        writes.push(data)
        if (data === AGY_USAGE_COMMAND) onData?.(panel)
      },
      kill: () => {
        killed = true
        onExit?.({ exitCode: 0 })
      }
    },
    writes,
    killed: () => killed
  }
}

function immediateTimers(): Pick<AgyUsageProbeDependencies, 'setTimer' | 'clearTimer'> {
  return {
    setTimer: (callback) => {
      callback()
      return null
    },
    clearTimer: () => {}
  }
}

describe('parseAgyUsagePanel', () => {
  it('keeps only the Gemini pool — resold-model pools are never surfaced', () => {
    const parsed = parseAgyUsagePanel(observedPanel())

    expect(parsed.planType).toBe('Antigravity Starter')
    // The panel also prints a "Claude + GPT models" pool; those models were
    // removed from the agy offer entirely, so metering the pool would only
    // advertise the extra-ToS-risk lane. Gemini is the whole story.
    expect(parsed.windows).toMatchObject([
      {
        label: 'Gemini models',
        remainingPercent: 85,
        usedPercent: 15,
        resetAt: '2026-07-24T12:00:00.000Z',
        limitLabel: '85% remaining · refresh: 2026-07-24T12:00:00.000Z'
      }
    ])
    expect(parsed.windows).toHaveLength(1)
  })

  it('fails closed for output without an official usage heading or supported groups', () => {
    expect(parseAgyUsagePanel('Gemini models\n85% remaining').windows).toEqual([])
    expect(parseAgyUsagePanel('Usage\nSome other product\n85% remaining').windows).toEqual([])
    expect(parseAgyUsagePanel('Usage\nGemini models\n105% remaining').windows).toEqual([])
  })

  it('accepts Gemini pool labels with or without the "models" suffix and skips the rest', () => {
    expect(
      parseAgyUsagePanel('Usage\nGemini\n85% remaining\nClaude & GPT\n20% remaining').windows
    ).toMatchObject([{ label: 'Gemini', remainingPercent: 85 }])
  })

  it('strips terminal controls before inspecting the panel', () => {
    expect(stripAgyUsageTerminalControls('\u001b[32mUsage\u001b[0m\rGemini models')).toBe(
      'Usage\nGemini models'
    )
  })
})

describe('fetchAuthenticatedAgyQuotaSnapshot', () => {
  it('keeps the get-agent-rate-limits API-only path side-effect free', async () => {
    const apiOnlyModels = [
      { id: 'gemini-api:gemini-2.5-flash', label: 'Gemini API · flash · separate billing' }
    ]
    const resolveBinary = vi.fn()
    const spawnPty = vi.fn()

    const authenticatedConnection = isAuthenticatedAgyRateLimitConnection(
      { ready: true, configuredProviders: new Set(['antigravity']) },
      apiOnlyModels
    )
    expect(authenticatedConnection).toBe(false)

    await expect(
      fetchAuthenticatedAgyQuotaSnapshot(
        optedIn,
        authenticatedConnection,
        {
          cwd: '/private/tmp/agy-test',
          resolveBinary,
          spawnPty,
          now
        }
      )
    ).resolves.toMatchObject({ configured: false })

    expect(resolveBinary).not.toHaveBeenCalled()
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('does not resolve or launch before recorded consent and authenticated S4 connection', async () => {
    const resolveBinary = vi.fn()
    const spawnPty = vi.fn()

    await expect(
      fetchAuthenticatedAgyQuotaSnapshot({}, false, {
        cwd: '/private/tmp/agy-test',
        resolveBinary,
        spawnPty,
        now
      })
    ).resolves.toMatchObject({ configured: false })

    expect(resolveBinary).not.toHaveBeenCalled()
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('uses only the sandboxed official TUI command with a credential-sanitized environment', async () => {
    const rendered = ptyThatRenders(observedPanel())
    const spawnPty = vi.fn(() => rendered.pty)
    const snapshot = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/agy-test',
      resolveBinary: async () => ({ binaryPath: '/Users/test/.local/bin/agy', source: 'path' }),
      spawnPty,
      inheritedEnv: {
        PATH: '/Users/test/.local/bin',
        GEMINI_API_KEY: 'never-forward',
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/credentials.json'
      },
      now,
      ...immediateTimers()
    })

    expect(snapshot).toMatchObject({
      provider: 'antigravity',
      configured: true,
      planType: 'Antigravity Starter'
    })
    expect(snapshot.windows).toHaveLength(1)
    expect(spawnPty).toHaveBeenCalledWith(
      '/Users/test/.local/bin/agy',
      AGY_USAGE_TUI_ARGS,
      expect.objectContaining({
        cwd: '/private/tmp/agy-test',
        env: expect.not.objectContaining({
          GEMINI_API_KEY: expect.anything(),
          GOOGLE_APPLICATION_CREDENTIALS: expect.anything()
        })
      })
    )
    expect(rendered.writes).toEqual([AGY_USAGE_COMMAND])
    expect(rendered.writes.join(' ')).not.toContain('dangerously-skip-permissions')
    expect(rendered.writes.join(' ')).not.toContain('new-project')
    expect(rendered.killed()).toBe(true)
  })

  it('returns structured quota-unavailable data for timeout, unsupported output, and resolver failure', async () => {
    const silent: AgyPtyLike = {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      kill: () => {}
    }
    const timedOut = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/agy-test',
      resolveBinary: async () => ({ binaryPath: '/agy', source: 'path' }),
      spawnPty: () => silent,
      now,
      readyDelayMs: 100,
      timeoutMs: 0,
      ...immediateTimers()
    })
    const unsupported = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/agy-test',
      resolveBinary: async () => ({ binaryPath: '/agy', source: 'path' }),
      spawnPty: () => ptyThatRenders('Usage\nGemini models\nnot available').pty,
      now,
      ...immediateTimers()
    })
    const unresolved = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/agy-test',
      resolveBinary: async () => Promise.reject(new Error('missing')),
      spawnPty: () => silent,
      now
    })

    for (const snapshot of [timedOut, unsupported, unresolved]) {
      expect(snapshot).toMatchObject({ provider: 'antigravity', configured: true })
      expect(snapshot.windows).toBeUndefined()
      expect(snapshot.error).toMatch(/^Quota unavailable:/)
    }
  })
})


describe('agyUsageProbeDecision', () => {
  const T0 = 1_000_000

  it('never lets an automatic caller reach the PTY — cache or unavailable', () => {
    expect(
      agyUsageProbeDecision({ force: false, nowMs: T0, cacheFetchedAtMs: null, lastAttemptAtMs: null })
    ).toBe('unavailable')
    // Even an arbitrarily stale cache is served rather than refreshed.
    expect(
      agyUsageProbeDecision({
        force: false,
        nowMs: T0 + 24 * 60 * 60 * 1000,
        cacheFetchedAtMs: T0,
        lastAttemptAtMs: T0
      })
    ).toBe('serve-cache')
  })

  it('lets the first manual refresh probe, then clamps mashing to the window', () => {
    expect(
      agyUsageProbeDecision({ force: true, nowMs: T0, cacheFetchedAtMs: null, lastAttemptAtMs: null })
    ).toBe('probe')
    expect(
      agyUsageProbeDecision({
        force: true,
        nowMs: T0 + 30_000,
        cacheFetchedAtMs: null,
        lastAttemptAtMs: T0
      })
    ).toBe('unavailable')
    expect(
      agyUsageProbeDecision({
        force: true,
        nowMs: T0 + 30_000,
        cacheFetchedAtMs: T0,
        lastAttemptAtMs: T0
      })
    ).toBe('serve-cache')
    expect(
      agyUsageProbeDecision({
        force: true,
        nowMs: T0 + AGY_USAGE_MANUAL_MIN_INTERVAL_MS + 1,
        cacheFetchedAtMs: T0,
        lastAttemptAtMs: T0
      })
    ).toBe('probe')
  })

  it('serves a fresh cache to a manual refresh without spawning', () => {
    expect(
      agyUsageProbeDecision({
        force: true,
        nowMs: T0 + 60_000,
        cacheFetchedAtMs: T0,
        lastAttemptAtMs: T0 - 10 * 60 * 1000
      })
    ).toBe('serve-cache')
  })

  it('clamps on ATTEMPT time, not success — a failing probe cannot retry-spam', () => {
    expect(
      agyUsageProbeDecision({
        force: true,
        nowMs: T0 + 60_000,
        cacheFetchedAtMs: null,
        lastAttemptAtMs: T0
      })
    ).toBe('unavailable')
  })
})
