export const RENDERER_ATTACHMENT_AUTHORIZATION_ERROR =
  'Renderer is not authorized to use one or more attachments.'

/**
 * Resolve renderer-supplied attachment paths to canonical paths, keeping only
 * the entries the caller is authorized to use. Unresolvable (moved/deleted),
 * empty, or unauthorized entries are DROPPED, never thrown: an ambiguous
 * attachment must not fail a run. Security is preserved because unauthorized
 * paths are never returned to the caller.
 */
export function resolveAuthorizedRendererAttachmentPaths(
  rawPaths: unknown,
  authorizedCanonicalPaths: readonly string[],
  canonicalize: (path: string) => string
): string[] {
  if (rawPaths === undefined) return []
  if (!Array.isArray(rawPaths)) return []
  const authorized = new Set(authorizedCanonicalPaths)
  const resolved: string[] = []
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    let canonicalPath: string
    try {
      canonicalPath = canonicalize(rawPath.trim())
    } catch {
      continue
    }
    if (!canonicalPath || !authorized.has(canonicalPath)) continue
    resolved.push(canonicalPath)
  }
  return resolved
}

/**
 * Rewrite attachment records with only caller-authorized canonical paths.
 * Records whose path cannot be resolved or is not authorized are dropped so
 * the run continues without the ambiguous attachment.
 */
export function authorizeAttachmentRecords<T extends { path: string }>(
  attachments: readonly T[],
  resolvePaths: (paths: string[]) => string[]
): T[] {
  if (attachments.length === 0) return []
  const authorized: T[] = []
  for (const attachment of attachments) {
    let resolved: string[]
    try {
      resolved = resolvePaths([attachment.path])
    } catch {
      continue
    }
    if (resolved.length === 0) continue
    authorized.push({ ...attachment, path: resolved[0] })
  }
  return authorized
}

export async function authorizeThenExpandAttachmentRecords<T extends { path: string }, U>(
  attachments: readonly T[],
  resolvePaths: (paths: string[]) => string[],
  expand: (attachments: T[]) => Promise<U>
): Promise<U> {
  const authorized = authorizeAttachmentRecords(attachments, resolvePaths)
  return expand(authorized)
}

/**
 * Dispatch a payload with only the image paths the caller is authorized to
 * use. Unauthorized or unresolvable paths are dropped (never delivered), and
 * the text turn still dispatches.
 */
export async function dispatchWithAuthorizedAttachmentPaths<
  T extends { imagePaths?: string[] },
  U
>(
  payload: T,
  resolvePaths: (paths: string[]) => string[],
  dispatch: (payload: T) => Promise<U>
): Promise<U> {
  if (payload.imagePaths === undefined) return dispatch(payload)
  let authorizedPaths: string[]
  try {
    authorizedPaths = resolvePaths(payload.imagePaths)
  } catch {
    authorizedPaths = []
  }
  return dispatch({ ...payload, imagePaths: authorizedPaths })
}
