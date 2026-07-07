import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { extractToolFileContributions } from './LiveFileDiffSummary'
import { isErroredToolStatus } from './ToolParser'

/**
 * Tool-edit diff snapshots for the "Task complete" file-change hover previews.
 *
 * The exact run diff only carries per-file `diffText` when the workspace is a
 * git repo AND the change still existed when the post-run snapshot diff ran.
 * Live tool-derived summaries never carry hunks at all. This module rebuilds a
 * Codex/Claude-style "what did the agent actually send" snapshot for one file
 * from the run's write-tool activities (Edit old/new strings, MultiEdit
 * edits[], Write content, apply_patch / unified-diff payloads) so the hover
 * bubble can show real hunks instead of "No inline diff captured".
 *
 * Output is unified-diff-shaped text for `parseUnifiedDiff`: `@@ … @@` section
 * headers (freeform header text renders with blank gutters) plus +/- lines.
 */

const SNAPSHOT_TOTAL_LINE_LIMIT = 400
const SNAPSHOT_SECTION_LINE_LIMIT = 160
const SNAPSHOT_TOTAL_CHAR_LIMIT = 60_000
const SNAPSHOT_LINE_CHAR_LIMIT = 500

const PATCH_PARAM_KEYS = [
  'patchPreview',
  'patch_preview',
  'patch',
  'diff',
  'unifiedDiff',
  'unified_diff'
]

const PATH_PARAM_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target',
  'target_file',
  'target_file_path'
]

interface SnapshotSection {
  lines: string[]
}

function normalisePath(value: string, workspacePath?: string | null): string {
  const normalised = value.replace(/\\/g, '/')
  const workspace = (workspacePath || '').replace(/\\/g, '/')
  if (!workspace) return normalised
  const ws = workspace.endsWith('/') ? workspace : `${workspace}/`
  return normalised.startsWith(ws) ? normalised.slice(ws.length) : normalised
}

/** Suffix match on `/` boundaries so repo-relative, workspace-relative and
 * absolute spellings of the same file all correlate. */
function pathsReferToSameFile(left: string, right: string): boolean {
  const a = left.replace(/\\/g, '/').replace(/^\.\/+/, '')
  const b = right.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!a || !b) return false
  if (a === b) return true
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  return longer.endsWith(`/${shorter}`)
}

function clampLine(line: string): string {
  return line.length > SNAPSHOT_LINE_CHAR_LIMIT
    ? `${line.slice(0, SNAPSHOT_LINE_CHAR_LIMIT)}…`
    : line
}

function splitContentLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function editVerbForToolName(toolName: string): string {
  const name = (toolName || '').toLowerCase()
  const unqualified = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name
  if (unqualified.includes('patch')) return 'Patch'
  if (unqualified.startsWith('create')) return 'Write (new file)'
  if (unqualified.startsWith('write')) return 'Write'
  if (unqualified.startsWith('delete')) return 'Delete'
  if (unqualified.includes('multiedit')) return 'Edit'
  return 'Edit'
}

function sectionFromReplacement(
  verb: string,
  oldString: string,
  newString: string,
  ordinal?: string
): SnapshotSection | null {
  const removed = oldString ? splitContentLines(oldString) : []
  const added = newString ? splitContentLines(newString) : []
  if (removed.length === 0 && added.length === 0) return null
  const label = ordinal ? `${verb} ${ordinal}` : verb
  const lines = [`@@ ${label} — -${removed.length} +${added.length} @@`]
  for (const line of removed) lines.push(`-${clampLine(line)}`)
  for (const line of added) lines.push(`+${clampLine(line)}`)
  return { lines: boundSectionLines(lines) }
}

function sectionFromContent(verb: string, content: string): SnapshotSection | null {
  const added = splitContentLines(content)
  if (added.length === 0) return null
  const lines = [`@@ ${verb} — file content (${added.length} lines) @@`]
  for (const line of added) lines.push(`+${clampLine(line)}`)
  return { lines: boundSectionLines(lines) }
}

function boundSectionLines(lines: string[]): string[] {
  if (lines.length <= SNAPSHOT_SECTION_LINE_LIMIT) return lines
  const kept = lines.slice(0, SNAPSHOT_SECTION_LINE_LIMIT)
  kept.push(`@@ … ${lines.length - SNAPSHOT_SECTION_LINE_LIMIT} more lines in this edit @@`)
  return kept
}

