// macOS Seatbelt (`sandbox-exec`) wrapper for the agent shell.
//
// WHAT THIS CONTAINS, PRECISELY — the honest boundary, because a sandbox that
// is described more strongly than it behaves is worse than none:
//
//   WRITES  — hard-contained. `(deny file-write*)` follows `(allow default)`,
//             and only the workspace subpath plus the process temp roots are
//             allowed back. This is the property `NativeWorkspaceToolGate`'s
//             `runtimeSandboxed` flag is asking about, and the one this module
//             is willing to assert.
//   READS   — broad, minus a denylist of high-value secrets (SSH/AWS/GnuPG/
//             keychains/cloud + shell credentials). Best-effort by construction:
//             a denylist cannot enumerate every secret on a user's disk. Do NOT
//             describe this as read containment.
//   NETWORK — NOT contained. Denying egress here would break `npm install`,
//             `git fetch`, and every package manager an agent legitimately runs.
//
// Why `(allow default)` rather than `(deny default)`: a deny-default profile has
// to enumerate every mach service, sysctl, and IPC that a real toolchain touches,
// and each omission surfaces as an inscrutable mid-build failure rather than a
// permission error. Write containment is the property being bought; buying it
// with a profile that reliably runs `npm`, `git`, `cargo` and `swift` is worth
// more than a tighter profile that gets switched off after the first false
// positive.
//
// macOS-only. Every other platform resolves to an unsandboxed plan with a stated
// reason; nothing here may become a hard requirement on Windows or Linux.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export type ShellSandboxUnavailableReason =
  | 'platform_unsupported'
  | 'gate_disabled'
  | 'full_access_granted'
  | 'no_workspace_root'
  | 'unsafe_workspace_root'
  | 'sandbox_binary_unavailable'

/** Absolute path to the Seatbelt driver. Apple has deprecated it, so its absence
 *  is a real state to handle rather than a theoretical one. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export type ShellSandboxPlan =
  | { sandboxed: true; profile: string; wrap: (command: readonly string[]) => string[] }
  | {
      sandboxed: false
      /**
       * True when containment was ASKED FOR and could not be delivered. The
       * caller must refuse to run rather than silently falling back to an
       * uncontained shell — a gate that degrades open is worse than no gate,
       * because the operator believes writes are confined and they are not.
       */
      enforced: boolean
      reason: ShellSandboxUnavailableReason
      detail?: string
    }

export interface ShellSandboxPlanInput {
  platform: NodeJS.Platform
  /** Env gate. False resolves unsandboxed with `gate_disabled`. */
  enabled: boolean
  /**
   * True for a signed Full Access run. Full Access is the explicit opt-in to an
   * uncontained shell, exactly as `codexSandboxForMode` drops Codex's own
   * sandbox — the picker and the boundary must not disagree.
   */
  fullAccessGranted: boolean
  /** Active workspace root. Absent means there is nothing to contain to. */
  workspacePath?: string | null
  /** Additional writable roots (temp dirs). Non-absolute entries are dropped. */
  writableRoots?: readonly string[]
  /**
   * Home directory used to site the secret denylist and to refuse a home-rooted
   * writable root. REQUIRED: when it was optional, omitting it silently skipped
   * the home guard and let the whole home directory become writable while the
   * plan still reported `sandboxed: true`.
   */
  homePath: string
  /** Injected for tests; defaults to `realpathSync`. */
  realpath?: (value: string) => string
  /** Injected for tests; defaults to a real `existsSync` on SANDBOX_EXEC_PATH. */
  sandboxBinaryAvailable?: () => boolean
}

/**
 * Home-relative secret locations denied even though reads are otherwise broad.
 * A denylist, with a denylist's limits — this narrows the obvious blast radius
 * of an agent shell, it does not make the filesystem confidential.
 */
export const SHELL_SANDBOX_DENIED_READ_RELPATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'Library/Keychains',
  'Library/Application Support/com.apple.TCC'
] as const

// eslint-disable-next-line no-control-regex -- detecting control bytes is the point
const SBPL_FORBIDDEN_CONTROL_BYTES = /[\x00-\x1f\x7f]/

/**
 * Quote a path into an SBPL string literal.
 *
 * Load-bearing: the profile is passed to `sandbox-exec -p` as one argument, so a
 * path containing `"` or `\` would otherwise terminate the literal early and let
 * a crafted directory name inject profile syntax — turning a workspace name into
 * a sandbox escape. Only these two characters are special inside an SBPL string,
 * and a NUL cannot survive argv, so escaping them is sufficient. Control bytes
 * are refused outright rather than escaped, because they have no legitimate
 * place in a workspace path this code should be willing to contain.
 */
