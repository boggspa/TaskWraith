import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats
} from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

export function codexSandboxForMode(
  approvalMode?: string,
  fullAccessGranted?: boolean
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  // Plan is always the read-only floor, even if a full-access flag leaks in
  // (the two are mutually exclusive — full_access resolves to auto_edit).
  if (approvalMode === 'plan') return 'read-only'
  // A signed, post-clamp full_access grant (see `isFullShellAccessGranted`)
  // drops Codex's workspace confinement so an approved agent can reach
  // ~/Library (SwiftPM caches / DerivedData), the login keychain (codesign
  // identities) and paths outside the repo — the capabilities an iOS
  // archive / notarize / TestFlight upload needs. Gated strictly on the
  // trusted grant; every other run stays workspace-confined.
  if (fullAccessGranted) return 'danger-full-access'
  return 'workspace-write'
}

export interface CodexGitMetadataFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  realpathSync(path: string): string
  statSync(path: string): Pick<Stats, 'isDirectory' | 'isFile'>
}

const nodeGitMetadataFs: CodexGitMetadataFs = {
  existsSync,
  readFileSync,
  realpathSync,
  statSync
}

/**
 * Codex's workspace-write sandbox can still leave Git metadata unwritable,
 * especially for linked worktrees where `.git` is a file pointing outside the
 * workspace. Include the concrete metadata roots so an approved writer can
 * stage and commit without widening the whole filesystem.
 */
export function codexGitMetadataRootsForWorkspace(
  workspace: string,
  fsImpl: CodexGitMetadataFs = nodeGitMetadataFs
): string[] {
  const workspaceRoot = resolve(workspace)
  const visibleGitPath = resolve(workspaceRoot, '.git')
  const roots: string[] = []
  const addRoot = (path: string | null | undefined): void => {
    if (!path) return
    const resolved = realpathOrResolve(path, fsImpl)
    if (!roots.includes(resolved)) roots.push(resolved)
  }

  try {
    if (!fsImpl.existsSync(visibleGitPath)) return roots
    const visibleGitStat = fsImpl.statSync(visibleGitPath)
    let gitDir: string | null = null

    if (visibleGitStat.isDirectory()) {
      gitDir = visibleGitPath
    } else if (visibleGitStat.isFile()) {
      gitDir = parseGitDirPointer(fsImpl.readFileSync(visibleGitPath, 'utf8'), workspaceRoot)
    }

    if (!gitDir) return roots
    addRoot(gitDir)

    const commonDirPointer = resolve(gitDir, 'commondir')
    if (fsImpl.existsSync(commonDirPointer) && fsImpl.statSync(commonDirPointer).isFile()) {
      const commonDir = firstNonEmptyLine(fsImpl.readFileSync(commonDirPointer, 'utf8'))
      if (commonDir) {
        addRoot(isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir))
      }
    }
  } catch {
    return roots
  }

  return roots
}

function parseGitDirPointer(content: string, workspaceRoot: string): string | null {
  const match = content.match(/^\s*gitdir:\s*(.+?)\s*$/im)
  if (!match) return null
  const gitDir = match[1]?.trim()
  if (!gitDir) return null
  return isAbsolute(gitDir) ? gitDir : resolve(workspaceRoot, gitDir)
}

function firstNonEmptyLine(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || ''
}

function realpathOrResolve(path: string, fsImpl: CodexGitMetadataFs): string {
  try {
    return fsImpl.realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function buildCodexUserInput(prompt: string, imagePaths: string[] = []) {
  const input: any[] = [{ type: 'text', text: prompt, text_elements: [] }]
  for (const imagePath of imagePaths) {
    if (typeof imagePath === 'string' && imagePath.trim()) {
      input.push({ type: 'localImage', path: imagePath.trim() })
    }
  }
  return input
}

export function normalizeCodexTurnStatus(status?: string): string {
  if (status === 'completed') return 'success'
  if (status === 'interrupted') return 'cancelled'
  if (status === 'failed') return 'failed'
  return status || 'success'
}
