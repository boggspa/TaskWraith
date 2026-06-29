import { spawn, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import type {
  DiffFileSummary,
  DiffFileStatus,
  DiffPreviewKind,
  WorkspaceSnapshot,
  RunDiffResult,
  FileSnapshot
} from './store/types'

const NOISE_PATHS = ['.DS_Store', 'Thumbs.db', 'node_modules', 'dist', 'build', '.vite']
const SENSITIVE_PATTERNS = [/\.env$/i, /\.pem$/i, /\.key$/i, /secret/i, /password/i, /token/i]
const MAX_PREVIEW_SIZE = 1024 * 100 // 100KB
const MAX_GIT_DIFF_PREVIEW_BYTES = 256 * 1024
const MAX_GIT_DIFF_PREVIEW_LINES = 5000
const MAX_GIT_DIFF_PREVIEW_LINE_CHARS = 1200
const GIT_DIFF_PREVIEW_MAX_BUFFER = MAX_GIT_DIFF_PREVIEW_BYTES + 64 * 1024

function isNoiseFile(filePath: string): boolean {
  const basename = path.basename(filePath)
  return NOISE_PATHS.some((n) => basename === n || filePath.includes(`/${n}/`))
}

function isSensitiveFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return SENSITIVE_PATTERNS.some((p) => p.test(lower))
}

function isBinaryFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath)
    for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return true
  }
}

function isPathInside(basePath: string, candidatePath: string): boolean {
  const rel = path.relative(basePath, candidatePath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveWorkspacePath(workspace: string, filePath: string): string | null {
  const workspaceRoot = path.resolve(workspace)
  const resolved = path.resolve(workspaceRoot, filePath)
  if (!isPathInside(workspaceRoot, resolved)) return null
  if (!fs.existsSync(resolved)) return resolved
  try {
    const realWorkspace = fs.realpathSync.native(workspaceRoot)
    const realFile = fs.realpathSync.native(resolved)
    if (!isPathInside(realWorkspace, realFile)) return null
  } catch {
    return null
  }
  return resolved
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

async function spawnGit(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, shell: false })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? 0 })
    })
    proc.on('error', (err) => {
      resolve({ stdout, stderr: err.message, code: -1 })
    })
  })
}

function spawnGitSync(
  cwd: string,
  args: string[],
  options: { maxBuffer?: number } = {}
): { stdout: string; stderr: string; code: number; truncated?: boolean } {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf-8',
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {})
  })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status ?? 0,
    truncated:
      Boolean(result.error && 'code' in result.error && result.error.code === 'ENOBUFS') ||
      (options.maxBuffer !== undefined && (result.stdout || '').length >= options.maxBuffer)
  }
}

async function resolveGitWorkspaceScope(
  workspace: string
): Promise<{ workspaceRoot: string; repoRoot: string; workspacePrefix: string } | null> {
  const workspaceRoot = fs.realpathSync.native(path.resolve(workspace))
  const repoResult = await spawnGit(workspaceRoot, ['rev-parse', '--show-toplevel'])
  if (repoResult.code !== 0) return null
  const repoRoot = fs.realpathSync.native(path.resolve(repoResult.stdout.trim()))
  const relativePrefix = path.relative(repoRoot, workspaceRoot)
  if (
    relativePrefix === '..' ||
    relativePrefix.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePrefix)
  ) {
    return null
  }
  return {
    workspaceRoot,
    repoRoot,
    workspacePrefix: relativePrefix ? toGitPath(relativePrefix) : ''
  }
}

function workspacePathspec(workspacePrefix: string): string[] {
  return workspacePrefix ? ['--', workspacePrefix] : []
}

function repoPathToWorkspacePath(repoPath: string, workspacePrefix: string): string | null {
  if (!workspacePrefix) return repoPath
  if (repoPath === workspacePrefix) return ''
  const prefix = `${workspacePrefix}/`
  if (!repoPath.startsWith(prefix)) return null
  return repoPath.slice(prefix.length)
}

