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

// The real agy 1.1.8 /usage panel (observed 2026-07-28): pools with two
// sub-limits each, progress bars carrying a bare percentage, and a status
// line. The Gemini weekly here is deliberately partial (42%) and the
// five-hour full so the split is discriminating; the Claude pool is ignored.
function observedPanel(): string {
  return [
    '\u001b[1mModels & Quota\u001b[0m',
    'Account: chrisizatt@hotmail.co.uk',
    'GEMINI MODELS',
    'Models within this group: Gemini Flash, Gemini Pro',
    'Weekly Limit',
    '\u2588\u2588\u2588\u2588 42.00%',
    '42% remaining \u00b7 Refreshes in 91h 44m',
    'Five Hour Limit',
    '\u2588\u2588\u2588\u2588 100.00%',
    'Quota available',
    'CLAUDE AND GPT MODELS',
    'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
    'Weekly Limit',
    '5% remaining'
  ].join('\n')
}

// The exact screenshot state \u2014 both Gemini limits effectively full.
function fullPanel(): string {
  return [
    'Models & Quota',
    'GEMINI MODELS',
    'Models within this group: Gemini Flash, Gemini Pro',
    'Weekly Limit',
    '\u2588\u2588\u2588\u2588 99.91%',
    '100% remaining \u00b7 Refreshes in 91h 44m',
    'Five Hour Limit',
    '\u2588\u2588\u2588\u2588 100.00%',
    'Quota available'
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
  it('splits the Gemini pool into Weekly + Five-Hour windows and ignores Claude', () => {
    const parsed = parseAgyUsagePanel(observedPanel())

    // Two windows, both from the GEMINI region. The CLAUDE AND GPT pool's own
    // "Weekly Limit / 5% remaining" is outside the region and never read.
    expect(parsed.windows).toMatchObject([
      {
        id: 'agy-gemini-weekly',
        label: 'Gemini Weekly',
        remainingPercent: 42,
        usedPercent: 58,
        limitLabel: '42% remaining · refresh: in 91h 44m'
      },
      {
        id: 'agy-gemini-5h',
        label: 'Gemini 5H',
        remainingPercent: 100,
        usedPercent: 0,
        limitLabel: '100% remaining'
      }
    ])
    expect(parsed.windows).toHaveLength(2)
    // "Refreshes in 91h 44m" is relative, not an ISO instant, so no resetAt.
    expect(parsed.windows[0].resetAt).toBeUndefined()
    expect(parsed.windows.some((window) => window.remainingPercent === 5)).toBe(false)
  })

  it('parses the exact screenshot state — both Gemini limits effectively full', () => {
    const parsed = parseAgyUsagePanel(fullPanel())
    expect(parsed.windows).toMatchObject([
      { label: 'Gemini Weekly', remainingPercent: 100 },
      { label: 'Gemini 5H', remainingPercent: 100 }
    ])
  })

  it('reads the bar percentage when there is no explicit remaining text', () => {
    const parsed = parseAgyUsagePanel(
      ['Quota', 'GEMINI MODELS', 'Weekly Limit', '████ 73.5%'].join('\n')
    )
    expect(parsed.windows).toMatchObject([{ label: 'Gemini Weekly', remainingPercent: 73.5 }])
  })

  it('fails closed for output without an official usage heading or Gemini pool', () => {
    expect(parseAgyUsagePanel('Weekly Limit\n85% remaining').windows).toEqual([])
    expect(parseAgyUsagePanel('Quota\nSome other product\n85% remaining').windows).toEqual([])
    expect(
      parseAgyUsagePanel('Quota\nGEMINI MODELS\nWeekly Limit\nnothing here').windows
    ).toEqual([])
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
      configured: true
    })
    expect(snapshot.windows).toHaveLength(2)
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