function readStringParam(parameters: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/** Extract the chunk of a (possibly multi-file) patch that touches `path`.
 * Handles `diff --git` git patches, Codex `*** Update File:` envelopes and
 * bare single-file `---`/`+++` diffs. Headerless hunk text (`@@`/+/- with no
 * file header at all) carries no path evidence of its own, so it is only
 * accepted when the caller vouches for the activity via `allowHeaderless`. */
export function extractFilePatchChunk(
  patchText: string,
  path: string,
  options: { allowHeaderless?: boolean } = {}
): string | null {
  const text = patchText.replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  const gitBoundaries: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('diff --git ')) gitBoundaries.push(index)
  }
  if (gitBoundaries.length > 0) {
    for (let chunk = 0; chunk < gitBoundaries.length; chunk += 1) {
      const start = gitBoundaries[chunk]
      const end = chunk + 1 < gitBoundaries.length ? gitBoundaries[chunk + 1] : lines.length
      const header = lines[start].match(/^diff --git a\/(.+?) b\/(.+)$/)
      const headerPath = header ? header[2] || header[1] : ''
      const plusLine = lines
        .slice(start, end)
        .find((line) => line.startsWith('+++ '))
        ?.replace(/^\+\+\+ (b\/)?/, '')
      const candidate = headerPath || plusLine || ''
      if (candidate && pathsReferToSameFile(candidate, path)) {
        return lines.slice(start, end).join('\n').trimEnd()
      }
    }
    return null
  }

  const envelopeMarker = /^\*\*\* (Update|Add|Delete) File: (.+)$/
  const envelopeBoundaries: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (envelopeMarker.test(lines[index])) envelopeBoundaries.push(index)
  }
  if (envelopeBoundaries.length > 0) {
    for (let chunk = 0; chunk < envelopeBoundaries.length; chunk += 1) {
      const start = envelopeBoundaries[chunk]
      const end =
        chunk + 1 < envelopeBoundaries.length ? envelopeBoundaries[chunk + 1] : lines.length
      const match = lines[start].match(envelopeMarker)
      if (!match || !pathsReferToSameFile(match[2].trim(), path)) continue
      const body = lines
        .slice(start + 1, end)
        .filter((line) => !line.startsWith('*** '))
        .join('\n')
        .trimEnd()
      return [`@@ ${match[1]} File: ${match[2].trim()} @@`, body].filter(Boolean).join('\n')
    }
    return null
  }

  // Bare diff: accept when its own file header names the target.
  const plusHeader = lines.find((line) => line.startsWith('+++ '))
  const minusHeader = lines.find((line) => line.startsWith('--- '))
  const headerPath =
    plusHeader?.replace(/^\+\+\+ (b\/)?/, '').trim() ||
    minusHeader?.replace(/^--- (a\/)?/, '').trim()
  if (headerPath && headerPath !== '/dev/null') {
    return pathsReferToSameFile(headerPath, path) ? text.trimEnd() : null
  }
  if (!options.allowHeaderless) return null
  return /^@@/m.test(text) ? text.trimEnd() : null
}

function sectionFromPatch(
  verb: string,
  patchText: string,
  path: string,
  options: { allowHeaderless?: boolean } = {}
): SnapshotSection | null {
  const chunk = extractFilePatchChunk(patchText, path, options)
  if (!chunk || !chunk.trim()) return null
  const chunkLines = chunk.split('\n').map(clampLine)
  const lines = chunkLines[0]?.startsWith('@@') ? chunkLines : [`@@ ${verb} @@`, ...chunkLines]
  return { lines: boundSectionLines(lines) }
}

function activityTouchesPath(
  activity: ToolActivity,
  path: string,
  workspacePath?: string | null
): boolean {
  return extractToolFileContributions(activity, workspacePath).some((contribution) =>
    pathsReferToSameFile(contribution.path, path)
  )
}

