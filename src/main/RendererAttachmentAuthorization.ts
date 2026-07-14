export const RENDERER_ATTACHMENT_AUTHORIZATION_ERROR =
  'Renderer is not authorized to use one or more attachments.'

export function resolveAuthorizedRendererAttachmentPaths(
  rawPaths: unknown,
  authorizedCanonicalPaths: readonly string[],
  canonicalize: (path: string) => string
): string[] {
  if (rawPaths === undefined) return []
  if (!Array.isArray(rawPaths)) throw new Error(RENDERER_ATTACHMENT_AUTHORIZATION_ERROR)

  const authorized = new Set(authorizedCanonicalPaths)
  return rawPaths.map((rawPath) => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new Error(RENDERER_ATTACHMENT_AUTHORIZATION_ERROR)
    }
    let canonicalPath: string
    try {
      canonicalPath = canonicalize(rawPath.trim())
    } catch {
      throw new Error(RENDERER_ATTACHMENT_AUTHORIZATION_ERROR)
    }
    if (!canonicalPath || !authorized.has(canonicalPath)) {
      throw new Error(RENDERER_ATTACHMENT_AUTHORIZATION_ERROR)
    }
    return canonicalPath
  })
}

export function authorizeAttachmentRecords<T extends { path: string }>(
  attachments: readonly T[],
  resolvePaths: (paths: string[]) => string[]
): T[] {
  if (attachments.length === 0) return []
  const resolvedPaths = resolvePaths(attachments.map((attachment) => attachment.path))
  if (resolvedPaths.length !== attachments.length) {
    throw new Error(RENDERER_ATTACHMENT_AUTHORIZATION_ERROR)
  }
  return attachments.map((attachment, index) => ({
    ...attachment,
    path: resolvedPaths[index]
  }))
}

export async function authorizeThenExpandAttachmentRecords<T extends { path: string }, U>(
  attachments: readonly T[],
  resolvePaths: (paths: string[]) => string[],
  expand: (attachments: T[]) => Promise<U>
): Promise<U> {
  const authorized = authorizeAttachmentRecords(attachments, resolvePaths)
  return expand(authorized)
}

export async function dispatchWithAuthorizedAttachmentPaths<
  T extends { imagePaths?: string[] },
  U
>(
  payload: T,
  resolvePaths: (paths: string[]) => string[],
  dispatch: (payload: T) => Promise<U>
): Promise<U> {
  if (payload.imagePaths === undefined) return dispatch(payload)
  const authorizedPayload = {
    ...payload,
    imagePaths: resolvePaths(payload.imagePaths)
  }
  return dispatch(authorizedPayload)
}
