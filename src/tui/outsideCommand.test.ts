import { describe, expect, it } from 'vitest'
import { parseOutsideCommand } from './outsideCommand'
import { TuiUsageError } from './tuiUsageError'

const defaults = { cwd: '/repo/worktree' }

describe('parseOutsideCommand', () => {
  it('leaves every interactive and flag-only invocation to the TUI parser', () => {
    expect(parseOutsideCommand([], defaults)).toBeNull()
    expect(parseOutsideCommand(['--json'], defaults)).toBeNull()
    expect(parseOutsideCommand(['--thread', 'abc'], defaults)).toBeNull()
    expect(parseOutsideCommand(['--demo'], defaults)).toBeNull()
  })

  it('parses a send as selector plus the remaining words, scoped to the working tree', () => {
    expect(parseOutsideCommand(['send', 'host-persistence', 'nice', 'work'], defaults)).toEqual({
      kind: 'send',
      selector: 'host-persistence',
      text: 'nice work',
      cwd: '/repo/worktree',
      json: false
    })
  })

  it('keeps the send text verbatim, including flag-like words after the selector', () => {
    expect(parseOutsideCommand(['send', 't-1', 'try', '--json', 'next'], defaults)).toMatchObject({
      text: 'try --json next',
      json: false
    })
  })

  it('accepts the sender label and machine output before the selector', () => {
    expect(
      parseOutsideCommand(['send', '--from', 'Codex', '--json', 't-1', 'go'], defaults)
    ).toEqual({
      kind: 'send',
      selector: 't-1',
      text: 'go',
      from: 'Codex',
      cwd: '/repo/worktree',
      json: true
    })
  })

  it('leaves text unset when there are no words, so the caller can read stdin', () => {
    expect(parseOutsideCommand(['send', 't-1'], defaults)).not.toHaveProperty('text')
  })

  it('scopes threads to the working tree unless every workspace is requested', () => {
    expect(parseOutsideCommand(['threads'], defaults)).toEqual({
      kind: 'threads',
      cwd: '/repo/worktree',
      json: false
    })
    expect(parseOutsideCommand(['threads', '--all'], defaults)).toEqual({
      kind: 'threads',
      json: false
    })
    expect(parseOutsideCommand(['threads', '--query=host', '--json'], defaults)).toEqual({
      kind: 'threads',
      query: 'host',
      cwd: '/repo/worktree',
      json: true
    })
  })

  it('honours an explicit working tree over the caller default', () => {
    expect(parseOutsideCommand(['threads', '--cwd', '/elsewhere'], defaults)).toMatchObject({
      cwd: '/elsewhere'
    })
  })

  it('parses a read as a thread selector scoped to the working tree', () => {
    expect(parseOutsideCommand(['read', 'host-persistence'], defaults)).toEqual({
      kind: 'read',
      selector: 'host-persistence',
      cwd: '/repo/worktree',
      json: false
    })
  })

  it('accepts a row limit and machine output on a read', () => {
    expect(parseOutsideCommand(['read', '--limit', '5', '--json', 't-1'], defaults)).toMatchObject({
      kind: 'read',
      selector: 't-1',
      limit: 5,
      json: true
    })
  })

  it('refuses a read with no thread, and a limit that is not a positive count', () => {
    expect(() => parseOutsideCommand(['read'], defaults)).toThrow(/thread/i)
    expect(() => parseOutsideCommand(['read', '--limit', 'lots', 't-1'], defaults)).toThrow(
      /--limit/
    )
    expect(() => parseOutsideCommand(['read', '--limit', '0', 't-1'], defaults)).toThrow(/--limit/)
  })

  it('parses the mcp verb, which always carries a default scope for its tool calls', () => {
    expect(parseOutsideCommand(['mcp'], defaults)).toEqual({ kind: 'mcp', cwd: '/repo/worktree' })
    expect(parseOutsideCommand(['mcp', '--cwd', '/elsewhere'], defaults)).toEqual({
      kind: 'mcp',
      cwd: '/elsewhere'
    })
  })

  it('refuses stray arguments after mcp rather than silently ignoring them', () => {
    expect(() => parseOutsideCommand(['mcp', 'send'], defaults)).toThrow(/mcp/i)
    expect(() => parseOutsideCommand(['mcp', '--nope'], defaults)).toThrow(/--nope/)
  })

  it('refuses a send with no thread selector', () => {
    expect(() => parseOutsideCommand(['send'], defaults)).toThrow(/thread/i)
  })

  it('refuses an unknown flag rather than treating it as a selector', () => {
    expect(() => parseOutsideCommand(['threads', '--nope'], defaults)).toThrow(/--nope/)
    expect(() => parseOutsideCommand(['send', '--nope', 't-1', 'go'], defaults)).toThrow(/--nope/)
  })

  it('refuses a flag that is missing its value', () => {
    expect(() => parseOutsideCommand(['send', '--from'], defaults)).toThrow(/--from/)
  })

  it('reports malformed verbs as usage errors for the exit-code contract', () => {
    expect(() => parseOutsideCommand(['send'], defaults)).toThrow(TuiUsageError)
    expect(() => parseOutsideCommand(['threads', '--nope'], defaults)).toThrow(TuiUsageError)
    expect(() => parseOutsideCommand(['mcp', 'send'], defaults)).toThrow(TuiUsageError)
  })
})
