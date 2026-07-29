import { afterEach, describe, expect, it } from 'vitest'
import { getCliSearchDirs, getUserCliSearchDirs, setUserCliSearchDirs } from './CliSearchDirs'

afterEach(() => {
  setUserCliSearchDirs([])
})

describe('setUserCliSearchDirs', () => {
  it('normalizes, ~-expands, and reports whether the effective list changed', () => {
    expect(setUserCliSearchDirs(['~/.local/bin', ' /opt/tools/bin '], '/Users/dev')).toBe(true)
    expect(getUserCliSearchDirs()).toEqual(['/Users/dev/.local/bin', '/opt/tools/bin'])

    // Re-publishing an equivalent list must NOT report a change — the caller
    // invalidates resolution caches on true, and needlessly dropping them would
    // re-probe every tool on every unrelated settings write.
    expect(setUserCliSearchDirs([' ~/.local/bin ', '/opt/tools/bin/'], '/Users/dev')).toBe(false)
    expect(setUserCliSearchDirs(['/opt/tools/bin', '~/.local/bin'], '/Users/dev')).toBe(true)
  })

  it('drops invalid entries and tolerates null', () => {
    setUserCliSearchDirs(['relative/bin', '', '/opt/good/bin'], '/Users/dev')
    expect(getUserCliSearchDirs()).toEqual(['/opt/good/bin'])
    expect(setUserCliSearchDirs(null, '/Users/dev')).toBe(true)
    expect(getUserCliSearchDirs()).toEqual([])
  })
})

describe('getCliSearchDirs', () => {
  it('searches user directories before the inherited PATH and the built-in roots', () => {
    setUserCliSearchDirs(['/opt/tools/bin'], '/Users/dev')
    const dirs = getCliSearchDirs(null, { PATH: '/usr/bin' })
    expect(dirs[0]).toBe('/opt/tools/bin')
    expect(dirs.indexOf('/opt/tools/bin')).toBeLessThan(dirs.indexOf('/usr/bin'))
    expect(dirs.indexOf('/opt/tools/bin')).toBeLessThan(dirs.indexOf('/usr/local/bin'))
  })

  it('still puts an explicitly resolved binary directory first', () => {
    setUserCliSearchDirs(['/opt/tools/bin'], '/Users/dev')
    const dirs = getCliSearchDirs('/custom/place/codex', { PATH: '/usr/bin' })
    expect(dirs[0]).toBe('/custom/place')
    expect(dirs[1]).toBe('/opt/tools/bin')
  })

  it('de-duplicates a user directory that is already on PATH without losing priority', () => {
    setUserCliSearchDirs(['/usr/bin'], '/Users/dev')
    const dirs = getCliSearchDirs(null, { PATH: '/usr/bin:/sbin' })
    expect(dirs.filter((dir) => dir === '/usr/bin')).toHaveLength(1)
    expect(dirs[0]).toBe('/usr/bin')
  })

  it('is unchanged from the built-in behaviour when no user directories are set', () => {
    const dirs = getCliSearchDirs(null, { PATH: '/usr/bin' })
    expect(dirs[0]).toBe('/usr/bin')
    expect(dirs).toContain('/opt/homebrew/bin')
  })

  it('reaches Homebrew under the minimal launchd PATH a Finder-launched app inherits', () => {
    // The reported `gh` failure in full: a Finder-launched macOS app gets
    // /usr/bin:/bin:/usr/sbin:/sbin and nothing else, so a bare spawn of a
    // Homebrew-installed binary reports "not installed or not on PATH" on a
    // machine where it is plainly installed. Anything resolving through this
    // helper — providers, host tools, and now git/gh — must not have that gap.
    const dirs = getCliSearchDirs(null, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/local/bin')
  })

  it('lets a user directory rescue a CLI that lives outside every known root', () => {
    // Version-manager shims (asdf/mise/volta) and custom npm prefixes are the
    // installs the built-in roots cannot cover — the case the setting exists for.
    setUserCliSearchDirs(['~/.asdf/shims'], '/Users/dev')
    const dirs = getCliSearchDirs(null, { PATH: '/usr/bin:/bin' })
    expect(dirs).toContain('/Users/dev/.asdf/shims')
    expect(dirs.indexOf('/Users/dev/.asdf/shims')).toBeLessThan(dirs.indexOf('/usr/bin'))
  })
})
