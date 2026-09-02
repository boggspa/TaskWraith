import { describe, expect, it } from 'vitest'

import { HOST_GIT_SAFE_CONFIG_OVERRIDES, HostGitRefusedError } from './HostGitSecurity'
import {
  HOST_GIT_MAX_PAYLOAD_BYTES,
  HostGitReadService,
  truncateHostGitText,
  type HostGitFsPort,
  type HostGitSpawnPort,
  type HostGitSpawnResult
} from './HostGitReadService'

const WORKSPACE = '/workspace/project'

interface SpawnCall {
  command: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxBytes: number
}

/** Records EXACTLY what would be handed to the OS. Never runs a real git. */
function recordingSpawn(
  respond: (args: readonly string[]) => Partial<HostGitSpawnResult>
): HostGitSpawnPort & { calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  return {
    calls,
    run: async (input) => {
      calls.push({ ...input, args: [...input.args] })
      const subcommand = input.args.find((arg) => !arg.startsWith('-') && arg !== 'HEAD')
      return { status: 0, stdout: '', stderr: '', ...respond([subcommand ?? '', ...input.args]) }
    }
  }
}

function fsPort(overrides: Partial<HostGitFsPort> = {}): HostGitFsPort {
  return {
    realpath: (path) => path,
    inspectGitMarker: () => ({ exists: true, kind: 'dir' as const }),
    ...overrides
  }
}

function service(
  spawn: HostGitSpawnPort,
  fs: HostGitFsPort = fsPort(),
  options: { maxPayloadBytes?: number } = {}
): HostGitReadService {
  return new HostGitReadService({
    spawn,
    fs,
    env: { PATH: '/usr/bin', GITHUB_TOKEN: 'secret', GIT_DIR: '/elsewhere' },
    ...options
  })
}

function defaultResponses(args: readonly string[]): Partial<HostGitSpawnResult> {
  if (args.includes('--show-toplevel')) return { stdout: `${WORKSPACE}\n` }
  if (args.includes('--show-current')) return { stdout: 'main\n' }
  if (args.includes('HEAD')) return { stdout: 'abc123\n' }
  if (args.includes('status')) return { stdout: 'M  a.ts\0' }
  return { stdout: 'diff --git a/a.ts b/a.ts\n' }
}

describe('hardening reaches the actual spawn call', () => {
  it('hands the -c overrides to spawn, not merely to a helper', async () => {
    // The assertion that matters: a helper can return the right argv while the
    // service forgets to use it. This inspects what spawn actually received.
    const spawn = recordingSpawn(defaultResponses)
    await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })

    expect(spawn.calls.length).toBeGreaterThan(0)
    for (const call of spawn.calls) {
      expect(call.args.slice(0, HOST_GIT_SAFE_CONFIG_OVERRIDES.length)).toEqual([
        ...HOST_GIT_SAFE_CONFIG_OVERRIDES
      ])
    }
  })

  it('hands a scrubbed, prompt-disabled env to spawn', async () => {
    const spawn = recordingSpawn(defaultResponses)
    await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })

    for (const call of spawn.calls) {
      expect(call.env).not.toHaveProperty('GITHUB_TOKEN')
      expect(call.env).not.toHaveProperty('GIT_DIR')
      expect(call.env.GIT_TERMINAL_PROMPT).toBe('0')
      // @portability-ok: asserts the fixture PATH passes through the env scrub unchanged — the code under test pins no literal
      expect(call.env.PATH).toBe('/usr/bin')
    }
  })

  it('pins cwd to the workspace and supplies a timeout and byte bound', async () => {
    const spawn = recordingSpawn(defaultResponses)
    await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })

    for (const call of spawn.calls) {
      expect(call.cwd).toBe(WORKSPACE)
      expect(call.timeoutMs).toBeGreaterThan(0)
      expect(call.maxBytes).toBeGreaterThan(0)
      expect(call.command).toBe('git')
    }
  })
})

describe('repository scope is fail-closed', () => {
  it('REFUSES a repository whose toplevel resolves outside the workspace', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel') ? { stdout: '/somewhere/else\n' } : defaultResponses(args)
    )

    await expect(
      service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/resolves outside the workspace/)
  })

  it('REFUSES an ancestor checkout that would widen the read', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel') ? { stdout: '/workspace\n' } : defaultResponses(args)
    )

    await expect(
      service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(HostGitRefusedError)
  })

  it('compares the REALPATH of the toplevel so a symlink cannot move the boundary', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel')
        ? { stdout: '/workspace/project-link\n' }
        : defaultResponses(args)
    )
    const fs = fsPort({
      realpath: (path) => (path === '/workspace/project-link' ? '/somewhere/else' : path)
    })

    await expect(
      service(spawn, fs).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/resolves outside the workspace/)
  })

  it('REFUSES a symlinked .git marker', async () => {
    const spawn = recordingSpawn(defaultResponses)
    const fs = fsPort({ inspectGitMarker: () => ({ exists: true, kind: 'symlink' as const }) })

    await expect(
      service(spawn, fs).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/symlinked \.git marker/)
  })

  it('REFUSES a missing .git marker', async () => {
    const spawn = recordingSpawn(defaultResponses)
    const fs = fsPort({ inspectGitMarker: () => ({ exists: false, kind: 'dir' as const }) })

    await expect(
      service(spawn, fs).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(HostGitRefusedError)
  })

  it('admits a .git FILE only because the toplevel already proved to be inside', async () => {
    const spawn = recordingSpawn(defaultResponses)
    const fs = fsPort({ inspectGitMarker: () => ({ exists: true, kind: 'file' as const }) })

    const result = await service(spawn, fs).read({
      workspaceRealPath: WORKSPACE,
      scope: 'status'
    })
    expect(result.repositoryRoot).toBe(WORKSPACE)
  })

  it('refuses a .git-file repo whose redirected toplevel escapes', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel') ? { stdout: '/other/root\n' } : defaultResponses(args)
    )
    const fs = fsPort({ inspectGitMarker: () => ({ exists: true, kind: 'file' as const }) })

    await expect(
      service(spawn, fs).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/resolves outside the workspace/)
  })

  it('refuses a relative workspace path', async () => {
    const spawn = recordingSpawn(defaultResponses)
    await expect(
      service(spawn).read({ workspaceRealPath: 'relative/dir', scope: 'status' })
    ).rejects.toThrow(/absolute workspace path/)
  })

  it('refuses when no repository is reported', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel') ? { stdout: '\n' } : defaultResponses(args)
    )
    await expect(
      service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/no repository/)
  })
})