export function sbplQuote(value: string): string {
  if (SBPL_FORBIDDEN_CONTROL_BYTES.test(value)) {
    throw new Error('Refusing to build a sandbox profile for a path containing control bytes.')
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Roots that must never be handed to the profile as the writable workspace: a
 * profile rooted at `/` or at the home directory grants back everything the
 * `(deny file-write*)` line just took away, which is worse than running
 * unsandboxed because it reports as contained.
 */
function isUnsafeWritableRoot(candidate: string, homePath: string): boolean {
  if (candidate === '') return true
  if (candidate === homePath) return true
  // A two-segment absolute path ("/Users", "/private") is a system tier, not a
  // workspace. Anything deeper is the user's own directory layout.
  return candidate.split('/').filter(Boolean).length < 2
}

/**
 * Resolve to the path Seatbelt will actually match on.
 *
 * The kernel matches the REAL path, so `/tmp/x` must become `/private/tmp/x` or
 * the rule silently never fires. A plain `realpathSync` is not enough: it throws
 * on a path that does not exist yet (a denylist entry for a home directory the
 * user has never created, a workspace root about to be made), and falling back
 * to a lexical `resolve` there leaves `/var/...` unresolved while the kernel
 * sees `/private/var/...`. That mismatch is silent and fails OPEN for a deny
 * rule, so resolve the deepest ancestor that does exist and re-append the rest.
 */
function safeRealpath(value: string, realpath: (input: string) => string): string {
  const absolute = resolve(value)
  const trailing: string[] = []
  let current = absolute
  for (;;) {
    try {
      const resolved = realpath(current)
      return trailing.length > 0 ? join(resolved, ...trailing.reverse()) : resolved
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      trailing.push(basename(current))
      current = parent
    }
  }
}

export function buildWorkspaceSandboxProfile(input: {
  workspaceRoot: string
  writableRoots?: readonly string[]
  deniedReadPaths?: readonly string[]
}): string {
  const writable = [input.workspaceRoot, ...(input.writableRoots || [])]
  const lines = [
    '(version 1)',
    '(allow default)',
    '',
    '; Writes are the contained axis. Everything below re-grants the minimum.',
    '(deny file-write*)',
    ...writable.map((root) => `(allow file-write* (subpath ${sbplQuote(root)}))`),
    '(allow file-write-data',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/dtracehelper")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr"))',
    '(allow file-write* (regex #"^/dev/ttys[0-9]*$"))',
    '(allow file-write* (regex #"^/dev/fd/[0-9]+$"))'
  ]
  const deniedReads = input.deniedReadPaths || []
  if (deniedReads.length > 0) {
    lines.push(
      '',
      '; Best-effort secret denial. Reads are otherwise broad by design.',
      ...deniedReads.map((path) => `(deny file-read* (subpath ${sbplQuote(path)}))`)
    )
  }
  return `${lines.join('\n')}\n`
}

/** Decide whether this run gets a Seatbelt, and build the wrapper if so. */
export function resolveShellSandboxPlan(input: ShellSandboxPlanInput): ShellSandboxPlan {
  // Every branch above the gate is a legitimate reason NOT to contain, so all of
  // them report `enforced: false` — the caller runs the command normally.
  if (input.platform !== 'darwin') {
    return {
      sandboxed: false,
      enforced: false,
      reason: 'platform_unsupported',
      detail: input.platform
    }
  }
  if (!input.enabled) return { sandboxed: false, enforced: false, reason: 'gate_disabled' }
  if (input.fullAccessGranted) {
    return { sandboxed: false, enforced: false, reason: 'full_access_granted' }
  }

  const rawWorkspace = (input.workspacePath || '').trim()
  if (!rawWorkspace || !isAbsolute(rawWorkspace)) {
    return { sandboxed: false, enforced: false, reason: 'no_workspace_root' }
  }

  // Past this point the gate is on, the posture is contained, and there IS a
  // workspace — so containment was asked for. A failure from here is enforced.
  const binaryAvailable = input.sandboxBinaryAvailable || (() => existsSync(SANDBOX_EXEC_PATH))
  if (!binaryAvailable()) {
    return {
      sandboxed: false,
      enforced: true,
      reason: 'sandbox_binary_unavailable',
      detail: SANDBOX_EXEC_PATH
    }
  }

  const realpath = input.realpath || realpathSync
  const home = safeRealpath(input.homePath, realpath)
  const workspaceRoot = safeRealpath(rawWorkspace, realpath)
  if (isUnsafeWritableRoot(workspaceRoot, home)) {
    return {
      sandboxed: false,
      enforced: true,
      reason: 'unsafe_workspace_root',
      detail: workspaceRoot
    }
  }

  const writableRoots: string[] = []
  for (const candidate of input.writableRoots || []) {
    const trimmed = (candidate || '').trim()
    if (!trimmed || !isAbsolute(trimmed)) continue
    const resolved = safeRealpath(trimmed, realpath)
    if (isUnsafeWritableRoot(resolved, home)) continue
    if (resolved === workspaceRoot || writableRoots.includes(resolved)) continue
    writableRoots.push(resolved)
  }

  const deniedReadPaths = SHELL_SANDBOX_DENIED_READ_RELPATHS.map(
    (relative) => `${home}/${relative}`
  ).filter((path) => {
    // A secret path INSIDE the workspace is not denied: the agent is already
    // authorized to read the workspace, so a deny would be a confusing partial
    // refusal rather than a boundary.
    if (path === workspaceRoot || path.startsWith(`${workspaceRoot}/`)) return false
    // A secret path that CONTAINS the workspace must not be denied either, or the
    // agent loses read access to its own files. A workspace of
    // `~/.config/gh/mytool` sits under the `~/.config/gh` deny, and a subpath
    // deny there makes every read in the workspace fail.
    if (workspaceRoot.startsWith(`${path}/`)) return false
    return true
  })

  const profile = buildWorkspaceSandboxProfile({ workspaceRoot, writableRoots, deniedReadPaths })
  return {
    sandboxed: true,
    profile,
    wrap: (command) => [SANDBOX_EXEC_PATH, '-p', profile, ...command]
  }
}
