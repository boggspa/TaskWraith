import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { dirname, isAbsolute, resolve } from 'path'
import os from 'os'
import { MAX_EDITOR_FILE_BYTES } from '../index.constants'
import type { McpToolExecutionResult } from '../index.types'
import { assertTextBuffer } from '../gemini/GeminiDiscovery'
import { mcpJson, isTaskWraithMcpToolName } from '../mcp/McpResultHelpers'
import {
  formatScopedPath as formatWorkspaceToolScopedPath,
  resolveMcpScopedPath as resolveWorkspaceToolScopedPath,
  type WorkspaceToolContext
} from '../mcp/WorkspaceToolExecutors'
import { isCapabilityGatewayToolName, type CapabilityGatewayToolName } from '../mcp/McpToolGateway'
import {
  readScopedDirectory,
  readScopedRegularFile,
  type ScopedPathAuthority
} from '../ScopedPathAccess'
import { isRecord, requireNonEmptyString } from '../settings/MainSanitizers'
import { routeWithRunId } from '../run/RunRoute'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { GeminiToolContext } from '../runStateTypes'
import type { RunManager } from '../RunManager'
import type { AppSettings, ChatRecord, ExternalPathGrant } from '../store/types'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { sanitizeTaskWraithMcpPromptClaims } from '../PromptComposition'
import { buildOllamaToolDocSection } from './OllamaToolsDoc'
import {
  OLLAMA_TOOL_HELP_NAME,
  canonicalizeOllamaToolArguments,
  validateOllamaToolArguments,
  type OllamaProviderDeps,
  type OllamaToolExecutionRequest,
  type OllamaToolExecutionResult
} from './OllamaProvider'
import {
  normalizeOllamaSessionMemory,
  normalizeOllamaSessionMemoryMap,
  upsertOllamaSessionMemory
} from './OllamaRunMemory'
import type { OllamaModelPreflightResult } from './OllamaModelPreflight'
import { assertOllamaMutationIntent, assertOllamaProtectedWritePaths } from './OllamaToolPolicy'

