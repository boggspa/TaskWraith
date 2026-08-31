import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('emulator Canvas composition wiring', () => {
  it('keeps runtime construction in the extracted factory and index to one branch', () => {
    expect(source).toContain("from './emulator/EmulatorDriverFactory'")
    expect(source).toContain('createEmulatorCanvasDriverFactory({')
    expect(source).toMatch(/if \(kind === 'emulator'\)[\s\S]{0,500}?createEmulatorCanvasDriver\(\{/)
    expect(source).not.toContain('new CanvasEmulatorDriver(')
    expect(source).not.toContain('new ElectronEmulatorRuntimeBridge(')
  })
})
