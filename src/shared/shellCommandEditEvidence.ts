import type { ToolDiffFileSummary, ToolDiffSummary } from '../main/store/types'

/*
 * Edit evidence extracted from a SHELL COMMAND STRING — the honest basis for
 * +N/−M chips on `run_shell_command` rows.
 *
 * Some hosted model families (pi-routed Xiaomi/MiMo, and any other shell-only
 * model) never call the dedicated file tools (`replace`, `write_file`,
 * `apply_patch`); every edit is a heredoc write, an inline patch, or a
 * redirect through the managed shell. Those rows carried no diff odometer
 * because estimation is deliberately gated to edit-like calls — a shell
 * RESULT containing `diff --git` markers (a `git diff` run) must never mint a
 * chip (the phantom-badge class fixed in a90fd39c8).
 *
 * This module therefore reads ONLY the command text, never tool output:
 * a `cat > file <<EOF` heredoc carries the exact content the call writes, and
 * a `git apply <<EOF` heredoc carries the exact patch it applies. Everything
 * derived here is an ESTIMATE of intent (the command may still fail — errored
 * rows are suppressed by the renderer) and is marked `estimated` so the `~`
 * indicator renders. A measured `git_numstat` summary always outranks it via
 * `toolDiffSummaryMerge`.
 */

/** A write whose content the command itself carries or names. `lines` is
 * undefined for real-but-unmeasurable writes (a generic `cmd > file`
 * redirect), which contribute a file entry but never counts. */
export interface ShellContentWriteEvidence {
  kind: 'content'
  path?: string
  lines?: number
  append: boolean
}

/** A patch applier invocation whose heredoc body is the patch text. The body
 * is structurally unvalidated here; callers parse it with their lane's diff
 * parser and drop it when it is not actually a diff. */
export interface ShellPatchApplyEvidence {
  kind: 'patch'
  body: string
}

/** An in-place editor (`sed -i`, `perl -i`) — names its targets, counts
 * nothing. */
export interface ShellInPlaceEditEvidence {
  kind: 'inplace'
  paths: string[]
}

export type ShellWriteEvidence =
  | ShellContentWriteEvidence
  | ShellPatchApplyEvidence
  | ShellInPlaceEditEvidence

/** The shell-command string from a `run_shell_command`-shaped tool input. */
export function shellCommandTextFromInput(input: Record<string, unknown>): string {
  const candidates = [input.command, input.cmd, input.script]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (Array.isArray(candidate) && candidate.length > 0) {
      const joined = candidate.filter((part): part is string => typeof part === 'string').join(' ')
      if (joined.trim()) return joined
    }
  }
  return ''
}

function countBodyLines(body: string): number {
  return body.length ? body.split('\n').length : 0
}

/** Line estimate for inline text (`echo`/`printf` arguments, herestrings):
 * each `\n` escape or literal newline starts another line. */
function estimateInlineLines(text: string): number {
  const matches = text.match(/\\n|\n/g)
  return Math.max(1, matches ? matches.length : 0)
}

