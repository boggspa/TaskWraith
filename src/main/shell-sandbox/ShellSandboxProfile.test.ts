import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as readFileSyncNode } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import {
  buildWorkspaceSandboxProfile,
  resolveShellSandboxPlan,
  sbplQuote,
  SHELL_SANDBOX_DENIED_READ_RELPATHS
} from './ShellSandboxProfile'

const identityRealpath = (value: string): string => value

// The module contributes the plausible temp roots itself, so the seams are
// pinned here: an un-pinned unit test would otherwise assert against whatever
// os.tmpdir()/TMPDIR happen to be on the host running the suite.
const FAKE_TMPDIR = '/var/folders/zz/T'

function plan(overrides: Record<string, unknown> = {}) {
  return resolveShellSandboxPlan({
    platform: 'darwin',
    enabled: true,
    fullAccessGranted: false,
    workspacePath: '/Users/dev/projects/app',
    homePath: '/Users/dev',
    realpath: identityRealpath,
    tmpdir: () => FAKE_TMPDIR,
    env: {},
    ...overrides
  })
}

describe('resolveShellSandboxPlan — when a Seatbelt is refused', () => {
  it('never sandboxes off darwin, so Windows and Linux keep working', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(plan({ platform })).toMatchObject({
        sandboxed: false,
        reason: 'platform_unsupported'
      })
    }
  })

  it('is off by default until the gate says otherwise', () => {
    expect(plan({ enabled: false })).toMatchObject({ sandboxed: false, reason: 'gate_disabled' })
  })

  // Matches codexSandboxForMode: Full Access is the explicit opt-in to an
  // uncontained shell. If the picker says full access and the shell is still
  // confined, the posture the user chose and the boundary disagree.
  it('stands down on a signed Full Access run', () => {
    expect(plan({ fullAccessGranted: true })).toMatchObject({
      sandboxed: false,
      reason: 'full_access_granted'
    })
  })

  // A global-scope run has no workspace concept at all — resolveScopedDirectory
  // hands it an arbitrary host directory by design — so it is out of scope for a
  // workspace-rooted boundary rather than a failure of one. Named explicitly so
  // the exemption is a decision someone can find, not a side effect of a missing
  // root, and so it reads differently from a workspace run that lost its root.
  it('names the global-scope exemption instead of reporting a missing root', () => {
    expect(plan({ globalScopeRun: true })).toMatchObject({
      sandboxed: false,
      enforced: false,
      reason: 'global_scope_run'
    })
  })

  it('ENFORCES a workspace run that lost its root rather than running it open', () => {
    for (const workspacePath of [null, 'relative/path']) {
      expect(plan({ workspacePath })).toMatchObject({
        sandboxed: false,
        enforced: true,
        reason: 'no_workspace_root'
      })
    }
  })

  // A profile whose writable root is / or the home directory grants back
  // everything `(deny file-write*)` just took, while still REPORTING as
  // contained — worse than running unsandboxed.
  it('refuses a root that would grant everything back', () => {
    for (const workspacePath of ['/', '/Users', '/Users/dev']) {
      expect(plan({ workspacePath })).toMatchObject({
        sandboxed: false,
        reason: 'unsafe_workspace_root'
      })
    }
  })
})

describe('buildWorkspaceSandboxProfile', () => {
  it('denies writes before re-granting only the workspace', () => {
    const profile = buildWorkspaceSandboxProfile({ workspaceRoot: '/ws/app' })
    const denyIndex = profile.indexOf('(deny file-write*)')
    const allowIndex = profile.indexOf('(allow file-write* (subpath "/ws/app"))')
    expect(denyIndex).toBeGreaterThan(-1)
    // SBPL is last-match-wins: the allow MUST come after the deny or the
    // workspace is unwritable and every agent edit fails.
    expect(allowIndex).toBeGreaterThan(denyIndex)
  })

  it('re-grants each extra writable root', () => {
    const profile = buildWorkspaceSandboxProfile({
      workspaceRoot: '/ws/app',
      writableRoots: ['/private/tmp']
    })
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))')
  })
})