function countDiffLines(diffText: string): { additions?: number; deletions?: number } {
  if (!diffText.trim()) return {}
  let additions = 0
  let deletions = 0
  let index = 0
  while (index <= diffText.length) {
    const nextBreak = diffText.indexOf('\n', index)
    const lineEnd = nextBreak === -1 ? diffText.length : nextBreak
    const line = diffText.slice(index, lineEnd)
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
    if (nextBreak === -1) break
    index = nextBreak + 1
  }
  return { additions, deletions }
}

function parseNumstat(stdout: string): { additions?: number; deletions?: number } {
  let additions = 0
  let deletions = 0
  let sawTextStats = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [rawAdditions, rawDeletions] = line.split(/\s+/, 2)
    const nextAdditions = Number(rawAdditions)
    const nextDeletions = Number(rawDeletions)
    if (!Number.isFinite(nextAdditions) || !Number.isFinite(nextDeletions)) continue
    additions += nextAdditions
    deletions += nextDeletions
    sawTextStats = true
  }
  return sawTextStats ? { additions, deletions } : {}
}

function countGitFileDiffLines(
  gitCwd: string,
  gitPath: string
): { additions?: number; deletions?: number } {
  const unstaged = parseNumstat(
    spawnGitSync(gitCwd, ['diff', '--numstat', '--no-ext-diff', '--', gitPath]).stdout
  )
  const staged = parseNumstat(
    spawnGitSync(gitCwd, [
      'diff',
      '--cached',
      '--numstat',
      '--no-ext-diff',
      '--',
      gitPath
    ]).stdout
  )
  const additions =
    unstaged.additions !== undefined || staged.additions !== undefined
      ? (unstaged.additions ?? 0) + (staged.additions ?? 0)
      : undefined
  const deletions =
    unstaged.deletions !== undefined || staged.deletions !== undefined
      ? (unstaged.deletions ?? 0) + (staged.deletions ?? 0)
      : undefined
  return { additions, deletions }
}

function capDiffPreviewText(text: string): {
  text: string
  truncated: boolean
  omittedLines?: number
} {
  if (!text) return { text, truncated: false }
  const output: string[] = []
  let omittedLines = 0
  let truncated = false
  let usedBytes = 0
  let index = 0

  while (index <= text.length) {
    const nextBreak = text.indexOf('\n', index)
    const lineEnd = nextBreak === -1 ? text.length : nextBreak
    const rawLine = text.slice(index, lineEnd)
    const clippedLine =
      rawLine.length > MAX_GIT_DIFF_PREVIEW_LINE_CHARS
        ? rawLine.slice(0, MAX_GIT_DIFF_PREVIEW_LINE_CHARS)
        : rawLine
    if (clippedLine.length < rawLine.length) truncated = true
    const nextBytes = Buffer.byteLength(clippedLine, 'utf8') + 1
    if (
      output.length >= MAX_GIT_DIFF_PREVIEW_LINES ||
      usedBytes + nextBytes > MAX_GIT_DIFF_PREVIEW_BYTES
    ) {
      truncated = true
      omittedLines += 1
    } else {
      output.push(clippedLine)
      usedBytes += nextBytes
    }
    if (nextBreak === -1) break
    index = nextBreak + 1
  }

  if (omittedLines === 0) return { text: output.join('\n'), truncated }
  return { text: output.join('\n'), truncated, omittedLines }
}

function readGitDiffPreview(
  gitCwd: string,
  args: string[]
): { text: string; truncated: boolean; omittedLines?: number } {
  const result = spawnGitSync(gitCwd, args, { maxBuffer: GIT_DIFF_PREVIEW_MAX_BUFFER })
  const capped = capDiffPreviewText(result.stdout)
  return {
    text: capped.text,
    truncated: Boolean(result.truncated || capped.truncated),
    omittedLines: capped.omittedLines
  }
}

