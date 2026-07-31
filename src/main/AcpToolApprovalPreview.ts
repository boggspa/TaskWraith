/**
 * Build a structured approval preview for ACP-native tool permission requests.
 *
 * These previews are sent to the renderer and to paired devices. They are also
 * persisted in durable run events and the approval ledger, so they deliberately
 * carry the MINIMUM structured detail needed to render the card. Raw tool
 * arguments live in the transient desktop `body` and are not duplicated here.
 */

import { extractShellCommandFromToolCall } from './grok/GrokReadOnlyShell'
import type { AgenticServiceId } from './store/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function planArtifactRawPathFromToolInput(input: unknown, depth = 0): string | null {
  if (!isRecord(input) || depth > 1) return null
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'target_path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  for (const key of ['input', 'arguments', 'params', 'payload']) {
    const nestedPath = planArtifactRawPathFromToolInput(input[key], depth + 1)
    if (nestedPath) return nestedPath
  }
  return null
}

export interface AcpToolApprovalPreview {
  kind: 'command' | 'fileChange' | 'tool'
  command?: string
  cwd?: string
  toolName?: string
  planArtifactRawPath?: string
  changes?: Array<{ kind: 'write' | 'edit'; path: string }>
}

export function buildAcpToolApprovalPreview(options: {
  toolName: string
  rawToolCall: unknown
  service: AgenticServiceId
  cwd?: string
}): AcpToolApprovalPreview {
  const { toolName, rawToolCall, service, cwd } = options

  if (service === 'shellCommands') {
    const command = extractShellCommandFromToolCall(rawToolCall) ?? ''
    return {
      kind: 'command',
      command,
      cwd
    }
  }

  if (service === 'fileChanges') {
    const path = planArtifactRawPathFromToolInput(rawToolCall) ?? ''
    return {
      kind: 'fileChange',
      toolName,
      ...(path ? { planArtifactRawPath: path } : {}),
      changes: path
        ? [{ kind: toolName.toLowerCase().includes('write') ? 'write' : 'edit', path }]
        : []
    }
  }

  return {
    kind: 'tool',
    toolName
  }
}

/**
 * Strip argument payloads from a preview before durable storage.
 *
 * The live desktop card needs structured detail (and gets it via the live
 * approval payload), but the durable run event and approval ledger only need
 * enough to identify what was approved. Tool arguments can carry secrets
 * (tokens, file contents, env values), so we keep only kind, command, cwd,
 * toolName, and file-change paths. Outlook recipient-bearing previews are
 * preserved because they are the remote-card payload and already bounded by
 * RemoteApprovalSummary.
 */
export function redactAcpApprovalPreviewForDurableStorage(
  preview: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(preview)) return undefined
  const kind = typeof preview.kind === 'string' ? preview.kind : undefined
  const toolName = typeof preview.toolName === 'string' ? preview.toolName : undefined

  if (kind === 'command') {
    return {
      kind,
      command: typeof preview.command === 'string' ? preview.command : undefined,
      cwd: typeof preview.cwd === 'string' ? preview.cwd : undefined
    }
  }

  if (kind === 'fileChange') {
    return {
      kind,
      toolName,
      planArtifactRawPath:
        typeof preview.planArtifactRawPath === 'string' ? preview.planArtifactRawPath : undefined,
      changes: Array.isArray(preview.changes) ? preview.changes : undefined
    }
  }

  if (toolName === 'canvas_fill' || toolName?.startsWith('outlook_')) {
    // canvas_fill has its own dedicated durable redactor; outlook recipient-
    // bearing previews are already bounded by RemoteApprovalSummary. Keep the
    // original shape so the existing redactors can do their job.
    return { ...preview }
  }

  return {
    kind,
    toolName
  }
}