/** Split on unquoted `&&`, `||`, `;`, `|`, and newlines. */
function splitCommandSegments(text: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      current += char
      if (char === quote && text[index - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if ((char === '&' && text[index + 1] === '&') || (char === '|' && text[index + 1] === '|')) {
      segments.push(current)
      current = ''
      index++
      continue
    }
    if (char === '|') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

/** Recognise a patch-applying COMMAND, not a command that merely mentions one
 * (`rg apply_patch` is a search). Mirrors CodexEventFormatting's boundary. */
function invokesPatchApplier(context: string): boolean {
  return (
    /(?:^|(?:&&|\|\||[;|])\s*)(?:apply_patch|applypatch)(?:\s|$)/i.test(context.trim()) ||
    /\bgit\s+apply(?:\s|$)/i.test(context) ||
    /(?:^|(?:&&|\|\||[;|])\s*)patch\s+-/i.test(context.trim())
  )
}

function unquotePath(raw: string): string {
  const trimmed = raw.trim()
  const quoted = trimmed.match(/^"([^"]*)"$|^'([^']*)'$/)
  return quoted ? (quoted[1] ?? quoted[2] ?? '') : trimmed
}

function isWritablePathTarget(path: string): boolean {
  if (!path || path === '-') return false
  if (path.startsWith('/dev/')) return false
  if (path.startsWith('&')) return false
  return true
}

/** Find a bare `>`/`>>` redirect target. Fd-prefixed (`2>`) and `&>` forms are
 * diagnostics plumbing, not edits, and are deliberately not matched. */
function findRedirectTarget(context: string): { path: string; append: boolean } | null {
  const match = context.match(/(?:^|[^<>\d&])(>{1,2})\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/)
  if (!match) return null
  const path = unquotePath(match[2])
  if (!isWritablePathTarget(path)) return null
  return { path, append: match[1] === '>>' }
}

function findTeeTarget(context: string): { path: string; append: boolean } | null {
  const match = context.match(/\btee\s+((?:-\w+\s+)*)("[^"]*"|'[^']*'|[^\s;&|<>]+)/)
  if (!match) return null
  const path = unquotePath(match[2])
  if (!isWritablePathTarget(path) || path.startsWith('-')) return null
  return { path, append: /(?:^|\s)-\w*a\w*(?:\s|$)/.test(match[1] || '') }
}

const HEREDOC_START = /<<(-?)\s*(?!<)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g

interface ExtractedHeredoc {
  context: string
  body: string
}

/** Pull heredocs out of the command: each yields its OWN context (the command
 * clause the operator belongs to) and its body. Body lines are consumed so
 * decoy commands inside written content are never scanned as evidence, and the
 * owning clause is consumed so the remainder never double-reports its
 * redirect. Everything else is returned for plain-segment scanning. */
function extractHeredocs(command: string): {
  heredocs: ExtractedHeredoc[]
  remainder: string[]
} {
  const heredocs: ExtractedHeredoc[] = []
  const remainder: string[] = []
  const lines = command.split('\n')
  let lineIndex = 0
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]
    HEREDOC_START.lastIndex = 0
    const matches = [...line.matchAll(HEREDOC_START)]
    if (matches.length === 0) {
      remainder.push(line)
      lineIndex++
      continue
    }
    // Clauses before the one owning the first heredoc stay plain segments.
    const firstMatch = matches[0]
    const before = line.slice(0, firstMatch.index)
    const beforeSegments = splitCommandSegments(before)
    const owningClause = beforeSegments.pop() || ''
    remainder.push(...beforeSegments)
    // Per-operator context: the owning clause plus the line tail, so a
    // trailing `> out.txt` after the operator is still seen.
    const tail = line.slice((firstMatch.index ?? 0) + firstMatch[0].length)
    const contexts = matches.map((_match, matchIndex) =>
      matchIndex === 0 ? `${owningClause} ${tail}`.trim() : line.trim()
    )
    // Consume bodies in operator order.
    let bodyLine = lineIndex + 1
    for (let matchIndex = 0; matchIndex < matches.length; matchIndex++) {
      const delimiter = matches[matchIndex][3]
      const bodyLines: string[] = []
      while (bodyLine < lines.length && lines[bodyLine].trim() !== delimiter) {
        bodyLines.push(lines[bodyLine])
        bodyLine++
      }
      if (bodyLine < lines.length) bodyLine++
      heredocs.push({ context: contexts[matchIndex], body: bodyLines.join('\n') })
    }
    lineIndex = bodyLine
  }
  return { heredocs, remainder }
}

function classifyHeredoc(entry: ExtractedHeredoc): ShellWriteEvidence | null {
  if (invokesPatchApplier(entry.context)) {
    return { kind: 'patch', body: entry.body }
  }
  const target = findRedirectTarget(entry.context) || findTeeTarget(entry.context)
  if (target) {
    return {
      kind: 'content',
      path: target.path,
      lines: countBodyLines(entry.body),
      append: target.append
    }
  }
  return null
}

function stripLeadingAssignments(segment: string): string {
  let rest = segment
  for (;;) {
    const next = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/)
    if (!next) return rest
    rest = rest.slice(next[0].length)
  }
}