export function parseGitStatusZ(
  statusOutput: string
): Array<{ statusCode: string; filePath: string }> {
  const entries: Array<{ statusCode: string; filePath: string }> = []
  const parts = statusOutput.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry || entry.length < 3) {
      i++
      continue
    }
    const statusCode = entry.substring(0, 2)
    const filePath = entry.substring(3)
    // For renames, porcelain v1 -z emits the current path, then the original path.
    if (statusCode.startsWith('R') && i + 1 < parts.length) {
      i += 2
    } else {
      i++
    }
    entries.push({ statusCode: statusCode.trim(), filePath })
  }
  return entries
}

export function classifyStatus(statusCode: string): DiffFileStatus {
  if (statusCode === '??') return 'untracked'
  if (statusCode === '!!') return 'noise'
  if (statusCode === 'A') return 'created'
  if (statusCode === 'D') return 'deleted'
  if (statusCode.startsWith('R')) return 'renamed'
  if (statusCode.startsWith('M') || statusCode.endsWith('M')) return 'modified'
  return 'modified'
}

export function generateSyntheticNewFileDiff(filePath: string, content: string): string {
  const lines = content.split('\n')
  const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@`
  const body = lines.map((l) => '+' + l).join('\n')
  return header + '\n' + body
}

function buildCurrentFileSummary(
  workspace: string | undefined,
  repoRoot: string | undefined,
  repoPath: string,
  displayPath: string,
  status: DiffFileStatus
): DiffFileSummary {
  const baseSummary: DiffFileSummary = {
    path: displayPath,
    status,
    previewKind: 'none',
    isNoise: isNoiseFile(displayPath),
    isSensitive: isSensitiveFile(displayPath)
  }

  if (!workspace) {
    return baseSummary
  }

  const fullPath = resolveWorkspacePath(workspace, displayPath)
  if (!fullPath) {
    return baseSummary
  }

  const exists = fs.existsSync(fullPath)
  const sizeBytes = exists ? fs.statSync(fullPath).size : 0
  let previewKind: DiffPreviewKind = 'none'
  let diffText: string | undefined
  let diffTextTruncated: boolean | undefined
  let diffTextOmittedLines: number | undefined
  let diffTextOriginalBytes: number | undefined
  let isBinary = false
  let additions: number | undefined
  let deletions: number | undefined

  if (baseSummary.isSensitive) {
    previewKind = 'hidden'
  } else if (
    (status === 'created' || status === 'untracked') &&
    exists &&
    !fs.statSync(fullPath).isDirectory()
  ) {
    isBinary = isBinaryFile(fullPath)
    if (isBinary) {
      previewKind = 'binary'
    } else if (sizeBytes <= MAX_PREVIEW_SIZE) {
      const content = fs.readFileSync(fullPath, 'utf-8')
      diffText = generateSyntheticNewFileDiff(displayPath, content)
      previewKind = 'synthetic_new_file'
      additions = content.split('\n').length
      deletions = 0
    }
  } else if (status === 'modified' || status === 'deleted' || status === 'renamed') {
    const gitCwd = repoRoot || workspace
    const gitPath = repoRoot ? repoPath : displayPath
    const exactCounts = countGitFileDiffLines(gitCwd, gitPath)
    additions = exactCounts.additions
    deletions = exactCounts.deletions
    const unstagedDiff = readGitDiffPreview(gitCwd, [
      'diff',
      '--no-ext-diff',
      '--',
      gitPath
    ])
    const stagedDiff = readGitDiffPreview(gitCwd, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--',
      gitPath
    ])
    const currentDiff = [stagedDiff.text, unstagedDiff.text].filter((text) => text.trim()).join('\n')
    if (currentDiff.trim()) {
      if (/^Binary files /m.test(currentDiff) || /^GIT binary patch$/m.test(currentDiff)) {
        isBinary = true
        previewKind = 'binary'
      } else {
        diffText = currentDiff
        diffTextTruncated = Boolean(stagedDiff.truncated || unstagedDiff.truncated)
        diffTextOmittedLines = [stagedDiff.omittedLines, unstagedDiff.omittedLines].reduce(
          (sum: number, count) => sum + (count ?? 0),
          0
        )
        if (diffTextOmittedLines === 0) diffTextOmittedLines = undefined
        if (!diffTextTruncated) {
          diffTextOriginalBytes = Buffer.byteLength(currentDiff, 'utf8')
        }
        previewKind = 'git_diff'
        if (additions === undefined || deletions === undefined) {
          const counts = countDiffLines(currentDiff)
          additions = counts.additions
          deletions = counts.deletions
        }
      }
    }
  }

  return {
    ...baseSummary,
    additions,
    deletions,
    isBinary,
    previewKind,
    diffText,
    diffTextTruncated,
    diffTextOmittedLines,
    diffTextOriginalBytes,
    sizeBytes
  }
}

function buildRunFileSummary(
  workspace: string | undefined,
  filePath: string,
  status: DiffFileStatus
): DiffFileSummary {
  return buildCurrentFileSummary(workspace, workspace, filePath, filePath, status)
}

export async function getWorkspaceDiff(workspace: string): Promise<{
  type: string
  text?: string
  statusText?: string
  diffText?: string
  summaries?: DiffFileSummary[]
}> {
  const scope = await resolveGitWorkspaceScope(workspace)
  if (!scope) {
    return {
      type: 'not_repo',
      text: 'This folder is not a git repository. Run git init if you want diff tracking.'
    }
  }

  const pathspec = workspacePathspec(scope.workspacePrefix)
  const { stdout: statusOut, stderr: statusErr } = await spawnGit(scope.repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    ...pathspec
  ])
  if (statusErr.includes('not a git repository')) {
    return {
      type: 'not_repo',
      text: 'This folder is not a git repository. Run git init if you want diff tracking.'
    }
  }

  if (!statusOut.trim()) {
    return { type: 'no_changes', text: 'No changes were made.' }
  }

  const statusEntries = parseGitStatusZ(statusOut)

  const summaries = statusEntries.flatMap((entry) => {
    const displayPath = repoPathToWorkspacePath(entry.filePath, scope.workspacePrefix)
    if (!displayPath) return []
    return [
      buildCurrentFileSummary(
        scope.workspaceRoot,
        scope.repoRoot,
        entry.filePath,
        displayPath,
        classifyStatus(entry.statusCode)
      )
    ]
  })

  return {
    type: 'changes',
    statusText: statusOut,
    summaries
  }
}

export async function captureWorkspaceSnapshot(workspace: string): Promise<WorkspaceSnapshot> {
  const { stdout: statusOut, stderr: statusErr } = await spawnGit(workspace, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ])
  const isGitRepo = !statusErr.includes('not a git repository')

  if (isGitRepo) {
    return {
      capturedAt: new Date().toISOString(),
      isGitRepo: true,
      workspacePath: workspace,
      gitStatus: statusOut
    }
  }

  // Non-git: lightweight file tree snapshot
  const files: FileSnapshot[] = []
  function walk(dir: string, base: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (isNoiseFile(entry.name)) continue
      const rel = path.relative(workspace, path.join(dir, entry.name))
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), base)
      } else {
        const stat = fs.statSync(path.join(dir, entry.name))
        files.push({
          path: rel,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs
        })
      }
    }
  }
  try {
    walk(workspace, workspace)
  } catch {
    /* ignore */
  }

  return {
    capturedAt: new Date().toISOString(),
    isGitRepo: false,
    workspacePath: workspace,
    files
  }
}

// ── Bounded workspace diff (iOS Diff Studio) ─────────────────────────────────
// The `workspaceDiff` bridge action projects the same safe per-file previews
// desktop Diff Studio receives (`get-diff` IPC → getWorkspaceDiff), then applies
// tighter mobile caps so the ack stays inside the relay frame budget: ≤40 files,
// ≤200 hunk lines per file, line text clipped to 400 chars. Anything dropped is
// flagged with `truncated` (per file and on the total).

export const BOUNDED_DIFF_MAX_FILES = 40
export const BOUNDED_DIFF_MAX_LINES_PER_FILE = 200
export const BOUNDED_DIFF_MAX_LINE_CHARS = 400

export interface BoundedDiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

export interface BoundedDiffHunk {
  header: string
  lines: BoundedDiffLine[]
}

export interface BoundedDiffFile {
  path: string
  kind: 'created' | 'modified' | 'deleted'
  additions: number
  deletions: number
  hunks: BoundedDiffHunk[]
  truncated?: boolean
}

export interface BoundedWorkspaceDiff {
  files: BoundedDiffFile[]
  /** Non-noise changed files BEFORE the file cap — lets the phone render
   * "showing 40 of N". */
  totalFiles: number
  truncated: boolean
}

function boundedDiffKind(status: DiffFileStatus): BoundedDiffFile['kind'] {
  if (status === 'created' || status === 'untracked') return 'created'
  if (status === 'deleted') return 'deleted'
  return 'modified'
}

function isUnifiedDiffMetadataLine(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++ ') ||
    line.startsWith('--- ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('similarity index') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('Binary files') ||
    line.startsWith('\\ No newline')
  )
}

function boundDiffFile(summary: DiffFileSummary): BoundedDiffFile {
  const file: BoundedDiffFile = {
    path: summary.path,
    kind: boundedDiffKind(summary.status),
    additions: summary.additions ?? 0,
    deletions: summary.deletions ?? 0,
    hunks: []
  }
  // Sensitive previews stay hidden on the phone exactly as on the desktop;
  // binary files have no renderable hunks either way.
  if (!summary.diffText || summary.isBinary || summary.isSensitive) return file

  let usedLines = 0
  let oldCounter: number | undefined
  let newCounter: number | undefined
  let current: BoundedDiffHunk | null = null
  for (const rawLine of summary.diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('@@')) {
      if (usedLines >= BOUNDED_DIFF_MAX_LINES_PER_FILE) {
        file.truncated = true
        break
      }
      const header =
        rawLine.length > BOUNDED_DIFF_MAX_LINE_CHARS
          ? rawLine.slice(0, BOUNDED_DIFF_MAX_LINE_CHARS)
          : rawLine
      current = { header, lines: [] }
      file.hunks.push(current)
      const parsed = rawLine.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      oldCounter = parsed ? Number(parsed[1]) : undefined
      newCounter = parsed ? Number(parsed[2]) : undefined
      continue
    }
    if (!current || isUnifiedDiffMetadataLine(rawLine)) continue
    if (usedLines >= BOUNDED_DIFF_MAX_LINES_PER_FILE) {
      file.truncated = true
      break
    }
    const marker = rawLine[0]
    const body = rawLine.length > 0 ? rawLine.slice(1) : ''
    const text =
      body.length > BOUNDED_DIFF_MAX_LINE_CHARS ? body.slice(0, BOUNDED_DIFF_MAX_LINE_CHARS) : body
    if (body.length > BOUNDED_DIFF_MAX_LINE_CHARS) file.truncated = true
    const line: BoundedDiffLine = {
      type: marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx',
      text
    }
    if (line.type === 'add') {
      if (newCounter !== undefined && newCounter > 0) line.newLine = newCounter
      if (newCounter !== undefined) newCounter += 1
    } else if (line.type === 'del') {
      if (oldCounter !== undefined && oldCounter > 0) line.oldLine = oldCounter
      if (oldCounter !== undefined) oldCounter += 1
    } else {
      if (oldCounter !== undefined && oldCounter > 0) line.oldLine = oldCounter
      if (newCounter !== undefined && newCounter > 0) line.newLine = newCounter
      if (oldCounter !== undefined) oldCounter += 1
      if (newCounter !== undefined) newCounter += 1
    }
    current.lines.push(line)
    usedLines += 1
  }
  return file
}

/** Project `getWorkspaceDiff` summaries into the bounded shape the phone's
 * Diff Studio renders. Noise files are dropped (the desktop's "Hide noise"
 * default); sensitive and binary files keep their row but ship no hunks. */
export function buildBoundedWorkspaceDiff(summaries: DiffFileSummary[]): BoundedWorkspaceDiff {
  const eligible = summaries.filter((summary) => !summary.isNoise)
  const files = eligible.slice(0, BOUNDED_DIFF_MAX_FILES).map(boundDiffFile)
  return {
    files,
    totalFiles: eligible.length,
    truncated: eligible.length > BOUNDED_DIFF_MAX_FILES || files.some((file) => file.truncated)
  }
}

export function computeRunDiff(
  pre: WorkspaceSnapshot,
  post: WorkspaceSnapshot,
  runId: string
): RunDiffResult {
  const createdFiles: DiffFileSummary[] = []
  const modifiedFiles: DiffFileSummary[] = []
  const deletedFiles: DiffFileSummary[] = []
  const preExistingFiles: DiffFileSummary[] = []
  const workspace = post.workspacePath || pre.workspacePath

  if (
    pre.isGitRepo &&
    post.isGitRepo &&
    typeof pre.gitStatus === 'string' &&
    typeof post.gitStatus === 'string'
  ) {
    const preEntries = parseGitStatusZ(pre.gitStatus)
    const postEntries = parseGitStatusZ(post.gitStatus)

    const preMap = new Map(preEntries.map((e) => [e.filePath, e]))
    const postMap = new Map(postEntries.map((e) => [e.filePath, e]))

    for (const [filePath, postEntry] of postMap) {
      const status = classifyStatus(postEntry.statusCode)
      const preEntry = preMap.get(filePath)

      if (!preEntry) {
        // Didn't exist before run
        if (status === 'untracked' || status === 'created') {
          createdFiles.push(buildRunFileSummary(workspace, filePath, 'created'))
        } else {
          modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
        }
      } else {
        const preStatus = classifyStatus(preEntry.statusCode)
        if (preStatus === status) {
          // Unchanged status: pre-existing
          preExistingFiles.push({ path: filePath, status, previewKind: 'none' })
        } else {
          // Changed during run
          modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
        }
      }
    }

    for (const [filePath] of preMap) {
      if (!postMap.has(filePath)) {
        deletedFiles.push(buildRunFileSummary(workspace, filePath, 'deleted'))
      }
    }
  } else if (!pre.isGitRepo && !post.isGitRepo && pre.files && post.files) {
    const preMap = new Map(pre.files.map((f) => [f.path, f]))
    const postMap = new Map(post.files.map((f) => [f.path, f]))

    for (const [filePath, postFile] of postMap) {
      const preFile = preMap.get(filePath)
      if (!preFile) {
        createdFiles.push(buildRunFileSummary(workspace, filePath, 'created'))
      } else if (preFile.mtimeMs !== postFile.mtimeMs || preFile.sizeBytes !== postFile.sizeBytes) {
        modifiedFiles.push(buildRunFileSummary(workspace, filePath, 'modified'))
      }
    }

    for (const [filePath] of preMap) {
      if (!postMap.has(filePath)) {
        deletedFiles.push(buildRunFileSummary(workspace, filePath, 'deleted'))
      }
    }
  }

  return {
    runId,
    preSnapshot: pre,
    postSnapshot: post,
    createdFiles,
    modifiedFiles,
    deletedFiles,
    preExistingFiles
  }
}
