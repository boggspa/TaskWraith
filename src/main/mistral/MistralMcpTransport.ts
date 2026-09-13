import {
  startKimiHttpMcpBridge,
  type KimiHttpMcpBridgeHandle,
  type KimiHttpMcpBridgeOptions
} from '../kimi/KimiHttpMcpBridge'
import type { AcpMcpServerSelectionResult } from '../acp/AcpTurnClient'

const MISTRAL_VIBE_AGENT_NAME = '@mistralai/mistral-vibe'
const MISTRAL_VIBE_HTTP_COMPATIBILITY_FLOOR = [2, 22, 0] as const
const REDACTED_TOKEN = '[redacted-token]'
const BEARER_TOKEN_PATTERN = /\bBearer[ \t]+[A-Za-z0-9._~+/-]+={0,2}/gi
const MISTRAL_MCP_UNAVAILABLE_WARNING_PREFIX = 'Mistral MCP bridge unavailable:'

export interface MistralHttpMcpServer {
  name: string
  type: 'http'
  url: string
  headers: Array<{ name: string; value: string }>
}

export interface MistralMcpTransportSelection {
  transport: 'http' | 'stdio' | 'none'
  servers: unknown[]
  reason:
    | 'advertised-http'
    | 'known-vibe-http'
    | 'explicit-http-disabled'
    | 'runtime-http-unknown'
    | 'http-unavailable'
}

export interface SelectMistralMcpTransportInput {
  initializeResult: unknown
  httpServer?: MistralHttpMcpServer
  stdioServer?: unknown
  getStdioServer?: () => unknown | null | undefined | Promise<unknown | null | undefined>
}

export interface MistralHttpMcpTransportHandle {
  server: MistralHttpMcpServer
  selectMcpTransport: (initializeResult: unknown) => Promise<MistralMcpTransportSelection>
  close: () => Promise<void>
}

export interface StartMistralHttpMcpTransportInput {
  serverName: string
  dispatch: KimiHttpMcpBridgeOptions['dispatch']
  getStdioServer?: SelectMistralMcpTransportInput['getStdioServer']
  startBridge?: (options: KimiHttpMcpBridgeOptions) => Promise<KimiHttpMcpBridgeHandle>
}

export interface MistralAcpMcpSelectionInput {
  selection: MistralMcpTransportSelection
  prompt: string
  sanitizePrompt: (prompt: string) => string
  httpTransportSetupFailed?: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parsedVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  const parts = match.slice(1, 4).map(Number)
  return parts.every(Number.isSafeInteger) ? [parts[0]!, parts[1]!, parts[2]!] : null
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!
  }
  return true
}

function knownVibeHttpRuntime(initializeResult: unknown): boolean {
  const result = record(initializeResult)
  const agentInfo = record(result?.agentInfo)
  const name = typeof agentInfo?.name === 'string' ? agentInfo.name.trim().toLowerCase() : ''
  const version = parsedVersion(agentInfo?.version)
  return Boolean(
    name === MISTRAL_VIBE_AGENT_NAME &&
    version &&
    versionAtLeast(version, MISTRAL_VIBE_HTTP_COMPATIBILITY_FLOOR)
  )
}

function explicitHttpCapability(initializeResult: unknown): boolean | null {
  const result = record(initializeResult)
  const agentCapabilities = record(result?.agentCapabilities)
  const mcpCapabilities = record(agentCapabilities?.mcpCapabilities)
  if (!mcpCapabilities || !Object.prototype.hasOwnProperty.call(mcpCapabilities, 'http')) {
    return null
  }
  return typeof mcpCapabilities.http === 'boolean' ? mcpCapabilities.http : false
}

async function lazyStdioServer(
  input: SelectMistralMcpTransportInput
): Promise<unknown | undefined> {
  if (input.stdioServer !== undefined && input.stdioServer !== null) return input.stdioServer
  try {
    return (await input.getStdioServer?.()) ?? undefined
  } catch {
    return undefined
  }
}