export function buildActivityEditSnapshotSection(
  activity: ToolActivity,
  path: string,
  workspacePath?: string | null
): SnapshotSection | null {
  const parameters = activity.parameters || {}
  const verb = editVerbForToolName(activity.toolName || '')

  // Path evidence, strongest first: an explicit path param naming the file, a
  // patch chunk whose own file headers name it, or (for payloads with no path
  // of their own) the stats extractor attributing the activity to it.
  const paramPath = readStringParam(parameters, PATH_PARAM_KEYS) || activity.filePath || ''
  const explicitParamMatch = paramPath
    ? pathsReferToSameFile(normalisePath(paramPath.trim(), workspacePath), path)
    : null
  let contributionMatch: boolean | null = null
  const touchesPath = (): boolean => {
    if (explicitParamMatch !== null) return explicitParamMatch
    if (contributionMatch === null) {
      contributionMatch = activityTouchesPath(activity, path, workspacePath)
    }
    return contributionMatch
  }

  const patchText =
    readStringParam(parameters, PATCH_PARAM_KEYS) ||
    (() => {
      const resultText = activity.resultSummary || activity.outputPreview || ''
      return /^(?:diff --git|@@\s|\*\*\* (?:Begin Patch|Update File|Add File)|---\s|\+\+\+\s)/m.test(
        resultText
      )
        ? resultText
        : ''
    })()
  if (patchText) {
    const section = sectionFromPatch(verb, patchText, path, {
      allowHeaderless: touchesPath()
    })
    if (section) return section
  }

  const paramPathMatches = explicitParamMatch !== false && touchesPath()

  const edits = parameters.edits
  if (Array.isArray(edits) && edits.length > 0 && paramPathMatches) {
    const editSections: SnapshotSection[] = []
    for (let index = 0; index < edits.length; index += 1) {
      const edit = edits[index]
      if (!edit || typeof edit !== 'object') continue
      const record = edit as Record<string, unknown>
      const oldString =
        typeof record.old_string === 'string'
          ? record.old_string
          : typeof record.oldString === 'string'
            ? record.oldString
            : ''
      const newString =
        typeof record.new_string === 'string'
          ? record.new_string
          : typeof record.newString === 'string'
            ? record.newString
            : ''
      const section = sectionFromReplacement(
        verb,
        oldString,
        newString,
        edits.length > 1 ? `${index + 1}/${edits.length}` : undefined
      )
      if (section) editSections.push(section)
    }
    if (editSections.length > 0) {
      return { lines: editSections.flatMap((section) => section.lines) }
    }
  }

  const oldString = typeof parameters.old_string === 'string' ? parameters.old_string : ''
  const newString = typeof parameters.new_string === 'string' ? parameters.new_string : ''
  if ((oldString || newString) && paramPathMatches) {
    return sectionFromReplacement(verb, oldString, newString)
  }

  const content = typeof parameters.content === 'string' ? parameters.content : ''
  if (content && paramPathMatches) {
    return sectionFromContent(verb, content)
  }

  if (verb === 'Delete' && paramPathMatches) {
    return { lines: [`@@ ${verb} — file deleted @@`] }
  }

  return null
}

/**
 * Aggregate a hover-preview diff snapshot for `path` from every non-errored
 * write-tool activity in the transcript that touched it, chronologically.
 * Returns null when no activity provides usable edit content. On overflow the
 * LATEST edits win and a leading header reports how many were omitted.
 */
export function buildToolEditDiffSnapshotForPath(
  messages: ChatMessage[] | undefined,
  path: string,
  workspacePath?: string | null
): string | null {
  if (!messages || messages.length === 0 || !path) return null

  const sections: SnapshotSection[] = []
  for (const message of messages) {
    const activities = message?.toolActivities
    if (!activities) continue
    for (const activity of activities) {
      if (!activity || isErroredToolStatus(activity.status)) continue
      const section = buildActivityEditSnapshotSection(activity, path, workspacePath)
      if (section && section.lines.length > 0) sections.push(section)
    }
  }
  if (sections.length === 0) return null

  const kept: SnapshotSection[] = []
  let lineBudget = SNAPSHOT_TOTAL_LINE_LIMIT
  let charBudget = SNAPSHOT_TOTAL_CHAR_LIMIT
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index]
    const sectionChars = section.lines.reduce((total, line) => total + line.length + 1, 0)
    if (kept.length > 0 && (section.lines.length > lineBudget || sectionChars > charBudget)) {
      break
    }
    kept.unshift(section)
    lineBudget -= section.lines.length
    charBudget -= sectionChars
    if (lineBudget <= 0 || charBudget <= 0) break
  }

  const omitted = sections.length - kept.length
  const lines = kept.flatMap((section) => section.lines)
  if (omitted > 0) {
    lines.unshift(`@@ ${omitted} earlier edit${omitted === 1 ? '' : 's'} not shown @@`)
  }
  return lines.join('\n')
}
