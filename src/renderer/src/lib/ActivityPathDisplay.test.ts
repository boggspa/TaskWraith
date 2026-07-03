import { describe, it, expect } from 'vitest'
import {
  displayPathRelativeToWorkspace,
  isAbsoluteFilePath,
  resolveWorkspaceAbsolutePath,
  tildifyHomePath
} from './ActivityPathDisplay'

describe('displayPathRelativeToWorkspace', () => {
  describe('workspace-relative truncation', () => {
    it('strips a workspace prefix from a nested file path', () => {
      const workspace = '/Users/alice/Documents/Dungeons of Darkness'
      const filePath =
        '/Users/alice/Documents/Dungeons of Darkness/Sources/DungeonsEngine/SoundSynth.swift'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe(
        'Sources/DungeonsEngine/SoundSynth.swift'
      )
    })

    it('handles a workspace path with a trailing slash', () => {
      const workspace = '/Users/alice/Documents/Dungeons of Darkness/'
      const filePath =
        '/Users/alice/Documents/Dungeons of Darkness/Sources/DungeonsEngine/SoundSynth.swift'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe(
        'Sources/DungeonsEngine/SoundSynth.swift'
      )
    })

    it('handles a workspace path with multiple trailing separators', () => {
      const workspace = '/Users/alice/Documents/repo///'
      const filePath = '/Users/alice/Documents/repo/src/index.ts'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe('src/index.ts')
    })

    it('returns "." when the file path equals the workspace root exactly', () => {
      const workspace = '/Users/alice/Documents/repo'
      expect(displayPathRelativeToWorkspace(workspace, workspace)).toBe('.')
    })

    it('returns "." when the file path equals the workspace root with a trailing slash', () => {
      const workspace = '/Users/alice/Documents/repo/'
      const filePath = '/Users/alice/Documents/repo'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe('.')
    })
  })

  describe('segment-aware prefix matching', () => {
    it('does NOT strip when the workspace prefix only matches a partial segment', () => {
      // `/repo` is a substring prefix of `/repo-backup`, but is not a parent
      // directory — the helper must reject this to avoid mangling the path.
      const workspace = '/Users/alice/Documents/repo'
      const filePath = '/Users/alice/Documents/repo-backup/src/index.ts'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe(
        '~/Documents/repo-backup/src/index.ts'
      )
    })

    it('strips when the workspace prefix matches a full segment boundary', () => {
      const workspace = '/Users/alice/Documents/repo'
      const filePath = '/Users/alice/Documents/repo/src/index.ts'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe('src/index.ts')
    })
  })

  describe('paths outside the workspace', () => {
    it('returns the path unchanged when there is no workspace match and no home match', () => {
      const workspace = '/Users/alice/Documents/repo'
      const filePath = '/var/log/system.log'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe('/var/log/system.log')
    })

    it('falls back to the home-relative form for files outside the workspace', () => {
      const workspace = '/Users/alice/Documents/repo'
      const filePath = '/Users/alice/Downloads/notes.txt'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe('~/Downloads/notes.txt')
    })

    it('applies the home-relative fallback even when no workspace is provided', () => {
      const filePath = '/Users/alice/Documents/repo/src/index.ts'
      expect(displayPathRelativeToWorkspace(filePath, undefined)).toBe(
        '~/Documents/repo/src/index.ts'
      )
    })

    it('returns the original path when no workspace match and no home prefix', () => {
      const filePath = '/etc/hosts'
      expect(displayPathRelativeToWorkspace(filePath, undefined)).toBe('/etc/hosts')
    })
  })

  describe('case sensitivity', () => {
    it('treats path comparison as case-sensitive', () => {
      // macOS APFS volumes are case-insensitive by default, but Linux + Windows
      // are sensitive. Default to the stricter rule for portability.
      const workspace = '/Users/alice/Documents/Repo'
      const filePath = '/Users/alice/Documents/repo/src/index.ts'
      expect(displayPathRelativeToWorkspace(filePath, workspace)).toBe(
        '~/Documents/repo/src/index.ts'
      )
    })
  })

  describe('empty and null inputs', () => {
    it('returns an empty string for undefined filePath', () => {
      expect(displayPathRelativeToWorkspace(undefined, '/Users/alice/repo')).toBe('')
    })

    it('returns an empty string for null filePath', () => {
      expect(displayPathRelativeToWorkspace(null, '/Users/alice/repo')).toBe('')
    })

    it('returns an empty string for an empty filePath', () => {
      expect(displayPathRelativeToWorkspace('', '/Users/alice/repo')).toBe('')
    })

    it('returns an empty string for a whitespace-only filePath', () => {
      expect(displayPathRelativeToWorkspace('   ', '/Users/alice/repo')).toBe('')
    })

    it('passes through the original path when workspacePath is undefined and home does not match', () => {
      expect(displayPathRelativeToWorkspace('/srv/data/file.txt', undefined)).toBe(
        '/srv/data/file.txt'
      )
    })

    it('passes through the original path when workspacePath is an empty string', () => {
      expect(displayPathRelativeToWorkspace('/Users/alice/Documents/repo/src/index.ts', '')).toBe(
        '~/Documents/repo/src/index.ts'
      )
    })

    it('passes through the original path when workspacePath is whitespace only', () => {
      expect(
        displayPathRelativeToWorkspace('/Users/alice/Documents/repo/src/index.ts', '   ')
      ).toBe('~/Documents/repo/src/index.ts')
    })
  })

  describe('non-string inputs (defensive guards)', () => {
    it('tolerates a non-string filePath', () => {
      expect(displayPathRelativeToWorkspace(42 as unknown as string, '/Users/alice/repo')).toBe('')
    })

    it('tolerates a non-string workspacePath and treats the path as outside the workspace', () => {
      expect(
        displayPathRelativeToWorkspace(
          '/Users/alice/Documents/repo/src/index.ts',
          {} as unknown as string
        )
      ).toBe('~/Documents/repo/src/index.ts')
    })
  })

  describe('home-relative formatting', () => {
    it('preserves intermediate path segments when collapsing the home prefix', () => {
      const filePath = '/Users/bob/Library/Application Support/MyApp/state.json'
      expect(displayPathRelativeToWorkspace(filePath, undefined)).toBe(
        '~/Library/Application Support/MyApp/state.json'
      )
    })

    it('does not collapse `/Users` paths without a user segment', () => {
      // `/Users` alone is not a personal home — leave it as-is.
      expect(displayPathRelativeToWorkspace('/Users', undefined)).toBe('/Users')
    })
  })
})