describe('sbplQuote — profile injection', () => {
  // The profile is one `sandbox-exec -p` argument. An unescaped quote in a
  // directory name would close the string literal and let the rest of the path
  // be parsed as profile syntax — a workspace NAME becoming a sandbox escape.
  it('escapes a quote so a crafted directory name cannot close the literal', () => {
    expect(sbplQuote('/ws/ev"il')).toBe('"/ws/ev\\"il"')
  })

  it('escapes backslashes so an escape cannot be smuggled in', () => {
    expect(sbplQuote('/ws/back\\slash')).toBe('"/ws/back\\\\slash"')
  })

  it('refuses control bytes rather than escaping them', () => {
    expect(() => sbplQuote('/ws/nl\nrule')).toThrow(/control bytes/)
  })

  it('carries the escaping through a built profile', () => {
    const profile = buildWorkspaceSandboxProfile({ workspaceRoot: '/ws/ev"il' })
    expect(profile).toContain('(allow file-write* (subpath "/ws/ev\\"il"))')
    // The injected text must not have produced a second bare allow directive.
    expect(profile.match(/\(allow file-write\* \(subpath/g)).toHaveLength(1)
  })
})

describe('resolveShellSandboxPlan — the contained plan', () => {
  it('resolves symlinked roots because Seatbelt matches the real path', () => {
    const result = plan({
      workspacePath: '/tmp/ws',
      writableRoots: ['/tmp'],
      realpath: (value) => (value.startsWith('/tmp') ? `/private${value}` : value)
    })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain('(allow file-write* (subpath "/private/tmp/ws"))')
    expect(result.profile).not.toContain('(subpath "/tmp/ws")')
  })

  it('denies the home secret paths', () => {
    const result = plan()
    if (!result.sandboxed) throw new Error('expected a contained plan')
    for (const relative of SHELL_SANDBOX_DENIED_READ_RELPATHS) {
      expect(result.profile).toContain(`(deny file-read* (subpath "/Users/dev/${relative}"))`)
    }
  })

  // The agent is already authorized to read the workspace. Denying a path that
  // happens to sit inside it would be a confusing partial refusal, not a boundary.
  it('does not deny a secret path that lives inside the workspace', () => {
    const result = plan({ workspacePath: '/Users/dev/work', homePath: '/Users/dev/work/home' })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    // The agent may already read the whole workspace, so a deny here would be a
    // confusing partial refusal rather than a boundary.
    expect(result.profile).not.toContain('/Users/dev/work/home/.ssh')
    expect(result.profile).not.toContain('(deny file-read*')
  })

  it('drops a writable root that would re-open everything', () => {
    const result = plan({ writableRoots: ['/', '/Users', '/Users/dev'] })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/"))')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/Users"))')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/Users/dev"))')
  })

  it('wraps argv through sandbox-exec without disturbing the command', () => {
    const result = plan()
    if (!result.sandboxed) throw new Error('expected a contained plan')
    const wrapped = result.wrap(['/bin/zsh', '-lc', 'npm test'])
    expect(wrapped[0]).toBe('/usr/bin/sandbox-exec')
    expect(wrapped[1]).toBe('-p')
    expect(wrapped[2]).toBe(result.profile)
    expect(wrapped.slice(3)).toEqual(['/bin/zsh', '-lc', 'npm test'])
  })
})