describe('pathspec validation', () => {
  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a traversing path', '../../etc/passwd'],
    ['a nested traversal', 'src/../../outside'],
    ['a flag-shaped path', '--output=/tmp/x'],
    ['a control character', 'a\nb'],
    ['an empty path', '']
  ])('refuses %s before spawning', async (_label, path) => {
    const spawn = recordingSpawn(defaultResponses)
    await expect(
      service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'diff', path })
    ).rejects.toThrow(HostGitRefusedError)
    expect(spawn.calls).toEqual([])
  })

  it('passes a relative pathspec after a -- separator', async () => {
    const spawn = recordingSpawn(defaultResponses)
    await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'diff', path: 'src/a.ts' })

    const diffCall = spawn.calls.find((call) => call.args.includes('diff'))
    expect(diffCall?.args.slice(-2)).toEqual(['--', 'src/a.ts'])
  })
})

describe('payload cap', () => {
  it('truncates AND marks rather than silently clipping', () => {
    const result = truncateHostGitText('x'.repeat(1000), 100)
    expect(result.truncated).toBe(true)
    expect(result.byteLength).toBeLessThanOrEqual(100)
  })

  it('does not mark an under-cap payload', () => {
    const result = truncateHostGitText('short', HOST_GIT_MAX_PAYLOAD_BYTES)
    expect(result).toMatchObject({ text: 'short', truncated: false })
  })

  it('never splits a multi-byte character', () => {
    const result = truncateHostGitText('é'.repeat(200), 101)
    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain('�')
    expect(Buffer.from(result.text, 'utf8').byteLength).toBeLessThanOrEqual(101)
  })

  it('marks an oversized diff through the service', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel')
        ? { stdout: `${WORKSPACE}\n` }
        : args.includes('diff')
          ? { stdout: 'd'.repeat(5_000) }
          : defaultResponses(args)
    )

    const result = await service(spawn, fsPort(), { maxPayloadBytes: 512 }).read({
      workspaceRealPath: WORKSPACE,
      scope: 'diff'
    })

    expect(result.text?.truncated).toBe(true)
    expect(result.text?.byteLength).toBeLessThanOrEqual(512)
  })
})

describe('read surface', () => {
  it('returns parsed status files with branch and head', async () => {
    const spawn = recordingSpawn(defaultResponses)
    const result = await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })

    expect(result).toMatchObject({ scope: 'status', branch: 'main', head: 'abc123' })
    expect(result.files?.[0]).toMatchObject({ path: 'a.ts', kind: 'modified' })
  })

  it('uses --no-ext-diff on diff so an ext-diff helper cannot run', async () => {
    const spawn = recordingSpawn(defaultResponses)
    await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'diff' })

    const diffCall = spawn.calls.find((call) => call.args.includes('diff'))
    expect(diffCall?.args).toContain('--no-ext-diff')
    expect(diffCall?.args).toContain('--no-color')
  })

  it('bounds the log read', async () => {
    const spawn = recordingSpawn(defaultResponses)
    await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'log' })

    const logCall = spawn.calls.find((call) => call.args.includes('log'))
    expect(logCall?.args).toContain('--max-count=100')
  })

  it('tolerates a detached HEAD without failing the read', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-current')
        ? { status: 1, stdout: '', stderr: 'detached' }
        : defaultResponses(args)
    )

    const result = await service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    expect(result.branch).toBeNull()
  })

  it('surfaces a timeout as a refusal rather than an empty result', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel') ? { timedOut: true, status: null } : defaultResponses(args)
    )

    await expect(
      service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/timed out/)
  })

  it('surfaces a non-zero exit as a refusal', async () => {
    const spawn = recordingSpawn((args) =>
      args.includes('--show-toplevel')
        ? { status: 128, stdout: '', stderr: 'fatal: not a git repository' }
        : defaultResponses(args)
    )

    await expect(
      service(spawn).read({ workspaceRealPath: WORKSPACE, scope: 'status' })
    ).rejects.toThrow(/not a git repository/)
  })
})

describe('construction', () => {
  it('requires both injected ports', () => {
    expect(
      () =>
        new HostGitReadService({ spawn: undefined as unknown as HostGitSpawnPort, fs: fsPort() })
    ).toThrow(/spawn port/)
    expect(
      () =>
        new HostGitReadService({
          spawn: recordingSpawn(defaultResponses),
          fs: undefined as unknown as HostGitFsPort
        })
    ).toThrow(/filesystem port/)
  })
})
