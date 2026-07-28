import type { GeminiToolContext } from './runStateTypes'
import type { TaskWraithMcpToolName } from './TaskWraithMcpTools'
import type { AgenticServiceId, ProviderId } from './store/types'
import { outlookRecipientList } from './mcp/OutlookToolExecutors'
import { MESH_SCENE_MCP_TOOL_NAMES } from './TaskWraithMcpTools'

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
/**
 * How much agent-authored mail/event text the approval renders inline.
 *
 * The executor accepts far more than this (100k for a draft body, 32k for an
 * event). Rather than silently showing a prefix — which let 2k of innocuous
 * text stand in for 100k of anything — the remainder is DISCLOSED with an
 * exact count, so a reviewer can decline what they cannot see.
 */
export const OUTLOOK_PREVIEW_BODY_LIMIT = 8_000
/** Mirrors the executor's own caps in OutlookToolExecutors. */
const OUTLOOK_SUBJECT_LIMIT = 4_000
const OUTLOOK_LOCATION_LIMIT = 4_000
const OUTLOOK_DRAFT_BODY_LIMIT = 100_000
const OUTLOOK_EVENT_BODY_LIMIT = 32_000

export function outlookHiddenNotice(hidden: number): string {
  return `[${hidden.toLocaleString('en-US')} more characters WILL BE WRITTEN but are not shown here]`
}

export interface OutlookPreviewBody {
  text: string
  /** Characters the executor will write that the preview does not show. */
  hidden: number
}

/**
 * Split an agent-authored body into what the approval shows and how much it
 * is withholding.
 *
 * The count is against what the EXECUTOR will actually write, not the raw
 * argument: it clamps to `writeLimit`, so measuring the argument overstated a
 * 200k body by a full 100k. Code points, not UTF-16 units, so 20k emoji are
 * not reported as 40k — and slicing by code point cannot strand half a
 * surrogate pair at the cut.
 *
 * The count is returned SEPARATELY rather than appended: an in-band notice is
 * indistinguishable from the same sentence typed into the body itself, and
 * the preview `<pre>` shows about ten lines, so a forged marker on line ten
 * hides the payload behind a scroll the reviewer was just told was empty.
 */
export function outlookPreviewBody(value: string, writeLimit: number): OutlookPreviewBody {
  const written = Array.from(value).slice(0, writeLimit)
  const shown = written.slice(0, OUTLOOK_PREVIEW_BODY_LIMIT)
  return { text: shown.join(''), hidden: written.length - shown.length }
}

/**
 * Clamp a preview field to what the executor accepts.
 *
 * Preview and executor caps must agree in BOTH directions: a field the
 * preview renders beyond the executor's limit is text the approver reads and
 * the write silently drops, and it is also an amplifier — every character can
 * expand ~44× through the codepoint reviewer.
 */
function clampField(value: string | undefined, limit: number): string {
  return (value || '').slice(0, limit)
}

/**
 * Whether a field is non-empty for the EXECUTOR, which does not trim.
 *
 * `optionalString` treats whitespace as absent, so a subject of 4,000
 * newlines rendered as "(no subject)" while 4,000 newlines were written.
 */
