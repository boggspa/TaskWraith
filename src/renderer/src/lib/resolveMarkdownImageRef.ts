import type { ChatMediaRef } from '../components/ChatMediaPanel'

/*
 * resolveMarkdownImageRef — map a markdown `![alt](src)` back to a persisted
 * transcript media ref so the inline placeholder can be replaced with the
 * SAFE bounded thumbnail the main process already produced.
 *
 * Security model (the H4 invariant). The renderer must NEVER load the raw
 * markdown `src` an agent wrote — it could be `https://evil/track.png`
 * (beacon / exfil) or `file:///etc/passwd` (local read). So:
 *
 *   1. Non-local schemes (http/https/data/blob/javascript/…) are rejected up
 *      front — they can never resolve to a ref.
 *   2. Matching is PATH-ONLY (absolute realpath or workspace-relative path).
 *      The loose "match by basename / by alt text" tiers are deliberately
 *      dropped: they are spoofable (`![](anything/out.png)` would borrow an
 *      unrelated ref's thumbnail).
 *   3. The only thing ever emitted to an <img src> is `inlineMarkdownImageThumbnail`,
 *      which returns ONLY a `data:` URL built from the ref's bounded thumbnail —
 *      never `ref.path`, never the markdown src. A mismatch falls back to the
 *      inert placeholder. The worst case of any matching bug is "no thumbnail",
 *      never "loaded an attacker URL".
 *
 * The renderer has no `fs`/`path`, so normalisation is pure string work. Symlink
 * resolution (which the main process applies via realpath) cannot be reproduced
 * here — a workspace reached through a symlink simply fails to match and shows
 * the placeholder, which is a safe degradation.
 */

const NON_LOCAL_SCHEME = /^(?:https?|data|blob|javascript|vbscript|mailto|about|tel):/i

function decodeFileUrl(value: string): string {
  if (!/^file:\/\//i.test(value)) return value
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return ''
  }
}

/** Treat `C:\…` / `\\?\…` as absolute too (posix-first, Windows-tolerant). */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(value)
}

/**
 * Pure POSIX-style path normalisation. Collapses `.`/`..`/`//`, converts
 * backslashes, drops a trailing slash. Renderer-safe (no Node `path`).
 */
export function posixNormalize(input: string): string {
  if (!input) return ''
  const slashed = input.replace(/\\/g, '/')
  const isAbs = slashed.startsWith('/')
  const out: string[] = []
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!isAbs) out.push('..')
    } else {
      out.push(part)
    }
  }
  return (isAbs ? '/' : '') + out.join('/')
}

interface PathForms {
  abs?: string
  rel?: string
}

/** The absolute + workspace-relative forms a markdown `src` could resolve to. */
function srcForms(src: string, workspacePath?: string): PathForms {
  const decoded = decodeFileUrl(src.trim())
  if (!decoded || decoded.includes('\0')) return {}
  const ws = workspacePath ? posixNormalize(workspacePath) : ''
  if (isAbsolutePath(decoded)) {
    const abs = posixNormalize(decoded)
    const rel = ws && abs.startsWith(`${ws}/`) ? abs.slice(ws.length + 1) : undefined
    return { abs, ...(rel ? { rel } : {}) }
  }
  const rel = posixNormalize(decoded)
  const abs = ws ? posixNormalize(`${ws}/${decoded}`) : undefined
  return { ...(abs ? { abs } : {}), ...(rel ? { rel } : {}) }
}

/** The absolute + workspace-relative forms a stored ref resolves to. */
function refForms(ref: ChatMediaRef, workspacePath?: string): PathForms {
  const ws = workspacePath ? posixNormalize(workspacePath) : ''
  const abs = ref.path && isAbsolutePath(ref.path) ? posixNormalize(ref.path) : undefined
  let rel: string | undefined
  if (ref.workspaceRelativePath) rel = posixNormalize(ref.workspaceRelativePath)
  else if (abs && ws && abs.startsWith(`${ws}/`)) rel = abs.slice(ws.length + 1)
  return { ...(abs ? { abs } : {}), ...(rel ? { rel } : {}) }
}

/**
 * Resolve a markdown image `src` to the message media ref it denotes, by
 * absolute or workspace-relative path equality. Returns `undefined` when the
 * src is remote / non-local, or no image ref with a filesystem path matches.
 */
