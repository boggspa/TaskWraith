import { describe, expect, it } from 'vitest'
import {
  MAX_CLI_PATH_DIRECTORIES,
  cliPathDirectoryRejection,
  expandCliPathDirectory,
  isValidCliPathDirectory,
  normalizeCliPathDirectories,
  splitPastedCliPath
} from './cliPathDirectories'

describe('cliPathDirectoryRejection', () => {
  it('accepts absolute POSIX, home-relative, and Windows directories', () => {
    expect(cliPathDirectoryRejection('/opt/homebrew/bin')).toBeNull()
    expect(cliPathDirectoryRejection('~/.local/bin')).toBeNull()
    expect(cliPathDirectoryRejection('~')).toBeNull()
    expect(cliPathDirectoryRejection('C:\\tools\\bin')).toBeNull()
    expect(cliPathDirectoryRejection('\\\\server\\share\\bin')).toBeNull()
  })

  it('rejects relative entries — they would resolve against an unpredictable cwd', () => {
    expect(cliPathDirectoryRejection('bin')).toMatch(/absolute/i)
    expect(cliPathDirectoryRejection('./bin')).toMatch(/absolute/i)
    expect(cliPathDirectoryRejection('../bin')).toMatch(/absolute/i)
  })

  it('rejects empty, non-string, and control-character entries', () => {
    expect(cliPathDirectoryRejection('')).toMatch(/empty/i)
    expect(cliPathDirectoryRejection('   ')).toMatch(/empty/i)
    expect(cliPathDirectoryRejection(42)).toMatch(/not a path/i)
    expect(cliPathDirectoryRejection('/opt/bin\nrm -rf /')).toMatch(/control characters/i)
    expect(cliPathDirectoryRejection('/opt/bin\0')).toMatch(/control characters/i)
  })

  it('rejects a whole PATH pasted into one row, but not a Windows drive path', () => {
    expect(cliPathDirectoryRejection('/opt/homebrew/bin:/usr/local/bin')).toMatch(/one directory/i)
    expect(cliPathDirectoryRejection('C:\\tools;C:\\other')).toMatch(/one directory/i)
    expect(isValidCliPathDirectory('C:/tools/bin')).toBe(true)
  })
})

describe('normalizeCliPathDirectories', () => {
  it('drops invalid entries and preserves user ordering', () => {
    expect(
      normalizeCliPathDirectories([' /opt/homebrew/bin ', 'relative', '', '~/.local/bin'])
    ).toEqual(['/opt/homebrew/bin', '~/.local/bin'])
  })

  it('de-duplicates across trailing separators, first occurrence wins', () => {
    expect(
      normalizeCliPathDirectories(['/opt/homebrew/bin/', '/usr/local/bin', '/opt/homebrew/bin'])
    ).toEqual(['/opt/homebrew/bin', '/usr/local/bin'])
  })

  it('never strips the separator that IS the path', () => {
    expect(normalizeCliPathDirectories(['/'])).toEqual(['/'])
    expect(normalizeCliPathDirectories(['C:\\'])).toEqual(['C:\\'])
  })

  it('caps the list and tolerates non-array input', () => {
    const many = Array.from({ length: MAX_CLI_PATH_DIRECTORIES + 8 }, (_, i) => `/opt/bin${i}`)
    expect(normalizeCliPathDirectories(many)).toHaveLength(MAX_CLI_PATH_DIRECTORIES)
    expect(normalizeCliPathDirectories(undefined)).toEqual([])
    expect(normalizeCliPathDirectories('/opt/bin')).toEqual([])
  })
})

describe('expandCliPathDirectory', () => {
  it('expands a leading ~ against the supplied home', () => {
    expect(expandCliPathDirectory('~/.local/bin', '/Users/dev')).toBe('/Users/dev/.local/bin')
    expect(expandCliPathDirectory('~', '/Users/dev')).toBe('/Users/dev')
    expect(expandCliPathDirectory('~/.local/bin', '/Users/dev/')).toBe('/Users/dev/.local/bin')
  })

  it('leaves absolute entries alone and no-ops without a home directory', () => {
    expect(expandCliPathDirectory('/opt/homebrew/bin', '/Users/dev')).toBe('/opt/homebrew/bin')
    expect(expandCliPathDirectory('~/.local/bin', '')).toBe('~/.local/bin')
  })
})

describe('splitPastedCliPath', () => {
  it('splits a pasted POSIX PATH', () => {
    expect(splitPastedCliPath('/opt/homebrew/bin:/usr/local/bin:/usr/bin')).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin'
    ])
  })

  it('splits a pasted Windows PATH without mangling drive letters', () => {
    expect(splitPastedCliPath('C:\\tools\\bin;C:\\Program Files\\nodejs')).toEqual([
      'C:\\tools\\bin',
      'C:\\Program Files\\nodejs'
    ])
  })

  it('splits newline-separated rows', () => {
    expect(splitPastedCliPath('/opt/bin\n\n~/.local/bin\n')).toEqual(['/opt/bin', '~/.local/bin'])
  })
})
