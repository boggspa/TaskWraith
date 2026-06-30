import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgenticServiceId, ChatWorkflowMode, EffectiveRunPermissions } from './store/types'
import type { TaskWraithMcpToolName } from './TaskWraithMcpTools'

export interface PlanArtifactWriteCheckInput {
  workflowMode?: ChatWorkflowMode | string | null
  effectivePermissions?: EffectiveRunPermissions
  globalFileChangesPolicy?: string | null
  service: AgenticServiceId
  toolName?: TaskWraithMcpToolName | string | null
  workspacePath?: string | null
  rawPath?: string | null
}

export interface PlanArtifactWriteDecision {
  allowed: boolean
  targetPath?: string
  relativePath?: string
  reason?: string
}

const PLAN_ARTIFACT_DIR_PREFIXES = [
  '.taskwraith/plans/',
  '.cursor/plans/',
  'docs/plans/',
  'plans/'
]

export function evaluatePlanArtifactWrite(input: PlanArtifactWriteCheckInput): PlanArtifactWriteDecision {
  if (input.workflowMode !== 'plan') return { allowed: false, reason: 'not_plan_workflow' }
  if (input.service !== 'fileChanges') return { allowed: false, reason: 'not_file_changes' }
  if (input.effectivePermissions?.readOnly !== true) {
    return { allowed: false, reason: 'not_read_only_posture' }
  }
  if (input.effectivePermissions.agenticServices?.fileChanges !== 'deny') {
    return { allowed: false, reason: 'file_changes_not_denied_by_posture' }
  }
  if (input.globalFileChangesPolicy === 'deny') {
    return { allowed: false, reason: 'global_file_changes_denied' }
  }
  if (input.toolName !== 'write_file' && input.toolName !== 'replace') {
    return { allowed: false, reason: 'unsupported_tool' }
  }
  if (!input.workspacePath || !input.rawPath?.trim()) {
    return { allowed: false, reason: 'missing_path' }
  }

  const workspaceRoot = resolve(input.workspacePath)
  const targetPath = isAbsolute(input.rawPath)
    ? resolve(input.rawPath)
    : resolve(workspaceRoot, input.rawPath)
  const relativePath = toPosixRelative(workspaceRoot, targetPath)
  if (!relativePath || relativePath.startsWith('../') || relativePath === '..') {
    return { allowed: false, reason: 'outside_workspace' }
  }
  if (!isMarkdownPath(relativePath)) {
    return { allowed: false, reason: 'not_markdown' }
  }
  if (!isPlanArtifactPath(relativePath)) {
    return { allowed: false, reason: 'not_plan_artifact' }
  }
  return { allowed: true, targetPath, relativePath }
}

function toPosixRelative(workspaceRoot: string, targetPath: string): string {
  return relative(workspaceRoot, targetPath).split(sep).join('/')
}

function isMarkdownPath(relativePath: string): boolean {
  const extension = extname(relativePath).toLowerCase()
  return extension === '.md' || extension === '.markdown'
}

function isPlanArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, '')
  const basename = normalized.split('/').at(-1)?.toLowerCase() || ''
  if (normalized === 'PLAN.md' || normalized === 'PLAN.markdown') return true
  if (basename.endsWith('.plan.md') || basename.endsWith('.plan.markdown')) return true
  return PLAN_ARTIFACT_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}
