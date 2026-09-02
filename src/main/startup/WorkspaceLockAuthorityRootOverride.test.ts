import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { workspaceLockAuthorityRootForHome } from '../WorkspaceLockRuntime'
import {
  resolveWorkspaceLockAuthorityRoot,
  WORKSPACE_LOCK_AUTHORITY_ROOT_ENV
} from './WorkspaceLockAuthorityRootOverride'

const home = '/Users/example'

describe('resolveWorkspaceLockAuthorityRoot', () => {
  it('uses the shared per-user root when no override is requested', () => {
    for (const override of [undefined, '', '   ']) {
      expect(
        resolveWorkspaceLockAuthorityRoot({ homePath: home, override, isPackaged: false })
      ).toEqual({
        root: workspaceLockAuthorityRootForHome(home),
        overridden: false
      })
    }
  })

  it('honours an absolute isolated root outside a packaged build', () => {
    // The resolver requires the override to already be normalized: on win32 a
    // POSIX `/tmp/...` literal normalizes to a drive-less path that resolve()
    // then rebases onto the cwd drive. A tmpdir()-derived absolute path is
    // already normalized on every OS, so resolve(normalize(x)) === x holds.
    const isolatedRoot = path.resolve(os.tmpdir(), 'tw-perf', 'authority-a')
    expect(
      resolveWorkspaceLockAuthorityRoot({
        homePath: home,
        override: isolatedRoot,
        isPackaged: false
      })
    ).toEqual({ root: isolatedRoot, overridden: true })
  })

  it('refuses the override in a packaged build', () => {
    expect(() =>
      resolveWorkspaceLockAuthorityRoot({
        homePath: home,
        override: '/tmp/tw-perf/authority-a',
        isPackaged: true
      })
    ).toThrow(/test-only override and is refused in a packaged build/)
  })

  it('refuses a relative path rather than resolving it against the cwd', () => {
    expect(() =>
      resolveWorkspaceLockAuthorityRoot({
        homePath: home,
        override: 'relative/root',
        isPackaged: false
      })
    ).toThrow(/must be an absolute path/)
  })

  it('refuses a NUL byte', () => {
    expect(() =>
      resolveWorkspaceLockAuthorityRoot({
        homePath: home,
        override: '/tmp/a\0b',
        isPackaged: false
      })
    ).toThrow(/NUL byte/)
  })

  it('refuses an override that resolves back to the shared root', () => {
    // The whole point of the override is provable isolation; a value that
    // silently lands on the shared root is how a contended run gets reported
    // as an isolated one.
    expect(() =>
      resolveWorkspaceLockAuthorityRoot({
        homePath: home,
        override: workspaceLockAuthorityRootForHome(home),
        isPackaged: false
      })
    ).toThrow(/would not isolate anything/)
    expect(() =>
      resolveWorkspaceLockAuthorityRoot({
        homePath: home,
        override: `${workspaceLockAuthorityRootForHome(home)}/../workspace-lock-authority-v1`,
        isPackaged: false
      })
    ).toThrow(/already be normalized|would not isolate anything/)
  })

  it('refuses a filesystem root or a single top-level directory', () => {
    // Platform roots so the normalization gate passes on win32 too: the drive
    // root ('C:\\') is both the filesystem root and the single top-level
    // directory, so the second POSIX case only exists where '/' + '/tmp' do.
    const fsRoot = path.parse(process.cwd()).root
    const cases = [fsRoot]
    if (process.platform !== 'win32') cases.push(path.join(fsRoot, 'tmp'))
    for (const override of cases) {
      expect(() =>
        resolveWorkspaceLockAuthorityRoot({ homePath: home, override, isPackaged: false })
      ).toThrow(/dedicated directory/)
    }
  })

  it('names the env var in every refusal so the operator can find it', () => {
    try {
      resolveWorkspaceLockAuthorityRoot({ homePath: home, override: 'nope', isPackaged: false })
      throw new Error('expected a refusal')
    } catch (error) {
      expect((error as Error).message).toContain(WORKSPACE_LOCK_AUTHORITY_ROOT_ENV)
    }
  })
})
