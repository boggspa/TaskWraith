import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  resolveCanonicalWorkspaceLockPath,
  type ResolvedCanonicalWorkspaceLockPath
} from '../workLocks/CanonicalWorkspaceLockPath'
import type {
  WorkspaceLockClaimKind,
  WorkspaceLockMutationCapability
} from '../workLocks/WorkspaceLockTypes'
import {
  prepareVerifiedWorkspaceMutationHandoff,
  reverifyWorkspaceMutationExecutionCwd
} from './VerifiedWorkspaceMutationHandoff'

let leaseSequence = 0

function pathEvidence(input: {
  requestedRoot?: string
  canonicalRoot?: string
  requestedTarget: string
  executableTarget: string
  targetExists?: boolean
}): ResolvedCanonicalWorkspaceLockPath {
  const requestedRoot = input.requestedRoot || '/repo'
  const canonicalRoot = input.canonicalRoot || '/physical/repo'
  const lexicalTarget = nodePath.posix.resolve(requestedRoot, input.requestedTarget)
  const executableTarget = nodePath.posix.resolve(input.executableTarget)
  const relativeTarget = nodePath.posix.relative(canonicalRoot, executableTarget)
  const targetExists = input.targetExists !== false
  const fileIdentity = {
    device: '1',
    inode: String(100 + leaseSequence),
    key: `1:${100 + leaseSequence}`
  }
  return {
    requestedRootPath: requestedRoot,
    requestedTargetPath: lexicalTarget,
    lexicalRootPath: nodePath.posix.resolve(requestedRoot),
    lexicalTargetPath: lexicalTarget,
    pathFlavor: 'posix',
    caseSensitive: true,
    targetExists,
    canonicalPath: executableTarget,
    comparisonPath: executableTarget,
    physicalIdentity: targetExists ? fileIdentity.key : `planned:${relativeTarget}`,
    targetIdentity: targetExists
      ? {
          kind: 'existing',
          file: fileIdentity,
          key: fileIdentity.key
        }
      : {
          kind: 'planned',
          existingAncestor: fileIdentity,
          normalizedSuffix: relativeTarget,
          key: `planned:${relativeTarget}`
        },
    containment: {
      canonicalRootPath: canonicalRoot,
      canonicalTargetPath: executableTarget,
      comparisonRootPath: canonicalRoot,
      comparisonTargetPath: executableTarget,
      relativeTargetPath: relativeTarget.replaceAll(nodePath.posix.sep, '/'),
      rootIdentity: {
        device: '1',
        inode: '10',
        key: '1:10'
      },
      existingAncestorCanonicalPath: targetExists
        ? executableTarget
        : nodePath.posix.dirname(executableTarget),
      existingAncestorIdentity: fileIdentity
    }
  }
}

function capability(input: {
  requestedTarget: string
  executableTarget: string
  kind?: WorkspaceLockClaimKind
  requestedRoot?: string
  canonicalRoot?: string
  targetExists?: boolean
}): WorkspaceLockMutationCapability {
  leaseSequence += 1
  const leaseId = `lease-${leaseSequence}`
  const evidence = pathEvidence(input)
  return {
    token: {
      leaseId,
      acquiredTransitionId: 'transition-1',
      authorityInstanceId: 'authority-1',
      authorityGeneration: 1,
      ownerRunId: 'run-1'
    },
    leaseId,
    kind: input.kind || 'file',
    executableTargetPath: input.executableTarget,
    verifiedPathEvidence: evidence,
    ...(input.kind === 'hunk'
      ? {
          hunk: {
            baseline: 'a'.repeat(64),
            startLine: leaseSequence,
            endLine: leaseSequence + 1
          }
        }
      : {})
  }
}

function workspaceCapability(
  input: {
    requestedRoot?: string
    canonicalRoot?: string
  } = {}
): WorkspaceLockMutationCapability {
  const requestedRoot = input.requestedRoot || '/repo'
  const canonicalRoot = input.canonicalRoot || '/physical/repo'
  return capability({
    requestedRoot,
    canonicalRoot,
    requestedTarget: requestedRoot,
    executableTarget: canonicalRoot,
    kind: 'workspace'
  })
}

