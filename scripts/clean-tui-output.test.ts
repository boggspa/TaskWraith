import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const cleanup: string[] = []

function temporaryRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-clean-tui-output-'))
  cleanup.push(root)
  return root
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

describe('cleanTuiOutput', () => {
  it('removes only the generated out/tui tree', async () => {
    const root = temporaryRepo()
    const staleTuiFile = join(root, 'out', 'tui', 'main', 'stale.js')
    const preservedOutFile = join(root, 'out', 'main', 'index.js')
    const preservedSourceFile = join(root, 'src', 'main.ts')
    mkdirSync(join(root, 'out', 'tui', 'main'), { recursive: true })
    mkdirSync(join(root, 'out', 'main'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(staleTuiFile, 'stale TUI payload')
    writeFileSync(preservedOutFile, 'preserve app output')
    writeFileSync(preservedSourceFile, 'preserve source')

    const { cleanTuiOutput } = await import('./clean-tui-output.cjs')
    expect(cleanTuiOutput(root)).toBe(join(root, 'out', 'tui'))

    expect(existsSync(join(root, 'out', 'tui'))).toBe(false)
    expect(readFileSync(preservedOutFile, 'utf8')).toBe('preserve app output')
    expect(readFileSync(preservedSourceFile, 'utf8')).toBe('preserve source')
  })

  it('refuses to clear through a symbolic-link parent', async () => {
    const root = temporaryRepo()
    const target = temporaryRepo()
    symlinkSync(target, join(root, 'out'))

    const { cleanTuiOutput } = await import('./clean-tui-output.cjs')
    expect(() => cleanTuiOutput(root)).toThrow(/symbolic-link parent/)
  })

  it('refuses to clear a symbolic-link TUI directory', async () => {
    const root = temporaryRepo()
    const target = temporaryRepo()
    mkdirSync(join(root, 'out'), { recursive: true })
    symlinkSync(target, join(root, 'out', 'tui'))

    const { cleanTuiOutput } = await import('./clean-tui-output.cjs')
    expect(() => cleanTuiOutput(root)).toThrow(/symbolic-link directory/)
  })
})
