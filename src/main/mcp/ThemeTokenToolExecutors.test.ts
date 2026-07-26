import { describe, expect, it, vi } from 'vitest'
import { createThemeTokenToolExecutor } from './ThemeTokenToolExecutors'
import type { AgentThemeTokenOverrides } from '../../shared/agentThemeTokens'

function makeExecutor(initial: unknown = {}) {
  let stored: unknown = initial
  const setOverrides = vi.fn(async (next: AgentThemeTokenOverrides) => {
    stored = next
  })
  const { executeThemeTokenTool } = createThemeTokenToolExecutor({
    getOverrides: () => stored,
    setOverrides
  })
  return { executeThemeTokenTool, setOverrides, read: () => stored }
}

describe('theme_tokens_get', () => {
  it('reports the current overrides and the writable set with bounds', async () => {
    const { executeThemeTokenTool } = makeExecutor({ 'radius-md': '14px' })
    const result = await executeThemeTokenTool('theme_tokens_get', {})
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('radius-md: 14px')
    // The model needs the bounds to choose without guessing.
    expect(result.text).toContain('sidebar-width')
    expect(result.text).toMatch(/180\.\.520/)
  })

  it('says so plainly when nothing is overridden', async () => {
    const { executeThemeTokenTool } = makeExecutor({})
    const result = await executeThemeTokenTool('theme_tokens_get', {})
    expect(result.text).toContain('none')
  })

  it('never surfaces a value that is no longer allowlisted', async () => {
    // Read goes through the same validator as write, so a stale stored entry
    // cannot be reported back as if it were live.
    const { executeThemeTokenTool } = makeExecutor({ 'provider-claude-color': '#FFFFFF' })
    const result = await executeThemeTokenTool('theme_tokens_get', {})
    expect(result.text).not.toContain('provider-claude-color')
  })
})

describe('theme_tokens_set', () => {
  it('applies valid tokens and persists the merged map', async () => {
    const { executeThemeTokenTool, setOverrides, read } = makeExecutor({ 'radius-sm': '4px' })
    const result = await executeThemeTokenTool('theme_tokens_set', {
      tokens: { 'radius-md': 14, 'scrollbar-thumb': '#abc' }
    })
    expect(result.isError).toBeFalsy()
    expect(setOverrides).toHaveBeenCalledTimes(1)
    // Merges rather than replaces — an unrelated existing override survives.
    expect(read()).toEqual({
      'radius-sm': '4px',
      'radius-md': '14px',
      'scrollbar-thumb': '#AABBCC'
    })
  })

  it('applies the good entries and reports the bad ones individually', async () => {
    // A model that mistyped one value should not have to re-send the rest, and
    // needs to know WHICH entry was wrong to correct itself.
    const { executeThemeTokenTool, read } = makeExecutor({})
    const result = await executeThemeTokenTool('theme_tokens_set', {
      tokens: { 'radius-md': 14, 'radius-lg': 'calc(2px)', 'provider-claude-color': '#000' }
    })
    expect(result.isError).toBeFalsy()
    expect(read()).toEqual({ 'radius-md': '14px' })
    expect(result.text).toContain('radius-lg')
    expect(result.text).toContain('provider-claude-color')
    expect(result.text).toContain('not an allowlisted token')
  })

  it('errors without persisting when every entry is invalid', async () => {
    // Otherwise a fully-rejected call reads as a successful restyle.
    const { executeThemeTokenTool, setOverrides } = makeExecutor({})
    const result = await executeThemeTokenTool('theme_tokens_set', {
      tokens: { 'provider-claude-color': '#000', nonsense: 1 }
    })
    expect(result.isError).toBe(true)
    expect(setOverrides).not.toHaveBeenCalled()
  })

  it('errors when given nothing to do', async () => {
    const { executeThemeTokenTool, setOverrides } = makeExecutor({})
    const result = await executeThemeTokenTool('theme_tokens_set', {})
    expect(result.isError).toBe(true)
    expect(setOverrides).not.toHaveBeenCalled()
  })

  it('resets before applying, so one call can wipe and re-set', async () => {
    const { executeThemeTokenTool, read } = makeExecutor({
      'radius-sm': '4px',
      'radius-lg': '20px'
    })
    await executeThemeTokenTool('theme_tokens_set', {
      reset: true,
      tokens: { 'radius-md': 10 }
    })
    expect(read()).toEqual({ 'radius-md': '10px' })
  })

  it('accepts a bare reset with no tokens', async () => {
    const { executeThemeTokenTool, read } = makeExecutor({ 'radius-sm': '4px' })
    const result = await executeThemeTokenTool('theme_tokens_set', { reset: true })
    expect(result.isError).toBeFalsy()
    expect(read()).toEqual({})
  })

  it('cannot be used to reach a non-allowlisted property', async () => {
    // The security claim of the whole feature, asserted at the transport too and
    // not only in the validator's own unit tests.
    const { executeThemeTokenTool, read } = makeExecutor({})
    await executeThemeTokenTool('theme_tokens_set', {
      tokens: {
        'focus-ring': '#FF0000',
        'header-height': 0,
        'provider-codex-color': '#B16105'
      }
    })
    expect(read()).toEqual({})
  })

  it('tolerates a malformed tokens payload without throwing', async () => {
    const { executeThemeTokenTool } = makeExecutor({})
    for (const tokens of ['string', 42, [], null]) {
      const result = await executeThemeTokenTool('theme_tokens_set', { tokens })
      expect(result.isError).toBe(true)
    }
  })
})

describe('dispatch', () => {
  it('fails closed on an unknown tool rather than returning empty success', async () => {
    // The top-level dispatcher has no terminal else, so a family executor that
    // answered {text:''} here would surface as a SUCCESSFUL empty tool call.
    const { executeThemeTokenTool } = makeExecutor({})
    const result = await executeThemeTokenTool('theme_tokens_teleport', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Unknown theme token tool')
  })
})