function inPlaceEditPaths(segment: string): string[] | null {
  const sedInPlace =
    /(?:^|\s)sed(?:\s|$)/.test(segment) && /\s(?:-\w*i\w*|--in-place)(?:\s|$|=)/.test(segment)
  const perlInPlace = /(?:^|\s)perl(?:\s|$)/.test(segment) && /\s-\w*i\w*(?:\s|$)/.test(segment)
  if (!sedInPlace && !perlInPlace) return null
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) || []
  const paths: string[] = []
  for (let index = tokens.length - 1; index > 0; index--) {
    const token = unquotePath(tokens[index])
    if (!token || token.startsWith('-')) break
    // The walk stops at the sed/perl script argument (`s/a/b/g`, `y|…|…|`),
    // which bounds the trailing run of file arguments.
    if (/^[sy][/,#|]/.test(token)) break
    paths.unshift(token)
  }
  return paths
}

function classifySegment(rawSegment: string): ShellWriteEvidence | null {
  const segment = stripLeadingAssignments(rawSegment.trim())
  if (!segment) return null
  const inPlace = inPlaceEditPaths(segment)
  if (inPlace) return inPlace.length ? { kind: 'inplace', paths: inPlace } : null
  const target = findRedirectTarget(segment)
  if (!target) return null
  const leadingWord = segment.match(/^(\S+)/)?.[1] || ''
  if (leadingWord === 'echo' || leadingWord === 'printf') {
    const inline = segment.replace(/(?:^|[^<>\d&])>{1,2}\s*(?:"[^"]*"|'[^']*'|\S+)/, ' ')
    const args = inline.slice(inline.indexOf(leadingWord) + leadingWord.length)
    return {
      kind: 'content',
      path: target.path,
      lines: estimateInlineLines(args),
      append: target.append
    }
  }
  const herestring = segment.match(/<<<\s*("[^"]*"|'[^']*'|\S+)/)
  if (herestring) {
    return {
      kind: 'content',
      path: target.path,
      lines: estimateInlineLines(unquotePath(herestring[1])),
      append: target.append
    }
  }
  return { kind: 'content', path: target.path, lines: undefined, append: target.append }
}

/** Every file-write the command itself gives evidence for, in command order. */
export function collectShellWriteEvidence(command: string): ShellWriteEvidence[] {
  if (!command.trim()) return []
  const evidence: ShellWriteEvidence[] = []
  const { heredocs, remainder } = extractHeredocs(command)
  for (const entry of heredocs) {
    const classified = classifyHeredoc(entry)
    if (classified) evidence.push(classified)
  }
  for (const line of remainder) {
    for (const segment of splitCommandSegments(line)) {
      const classified = classifySegment(segment)
      if (classified) evidence.push(classified)
    }
  }
  return evidence
}

/**
 * Compose the evidence into one estimated `ToolDiffSummary`, or undefined when
 * nothing countable was found — an uncounted redirect or in-place edit alone
 * never mints a chip. `parsePatchBody` is the caller's lane-local diff parser
 * (renderer `parseUnifiedDiffSummary`, bridge `bridgeUnifiedDiffStats`), so
 * this module stays dependency-free and both lanes keep their exact patch
 * semantics.
 */
export function shellWriteEvidenceDiffSummary(
  command: string,
  parsePatchBody: (body: string) => ToolDiffSummary | undefined
): ToolDiffSummary | undefined {
  const evidence = collectShellWriteEvidence(command)
  if (evidence.length === 0) return undefined
  let additions = 0
  let deletions = 0
  let counted = false
  let sawPatch = false
  const files: ToolDiffFileSummary[] = []
  for (const item of evidence) {
    if (item.kind === 'patch') {
      const parsed = item.body.trim() ? parsePatchBody(item.body) : undefined
      // A body that is not structurally a diff parses to nothing (or to
      // ±0/0, which is file content riding a patch field, not a patch).
      if (!parsed || ((parsed.additions || 0) === 0 && (parsed.deletions || 0) === 0)) continue
      counted = true
      sawPatch = true
      additions += parsed.additions || 0
      deletions += parsed.deletions || 0
      files.push(...(parsed.files || []))
      continue
    }
    if (item.kind === 'content') {
      if (typeof item.lines === 'number') {
        counted = true
        additions += item.lines
        files.push({
          path: item.path,
          status: 'modified',
          additions: item.lines,
          deletions: 0
        })
      } else {
        files.push({ path: item.path, status: 'modified' })
      }
      continue
    }
    for (const path of item.paths) {
      files.push({ path, status: 'modified' })
    }
  }
  if (!counted) return undefined
  return {
    additions,
    deletions,
    files: files.filter((file) => file.path || file.additions || file.deletions),
    source: sawPatch ? 'patch_preview' : 'content',
    confidence: 'estimated'
  }
}
