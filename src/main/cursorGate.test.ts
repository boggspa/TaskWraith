import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cursorDebugEnabled, cursorWebBridgeEnabled } from './cursorGate'

// These flags are legacy diagnostics only; neither can enable a production
// Cursor run or bridge under the unconditional managed-run gate.
const CURSOR_ENV_KEYS = ['TASKWRAITH_CURSOR_DEBUG', 'TASKWRAITH_CURSOR_WEB'] as const

type CursorEnvKey = (typeof CURSOR_ENV_KEYS)[number]

const originalEnv = new Map<CursorEnvKey, string | undefined>()

function resetCursorEnv(values: Partial<Record<CursorEnvKey, string>> = {}): void {
  for (const key of CURSOR_ENV_KEYS) {
    delete process.env[key]
  }
  for (const key of CURSOR_ENV_KEYS) {
    const value = values[key]
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}

describe('cursorDebugEnabled', () => {
  beforeEach(() => {
    originalEnv.clear()
    for (const key of CURSOR_ENV_KEYS) {
      originalEnv.set(key, process.env[key])
    }
    resetCursorEnv()
  })

  afterEach(() => {
    for (const key of CURSOR_ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('defaults off', () => {
    expect(cursorDebugEnabled()).toBe(false)
  })

  it('turns on for documented opt-in values', () => {
    for (const value of ['1', 'true', 'yes']) {
      resetCursorEnv({ TASKWRAITH_CURSOR_DEBUG: value })
      expect(cursorDebugEnabled()).toBe(true)
    }
  })

  it('stays off for false-ish, malformed, uppercase, or padded values', () => {
    for (const value of ['', '0', 'false', 'no', 'TRUE', 'YES', ' yes ', 'random']) {
      resetCursorEnv({ TASKWRAITH_CURSOR_DEBUG: value })
      expect(cursorDebugEnabled()).toBe(false)
    }
  })
})

describe('cursorWebBridgeEnabled', () => {
  beforeEach(() => {
    originalEnv.clear()
    for (const key of CURSOR_ENV_KEYS) {
      originalEnv.set(key, process.env[key])
    }
    resetCursorEnv()
  })

  afterEach(() => {
    for (const key of CURSOR_ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('defaults off', () => {
    expect(cursorWebBridgeEnabled()).toBe(false)
  })

  it('turns off for documented opt-out values', () => {
    for (const value of ['0', 'false', 'no']) {
      resetCursorEnv({ TASKWRAITH_CURSOR_WEB: value })
      expect(cursorWebBridgeEnabled()).toBe(false)
    }
  })

  it('cannot be enabled by legacy opt-in-looking or malformed values', () => {
    for (const value of ['', '1', 'true', 'yes', 'FALSE', 'NO', ' no ', 'random']) {
      resetCursorEnv({ TASKWRAITH_CURSOR_WEB: value })
      expect(cursorWebBridgeEnabled()).toBe(false)
    }
  })
})
