import { isAbsolute, normalize, resolve } from 'node:path'

import { workspaceLockAuthorityRootForHome } from '../WorkspaceLockRuntime'

/**
 * Test-only override for the workspace-lock authority root.
 *
 * The authority root is deliberately one machine-shared, per-user boundary, so
 * every TaskWraith instance on a machine contends on the same fence. That is
 * correct for the product and ruinous for measurement: a startup matrix run
 * against the shared root is bimodal, and the obvious workaround does not work
 * — Electron resolves `app.getPath('home')` through `NSHomeDirectory()`, not
 * `$HOME`, so an env HOME override silently leaves the real root in play and
 * the "isolated" numbers are the shared ones.
 *
 * This override exists so an isolated run is isolated *provably*. It is
 * fail-closed in both directions: refused outright in a packaged build, and a
 * malformed or non-isolating value throws rather than falling back to the
 * shared root, because a silent fallback is exactly the failure it prevents.
 */
export const WORKSPACE_LOCK_AUTHORITY_ROOT_ENV = 'TASKWRAITH_WORKSPACE_LOCK_AUTHORITY_ROOT'

export interface WorkspaceLockAuthorityRootResolution {
  root: string
  overridden: boolean
}

export interface WorkspaceLockAuthorityRootInput {
  homePath: string
  /** Raw env value; undefined or empty means "no override requested". */
  override: string | undefined
  /** Production builds never honour the override. */
  isPackaged: boolean
}

export function resolveWorkspaceLockAuthorityRoot(
  input: WorkspaceLockAuthorityRootInput
): WorkspaceLockAuthorityRootResolution {
  const defaultRoot = workspaceLockAuthorityRootForHome(input.homePath)
  const requested = input.override?.trim()
  if (!requested) return { root: defaultRoot, overridden: false }

  if (input.isPackaged) {
    throw new Error(
      `${WORKSPACE_LOCK_AUTHORITY_ROOT_ENV} is a test-only override and is refused in a packaged build.`
    )
  }
  if (requested.includes('\0')) {
    throw new Error(`${WORKSPACE_LOCK_AUTHORITY_ROOT_ENV} must not contain a NUL byte.`)
  }
  if (!isAbsolute(requested)) {
    throw new Error(`${WORKSPACE_LOCK_AUTHORITY_ROOT_ENV} must be an absolute path.`)
  }
  const root = resolve(normalize(requested))
  if (root !== normalize(requested).replace(/[/\\]+$/, '') && root !== normalize(requested)) {
    throw new Error(
      `${WORKSPACE_LOCK_AUTHORITY_ROOT_ENV} must already be normalized; got ${requested}.`
    )
  }
  if (root === defaultRoot) {
    // Refusing is the point: a "control" run that quietly used the shared root
    // is how a contended measurement gets reported as an isolated one.
    throw new Error(
      `${WORKSPACE_LOCK_AUTHORITY_ROOT_ENV} points at the shared authority root and would not isolate anything.`
    )
  }
  if (root === '/' || root.split(/[/\\]/).filter(Boolean).length < 2) {
    throw new Error(
      `${WORKSPACE_LOCK_AUTHORITY_ROOT_ENV} must name a dedicated directory, not a filesystem root.`
    )
  }
  return { root, overridden: true }
}
