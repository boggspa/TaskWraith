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
  // Plan is always the read-only floor, and it outranks a full-access grant:
  // if the flag ever leaks onto a plan run the floor still wins.
  if (approvalMode === 'plan') return 'read-only'
  // A signed Full Access grant drops the native sandbox outright, so the run's
  // real posture matches what the permissions picker promised the user. The
  // blast radius is the point — Full Access exists to reach the login keychain
  // and ~/Library for signing/archiving, and the user is warned before granting
  // it. Callers must pass `isFullShellAccessGranted(effectivePermissions)`,
  // which already requires presetId === 'full_access' AND the global shell
  // kill-switch to be open; anything short of that stays workspace-confined.
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


/**
 * Slice D (owner directive 2026-08-04): the codex native-tool approval gate
 * previously read only GLOBAL agenticServices, so a Full WS Access / Full
 * Access run still inherited the globals' prompts ("some providers can't use
 * shell when granted"). This posture-honoring variant reads the run's SIGNED,
 * post-clamp effective permissions instead: a write-tier preset whose resolved
 * shell+file are both 'allow' runs codex natively without the per-call gate.
 * A global 'deny' survives the resolver (preserveExplicitDeny), so the kill
 * switch keeps working through this path exactly as through the settings path.
 * Read tiers and Accept Edits never qualify — their TaskWraith-side prompts
 * remain the contract.
 */
export function codexNativeAutoApprovalFromPosture(
  effectivePermissions:
    | { presetId?: string; agenticServices?: Record<string, string | undefined> }
    | null
    | undefined
): boolean {
  if (!effectivePermissions) return false
  const presetId = effectivePermissions.presetId
  if (presetId !== 'workspace_write' && presetId !== 'full_access') return false
  const services = effectivePermissions.agenticServices
  return services?.shellCommands === 'allow' && services?.fileChanges === 'allow'
}
