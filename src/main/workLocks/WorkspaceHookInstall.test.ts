import { execFileSync, spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  TASKWRAITH_HOOK_RECEIPT_FILENAME,
  TASKWRAITH_HOOK_SIGNATURE,
  installWorkspaceHook,
  planWorkspaceHookInstall,
  uninstallWorkspaceHook
} from './WorkspaceHookInstall'

const created: string[] = []
const peerPids: number[] = []
// @portability-ok: written and read back as text — never executed; the enforcement describe below runs the real .githooks/pre-commit instead
const HOOK_SOURCE = '#!/usr/bin/env bash\necho "coordination check"\nexit 0\n'

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `taskwraith-hook-install-${label}-`))
  created.push(root)
  return root
}

function plainRepo(label: string): string {
  const root = scratch(label)
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  return root
}

/** No hooksPath configured anywhere. */
const noHooksPath = (): string | null => null

afterEach(() => {
  while (created.length > 0) {
    const root = created.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
  while (peerPids.length > 0) {
    const pid = peerPids.pop()
    if (!pid) continue
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
})

describe('planWorkspaceHookInstall', () => {
  it('reports a clean repo as installable', () => {
    const root = plainRepo('clean')
    expect(planWorkspaceHookInstall({ worktreeRoot: root, readHooksPath: noHooksPath })).toEqual({
      status: 'installable',
      hookPath: join(root, '.git', 'hooks', 'pre-commit')
    })
  })

  it('refuses when core.hooksPath is redirected, because git would ignore our hook', () => {
    // husky/lefthook set core.hooksPath. Writing .git/hooks/pre-commit there is
    // not destructive, it is USELESS: git reads the redirected directory only.
    const root = plainRepo('redirected')
    const plan = planWorkspaceHookInstall({
      worktreeRoot: root,
      readHooksPath: () => '.husky'
    })
    expect(plan).toEqual({
      status: 'blocked',
      reason: 'hooks-path-redirected',
      detail: '.husky'
    })
  })

  it('refuses to touch a pre-commit hook somebody else wrote', () => {
    const root = plainRepo('foreign')
    // @portability-ok: foreign hook content inspected only — never executed
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8')
    expect(planWorkspaceHookInstall({ worktreeRoot: root, readHooksPath: noHooksPath })).toEqual({
      status: 'blocked',
      reason: 'foreign-hook-present'
    })
  })

  it('refuses a directory that is not a git worktree', () => {
    expect(
      planWorkspaceHookInstall({ worktreeRoot: scratch('nonrepo'), readHooksPath: noHooksPath })
    ).toEqual({ status: 'blocked', reason: 'not-a-git-worktree' })
  })
})

describe('installWorkspaceHook', () => {
  it('writes an executable, signed hook plus a restore receipt', () => {
    const root = plainRepo('install')
    const result = installWorkspaceHook({
      worktreeRoot: root,
      hookSource: HOOK_SOURCE,
      readHooksPath: noHooksPath
    })

    expect(result.status).toBe('installed')
    const hookPath = join(root, '.git', 'hooks', 'pre-commit')
    const body = readFileSync(hookPath, 'utf8')
    expect(body).toContain(TASKWRAITH_HOOK_SIGNATURE)
    expect(body).toContain('coordination check')
    if (process.platform !== 'win32') {
      expect(lstatSync(hookPath).mode & 0o111).not.toBe(0)
    }

    const receipt = JSON.parse(
      readFileSync(join(root, '.git', TASKWRAITH_HOOK_RECEIPT_FILENAME), 'utf8')
    )
    expect(receipt.hookPath).toBe(hookPath)
    expect(receipt.previousExists).toBe(false)
  })

  it('is recognised as already-installed on the next plan, and never doubles up', () => {
    const root = plainRepo('reinstall')
    installWorkspaceHook({
      worktreeRoot: root,
      hookSource: HOOK_SOURCE,
      readHooksPath: noHooksPath
    })

    const plan = planWorkspaceHookInstall({ worktreeRoot: root, readHooksPath: noHooksPath })
    expect(plan.status).toBe('already-installed')
  })

  it('refuses at write time too, not only at plan time', () => {
    const root = plainRepo('defence')
    // @portability-ok: foreign hook content inspected only — never executed
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', 'utf8')
    const result = installWorkspaceHook({
      worktreeRoot: root,
      hookSource: HOOK_SOURCE,
      readHooksPath: noHooksPath
    })
    expect(result.status).toBe('blocked')
    // The foreign hook is left byte-identical.
    // @portability-ok: byte-for-byte comparison of hook text — never executed
    expect(readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(
      '#!/bin/sh\nexit 0\n'
    )
  })

  it('installs into the SHARED common dir for a linked worktree', () => {
    const root = scratch('linked')
    const mainGit = join(root, 'main', '.git')
    const linkedGitDir = join(mainGit, 'worktrees', 'w1')
    mkdirSync(linkedGitDir, { recursive: true })
    writeFileSync(join(linkedGitDir, 'commondir'), '../..\n', 'utf8')
    const linkedRoot = join(root, 'linked')
    mkdirSync(linkedRoot, { recursive: true })
    writeFileSync(join(linkedRoot, '.git'), `gitdir: ${linkedGitDir}\n`, 'utf8')

    const result = installWorkspaceHook({
      worktreeRoot: linkedRoot,
      hookSource: HOOK_SOURCE,
      readHooksPath: noHooksPath
    })
    expect(result.status).toBe('installed')
    expect(readFileSync(join(mainGit, 'hooks', 'pre-commit'), 'utf8')).toContain(
      TASKWRAITH_HOOK_SIGNATURE
    )
  })
})

describe('uninstallWorkspaceHook', () => {
  it('removes the hook and its receipt', () => {
    const root = plainRepo('uninstall')
    installWorkspaceHook({
      worktreeRoot: root,
      hookSource: HOOK_SOURCE,
      readHooksPath: noHooksPath
    })

    expect(uninstallWorkspaceHook({ worktreeRoot: root }).status).toBe('removed')
    expect(() => readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf8')).toThrow()
    expect(() =>
      readFileSync(join(root, '.git', TASKWRAITH_HOOK_RECEIPT_FILENAME), 'utf8')
    ).toThrow()
  })

  it('leaves a hook the user has since edited, rather than deleting their work', () => {
    const root = plainRepo('edited')
    installWorkspaceHook({
      worktreeRoot: root,
      hookSource: HOOK_SOURCE,
      readHooksPath: noHooksPath
    })
    const hookPath = join(root, '.git', 'hooks', 'pre-commit')
    // @portability-ok: user-edited hook text compared only — never executed
    writeFileSync(hookPath, '#!/bin/sh\n# my own edits now\nexit 0\n', 'utf8')

    expect(uninstallWorkspaceHook({ worktreeRoot: root }).status).toBe('modified-since-install')
    expect(readFileSync(hookPath, 'utf8')).toContain('my own edits now')
  })

  it('is a no-op when nothing was ever installed', () => {
    expect(uninstallWorkspaceHook({ worktreeRoot: plainRepo('never') }).status).toBe(
      'not-installed'
    )
  })
})

/**
 * The unit tests above prove we write A hook. This proves we write THE hook —
 * that the repository's real `.githooks/pre-commit`, installed by this
 * installer into a foreign checkout, still refuses a commit that stages a path
 * another live session has claimed. That is the entire point of shipping it,
 * and it is the one thing no amount of file-writing assertions can establish.
 */
describe('the installed hook actually enforces a peer claim', () => {
  function git(cwd: string, args: string[]): { code: number; output: string } {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return { code: 0, output }
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string }
      return { code: failure.status ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
    }
  }

  it('blocks staging a path a live peer marker claims, and allows an unclaimed one', (ctx) => {
    if (process.platform === 'win32') {
      // The hook probes claim liveness with `kill -0` under git's MSYS sh,
      // which cannot see a Windows-native pid — the detached peer below reads
      // as dead and the block would pass vacuously. Enforcement semantics are
      // POSIX; install/uninstall coverage stays live on every leg.
      return ctx.skip()
    }
    const hookSource = readFileSync(
      join(__dirname, '..', '..', '..', '.githooks', 'pre-commit'),
      'utf8'
    )

    const root = scratch('enforces')
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.invalid'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['config', 'commit.gpgsign', 'false'])

    expect(installWorkspaceHook({ worktreeRoot: root, hookSource }).status).toBe('installed')

    // A peer's live claim needs a pid that is alive, OURS, and not an ancestor
    // of git. pid 1 looks perfect and is a trap: `kill -0 1` fails with EPERM
    // for a non-root user, so the hook correctly reads it as dead and the whole
    // test passes vacuously. A detached child of this process is the real shape.
    const peer = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    peer.unref()
    peerPids.push(peer.pid ?? 0)
    const started = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const expires = new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    writeFileSync(
      join(root, '.WORK-IN-PROGRESS-peer.md'),
      [
        '---',
        'session: peer-session',
        'agent: peer',
        'task: holding claimed.ts',
        `pid: ${peer.pid}`,
        `started: ${started}`,
        `expires: ${expires}`,
        'paths:',
        '  - claimed.ts',
        '---',
        'peer holds claimed.ts',
        ''
      ].join('\n'),
      'utf8'
    )

    writeFileSync(join(root, 'claimed.ts'), 'export const claimed = 1\n', 'utf8')
    writeFileSync(join(root, 'free.ts'), 'export const free = 1\n', 'utf8')

    git(root, ['add', '--', 'claimed.ts'])
    const blocked = git(root, ['commit', '-m', 'take a peer path', '--', 'claimed.ts'])
    expect(blocked.code).not.toBe(0)
    expect(blocked.output).toContain('claimed.ts')

    // The same hook must stay out of the way of unclaimed work, or it gets
    // disabled within a day and protects nothing.
    git(root, ['add', '--', 'free.ts'])
    const allowed = git(root, ['commit', '-m', 'unclaimed path', '--', 'free.ts'])
    expect(allowed.code).toBe(0)
  })
})