// The caller resolves os.tmpdir() in the MAIN process, but the command runs
// under `/bin/zsh -lc` — a LOGIN shell, which sources .zshenv/.zprofile and can
// reassign TMPDIR first. A profile that allows only the main process's view
// denies the directory the child actually writes to, and the build tool that
// honours $TMPDIR fails with an error naming neither the sandbox nor TMPDIR.
describe('resolveShellSandboxPlan — temp roots the login shell may actually use', () => {
  it('allows the process temp root even when the caller passes none', () => {
    const result = plan({ writableRoots: [] })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain(`(allow file-write* (subpath "${FAKE_TMPDIR}"))`)
  })

  it('allows a TMPDIR the caller never saw', () => {
    const result = plan({ writableRoots: [], env: { TMPDIR: '/Users/dev/tmp' } })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain('(allow file-write* (subpath "/Users/dev/tmp"))')
  })

  // Seatbelt matches the REAL path, so a lexical /tmp rule silently never fires.
  it('allows /tmp by its real path, not the symlink the profile names', () => {
    const result = plan({
      writableRoots: [],
      realpath: (value: string) => (value === '/tmp' ? '/private/tmp' : value)
    })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain('(allow file-write* (subpath "/private/tmp"))')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/tmp"))')
  })

  // Contributed roots go through the SAME funnel as caller-supplied ones. A temp
  // root of / or $HOME would re-grant everything `(deny file-write*)` just took
  // while the plan still reported `sandboxed: true`.
  it('still refuses a temp root that would re-open the tree', () => {
    for (const unsafe of ['/', '/Users', '/Users/dev']) {
      const result = plan({ writableRoots: [], tmpdir: () => unsafe, env: { TMPDIR: unsafe } })
      if (!result.sandboxed) throw new Error('expected a contained plan')
      expect(result.profile).not.toContain(`(allow file-write* (subpath "${unsafe}"))`)
    }
  })

  it('drops a relative or empty TMPDIR instead of resolving it against cwd', () => {
    for (const TMPDIR of ['', '   ', 'relative/tmp']) {
      const result = plan({ writableRoots: [], env: { TMPDIR } })
      if (!result.sandboxed) throw new Error('expected a contained plan')
      expect(result.profile).not.toContain('relative/tmp')
      expect(result.profile.match(/\(allow file-write\* \(subpath/g)).toHaveLength(2)
    }
  })

  // The live caller already passes os.tmpdir(), so the contributed set overlaps
  // it by construction. Duplicate allow lines are harmless to the kernel and a
  // reliable sign the funnel was bypassed.
  it('emits one allow line when the caller already passed the same temp root', () => {
    const result = plan({ writableRoots: [FAKE_TMPDIR], env: { TMPDIR: FAKE_TMPDIR } })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    const allows = result.profile.match(
      /\(allow file-write\* \(subpath "\/var\/folders\/zz\/T"\)\)/g
    )
    expect(allows).toHaveLength(1)
  })

  // The seams above are test-only. This one omits them so the DEFAULTS —
  // os.tmpdir() and process.env — are proven wired rather than assumed.
  it('reads the real process temp root when no seam is injected', () => {
    const result = resolveShellSandboxPlan({
      platform: 'darwin',
      enabled: true,
      fullAccessGranted: false,
      workspacePath: '/Users/dev/projects/app',
      homePath: '/Users/dev',
      // Only /tmp is rewritten, so the expectation below names the root the
      // funnel emits on any host this suite runs on, macOS or Linux CI.
      realpath: (value: string) => (value === '/tmp' ? '/private/tmp' : value)
    })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    const real = tmpdir() === '/tmp' ? '/private/tmp' : tmpdir()
    expect(result.profile).toContain(`(allow file-write* (subpath ${sbplQuote(real)}))`)
  })
})

// The unit tests above prove the profile TEXT. Only the kernel can prove the
// profile is valid SBPL and that it actually contains a write, so this runs the
// real thing. Skipped off darwin.
const describeLive = process.platform === 'darwin' ? describe : describe.skip
const liveRoots: string[] = []

afterAll(() => {
  for (const root of liveRoots) rmSync(root, { recursive: true, force: true })
})

describeLive('sandbox-exec, for real', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'tw-sandbox-ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'tw-sandbox-out-'))
  const tempRoot = mkdtempSync(join(tmpdir(), 'tw-sandbox-tmp-'))
  liveRoots.push(workspace, outside, tempRoot)

  const contained = resolveShellSandboxPlan({
    platform: 'darwin',
    enabled: true,
    fullAccessGranted: false,
    workspacePath: workspace,
    // `outside` is itself a directory under the real temp root, which this
    // module now contributes on its own. Point the temp seams at a SIBLING of
    // it so the escape tests below still test an escape — and so the allowed
    // temp root can be written to on purpose, one test further down.
    tmpdir: () => tempRoot,
    env: { TMPDIR: tempRoot },
    homePath: join(outside, 'home')
  })

  const run = (script: string): { status: number | null; stderr: string } => {
    if (!contained.sandboxed) throw new Error('expected a contained plan')
    try {
      execFileSync('/usr/bin/sandbox-exec', ['-p', contained.profile, '/bin/zsh', '-c', script], {
        stdio: 'pipe'
      })
      return { status: 0, stderr: '' }
    } catch (error) {
      const failure = error as { status?: number | null; stderr?: Buffer }
      return { status: failure.status ?? null, stderr: String(failure.stderr || '') }
    }
  }

  it('accepts the generated profile as valid SBPL', () => {
    expect(run('exit 0').status).toBe(0)
  })

  it('allows a write inside the workspace', () => {
    const target = join(workspace, 'inside.txt')
    expect(run(`printf ok > ${JSON.stringify(target)}`).status).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('ok')
  })

  // The kernel's word on the contributed temp root: the profile TEXT could name
  // it and still be matching a path nothing writes to.
  it('allows a write into the contributed temp root', () => {
    const target = join(tempRoot, 'temp.txt')
    expect(run(`printf ok > ${JSON.stringify(target)}`).status).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('ok')
  })

  // The whole point. cwd validation alone would let this through.
  it('BLOCKS a write outside the workspace', () => {
    const target = join(outside, 'escaped.txt')
    expect(run(`printf pwned > ${JSON.stringify(target)}`).status).not.toBe(0)
    expect(() => readFileSync(target, 'utf8')).toThrow()
  })

  it('BLOCKS an absolute-path write that a cwd check would miss', () => {
    const target = join(outside, 'absolute.txt')
    expect(
      run(`cd ${JSON.stringify(workspace)} && printf pwned > ${JSON.stringify(target)}`).status
    ).not.toBe(0)
    expect(() => readFileSync(target, 'utf8')).toThrow()
  })

  it('still allows reads outside the workspace, as documented', () => {
    const readable = join(outside, 'readable.txt')
    writeFileSync(readable, 'visible')
    expect(run(`cat ${JSON.stringify(readable)} > /dev/null`).status).toBe(0)
  })

  it('blocks a read of a denied secret path', () => {
    const secret = join(outside, 'home', '.ssh', 'id_rsa')
    execFileSync('/bin/mkdir', ['-p', join(outside, 'home', '.ssh')])
    writeFileSync(secret, 'PRIVATE KEY')
    expect(run(`cat ${JSON.stringify(secret)}`).status).not.toBe(0)
  })
})

describe('resolveShellSandboxPlan — fail closed, never degrade open', () => {
  // A legitimate reason not to contain: the caller runs the command normally.
  it('marks every legitimate exemption unenforced', () => {
    for (const overrides of [
      { platform: 'linux' as NodeJS.Platform },
      { enabled: false },
      { fullAccessGranted: true },
      { globalScopeRun: true }
    ]) {
      const result = plan(overrides)
      expect(result).toMatchObject({ sandboxed: false, enforced: false })
    }
  })

  // Containment was ASKED FOR and cannot be delivered. Falling back to an
  // uncontained shell would leave the operator believing writes are confined.
  it('enforces when sandbox-exec is missing', () => {
    const result = plan({ sandboxBinaryAvailable: () => false })
    expect(result).toMatchObject({
      sandboxed: false,
      enforced: true,
      reason: 'sandbox_binary_unavailable'
    })
  })

  it('enforces rather than exempting an unsafe workspace root', () => {
    expect(plan({ workspacePath: '/Users' })).toMatchObject({
      sandboxed: false,
      enforced: true,
      reason: 'unsafe_workspace_root'
    })
  })

  // Order matters: the binary check must sit BELOW the gate, or a host without
  // sandbox-exec would refuse to run any command even with the feature off.
  it('does not enforce a missing binary when the gate is off', () => {
    expect(plan({ enabled: false, sandboxBinaryAvailable: () => false })).toMatchObject({
      sandboxed: false,
      enforced: false,
      reason: 'gate_disabled'
    })
  })
})

describe('resolveShellSandboxPlan — denylist must not deny the workspace', () => {
  // A workspace nested under a denied directory would otherwise be denied to
  // ITSELF: `(deny file-read* (subpath "~/.config/gh"))` covers
  // `~/.config/gh/mytool`, so every read in the agent's own workspace fails.
  it('drops a secret deny that contains the workspace', () => {
    const result = plan({ workspacePath: '/Users/dev/.config/gh/mytool' })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).not.toContain('(deny file-read* (subpath "/Users/dev/.config/gh"))')
    // Unrelated secrets are still denied.
    expect(result.profile).toContain('(deny file-read* (subpath "/Users/dev/.ssh"))')
  })

  it('still denies a sibling secret that merely shares a prefix string', () => {
    const result = plan({ workspacePath: '/Users/dev/.sshnot' })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain('(deny file-read* (subpath "/Users/dev/.ssh"))')
  })
})

