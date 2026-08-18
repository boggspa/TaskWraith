import { describe, expect, it, vi } from 'vitest'
import {
  AGY_USAGE_COMMAND,
  AGY_USAGE_TUI_ARGS,
  agyQuotaUnavailableSnapshot,
  fetchAuthenticatedAgyQuotaSnapshot,
  parseAgyUsagePanel,
  stripAgyUsageTerminalControls,
  type AgyPtyLike,
  type AgyUsageProbeDependencies
} from './AntigravityUsage'
import { isAuthenticatedAgyRateLimitConnection } from './AntigravityCombinedModelCatalog'

const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }
const now = () => '2026-07-23T12:00:00.000Z'

// The real agy 1.1.8 /usage panel (observed 2026-07-28): pools with two
// sub-limits each, progress bars carrying a bare percentage, and a status
// line. The Gemini weekly here is deliberately partial (42%) and the
// five-hour full so the split is discriminating; the CLAUDE+GPT pool is now
// parsed as a separate 3P bucket as well.
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
    '5% remaining',
    'Five Hour Limit',
    'Quota available'
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

function ptyThatRequiresTrust(
  panel: string,
  selected: 'yes' | 'no' = 'yes'
): { pty: AgyPtyLike; writes: string[] } {
  let onData: ((data: string) => void) | null = null
  let trusted = false
  const writes: string[] = []
  return {
    pty: {
      onData: (listener) => {
        onData = listener
        listener(
          selected === 'yes'
            ? 'Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit'
            : 'Do you trust the contents of this project?\n  Yes, I trust this folder\n> No, exit'
        )
      },
      onExit: () => {},
      write: (data) => {
        writes.push(data)
        if (data === '\r') trusted = true
        if (data === AGY_USAGE_COMMAND && trusted) onData?.(panel)
      },
      kill: () => {}
    },
    writes
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
  it('maps Gemini and CLAUDE+GPT pools to dedicated windows', () => {
    const parsed = parseAgyUsagePanel(observedPanel())

    // Four windows, two from each pool.
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
      },
      {
        id: 'agy-3p-weekly',
        label: 'Claude/GPT Weekly',
        remainingPercent: 5,
        usedPercent: 95,
        limitLabel: '5% remaining'
      },
      {
        id: 'agy-3p-5h',
        label: 'Claude/GPT 5H',
        remainingPercent: 100,
        usedPercent: 0,
        limitLabel: '100% remaining'
      }
    ])
    expect(parsed.windows).toHaveLength(4)
  })

  it('parses the exact screenshot state — both Gemini limits effectively full', () => {
    const parsed = parseAgyUsagePanel(fullPanel())
    expect(parsed.windows).toMatchObject([
      { label: 'Gemini Weekly', remainingPercent: 100 },
      { label: 'Gemini 5H', remainingPercent: 100 }
    ])
  })

  it('finds the agy 1.1.13 panel after accumulated startup redraws', () => {
    const parsed = parseAgyUsagePanel(
      [
        ...Array.from({ length: 24 }, (_, index) => `startup redraw ${index + 1}`),
        '> /usage View model quota usage',
        'Models & Quota',
        'GEMINI MODELS',
        'Models within this group: Gemini Flash, Gemini Pro',
        'Weekly Limit Remaining',
        '100% remaining · Refreshes in 166h 18m',
        'Five Hour Limit Remaining',
        '97% remaining · Refreshes in 52m',
        'CLAUDE AND GPT MODELS',
        'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        'Weekly Limit Remaining',
        '5% remaining · Refreshes in 12h 7m',
        'Five Hour Limit Remaining',
        '88% remaining · Refreshes in 17m'
      ].join('\n')
    )

    expect(parsed.windows).toMatchObject([
      { label: 'Gemini Weekly', remainingPercent: 100 },
      { label: 'Gemini 5H', remainingPercent: 97 },
      { label: 'Claude/GPT Weekly', remainingPercent: 5 },
      { label: 'Claude/GPT 5H', remainingPercent: 88 }
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
      apiOnlyModels,
      // Even with a live probe on record, API-only rows mean no agy lane is
      // offered, so the gate stays shut.
      { source: 'live', cachedAtMs: null },
      Date.parse('2026-07-23T12:00:00.000Z')
    )
    expect(authenticatedConnection).toBe(false)

    // Opted in, but the catalogue holds only `gemini-api:` rows so there is no
    // authenticated agy connection. Reportable rather than silent: `configured`
    // is true and a reason is attached, because the renderer surfaces a quota
    // entry only when it has windows OR configured+error. Returning
    // configured:false here made an unauthenticated CLI look identical to a
    // lane that does not exist.
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
    ).resolves.toMatchObject({
      configured: true,
      error: expect.stringContaining('no authenticated agy connection')
    })

    // The point of this case is unchanged: reporting the state must not touch
    // the binary or spawn a session.
    expect(resolveBinary).not.toHaveBeenCalled()
    expect(spawnPty).not.toHaveBeenCalled()
  })

  it('stays fully silent (configured false, no reason) when no opt-in is recorded', async () => {
    // The one state that must NOT surface: without recorded consent the
    // ban-risk lane does not exist as far as any meter is concerned.
    const resolveBinary = vi.fn()
    const spawnPty = vi.fn()

    const snapshot = await fetchAuthenticatedAgyQuotaSnapshot({}, true, {
      cwd: '/private/tmp/agy-test',
      resolveBinary,
      spawnPty,
      now
    })

    expect(snapshot).toMatchObject({ configured: false })
    expect(snapshot.error).toBeUndefined()
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
    expect(snapshot.windows).toHaveLength(4)
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

  it('confirms trust only for a TaskWraith-created private probe directory', async () => {
    const rendered = ptyThatRequiresTrust(observedPanel())
    const snapshot = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/taskwraith-owned-probe',
      confirmAppOwnedCwdTrust: true,
      resolveBinary: async () => ({ binaryPath: '/Users/test/.local/bin/agy', source: 'path' }),
      spawnPty: () => rendered.pty,
      now,
      ...immediateTimers()
    })

    expect(snapshot.windows).toHaveLength(4)
    expect(rendered.writes).toEqual(['\r', AGY_USAGE_COMMAND])
  })

  it('never confirms a trust prompt without an explicit app-owned-directory signal', async () => {
    const rendered = ptyThatRequiresTrust(observedPanel())
    const snapshot = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/not-asserted-owned',
      resolveBinary: async () => ({ binaryPath: '/Users/test/.local/bin/agy', source: 'path' }),
      spawnPty: () => rendered.pty,
      now,
      timeoutMs: 0,
      ...immediateTimers()
    })

    expect(rendered.writes).not.toContain('\r')
    expect(snapshot.error).toContain('timed out')
  })

  it('does not press Enter unless agy has selected the explicit trust option', async () => {
    const rendered = ptyThatRequiresTrust(observedPanel(), 'no')
    const snapshot = await fetchAuthenticatedAgyQuotaSnapshot(optedIn, true, {
      cwd: '/private/tmp/taskwraith-owned-probe',
      confirmAppOwnedCwdTrust: true,
      resolveBinary: async () => ({ binaryPath: '/Users/test/.local/bin/agy', source: 'path' }),
      spawnPty: () => rendered.pty,
      now,
      timeoutMs: 0,
      ...immediateTimers()
    })

    expect(rendered.writes).not.toContain('\r')
    expect(snapshot.error).toContain('timed out')
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


describe('agyQuotaUnavailableSnapshot', () => {
  // These are the states that used to be indistinguishable blanks. The renderer
  // admits a quota entry only when it has windows OR configured+error, so
  // `configured: true` plus a reason is what makes each one visible at all.
  it('marks the lane configured and carries the reason', () => {
    const snapshot = agyQuotaUnavailableSnapshot('because reasons.', now)
    expect(snapshot).toMatchObject({
      provider: 'antigravity',
      source: 'agy-usage-tui',
      configured: true,
      fetchedAt: '2026-07-23T12:00:00.000Z',
      error: 'Quota unavailable: because reasons.'
    })
  })

  it('reports no windows, so the caller cannot mistake it for quota data', () => {
    expect(agyQuotaUnavailableSnapshot('nope.', now).windows).toBeUndefined()
  })

})
