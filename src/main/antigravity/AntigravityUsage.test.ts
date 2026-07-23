import { describe, expect, it, vi } from 'vitest'
import {
  AGY_USAGE_COMMAND,
  AGY_USAGE_TUI_ARGS,
  fetchAuthenticatedAgyQuotaSnapshot,
  parseAgyUsagePanel,
  stripAgyUsageTerminalControls,
  type AgyPtyLike,
  type AgyUsageProbeDependencies
} from './AntigravityUsage'

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
  it('keeps only exact observed tier, groups, remaining percentages, and reset text', () => {
    const parsed = parseAgyUsagePanel(observedPanel())

    expect(parsed.planType).toBe('Antigravity Starter')
    expect(parsed.windows).toMatchObject([
      {
        label: 'Gemini models',
        remainingPercent: 85,
        usedPercent: 15,
        resetAt: '2026-07-24T12:00:00.000Z',
        limitLabel: '85% remaining · refresh: 2026-07-24T12:00:00.000Z'
      },
      {
        label: 'Claude + GPT models',
        remainingPercent: 20,
        usedPercent: 80,
        limitLabel: '20% remaining · refresh: Jul 30, 09:00 UTC'
      }
    ])
  })

  it('fails closed for output without an official usage heading or supported groups', () => {
    expect(parseAgyUsagePanel('Gemini models\n85% remaining').windows).toEqual([])
    expect(parseAgyUsagePanel('Usage\nSome other product\n85% remaining').windows).toEqual([])
    expect(parseAgyUsagePanel('Usage\nGemini models\n105% remaining').windows).toEqual([])
  })

  it('accepts the documented pool labels with or without the visual "models" suffix', () => {
    expect(
      parseAgyUsagePanel('Usage\nGemini\n85% remaining\nClaude & GPT\n20% remaining').windows
    ).toMatchObject([
      { label: 'Gemini', remainingPercent: 85 },
      { label: 'Claude & GPT', remainingPercent: 20 }
    ])
  })

  it('strips terminal controls before inspecting the panel', () => {
    expect(stripAgyUsageTerminalControls('\u001b[32mUsage\u001b[0m\rGemini models')).toBe(
      'Usage\nGemini models'
    )
  })
})

describe('fetchAuthenticatedAgyQuotaSnapshot', () => {
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
