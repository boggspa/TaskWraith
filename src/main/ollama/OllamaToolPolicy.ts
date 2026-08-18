import {
  assertPatchPathsInScope,
  formatScopedPath,
  resolveMcpScopedPath,
  type WorkspaceToolContext
} from '../mcp/WorkspaceToolExecutors'
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
  if (
    /\b(npm|pnpm|yarn|bun|pip|uv|cargo|gem|bundle|brew)\s+(install|add|update|upgrade|remove|uninstall)\b/.test(
      normalized
    )
  ) {
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
          ...previousContent
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((line) => `-${line}`),
          ...nextLines.map((line) => `+${line}`)
        ]
  const preview = [...header, ...body].join('\n')
  if (preview.length <= MAX_OLLAMA_APPROVAL_DIFF_PREVIEW_CHARS) return preview
  return `${preview.slice(0, MAX_OLLAMA_APPROVAL_DIFF_PREVIEW_CHARS).trimEnd()}\n... diff preview truncated ...`
}

export function ollamaProtectedPathReason(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  const parts = normalized.split('/')
  const basename = parts[parts.length - 1]

  // Direct matches against protected workspace paths
  for (const protectedPath of OLLAMA_PROTECTED_WORKSPACE_PATHS) {
    const protectedNormalized = protectedPath.toLowerCase()
    if (
      normalized === protectedNormalized ||
      normalized.startsWith(protectedNormalized + '/') ||
      basename === protectedNormalized ||
      (protectedNormalized === '.env' && basename.startsWith('.env'))
    ) {
      if (protectedPath.includes('.env') || protectedPath === '.env') {
        return 'environment/secret files are protected from direct Ollama modification'
      }
      if (protectedPath.includes('package') || protectedPath.includes('lock')) {
        return 'dependency control file is protected from direct Ollama modification'
      }
      if (protectedPath.includes('entitlements')) {
        return 'macOS entitlements are protected from direct Ollama modification'
      }
      return 'protected workspace configuration'
    }
  }

  // Special pattern: .github/workflows
  if (normalized.includes('.github/workflows') || normalized.includes('.github/workflows/')) {
    return 'CI/workflow configuration is protected from direct Ollama modification'
  }

  // Special pattern: certs/ credentials
  if (parts.some((p) => p.includes('cert') || p.includes('credential') || p.includes('key'))) {
    return 'credential material is protected from direct Ollama modification'
  }

  return null
}

export function assertOllamaMutationIntent(toolName: string, args: Record<string, unknown>): void {
  if (!ollamaToolRequiresIntent(toolName)) return
  if (ollamaToolIntent(args)) return
  throw new Error(
    `${toolName} requires an intent or summary before TaskWraith can request approval.`
  )
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
    const targetPath = resolveMcpScopedPath(
      context,
      String(args.path || args.from || args.source || '')
    )
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

/**
 * Apply Ollama's two non-grantable tool guards as one boundary. Callers that
 * route through a wrapper or an approved retry must invoke this again for the
 * resolved target immediately before dispatch.
 */
export function assertOllamaResolvedToolPolicy(
  toolName: string,
  args: Record<string, unknown>,
  context: WorkspaceToolContext,
  cwd: string
): void {
  assertOllamaMutationIntent(toolName, args)
  assertOllamaProtectedWritePaths(toolName, args, context, cwd)
}

export function ollamaResolvedToolPolicyError(input: {
  toolName: string
  args: Record<string, unknown>
  workspacePath: string
  appChatId?: string
}): string | null {
  const context: WorkspaceToolContext = {
    scope: 'workspace',
    cwd: input.workspacePath,
    workspacePath: input.workspacePath,
    appChatId: input.appChatId
  }
  try {
    assertOllamaResolvedToolPolicy(input.toolName, input.args, context, input.workspacePath)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
