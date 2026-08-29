import type { McpToolExecutionResult } from './McpBridgeRuntime'
import type { WebSiteLogin } from '../../shared/webSiteLogin'

/**
 * Agent-facing tools for authorized site sessions.
 *
 * Deliberately two verbs and no more. `web_login_list` is the catalogue an
 * agent needs to know a site exists; `web_login_open` binds a canvas to one.
 * Everything else - adding a site, signing in, granting access, forgetting -
 * is the user's, through Work > Logins, and no tool exists for any of it.
 *
 * THE PROJECTION NEVER CARRIES A SECRET. No cookie, no header, no partition
 * name. A partition string is a capability, so even the derived name stays out
 * of the model's context.
 *
 * See docs/appdrive/authorized-site-sessions.md.
 */

export const WEB_LOGIN_MCP_TOOL_NAMES = ['web_login_list', 'web_login_open'] as const
export type WebLoginMcpToolName = (typeof WEB_LOGIN_MCP_TOOL_NAMES)[number]
const WEB_LOGIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(WEB_LOGIN_MCP_TOOL_NAMES)

export function isWebLoginMcpToolName(value: unknown): value is WebLoginMcpToolName {
  return typeof value === 'string' && WEB_LOGIN_TOOL_NAME_SET.has(value)
}

export interface WebLoginToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
  participantId?: string
}

export interface WebLoginToolExecutorDeps {
  listSites: () => WebSiteLogin[]
  /** Opens a canvas bound to that site. Throws when the site is unknown or the
   *  user has not granted agent access - the resolver is the chokepoint. */
  openBoundCanvas: (input: {
    siteId: string
    url?: string
    context: WebLoginToolContext
    provider: string
  }) => Promise<{ canvasId: string; url?: string }>
}

export interface WebLoginToolExecutors {
  executeWebLoginTool: (
    toolName: WebLoginMcpToolName,
    rawArgs: unknown,
    context: WebLoginToolContext,
    parentProvider: string
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asOptString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function succeed(toolName: WebLoginMcpToolName, value: object): McpToolExecutionResult {
  const payload = { ok: true, tool: toolName, ...value }
  const text = JSON.stringify(payload)
  return { text, structuredContent: payload, content: [{ type: 'text', text }] }
}

function fail(toolName: WebLoginMcpToolName, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

/** The agent-visible row. Note what is absent: no partition, no cookie, no
 *  timestamps that would let a model infer session lifetime. */
function projectSite(site: WebSiteLogin): {
  siteId: string
  label: string
  origin: string
  extraOrigins: string[]
  agentAccess: WebSiteLogin['agentAccess']
  status: WebSiteLogin['status']
} {
  return {
    siteId: site.id,
    label: site.label,
    origin: site.origin,
    extraOrigins: [...site.extraOrigins],
    agentAccess: site.agentAccess,
    status: site.status
  }
}

export function createWebLoginToolExecutors(deps: WebLoginToolExecutorDeps): WebLoginToolExecutors {
  async function executeWebLoginTool(
    toolName: WebLoginMcpToolName,
    rawArgs: unknown,
    context: WebLoginToolContext,
    parentProvider: string
  ): Promise<McpToolExecutionResult> {
    const args = asRecord(rawArgs)
    try {
      switch (toolName) {
        case 'web_login_list': {
          // Sites the user has kept at "no agent access" are omitted entirely.
          // Listing is not acting, but it is reconnaissance: a site the user
          // has not opened to agents should not tell a model it exists.
          const sites = deps
            .listSites()
            .filter((site) => site.agentAccess !== 'off')
            .map(projectSite)
          return succeed(toolName, { sites })
        }
        case 'web_login_open': {
          const siteId = asOptString(args.siteId)
          if (!siteId) {
            return fail(toolName, '`siteId` is required (from web_login_list).')
          }
          const url = asOptString(args.url)
          const opened = await deps.openBoundCanvas({
            siteId,
            ...(url ? { url } : {}),
            context,
            provider: parentProvider
          })
          return succeed(toolName, {
            canvasId: opened.canvasId,
            ...(opened.url ? { url: opened.url } : {}),
            siteId
          })
        }
        default: {
          const exhaustive: never = toolName
          return fail(exhaustive, 'Unsupported site-login tool.')
        }
      }
    } catch (error) {
      return fail(toolName, error instanceof Error ? error.message : String(error))
    }
  }

  return { executeWebLoginTool }
}
