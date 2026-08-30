import { describe, expect, it } from 'vitest'
import { getTerminalCliCommand, isTerminalCliId } from './terminalCli'

describe('terminal CLI ids', () => {
  it('maps Mistral Vibe to its interactive binary', () => {
    expect(getTerminalCliCommand('mistral')).toBe('vibe')
    expect(getTerminalCliCommand('mistral')).not.toBe('mistral')
  })

  it('returns no command for Default and rejects unknown ids', () => {
    expect(getTerminalCliCommand('default')).toBeNull()
    expect(getTerminalCliCommand('not-a-cli')).toBeNull()
    expect(isTerminalCliId('codex')).toBe(true)
    expect(isTerminalCliId('not-a-cli')).toBe(false)
  })
})