interface OllamaWorkspaceToolExecutors {
  executeFindFiles: (
    args: Record<string, unknown>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeWorkspaceSearch: (
    args: Record<string, unknown>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeWorkspaceSymbols: (
    args: Record<string, unknown>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
  executeGitStatus: (cwd: string) => Promise<unknown>
  executeGitDiff: (
    args: Record<string, unknown>,
    context: WorkspaceToolContext,
    cwd: string
  ) => Promise<unknown>
}

export interface OllamaMainRuntimeDependencies {
  store: {
    getSettings: () => AppSettings
    updateSettings: (partial: Partial<AppSettings>) => void
    getChat: (chatId: string) => ChatRecord | null
    saveChat: (chat: ChatRecord) => void
    getRunQueueJob: (runId?: string) => { executionGraph?: unknown } | null
  }
  canonicalPath: (value: string) => string
  canonicalExternalGrantPath: (value: string) => string | null
  isPathInsideRoot: (rootPath: string | undefined, candidatePath: string) => boolean
  getAgentToolContext: (provider: 'ollama', route: AgentRunRoute) => GeminiToolContext | null
  resolveGrantAwarePath: (
    context: GeminiToolContext,
    provider: 'ollama',
    filePath: string,
    access: 'read',
    options?: { allowWorkspaceRoot?: boolean }
  ) => string
  resolveGrantAwarePathAuthority: (
    context: GeminiToolContext,
    provider: 'ollama',
    filePath: string,
    access: 'read',
    options?: { allowWorkspaceRoot?: boolean }
  ) => ScopedPathAuthority
  externalPathGrantForTarget: (
    context: GeminiToolContext,
    provider: 'ollama',
    targetPath: string,
    access: 'read'
  ) => ExternalPathGrant | undefined
  workspaceToolExecutors: OllamaWorkspaceToolExecutors
  createHostCommandProjection?: NonNullable<OllamaProviderDeps['createHostCommandProjection']>
  executeMcpTool: (
    toolName: TaskWraithMcpToolName | CapabilityGatewayToolName,
    args: Record<string, any>,
    route: AgentRunRoute,
    parentProvider: 'ollama'
  ) => Promise<McpToolExecutionResult>
  registerRunSession: (
    provider: 'ollama',
    sender: WebContents,
    route: AgentRunRoute,
    workspacePath: string | undefined,
    state: Record<string, unknown>
  ) => unknown
  appendDurableRunEventForRoute: (
    provider: 'ollama',
    route: AgentRunRoute | null | undefined,
    kind: 'lifecycle',
    phase: 'control',
    summary: string,
    payload: unknown
  ) => void
  sendAgentCompatLine: OllamaProviderDeps['sendAgentCompatLine']
  sendAgentCompatError: OllamaProviderDeps['sendAgentCompatError']
  sendAgentCompatExit: OllamaProviderDeps['sendAgentCompatExit']
  reportWorkingTokenUsage?: OllamaProviderDeps['reportWorkingTokenUsage']
  runManager: RunManager<any>
  emitProviderCapabilityWarnings: NonNullable<OllamaProviderDeps['emitProviderCapabilityWarnings']>
  runProvider: (
    providerDeps: OllamaProviderDeps,
    event: IpcMainInvokeEvent,
    payload: AgentRunPayload,
    route: AgentRunRoute
  ) => Promise<void>
}

export interface OllamaMainRuntime {
  executeLocalTool: (request: OllamaToolExecutionRequest) => Promise<OllamaToolExecutionResult>
  markModelPreflightComplete: (modelId: string) => void
  emitModelPreflight: (
    sender: WebContents,
    result: OllamaModelPreflightResult,
    route?: AgentRunRoute | null
  ) => void
  runProviderAdapter: (event: IpcMainInvokeEvent, payload: AgentRunPayload) => Promise<void>
}

export function createOllamaMainRuntime(deps: OllamaMainRuntimeDependencies): OllamaMainRuntime {
  function flattenWorkspaceSearchResult(result: unknown): string {
    if (!isRecord(result) || !Array.isArray(result.matches)) return mcpJson(result)
    const rows = result.matches
      .map((match) => {
        if (!isRecord(match)) return ''
        const path = String(match.path || '').trim()
        const line = Number(match.line)
        const text = String(match.text || '').trim()
        if (!path || !Number.isFinite(line)) return ''
        return `${path}:${line}: ${text}`
      })
      .filter(Boolean)
    if (rows.length === 0) return mcpJson(result)
    if (result.truncated === true) {
      rows.push(`[search truncated at ${String(result.count || rows.length)} results]`)
    }
    return rows.join('\n')
  }

  function flattenFindFilesResult(result: unknown): string {
    if (!isRecord(result) || !Array.isArray(result.files)) return mcpJson(result)
    const rows = result.files.map((file) => String(file || '').trim()).filter(Boolean)
    if (rows.length === 0) return mcpJson(result)
    if (result.truncated === true) {
      rows.push(`[file list truncated at ${String(result.count || rows.length)} results]`)
    }
    return rows.join('\n')
  }

  function integerArg(value: unknown): number | null {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return null
    return Math.max(1, Math.trunc(numeric))
  }

  function sliceReadFileOutput(
    content: string,
    args: Record<string, unknown>
  ): {
    output: string
    startLine: number
    endLine: number
    totalLines: number
    truncated: boolean
  } {
    const lines = content.split(/\r?\n/)
    const totalLines = lines.length
    const requestedStart = integerArg(args.startLine ?? args.start_line ?? args.lineStart)
    const requestedEnd = integerArg(args.endLine ?? args.end_line ?? args.lineEnd)
    const requestedMax = integerArg(args.maxLines ?? args.max_lines ?? args.limit)
    const startLine = Math.min(totalLines, requestedStart || 1)
    const endByMax = requestedMax ? startLine + requestedMax - 1 : totalLines
    const endLine = Math.min(totalLines, requestedEnd || endByMax)
    const safeEndLine = Math.max(startLine, endLine)
    return {
      output: lines.slice(startLine - 1, safeEndLine).join('\n'),
      startLine,
      endLine: safeEndLine,
      totalLines,
      truncated: startLine > 1 || safeEndLine < totalLines
    }
  }

  function resolveReadToolScope(
    request: OllamaToolExecutionRequest,
    context: WorkspaceToolContext,
    rawTarget: unknown
  ): {
    args: Record<string, unknown>
    context: WorkspaceToolContext
    cwd: string
  } {
    const target = typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim() : '.'
    const primaryCwd = context.workspacePath || context.cwd
    if (!isAbsolute(target)) {
      return { args: { ...request.arguments }, context, cwd: primaryCwd }
    }

    const runContext = deps.getAgentToolContext('ollama', {
      appRunId: request.appRunId,
      appChatId: request.appChatId
    })
    if (!runContext) {
      return { args: { ...request.arguments }, context, cwd: primaryCwd }
    }

    const targetPath = deps.resolveGrantAwarePath(runContext, 'ollama', target, 'read', {
      allowWorkspaceRoot: true
    })
    if (deps.isPathInsideRoot(context.workspacePath || context.cwd, targetPath)) {
      return {
        args: { ...request.arguments, path: targetPath },
        context,
        cwd: primaryCwd
      }
    }

    const grant = deps.externalPathGrantForTarget(runContext, 'ollama', targetPath, 'read')
    if (!grant) {
      throw new Error('Path is outside the workspace and has no matching Ollama grant.')
    }
    const grantRoot = resolve(grant.path)
    const scopedWorkspace = grant.kind === 'directory' ? grantRoot : targetPath
    return {
      args: { ...request.arguments, path: targetPath },
      context: {
        ...context,
        cwd: grant.kind === 'directory' ? grantRoot : dirname(targetPath),
        workspacePath: scopedWorkspace
      },
      cwd: grant.kind === 'directory' ? grantRoot : dirname(targetPath)
    }
  }

  function resolveWorkspacePathAuthority(
    context: WorkspaceToolContext,
    filePath: string,
    options: { allowWorkspaceRoot?: boolean } = {}
  ): ScopedPathAuthority {
    const targetPath = resolveWorkspaceToolScopedPath(context, filePath, options)
    if (context.scope === 'global') {
      const canonicalTarget = deps.canonicalExternalGrantPath(targetPath) || targetPath
      return {
        rootPath:
          dirname(canonicalTarget) === canonicalTarget ? canonicalTarget : dirname(canonicalTarget),
        targetPath: canonicalTarget
      }
    }
    const rootPath = deps.canonicalExternalGrantPath(context.workspacePath || context.cwd)
    const canonicalTarget = deps.canonicalExternalGrantPath(targetPath)
    if (!rootPath || !canonicalTarget) {
      throw new Error('Selected workspace path could not be resolved safely.')
    }
    return { rootPath, targetPath: canonicalTarget }
  }

  async function executeLocalTool(
    request: OllamaToolExecutionRequest
  ): Promise<OllamaToolExecutionResult> {
    const workspacePath = deps.canonicalPath(
      requireNonEmptyString(request.workspacePath, 'Workspace')
    )
    const context: WorkspaceToolContext = {
      scope: 'workspace',
      cwd: workspacePath,
      workspacePath,
      appChatId: request.appChatId
    }
    try {
      if (request.toolName === OLLAMA_TOOL_HELP_NAME) {
        const output = buildOllamaToolDocSection(
          String(request.arguments.name ?? request.arguments.tool ?? ''),
          request.taskWraithMcpProfileId
        )
        return { ok: true, output }
      }
      const canonicalArguments = canonicalizeOllamaToolArguments(
        request.toolName,
        request.arguments
      )
      const argCheck = validateOllamaToolArguments(request.toolName, canonicalArguments)
      if (!argCheck.ok) {
        return { ok: false, output: argCheck.message, validationError: true }
      }

      // Rebind locally so executors see canonical keys without mutating the
      // caller-owned request (tool_use / trajectory keep model-emitted args).
      request = { ...request, arguments: canonicalArguments }

      if (isCapabilityGatewayToolName(request.toolName)) {
        const result = await deps.executeMcpTool(
          request.toolName,
          request.arguments,
          { appRunId: request.appRunId, appChatId: request.appChatId },
          'ollama'
        )
        return {
          ok: result.isError !== true,
          output: result.text,
          structuredContent: result.structuredContent,
          canvasEvalApproval: result.canvasEvalApproval
        }
      }

      assertOllamaMutationIntent(request.toolName, request.arguments)
      assertOllamaProtectedWritePaths(request.toolName, request.arguments, context, workspacePath)

      if (request.toolName === 'find_files') {
        const scope = resolveReadToolScope(
          request,
          context,
          request.arguments.path || request.arguments.directory || '.'
        )
        const result = await deps.workspaceToolExecutors.executeFindFiles(
          scope.args,
          scope.context,
          scope.cwd
        )
        return {
          ok:
            isRecord(result) &&
            (result.ok === true || result.exitCode === 0 || result.exitCode === 1) &&
            result.timedOut !== true,
          output: flattenFindFilesResult(result),
          structuredContent: result
        }
      }

      if (request.toolName === 'workspace_search') {
        const scope = resolveReadToolScope(
          request,
          context,
          request.arguments.path || request.arguments.directory || '.'
        )
        const result = await deps.workspaceToolExecutors.executeWorkspaceSearch(
          scope.args,
          scope.context,
          scope.cwd
        )
        return {
          ok:
            isRecord(result) &&
            (result.ok === true || result.exitCode === 0 || result.exitCode === 1) &&
            result.timedOut !== true,
          output: flattenWorkspaceSearchResult(result),
          structuredContent: result
        }
      }

      if (request.toolName === 'workspace_symbols') {
        const scope = resolveReadToolScope(request, context, request.arguments.path || '.')
        const result = await deps.workspaceToolExecutors.executeWorkspaceSymbols(
          scope.args,
          scope.context,
          scope.cwd
        )
        return { ok: true, output: mcpJson(result), structuredContent: result }
      }

      if (request.toolName === 'git_status') {
        const result = await deps.workspaceToolExecutors.executeGitStatus(workspacePath)
        return {
          ok: isRecord(result) ? result.ok !== false : true,
          output: mcpJson(result),
          structuredContent: result
        }
      }

      if (request.toolName === 'git_diff') {
        const result = await deps.workspaceToolExecutors.executeGitDiff(
          request.arguments,
          context,
          workspacePath
        )
        return {
          ok: isRecord(result) ? result.ok !== false : true,
          output: mcpJson(result),
          structuredContent: result
        }
      }

      if (request.toolName === 'read_file') {
        const rawPath = String(request.arguments.path || request.arguments.file_path || '')
        const runContext = deps.getAgentToolContext('ollama', {
          appRunId: request.appRunId,
          appChatId: request.appChatId
        })
        const authority = runContext
          ? deps.resolveGrantAwarePathAuthority(runContext, 'ollama', rawPath, 'read')
          : resolveWorkspacePathAuthority(context, rawPath)
        const { buffer, stat } = await readScopedRegularFile(authority, {
          maxBytes: MAX_EDITOR_FILE_BYTES,
          sizeLimitErrorMessage: 'File is too large to read through the Ollama tool loop.'
        })
        const targetPath = authority.targetPath
        assertTextBuffer(buffer)
        const sliced = sliceReadFileOutput(buffer.toString('utf8'), request.arguments)
        return {
          ok: true,
          output: sliced.output,
          structuredContent: {
            ok: true,
            tool: 'read_file',
            path: formatWorkspaceToolScopedPath(context, targetPath),
            bytes: Number(stat.size),
            startLine: sliced.startLine,
            endLine: sliced.endLine,
            totalLines: sliced.totalLines,
            truncated: sliced.truncated
          }
        }
      }

      if (
        request.toolName === 'write_file' ||
        request.toolName === 'replace' ||
        request.toolName === 'create_directory' ||
        request.toolName === 'delete_path' ||
        request.toolName === 'move_path' ||
        request.toolName === 'apply_patch' ||
        request.toolName === 'run_shell_command' ||
        request.toolName === 'run_task' ||
        request.toolName === 'todo_write'
      ) {
        const result = await deps.executeMcpTool(
          request.toolName as TaskWraithMcpToolName,
          request.arguments,
          { appRunId: request.appRunId, appChatId: request.appChatId },
          'ollama'
        )
        return {
          ok: result.isError !== true,
          output: result.text,
          structuredContent: result.structuredContent,
          canvasEvalApproval: result.canvasEvalApproval
        }
      }

      if (request.toolName === 'list_directory') {
        const rawPath = String(request.arguments.path || request.arguments.directory || '.')
        const runContext = deps.getAgentToolContext('ollama', {
          appRunId: request.appRunId,
          appChatId: request.appChatId
        })
        const authority = runContext
          ? deps.resolveGrantAwarePathAuthority(runContext, 'ollama', rawPath, 'read', {
              allowWorkspaceRoot: true
            })
          : resolveWorkspacePathAuthority(context, rawPath, { allowWorkspaceRoot: true })
        const targetPath = authority.targetPath
        const entries = await readScopedDirectory(authority)
        const rows = entries
          .sort((left, right) => {
            if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1
            return left.name.localeCompare(right.name)
          })
          .slice(0, 300)
          .map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`)
        return {
          ok: true,
          output: rows.join('\n'),
          structuredContent: {
            ok: true,
            tool: 'list_directory',
            path: formatWorkspaceToolScopedPath(context, targetPath),
            count: rows.length,
            truncated: entries.length > rows.length
          }
        }
      }

      if (isTaskWraithMcpToolName(request.toolName)) {
        const result = await deps.executeMcpTool(
          request.toolName,
          request.arguments,
          { appRunId: request.appRunId, appChatId: request.appChatId },
          'ollama'
        )
        return {
          ok: result.isError !== true,
          output: result.text,
          structuredContent: result.structuredContent,
          canvasEvalApproval: result.canvasEvalApproval
        }
      }
      throw new Error(`Tool ${request.toolName} is not a recognized TaskWraith tool.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: message,
        structuredContent: { ok: false, tool: request.toolName, error: message }
      }
    }
  }

  function markModelPreflightComplete(modelId: string): void {
    const key = modelId.trim()
    if (!key) return
    const settings = deps.store.getSettings()
    deps.store.updateSettings({
      ollamaModelPreflightAt: {
        ...(settings.ollamaModelPreflightAt || {}),
        [key]: Date.now()
      }
    })
  }

  /**
   * Cache a context length measured from the daemon so synchronous consumers
   * (prompt composition, which runs before the launch plan that holds the model
   * info) can size a budget against the model's real window.
   *
   * Writes only on CHANGE. `updateSettings` performs a synchronous full-settings
   * `writeJson`, so an unconditional write here would put disk I/O on every run —
   * the persistence-freeze class. In practice this fires once per model, ever.
   */
  function recordModelContextTokens(modelId: string, contextTokens?: number | null): void {
    const key = modelId.trim()
    if (!key) return
    if (
      typeof contextTokens !== 'number' ||
      !Number.isFinite(contextTokens) ||
      contextTokens <= 0
    ) {
      return
    }
    const measured = Math.trunc(contextTokens)
    const settings = deps.store.getSettings()
    const existing = settings.ollamaModelContextTokens || {}
    if (existing[key] === measured) return
    deps.store.updateSettings({
      ollamaModelContextTokens: { ...existing, [key]: measured }
    })
  }

  function emitModelPreflight(
    sender: WebContents,
    result: OllamaModelPreflightResult,
    route?: AgentRunRoute | null
  ): void {
    deps.appendDurableRunEventForRoute(
      'ollama',
      route,
      'lifecycle',
      'control',
      `Ollama capability preflight: ${result.guidance}`,
      { kind: 'ollamaModelPreflight', guidance: result.guidance, checks: result.checks }
    )
    for (const check of result.checks) {
      deps.appendDurableRunEventForRoute(
        'ollama',
        route,
        'lifecycle',
        'control',
        `Preflight ${check.id}: ${check.detail}`,
        { kind: 'ollamaModelPreflightCheck', check }
      )
    }
    for (const item of result.warnings) {
      if (item.severity === 'info') continue
      deps.sendAgentCompatLine(
        sender,
        'ollama',
        {
          type: 'provider_warning',
          provider: 'ollama',
          severity: item.severity,
          title: item.title,
          message: item.message,
          capabilityWarning: item
        },
        route
      )
    }
  }

  async function runProviderAdapter(
    event: IpcMainInvokeEvent,
    payload: AgentRunPayload
  ): Promise<void> {
    const graphOwnedOllamaAttempt = Boolean(
      payload.appRunId && deps.store.getRunQueueJob(payload.appRunId)?.executionGraph
    )
    const ollamaTaskWraithMcpAdvertised = Boolean(
      payload.scope !== 'global' &&
      payload.workspace &&
      deps.store.getSettings().agenticServices?.mcpTools !== 'deny'
    )
    if (!ollamaTaskWraithMcpAdvertised) {
      payload.taskWraithMcpAdvertised = false
      payload.prompt = sanitizeTaskWraithMcpPromptClaims(payload.prompt, {
        advertised: false,
        coreProfile: false
      })
    }
    const route = routeWithRunId('ollama', payload)
    const registeredSession = deps.registerRunSession(
      'ollama',
      event.sender,
      route,
      payload.scope === 'global' ? undefined : payload.workspace,
      {
        provider: 'ollama',
        sender: event.sender,
        startedAt: Date.now(),
        model: payload.model,
        approvalMode: payload.approvalMode,
        workflowMode: payload.workflowMode,
        sessionTrust: Boolean(payload.sessionTrust),
        externalPathGrants: payload.externalPathGrants,
        runtimeProfileId: payload.runtimeProfileId,
        taskWraithMcpProfileId: payload.taskWraithMcpProfileId,
        effectivePermissions: payload.effectivePermissions,
        effectivePermissionsSignature: payload.effectivePermissionsSignature,
        ensembleRun: payload.ensembleRun,
        ...route
      }
    )
    if (!registeredSession) return
    await deps.runProvider(
      {
        getSettings: deps.store.getSettings,
        getTotalMemoryBytes: () => os.totalmem(),
        markOllamaModelPreflightComplete: markModelPreflightComplete,
        recordOllamaModelContextTokens: recordModelContextTokens,
        emitOllamaModelPreflight: emitModelPreflight,
        sendAgentCompatLine: deps.sendAgentCompatLine,
        sendAgentCompatError: deps.sendAgentCompatError,
        sendAgentCompatExit: deps.sendAgentCompatExit,
        reportWorkingTokenUsage: deps.reportWorkingTokenUsage,
        runManager: deps.runManager,
        emitProviderCapabilityWarnings: deps.emitProviderCapabilityWarnings,
        executeTool: executeLocalTool,
        createHostCommandProjection: deps.createHostCommandProjection,
        getOllamaSessionMemory: (chatId, memoryKey) => {
          if (graphOwnedOllamaAttempt) return null
          const chat = deps.store.getChat(chatId)
          if (!chat) return null
          if (memoryKey) {
            return normalizeOllamaSessionMemory(
              normalizeOllamaSessionMemoryMap(chat.ollamaSessionMemories)[memoryKey]
            )
          }
          return normalizeOllamaSessionMemory(chat.ollamaSessionMemory)
        },
        saveOllamaSessionMemory: (chatId, memory, memoryKey) => {
          if (graphOwnedOllamaAttempt) return
          const chat = deps.store.getChat(chatId)
          if (!chat) return
          if (memoryKey) {
            deps.store.saveChat({
              ...chat,
              ollamaSessionMemories: upsertOllamaSessionMemory(
                chat.ollamaSessionMemories,
                memoryKey,
                memory
              )
            })
            return
          }
          deps.store.saveChat({ ...chat, ollamaSessionMemory: memory })
        }
      },
      event,
      payload,
      route
    )
  }

  return {
    executeLocalTool,
    markModelPreflightComplete,
    emitModelPreflight,
    runProviderAdapter
  }
}
