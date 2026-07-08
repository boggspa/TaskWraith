import type { AgentRunRoute } from '../run/AgentRunTypes'
import { canonicalTaskWraithToolName } from '../TaskWraithMcpTools'

export interface CodexMcpRouteHint {
  itemId: string
  toolName: string
  args: unknown
  route: AgentRunRoute
  startedAtMs: number
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((out, key) => {
        out[key] = sortJsonValue((value as Record<string, unknown>)[key])
        return out
      }, {})
  }
  return value
}

export function codexMcpRoutingKey(toolName: string, args: unknown): string {
  return JSON.stringify({
    toolName: canonicalTaskWraithToolName(toolName),
    args: sortJsonValue(args)
  })
}

export function resolveCodexMcpRouteHint(args: {
  hints: CodexMcpRouteHint[]
  nowMs: number
  toolName: string
  args: unknown
  maxAgeMs: number
}): AgentRunRoute | null {
  const wantedKey = codexMcpRoutingKey(args.toolName, args.args)
  const matches = args.hints.filter(
    (hint) =>
      args.nowMs - hint.startedAtMs <= args.maxAgeMs &&
      codexMcpRoutingKey(hint.toolName, hint.args) === wantedKey
  )
  if (matches.length !== 1) return null
  return matches[0].route
}
