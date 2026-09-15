import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveClaudeContextPreference } from './ClaudeContextPreference'

describe('Claude compaction preference forwarding', () => {
  it('forwards the saved window without importing executable or permission settings', () => {
    const readSettings = vi.fn(() =>
      JSON.stringify({
        autoCompactWindow: 650_000,
        hooks: { PreToolUse: ['untrusted-command'] },
        permissions: { defaultMode: 'bypassPermissions' },
        env: { ANTHROPIC_BASE_URL: 'untrusted-endpoint' }
      })
    )
    const original = { HOME: '/test/home', TASKWRAITH_RUN_ID: 'run-1' }
    const result = resolveClaudeContextPreference(original, { readSettings })
    // Built with join: the module joins with the host path module, so a POSIX
    // literal cannot match the backslashes win32 emits.
    expect(readSettings).toHaveBeenCalledWith(join('/test/home', '.claude', 'settings.json'))
    expect(result.env).toEqual({ ...original, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '650000' })
    expect(result.preference).toEqual({ source: 'user-settings', windowTokens: 650_000 })
    expect(original).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  })

  it('honours the selected Claude config directory', () => {
    const readSettings = vi.fn(() => '{"autoCompactWindow":750000}')
    const result = resolveClaudeContextPreference(
      { CLAUDE_CONFIG_DIR: '/selected/claude' },
      { readSettings }
    )
    expect(readSettings).toHaveBeenCalledWith(join('/selected/claude', 'settings.json'))
    expect(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('750000')
  })

  it.each(['800000', 'invalid'])('preserves an explicit environment override (%s)', (override) => {
    const readSettings = vi.fn()
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: override }
    const result = resolveClaudeContextPreference(env, { readSettings })
    expect(result.env).toBe(env)
    expect(result.preference.source).toBe('environment')
    expect(readSettings).not.toHaveBeenCalled()
  })

  it.each([null, {}, '650000', 0, -1, 99_999, 1_000_001, 650_000.5])(
    'retains native defaults for an unsupported saved value (%j)',
    (value) => {
      const env = { HOME: '/test/home' }
      expect(
        resolveClaudeContextPreference(env, {
          readSettings: () => JSON.stringify({ autoCompactWindow: value })
        })
      ).toEqual({ env, preference: { source: 'provider-default' } })
    }
  )

  it.each(['{bad json', 'null', '[]'])('tolerates malformed settings (%s)', (settings) => {
    expect(
      resolveClaudeContextPreference({}, { readSettings: () => settings }).preference.source
    ).toBe('provider-default')
  })

  it('tolerates a missing file and observes preference changes on the next launch', () => {
    const readSettings = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('ENOENT')
      })
      .mockReturnValueOnce('{"autoCompactWindow":650000}')
      .mockReturnValueOnce('{"autoCompactWindow":800000}')
    expect(resolveClaudeContextPreference({}, { readSettings }).preference.source).toBe(
      'provider-default'
    )
    const first = resolveClaudeContextPreference({}, { readSettings })
    const next = resolveClaudeContextPreference({}, { readSettings })
    expect(first.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('650000')
    expect(next.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('800000')
  })
})
