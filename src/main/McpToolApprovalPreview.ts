import type { GeminiToolContext } from './runStateTypes'
import type { TaskWraithMcpToolName } from './TaskWraithMcpTools'
import type { AgenticServiceId, ProviderId } from './store/types'

export interface McpToolApprovalPreview {
  title: string
  body: string
  service: AgenticServiceId
  preview: Record<string, unknown>
}

export interface McpApprovalAttachedWindowMeta {
  applicationName?: string
  bundleID?: string
  title?: string
}

export interface McpToolApprovalPreviewDependencies {
  mediaEditingTools: ReadonlySet<string>
  providerDisplayName: (provider: ProviderId) => string
  optionalString: (value: unknown) => string | undefined
  isRecord: (value: unknown) => value is Record<string, unknown>
  ollamaShellApprovalPreviewMetadata: (command: string) => object
  ollamaTextDiffPreview: (
    relativePath: string,
    previousContent: string | null,
    nextContent: string
  ) => string
  previewPath: (context: GeminiToolContext, filePath: string) => string
  readApprovalPreviewFileContent: (context: GeminiToolContext, filePath: string) => string | null
  getAttachedWindowMeta: () => McpApprovalAttachedWindowMeta | null | undefined
}

export type McpToolApprovalPreviewer = (
  toolName: TaskWraithMcpToolName,
  args: Record<string, any>,
  cwd: string,
  context: GeminiToolContext,
  parentProvider?: ProviderId
) => McpToolApprovalPreview

/**
 * Build the approval prompt for a TaskWraith-hosted MCP tool call.
 *
 * The legacy Gemini name at the main dispatch seam is retained for session and
 * source-contract compatibility, but this formatter serves every provider.
 * Host state and filesystem projections are explicit dependencies so the
 * classification and preview policy stays independently testable.
 */