// Source-level contract. The review found that wiring the Seatbelt into ONE
// call site left run_task and start_background_process as uncontained doors;
// these assertions fail if the decision drifts back to a per-call opt-in.
describe('index.ts containment wiring', () => {
  const indexSource = readFileSyncNode(new URL('../index.ts', import.meta.url), 'utf8')
  const index = new MainSourceProbe('index.ts', new URL('../index.ts', import.meta.url))

  it('reads the plan from the projection scope, not a per-call argument', () => {
    // Structural: a rename of the binding throws here rather than passing over
    // a slice that no longer contains the thing being claimed.
    expect(index.text(index.binding('sandboxPlan'))).toBe('projectionScope?.shellSandbox')
    expect(index.typeMembers('HostCommandProjectionScope')).toContain('shellSandbox')
    // The old opt-in field must be gone: it contained whichever call site
    // remembered to pass it and silently left the rest open.
    //
    // Previously spelled `not.toContain('sandbox?: ShellSandboxPlan\n}')`, which
    // anchored the claim on the field being the LAST member of its type. That
    // guard stopped guarding the moment anyone declared a member after it — the
    // forbidden field could come back, not last, and the test stayed green.
    expect(index.typeMembers('HostCommandProjectionScope')).not.toContain('sandbox')
    expect(indexSource).not.toMatch(/(^|[^A-Za-z])sandbox\?: ShellSandboxPlan/m)
  })

  // BOTH spawn families must refuse: runHostCommand (run_shell_command,
  // run_task) and the background registry. Asserting mere presence passed while
  // one of the two was deleted, because the guard reads identically at each.
  it('refuses at every spawn family when containment could not be delivered', () => {
    const guards = indexSource.split('!sandboxPlan.sandboxed && sandboxPlan.enforced').length - 1
    expect(guards).toBe(2)
  })

  it('contains the background-process spawn, which never routes through runHostCommand', () => {
    expect(indexSource).toContain('authority?.sandboxArgv')
    expect(indexSource).toContain('sandboxArgv: sandboxPlan.wrap')
  })

  // Scoped to the resolver body, not the whole file. `grant.access === 'write'`
  // occurs five times in index.ts, so a file-wide toContain passed even with the
  // filter deleted from THIS function — the same vacuous-assertion trap that let
  // a deleted refusal guard slip through an earlier round.
  it('feeds user-granted external write paths into the profile', () => {
    const start = indexSource.indexOf('function brokeredShellSandboxPlan(')
    const body = indexSource.slice(start, indexSource.indexOf('\nfunction ', start + 1))
    expect(start).toBeGreaterThan(-1)
    expect(body).toContain('externalWritableDirectories:')
    expect(body).toContain('externalWritableFiles:')
    expect(body).toContain("grant.access === 'write'")
  })

  it('attaches a plan to every brokered-mcp projection scope', () => {
    const brokered = indexSource.split("source: 'brokered-mcp'").length - 1
    const attached = indexSource.split('shellSandbox: brokeredShellSandboxPlan(').length - 1
    expect(`brokered:${brokered} attached:${attached}`).toBe(`brokered:2 attached:2`)
  })
})