describe('tildifyHomePath', () => {
  it('collapses a macOS home prefix to ~/ (strips the OS username)', () => {
    expect(tildifyHomePath('/Users/bob/Documents/TaskWraith')).toBe('~/Documents/TaskWraith')
  })

  it('keeps the project folder + intermediate segments', () => {
    expect(tildifyHomePath('/Users/alice/code/proj/src')).toBe('~/code/proj/src')
  })

  it('returns a non-home path unchanged (nothing to strip)', () => {
    expect(tildifyHomePath('/Volumes/External/proj')).toBe('/Volumes/External/proj')
  })

  it('does not collapse bare `/Users` (no user segment)', () => {
    expect(tildifyHomePath('/Users')).toBe('/Users')
  })

  it('trims surrounding whitespace before collapsing', () => {
    expect(tildifyHomePath('  /Users/bob/x  ')).toBe('~/x')
  })

  it('returns "" for empty / nullish / non-string inputs', () => {
    expect(tildifyHomePath('')).toBe('')
    expect(tildifyHomePath('   ')).toBe('')
    expect(tildifyHomePath(null)).toBe('')
    expect(tildifyHomePath(undefined)).toBe('')
    expect(tildifyHomePath(42 as unknown as string)).toBe('')
  })
})

describe('isAbsoluteFilePath', () => {
  it('recognises POSIX, Windows-drive and UNC absolute paths', () => {
    expect(isAbsoluteFilePath('/repo/src/foo.ts')).toBe(true)
    expect(isAbsoluteFilePath('C:\\Users\\a\\foo.ts')).toBe(true)
    expect(isAbsoluteFilePath('C:/Users/a/foo.ts')).toBe(true)
    expect(isAbsoluteFilePath('\\\\host\\share\\foo.ts')).toBe(true)
  })

  it('treats relative paths and `~` as NOT absolute', () => {
    expect(isAbsoluteFilePath('src/foo.ts')).toBe(false)
    expect(isAbsoluteFilePath('./foo.ts')).toBe(false)
    expect(isAbsoluteFilePath('../foo.ts')).toBe(false)
    expect(isAbsoluteFilePath('~/foo.ts')).toBe(false)
  })

  it('returns false for empty / nullish / non-string inputs', () => {
    expect(isAbsoluteFilePath('')).toBe(false)
    expect(isAbsoluteFilePath('   ')).toBe(false)
    expect(isAbsoluteFilePath(null)).toBe(false)
    expect(isAbsoluteFilePath(undefined)).toBe(false)
  })
})

