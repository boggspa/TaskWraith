import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { projectBlackboardDeleteResultForModel } from '../blackboard/BlackboardDeleteReceipt'
export const MAX_MCP_TEXT_CHARS = 200_000

export function mcpJson(value: unknown): string {
  const text = JSON.stringify(projectBlackboardDeleteResultForModel(value), null, 2)
  if (text.length <= MAX_MCP_TEXT_CHARS) return text
  return JSON.stringify(
    {
      truncated: true,
      originalLength: text.length,
      preview: text.slice(0, MAX_MCP_TEXT_CHARS)
    },
    null,
    2
  )
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function normalizeMcpToolArguments(value: unknown): Record<string, any> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value }
    } catch {
      return { value }
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>
  }
  return { value }
}

export function isTaskWraithMcpToolName(value: unknown): value is TaskWraithMcpToolName {
  return TASKWRAITH_MCP_TOOLS.includes(value as TaskWraithMcpToolName)
}