export async function selectMistralMcpTransport(
  input: SelectMistralMcpTransportInput
): Promise<MistralMcpTransportSelection> {
  const advertisedHttp = explicitHttpCapability(input.initializeResult)
  const useHttp =
    advertisedHttp === true ||
    (advertisedHttp === null && knownVibeHttpRuntime(input.initializeResult))
  const httpReason = advertisedHttp === true ? 'advertised-http' : 'known-vibe-http'
  if (useHttp && input.httpServer) {
    return { transport: 'http', servers: [input.httpServer], reason: httpReason }
  }

  const stdioServer = await lazyStdioServer(input)
  const fallbackReason =
    advertisedHttp === false
      ? 'explicit-http-disabled'
      : useHttp
        ? 'http-unavailable'
        : 'runtime-http-unknown'
  if (stdioServer !== undefined) {
    return { transport: 'stdio', servers: [stdioServer], reason: fallbackReason }
  }
  return {
    transport: 'none',
    servers: [],
    reason: fallbackReason
  }
}

export function mistralAcpMcpSelectionForTransport(
  input: MistralAcpMcpSelectionInput
): AcpMcpServerSelectionResult {
  if (input.selection.transport !== 'none') return input.selection.servers
  return {
    servers: [],
    prompt: input.sanitizePrompt(input.prompt),
    transformPrompt: input.sanitizePrompt,
    warning:
      `${MISTRAL_MCP_UNAVAILABLE_WARNING_PREFIX} the ACP runtime did not accept the per-run HTTP transport and no safe stdio bridge was available for this launch. Continuing without TaskWraith MCP tools.` +
      (input.httpTransportSetupFailed ? ' The HTTP listener could not be prepared.' : '')
  }
}

export function isMistralMcpUnavailableWarning(value: string): boolean {
  return value.startsWith(MISTRAL_MCP_UNAVAILABLE_WARNING_PREFIX)
}

function validLoopbackMcpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/mcp'
  } catch {
    return false
  }
}

export async function startMistralHttpMcpTransport(
  input: StartMistralHttpMcpTransportInput
): Promise<MistralHttpMcpTransportHandle> {
  const serverName = input.serverName.trim()
  if (!serverName) throw new Error('Mistral HTTP MCP transport requires a server name.')
  const bridge = await (input.startBridge ?? startKimiHttpMcpBridge)({ dispatch: input.dispatch })
  if (
    !validLoopbackMcpUrl(bridge.url) ||
    bridge.headerName.toLowerCase() !== 'authorization' ||
    !bridge.headerValue.startsWith('Bearer ')
  ) {
    await bridge.close()
    throw new Error('Mistral HTTP MCP transport requires a valid loopback URL and Bearer header.')
  }
  const server: MistralHttpMcpServer = {
    name: serverName,
    type: 'http',
    url: bridge.url,
    headers: [{ name: bridge.headerName, value: bridge.headerValue }]
  }
  let closed = false
  return {
    server,
    selectMcpTransport: (initializeResult) =>
      selectMistralMcpTransport({
        initializeResult,
        httpServer: server,
        getStdioServer: input.getStdioServer
      }),
    close: async () => {
      if (closed) return
      closed = true
      await bridge.close()
    }
  }
}

function redactTransportArray(key: string, values: unknown[]): unknown[] {
  if (key === 'args') {
    return values.map((value, index) =>
      index > 0 && values[index - 1] === '--token'
        ? REDACTED_TOKEN
        : redactTransportValue(value, '')
    )
  }
  return values.map((value) => redactTransportValue(value, key))
}

function redactTransportValue(value: unknown, parentKey: string): unknown {
  if (Array.isArray(value)) return redactTransportArray(parentKey, value)
  if (typeof value === 'string') return redactMistralMcpTransportText(value)
  const source = record(value)
  if (!source) return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(source)) {
    if (key.toLowerCase() === 'authorization' && typeof child === 'string') {
      const redacted = redactMistralMcpTransportText(child)
      output[key] = redacted === child ? REDACTED_TOKEN : redacted
    } else if (
      key === 'value' &&
      typeof source.name === 'string' &&
      (source.name.toLowerCase() === 'authorization' ||
        source.name === 'TASKWRAITH_MCP_BROKER_TOKEN')
    ) {
      output[key] = REDACTED_TOKEN
    } else {
      output[key] = redactTransportValue(child, key)
    }
  }
  return output
}

/** Redact an HTTP Bearer credential while preserving the surrounding diagnosis. */
export function redactMistralMcpTransportText(value: string): string {
  return value.replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED_TOKEN}`)
}

/** Clone an ACP frame for debug output while removing every MCP bearer/token lane. */
export function redactMistralMcpTransportSecrets(value: unknown): unknown {
  return redactTransportValue(value, '')
}