describe('resolveWorkspaceAbsolutePath', () => {
  it('returns an already-absolute path trimmed and unchanged', () => {
    expect(
      resolveWorkspaceAbsolutePath('/repo/src/foo.ts', '/repo')
    ).toBe('/repo/src/foo.ts')
    expect(
      resolveWorkspaceAbsolutePath('  /repo/src/foo.ts  ', '/other')
    ).toBe('/repo/src/foo.ts')
    // A leading-slash path is absolute POSIX — NOT joined onto the workspace.
    expect(resolveWorkspaceAbsolutePath('/src/foo.ts', '/repo')).toBe('/src/foo.ts')
  })

  it('joins a relative path onto the workspace root', () => {
    expect(resolveWorkspaceAbsolutePath('src/foo.ts', '/repo')).toBe('/repo/src/foo.ts')
    expect(resolveWorkspaceAbsolutePath('src/foo.ts', '/repo/')).toBe('/repo/src/foo.ts')
  })

  it('normalises `./` and lexically collapses `../` segments after joining', () => {
    expect(resolveWorkspaceAbsolutePath('./src/foo.ts', '/repo')).toBe('/repo/src/foo.ts')
    expect(resolveWorkspaceAbsolutePath('../sibling/foo.ts', '/repo')).toBe('/sibling/foo.ts')
    // Deep traversal collapses to an honest resolved path (no opaque `..` run).
    expect(resolveWorkspaceAbsolutePath('src/../../../etc/hosts', '/repo')).toBe('/etc/hosts')
  })

  it('collapses `.`/`..` in an already-absolute POSIX path', () => {
    expect(resolveWorkspaceAbsolutePath('/repo/src/../lib/x.ts', '/repo')).toBe('/repo/lib/x.ts')
  })

  it('returns a `~`-prefixed path untouched rather than joining it onto the workspace', () => {
    expect(resolveWorkspaceAbsolutePath('~/Desktop/x.ts', '/repo')).toBe('~/Desktop/x.ts')
  })

  it('uses backslash join for a Windows workspace root', () => {
    expect(resolveWorkspaceAbsolutePath('src\\foo.ts', 'C:\\repo')).toBe('C:\\repo\\src\\foo.ts')
  })

  it('returns the relative path unchanged when there is no workspace to anchor it', () => {
    expect(resolveWorkspaceAbsolutePath('src/foo.ts', undefined)).toBe('src/foo.ts')
    expect(resolveWorkspaceAbsolutePath('src/foo.ts', '')).toBe('src/foo.ts')
  })

  it('returns "" for empty / nullish inputs', () => {
    expect(resolveWorkspaceAbsolutePath('', '/repo')).toBe('')
    expect(resolveWorkspaceAbsolutePath(null, '/repo')).toBe('')
    expect(resolveWorkspaceAbsolutePath(undefined, '/repo')).toBe('')
  })
})