function writtenOrPlaceholder(raw: unknown, placeholder: string): string {
  return typeof raw === 'string' && raw.length > 0 ? raw : placeholder
}

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
    // Clamped: `optionalString` does not truncate, and this string is
    // prepended to EVERY tool's approval body. An agent-authored intent of
    // arbitrary length is a lever on the size of the approval card itself.
    const rawIntent = deps.optionalString(
      args.intent || args.summary || args.reason || args.description
    )
    const intent = rawIntent ? rawIntent.slice(0, 600) : undefined
    const intentBody = intent ? `Intent: ${intent}\n\n` : ''
    const intentPreview = intent ? { intent } : {}

    // Outlook: the user must see WHO a draft addresses before approving.
    // Recipients are formatted with the SAME parser the executor uses, so
    // the prompt can never disagree with what is written — including the
    // array form, which a plain string coercion would render as empty.
    if (toolName === 'outlook_create_draft') {
      const to = outlookRecipientList(args.to)
      const cc = outlookRecipientList(args.cc)
      const subject = clampField(
        writtenOrPlaceholder(args.subject, '(no subject)'),
        OUTLOOK_SUBJECT_LIMIT
      )
      const body = outlookPreviewBody(
        typeof args.body === 'string' ? args.body : '',
        OUTLOOK_DRAFT_BODY_LIMIT
      )
      const recipientLines =
        `To: ${to.length > 0 ? to.join(', ') : '(no recipients)'}\n` +
        // cc is only shown when present, but it is NEVER omitted when set —
        // a hidden cc is how an injected instruction would exfiltrate.
        (cc.length > 0 ? `Cc: ${cc.join(', ')}\n` : '')
      return {
        title: `Approve ${providerName} Outlook draft`,
        body:
          `${intentBody}Saves a DRAFT — nothing is sent.\n` +
          `${recipientLines}Subject: ${subject}\n\n${body.text}`.trim() +
          (body.hidden > 0 ? `\n\n${outlookHiddenNotice(body.hidden)}` : ''),
        service: 'mcpTools',
        // `kind: 'tool'` + `params` is the shape the renderer displays as a
        // structured block; a bare object renders nothing at all.
        preview: {
          kind: 'tool',
          toolName,
          params: {
            to,
            cc,
            subject,
            body: body.text,
            // Structured, so the renderer can show it OUTSIDE the body block
            // where an agent cannot imitate it.
            ...(body.hidden > 0 ? { hiddenBodyCharacters: body.hidden } : {})
          },
          ...intentPreview
        }
      }
    }
    if (toolName === 'outlook_create_event') {
      const subject = clampField(
        writtenOrPlaceholder(args.subject, '(no title)'),
        OUTLOOK_SUBJECT_LIMIT
      )
      const window = `${deps.optionalString(args.startIso) || '?'} → ${
        deps.optionalString(args.endIso) || '?'
      }`
      // location and body are written to the calendar entry, so they belong in
      // the approval. Showing only subject+window meant 32k of agent-authored
      // event text went in unseen.
      const location = clampField(
        typeof args.location === 'string' ? args.location : '',
        OUTLOOK_LOCATION_LIMIT
      )
      const body = outlookPreviewBody(
        typeof args.body === 'string' ? args.body : '',
        OUTLOOK_EVENT_BODY_LIMIT
      )
      return {
        title: `Approve ${providerName} calendar entry`,
        body: `${intentBody}Creates a calendar entry with no attendees, so no invitations are sent.\n${subject}\n${window}${
          location ? `\n${location}` : ''
        }${body.text ? `\n\n${body.text}` : ''}${
          body.hidden > 0 ? `\n\n${outlookHiddenNotice(body.hidden)}` : ''
        }`,
        service: 'mcpTools',
        preview: {
          kind: 'tool',
          toolName,
          params: {
            subject,
            window,
            location,
            body: body.text,
            ...(body.hidden > 0 ? { hiddenBodyCharacters: body.hidden } : {})
          },
          ...intentPreview
        }
      }
    }
    if (
      toolName === 'outlook_list_messages' ||
      toolName === 'outlook_search_messages' ||
      toolName === 'outlook_get_message' ||
      toolName === 'outlook_list_events'
    ) {
      const detail =
        clampField(deps.optionalString(args.query), 400) ||
        clampField(deps.optionalString(args.messageId), 512) ||
        clampField(deps.optionalString(args.folder), 32) ||
        [deps.optionalString(args.startIso), deps.optionalString(args.endIso)]
          .filter(Boolean)
          .join(' → ')
      return {
        title: `Approve ${providerName} Outlook read`,
        body: `${intentBody}${toolName}${detail ? `\n${detail}` : ''}`.trim(),
        service: 'mcpTools',
        // `toolName` (not `tool`): the run-level network deny reads exactly
        // this key to classify the call, so a different name silently opts
        // these reads out of the offline kill switch.
        preview: { kind: 'tool', toolName, params: { detail }, ...intentPreview }
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

    if (toolName === 'canvas_click' || toolName === 'canvas_fill') {
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

    if (toolName === 'canvas_sketch_update') {
      return {
        title: `Approve ${providerName} Sketch Canvas edit`,
        body: toolName,
        service: 'sketchCanvas',
        preview: {
          kind: 'tool',
          toolName,
          params: args
        }
      }
    }

    if ((MESH_SCENE_MCP_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return {
        title: `Approve ${providerName} Mesh Canvas action`,
        body: toolName,
        service: 'meshCanvas',
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