describe('resolveShellSandboxPlan — external path grants', () => {
  // The Seatbelt is a second permission system under TaskWraith's own. An
  // external grant is an explicit user decision; if the profile does not
  // re-grant it, enabling containment silently revokes a capability the user
  // gave and the two systems disagree with no way to see which one refused.
  it('re-grants a directory the user granted write access to', () => {
    const result = plan({ externalWritableDirectories: ['/Users/dev/shared-assets'] })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain('(allow file-write* (subpath "/Users/dev/shared-assets"))')
  })

  it('re-grants a single granted file as a literal, not a subpath', () => {
    const result = plan({ externalWritableFiles: ['/Users/dev/notes/log.txt'] })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).toContain('(allow file-write* (literal "/Users/dev/notes/log.txt"))')
    expect(result.profile).not.toContain('(subpath "/Users/dev/notes/log.txt")')
  })

  // A grant cannot be used to re-open everything the deny just took.
  it('still refuses a granted directory that would re-open the tree', () => {
    const result = plan({ externalWritableDirectories: ['/', '/Users', '/Users/dev'] })
    if (!result.sandboxed) throw new Error('expected a contained plan')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/"))')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/Users"))')
    expect(result.profile).not.toContain('(allow file-write* (subpath "/Users/dev"))')
  })
})