export function resolveMarkdownImageRef(
  src: string,
  refs: readonly ChatMediaRef[] | undefined,
  workspacePath?: string
): ChatMediaRef | undefined {
  if (!src || !refs || refs.length === 0) return undefined
  if (NON_LOCAL_SCHEME.test(src.trim())) return undefined
  const want = srcForms(src, workspacePath)
  if (!want.abs && !want.rel) return undefined
  for (const ref of refs) {
    if (ref.kind !== 'image' || !ref.path) continue
    const have = refForms(ref, workspacePath)
    if (want.abs && have.abs && want.abs === have.abs) return ref
    if (want.rel && have.rel && want.rel === have.rel) return ref
  }
  return undefined
}

/**
 * The ONLY src ever handed to an inline `<img>`: a `data:` URL built from the
 * ref's bounded thumbnail. Returns '' when the ref has no raster data thumbnail
 * (e.g. an SVG, an over-size image, or a path-only upload) so the caller falls
 * back to the inert placeholder. Never returns `ref.path` or any remote URL.
 */
export function inlineMarkdownImageThumbnail(ref: ChatMediaRef): string {
  const thumbnail = ref.thumbnail
  if (thumbnail?.dataBase64 && /^image\/(png|jpe?g|webp)$/i.test(thumbnail.mimeType || '')) {
    return `data:${thumbnail.mimeType};base64,${thumbnail.dataBase64}`
  }
  return ''
}

/**
 * Statuses that mean "do not display": the main process flagged the source as
 * missing, blocked, oversize, or an unsafe SVG. These never carry a thumbnail in
 * practice, but the check is belt-and-braces. A `'available'` or absent status
 * (legacy uploads predate the field) is displayable as long as a data thumbnail
 * exists — which is the user's primary case (their own attached image inline).
 */
const NON_DISPLAYABLE_STATUSES = new Set([
  'missing',
  'denied',
  'unsafe_svg',
  'too_large',
  'unsupported'
])

/**
 * Combined resolve + render gate. Returns the ref and its safe `data:` thumbnail
 * only when the markdown src maps to a displayable image ref that carries a
 * raster data thumbnail; otherwise `null` (→ inert placeholder). This is the
 * single entry point the renderer uses, so the H4 invariant is enforced in one
 * place: the only thing returned is a `data:` URL, never the raw markdown src.
 */
export function resolveInlineMarkdownImage(
  src: string,
  refs: readonly ChatMediaRef[] | undefined,
  workspacePath?: string
): { ref: ChatMediaRef; thumbnail: string } | null {
  const ref = resolveMarkdownImageRef(src, refs, workspacePath)
  if (!ref) return null
  if (ref.status && NON_DISPLAYABLE_STATUSES.has(ref.status)) return null
  const thumbnail = inlineMarkdownImageThumbnail(ref)
  if (!thumbnail.startsWith('data:')) return null
  return { ref, thumbnail }
}

/** Blank fenced + inline code so a `![](x)` shown as literal code (not an image)
 *  isn't counted as rendered inline. Mirrors the persist-time extractor. */
function blankMarkdownCode(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '')
}

// CommonMark image: `![label](<dest>|bare-dest "optional title")`.
const MARKDOWN_IMAGE_RE =
  /!\[(?:[^\]\\\n]|\\.){0,240}\]\(\s*(<[^>\n]*>|[^\s)]{1,2048})(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g

/**
 * The ids of the refs that the markdown body renders INLINE — i.e. those a
 * `![](src)` in `content` resolves to via `resolveInlineMarkdownImage`. Lets the
 * attachment strip drop refs already shown inline so an embedded image isn't
 * displayed twice. Code-fenced `![]()` (rendered as literal code) is excluded,
 * matching the persist-time ref extractor that blanks code ranges.
 */
export function collectInlineImageRefIds(
  content: string | undefined,
  refs: readonly ChatMediaRef[] | undefined,
  workspacePath?: string
): Set<string> {
  const ids = new Set<string>()
  if (!content || !content.includes('![') || !refs || refs.length === 0) return ids
  const scan = blankMarkdownCode(content)
  MARKDOWN_IMAGE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MARKDOWN_IMAGE_RE.exec(scan)) !== null) {
    let dest = match[1]
    if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1)
    const resolved = resolveInlineMarkdownImage(dest, refs, workspacePath)
    if (resolved) ids.add(resolved.ref.id)
  }
  return ids
}