export function createMcpToolApprovalPreviewer(
  deps: McpToolApprovalPreviewDependencies
): McpToolApprovalPreviewer {
  return function previewForGeminiMcpTool(
    toolName,
    args,
    cwd,
    context,
    parentProvider = 'gemini'
  ): McpToolApprovalPreview {
    const providerName = deps.providerDisplayName(parentProvider)
    const intent = deps.optionalString(
      args.intent || args.summary || args.reason || args.description
    )
    const intentBody = intent ? `Intent: ${intent}\n\n` : ''
    const intentPreview = intent ? { intent } : {}

    // Outlook: the user must see WHO a draft addresses and WHAT it says
    // before approving, not a JSON blob. Reads name the mailbox scope.
    if (toolName === 'outlook_create_draft') {
      const to = deps.optionalString(args.to) || '(no recipients)'
      const subject = deps.optionalString(args.subject) || '(no subject)'
      const body = deps.optionalString(args.body) || ''
      return {
        title: `Approve ${providerName} Outlook draft`,
        body:
          `${intentBody}Saves a DRAFT — nothing is sent.\n` +
          `To: ${to}\nSubject: ${subject}\n\n${body.slice(0, 2_000)}`.trim(),
        service: 'mcpTools',
        preview: { ...intentPreview, to, subject, body: body.slice(0, 2_000) }
      }
    }
    if (toolName === 'outlook_create_event') {
      const subject = deps.optionalString(args.subject) || '(no title)'
      const window = `${deps.optionalString(args.startIso) || '?'} → ${
        deps.optionalString(args.endIso) || '?'
      }`
      return {
        title: `Approve ${providerName} calendar entry`,
        body: `${intentBody}Creates a calendar entry with no attendees, so no invitations are sent.\n${subject}\n${window}`,
        service: 'mcpTools',
        preview: { ...intentPreview, subject, window }
      }
    }
    if (
      toolName === 'outlook_list_messages' ||
      toolName === 'outlook_search_messages' ||
      toolName === 'outlook_get_message' ||
      toolName === 'outlook_list_events'
    ) {
      const detail =
        deps.optionalString(args.query) ||
        deps.optionalString(args.messageId) ||
        deps.optionalString(args.folder) ||
        [deps.optionalString(args.startIso), deps.optionalString(args.endIso)]
          .filter(Boolean)
          .join(' → ')
      return {
        title: `Approve ${providerName} Outlook read`,
        body: `${intentBody}${toolName}${detail ? `\n${detail}` : ''}`.trim(),
        service: 'mcpTools',
        preview: { ...intentPreview, tool: toolName, detail }
      }
    }

    if (deps.mediaEditingTools.has(toolName)) {
      const isAnalyze = toolName === 'audio_analyze'
      const isRender = toolName === 'audio_render_wav'
      return {
        title: `Approve ${providerName} media ${
          isAnalyze ? 'analysis' : isRender ? 'render' : 'edit'
        }`,
        body: `${intentBody}${toolName} ${String(args.sourcePath || args.waveform || '')}`.trim(),
        service: 'mediaEditing',
        preview: {
          kind: 'tool',
          toolName,
          params: args,
          ...intentPreview
        }
      }
    }

    if (toolName === 'run_shell_command') {
      const command = String(args.command || '')
      const ollamaShellMetadata =
        parentProvider === 'ollama' ? deps.ollamaShellApprovalPreviewMetadata(command) : {}
      return {
        title: `Approve ${providerName} shell command`,
        body: `${intentBody}${command}\n${cwd}`,
        service: 'shellCommands',
        preview: {
          kind: 'command',
          command,
          cwd,
          ...ollamaShellMetadata,
          ...intentPreview
        }
      }
    }

    if (toolName === 'run_task') {
      const command = Array.isArray(args.command)
        ? args.command.map((part) => String(part)).join(' ')
        : String(args.command || args.task || args.script || '')
      return {
        title: 'Approve task run',
        body: `${command}\n${cwd}`,
        service: 'shellCommands',
        preview: {
          kind: 'command',
          command,
          cwd
        }
      }
    }

    if (toolName === 'start_background_process') {
      const command = String(args.command || '')
      return {
        title: `Approve ${providerName} background process`,
        body: `${intentBody}${command}\n${cwd}`,
        service: 'shellCommands',
        preview: {
          kind: 'command',
          command,
          cwd,
          ...intentPreview
        }
      }
    }

    if (toolName === 'kill_background_process') {
      const processId = String(args.processId || args.id || '')
      const signal = String(args.signal || 'SIGTERM')
      return {
        title: `Approve ${providerName} background process termination`,
        body: `${intentBody}${processId}${signal ? ` (${signal})` : ''}`.trim(),
        service: 'shellCommands',
        preview: {
          kind: 'tool',
          toolName,
          params: args,
          ...intentPreview
        }
      }
    }

    if (toolName === 'launch_start' || toolName === 'launch_stop') {
      const ref = String(args.targetId || args.attemptId || '')
      return {
        title:
          toolName === 'launch_start' ? 'Approve Run-Button launch' : 'Approve stopping a launch',
        body: `${toolName}${ref ? ` ${ref}` : ''}`,
        service: 'shellCommands',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    if (toolName === 'get_diagnostics') {
      const source = String(args.source || args.kind || (args.includeLint ? 'all' : 'typescript'))
      const target = String(args.path || args.file || args.project || '.')
      return {
        title: 'Approve diagnostics run',
        body: `${intentBody}${source} diagnostics for ${target}\n${cwd}`,
        service: 'shellCommands',
        preview: {
          kind: 'command',
          command: `get_diagnostics ${source} ${target}`.trim(),
          cwd,
          ...intentPreview
        }
      }
    }

    if (
      toolName === 'image_edit' ||
      toolName === 'svg_rasterize' ||
      toolName === 'image_generate'
    ) {
      let title: string
      let summary: string
      if (toolName === 'image_generate') {
        const provider = String(args.provider || '')
        const endpoint =
          provider === 'xai'
            ? 'api.x.ai'
            : provider === 'openai'
              ? 'api.openai.com'
              : 'the configured image provider'
        title = `Approve ${providerName} image generation`
        summary = `Generate via ${endpoint}\nPrompt: ${String(args.prompt || '').slice(0, 2000)}`
      } else if (toolName === 'image_edit') {
        title = `Approve ${providerName} image edit`
        summary = `op=${String(args.op || '?')} ${String(
          args.sourceMediaId || args.sourcePath || ''
        )}`.trim()
      } else {
        title = `Approve ${providerName} SVG rasterize`
        summary = `${String(args.width || 1024)}x${String(args.height || 768)} SVG -> PNG`
      }
      return {
        title,
        body: `${intentBody}${summary}`,
        service: 'fileChanges',
        preview: {
          kind: 'tool',
          toolName,
          params: args,
          ...intentPreview
        }
      }
    }

    if (toolName === 'write_file' || toolName === 'replace') {
      const filePath = String(args.path || args.file_path || '')
      const previewPath = filePath ? deps.previewPath(context, filePath) : filePath
      const content = String(args.content || '')
      const oldString = String(args.old_string || args.oldString || '')
      const newString = String(args.new_string || args.newString || '')
      const patchPreview =
        parentProvider === 'ollama'
          ? toolName === 'write_file'
            ? deps.ollamaTextDiffPreview(
                previewPath || filePath || 'file',
                deps.readApprovalPreviewFileContent(context, filePath),
                content
              )
            : deps.ollamaTextDiffPreview(previewPath || filePath || 'file', oldString, newString)
          : toolName === 'replace'
            ? [
                `--- old_string`,
                oldString.slice(0, 2000),
                `+++ new_string`,
                newString.slice(0, 2000)
              ].join('\n')
            : content.slice(0, 2000)
      return {
        title:
          toolName === 'write_file'
            ? `Approve ${providerName} file write`
            : `Approve ${providerName} file edit`,
        body: `${intentBody}${previewPath || toolName}`,
        service: 'fileChanges',
        preview: {
          kind: 'fileChange',
          toolName,
          planArtifactRawPath: filePath,
          changes: [{ kind: toolName === 'write_file' ? 'write' : 'replace', path: previewPath }],
          ...intentPreview,
          patchPreview
        }
      }
    }

    if (
      toolName === 'create_directory' ||
      toolName === 'delete_path' ||
      toolName === 'move_path' ||
      toolName === 'rename_path'
    ) {
      const previewPath = (rawPath: unknown): string => {
        const filePath = typeof rawPath === 'string' ? rawPath : ''
        return filePath ? deps.previewPath(context, filePath) : ''
      }
      const source = previewPath(
        args.path || args.from || args.source || args.sourcePath || args.directory || args.file
      )
      const destination = previewPath(
        args.to || args.destination || args.destinationPath || args.target
      )
      const newName = deps.optionalString(args.newName || args.name)
      const actionLabel =
        toolName === 'create_directory'
          ? 'directory create'
          : toolName === 'delete_path'
            ? 'path delete'
            : toolName === 'move_path'
              ? 'path move'
              : 'path rename'
      const changes =
        toolName === 'move_path'
          ? [
              { kind: 'move', path: source },
              { kind: 'move', path: destination }
            ]
          : toolName === 'rename_path'
            ? [{ kind: 'rename', path: `${source} -> ${newName || ''}`.trim() }]
            : [{ kind: toolName === 'delete_path' ? 'delete' : 'mkdir', path: source }]
      const detail =
        toolName === 'move_path'
          ? `${source} -> ${destination}`
          : toolName === 'rename_path'
            ? `${source} -> ${newName || ''}`
            : source
      return {
        title: `Approve ${providerName} ${actionLabel}`,
        body: `${intentBody}${detail || toolName}`,
        service: 'fileChanges',
        preview: {
          kind: 'fileChange',
          changes,
          ...intentPreview
        }
      }
    }

    if (toolName === 'apply_patch') {
      const patch = String(args.patch || args.diff || '')
      return {
        title:
          args.dryRun === true || args.check === true
            ? 'Preview patch application'
            : 'Approve patch application',
        body: `${intentBody}${cwd}\n${patch.slice(0, 1000)}`,
        service: 'fileChanges',
        preview: {
          kind: 'fileChange',
          changes: [],
          ...intentPreview,
          patchPreview: patch.slice(0, 4000)
        }
      }
    }

    if (
      toolName === 'git_stage' ||
      toolName === 'git_commit' ||
      toolName === 'git_push' ||
      toolName === 'git_create_pr'
    ) {
      const actionLabel =
        toolName === 'git_stage'
          ? 'git stage'
          : toolName === 'git_commit'
            ? 'git commit'
            : toolName === 'git_push'
              ? 'git push'
              : 'GitHub pull request'
      const body =
        toolName === 'git_stage'
          ? JSON.stringify(args)
          : toolName === 'git_commit'
            ? String(args.message || '')
            : toolName === 'git_push'
              ? `remote=${String(args.remote || 'upstream/default')} setUpstream=${args.setUpstream === true}`
              : `title=${String(args.title || '(fill from commits)').slice(0, 300)} draft=${args.draft === true}`
      return {
        title: `Approve ${actionLabel}`,
        body,
        service:
          toolName === 'git_push' || toolName === 'git_create_pr'
            ? 'externalPublish'
            : 'fileChanges',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    if (toolName === 'workspace_board_apply_plan') {
      const plan = deps.isRecord(args.plan) ? args.plan : args
      const cards = Array.isArray(plan.cards) ? plan.cards.length : 0
      const boardLabel = String(plan.name || plan.boardId || 'active workspace board')
      return {
        title: `Approve ${providerName} workspace board update`,
        body: `${intentBody}${boardLabel}\n${cards} card proposal${cards === 1 ? '' : 's'}`,
        service: 'mcpTools',
        preview: {
          kind: 'tool',
          toolName,
          params: {
            boardId: plan.boardId,
            name: plan.name,
            cards
          },
          ...intentPreview
        }
      }
    }

    if (toolName === 'cancel_subthread') {
      return {
        title: 'Approve sub-thread cancellation',
        body: `Sub-thread: ${String(args.subThreadId || args.id || '')}`,
        service: 'subThreadDelegation',
        preview: {
          kind: 'tool',
          toolName,
          params: {
            subThreadId: args.subThreadId || args.id,
            reason: args.reason
          }
        }
      }
    }

    if (toolName === 'web_search' || toolName === 'web_fetch' || toolName === 'github_ci_status') {
      const queryOrUrl =
        toolName === 'web_search'
          ? String(args.query || args.q || '')
          : toolName === 'web_fetch'
            ? String(args.url || args.uri || '')
            : String(args.pr || args.branch || args.commitSha || 'current PR/branch')
      return {
        title:
          toolName === 'web_search'
            ? `Approve ${providerName} web search`
            : toolName === 'web_fetch'
              ? `Approve ${providerName} web fetch`
              : `Approve ${providerName} GitHub CI status check`,
        body: queryOrUrl,
        service: 'mcpTools',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    if (toolName === 'attached_window_capture') {
      const meta = deps.getAttachedWindowMeta()
      const label = meta
        ? `${meta.applicationName || meta.bundleID || 'window'}: ${meta.title || '(untitled)'}`
        : 'no window attached'
      return {
        title: 'Capture attached window',
        body: label,
        service: 'mcpTools',
        preview: {
          kind: 'tool',
          toolName,
          params: { windowMeta: meta || null, args }
        }
      }
    }

    if (
      toolName === 'appwatch_start' ||
      toolName === 'appwatch_stop' ||
      toolName === 'appwatch_latest_frame' ||
      toolName === 'appwatch_frames'
    ) {
      const meta = deps.getAttachedWindowMeta()
      const label = meta
        ? `${meta.applicationName || meta.bundleID || 'window'}: ${meta.title || '(untitled)'}`
        : 'no window attached'
      const title =
        toolName === 'appwatch_start'
          ? 'Start live window capture'
          : toolName === 'appwatch_stop'
            ? 'Stop live window capture'
            : toolName === 'appwatch_frames'
              ? 'Pull live frame batch'
              : 'Pull latest live frame'
      return {
        title,
        body: label,
        service: 'mcpTools',
        preview: {
          kind: 'tool',
          toolName,
          params: { windowMeta: meta || null, args }
        }
      }
    }

    if (
      toolName === 'canvas_click' ||
      toolName === 'canvas_fill' ||
      toolName === 'canvas_sketch_update'
    ) {
      return {
        title: `Approve ${providerName} canvas interaction`,
        body: toolName,
        service: 'canvasInteraction',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    if (
      toolName === 'tw_recall_find' ||
      toolName === 'tw_recall_read' ||
      toolName === 'tw_recall_read_events'
    ) {
      return {
        title: `Approve ${providerName} cross-thread read`,
        body: toolName,
        service: 'crossThreadRead',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    if (toolName === 'canvas_eval') {
      return {
        title: `Approve ${providerName} canvas eval (runs JavaScript)`,
        body: toolName,
        service: 'canvasEval',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    return {
      title: `Approve ${providerName} tool call`,
      body: toolName,
      service: 'mcpTools',
      preview: {
        kind: 'tool',
        toolName,
        params: args
      }
    }
  }
}
