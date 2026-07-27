/**
 * Conservative parsers for local model sidecar references. They return only
 * safe relative paths; callers decide whether an absent/undeclared reference
 * is tolerated (legacy single-file import) or rejected (scene package).
 */
import { isSafeMeshAssetRelativePath } from '../../shared/meshScene'

export interface MeshModelDependencyParseOptions {
  /**
   * Package manifests promise a closed local bundle. Direct file imports keep
   * their historical best-effort behaviour, but package imports reject an
   * unsafe or remote sidecar reference rather than silently omitting it.
   */
  rejectUnsafe?: boolean
}

function safeReferencedPath(raw: string): string | null {
  const text = raw.trim().replace(/^['"]|['"]$/g, '')
  if (!text || text.length > 512 || text.startsWith('data:')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(text)
  } catch {
    return null
  }
  const normal = decoded.replace(/\\/g, '/')
  return isSafeMeshAssetRelativePath(normal) ? normal : null
}

function textReferences(
  source: string,
  pattern: RegExp,
  options: MeshModelDependencyParseOptions
): string[] {
  const refs = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    const raw = match[1] || ''
    const safe = safeReferencedPath(raw)
    if (!safe && options.rejectUnsafe) {
      throw new Error(`Model sidecar reference “${raw.trim()}” is not a safe local path.`)
    }
    if (safe) refs.add(safe)
  }
  return [...refs]
}

export function meshObjMtlReferences(
  source: string,
  options: MeshModelDependencyParseOptions = {}
): string[] {
  // Wavefront's `mtllib` convention permits one path per line in normal DCC
  // exports. Quoted values retain spaces; unquoted values are deliberately
  // accepted as one trimmed path rather than guessing at multiple filenames.
  return textReferences(source, /^\s*mtllib\s+(.+?)\s*$/gim, options)
}

export function meshMtlTextureReferences(
  source: string,
  options: MeshModelDependencyParseOptions = {}
): string[] {
  const refs = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*map_[a-z0-9_]+\s+(.+?)\s*$/i.exec(line)
    if (!match) continue
    const raw = match[1].trim()
    // Most MTL option forms put the actual filename last. This deliberately
    // favours safe omission over treating an option as a path.
    const quoted = /(?:^|\s)(['"])(.+?)\1\s*$/.exec(raw)
    const candidate = quoted ? quoted[2] : raw.split(/\s+/).at(-1) || ''
    const safe = safeReferencedPath(candidate)
    if (!safe && options.rejectUnsafe) {
      throw new Error(`Model sidecar reference “${candidate.trim()}” is not a safe local path.`)
    }
    if (safe) refs.add(safe)
  }
  return [...refs]
}

export function meshGltfReferences(
  source: string,
  options: MeshModelDependencyParseOptions = {}
): string[] {
  let parsed: {
    buffers?: Array<{ uri?: unknown }>
    images?: Array<{ uri?: unknown }>
  }
  try {
    parsed = JSON.parse(source) as {
      buffers?: Array<{ uri?: unknown }>
      images?: Array<{ uri?: unknown }>
    }
  } catch {
    throw new Error('The glTF JSON could not be parsed.')
  }
  const refs = new Set<string>()
  for (const item of [...(parsed.buffers ?? []), ...(parsed.images ?? [])]) {
    const raw = typeof item?.uri === 'string' ? item.uri : ''
    // A data URI is already embedded in the JSON and therefore has no
    // package file to declare. Any other non-local URI would violate the
    // closed-bundle promise when strict package parsing is enabled.
    if (raw.startsWith('data:')) continue
    const safe = safeReferencedPath(raw)
    if (!safe && raw && options.rejectUnsafe) {
      throw new Error(`Model sidecar reference “${raw.trim()}” is not a safe local path.`)
    }
    if (safe) refs.add(safe)
  }
  return [...refs]
}
