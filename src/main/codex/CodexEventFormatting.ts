export function codexTimelineItemId(params: any, fallbackPrefix: string): string {
  const item = params?.item
  const rawId = params?.itemId || params?.item_id || item?.id || params?.id
  if (typeof rawId === 'string' && rawId.trim()) return rawId
  return fallbackPrefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
}

export function codexString(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(codexString).filter(Boolean).join('')
  if (value === undefined || value === null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    const nested = value.text || value.delta || value.content || value.output || value.value
    if (nested !== undefined) return codexString(nested)
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

export const CODEX_REASONING_SUMMARY_MODE = 'auto'

export function codexReasoningSummaryModeForEffort(
  effort: string | null | undefined
): typeof CODEX_REASONING_SUMMARY_MODE | undefined {
  const normalized = String(effort || '').trim().toLowerCase()
  if (!normalized || normalized === 'off' || normalized === 'none') return undefined
  return CODEX_REASONING_SUMMARY_MODE
}

export function codexReasoningSummaryText(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(codexReasoningSummaryText).filter(Boolean).join('')
  if (!value || typeof value !== 'object') return ''
  if (value.type === 'summary_text' && typeof value.text === 'string') return value.text
  if (typeof value.summary === 'string') return value.summary
  if (Array.isArray(value.summary)) return codexReasoningSummaryText(value.summary)
  if (
    (value.kind === 'summary_text' || value.type === 'reasoning_summary_text') &&
    typeof value.text === 'string'
  ) {
    return value.text
  }
  if (
    (value.kind === 'summary_text' ||
      value.type === 'summary_text' ||
      value.type === 'reasoning_summary_text') &&
    typeof value.delta === 'string'
  ) {
    return value.delta
  }
  return ''
}

export function codexCommandText(command: any): string {
  if (Array.isArray(command)) return command.map(codexString).join(' ')
  return codexString(command)
}

function shellQuoteTrim(value: string): string {
  return value.trim().replace(/^['"`]+|['"`]+$/g, '')
}

function codexCommandEditPath(command: string): string {
  const gitAddPatch = command.match(/\bgit\s+add\s+-p\s+(.+?)(?:\s*(?:&&|;|\||$))/)
  if (gitAddPatch?.[1]) return shellQuoteTrim(gitAddPatch[1])
  const fileFlag = command.match(/(?:^|\s)(?:--file|-f|--path)\s+(['"]?)([^'"\s]+)\1/)
  if (fileFlag?.[2]) return shellQuoteTrim(fileFlag[2])
  return ''
}

function looksLikePatchText(value: string): boolean {
  if (!value.trim()) return false
  return (
    /^diff --git /m.test(value) ||
    /^@@\s+-\d+/m.test(value) ||
    /^\*\*\* Begin Patch/m.test(value) ||
    /^---\s+(?:a\/|old|\/)/m.test(value)
  )
}

export function codexCommandFileEditMetadata(
  command: string,
  output = ''
): { toolName: string; parameters: Record<string, unknown> } | null {
  const normalized = command.toLowerCase()
  const commandSuggestsPatch =
    normalized.includes('apply_patch') ||
    normalized.includes('git add -p') ||
    normalized.includes('git apply') ||
    normalized.includes('patch -p')
  const patchPreview = looksLikePatchText(output) ? output : ''
  if (!commandSuggestsPatch && !patchPreview) return null
  const path = codexCommandEditPath(command)
  return {
    toolName: 'edit_file',
    parameters: {
      ...(path ? { path, changes: [{ kind: 'edit', path }] } : {}),
      command,
      ...(patchPreview ? { patchPreview } : {})
    }
  }
}

export function summarizeCodexFileChanges(changes: any[]): string {
  if (!Array.isArray(changes) || changes.length === 0) return 'File change pending.'
  return changes
    .map((change) => {
      const kind = codexString(change?.kind || change?.type || change?.operation || 'update')
      const filePath = codexString(
        change?.path || change?.filePath || change?.file_path || change?.target || ''
      )
      const additions = Number(change?.additions || change?.added || 0)
      const deletions = Number(change?.deletions || change?.deleted || 0)
      const stats = additions || deletions ? ' (+' + additions + ' -' + deletions + ')' : ''
      return (kind + (filePath ? ' ' + filePath : '') + stats).trim()
    })
    .filter(Boolean)
    .join('\\n')
}

export function codexPatchPreviewFromValue(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(codexPatchPreviewFromValue).filter(Boolean).join('\\n')
  if (!value || typeof value !== 'object') return ''
  const direct =
    value.diff ||
    value.patch ||
    value.unifiedDiff ||
    value.unified_diff ||
    value.preview ||
    value.output
  if (direct !== undefined) return codexPatchPreviewFromValue(direct)
  if (Array.isArray(value.changes)) return codexPatchPreviewFromValue(value.changes)
  return summarizeCodexFileChanges([value])
}

export function codexToolUseFromItem(item: any): any | null {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'commandExecution') {
    const command = codexCommandText(item.command || '')
    const editMetadata = codexCommandFileEditMetadata(
      command,
      codexString(item.aggregatedOutput || item.output || item.stdout || item.stderr || '')
    )
    if (editMetadata) {
      return {
        type: 'tool_use',
        tool_id: item.id,
        tool_name: editMetadata.toolName,
        parameters: editMetadata.parameters,
        provider: 'codex'
      }
    }
    return {
      type: 'tool_use',
      tool_id: item.id,
      tool_name: 'run_shell_command',
      parameters: {
        command,
        cwd: item.cwd || ''
      },
      provider: 'codex'
    }
  }
  if (item.type === 'fileChange') {
    const firstChange = Array.isArray(item.changes) ? item.changes[0] : undefined
    const kind = firstChange?.kind || 'update'
    const toolName =
      kind === 'create' || kind === 'add'
        ? 'create_file'
        : kind === 'delete'
          ? 'delete_file'
          : 'edit_file'
    return {
      type: 'tool_use',
      tool_id: item.id,
      tool_name: toolName,
      parameters: {
        path: firstChange?.path || '',
        changes: item.changes || []
      },
      provider: 'codex'
    }
  }
  if (item.type === 'mcpToolCall') {
    return {
      type: 'tool_use',
      tool_id: item.id,
      tool_name: item.tool || 'mcp_tool',
      parameters: item.arguments || {},
      provider: 'codex',
      server: item.server
    }
  }
  if (item.type === 'dynamicToolCall') {
    return {
      type: 'tool_use',
      tool_id: item.id,
      tool_name: item.tool || 'dynamic_tool',
      parameters: item.arguments || {},
      provider: 'codex',
      namespace: item.namespace
    }
  }
  return null
}

export function codexToolResultFromItem(item: any): any | null {
  if (!item || typeof item !== 'object') return null
  if (item.type === 'commandExecution') {
    const output = item.aggregatedOutput || ''
    const command = codexCommandText(item.command || '')
    const editMetadata = codexCommandFileEditMetadata(
      command,
      codexString(output || item.output || item.stdout || item.stderr || '')
    )
    return {
      type: 'tool_result',
      tool_id: item.id,
      tool_name: editMetadata?.toolName || 'run_shell_command',
      status:
        item.status === 'failed' ? 'error' : item.status === 'declined' ? 'warning' : 'success',
      output,
      result: {
        exitCode: item.exitCode,
        durationMs: item.durationMs
      },
      provider: 'codex'
    }
  }
  if (item.type === 'fileChange') {
    return {
      type: 'tool_result',
      tool_id: item.id,
      tool_name: codexToolUseFromItem(item)?.tool_name || 'edit_file',
      status:
        item.status === 'failed' ? 'error' : item.status === 'declined' ? 'warning' : 'success',
      output: Array.isArray(item.changes)
        ? item.changes
            .map((change: any) => `${change.kind || 'update'} ${change.path || ''}`)
            .join('\n')
        : '',
      result: item,
      provider: 'codex'
    }
  }
  if (item.type === 'mcpToolCall') {
    return {
      type: 'tool_result',
      tool_id: item.id,
      tool_name: item.tool || 'mcp_tool',
      status: item.status === 'failed' ? 'error' : 'success',
      output: item.error ? JSON.stringify(item.error) : JSON.stringify(item.result || {}),
      result: item.result || item.error || {},
      provider: 'codex'
    }
  }
  if (item.type === 'dynamicToolCall') {
    return {
      type: 'tool_result',
      tool_id: item.id,
      tool_name: item.tool || 'dynamic_tool',
      status: item.success === false || item.status === 'failed' ? 'error' : 'success',
      output: JSON.stringify(item.contentItems || {}),
      result: item,
      provider: 'codex'
    }
  }
  return null
}
