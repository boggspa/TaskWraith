import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { removeOwnTempDir } = require('./ownTempDir.cjs') as {
  removeOwnTempDir: (
    dir: string,
    prefix: string,
    options?: { rm?: (dir: string, options: object) => void }
  ) => void
}

/** Every directory this file makes is named so, directly in the temporary folder. */
const PREFIX = 'harness-own-temp-'
const made: string[] = []

function makeDirectory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), PREFIX))
  made.push(dir)
  return dir
}

/** This file's own cleanup, checked here rather than trusted to the helper under test. */
afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop()!
    if (dir === tmpdir() || !dir.startsWith(tmpdir() + path.sep + PREFIX)) {
      throw new Error(`refusing to remove ${dir}: not a directory this file made`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A removal that only records what it was asked to remove. */
function recorder() {
  const asked: string[] = []
  return { asked, rm: (dir: string) => void asked.push(dir) }
}

describe('removing a temporary directory this process made', () => {
  it('removes a directory mkdtemp made directly in the temporary folder, with all it holds', () => {
    const dir = makeDirectory()
    mkdirSync(path.join(dir, 'profile', 'deep'), { recursive: true })
    writeFileSync(path.join(dir, 'profile', 'deep', 'file'), 'x')
    removeOwnTempDir(dir, PREFIX)
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses the temporary folder itself, its parent, and anything outside it', () => {
    const root = tmpdir()
    const { asked, rm } = recorder()
    for (const dir of [root, path.dirname(root), '/', path.join(root, '..'), process.cwd()]) {
      expect(() => removeOwnTempDir(dir, PREFIX, { rm })).toThrow(/refusing to remove/)
    }
    expect(asked).toEqual([])
  })

  it('refuses a directory without the prefix, one nested deeper, or a path that is not plain', () => {
    const dir = makeDirectory()
    const { asked, rm } = recorder()
    for (const refused of [
      path.join(dir, `${PREFIX}inner`),
      path.join(tmpdir(), 'someone-else-abc123'),
      `${dir}/../${path.basename(dir)}`,
      `${dir}/`,
      path.join(tmpdir(), PREFIX),
      'relative-dir'
    ]) {
      expect(() => removeOwnTempDir(refused, PREFIX, { rm })).toThrow(/refusing to remove/)
    }
    expect(asked).toEqual([])
    // The same directory, asked for plainly, is removed.
    removeOwnTempDir(dir, PREFIX, { rm })
    expect(asked).toEqual([dir])
  })

  it('refuses a prefix that is empty, names a path, or is no string', () => {
    const dir = makeDirectory()
    const { asked, rm } = recorder()
    for (const prefix of ['', '..', 'a/b', `${PREFIX}/`, undefined, 7] as unknown as string[]) {
      expect(() => removeOwnTempDir(dir, prefix, { rm })).toThrow(/prefix/)
    }
    expect(asked).toEqual([])
  })
})

describe('the layout probes', () => {
  // Each probe runs inside Electron when it is loaded, so its source is read.
  it.each([
    ['transcriptWindowLayoutProbe.cjs', 'taskwraith-transcript-window-'],
    ['composerGhostLayoutProbe.cjs', 'taskwraith-composer-ghost-']
  ])(
    '%s removes only the fixture folder it made, by the prefix it made it with',
    (file, prefix) => {
      const source = readFileSync(path.join(__dirname, file), 'utf8')
      expect(source).toContain(`mkdtempSync(path.join(tmpdir(), '${prefix}'))`)
      expect(source).toContain(`removeOwnTempDir(fixtureDir, '${prefix}')`)
      expect(source).not.toMatch(/\brmSync\(/)
    }
  )
})
