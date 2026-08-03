import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TASKWRAITH_TOOL_ACTIONS } from '../shared/providerActionTaxonomy'
import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from '../shared/taskWraithMcpCatalog'
import { deriveWorkspaceMutationClaims } from './WorkspaceMutationClaims'

const temporaryRoots: string[] = []

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-claim-derivation-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('deriveWorkspaceMutationClaims', () => {
  it('returns no workspace claim for reads, external mutations, or explicit dry-runs', async () => {
    const workspacePath = await temporaryWorkspace()

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'read_file',
        args: { path: 'notes.txt' }
      })
    ).resolves.toEqual([])
    await expect(
      deriveWorkspaceMutationClaims({ workspacePath, action: 'git_push' })
    ).resolves.toEqual([])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'run_shell_command',
        args: { command: 'npm test' },
        executionMode: 'dry-run'
      })
    ).resolves.toEqual([])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: 'not parsed during a declared check', check: true }
      })
    ).resolves.toEqual([])
  })

  it('fails explicitly for unmapped and unmediated native actions', async () => {
    const workspacePath = await temporaryWorkspace()

    await expect(
      deriveWorkspaceMutationClaims({ workspacePath, action: 'future_write_tool' })
    ).rejects.toMatchObject({
      code: 'unmapped-action'
    })
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        source: 'provider-native',
        provider: 'pi',
        action: 'write',
        args: { path: 'x.txt' }
      })
    ).rejects.toMatchObject({
      code: 'unmapped-action'
    })
  })

  it('derives a whole-file claim for writes and rejects lexical worktree escapes', async () => {
    const workspacePath = await temporaryWorkspace()

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        worktreeName: 'master',
        branch: 'master',
        action: 'write_file',
        args: { path: 'src/new.ts', content: 'new' }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        workspacePath,
        worktreePath: workspacePath,
        worktreeName: 'master',
        branch: 'master',
        kind: 'file',
        mode: 'write',
        targetPath: join(workspacePath, 'src')
      }),
      expect.objectContaining({
        workspacePath,
        worktreePath: workspacePath,
        worktreeName: 'master',
        branch: 'master',
        kind: 'file',
        mode: 'write',
        targetPath: join(workspacePath, 'src/new.ts')
      })
    ])

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'write_file',
        args: { path: '../outside.txt', content: 'no' }
      })
    ).rejects.toMatchObject({
      code: 'path-escape'
    })

    await mkdir(join(workspacePath, 'existing'))
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'write_file',
        args: { path: 'existing/new.ts', content: 'new' }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, 'existing/new.ts')
      })
    ])
  })

  it('requires the nearest existing parent to resolve to a directory', async () => {
    const workspacePath = await temporaryWorkspace()
    await writeFile(join(workspacePath, 'regular-parent'), 'not a directory')

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'write_file',
        args: { path: 'regular-parent/new.ts', content: 'new' }
      })
    ).rejects.toMatchObject({
      code: 'invalid-call',
      message: 'Planned parent path must resolve to a directory before mutation.'
    })
  })

  it('accepts an in-workspace symlink whose target is an existing directory', async () => {
    const workspacePath = await temporaryWorkspace()
    const physicalDirectory = join(workspacePath, 'physical')
    await mkdir(physicalDirectory)
    await symlink(
      physicalDirectory,
      join(workspacePath, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'write_file',
        args: { path: 'alias/new.ts', content: 'new' }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, 'alias/new.ts')
      })
    ])
  })

  it('rejects a dangling symlink instead of treating it as a missing parent', async () => {
    const workspacePath = await temporaryWorkspace()
    await symlink(
      join(workspacePath, 'missing-target'),
      join(workspacePath, 'dangling'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'write_file',
        args: { path: 'dangling/new.ts', content: 'new' }
      })
    ).rejects.toMatchObject({
      code: 'invalid-call',
      message: 'Planned parent path must resolve to a directory before mutation.'
    })
  })

  it('preserves trailing spaces in valid target filenames', async () => {
    const workspacePath = await temporaryWorkspace()
    const targetName = 'trailing-space.txt '
    const content = 'old\n'
    await writeFile(join(workspacePath, targetName), content)

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'write_file',
        args: { path: targetName, content: 'exact path' }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, targetName)
      })
    ])

    const patch = [
      `diff --git a/${targetName} b/${targetName}`,
      `--- a/${targetName}`,
      `+++ b/${targetName}`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({ workspacePath, action: 'apply_patch', args: { patch } })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, targetName)
      })
    ])
  })

  it('derives same-baseline half-open hunks for an unambiguous literal replacement', async () => {
    const workspacePath = await temporaryWorkspace()
    const content = 'first line\nreplace me\nlast line\n'
    await writeFile(join(workspacePath, 'notes.txt'), content)

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'replace',
        args: { path: 'notes.txt', old_string: 'replace me', new_string: 'done' }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'hunk',
        targetPath: join(workspacePath, 'notes.txt'),
        hunk: {
          baseline: digest(content),
          startLine: 1,
          endLine: 2
        }
      })
    ])
  })

  it('falls back to a file claim for ambiguous, missing, new, or binary replacements', async () => {
    const workspacePath = await temporaryWorkspace()
    await writeFile(join(workspacePath, 'ambiguous.txt'), 'same\nsame\n')
    await writeFile(join(workspacePath, 'binary.dat'), Buffer.from([0, 1, 2, 3]))

    for (const [path, oldString] of [
      ['ambiguous.txt', 'same'],
      ['ambiguous.txt', 'missing'],
      ['new.txt', 'anything'],
      ['binary.dat', '\u0001']
    ]) {
      await expect(
        deriveWorkspaceMutationClaims({
          workspacePath,
          action: 'replace',
          args: { path, old_string: oldString, new_string: 'next' }
        })
      ).resolves.toEqual([
        expect.objectContaining({
          kind: 'file',
          targetPath: join(workspacePath, path)
        })
      ])
    }
  })

  it('derives every replace-all occurrence against one baseline and deduplicates a line', async () => {
    const workspacePath = await temporaryWorkspace()
    const content = 'needle and needle\nmiddle\nneedle\n'
    await writeFile(join(workspacePath, 'many.txt'), content)

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'replace',
        args: {
          path: 'many.txt',
          old_string: 'needle',
          new_string: 'pin',
          replace_all: true
        }
      })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'hunk',
        hunk: { baseline: digest(content), startLine: 0, endLine: 1 }
      }),
      expect.objectContaining({
        kind: 'hunk',
        hunk: { baseline: digest(content), startLine: 2, endLine: 3 }
      })
    ])
  })

  it('claims the whole file when a valid unified patch could apply with offset or fuzz', async () => {
    const workspacePath = await temporaryWorkspace()
    const content = 'one\ntwo\nthree\nfour\n'
    await writeFile(join(workspacePath, 'notes.txt'), content)
    const patch = [
      'diff --git a/notes.txt b/notes.txt',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+TWO',
      '@@ -4 +4 @@',
      '-four',
      '+FOUR',
      ''
    ].join('\n')

    await expect(
      deriveWorkspaceMutationClaims({ workspacePath, action: 'apply_patch', args: { patch } })
    ).resolves.toEqual([
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, 'notes.txt')
      })
    ])
  })

  it('never derives hunk concurrency from adversarial apply_patch line coordinates', async () => {
    const workspacePath = await temporaryWorkspace()
    await writeFile(join(workspacePath, 'offset.txt'), 'same\ncontext\nsame\n')
    const patch = [
      'diff --git a/offset.txt b/offset.txt',
      '--- a/offset.txt',
      '+++ b/offset.txt',
      '@@ -1,2 +1,2 @@',
      ' same',
      '-context',
      '+changed',
      ''
    ].join('\n')

    const claims = await deriveWorkspaceMutationClaims({
      workspacePath,
      action: 'apply_patch',
      args: { patch }
    })

    expect(claims).toEqual([
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, 'offset.txt')
      })
    ])
    expect(claims.some((claim) => claim.kind === 'hunk')).toBe(false)
  })

  it('uses per-file fallbacks for new, deleted, renamed, binary, and malformed patch files', async () => {
    const workspacePath = await temporaryWorkspace()
    await writeFile(join(workspacePath, 'old.txt'), 'old\n')

    const newFilePatch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+new',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: newFilePatch }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'new.txt') })
    ])

    const nestedNewFilePatch = [
      'diff --git a/nested/deep/new.txt b/nested/deep/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/nested/deep/new.txt',
      '@@ -0,0 +1 @@',
      '+new',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: nestedNewFilePatch }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'nested') }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'nested/deep') }),
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, 'nested/deep/new.txt')
      })
    ])

    const deleteFilePatch = [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-old',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: deleteFilePatch }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'old.txt') })
    ])

    const renamePatch = [
      'diff --git a/old.txt b/renamed.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to renamed.txt',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: renamePatch }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'old.txt') }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'renamed.txt') })
    ])

    const binaryPatch = [
      'diff --git a/old.txt b/old.txt',
      'Binary files a/old.txt and b/old.txt differ',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: binaryPatch }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'old.txt') })
    ])

    const malformedPatch = [
      'diff --git a/old.txt b/old.txt',
      '--- a/old.txt',
      '+++ b/old.txt',
      '@@ not-a-range @@',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: malformedPatch }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'old.txt') })
    ])

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'apply_patch',
        args: { patch: '*** Begin Patch\n*** End Patch\n' }
      })
    ).rejects.toMatchObject({ code: 'invalid-call' })
  })

  it('derives only exact paths and refuses directory moves or renames', async () => {
    const workspacePath = await temporaryWorkspace()
    await mkdir(join(workspacePath, 'folder'))
    await writeFile(join(workspacePath, 'file.txt'), 'content')
    await writeFile(join(workspacePath, 'destination.txt'), 'occupied')

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'create_directory',
        args: { path: 'created/nested' }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'created') }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'created/nested') })
    ])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'delete_path',
        args: { path: 'file.txt' }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'file.txt') })
    ])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'delete_path',
        args: { path: 'folder' }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'folder') })
    ])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'move_path',
        args: { from: 'folder', to: 'moved' }
      })
    ).rejects.toMatchObject({ code: 'invalid-call' })
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'rename_path',
        args: { path: 'file.txt', newName: 'renamed.txt' }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'file.txt') }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'renamed.txt') })
    ])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'move_path',
        args: { from: 'file.txt', to: 'new/deep/moved.txt', createParents: true }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'file.txt') }),
      expect.objectContaining({
        kind: 'file',
        targetPath: join(workspacePath, 'new/deep/moved.txt')
      }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'new') }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'new/deep') })
    ])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'move_path',
        args: { from: 'folder', to: 'destination.txt' }
      })
    ).rejects.toMatchObject({ code: 'invalid-call' })
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'rename_path',
        args: { path: 'file.txt', newName: 'folder' }
      })
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'file.txt') }),
      expect.objectContaining({ kind: 'file', targetPath: join(workspacePath, 'folder') })
    ])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'rename_path',
        args: { path: 'folder', newName: 'destination.txt' }
      })
    ).rejects.toMatchObject({ code: 'invalid-call' })
  })

  it('promotes closed provider-native hunk derivation to whole-file claims', async () => {
    const workspacePath = await temporaryWorkspace()
    const content = 'before\nold\n'
    await writeFile(join(workspacePath, 'native.txt'), content)

    const unifiedPatch = [
      'diff --git a/native.txt b/native.txt',
      '--- a/native.txt',
      '+++ b/native.txt',
      '@@ -2 +2 @@',
      '-old',
      '+new',
      ''
    ].join('\n')
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        source: 'provider-native',
        provider: 'codex',
        action: 'fileChange',
        args: { patch: unifiedPatch },
        nativeContext: { toolKind: 'edit', rawToolCall: { changes: ['native.txt'] } }
      })
    ).resolves.toEqual([
      {
        workspacePath,
        worktreePath: workspacePath,
        kind: 'file',
        mode: 'write',
        targetPath: join(workspacePath, 'native.txt')
      }
    ])

    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        source: 'provider-native',
        provider: 'codex',
        action: 'fileChange',
        args: {
          patch: [
            '*** Begin Patch',
            '*** Update File: native.txt',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
            ''
          ].join('\n')
        },
        nativeContext: { toolKind: 'edit', rawToolCall: { changes: ['native.txt'] } }
      })
    ).rejects.toMatchObject({ code: 'invalid-call' })
  })

  it('never derives a workspace or tree claim for a canonical mutation', async () => {
    const workspacePath = await temporaryWorkspace()
    await mkdir(join(workspacePath, 'folder'))
    await writeFile(join(workspacePath, 'target.txt'), 'needle\n')
    const representativeArgs: Partial<Record<TaskWraithMcpToolName, Record<string, unknown>>> = {
      write_file: { path: 'target.txt', content: 'next' },
      replace: { path: 'target.txt', old_string: 'needle', new_string: 'next' },
      create_directory: { path: 'created' },
      delete_path: { path: 'target.txt' },
      move_path: { from: 'target.txt', to: 'moved.txt' },
      rename_path: { path: 'target.txt', newName: 'renamed.txt' },
      apply_patch: {
        patch: [
          'diff --git a/target.txt b/target.txt',
          '--- a/target.txt',
          '+++ b/target.txt',
          '@@ -1 +1 @@',
          '-needle',
          '+next',
          ''
        ].join('\n')
      },
      run_shell_command: { command: 'pwd' }
    }

    for (const toolName of TASKWRAITH_MCP_TOOLS) {
      const metadata = TASKWRAITH_TOOL_ACTIONS[toolName]
      if (metadata.mutation === 'none') continue
      try {
        const claims = await deriveWorkspaceMutationClaims({
          workspacePath,
          action: toolName,
          args: representativeArgs[toolName] || {}
        })
        expect(
          claims.every((claim) => claim.kind === 'file' || claim.kind === 'hunk'),
          `${toolName} must use only exact file/hunk claims`
        ).toBe(true)
      } catch (error) {
        expect(error, `${toolName} must fail closed without a broad claim`).toMatchObject({
          code: 'invalid-call'
        })
      }
    }
  })

  it('does not lock read-labelled runtime operations and rejects advisory shell edit paths', async () => {
    const workspacePath = await temporaryWorkspace()

    await expect(
      deriveWorkspaceMutationClaims({ workspacePath, action: 'get_diagnostics', args: {} })
    ).resolves.toEqual([])
    await expect(
      deriveWorkspaceMutationClaims({ workspacePath, action: 'video_probe', args: {} })
    ).resolves.toEqual([])
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'run_shell_command',
        args: { command: 'touch changed.txt' }
      })
    ).rejects.toMatchObject({ code: 'invalid-call' })
    await expect(
      deriveWorkspaceMutationClaims({
        workspacePath,
        action: 'run_shell_command',
        args: {
          command: 'node scripts/update.mjs',
          editPaths: ['src/a.ts', 'src/b.ts']
        }
      })
    ).rejects.toMatchObject({
      code: 'invalid-call',
      message: expect.stringContaining('caller-declared paths cannot prove')
    })
  })

  it('uses one exact git metadata mutex instead of a workspace claim', async () => {
    const workspacePath = await temporaryWorkspace()

    for (const action of ['git_stage', 'git_commit']) {
      await expect(
        deriveWorkspaceMutationClaims({ workspacePath, action, args: {} })
      ).resolves.toEqual([
        expect.objectContaining({
          kind: 'file',
          targetPath: join(workspacePath, '.git')
        })
      ])
    }
  })

  it('keeps linked worktrees as the claim domain even when they live outside the workspace', async () => {
    const workspacePath = await temporaryWorkspace()
    const worktreePath = await temporaryWorkspace()

    const claims = await deriveWorkspaceMutationClaims({
      workspacePath,
      worktreePath,
      action: 'write_file',
      args: { path: 'inside.txt', content: 'safe' }
    })

    expect(claims).toEqual([
      expect.objectContaining({
        workspacePath: resolve(workspacePath),
        worktreePath: resolve(worktreePath),
        targetPath: join(worktreePath, 'inside.txt')
      })
    ])
  })
})
