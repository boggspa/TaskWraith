import {
  codexShellCommandFromApprovalParams,
  codexToolArgumentsFromApprovalParams
} from '../NativeApprovalPolicy'
import { codexCommandText, codexString } from './CodexEventFormatting'

export interface CodexShellApprovalPresentation {
  title: string
  body: string
  preview: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = codexString(value).trim()
    if (text) return text
  }
  return ''
}

/**
 * Lift exact command evidence out of Codex MCP elicitation metadata for the
 * approval card. This is presentation-only: the caller first resolves the
 * structural service and permission decision from the original payload.
 */
export function codexShellApprovalPresentation(
  paramsValue: unknown,
  previewValue: unknown
): CodexShellApprovalPresentation | null {
  const command = codexCommandText(codexShellCommandFromApprovalParams(paramsValue)).trim()
  if (!command) return null

  const params = record(paramsValue)
  const toolArguments = record(codexToolArgumentsFromApprovalParams(paramsValue))
  const exec = record(params?.exec)
  const item = record(params?.item)
  const cwd = firstText(
    toolArguments?.cwd,
    toolArguments?.workdir,
    params?.cwd,
    params?.workdir,
    exec?.cwd,
    item?.cwd
  )
  const preview = record(previewValue) ?? {}

  return {
    title: 'Approve Codex shell command',
    body: cwd ? `${command}\n${cwd}` : command,
    preview: {
      ...preview,
      kind: 'command',
      command,
      ...(cwd ? { cwd } : {})
    }
  }
}
