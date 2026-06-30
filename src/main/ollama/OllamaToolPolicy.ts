import {
  assertPatchPathsInScope,
  formatScopedPath,
  resolveMcpScopedPath,
  type WorkspaceToolContext
} from '../mcp/WorkspaceToolExecutors'
import type { OllamaToolControlTier } from '../store/types'
import { ollamaToolIntent, ollamaToolRequiresIntent } from './OllamaToolTiers'

export const OLLAMA_SHELL_ENV_DELTAS = {
  FORCE_COLOR: '0',
  NO_COLOR: '1'
} as const

const MAX_OLLAMA_APPROVAL_DIFF_PREVIEW_CHARS = 4_000

export const OLLAMA_PROTECTED_WORKSPACE_PATHS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.ssh',
  '.aws',
  '.config',
  '.npmrc',
  '.yarnrc',
  '.pnpmrc',
  '.env',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'electron-builder.yml',
  'electron-builder.yaml',
  'entitlements.mac.plist',
  'entitlements.plist'
])

const OLLAMA_FORCE_PROMPT_TOOLS = new Set([
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'apply_patch',
  'run_shell_command',
  'run_task',
  'get_diagnostics',
  'git_push',
  'git_create_pr',
  'cancel_active_run'
])

export function ollamaShellRiskLabels(command: string): string[] {
  const normalized = command.toLowerCase()
  const labels = new Set<string>(['workspace shell execution'])
  if (/\b(rm|rmdir|unlink)\b/.test(normalized)) labels.add('deletes files')
  if (/\b(mv|cp|mkdir|touch|tee)\b/.test(normalized) || />{1,2}/.test(command)) {
    labels.add('may modify files')
  }
  if (/\b(sed\s+-i|perl\s+-pi|python\s+-c|node\s+-e|git\s+apply)\b/.test(normalized)) {
    labels.add('scripted mutation')
  }
  if (/\b(git\s+(add|commit|reset|checkout|clean|merge|rebase|push|tag))\b/.test(normalized)) {
    labels.add('git mutation')
  }
  if (/\b(npm|pnpm|yarn|bun|pip|uv|cargo|gem|bundle|brew)\s+(install|add|update|upgrade|remove|uninstall)\b/.test(normalized)) {
    labels.add('dependency change')
  }
  if (/\b(curl|wget|scp|rsync|ssh|ftp)\b/.test(normalized)) labels.add('network access')
  if (/\b(sudo|su)\b/.test(normalized)) labels.add('elevated privileges')
  return [...labels]
}

export function ollamaShellApprovalPreviewMetadata(command: string): {
  envDeltas: Record<keyof typeof OLLAMA_SHELL_ENV_DELTAS, string>
  riskLabels: string[]
} {
  return {
    envDeltas: { ...OLLAMA_SHELL_ENV_DELTAS },
    riskLabels: ollamaShellRiskLabels(command)
  }
}

export function ollamaTextDiffPreview(
  relativePath: string,
  previousContent: string | null,
  nextContent: string
): string {
  const path = relativePath || 'file'
  const nextLines = nextContent.replace(/\r\n/g, '\n').split('\n')
  const header =
    previousContent === null
      ? [
          `diff --git a/${path} b/${path}`,
          'new file mode 100644',
          '--- /dev/null',
          `+++ b/${path}`,
          `@@ -0,0 +1,${nextLines.length} @@`
        ]
      : [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          `@@ -1,${previousContent.replace(/\r\n/g, '\n').split('\n').length} +1,${nextLines.length} @@`
        ]
  const body =
    previousContent === null
      ? nextLines.map((line) => `+${line}`)
      : [
          ...previousContent.replace(/\r\n/g, '\n').split('\n').map((line) => `-${line}`),
          ...nextLines.map((line) => `+${line}`)
        ]
  const preview = [...header, ...body].join('\n')
  if (preview.length <= MAX_OLLAMA_APPROVAL_DIFF_PREVIEW_CHARS) return preview
  return `${preview.slice(0, MAX_OLLAMA_APPROVAL_DIFF_PREVIEW_CHARS).trimEnd()}\n... diff preview truncated ...`
}

export function ollamaProtectedPathReason(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  const basename = parts[parts.length - 1] || normalized
  if (parts.some((part) => part === '.git' || part === '.hg' || part === '.svn')) {
    return 'version-control metadata is protected'
  }
  if (basename === '.env' || basename.startsWith('.env.')) {
    return 'environment/secret files are protected'
  }
  if (/\.(pem|key|p12|pfx|mobileprovision)$/i.test(basename)) {
    return 'credential/key material is protected'
  }
  if (OLLAMA_PROTECTED_WORKSPACE_PATHS.has(normalized) || OLLAMA_PROTECTED_WORKSPACE_PATHS.has(basename)) {
    return 'this workspace control file is protected'
  }
  if (parts.includes('.github')) {
    return 'CI/workflow configuration is protected'
  }
  return null
}

export function assertOllamaMutationIntent(
  toolName: string,
  args: Record<string, unknown>
): void {
  if (!ollamaToolRequiresIntent(toolName)) return
  if (ollamaToolIntent(args)) return
  throw new Error(`${toolName} requires an intent or summary before TaskWraith can request approval.`)
}

export function assertOllamaProtectedWritePaths(
  toolName: string,
  args: Record<string, unknown>,
  context: WorkspaceToolContext,
  cwd: string
): void {
  const checkRelativePath = (relativePath: string): void => {
    const reason = ollamaProtectedPathReason(relativePath)
    if (reason) {
      throw new Error(`Ollama cannot modify ${relativePath}: ${reason}.`)
    }
  }
  if (toolName === 'write_file' || toolName === 'replace') {
    const targetPath = resolveMcpScopedPath(context, String(args.path || args.file_path || ''))
    checkRelativePath(formatScopedPath(context, targetPath))
  }
  if (toolName === 'create_directory' || toolName === 'delete_path') {
    const targetPath = resolveMcpScopedPath(
      context,
      String(args.path || args.directory || args.file || '')
    )
    checkRelativePath(formatScopedPath(context, targetPath))
  }
  if (toolName === 'move_path') {
    for (const rawPath of [
      args.from || args.source || args.sourcePath || args.path,
      args.to || args.destination || args.destinationPath || args.target
    ]) {
      const targetPath = resolveMcpScopedPath(context, String(rawPath || ''))
      checkRelativePath(formatScopedPath(context, targetPath))
    }
  }
  if (toolName === 'rename_path') {
    const targetPath = resolveMcpScopedPath(context, String(args.path || args.from || args.source || ''))
    checkRelativePath(formatScopedPath(context, targetPath))
  }
  if (toolName === 'apply_patch') {
    const patch = String(args.patch || args.diff || '')
    const patchPaths = assertPatchPathsInScope(context, cwd, patch)
    for (const patchPath of patchPaths) {
      checkRelativePath(patchPath)
    }
  }
}

export function ollamaToolRequiresModalApproval(
  toolName: string,
  tier: OllamaToolControlTier | null | undefined
): boolean {
  return Boolean(tier && tier !== 'provider_parity' && OLLAMA_FORCE_PROMPT_TOOLS.has(toolName))
}
