import { open, lstat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'

export type RendererLocalPathOperation = 'open' | 'reveal' | 'file-icon'

export interface RendererLocalPathAuthorizationRequest {
  operation: RendererLocalPathOperation
  requestedPath: string
}

/**
 * Authorizers must derive authority from the invoking WebContents, not from
 * renderer-supplied paths. Returning the canonical authorized path lets the
 * handler use exactly the path that was checked for the subsequent OS call.
 */
export type AuthorizeRendererLocalPath = (
  event: IpcMainInvokeEvent,
  request: RendererLocalPathAuthorizationRequest
) => string | Promise<string>

export interface ResolveRendererLocalPathInput {
  requestedPath: string
  isMainRenderer: boolean
  ownerWorkspacePath?: string
  authorizedAttachmentPaths?: readonly string[]
  canonicalizePath: (path: string) => string
}

function pathIsWithinRoot(path: string, root: string): boolean {
  const child = relative(root, path)
  return (
    child === '' ||
    (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  )
}

/**
 * Resolve renderer-supplied local paths against main-owned authority. Main may
 * address any canonical desktop path. A secondary renderer may address only a
 * path inside its frozen workspace or an exact attachment capability issued to
 * that WebContents. The canonicalizer must resolve symlinks for secondary
 * callers so lexical workspace prefixes cannot escape the owned tree.
 */
export function resolveRendererLocalPath(input: ResolveRendererLocalPathInput): string {
  const requestedPath = input.requestedPath.trim()
  if (!requestedPath) throw new Error('Renderer local-path request is empty.')

  if (input.isMainRenderer) {
    return input.canonicalizePath(requestedPath)
  }

  const ownerWorkspacePath = input.ownerWorkspacePath?.trim()
  const candidate = isAbsolute(requestedPath)
    ? requestedPath
    : ownerWorkspacePath
      ? resolve(ownerWorkspacePath, requestedPath)
      : requestedPath

  let canonicalTarget: string
  try {
    canonicalTarget = input.canonicalizePath(candidate)
  } catch {
    throw new Error('Secondary renderer local path could not be resolved safely.')
  }

  if (new Set(input.authorizedAttachmentPaths || []).has(canonicalTarget)) {
    return canonicalTarget
  }

  if (ownerWorkspacePath) {
    let canonicalWorkspace: string
    try {
      canonicalWorkspace = input.canonicalizePath(ownerWorkspacePath)
    } catch {
      throw new Error('Secondary renderer workspace path could not be resolved safely.')
    }
    if (pathIsWithinRoot(canonicalTarget, canonicalWorkspace)) {
      return canonicalTarget
    }
  }

  throw new Error('Secondary renderer local path is outside its owned workspace.')
}

export async function resolveAuthorizedRendererLocalPath(
  authorize: AuthorizeRendererLocalPath | undefined,
  event: IpcMainInvokeEvent,
  request: RendererLocalPathAuthorizationRequest
): Promise<string> {
  if (!request.requestedPath.trim()) {
    throw new Error('Renderer local-path request is empty.')
  }
  if (!authorize) {
    throw new Error('Renderer local-path authorization is not configured.')
  }
  const authorizedPath = (await authorize(event, request)).trim()
  if (!authorizedPath) {
    throw new Error('Renderer local-path authorization returned an empty path.')
  }
  return authorizedPath
}

export interface LocalOpenTargetInspection {
  kind: 'file' | 'directory' | 'symlink' | 'other'
  mode: number
  prefix: Uint8Array
}

export type InspectLocalOpenTarget = (path: string) => Promise<LocalOpenTargetInspection>

const ACTIVE_OPEN_EXTENSIONS = new Set([
  '.app',
  '.application',
  '.applescript',
  '.bat',
  '.bundle',
  '.cmd',
  '.com',
  '.command',
  '.desktop',
  '.dmg',
  '.exe',
  '.fish',
  '.iso',
  '.jar',
  '.lnk',
  '.mpkg',
  '.pkg',
  '.plugin',
  '.prefpane',
  '.ps1',
  '.scpt',
  '.sh',
  '.url',
  '.webloc',
  '.workflow',
  '.zsh'
])

const EXECUTABLE_MAGIC = new Set([
  '7f454c46', // ELF
  'cafebabe', // Mach-O universal / Java class (both active content)
  'bebafeca',
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe'
])

async function inspectLocalOpenTarget(path: string): Promise<LocalOpenTargetInspection> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    return { kind: 'symlink', mode: metadata.mode, prefix: new Uint8Array() }
  }
  if (metadata.isDirectory()) {
    return { kind: 'directory', mode: metadata.mode, prefix: new Uint8Array() }
  }
  if (!metadata.isFile()) {
    return { kind: 'other', mode: metadata.mode, prefix: new Uint8Array() }
  }

  const handle = await open(path, 'r')
  try {
    const prefix = new Uint8Array(4)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    return { kind: 'file', mode: metadata.mode, prefix: prefix.subarray(0, bytesRead) }
  } finally {
    await handle.close()
  }
}

function prefixHex(prefix: Uint8Array): string {
  return Array.from(prefix)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function isExecutablePrefix(prefix: Uint8Array): boolean {
  if (prefix.length >= 2 && prefix[0] === 0x23 && prefix[1] === 0x21) return true
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) return true
  return prefix.length >= 4 && EXECUTABLE_MAGIC.has(prefixHex(prefix.subarray(0, 4)))
}

/**
 * A workspace popout may open ordinary documents and images, but it must not
 * turn a compromised renderer into a local code-launch primitive. Main keeps
 * its existing explicit authority. Secondary callers reject app/package
 * targets, symlinks, executable files, and shebang/native executable content.
 */
export async function assertSecondaryRendererLocalOpenIsPassive(
  authorizedPath: string,
  options: {
    isMainRenderer: boolean
    inspect?: InspectLocalOpenTarget
  }
): Promise<void> {
  if (options.isMainRenderer) return

  const extension = extname(authorizedPath).toLowerCase()
  if (ACTIVE_OPEN_EXTENSIONS.has(extension)) {
    throw new Error('Secondary renderers cannot open executable or active local targets.')
  }

  let inspection: LocalOpenTargetInspection
  try {
    inspection = await (options.inspect ?? inspectLocalOpenTarget)(authorizedPath)
  } catch {
    throw new Error('Secondary renderer local target could not be inspected safely.')
  }

  if (inspection.kind === 'symlink') {
    throw new Error('Secondary renderers cannot open symbolic-link targets.')
  }
  if (inspection.kind === 'file') {
    if ((inspection.mode & 0o111) !== 0 || isExecutablePrefix(inspection.prefix)) {
      throw new Error('Secondary renderers cannot open executable or active local targets.')
    }
  }
}
