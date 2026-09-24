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
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-clean-host-output-'))
  cleanup.push(root)
  return root
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop() as string, { recursive: true, force: true })
})

describe('cleanHostOutput', () => {
  it('removes only generated out/host output', async () => {
    const root = temporaryRepo()
    const staleHostFile = join(root, 'out', 'host', 'main', 'stale.js')
    const preservedAppOutput = join(root, 'out', 'main', 'index.js')
    mkdirSync(join(root, 'out', 'host', 'main'), { recursive: true })
    mkdirSync(join(root, 'out', 'main'), { recursive: true })
    writeFileSync(staleHostFile, 'stale host payload')
    writeFileSync(preservedAppOutput, 'preserve app output')

    const { cleanHostOutput } = await import('./clean-host-output.cjs')
    expect(cleanHostOutput(root)).toBe(join(root, 'out', 'host'))

    expect(existsSync(join(root, 'out', 'host'))).toBe(false)
    expect(readFileSync(preservedAppOutput, 'utf8')).toBe('preserve app output')
  })

  it('refuses symlinked output parents and directories', async () => {
    const parentRoot = temporaryRepo()
    const target = temporaryRepo()
    symlinkSync(target, join(parentRoot, 'out'))

    const { cleanHostOutput } = await import('./clean-host-output.cjs')
    expect(() => cleanHostOutput(parentRoot)).toThrow(/symbolic-link parent/)

    const directoryRoot = temporaryRepo()
    mkdirSync(join(directoryRoot, 'out'), { recursive: true })
    symlinkSync(target, join(directoryRoot, 'out', 'host'))
    expect(() => cleanHostOutput(directoryRoot)).toThrow(/symbolic-link directory/)
  })
})
