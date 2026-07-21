import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cursorDebugEnabled } from './cursorGate'

describe('cursorDebugEnabled', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.TASKWRAITH_CURSOR_DEBUG
    delete process.env.TASKWRAITH_CURSOR_DEBUG
  })

  afterEach(() => {
    if (original === undefined) delete process.env.TASKWRAITH_CURSOR_DEBUG
    else process.env.TASKWRAITH_CURSOR_DEBUG = original
  })

  it('defaults off', () => {
    expect(cursorDebugEnabled()).toBe(false)
  })

  it('turns on for documented opt-in values', () => {
    for (const value of ['1', 'true', 'yes']) {
      process.env.TASKWRAITH_CURSOR_DEBUG = value
      expect(cursorDebugEnabled()).toBe(true)
    }
  })

  it('stays off for false-ish, malformed, uppercase, or padded values', () => {
    for (const value of ['', '0', 'false', 'no', 'TRUE', 'YES', ' yes ', 'random']) {
      process.env.TASKWRAITH_CURSOR_DEBUG = value
      expect(cursorDebugEnabled()).toBe(false)
    }
  })
})