function repositoryCapability(
  input: {
    requestedRoot?: string
    canonicalRoot?: string
  } = {}
): WorkspaceLockMutationCapability {
  const requestedRoot = input.requestedRoot || '/repo'
  const canonicalRoot = input.canonicalRoot || '/physical/repo'
  return capability({
    requestedRoot,
    canonicalRoot,
    requestedTarget: '.git',
    executableTarget: nodePath.posix.join(canonicalRoot, '.git'),
    kind: 'file'
  })
}

function realWorkspaceCapability(rootPath: string): WorkspaceLockMutationCapability {
  leaseSequence += 1
  const leaseId = `lease-${leaseSequence}`
  const evidence = resolveCanonicalWorkspaceLockPath({
    rootPath,
    targetPath: rootPath
  })
  return {
    token: {
      leaseId,
      acquiredTransitionId: 'transition-1',
      authorityInstanceId: 'authority-1',
      authorityGeneration: 1,
      ownerRunId: 'run-1'
    },
    leaseId,
    kind: 'workspace',
    executableTargetPath: evidence.canonicalPath,
    verifiedPathEvidence: evidence
  }
}

function directoryAlias(target: string, alias: string): void {
  symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
}

describe('prepareVerifiedWorkspaceMutationHandoff', () => {
  it('replaces every write alias with the capability-only canonical target', () => {
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'write_file',
      args: {
        path: 'link/a.ts',
        file_path: 'raw-ignored.ts',
        filePath: 'also-ignored.ts',
        file: 'executor-alias.ts',
        content: 'hello'
      },
      capabilities: [
        capability({
          requestedTarget: 'link/a.ts',
          executableTarget: '/physical/repo/src/a.ts'
        })
      ]
    })

    expect(result).toMatchObject({
      ok: true,
      mode: 'precise-targets',
      args: {
        path: '/physical/repo/src/a.ts',
        content: 'hello'
      },
      executionContext: {
        cwd: '/physical/repo',
        workspacePath: '/physical/repo',
        executableTargetPaths: ['/physical/repo/src/a.ts'],
        rawPrecisePathsForwarded: false
      }
    })
    if (result.ok) {
      expect(result.args).not.toHaveProperty('file_path')
      expect(result.args).not.toHaveProperty('filePath')
      expect(result.args).not.toHaveProperty('file')
      expect(JSON.stringify(result.args)).not.toContain('link/a.ts')
      expect(JSON.stringify(result.args)).not.toContain('raw-ignored.ts')
    }
  })

  it('rejects a capability whose executable target is not its fresh canonical path', () => {
    const injected = capability({
      requestedTarget: 'a.ts',
      executableTarget: '/physical/repo/a.ts'
    })
    injected.executableTargetPath = '/physical/repo/injected.ts'

    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'write_file',
        args: { path: 'a.ts', content: 'x' },
        capabilities: [injected]
      })
    ).toMatchObject({ ok: false, reason: 'invalid_capability' })
  })

  it.each([
    {
      toolName: 'create_directory',
      args: {
        directory: 'alias/generated',
        folder: 'ignored-folder',
        recursive: true
      },
      requestedTarget: 'alias/generated',
      executableTarget: '/physical/repo/build/generated',
      kind: 'tree' as const
    },
    {
      toolName: 'delete_path',
      args: {
        path: 'alias/obsolete.ts',
        file: 'ignored-file.ts',
        directory: 'ignored-directory'
      },
      requestedTarget: 'alias/obsolete.ts',
      executableTarget: '/physical/repo/src/obsolete.ts',
      kind: 'file' as const
    }
  ])(
    'rewrites $toolName to its one verified target and removes executor aliases',
    ({ toolName, args, requestedTarget, executableTarget, kind }) => {
      const result = prepareVerifiedWorkspaceMutationHandoff({
        toolName,
        args,
        capabilities: [
          capability({
            requestedTarget,
            executableTarget,
            kind
          })
        ]
      })

      expect(result).toMatchObject({
        ok: true,
        args: { path: executableTarget },
        executionContext: { executableTargetPaths: [executableTarget] }
      })
      if (result.ok) {
        expect(result.args).not.toHaveProperty('directory')
        expect(result.args).not.toHaveProperty('folder')
        expect(result.args).not.toHaveProperty('file')
        expect(JSON.stringify(result.args)).not.toContain('ignored-')
      }
    }
  )

  it('maps a move by evidence when capabilities arrive in adversarial order', () => {
    const source = capability({
      requestedTarget: 'alias/source.ts',
      executableTarget: '/physical/repo/src/source.ts'
    })
    const destination = capability({
      requestedTarget: 'out/destination.ts',
      executableTarget: '/physical/repo/out/destination.ts',
      targetExists: false
    })

    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'move_path',
      args: {
        from: 'alias/source.ts',
        source: 'ignored-source.ts',
        path: 'ignored-path.ts',
        to: 'out/destination.ts',
        target: 'ignored-target.ts',
        overwrite: true
      },
      capabilities: [destination, source]
    })

    expect(result).toMatchObject({
      ok: true,
      args: {
        from: '/physical/repo/src/source.ts',
        to: '/physical/repo/out/destination.ts',
        overwrite: true
      },
      executionContext: {
        executableTargetPaths: ['/physical/repo/src/source.ts', '/physical/repo/out/destination.ts']
      }
    })
    if (result.ok) {
      expect(JSON.stringify(result.args)).not.toContain('ignored-')
    }
  })

  it('refuses move capability count and target mismatches', () => {
    const source = capability({
      requestedTarget: 'source.ts',
      executableTarget: '/physical/repo/source.ts'
    })
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'move_path',
        args: { from: 'source.ts', to: 'destination.ts' },
        capabilities: [source]
      })
    ).toMatchObject({ ok: false, reason: 'capability_count_mismatch' })

    const unrelated = capability({
      requestedTarget: 'other.ts',
      executableTarget: '/physical/repo/other.ts'
    })
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'move_path',
        args: { from: 'source.ts', to: 'destination.ts' },
        capabilities: [unrelated, source]
      })
    ).toMatchObject({ ok: false, reason: 'path_mismatch' })
  })

  it('derives rename basename from the destination capability and strips conflicting aliases', () => {
    const destination = capability({
      requestedTarget: 'src/after.ts',
      executableTarget: '/physical/repo/src/after.ts',
      targetExists: false
    })
    const source = capability({
      requestedTarget: 'src/before.ts',
      executableTarget: '/physical/repo/src/before.ts'
    })

    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'rename_path',
      args: {
        path: 'src/before.ts',
        from: 'malicious-source.ts',
        new_name: 'after.ts',
        name: 'malicious.ts',
        overwrite: true
      },
      capabilities: [destination, source]
    })

    expect(result).toMatchObject({
      ok: true,
      args: {
        path: '/physical/repo/src/before.ts',
        newName: 'after.ts',
        overwrite: true
      }
    })
    if (result.ok) {
      expect(result.args).not.toHaveProperty('new_name')
      expect(result.args).not.toHaveProperty('name')
      expect(JSON.stringify(result.args)).not.toContain('malicious.ts')
    }
  })

  it('collapses multiple verified hunks for one replace target', () => {
    const first = capability({
      requestedTarget: 'src/a.ts',
      executableTarget: '/physical/repo/src/a.ts',
      kind: 'hunk'
    })
    const second = capability({
      requestedTarget: 'src/a.ts',
      executableTarget: '/physical/repo/src/a.ts',
      kind: 'hunk'
    })
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'replace',
      args: { path: 'src/a.ts', old_string: 'a', new_string: 'b', replace_all: true },
      capabilities: [second, first]
    })

    expect(result).toMatchObject({
      ok: true,
      args: { path: '/physical/repo/src/a.ts' },
      executionContext: {
        executableTargetPaths: ['/physical/repo/src/a.ts']
      }
    })
  })

  it('rejects ambiguous capabilities for one lexical request', () => {
    const first = capability({
      requestedTarget: 'link/a.ts',
      executableTarget: '/physical/repo/a.ts'
    })
    const second = capability({
      requestedTarget: 'link/a.ts',
      executableTarget: '/physical/repo/other-a.ts'
    })

    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'write_file',
        args: { path: 'link/a.ts', content: 'x' },
        capabilities: [first, second]
      })
    ).toMatchObject({ ok: false, reason: 'ambiguous_path' })
  })

  it('rejects duplicate non-hunk targets instead of hiding a capability-count error', () => {
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_commit',
        args: { message: 'release' },
        capabilities: [workspaceCapability(), workspaceCapability()]
      })
    ).toMatchObject({ ok: false, reason: 'invalid_capability' })
  })

  it('rejects capabilities spliced from different verified acquisitions', () => {
    const source = capability({
      requestedTarget: 'source.ts',
      executableTarget: '/physical/repo/source.ts'
    })
    const destination = capability({
      requestedTarget: 'destination.ts',
      executableTarget: '/physical/repo/destination.ts'
    })
    destination.token.acquiredTransitionId = 'other-transition'

    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'move_path',
        args: { from: 'source.ts', to: 'destination.ts' },
        capabilities: [source, destination]
      })
    ).toMatchObject({ ok: false, reason: 'invalid_capability' })
  })

  it('rewrites multi-target git paths in caller order, never capability order', () => {
    const a = capability({
      requestedTarget: 'alias/a.ts',
      executableTarget: '/physical/repo/src/a.ts'
    })
    const b = capability({
      requestedTarget: 'alias/b.ts',
      executableTarget: '/physical/repo/src/b.ts'
    })

    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_stage',
      args: { paths: ['alias/b.ts', 'alias/a.ts'] },
      capabilities: [a, b]
    })

    expect(result).toMatchObject({
      ok: true,
      args: {
        paths: ['/physical/repo/src/b.ts', '/physical/repo/src/a.ts']
      },
      executionContext: {
        executableTargetPaths: ['/physical/repo/src/b.ts', '/physical/repo/src/a.ts']
      }
    })
  })

  it('refuses unused extra capabilities in a multi-target handoff', () => {
    const a = capability({
      requestedTarget: 'a.ts',
      executableTarget: '/physical/repo/a.ts'
    })
    const b = capability({
      requestedTarget: 'b.ts',
      executableTarget: '/physical/repo/b.ts'
    })

    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_stage',
        args: { paths: ['a.ts'] },
        capabilities: [a, b]
      })
    ).toMatchObject({ ok: false, reason: 'capability_count_mismatch' })
  })

  it('returns a conservative canonical-root context for repository-wide git staging', () => {
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_stage',
      args: { all: true },
      capabilities: [
        workspaceCapability({
          requestedRoot: '/old/root-alias',
          canonicalRoot: '/mounted/current-root'
        })
      ]
    })

    expect(result).toEqual({
      ok: true,
      mode: 'verified-workspace',
      args: { all: true },
      executionContext: {
        cwd: '/mounted/current-root',
        workspacePath: '/mounted/current-root',
        mode: 'verified-workspace',
        executableTargetPaths: ['/mounted/current-root'],
        capabilityLeaseIds: expect.any(Array),
        rawPrecisePathsForwarded: false
      }
    })
  })

  it('normalizes workspace-wide git path selectors under the capability root', () => {
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_stage',
      args: {
        paths: ['/old/root-alias/src/a.ts', 'src/b.ts'],
        path: 'ignored.ts'
      },
      capabilities: [
        workspaceCapability({
          requestedRoot: '/old/root-alias',
          canonicalRoot: '/mounted/current-root'
        })
      ]
    })

    expect(result).toMatchObject({
      ok: true,
      mode: 'verified-workspace',
      args: {
        paths: ['/mounted/current-root/src/a.ts', '/mounted/current-root/src/b.ts']
      },
      executionContext: {
        cwd: '/mounted/current-root',
        workspacePath: '/mounted/current-root'
      }
    })
    if (result.ok) {
      expect(JSON.stringify(result.args)).not.toContain('/old/root-alias')
      expect(JSON.stringify(result.args)).not.toContain('ignored.ts')
    }
  })

  it('normalizes path-bearing git staging through its exact repository metadata capability', () => {
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_stage',
      args: {
        paths: ['/repo/docs/channels-p6-plan.md', 'src/worker.ts'],
        path: 'ignored.ts'
      },
      capabilities: [
        repositoryCapability({
          requestedRoot: '/repo',
          canonicalRoot: '/physical/repo'
        })
      ]
    })

    expect(result).toMatchObject({
      ok: true,
      mode: 'verified-workspace',
      args: {
        paths: ['/physical/repo/docs/channels-p6-plan.md', '/physical/repo/src/worker.ts']
      },
      executionContext: {
        cwd: '/physical/repo',
        workspacePath: '/physical/repo',
        executableTargetPaths: ['/physical/repo']
      }
    })
  })

  it.each([{ all: true }, { update: true }])(
    'accepts repository-wide git staging through its exact metadata capability: %j',
    (args) => {
      expect(
        prepareVerifiedWorkspaceMutationHandoff({
          toolName: 'git_stage',
          args,
          capabilities: [repositoryCapability()]
        })
      ).toMatchObject({
        ok: true,
        mode: 'verified-workspace',
        args
      })
    }
  )

  it('accepts git commit through the same exact repository metadata capability', () => {
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_commit',
        args: { message: 'docs: record the verified finding' },
        capabilities: [repositoryCapability()]
      })
    ).toMatchObject({
      ok: true,
      mode: 'verified-workspace',
      args: { message: 'docs: record the verified finding' },
      executionContext: {
        cwd: '/physical/repo',
        workspacePath: '/physical/repo'
      }
    })
  })

  it('never promotes an arbitrary precise file capability into repository authority', () => {
    const arbitraryFile = capability({
      requestedTarget: 'src/a.ts',
      executableTarget: '/physical/repo/src/a.ts'
    })

    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_stage',
        args: { paths: ['src/b.ts'] },
        capabilities: [arbitraryFile]
      })
    ).toMatchObject({ ok: false, reason: 'path_mismatch' })
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_commit',
        args: { message: 'must fail' },
        capabilities: [arbitraryFile]
      })
    ).toMatchObject({ ok: false, reason: 'capability_count_mismatch' })
  })

  it('refuses workspace-wide git path selectors that escape the verified root', () => {
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_stage',
        args: { paths: ['../outside.ts'] },
        capabilities: [workspaceCapability()]
      })
    ).toMatchObject({ ok: false, reason: 'path_mismatch' })
  })

  it('refuses repository-capability git path selectors that escape the verified root', () => {
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'git_stage',
        args: { paths: ['../outside.ts'] },
        capabilities: [repositoryCapability()]
      })
    ).toMatchObject({ ok: false, reason: 'path_mismatch' })
  })

  it('rewrites every unified-patch path from exact capability targets', () => {
    const patch = [
      'diff --git a/alias/a.ts b/alias/a.ts',
      '--- a/alias/a.ts',
      '+++ b/alias/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'apply_patch',
      args: { patch },
      capabilities: [
        capability({
          requestedTarget: 'alias/a.ts',
          executableTarget: '/physical/repo/src/a.ts'
        })
      ]
    })

    expect(result).toMatchObject({ ok: true, mode: 'precise-targets' })
    if (!result.ok) return
    expect(result.args.patch).toBe(
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new'
      ].join('\n')
    )
    expect(String(result.args.patch)).not.toContain('alias/a.ts')
  })

  it('maps rename-only patch metadata with reversed capabilities', () => {
    const patch = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts'
    ].join('\n')
    const source = capability({
      requestedTarget: 'old.ts',
      executableTarget: '/physical/repo/src/old.ts'
    })
    const destination = capability({
      requestedTarget: 'new.ts',
      executableTarget: '/physical/repo/src/new.ts',
      targetExists: false
    })
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'apply_patch',
      args: { patch },
      capabilities: [destination, source]
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.args.patch).toBe(
      [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/new.ts'
      ].join('\n')
    )
  })

  it('rewrites git-stage patch headers under a verified workspace capability', () => {
    const patch = [
      'diff --git a/./src/a.ts b/./src/a.ts',
      '--- a/./src/a.ts',
      '+++ b/./src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_stage',
      args: { patch },
      capabilities: [
        workspaceCapability({
          requestedRoot: '/old/root-alias',
          canonicalRoot: '/mounted/current-root'
        })
      ]
    })

    expect(result).toMatchObject({
      ok: true,
      mode: 'verified-workspace',
      executionContext: {
        cwd: '/mounted/current-root',
        workspacePath: '/mounted/current-root'
      }
    })
    if (result.ok) {
      expect(result.args.patch).toBe(
        [
          'diff --git a/src/a.ts b/src/a.ts',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new'
        ].join('\n')
      )
    }
  })

  it('rewrites git-stage patch headers under the exact repository metadata capability', () => {
    const patch = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_stage',
      args: { patch },
      capabilities: [repositoryCapability()]
    })

    expect(result).toMatchObject({
      ok: true,
      mode: 'verified-workspace',
      args: { patch }
    })
  })

  it('refuses unsafe or capability-incomplete patches without returning raw paths', () => {
    const exact = capability({
      requestedTarget: 'a.ts',
      executableTarget: '/physical/repo/a.ts'
    })
    const unsafe = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'apply_patch',
      args: {
        patch: [
          'diff --git "a/a file.ts" "b/a file.ts"',
          '--- "a/a file.ts"',
          '+++ "b/a file.ts"'
        ].join('\n')
      },
      capabilities: [exact]
    })
    expect(unsafe).toMatchObject({ ok: false, reason: 'unsafe_patch' })
    expect(unsafe).not.toHaveProperty('args')

    const incomplete = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'apply_patch',
      args: {
        patch: [
          'diff --git a/a.ts b/b.ts',
          '--- a/a.ts',
          '+++ b/b.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b'
        ].join('\n')
      },
      capabilities: [exact]
    })
    expect(incomplete).toMatchObject({ ok: false, reason: 'path_mismatch' })
    expect(incomplete).not.toHaveProperty('args')
  })

  it('reports the exact hunk and count mismatch for an overlong patch body', () => {
    const exact = capability({
      requestedTarget: 'a.ts',
      executableTarget: '/physical/repo/a.ts'
    })
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'apply_patch',
      args: {
        patch: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1,2 +1 @@',
          '-one',
          '-two',
          '-three'
        ].join('\n')
      },
      capabilities: [exact]
    })

    expect(result).toMatchObject({ ok: false, reason: 'unsafe_patch' })
    if (result.ok) return
    expect(result.message).toContain('hunk 1')
    expect(result.message).toContain('declared old=2, new=1')
    expect(result.message).toContain('consumed old=3, new=0')
  })

  it('refuses precise tools backed only by a workspace-wide capability', () => {
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'delete_path',
        args: { path: 'a.ts' },
        capabilities: [workspaceCapability()]
      })
    ).toMatchObject({ ok: false, reason: 'capability_count_mismatch' })
  })

  it('preserves a verified subcwd across a canonical root alias for shell, task, background, and git', () => {
    const tempRoot = mkdtempSync(nodePath.join(tmpdir(), 'taskwraith-lock-cwd-'))
    try {
      const physicalRoot = nodePath.join(tempRoot, 'physical-workspace')
      const rootAlias = nodePath.join(tempRoot, 'workspace-alias')
      const subcwd = nodePath.join(physicalRoot, 'packages', 'app')
      mkdirSync(subcwd, { recursive: true })
      directoryAlias(physicalRoot, rootAlias)
      const locked = realWorkspaceCapability(rootAlias)
      const canonicalPhysicalRoot = locked.executableTargetPath
      const canonicalSubcwd = nodePath.join(canonicalPhysicalRoot, 'packages', 'app')
      const cases = [
        {
          toolName: 'run_shell_command',
          args: {
            command: 'pwd',
            cwd: 'packages/app',
            workdir: 'ignored-alias'
          }
        },
        { toolName: 'run_task', args: { task: 'test' } },
        {
          toolName: 'start_background_process',
          args: { command: 'npm run dev' }
        },
        { toolName: 'git_commit', args: { message: 'release' } }
      ] as const

      for (const entry of cases) {
        const result = prepareVerifiedWorkspaceMutationHandoff({
          ...entry,
          capabilities: [locked],
          requestedCwd: 'packages/app',
          effectiveCwd: nodePath.join(rootAlias, 'packages', 'app')
        })

        expect(result).toMatchObject({
          ok: true,
          mode: 'verified-workspace'
        })
        if (result.ok) {
          expect(result.executionContext.cwd).toBe(canonicalSubcwd)
          expect(result.executionContext.workspacePath).toBe(canonicalPhysicalRoot)
          expect(result.executionContext.cwdPathEvidence?.canonicalPath).toBe(canonicalSubcwd)
          expect(result.executionContext.cwdPathEvidence?.containment?.canonicalRootPath).toBe(
            canonicalPhysicalRoot
          )
          expect(result.executionContext.cwdPathEvidence?.containment?.relativeTargetPath).toBe(
            'packages/app'
          )
        }
        if (result.ok && entry.toolName === 'run_shell_command') {
          expect(result.args.cwd).toBe(canonicalSubcwd)
          expect(result.args).not.toHaveProperty('workdir')
          expect(JSON.stringify(result.args)).not.toContain('ignored-alias')
        }
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true })
    }
  })

  it('refuses mismatched, alternate-root, and symlink-alias cwd selectors', () => {
    const tempRoot = mkdtempSync(nodePath.join(tmpdir(), 'taskwraith-lock-cwd-alias-'))
    try {
      const physicalRoot = nodePath.join(tempRoot, 'physical-workspace')
      const rootAlias = nodePath.join(tempRoot, 'workspace-alias')
      const alternateAlias = nodePath.join(tempRoot, 'alternate-alias')
      const first = nodePath.join(physicalRoot, 'first')
      const second = nodePath.join(physicalRoot, 'second')
      const nestedAlias = nodePath.join(physicalRoot, 'nested-alias')
      mkdirSync(first, { recursive: true })
      mkdirSync(second, { recursive: true })
      directoryAlias(physicalRoot, rootAlias)
      directoryAlias(physicalRoot, alternateAlias)
      directoryAlias(first, nestedAlias)
      const locked = realWorkspaceCapability(rootAlias)

      expect(
        prepareVerifiedWorkspaceMutationHandoff({
          toolName: 'run_shell_command',
          args: { command: 'pwd' },
          capabilities: [locked],
          requestedCwd: 'first',
          effectiveCwd: nodePath.join(rootAlias, 'second')
        })
      ).toMatchObject({ ok: false, reason: 'cwd_mismatch' })

      expect(
        prepareVerifiedWorkspaceMutationHandoff({
          toolName: 'run_shell_command',
          args: { command: 'pwd' },
          capabilities: [locked],
          requestedCwd: 'first',
          effectiveCwd: nodePath.join(alternateAlias, 'first')
        })
      ).toMatchObject({ ok: false, reason: 'cwd_mismatch' })

      expect(
        prepareVerifiedWorkspaceMutationHandoff({
          toolName: 'run_shell_command',
          args: { command: 'pwd' },
          capabilities: [locked],
          requestedCwd: 'nested-alias',
          effectiveCwd: nodePath.join(rootAlias, 'nested-alias')
        })
      ).toMatchObject({ ok: false, reason: 'cwd_mismatch' })
    } finally {
      rmSync(tempRoot, { force: true, recursive: true })
    }
  })

  it('refuses a subcwd when the verified root object was replaced', () => {
    const tempRoot = mkdtempSync(nodePath.join(tmpdir(), 'taskwraith-lock-cwd-swap-'))
    try {
      const physicalRoot = nodePath.join(tempRoot, 'physical-workspace')
      const displacedRoot = nodePath.join(tempRoot, 'displaced-workspace')
      const rootAlias = nodePath.join(tempRoot, 'workspace-alias')
      mkdirSync(nodePath.join(physicalRoot, 'packages'), { recursive: true })
      directoryAlias(physicalRoot, rootAlias)
      const staleCapability = realWorkspaceCapability(rootAlias)
      // Preserve the alias pathname but replace the physical root object.
      renameSync(physicalRoot, displacedRoot)
      mkdirSync(nodePath.join(physicalRoot, 'packages'), { recursive: true })

      expect(
        prepareVerifiedWorkspaceMutationHandoff({
          toolName: 'run_task',
          args: { task: 'test' },
          capabilities: [staleCapability],
          requestedCwd: 'packages',
          effectiveCwd: nodePath.join(rootAlias, 'packages')
        })
      ).toMatchObject({ ok: false, reason: 'cwd_mismatch' })
    } finally {
      rmSync(tempRoot, { force: true, recursive: true })
    }
  })

  it('detects a subcwd object swap during a delayed executor preflight', () => {
    const tempRoot = mkdtempSync(nodePath.join(tmpdir(), 'taskwraith-lock-cwd-delay-'))
    try {
      const physicalRoot = nodePath.join(tempRoot, 'physical-workspace')
      const rootAlias = nodePath.join(tempRoot, 'workspace-alias')
      const subcwd = nodePath.join(physicalRoot, 'packages')
      const displaced = nodePath.join(physicalRoot, 'old-packages')
      mkdirSync(subcwd, { recursive: true })
      directoryAlias(physicalRoot, rootAlias)
      const handoff = prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'run_shell_command',
        args: { command: 'pwd', cwd: 'packages' },
        capabilities: [realWorkspaceCapability(rootAlias)],
        requestedCwd: 'packages',
        effectiveCwd: nodePath.join(rootAlias, 'packages')
      })
      expect(handoff).toMatchObject({ ok: true })
      if (!handoff.ok) return
      expect(reverifyWorkspaceMutationExecutionCwd(handoff.executionContext)).toEqual({
        ok: true
      })

      renameSync(subcwd, displaced)
      mkdirSync(subcwd)
      expect(reverifyWorkspaceMutationExecutionCwd(handoff.executionContext)).toMatchObject({
        ok: false,
        reason: 'cwd_mismatch'
      })
    } finally {
      rmSync(tempRoot, { force: true, recursive: true })
    }
  })

  it('uses only fresh canonical roots for coarse execution after a root alias swap', () => {
    const result = prepareVerifiedWorkspaceMutationHandoff({
      toolName: 'git_commit',
      args: { message: 'release' },
      capabilities: [
        workspaceCapability({
          requestedRoot: '/detached/old-root',
          canonicalRoot: '/verified/new-root'
        })
      ]
    })

    expect(result).toMatchObject({
      ok: true,
      mode: 'verified-workspace',
      args: { message: 'release' },
      executionContext: {
        cwd: '/verified/new-root',
        workspacePath: '/verified/new-root',
        executableTargetPaths: ['/verified/new-root']
      }
    })
    if (result.ok) {
      expect(JSON.stringify(result)).not.toContain('/detached/old-root')
    }
  })

  it('fails closed for an unknown mutation dispatcher', () => {
    expect(
      prepareVerifiedWorkspaceMutationHandoff({
        toolName: 'future_path_mutator',
        args: { path: 'a.ts' },
        capabilities: [
          capability({
            requestedTarget: 'a.ts',
            executableTarget: '/physical/repo/a.ts'
          })
        ]
      })
    ).toMatchObject({ ok: false, reason: 'unsupported_tool' })
  })
})