// The registry has TWO spawn branches. Only the ungated one carried the
// transform at first; the gated one is unreachable today (no spawnGatedProcess
// is wired) and would have silently reopened the bypass the moment it was.
describe('BackgroundProcessRegistry containment wiring', () => {
  const registrySource = readFileSyncNode(
    new URL('../services/BackgroundProcessRegistry.ts', import.meta.url),
    'utf8'
  )

  it('forwards the sandbox transform on both spawn branches', () => {
    const forwards = registrySource.split('sandboxArgv: options.sandboxArgv').length - 1
    expect(forwards).toBe(2)
  })
})

describe('contributed temp roots — disclosed widening', () => {
  // /tmp is not a per-user directory. Including it lets a contained shell write
  // somewhere every account on the machine can read and pre-create, which is a
  // real widening of the write surface rather than a neutral convenience. It is
  // kept because cross-platform tooling names /tmp literally, but the header has
  // to say so — an undisclosed widening is the exact failure this module's
  // "describe the boundary precisely" rule exists to prevent.
  it('discloses that /tmp is world-shared in the module header', () => {
    const source = readFileSyncNode(new URL('./ShellSandboxProfile.ts', import.meta.url), 'utf8')
    const header = source.slice(0, source.indexOf('import '))
    expect(header).toContain('WORLD-SHARED')
    expect(header).toContain('/private/tmp')
  })
})

describe('resolveShellSandboxPlan — an unquotable path must not throw', () => {
  // Callers resolve a plan while BUILDING the host-command projection scope,
  // which every brokered MCP tool passes through. A throw there would fail
  // read_file and list_directory — tools that spawn nothing — for a shell
  // boundary they never touch. macOS filenames may legally contain a newline,
  // so this is reachable, not theoretical.
  it('degrades to an enforced refusal instead of throwing', () => {
    const result = plan({ workspacePath: '/Users/dev/we\nird' })
    expect(result).toMatchObject({
      sandboxed: false,
      enforced: true,
      reason: 'profile_build_failed'
    })
  })

  it('carries the refusal reason so the message can name it', () => {
    const result = plan({ workspacePath: '/Users/dev/we\nird' })
    if (result.sandboxed) throw new Error('expected a refusal')
    expect(result.detail).toContain('control bytes')
  })

  // The same hazard reaches the profile through a user-granted path, not only
  // through the workspace root.
  it('refuses rather than throwing for an unquotable external grant', () => {
    const result = plan({ externalWritableDirectories: ['/Users/dev/gr\nant'] })
    expect(result).toMatchObject({ sandboxed: false, enforced: true })
  })
})
