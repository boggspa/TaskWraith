import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect } from 'vitest'
import {
  parseGitStatusZ,
  classifyStatus,
  generateSyntheticNewFileDiff,
  getWorkspaceDiff,
  captureWorkspaceSnapshot,
  buildBoundedWorkspaceDiff,
  computeRunDiff
} from './DiffService'

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  expect(result.status, result.stderr || result.stdout).toBe(0)
}

function makeGitRepo(): { baseDir: string; repoDir: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-diff-test-'))
  const repoDir = path.join(baseDir, 'repo')
  fs.mkdirSync(repoDir)
  runGit(repoDir, ['init'])
  runGit(repoDir, ['config', 'user.email', 'test@example.invalid'])
  runGit(repoDir, ['config', 'user.name', 'TaskWraith Test'])
  return { baseDir, repoDir }
}

describe('DiffService', () => {
  describe('parseGitStatusZ', () => {
    it('parses modified file', () => {
      const input = ' M README.md\0'
      const result = parseGitStatusZ(input)
      expect(result).toEqual([
        { statusCode: 'M', filePath: 'README.md', staged: false, unstaged: true }
      ])
    })
    it('parses untracked file', () => {
      const input = '?? HelloWorldView.swift\0'
      const result = parseGitStatusZ(input)
      expect(result).toEqual([
        {
          statusCode: '??',
          filePath: 'HelloWorldView.swift',
          staged: false,
          unstaged: true
        }
      ])
    })
    it('parses filenames with spaces using -z output', () => {
      const input = '?? my file.txt\0'
      const result = parseGitStatusZ(input)
      expect(result).toEqual([
        { statusCode: '??', filePath: 'my file.txt', staged: false, unstaged: true }
      ])
    })
    it('parses multiple entries', () => {
      const input = ' M README.md\0?? new.txt\0'
      const result = parseGitStatusZ(input)
      expect(result).toHaveLength(2)
      expect(result[1].filePath).toBe('new.txt')
    })
    it('uses the current path for renamed files', () => {
      const input = 'R  new-name.txt\0old-name.txt\0'
      const result = parseGitStatusZ(input)
      expect(result).toEqual([
        { statusCode: 'R', filePath: 'new-name.txt', staged: true, unstaged: false }
      ])
    })
    it('retains staged and unstaged state for mixed files', () => {
      const input = 'MM src/App.tsx\0'
      const result = parseGitStatusZ(input)
      expect(result).toEqual([
        { statusCode: 'MM', filePath: 'src/App.tsx', staged: true, unstaged: true }
      ])
    })
  })

  describe('classifyStatus', () => {
    it('classifies ?? as untracked', () => {
      expect(classifyStatus('??')).toBe('untracked')
    })
    it('classifies A as created', () => {
      expect(classifyStatus('A')).toBe('created')
    })
    it('classifies D as deleted', () => {
      expect(classifyStatus('D')).toBe('deleted')
    })
    it('classifies R as renamed', () => {
      expect(classifyStatus('R')).toBe('renamed')
    })
    it('classifies M as modified', () => {
      expect(classifyStatus('M')).toBe('modified')
    })
  })

  describe('generateSyntheticNewFileDiff', () => {
    it('generates synthetic diff for new file', () => {
      const text = generateSyntheticNewFileDiff('HelloWorldView.swift', 'line1\nline2')
      expect(text).toContain('diff --git a/HelloWorldView.swift b/HelloWorldView.swift')
      expect(text).toContain('new file mode 100644')
      expect(text).toContain('--- /dev/null')
      expect(text).toContain('+++ b/HelloWorldView.swift')
      expect(text).toContain('+line1')
      expect(text).toContain('+line2')
    })
  })

  describe('getWorkspaceDiff', () => {
    it('ignores hostile inherited Git routing variables in async and sync diff commands', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT'] as const
      const previous = new Map(keys.map((key) => [key, process.env[key]]))
      try {
        fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'before\n')
        runGit(repoDir, ['add', 'tracked.txt'])
        runGit(repoDir, ['commit', '-m', 'initial'])
        fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
        process.env.GIT_DIR = path.join(repoDir, 'hostile-git-dir')
        process.env.GIT_WORK_TREE = path.join(repoDir, 'hostile-work-tree')
        process.env.GIT_CONFIG_COUNT = '1'

        const diff = await getWorkspaceDiff(repoDir)

        expect(diff.type).toBe('changes')
        expect(diff.summaries?.find((file) => file.path === 'tracked.txt')?.diffText).toContain(
          '+after'
        )
      } finally {
        for (const key of keys) {
          const value = previous.get(key)
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('disables repository-local fsmonitor and external diff executables', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        const fsmonitorMarker = path.join(repoDir, 'fsmonitor-executed')
        const diffMarker = path.join(repoDir, 'external-diff-executed')
        const fsmonitor = path.join(repoDir, 'hostile-fsmonitor.sh')
        const externalDiff = path.join(repoDir, 'hostile-diff.sh')
        fs.writeFileSync(fsmonitor, `#!/bin/sh\ntouch ${JSON.stringify(fsmonitorMarker)}\n`)
        fs.writeFileSync(externalDiff, `#!/bin/sh\ntouch ${JSON.stringify(diffMarker)}\n`)
        fs.chmodSync(fsmonitor, 0o755)
        fs.chmodSync(externalDiff, 0o755)
        fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'before\n')
        runGit(repoDir, ['add', 'tracked.txt'])
        runGit(repoDir, ['commit', '-m', 'initial'])
        runGit(repoDir, ['config', 'core.fsmonitor', fsmonitor])
        runGit(repoDir, ['config', 'diff.external', externalDiff])
        fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')

        const diff = await getWorkspaceDiff(repoDir)

        expect(diff.type).toBe('changes')
        expect(diff.summaries?.find((file) => file.path === 'tracked.txt')?.diffText).toContain(
          '+after'
        )
        expect(fs.existsSync(fsmonitorMarker)).toBe(false)
        expect(fs.existsSync(diffMarker)).toBe(false)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('fails diff and snapshot capture closed before repository-local filters execute', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        const marker = path.join(repoDir, 'filter-executed')
        const filter = path.join(repoDir, 'hostile-filter.sh')
        fs.writeFileSync(filter, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`)
        fs.chmodSync(filter, 0o755)
        fs.writeFileSync(path.join(repoDir, '.gitattributes'), 'README.md filter=hostile\n')
        runGit(repoDir, ['config', 'filter.hostile.clean', filter])

        await expect(getWorkspaceDiff(repoDir)).resolves.toEqual({
          type: 'error',
          text: 'Repository-local Git filter commands are not executed by TaskWraith (filter.hostile.clean).'
        })
        await expect(captureWorkspaceSnapshot(repoDir)).rejects.toThrow(
          'Repository-local Git filter commands are not executed by TaskWraith'
        )
        expect(fs.existsSync(marker)).toBe(false)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('includes a preview for staged-only tracked changes', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'before\n')
        runGit(repoDir, ['add', 'tracked.txt'])
        runGit(repoDir, ['commit', '-m', 'initial'])

        fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
        runGit(repoDir, ['add', 'tracked.txt'])

        const diff = await getWorkspaceDiff(repoDir)
        const summary = diff.summaries?.find((file) => file.path === 'tracked.txt')
        expect(summary?.previewKind).toBe('git_diff')
        expect(summary?.diffText).toContain('-before')
        expect(summary?.diffText).toContain('+after')
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('scopes nested workspace diffs to workspace-relative files', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        const appDir = path.join(repoDir, 'app')
        const siblingDir = path.join(repoDir, 'sibling')
        fs.mkdirSync(appDir)
        fs.mkdirSync(siblingDir)
        fs.writeFileSync(path.join(appDir, 'tracked.txt'), 'app before\n')
        fs.writeFileSync(path.join(siblingDir, 'tracked.txt'), 'sibling before\n')
        runGit(repoDir, ['add', '.'])
        runGit(repoDir, ['commit', '-m', 'initial'])

        fs.writeFileSync(path.join(appDir, 'tracked.txt'), 'app after\n')
        fs.writeFileSync(path.join(appDir, 'new.txt'), 'new app file\n')
        fs.writeFileSync(path.join(siblingDir, 'tracked.txt'), 'sibling after\n')

        const diff = await getWorkspaceDiff(appDir)
        const paths = diff.summaries?.map((file) => file.path).sort()
        expect(paths).toEqual(['new.txt', 'tracked.txt'])
        expect(diff.summaries?.some((file) => file.path.includes('sibling'))).toBe(false)
        expect(diff.summaries?.find((file) => file.path === 'tracked.txt')?.diffText).toContain(
          '+app after'
        )
        expect(diff.summaries?.find((file) => file.path === 'new.txt')?.diffText).toContain(
          'diff --git a/new.txt b/new.txt'
        )
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('marks modified binary files as binary previews', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        const binaryPath = path.join(repoDir, 'asset.bin')
        fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3]))
        runGit(repoDir, ['add', 'asset.bin'])
        runGit(repoDir, ['commit', '-m', 'initial'])

        fs.writeFileSync(binaryPath, Buffer.from([0, 4, 5, 6]))

        const diff = await getWorkspaceDiff(repoDir)
        const summary = diff.summaries?.find((file) => file.path === 'asset.bin')
        expect(summary?.isBinary).toBe(true)
        expect(summary?.previewKind).toBe('binary')
        expect(summary?.diffText).toBeUndefined()
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('does not preview untracked symlink targets outside the workspace', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        const outsidePath = path.join(baseDir, 'outside-secret.txt')
        const linkPath = path.join(repoDir, 'linked-secret.txt')
        fs.writeFileSync(outsidePath, 'outside secret\n')
        try {
          fs.symlinkSync(outsidePath, linkPath)
        } catch {
          return
        }

        const diff = await getWorkspaceDiff(repoDir)
        const summary = diff.summaries?.find((file) => file.path === 'linked-secret.txt')
        expect(summary?.previewKind).toBe('none')
        expect(summary?.diffText).toBeUndefined()
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })

    it('caps large tracked diff previews while keeping exact numstat counts', async () => {
      const { baseDir, repoDir } = makeGitRepo()
      try {
        const filePath = path.join(repoDir, 'large.txt')
        fs.writeFileSync(filePath, 'base\n')
        runGit(repoDir, ['add', 'large.txt'])
        runGit(repoDir, ['commit', '-m', 'initial'])

        const addedLines = Array.from(
          { length: 6500 },
          (_, index) => `line ${String(index).padStart(4, '0')}`
        )
        fs.writeFileSync(filePath, ['base', ...addedLines].join('\n'))

        const diff = await getWorkspaceDiff(repoDir)
        const summary = diff.summaries?.find((file) => file.path === 'large.txt')
        expect(diff.diffText).toBeUndefined()
        expect(summary?.previewKind).toBe('git_diff')
        expect(summary?.additions).toBe(6500)
        expect(summary?.deletions).toBe(0)
        expect(summary?.diffTextTruncated).toBe(true)
        expect(summary?.diffTextOmittedLines).toBeGreaterThan(0)
        expect(summary?.diffText).toContain('+line 0000')
        expect(summary?.diffText).not.toContain('+line 6499')
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  describe('buildBoundedWorkspaceDiff', () => {
    it('keeps iOS diff projection bounded for source-capped desktop summaries', () => {
      const diffText = [
        'diff --git a/large.txt b/large.txt',
        '--- a/large.txt',
        '+++ b/large.txt',
        '@@ -1,1 +1,260 @@',
        ...Array.from({ length: 260 }, (_, index) => `+line ${index}`)
      ].join('\n')

      const bounded = buildBoundedWorkspaceDiff([
        {
          path: 'large.txt',
          status: 'modified',
          additions: 260,
          deletions: 0,
          previewKind: 'git_diff',
          diffText,
          diffTextOmittedLines: 400,
          diffTextTruncated: true,
          staged: true,
          unstaged: true
        }
      ])

      expect(bounded.totalFiles).toBe(1)
      expect(bounded.truncated).toBe(true)
      expect(bounded.files[0]).toMatchObject({
        path: 'large.txt',
        status: 'modified',
        previewKind: 'git_diff',
        canOpenInEditor: true,
        staged: true,
        unstaged: true
      })
      expect(bounded.files[0].hunks[0].lines).toHaveLength(200)
      expect(bounded.files[0].truncated).toBe(true)
    })

    it('carries mobile handoff safety metadata for blocked preview types', () => {
      const bounded = buildBoundedWorkspaceDiff([
        {
          path: 'asset.bin',
          status: 'modified',
          additions: 0,
          deletions: 0,
          isBinary: true,
          previewKind: 'binary'
        },
        {
          path: '.env',
          status: 'hidden_sensitive',
          additions: 1,
          deletions: 1,
          isSensitive: true,
          previewKind: 'hidden'
        },
        {
          path: 'docs/readme.md',
          status: 'deleted',
          additions: 0,
          deletions: 4,
          previewKind: 'none'
        }
      ])

      expect(bounded.files).toMatchObject([
        {
          path: 'asset.bin',
          status: 'modified',
          previewKind: 'binary',
          isBinary: true,
          canOpenInEditor: false
        },
        {
          path: '.env',
          status: 'hidden_sensitive',
          previewKind: 'hidden',
          isSensitive: true,
          canOpenInEditor: false
        },
        {
          path: 'docs/readme.md',
          status: 'deleted',
          previewKind: 'none',
          canOpenInEditor: false
        }
      ])
    })
  })

  describe('computeRunDiff', () => {
    it('marks file created during run', () => {
      const pre: any = { isGitRepo: true, gitStatus: '' }
      const post: any = { isGitRepo: true, gitStatus: '?? new.swift\0' }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.createdFiles).toHaveLength(1)
      expect(result.createdFiles[0].path).toBe('new.swift')
      expect(result.preExistingFiles).toHaveLength(0)
    })
    it('marks pre-existing dirty file', () => {
      const pre: any = { isGitRepo: true, gitStatus: ' M old.swift\0' }
      const post: any = { isGitRepo: true, gitStatus: ' M old.swift\0' }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.preExistingFiles).toHaveLength(1)
      expect(result.preExistingFiles[0].path).toBe('old.swift')
      expect(result.modifiedFiles).toHaveLength(0)
    })
    it('marks modified tracked file during run', () => {
      const pre: any = { isGitRepo: true, gitStatus: 'A old.swift\0' }
      const post: any = { isGitRepo: true, gitStatus: ' M old.swift\0' }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.modifiedFiles).toHaveLength(1)
      expect(result.modifiedFiles[0].path).toBe('old.swift')
    })
    it('marks untracked new file during run', () => {
      const pre: any = { isGitRepo: true, gitStatus: '' }
      const post: any = { isGitRepo: true, gitStatus: '?? GEMINI.md\0' }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.createdFiles).toHaveLength(1)
      expect(result.createdFiles[0].path).toBe('GEMINI.md')
    })
    it('marks tracked deleted file during run from post-run git status', () => {
      const pre: any = { isGitRepo: true, gitStatus: '' }
      const post: any = { isGitRepo: true, gitStatus: ' D gone.swift\0' }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.deletedFiles).toHaveLength(1)
      expect(result.deletedFiles[0].path).toBe('gone.swift')
    })
    it('does not mark a pre-existing dirty tracked file as deleted when it becomes clean', () => {
      const pre: any = { isGitRepo: true, gitStatus: ' M FirstLaunchSheet.tsx\0' }
      const post: any = { isGitRepo: true, gitStatus: '' }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.deletedFiles).toHaveLength(0)
      expect(result.modifiedFiles).toHaveLength(1)
      expect(result.modifiedFiles[0].path).toBe('FirstLaunchSheet.tsx')
    })
    it('handles non-git file snapshots', () => {
      const pre: any = { isGitRepo: false, files: [{ path: 'a.txt', sizeBytes: 10, mtimeMs: 1 }] }
      const post: any = {
        isGitRepo: false,
        files: [
          { path: 'a.txt', sizeBytes: 10, mtimeMs: 1 },
          { path: 'b.txt', sizeBytes: 5, mtimeMs: 2 }
        ]
      }
      const result = computeRunDiff(pre, post, 'run1')
      expect(result.createdFiles).toHaveLength(1)
      expect(result.createdFiles[0].path).toBe('b.txt')
    })
  })
})
